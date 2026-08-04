import { getDb } from "@/db";
import { fields, livestockAnimals, livestockLots, paddocks } from "@/db/schema";
import type { LivestockLot } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { assertFieldInScope, throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

type LivestockLotRow = typeof livestockLots.$inferSelect;

function toLivestockLot(row: LivestockLotRow): LivestockLot {
  return {
    id: row.id,
    fieldId: row.fieldId,
    paddockId: row.paddockId,
    name: row.name,
    category: row.category,
    animalCount: row.animalCount,
    averageWeightKg: row.averageWeightKg,
    entryDate: row.entryDate,
    status: row.status,
    ownerName: row.ownerName,
    trackingMode: row.trackingMode,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toRow(lot: LivestockLot): typeof livestockLots.$inferInsert {
  return {
    id: lot.id,
    fieldId: lot.fieldId,
    paddockId: lot.paddockId,
    name: lot.name,
    category: lot.category,
    animalCount: lot.animalCount,
    averageWeightKg: lot.averageWeightKg,
    entryDate: lot.entryDate,
    status: lot.status,
    ownerName: lot.ownerName,
    trackingMode: lot.trackingMode,
    notes: lot.notes,
    createdAt: lot.createdAt,
    updatedAt: new Date().toISOString(),
  };
}

async function findLotMoveTagConflict(
  db: ReturnType<typeof getDb>,
  lotId: string,
  targetFieldId: string,
  scope: OrganizationFieldScope,
): Promise<string | null> {
  const [conflict] = await db
    .select({ tag: livestockAnimals.tag })
    .from(livestockAnimals)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockAnimals.lotId, lotId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
      sql`EXISTS (
        SELECT 1
        FROM livestock_animals AS target_animal
        INNER JOIN livestock_lots AS target_lot ON target_lot.id = target_animal.lot_id
        INNER JOIN fields AS target_field ON target_field.id = target_lot.field_id
        WHERE target_animal.tag = ${livestockAnimals.tag}
          AND target_animal.id <> ${livestockAnimals.id}
          AND target_lot.field_id = ${targetFieldId}
          AND target_field.organization_id = ${scope.organizationId}
          AND target_field.id IN (SELECT value FROM json_each(${JSON.stringify(scope.fieldIds)}))
      )`,
    ))
    .limit(1);
  return conflict?.tag ?? null;
}

function throwLotMoveTagConflict(tag: string): never {
  throw new DomainRuleError(
    `El fundo destino ya tiene un animal con el DIIO ${tag}.`,
    "LIVESTOCK_TAG_SCOPE_CONFLICT",
  );
}

export async function listLivestockLots(scope: OrganizationFieldScope): Promise<LivestockLot[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ lot: livestockLots })
    .from(livestockLots)
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
    .orderBy(asc(livestockLots.name));
  return rows.map(({ lot }) => toLivestockLot(lot));
}

