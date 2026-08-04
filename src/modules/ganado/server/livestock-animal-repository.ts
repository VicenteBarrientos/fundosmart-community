import { getDb } from "@/db";
import { fields, livestockAnimalIdentifiers, livestockAnimals, livestockLots, livestockWeighings } from "@/db/schema";
import type { LivestockAnimal } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import { prepareIndividualLotSummaryUpdate } from "./livestock-repository";

type AnimalRow = typeof livestockAnimals.$inferSelect;
type WeighingRow = typeof livestockWeighings.$inferSelect;

function animalDependencySnapshotSql(targetAnimalId: string) {
  return `json_object(
    'weighings', json(COALESCE((
      SELECT json_group_array(json_object(
        'id', current_weighing.id,
        'lotId', current_weighing.lot_id,
        'animalId', current_weighing.animal_id,
        'recordedAt', current_weighing.recorded_at,
        'weightKg', current_weighing.weight_kg,
        'notes', current_weighing.notes,
        'source', current_weighing.source,
        'createdAt', current_weighing.created_at
      ))
      FROM (
        SELECT id, lot_id, animal_id, recorded_at, weight_kg, notes, source, created_at
        FROM livestock_weighings
        WHERE animal_id = ${targetAnimalId}
        ORDER BY id
      ) AS current_weighing
    ), '[]')),
    'lactations', json(COALESCE((
      SELECT json_group_array(json_object('id', current_lactation.id, 'updatedAt', current_lactation.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_lactations
        WHERE animal_id = ${targetAnimalId}
        ORDER BY id
      ) AS current_lactation
    ), '[]')),
    'milkControls', json(COALESCE((
      SELECT json_group_array(json_object('id', current_control.id, 'updatedAt', current_control.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_milk_controls
        WHERE animal_id = ${targetAnimalId}
          OR lactation_id IN (
            SELECT id FROM livestock_lactations WHERE animal_id = ${targetAnimalId}
          )
        ORDER BY id
      ) AS current_control
    ), '[]')),
    'reproductiveEvents', json(COALESCE((
      SELECT json_group_array(json_object('id', current_event.id, 'updatedAt', current_event.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_reproductive_events
        WHERE animal_id = ${targetAnimalId}
        ORDER BY id
      ) AS current_event
    ), '[]')),
    'births', json(COALESCE((
      SELECT json_group_array(json_object('id', current_birth.id, 'updatedAt', current_birth.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_births
        WHERE dam_animal_id = ${targetAnimalId}
          OR reproductive_event_id IN (
            SELECT id FROM livestock_reproductive_events WHERE animal_id = ${targetAnimalId}
          )
        ORDER BY id
      ) AS current_birth
    ), '[]')),
    'offspring', json(COALESCE((
      SELECT json_group_array(json_object('id', current_offspring.id, 'updatedAt', current_offspring.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_birth_offspring
        WHERE animal_id = ${targetAnimalId}
          OR birth_id IN (
            SELECT id
            FROM livestock_births
            WHERE dam_animal_id = ${targetAnimalId}
              OR reproductive_event_id IN (
                SELECT id FROM livestock_reproductive_events WHERE animal_id = ${targetAnimalId}
              )
          )
        ORDER BY id
      ) AS current_offspring
    ), '[]')),
    'healthEvents', json(COALESCE((
      SELECT json_group_array(json_object('id', current_health.id, 'updatedAt', current_health.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_health_events
        WHERE animal_id = ${targetAnimalId}
        ORDER BY id
      ) AS current_health
    ), '[]')),
    'identifiers', json(COALESCE((
      SELECT json_group_array(json_object('id', current_identifier.id, 'updatedAt', current_identifier.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_animal_identifiers
        WHERE animal_id = ${targetAnimalId}
        ORDER BY id
      ) AS current_identifier
    ), '[]')),
    'memberships', json(COALESCE((
      SELECT json_group_array(json_object('id', current_membership.id, 'updatedAt', current_membership.updated_at))
      FROM (
        SELECT id, updated_at
        FROM livestock_lot_memberships
        WHERE animal_id = ${targetAnimalId}
        ORDER BY id
      ) AS current_membership
    ), '[]'))
  )`;
}

async function animalSnapshotToken(row: AnimalRow, dependencySnapshot: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    animal: row,
    dependencies: JSON.parse(dependencySnapshot),
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `livestock-animal:v1:${hex}`;
}

async function readAnimalDependencySnapshot(
  client: ReturnType<typeof getDb>["$client"],
  animalId: string,
): Promise<string> {
  const snapshot = await client.prepare(`
    SELECT ${animalDependencySnapshotSql("snapshot_target.animal_id")} AS snapshot
    FROM (SELECT ? AS animal_id) AS snapshot_target
  `).bind(animalId).first<string>("snapshot");
  if (!snapshot) throwFieldScopeConflict("El identificador del animal no está disponible.");
  return snapshot;
}

function toAnimal(row: AnimalRow, dependencySnapshot: string, weighing?: WeighingRow): Promise<LivestockAnimal> {
  return animalSnapshotToken(row, dependencySnapshot).then((snapshotToken) => ({
    id: row.id,
    lotId: row.lotId,
    tag: row.tag,
    sex: row.sex,
    status: row.status,
    statusDate: row.statusDate,
    statusReason: row.statusReason,
    birthDate: row.birthDate,
    purchasePriceClp: row.purchasePriceClp,
    purchaseDate: row.purchaseDate,
    salePriceClp: row.salePriceClp,
    saleBuyer: row.saleBuyer,
    saleWeightKg: row.saleWeightKg,
    origin: row.origin,
    notes: row.notes,
    source: row.source,
    latestWeightKg: weighing?.weightKg ?? null,
    latestWeightDate: weighing?.recordedAt ?? null,
    createdAt: row.createdAt,
    snapshotToken,
  }));
}

export async function listLivestockAnimals(scope: OrganizationFieldScope): Promise<LivestockAnimal[]> {
  if (scope.fieldIds.length === 0) return [];
  const db = getDb();
  const [rows, weighingRows] = await Promise.all([
    db.select({
      animal: livestockAnimals,
      dependencySnapshot: sql<string>`${sql.raw(animalDependencySnapshotSql("livestock_animals.id"))}`,
    })
      .from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
      .orderBy(asc(livestockAnimals.tag)),
    /* De esta consulta solo se usa el último pesaje de cada animal, pero traía el
       historial completo para descartarlo en memoria: con dos años de pesajes
       mensuales son miles de filas leídas para quedarse con una por animal.
       `recorded_at` es único por animal (livestock_weighings_animal_date_unique),
       así que el máximo devuelve exactamente esa fila y el desempate por
       `created_at` deja de hacer falta. */
    db.select({ weighing: livestockWeighings })
      .from(livestockWeighings)
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockWeighings.animalId))
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(
        eq(fields.organizationId, scope.organizationId),
        inArray(fields.id, scope.fieldIds),
        sql`${livestockWeighings.recordedAt} = (
          SELECT MAX(latest_weighing.recorded_at)
          FROM livestock_weighings AS latest_weighing
          WHERE latest_weighing.animal_id = ${livestockWeighings.animalId}
        )`,
      )),
  ]);
  const latestByAnimal = new Map<string, WeighingRow>();
  for (const { weighing } of weighingRows) {
    latestByAnimal.set(weighing.animalId, weighing);
  }
  return Promise.all(rows.map(({ animal, dependencySnapshot }) =>
    toAnimal(animal, dependencySnapshot, latestByAnimal.get(animal.id))));
}