export async function upsertLivestockLot(lot: LivestockLot, scope: OrganizationFieldScope): Promise<LivestockLot> {
  const db = getDb();
  await assertFieldInScope(lot.fieldId, scope);
  const [existing] = await db
    .select({
      fieldId: livestockLots.fieldId,
      createdAt: livestockLots.createdAt,
      updatedAt: livestockLots.updatedAt,
    })
    .from(livestockLots)
    .where(eq(livestockLots.id, lot.id))
    .limit(1);
  if (existing) {
    await assertFieldInScope(existing.fieldId, scope, "El identificador del lote no está disponible.");
    if (!lot.updatedAt || lot.updatedAt !== existing.updatedAt) {
      throwFieldScopeConflict("El lote ganadero cambió desde la última carga.");
    }
  }

  if (lot.paddockId) {
    const [paddock] = await db
      .select({ fieldId: paddocks.fieldId })
      .from(paddocks)
      .where(eq(paddocks.id, lot.paddockId))
      .limit(1);
    if (!paddock || paddock.fieldId !== lot.fieldId) {
      throw new DomainRuleError("El potrero seleccionado no pertenece al fundo indicado.");
    }
  }

  if (lot.trackingMode === "summary") {
    const [registeredAnimal] = await db
      .select({ id: livestockAnimals.id })
      .from(livestockAnimals)
      .where(eq(livestockAnimals.lotId, lot.id))
      .limit(1);
    if (registeredAnimal) {
      throw new DomainRuleError("El lote tiene animales con DIIO. Muévelos o elimínalos antes de usar el modo de solo resumen.");
    }
  }

  if (existing && existing.fieldId !== lot.fieldId) {
    const conflictingTag = await findLotMoveTagConflict(db, lot.id, lot.fieldId, scope);
    if (conflictingTag) throwLotMoveTagConflict(conflictingTag);
  }

  const values = toRow(lot);
  const updatedAt = values.updatedAt ?? new Date().toISOString();
  const fieldIdsJson = JSON.stringify(scope.fieldIds);
  const client = db.$client;
  const mutation = existing
    ? client.prepare(`
      UPDATE livestock_lots
      SET
        field_id = ?, paddock_id = ?, name = ?, category = ?, animal_count = ?,
        average_weight_kg = ?, entry_date = ?, status = ?, owner_name = ?,
        tracking_mode = ?, notes = ?, updated_at = ?
      WHERE id = ? AND field_id = ? AND created_at = ? AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM fields AS target_field
          WHERE target_field.id = ?
            AND target_field.organization_id = ?
            AND target_field.id IN (SELECT value FROM json_each(?))
        )
        AND EXISTS (
          SELECT 1
          FROM fields AS source_field
          WHERE source_field.id = ?
            AND source_field.organization_id = ?
            AND source_field.id IN (SELECT value FROM json_each(?))
        )
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1
            FROM potreros AS target_paddock
            WHERE target_paddock.id = ? AND target_paddock.field_id = ?
          )
        )
        AND (
          ? <> 'summary' OR NOT EXISTS (
            SELECT 1 FROM livestock_animals AS animal WHERE animal.lot_id = ?
          )
        )
        AND (
          ? = 1 OR NOT EXISTS (
            SELECT 1
            FROM livestock_animals AS moving_animal
            INNER JOIN livestock_animals AS target_animal
              ON target_animal.tag = moving_animal.tag AND target_animal.id <> moving_animal.id
            INNER JOIN livestock_lots AS target_lot ON target_lot.id = target_animal.lot_id
            WHERE moving_animal.lot_id = livestock_lots.id
              AND target_lot.field_id = ?
          )
        )
    `).bind(
      values.fieldId,
      values.paddockId,
      values.name,
      values.category,
      values.animalCount,
      values.averageWeightKg,
      values.entryDate,
      values.status,
      values.ownerName,
      values.trackingMode,
      values.notes,
      updatedAt,
      values.id,
      existing.fieldId,
      existing.createdAt,
      existing.updatedAt,
      values.fieldId,
      scope.organizationId,
      fieldIdsJson,
      existing.fieldId,
      scope.organizationId,
      fieldIdsJson,
      values.paddockId,
      values.paddockId,
      values.fieldId,
      values.trackingMode,
      values.id,
      existing.fieldId === values.fieldId ? 1 : 0,
      values.fieldId,
    )
    : client.prepare(`
      INSERT INTO livestock_lots (
        id, field_id, paddock_id, name, category, animal_count, average_weight_kg,
        entry_date, status, owner_name, tracking_mode, notes, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM fields AS target_field
        WHERE target_field.id = ?
          AND target_field.organization_id = ?
          AND target_field.id IN (SELECT value FROM json_each(?))
      )
        AND (
          ? IS NULL OR EXISTS (
            SELECT 1
            FROM potreros AS target_paddock
            WHERE target_paddock.id = ? AND target_paddock.field_id = ?
          )
        )
        AND NOT EXISTS (
          SELECT 1 FROM livestock_lots AS existing_id WHERE existing_id.id = ?
        )
    `).bind(
      values.id,
      values.fieldId,
      values.paddockId,
      values.name,
      values.category,
      values.animalCount,
      values.averageWeightKg,
      values.entryDate,
      values.status,
      values.ownerName,
      values.trackingMode,
      values.notes,
      values.createdAt,
      updatedAt,
      values.fieldId,
      scope.organizationId,
      fieldIdsJson,
      values.paddockId,
      values.paddockId,
      values.fieldId,
      values.id,
    );

  const statements = [mutation];
  if (values.trackingMode === "individual") {
    statements.push(prepareIndividualLotSummaryUpdate(client, values.id, scope, updatedAt, true));
  }
  const results = await client.batch(statements);
  if (results[0].meta.changes === 0) {
    if (existing && existing.fieldId !== values.fieldId) {
      const conflictingTag = await findLotMoveTagConflict(db, values.id, values.fieldId, scope);
      if (conflictingTag) throwLotMoveTagConflict(conflictingTag);
    }
    throwFieldScopeConflict("El identificador del lote no está disponible.");
  }

  const [saved] = await db
    .select({ lot: livestockLots })
    .from(livestockLots)
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockLots.id, values.id),
      eq(livestockLots.fieldId, values.fieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!saved) throwFieldScopeConflict("El identificador del lote no está disponible.");
  return toLivestockLot(saved.lot);
}