export async function upsertLivestockAnimal(animal: LivestockAnimal, scope: OrganizationFieldScope): Promise<LivestockAnimal> {
  if (scope.fieldIds.length === 0) throwFieldScopeConflict("El lote seleccionado no está disponible.");
  const db = getDb();
  const [lot] = await db
    .select({ id: livestockLots.id, fieldId: livestockLots.fieldId, trackingMode: livestockLots.trackingMode })
    .from(livestockLots)
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockLots.id, animal.lotId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!lot) throw new DomainRuleError("El lote seleccionado no existe.");
  if (lot.trackingMode !== "individual") {
    throw new DomainRuleError("Activa la trazabilidad animal por animal en el lote antes de registrar un DIIO.");
  }

  const [duplicate] = await db
    .select({ id: livestockAnimals.id })
    .from(livestockAnimals)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .where(and(eq(livestockLots.fieldId, lot.fieldId), eq(livestockAnimals.tag, animal.tag), ne(livestockAnimals.id, animal.id)))
    .limit(1);
  if (duplicate) throw new DomainRuleError("Ya existe un animal con ese DIIO o identificador en este fundo.");

  const [existing] = await db
    .select({ animal: livestockAnimals, fieldId: livestockLots.fieldId })
    .from(livestockAnimals)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .where(eq(livestockAnimals.id, animal.id))
    .limit(1);
  let dependencySnapshot: string | null = null;
  if (existing) {
    await assertFieldInScope(existing.fieldId, scope, "El identificador del animal no está disponible.");
    dependencySnapshot = await readAnimalDependencySnapshot(db.$client, existing.animal.id);
    if (!animal.snapshotToken || animal.snapshotToken !== await animalSnapshotToken(existing.animal, dependencySnapshot)) {
      throwFieldScopeConflict("El animal cambió desde la última carga.");
    }
    // Un animal con historia de números vigentes solo cambia de número por la ficha:
    // ahí el número anterior queda cerrado con fecha en vez de sobrescribirse.
    if (existing.animal.tag !== animal.tag) {
      const [numberedIdentifier] = await db
        .select({ id: livestockAnimalIdentifiers.id })
        .from(livestockAnimalIdentifiers)
        .where(and(
          eq(livestockAnimalIdentifiers.animalId, animal.id),
          eq(livestockAnimalIdentifiers.sourceSystem, "manual"),
          eq(livestockAnimalIdentifiers.kind, "tag"),
        ))
        .limit(1);
      if (numberedIdentifier) {
        throw new DomainRuleError(
          "Este animal ya tiene historia de números. Usa Cambio de número en su ficha para conservar el anterior con su fecha.",
          "RENUMBER_REQUIRED",
        );
      }
    }
  }

  /**
   * La planilla afirma varios días a la vez; la ficha y las importaciones, uno solo.
   *
   * Cuando viene la lista, manda la lista: `latestWeightKg` pasa a ser lo que se leyó, no
   * lo que se escribe, y escribirlo además duplicaría el pesaje del día más reciente.
  */
  const weighingWrites = Array.isArray(animal.weighings) ? animal.weighings : null;
  if (
    weighingWrites !== null
    && existing
    && existing.animal.status !== animal.status
    && (existing.animal.status === "sold" || animal.status === "sold")
  ) {
    throw new DomainRuleError(
      "Las ventas se cierran o reabren desde la ficha del animal.",
    );
  }
  if (
    weighingWrites !== null
    && existing?.animal.status === "sold"
    && existing.animal.statusDate !== animal.statusDate
  ) {
    throw new DomainRuleError(
      "La fecha de una venta se corrige desde la ficha del animal.",
    );
  }
  const protectedSaleDates = new Set([
    existing?.animal.status === "sold" ? existing.animal.statusDate : null,
    animal.status === "sold" ? animal.statusDate : null,
  ].filter((date): date is string => Boolean(date)));
  if (
    weighingWrites?.some((write) => protectedSaleDates.has(write.recordedAt))
  ) {
    throw new DomainRuleError(
      "El peso final de venta se corrige desde la ficha del animal.",
    );
  }
  const writesLatestWeight = weighingWrites === null
    && animal.latestWeightKg !== null
    && Boolean(animal.latestWeightDate);

  const requestedWeightId = animal.latestWeightDate
    ? `weight-${animal.id}-${animal.latestWeightDate}`
    : null;
  let currentWeight: WeighingRow | undefined;
  if (writesLatestWeight && animal.latestWeightDate) {
    [currentWeight] = await db
      .select()
      .from(livestockWeighings)
      .where(and(
        eq(livestockWeighings.animalId, animal.id),
        eq(livestockWeighings.recordedAt, animal.latestWeightDate),
      ))
      .limit(1);
  }

  const updatedAt = new Date().toISOString();
  /* `updatedAt` tiene precisión de milisegundos y dos requests pueden compartirlo.
     El marcador aleatorio identifica inequívocamente a la mutación ganadora dentro
     del batch; se reemplaza por el timestamp real antes de actualizar resúmenes y
     nunca queda visible fuera de la transacción. */
  const writeMarker = `pending:${crypto.randomUUID()}`;
  const values = {
    id: animal.id,
    lotId: animal.lotId,
    tag: animal.tag,
    sex: animal.sex,
    status: animal.status,
    statusDate: animal.statusDate,
    statusReason: animal.statusReason,
    birthDate: animal.birthDate,
    purchasePriceClp: animal.purchasePriceClp,
    purchaseDate: animal.purchaseDate,
    salePriceClp: animal.salePriceClp ?? null,
    saleBuyer: animal.saleBuyer ?? null,
    saleWeightKg: animal.saleWeightKg ?? null,
    origin: animal.origin,
    notes: animal.notes,
    source: animal.source || "Registro manual",
    createdAt: existing?.animal.createdAt ?? animal.createdAt,
    updatedAt: writeMarker,
  } satisfies typeof livestockAnimals.$inferInsert;
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  let weightGuardSql = "";
  const weightGuardBindings: Array<string | number | null> = [];
  // Con varios pesajes en juego, guardar uno por uno se vuelve una lista de condiciones que
  // hay que recordar mantener. La huella de dependencias del animal ya contiene su historia
  // completa —es la misma que respalda el token—, así que compararla adentro del lote cubre
  // los N días de una vez y cierra la ventana entre leer el token y escribir.
  if (weighingWrites !== null && existing && dependencySnapshot) {
    weightGuardSql = `
      AND json(${animalDependencySnapshotSql("livestock_animals.id")}) = json(?)
    `;
    weightGuardBindings.push(dependencySnapshot);
  } else if (writesLatestWeight && animal.latestWeightDate && requestedWeightId) {
    if (currentWeight) {
      weightGuardSql = `
        AND EXISTS (
          SELECT 1 FROM livestock_weighings AS current_weighing
          WHERE current_weighing.id = ?
            AND current_weighing.lot_id IS ?
            AND current_weighing.animal_id = ?
            AND current_weighing.recorded_at = ?
            AND current_weighing.weight_kg IS ?
            AND current_weighing.notes = ?
            AND current_weighing.source = ?
            AND current_weighing.created_at = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_weighings AS conflicting_weight_id
          WHERE conflicting_weight_id.id = ?
            AND conflicting_weight_id.id <> ?
        )
      `;
      weightGuardBindings.push(
        currentWeight.id,
        currentWeight.lotId,
        currentWeight.animalId,
        currentWeight.recordedAt,
        currentWeight.weightKg,
        currentWeight.notes,
        currentWeight.source,
        currentWeight.createdAt,
        requestedWeightId,
        currentWeight.id,
      );
    } else {
      weightGuardSql = `
        AND NOT EXISTS (
          SELECT 1 FROM livestock_weighings AS conflicting_weight_date
          WHERE conflicting_weight_date.animal_id = ?
            AND conflicting_weight_date.recorded_at = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_weighings AS conflicting_weight_id
          WHERE conflicting_weight_id.id = ?
        )
      `;
      weightGuardBindings.push(animal.id, animal.latestWeightDate, requestedWeightId);
    }
  }
  const client = db.$client;
  const mutation = existing
    ? client.prepare(`
      UPDATE livestock_animals
      SET
        lot_id = ?, tag = ?, sex = ?, status = ?, status_date = ?, status_reason = ?,
        birth_date = ?, purchase_price_clp = ?, purchase_date = ?,
        sale_price_clp = ?, sale_buyer = ?, sale_weight_kg = ?, origin = ?,
        notes = ?, source = ?, updated_at = ?
      WHERE id = ? AND lot_id = ?
        AND tag = ?
        AND sex = ?
        AND status = ?
        AND status_date IS ?
        AND status_reason IS ?
        AND birth_date IS ?
        AND purchase_price_clp IS ?
        AND purchase_date IS ?
        AND sale_price_clp IS ?
        AND sale_buyer IS ?
        AND sale_weight_kg IS ?
        AND origin IS ?
        AND notes = ?
        AND source = ?
        AND created_at = ?
        AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM livestock_lots AS target_lot
          INNER JOIN fields AS target_field ON target_field.id = target_lot.field_id
          WHERE target_lot.id = ?
            AND target_lot.tracking_mode = 'individual'
            AND target_field.organization_id = ?
            AND target_field.id IN (SELECT value FROM json_each(?))
        )
        AND EXISTS (
          SELECT 1
          FROM livestock_lots AS source_lot
          INNER JOIN fields AS source_field ON source_field.id = source_lot.field_id
          WHERE source_lot.id = ?
            AND source_field.organization_id = ?
            AND source_field.id IN (SELECT value FROM json_each(?))
        )
        AND NOT EXISTS (
          SELECT 1
          FROM livestock_animals AS duplicate
          INNER JOIN livestock_lots AS duplicate_lot ON duplicate_lot.id = duplicate.lot_id
          INNER JOIN livestock_lots AS target_lot ON target_lot.id = ?
          WHERE duplicate.tag = ?
            AND duplicate.id <> ?
            AND duplicate_lot.field_id = target_lot.field_id
        )
        ${weightGuardSql}
    `).bind(
      values.lotId,
      values.tag,
      values.sex,
      values.status,
      values.statusDate,
      values.statusReason,
      values.birthDate,
      values.purchasePriceClp,
      values.purchaseDate,
      values.salePriceClp,
      values.saleBuyer,
      values.saleWeightKg,
      values.origin,
      values.notes,
      values.source,
      values.updatedAt,
      values.id,
      existing.animal.lotId,
      existing.animal.tag,
      existing.animal.sex,
      existing.animal.status,
      existing.animal.statusDate,
      existing.animal.statusReason,
      existing.animal.birthDate,
      existing.animal.purchasePriceClp,
      existing.animal.purchaseDate,
      existing.animal.salePriceClp,
      existing.animal.saleBuyer,
      existing.animal.saleWeightKg,
      existing.animal.origin,
      existing.animal.notes,
      existing.animal.source,
      existing.animal.createdAt,
      existing.animal.updatedAt,
      values.lotId,
      scope.organizationId,
      fieldIdsJson,
      existing.animal.lotId,
      scope.organizationId,
      fieldIdsJson,
      values.lotId,
      values.tag,
      values.id,
      ...weightGuardBindings,
    )
    : client.prepare(`
      INSERT INTO livestock_animals (
        id, lot_id, tag, sex, status, status_date, status_reason, birth_date,
        purchase_price_clp, purchase_date, sale_price_clp, sale_buyer, sale_weight_kg,
        origin, notes, source, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM livestock_lots AS target_lot
        INNER JOIN fields AS target_field ON target_field.id = target_lot.field_id
        WHERE target_lot.id = ?
          AND target_lot.tracking_mode = 'individual'
          AND target_field.organization_id = ?
          AND target_field.id IN (SELECT value FROM json_each(?))
      )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_animals AS existing_id WHERE existing_id.id = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM livestock_animals AS duplicate
          INNER JOIN livestock_lots AS duplicate_lot ON duplicate_lot.id = duplicate.lot_id
          INNER JOIN livestock_lots AS target_lot ON target_lot.id = ?
          WHERE duplicate.tag = ?
            AND duplicate_lot.field_id = target_lot.field_id
        )
        ${weightGuardSql}
    `).bind(
      values.id,
      values.lotId,
      values.tag,
      values.sex,
      values.status,
      values.statusDate,
      values.statusReason,
      values.birthDate,
      values.purchasePriceClp,
      values.purchaseDate,
      values.salePriceClp,
      values.saleBuyer,
      values.saleWeightKg,
      values.origin,
      values.notes,
      values.source,
      values.createdAt,
      values.updatedAt,
      values.lotId,
      scope.organizationId,
      fieldIdsJson,
      values.id,
      values.lotId,
      values.tag,
      ...weightGuardBindings,
    );

  const statements = [mutation];
  for (const write of weighingWrites ?? []) {
    // Cada pesaje se ancla al animal que este lote acaba de guardar mirando su `updated_at`,
    // y no a `changes()`: `changes()` mira solo la sentencia anterior, así que en cuanto hay
    // dos pesajes el segundo empieza a leer el resultado del primero en vez del animal.
    const savedAnimalCondition = `
      EXISTS (
        SELECT 1
        FROM livestock_animals AS saved_animal
        INNER JOIN livestock_lots AS saved_lot ON saved_lot.id = saved_animal.lot_id
        INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
        WHERE saved_animal.id = ?
          AND saved_animal.updated_at = ?
          AND saved_lot.id = ?
          AND saved_lot.tracking_mode = 'individual'
          AND saved_field.organization_id = ?
          AND saved_field.id IN (SELECT value FROM json_each(?))
      )
    `;
    statements.push(write.weightKg === null
      ? client.prepare(`
        DELETE FROM livestock_weighings
        WHERE animal_id = ?
          AND recorded_at = ?
          AND ${savedAnimalCondition}
      `).bind(
        animal.id,
        write.recordedAt,
        animal.id,
        writeMarker,
        animal.lotId,
        scope.organizationId,
        fieldIdsJson,
      )
      : client.prepare(`
        INSERT INTO livestock_weighings (
          id, lot_id, animal_id, recorded_at, weight_kg, notes, source
        )
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE ${savedAnimalCondition}
        ON CONFLICT(animal_id, recorded_at) DO UPDATE SET
          lot_id = excluded.lot_id,
          weight_kg = excluded.weight_kg,
          source = excluded.source
      `).bind(
        `weight-${animal.id}-${write.recordedAt}`,
        animal.lotId,
        animal.id,
        write.recordedAt,
        write.weightKg,
        "",
        "Planilla de animales",
        animal.id,
        writeMarker,
        animal.lotId,
        scope.organizationId,
        fieldIdsJson,
      ));
  }
  if (writesLatestWeight && animal.latestWeightDate) {
    statements.push(client.prepare(`
      INSERT INTO livestock_weighings (
        id, lot_id, animal_id, recorded_at, weight_kg, notes, source
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE changes() > 0
        AND EXISTS (
          SELECT 1
          FROM livestock_animals AS saved_animal
          INNER JOIN livestock_lots AS saved_lot ON saved_lot.id = saved_animal.lot_id
          INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
          WHERE saved_animal.id = ?
            AND saved_animal.updated_at = ?
            AND saved_lot.id = ?
            AND saved_lot.tracking_mode = 'individual'
            AND saved_field.organization_id = ?
            AND saved_field.id IN (SELECT value FROM json_each(?))
        )
      ON CONFLICT(animal_id, recorded_at) DO UPDATE SET
        lot_id = excluded.lot_id,
        weight_kg = excluded.weight_kg,
        source = excluded.source
    `).bind(
      `weight-${animal.id}-${animal.latestWeightDate}`,
      animal.lotId,
      animal.id,
      animal.latestWeightDate,
      animal.latestWeightKg,
      "Último pesaje registrado desde la ficha del animal",
      animal.source || "Registro manual",
      animal.id,
      writeMarker,
      animal.lotId,
      scope.organizationId,
      fieldIdsJson,
    ));
  }
  if (animal.status === "sold" && animal.saleWeightKg !== null && animal.statusDate) {
    const saleNotes = `Peso final de venta${animal.saleBuyer ? ` a ${animal.saleBuyer}` : ""}`;
    statements.push(client.prepare(`
      INSERT INTO livestock_weighings (
        id, lot_id, animal_id, recorded_at, weight_kg, notes, source
      )
      SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
          SELECT 1
          FROM livestock_animals AS saved_animal
          INNER JOIN livestock_lots AS saved_lot ON saved_lot.id = saved_animal.lot_id
          INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
          WHERE saved_animal.id = ?
            AND saved_animal.updated_at = ?
            AND saved_lot.id = ?
            AND saved_lot.tracking_mode = 'individual'
            AND saved_field.organization_id = ?
            AND saved_field.id IN (SELECT value FROM json_each(?))
        )
      ON CONFLICT(animal_id, recorded_at) DO UPDATE SET
        lot_id = excluded.lot_id,
        weight_kg = excluded.weight_kg,
        notes = excluded.notes,
        source = excluded.source
    `).bind(
      `sale-weight-${animal.id}-${animal.statusDate}`,
      animal.lotId,
      animal.id,
      animal.statusDate,
      animal.saleWeightKg,
      saleNotes,
      "Cierre de venta",
      animal.id,
      writeMarker,
      animal.lotId,
      scope.organizationId,
      fieldIdsJson,
    ));
  }
  /* El finalizador convierte el marcador transitorio en el timestamp público. Si la
     mutación principal perdió su CAS, cambia cero filas; el `changes()` que sigue
     impide tanto los resúmenes como cualquier efecto secundario del request perdedor. */
  statements.push(client.prepare(`
    UPDATE livestock_animals
    SET updated_at = ?
    WHERE id = ?
      AND updated_at = ?
      AND lot_id = ?
      AND EXISTS (
        SELECT 1
        FROM livestock_lots AS saved_lot
        INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
        WHERE saved_lot.id = livestock_animals.lot_id
          AND saved_lot.tracking_mode = 'individual'
          AND saved_field.organization_id = ?
          AND saved_field.id IN (SELECT value FROM json_each(?))
      )
  `).bind(
    updatedAt,
    animal.id,
    writeMarker,
    animal.lotId,
    scope.organizationId,
    fieldIdsJson,
  ));
  statements.push(prepareIndividualLotSummaryUpdate(client, animal.lotId, scope, updatedAt, true));
  if (existing && existing.animal.lotId !== animal.lotId) {
    statements.push(prepareIndividualLotSummaryUpdate(client, existing.animal.lotId, scope, updatedAt, true));
  }
  statements.push(client.prepare(`
    SELECT
      saved_animal.id,
      saved_animal.lot_id AS "lotId",
      saved_animal.tag,
      saved_animal.sex,
      saved_animal.status,
      saved_animal.status_date AS "statusDate",
      saved_animal.status_reason AS "statusReason",
      saved_animal.birth_date AS "birthDate",
      saved_animal.purchase_price_clp AS "purchasePriceClp",
      saved_animal.purchase_date AS "purchaseDate",
      saved_animal.sale_price_clp AS "salePriceClp",
      saved_animal.sale_buyer AS "saleBuyer",
      saved_animal.sale_weight_kg AS "saleWeightKg",
      saved_animal.origin,
      saved_animal.notes,
      saved_animal.source,
      saved_animal.created_at AS "createdAt",
      saved_animal.updated_at AS "updatedAt"
    FROM livestock_animals AS saved_animal
    INNER JOIN livestock_lots AS saved_lot ON saved_lot.id = saved_animal.lot_id
    INNER JOIN fields AS saved_field ON saved_field.id = saved_lot.field_id
    WHERE saved_animal.id = ?
      AND saved_animal.lot_id = ?
      AND saved_animal.updated_at = ?
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT value FROM json_each(?))
  `).bind(animal.id, animal.lotId, updatedAt, scope.organizationId, fieldIdsJson));
  statements.push(client.prepare(`
    SELECT
      latest.id,
      latest.lot_id AS "lotId",
      latest.animal_id AS "animalId",
      latest.recorded_at AS "recordedAt",
      latest.weight_kg AS "weightKg",
      latest.notes,
      latest.source,
      latest.created_at AS "createdAt"
    FROM livestock_weighings AS latest
    INNER JOIN livestock_animals AS current_animal ON current_animal.id = latest.animal_id
    INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
    INNER JOIN fields AS current_field ON current_field.id = current_lot.field_id
    WHERE current_animal.id = ?
      AND current_animal.lot_id = ?
      AND current_animal.updated_at = ?
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT value FROM json_each(?))
    ORDER BY latest.recorded_at DESC, latest.created_at DESC
    LIMIT 1
  `).bind(animal.id, animal.lotId, updatedAt, scope.organizationId, fieldIdsJson));

  const results = await client.batch(statements);
  if (results[0].meta.changes === 0) throwFieldScopeConflict("El identificador del animal no está disponible.");
  const saved = results[results.length - 2].results[0] as AnimalRow | undefined;
  if (!saved) throwFieldScopeConflict("El identificador del animal no está disponible.");
  const latest = results[results.length - 1].results[0] as WeighingRow | undefined;
  const savedDependencySnapshot = await readAnimalDependencySnapshot(client, saved.id);
  return toAnimal(saved, savedDependencySnapshot, latest);
}

export async function deleteLivestockAnimal(
  id: string,
  scope: OrganizationFieldScope,
  expectedSnapshotToken: string,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existing] = await db
    .select({ animal: livestockAnimals })
    .from(livestockAnimals)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockAnimals.id, id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!existing) return false;

  const client = db.$client;
  const dependencySnapshot = await readAnimalDependencySnapshot(client, id);
  if (expectedSnapshotToken !== await animalSnapshotToken(existing.animal, dependencySnapshot)) {
    throwFieldScopeConflict("El animal cambió desde la última carga.");
  }
  const results = await client.batch([
    client.prepare(`
      DELETE FROM livestock_animals
      WHERE id = ? AND lot_id = ?
        AND tag = ?
        AND sex = ?
        AND status = ?
        AND status_date IS ?
        AND status_reason IS ?
        AND birth_date IS ?
        AND purchase_price_clp IS ?
        AND purchase_date IS ?
        AND origin IS ?
        AND notes = ?
        AND source = ?
        AND created_at = ?
        AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM livestock_lots AS current_lot
          INNER JOIN fields AS current_field ON current_field.id = current_lot.field_id
          WHERE current_lot.id = livestock_animals.lot_id
            AND current_field.organization_id = ?
            AND current_field.id IN (SELECT value FROM json_each(?))
        )
        AND json(${animalDependencySnapshotSql("livestock_animals.id")}) = json(?)
    `).bind(
      id,
      existing.animal.lotId,
      existing.animal.tag,
      existing.animal.sex,
      existing.animal.status,
      existing.animal.statusDate,
      existing.animal.statusReason,
      existing.animal.birthDate,
      existing.animal.purchasePriceClp,
      existing.animal.purchaseDate,
      existing.animal.origin,
      existing.animal.notes,
      existing.animal.source,
      existing.animal.createdAt,
      existing.animal.updatedAt,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
      dependencySnapshot,
    ),
    prepareIndividualLotSummaryUpdate(client, existing.animal.lotId, scope, new Date().toISOString(), true),
  ]);
  return results[0].meta.changes > 0;
}