export async function deleteLivestockLot(
  id: string,
  scope: OrganizationFieldScope,
  expectedUpdatedAt: string,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existing] = await db
    .select({
      fieldId: livestockLots.fieldId,
      createdAt: livestockLots.createdAt,
      updatedAt: livestockLots.updatedAt,
    })
    .from(livestockLots)
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockLots.id, id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!existing) return false;
  if (existing.updatedAt !== expectedUpdatedAt) {
    throwFieldScopeConflict("El lote ganadero cambió desde la última carga.");
  }
  const client = db.$client;
  const [deleted] = await client.batch([
    client.prepare(`
      DELETE FROM livestock_lots
      WHERE id = ? AND field_id = ? AND created_at = ? AND updated_at = ?
        AND EXISTS (
          SELECT 1
          FROM fields AS current_field
          WHERE current_field.id = livestock_lots.field_id
            AND current_field.organization_id = ?
            AND current_field.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      id,
      existing.fieldId,
      existing.createdAt,
      existing.updatedAt,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
    ),
  ]);
  return deleted.meta.changes > 0;
}

export async function syncIndividualLot(lotId: string, scope: OrganizationFieldScope): Promise<void> {
  const db = getDb();
  await prepareIndividualLotSummaryUpdate(db.$client, lotId, scope, new Date().toISOString()).run();
}

export function prepareIndividualLotSummaryUpdate(
  client: ReturnType<typeof getDb>["$client"],
  lotId: string,
  scope: OrganizationFieldScope,
  updatedAt: string,
  requirePreviousChange = false,
) {
  const previousChangeGuard = requirePreviousChange ? "AND changes() > 0" : "";
  return client.prepare(`
    UPDATE livestock_lots
    SET
      animal_count = (
        SELECT COUNT(*)
        FROM livestock_animals AS animal
        WHERE animal.lot_id = ? AND animal.status = 'active'
      ),
      average_weight_kg = (
        SELECT ROUND(AVG(latest.weight_kg), 1)
        FROM (
          SELECT (
            SELECT weighing.weight_kg
            FROM livestock_weighings AS weighing
            WHERE weighing.animal_id = animal.id
            ORDER BY weighing.recorded_at DESC, weighing.created_at DESC
            LIMIT 1
          ) AS weight_kg
          FROM livestock_animals AS animal
          WHERE animal.lot_id = ? AND animal.status = 'active'
        ) AS latest
        WHERE latest.weight_kg IS NOT NULL
      ),
      updated_at = ?
    WHERE id = ?
      ${previousChangeGuard}
      AND tracking_mode = 'individual'
      AND EXISTS (
        SELECT 1
        FROM fields
        WHERE fields.id = livestock_lots.field_id
          AND fields.organization_id = ?
          AND fields.id IN (SELECT value FROM json_each(?))
      )
  `).bind(lotId, lotId, updatedAt, lotId, scope.organizationId, JSON.stringify(scope.fieldIds));
}
