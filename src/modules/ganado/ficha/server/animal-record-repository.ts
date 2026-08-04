import { getDb } from "@/db";
import {
  auditLog,
  fields,
  livestockAnimalIdentifiers,
  livestockAnimals,
  livestockBirthOffspring,
  livestockBirths,
  livestockHealthEvents,
  livestockLactations,
  livestockLots,
  livestockMilkControls,
  livestockReproductiveEvents,
  livestockWeighings,
} from "@/db/schema";
import type { LivestockAnimal, LivestockWeighing } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { and, asc, desc, eq, gte, inArray, isNull, lte, max, or, sql } from "drizzle-orm";
import type {
  AnimalDirectoryItem,
  AnimalParentageLink,
  AnimalRecord,
  AnimalTimelineItem,
  BirthInput,
  HealthEventInput,
  LivestockBirth,
  LivestockBirthOffspring,
  LivestockHealthEvent,
  LivestockLactation,
  LivestockMilkControl,
  LivestockReproductiveEvent,
  MilkControlInput,
  RenumberInput,
  ReproductiveEventInput,
} from "../domain/types";
import {
  LIVESTOCK_CALVING_DIFFICULTY_LABELS,
  LIVESTOCK_HEALTH_EVENT_LABELS,
  LIVESTOCK_REPRODUCTIVE_EVENT_LABELS,
} from "../domain/types";
import { buildAnimalInsights } from "./animal-insights.mjs";
import { normalizeAnimalTag } from "./animal-record-rules.mjs";
import { assertRenumberPlanApplied, buildAnimalRenumberPlan } from "./animal-renumber-plan.mjs";

type AnimalRow = typeof livestockAnimals.$inferSelect;
type WeighingRow = typeof livestockWeighings.$inferSelect;
type MilkControlRow = typeof livestockMilkControls.$inferSelect;
type ReproductiveEventRow = typeof livestockReproductiveEvents.$inferSelect;
type LactationRow = typeof livestockLactations.$inferSelect;
type BirthRow = typeof livestockBirths.$inferSelect;
type BirthOffspringRow = typeof livestockBirthOffspring.$inferSelect;
type SqlBinding = string | number | null;
type SqlCondition = { sql: string; bindings: SqlBinding[] };

export async function listAnimalDirectory(scope: OrganizationFieldScope): Promise<AnimalDirectoryItem[]> {
  if (scope.fieldIds.length === 0) return [];
  const db = getDb();
  const [animals, weighingRows] = await Promise.all([
    db
      .select({
        id: sql<string>`${livestockAnimals.id}`.as("animal_id"),
        tag: livestockAnimals.tag,
        sex: livestockAnimals.sex,
        status: livestockAnimals.status,
        fieldId: sql<string>`${livestockLots.fieldId}`.as("field_id"),
        fieldName: sql<string>`${fields.name}`.as("field_name"),
        lotId: sql<string>`${livestockLots.id}`.as("lot_id"),
        lotName: sql<string>`${livestockLots.name}`.as("lot_name"),
      })
      .from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
      .orderBy(asc(fields.name), asc(livestockAnimals.tag)),
    db
      .select({ weighing: livestockWeighings })
      .from(livestockWeighings)
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockWeighings.animalId))
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
      .orderBy(desc(livestockWeighings.recordedAt), desc(livestockWeighings.createdAt)),
  ]);
  const latestByAnimal = new Map<string, WeighingRow>();
  for (const { weighing } of weighingRows) {
    if (!latestByAnimal.has(weighing.animalId)) latestByAnimal.set(weighing.animalId, weighing);
  }
  return animals.map((animal) => ({
    ...animal,
    latestWeightKg: latestByAnimal.get(animal.id)?.weightKg ?? null,
    latestWeightDate: latestByAnimal.get(animal.id)?.recordedAt ?? null,
  }));
}

export async function getAnimalRecord(
  animalId: string,
  accessScope: OrganizationFieldScope,
): Promise<AnimalRecord | null> {
  if (accessScope.fieldIds.length === 0) return null;
  const db = getDb();
  const [recordScope] = await db
    .select({
      animal: livestockAnimals,
      fieldId: livestockLots.fieldId,
      fieldName: fields.name,
      lotName: livestockLots.name,
    })
    .from(livestockAnimals)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockAnimals.id, animalId),
      eq(fields.organizationId, accessScope.organizationId),
      inArray(fields.id, accessScope.fieldIds),
    ))
    .limit(1);
  if (!recordScope) return null;

  const [identifierRows, lactationRows, controlRows, eventRows, birthRows, offspringRows, parentLinkRows, healthRows, weighingRows] = await Promise.all([
    db.select().from(livestockAnimalIdentifiers).where(eq(livestockAnimalIdentifiers.animalId, animalId)).orderBy(desc(livestockAnimalIdentifiers.isPrimary), asc(livestockAnimalIdentifiers.kind)),
    db.select().from(livestockLactations).where(eq(livestockLactations.animalId, animalId)).orderBy(desc(livestockLactations.startedAt)),
    db.select().from(livestockMilkControls).where(eq(livestockMilkControls.animalId, animalId)).orderBy(desc(livestockMilkControls.controlDate)),
    db.select().from(livestockReproductiveEvents).where(eq(livestockReproductiveEvents.animalId, animalId)).orderBy(desc(livestockReproductiveEvents.occurredAt), desc(livestockReproductiveEvents.createdAt)),
    db.select().from(livestockBirths).where(eq(livestockBirths.damAnimalId, animalId)).orderBy(desc(livestockBirths.occurredAt), desc(livestockBirths.createdAt)),
    db.select().from(livestockBirthOffspring).innerJoin(livestockBirths, eq(livestockBirths.id, livestockBirthOffspring.birthId)).where(eq(livestockBirths.damAnimalId, animalId)).orderBy(asc(livestockBirthOffspring.id)),
    db.select().from(livestockBirthOffspring).where(eq(livestockBirthOffspring.animalId, animalId)),
    db.select().from(livestockHealthEvents).where(eq(livestockHealthEvents.animalId, animalId)).orderBy(desc(livestockHealthEvents.occurredAt), desc(livestockHealthEvents.createdAt)),
    db.select().from(livestockWeighings).where(eq(livestockWeighings.animalId, animalId)).orderBy(desc(livestockWeighings.recordedAt), desc(livestockWeighings.createdAt)),
  ]);

  const latestWeighing = weighingRows[0];
  const animal = toAnimal(recordScope.animal, latestWeighing);
  const lactations = lactationRows.map(toLactation);
  const milkControls = controlRows.map(toMilkControl);
  const reproductiveEvents = eventRows.map(toReproductiveEvent);
  const offspringByBirth = new Map<string, LivestockBirthOffspring[]>();
  for (const row of offspringRows) {
    const offspring = toBirthOffspring(row.livestock_birth_offspring);
    offspringByBirth.set(offspring.birthId, [...(offspringByBirth.get(offspring.birthId) ?? []), offspring]);
  }
  const births = birthRows.map((row) => toBirth(row, offspringByBirth.get(row.id) ?? []));
  const parentage = await buildParentage(parentLinkRows);
  const healthEvents = healthRows.map(toHealthEvent);
  const weighings = weighingRows.map(toWeighing);
  const identifiers = [
    { id: `fundosmart:${animal.id}:tag`, kind: "DIIO", value: animal.tag, sourceSystem: "fundosmart", validFrom: null, validTo: null },
    ...identifierRows
      // El número vigente ya se muestra arriba; su fila espejo se omite, pero la
      // historia cerrada del mismo valor sí debe verse.
      .filter((entry) => !(entry.value === animal.tag && entry.validTo === null))
      .map((entry) => ({
        id: entry.id,
        kind: entry.kind,
        value: entry.value,
        sourceSystem: entry.sourceSystem,
        validFrom: entry.validFrom,
        validTo: entry.validTo,
      }))
      .sort((left, right) => {
        if (left.validTo === right.validTo) return left.kind.localeCompare(right.kind, "es");
        if (left.validTo === null) return -1;
        if (right.validTo === null) return 1;
        return right.validTo.localeCompare(left.validTo);
      }),
  ];

  return {
    animal,
    fieldId: recordScope.fieldId,
    fieldName: recordScope.fieldName,
    lotName: recordScope.lotName,
    identifiers,
    lactations,
    milkControls,
    reproductiveEvents,
    births,
    healthEvents,
    parentage,
    weighings,
    timeline: buildTimeline({ births, healthEvents, lactations, milkControls, parentage, reproductiveEvents, weighings }),
    insights: buildAnimalInsights({ births, healthEvents, lactations, milkControls, reproductiveEvents, weighings }),
  };
}

export async function saveMilkControl(
  input: MilkControlInput & { totalLiters: number },
  actor: string,
  accessScope: OrganizationFieldScope,
): Promise<AnimalRecord> {
  const scope = await resolveAnimalScope(input.animalId, accessScope);
  if (!scope) throw new DomainRuleError("El animal seleccionado no existe.");
  if (scope.animal.sex === "male") throw new DomainRuleError("Un animal registrado como macho no puede recibir controles lecheros.");

  const db = getDb();
  const [lactation] = await db
    .select({ id: livestockLactations.id })
    .from(livestockLactations)
    .where(and(
      eq(livestockLactations.animalId, input.animalId),
      eq(livestockLactations.fieldId, scope.fieldId),
      lte(livestockLactations.startedAt, input.controlDate),
      or(isNull(livestockLactations.endedAt), gte(livestockLactations.endedAt, input.controlDate)),
    ))
    .orderBy(desc(livestockLactations.startedAt), desc(livestockLactations.id))
    .limit(1);
  const [existing] = await db
    .select()
    .from(livestockMilkControls)
    .where(and(
      eq(livestockMilkControls.fieldId, scope.fieldId),
      eq(livestockMilkControls.animalId, input.animalId),
      eq(livestockMilkControls.controlDate, input.controlDate),
    ))
    .limit(1);
  const id = existing?.id ?? `milk-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const values = {
    id,
    fieldId: scope.fieldId,
    animalId: input.animalId,
    lactationId: lactation?.id ?? null,
    controlDate: input.controlDate,
    morningLiters: input.morningLiters,
    afternoonLiters: input.afternoonLiters,
    thirdMilkingLiters: input.thirdMilkingLiters,
    totalLiters: input.totalLiters,
    fatPct: input.fatPct,
    proteinPct: input.proteinPct,
    somaticCellCount: input.somaticCellCount,
    notes: input.notes,
    source: existing?.source ?? "Registro manual",
    sourceRecordId: existing?.sourceRecordId ?? null,
    createdBy: actor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const writeCondition = milkControlWriteCondition(values, existing ?? null, accessScope);
  const client = db.$client;
  const auditStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
    WHERE ${writeCondition.sql}
  `).bind(
    crypto.randomUUID(),
    scope.organizationId,
    scope.fieldId,
    actor,
    existing ? "milk_control.updated" : "milk_control.created",
    "livestock_milk_control",
    id,
    existing ? JSON.stringify(existing) : null,
    JSON.stringify(values),
    now,
    ...writeCondition.bindings,
  );
  const mutationStatement = existing
    ? client.prepare(`
      UPDATE livestock_milk_controls
      SET lactation_id = ?, morning_liters = ?, afternoon_liters = ?,
          third_milking_liters = ?, total_liters = ?, fat_pct = ?, protein_pct = ?,
          somatic_cell_count = ?, notes = ?, created_by = ?, updated_at = ?
      WHERE id = ? AND ${writeCondition.sql}
    `).bind(
      values.lactationId,
      values.morningLiters,
      values.afternoonLiters,
      values.thirdMilkingLiters,
      values.totalLiters,
      values.fatPct,
      values.proteinPct,
      values.somaticCellCount,
      values.notes,
      values.createdBy,
      values.updatedAt,
      values.id,
      ...writeCondition.bindings,
    )
    : client.prepare(`
      INSERT INTO livestock_milk_controls (
        id, field_id, animal_id, lactation_id, control_date,
        morning_liters, afternoon_liters, third_milking_liters, total_liters,
        fat_pct, protein_pct, somatic_cell_count, notes, source,
        source_record_id, created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${writeCondition.sql}
    `).bind(
      values.id,
      values.fieldId,
      values.animalId,
      values.lactationId,
      values.controlDate,
      values.morningLiters,
      values.afternoonLiters,
      values.thirdMilkingLiters,
      values.totalLiters,
      values.fatPct,
      values.proteinPct,
      values.somaticCellCount,
      values.notes,
      values.source,
      values.sourceRecordId,
      values.createdBy,
      values.createdAt,
      values.updatedAt,
      ...writeCondition.bindings,
    );
  const [auditResult, mutationResult] = await client.batch([auditStatement, mutationStatement]);
  if (auditResult.meta.changes !== 1 || mutationResult.meta.changes !== 1) {
    throw new DomainRuleError(
      "El animal, la lactancia o el control cambiaron mientras se guardaba el control lechero.",
      "FIELD_SCOPE_CONFLICT",
    );
  }
  return requireAnimalRecord(input.animalId, accessScope);
}

export async function saveReproductiveEvent(
  input: ReproductiveEventInput,
  actor: string,
  accessScope: OrganizationFieldScope,
): Promise<AnimalRecord> {
  const scope = await resolveAnimalScope(input.animalId, accessScope);
  if (!scope) throw new DomainRuleError("El animal seleccionado no existe.");
  if (scope.animal.sex === "male") throw new DomainRuleError("Los eventos reproductivos de esta ficha están destinados a hembras.");

  const db = getDb();
  const id = `repro:${input.animalId}:${input.eventType}:${input.occurredAt}`;
  const [existing] = await db.select().from(livestockReproductiveEvents).where(and(
    eq(livestockReproductiveEvents.id, id),
    eq(livestockReproductiveEvents.fieldId, scope.fieldId),
    eq(livestockReproductiveEvents.animalId, input.animalId),
  )).limit(1);
  const sireMatches = await resolveKnownAnimalIds(input.sireIdentifier ? [input.sireIdentifier] : [], scope.fieldId);
  const sireAnimalId = input.sireIdentifier ? sireMatches.get(animalIdentifierKey(input.sireIdentifier)) ?? null : null;
  if (sireAnimalId === input.animalId) throw new DomainRuleError("Un animal no puede figurar como su propio progenitor.");
  const now = new Date().toISOString();
  const eventValues: ReproductiveEventRow = {
    id,
    fieldId: scope.fieldId,
    animalId: input.animalId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    method: input.method,
    result: input.result,
    sireIdentifier: input.sireIdentifier,
    sireAnimalId,
    notes: input.notes,
    metadata: existing?.metadata ?? {},
    source: existing?.source ?? "Registro manual",
    sourceRecordId: existing?.sourceRecordId ?? null,
    createdBy: actor,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  const client = db.$client;
  const eventScope = femaleAnimalWriteScopeCondition(input.animalId, scope.fieldId, accessScope);
  if (existing) {
    const writeCondition = combineSqlConditions(eventScope, reproductiveEventRowCondition(existing));
    await executeReproductiveBatch(client, [
      prepareConditionalAnimalRecordAudit(client, {
        organizationId: scope.organizationId,
        fieldId: scope.fieldId,
        actor,
        action: "reproductive_event.updated",
        entityType: "livestock_reproductive_event",
        entityId: id,
        before: existing,
        after: eventValues,
        occurredAt: now,
      }, writeCondition),
      prepareReproductiveEventUpdate(client, eventValues, writeCondition),
    ]);
    return requireAnimalRecord(input.animalId, accessScope);
  }

  const [[activeLactation], [sequence]] = await Promise.all([
    db.select().from(livestockLactations).where(and(
      eq(livestockLactations.fieldId, scope.fieldId),
      eq(livestockLactations.animalId, input.animalId),
      eq(livestockLactations.status, "active"),
    )).limit(1),
    db.select({ value: max(livestockLactations.sequenceNumber) })
      .from(livestockLactations)
      .where(eq(livestockLactations.animalId, input.animalId)),
  ]);
  const availableEvent = reproductiveEventAvailableCondition(id);
  const eventAudit = (condition: SqlCondition) => prepareConditionalAnimalRecordAudit(client, {
    organizationId: scope.organizationId,
    fieldId: scope.fieldId,
    actor,
    action: "reproductive_event.created",
    entityType: "livestock_reproductive_event",
    entityId: id,
    before: null,
    after: eventValues,
    occurredAt: now,
  }, condition);

  if (input.eventType === "calving") {
    if (activeLactation?.startedAt === input.occurredAt) {
      const writeCondition = combineSqlConditions(
        eventScope,
        availableEvent,
        activeLactationStateCondition(activeLactation, input.animalId, scope.fieldId),
      );
      await executeReproductiveBatch(client, [
        eventAudit(writeCondition),
        prepareReproductiveEventInsert(client, eventValues, writeCondition),
      ]);
      return requireAnimalRecord(input.animalId, accessScope);
    }
    if (activeLactation && activeLactation.startedAt > input.occurredAt) {
      throw new DomainRuleError("El parto no puede anteceder al inicio de la lactancia activa.");
    }
    const currentSequence = sequence?.value ?? 0;
    const nextSequence = currentSequence + 1;
    const lactationId = `lactation-${crypto.randomUUID()}`;
    const lactationValues: LactationRow = {
      id: lactationId,
      fieldId: scope.fieldId,
      animalId: input.animalId,
      sequenceNumber: nextSequence,
      calvingDate: input.occurredAt,
      startedAt: input.occurredAt,
      endedAt: null,
      status: "active" as const,
      dryOffReason: null,
      source: "Evento de parto",
      sourceRecordId: null,
      createdBy: actor,
      createdAt: now,
      updatedAt: now,
    };
    const writeCondition = combineSqlConditions(
      eventScope,
      availableEvent,
      activeLactationStateCondition(activeLactation ?? null, input.animalId, scope.fieldId),
      lactationSequenceCondition(input.animalId, currentSequence),
      lactationAvailableCondition(lactationId, input.animalId, nextSequence),
    );
    const lactationAudit = prepareConditionalAnimalRecordAudit(client, {
      organizationId: scope.organizationId,
      fieldId: scope.fieldId,
      actor,
      action: "lactation.created_from_calving",
      entityType: "livestock_lactation",
      entityId: lactationId,
      before: null,
      after: lactationValues,
      occurredAt: now,
    }, writeCondition);
    if (activeLactation) {
      const closedLactation: LactationRow = {
        ...activeLactation,
        status: "closed",
        endedAt: input.occurredAt,
        updatedAt: now,
      };
      await executeReproductiveBatch(client, [
        eventAudit(writeCondition),
        prepareConditionalAnimalRecordAudit(client, {
          organizationId: scope.organizationId,
          fieldId: scope.fieldId,
          actor,
          action: "lactation.closed_by_new_calving",
          entityType: "livestock_lactation",
          entityId: activeLactation.id,
          before: activeLactation,
          after: closedLactation,
          occurredAt: now,
        }, writeCondition),
        lactationAudit,
        prepareReproductiveEventInsert(client, eventValues, writeCondition),
        prepareLactationUpdate(
          client,
          closedLactation,
          combineSqlConditions(reproductiveEventRowCondition(eventValues), lactationRowCondition(activeLactation)),
        ),
        prepareLactationInsert(client, lactationValues, combineSqlConditions(
          reproductiveEventRowCondition(eventValues),
          lactationRowCondition(closedLactation),
          lactationSequenceCondition(input.animalId, currentSequence),
          lactationAvailableCondition(lactationId, input.animalId, nextSequence),
        )),
      ]);
    } else {
      await executeReproductiveBatch(client, [
        eventAudit(writeCondition),
        lactationAudit,
        prepareReproductiveEventInsert(client, eventValues, writeCondition),
        prepareLactationInsert(client, lactationValues, combineSqlConditions(
          reproductiveEventRowCondition(eventValues),
          activeLactationStateCondition(null, input.animalId, scope.fieldId),
          lactationSequenceCondition(input.animalId, currentSequence),
          lactationAvailableCondition(lactationId, input.animalId, nextSequence),
        )),
      ]);
    }
  } else if (input.eventType === "dry_off" && activeLactation) {
    if (input.occurredAt < activeLactation.startedAt) throw new DomainRuleError("El secado no puede anteceder al inicio de la lactancia activa.");
    const closedLactation: LactationRow = {
      ...activeLactation,
      status: "dry",
      endedAt: input.occurredAt,
      dryOffReason: input.result || input.notes || "Secado registrado",
      updatedAt: now,
    };
    const writeCondition = combineSqlConditions(
      eventScope,
      availableEvent,
      activeLactationStateCondition(activeLactation, input.animalId, scope.fieldId),
    );
    await executeReproductiveBatch(client, [
      eventAudit(writeCondition),
      prepareConditionalAnimalRecordAudit(client, {
        organizationId: scope.organizationId,
        fieldId: scope.fieldId,
        actor,
        action: "lactation.closed_by_dry_off",
        entityType: "livestock_lactation",
        entityId: activeLactation.id,
        before: activeLactation,
        after: closedLactation,
        occurredAt: now,
      }, writeCondition),
      prepareReproductiveEventInsert(client, eventValues, writeCondition),
      prepareLactationUpdate(
        client,
        closedLactation,
        combineSqlConditions(reproductiveEventRowCondition(eventValues), lactationRowCondition(activeLactation)),
      ),
    ]);
  } else {
    const writeCondition = combineSqlConditions(
      eventScope,
      availableEvent,
      ...(input.eventType === "dry_off"
        ? [activeLactationStateCondition(null, input.animalId, scope.fieldId)]
        : []),
    );
    await executeReproductiveBatch(client, [
      eventAudit(writeCondition),
      prepareReproductiveEventInsert(client, eventValues, writeCondition),
    ]);
  }
  return requireAnimalRecord(input.animalId, accessScope);
}

export async function saveBirth(
  input: BirthInput,
  actor: string,
  accessScope: OrganizationFieldScope,
): Promise<AnimalRecord> {
  const scope = await resolveAnimalScope(input.animalId, accessScope);
  if (!scope) throw new DomainRuleError("El animal seleccionado no existe.");
  if (scope.animal.sex === "male") throw new DomainRuleError("Un animal registrado como macho no puede figurar como madre del parto.");

  const db = getDb();
  const client = db.$client;
  const birthId = `birth:${input.animalId}:${input.occurredAt}`;
  const eventId = `repro:${input.animalId}:calving:${input.occurredAt}`;
  const [existingBirth] = await db.select().from(livestockBirths).where(and(
    eq(livestockBirths.id, birthId),
    eq(livestockBirths.fieldId, scope.fieldId),
    eq(livestockBirths.damAnimalId, input.animalId),
    eq(livestockBirths.occurredAt, input.occurredAt),
  )).limit(1);
  if (existingBirth) return requireAnimalRecord(input.animalId, accessScope);

  const [[existingEvent], [activeLactation], [sameDateLactation], [latestLactation], [sequence], linkedAnimals, sireMatches] = await Promise.all([
    db.select().from(livestockReproductiveEvents).where(eq(livestockReproductiveEvents.id, eventId)).limit(1),
    db.select().from(livestockLactations).where(and(
      eq(livestockLactations.fieldId, scope.fieldId),
      eq(livestockLactations.animalId, input.animalId),
      eq(livestockLactations.status, "active"),
    )).limit(1),
    db.select().from(livestockLactations).where(and(
      eq(livestockLactations.fieldId, scope.fieldId),
      eq(livestockLactations.animalId, input.animalId),
      eq(livestockLactations.calvingDate, input.occurredAt),
    )).orderBy(asc(livestockLactations.id)).limit(1),
    db.select().from(livestockLactations).where(eq(livestockLactations.animalId, input.animalId)).orderBy(desc(livestockLactations.startedAt)).limit(1),
    db.select({ value: max(livestockLactations.sequenceNumber) }).from(livestockLactations).where(eq(livestockLactations.animalId, input.animalId)),
    resolveKnownAnimalIds(input.offspring.map((entry) => entry.temporaryIdentifier), scope.fieldId),
    resolveKnownAnimalIds(input.sireIdentifier ? [input.sireIdentifier] : [], scope.fieldId),
  ]);
  if (existingEvent && (
    existingEvent.fieldId !== scope.fieldId
    || existingEvent.animalId !== input.animalId
    || existingEvent.eventType !== "calving"
    || existingEvent.occurredAt !== input.occurredAt
  )) {
    throw new DomainRuleError(
      "El evento de parto cambió mientras se preparaba el registro.",
      "FIELD_SCOPE_CONFLICT",
    );
  }
  if (!sameDateLactation && latestLactation && latestLactation.startedAt > input.occurredAt) {
    throw new DomainRuleError("El parto retroactivo antecede a una lactancia posterior. Revísalo antes de incorporarlo a la genealogía.");
  }
  if ([...linkedAnimals.values()].includes(input.animalId)) throw new DomainRuleError("Una cría no puede enlazarse con la misma madre.");
  const linkedAnimalValues = input.offspring
    .map((entry) => linkedAnimals.get(animalIdentifierKey(entry.temporaryIdentifier)))
    .filter((animalId): animalId is string => Boolean(animalId));
  const linkedAnimalIds = [...new Set(linkedAnimalValues)];
  if (linkedAnimalIds.length !== linkedAnimalValues.length) {
    throw new DomainRuleError("Dos crías del mismo parto no pueden enlazarse con el mismo animal.");
  }
  const sireAnimalId = input.sireIdentifier ? sireMatches.get(animalIdentifierKey(input.sireIdentifier)) ?? null : null;
  if (sireAnimalId === input.animalId) throw new DomainRuleError("Un animal no puede figurar como su propio progenitor.");
  if (linkedAnimalIds.length > 0) {
    const [existingLink] = await db.select({ id: livestockBirthOffspring.id })
      .from(livestockBirthOffspring)
      .where(inArray(livestockBirthOffspring.animalId, linkedAnimalIds))
      .limit(1);
    if (existingLink) throw new DomainRuleError("Uno de los animales ya está enlazado como cría de otro parto.");
  }

  const now = new Date().toISOString();
  const eventValues: ReproductiveEventRow = {
    id: eventId,
    fieldId: scope.fieldId,
    animalId: input.animalId,
    eventType: "calving" as const,
    occurredAt: input.occurredAt,
    method: LIVESTOCK_CALVING_DIFFICULTY_LABELS[input.difficulty],
    result: `${input.offspring.length} cría${input.offspring.length === 1 ? "" : "s"} · ${input.outcome}`,
    sireIdentifier: input.sireIdentifier,
    sireAnimalId,
    notes: input.notes,
    metadata: { birthId },
    source: "Registro de parto",
    sourceRecordId: null,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  const birthValues: BirthRow = {
    id: birthId,
    fieldId: scope.fieldId,
    damAnimalId: input.animalId,
    reproductiveEventId: eventId,
    occurredAt: input.occurredAt,
    calvingType: input.calvingType,
    difficulty: input.difficulty,
    outcome: input.outcome,
    sireIdentifier: input.sireIdentifier,
    sireAnimalId,
    notes: input.notes,
    source: "Registro manual",
    sourceRecordId: null,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  const offspringValues: BirthOffspringRow[] = input.offspring.map((entry, index) => ({
    id: `${birthId}:offspring:${index + 1}`,
    birthId,
    animalId: linkedAnimals.get(animalIdentifierKey(entry.temporaryIdentifier)) ?? null,
    temporaryIdentifier: entry.temporaryIdentifier,
    sex: entry.sex,
    outcome: entry.outcome,
    birthWeightKg: entry.birthWeightKg,
    notes: entry.notes,
    createdAt: now,
    updatedAt: now,
  }));

  const currentSequence = sequence?.value ?? 0;
  const lactationId = `lactation-${crypto.randomUUID()}`;
  const lactationValues: LactationRow | null = sameDateLactation ? null : {
    id: lactationId,
    fieldId: scope.fieldId,
    animalId: input.animalId,
    sequenceNumber: currentSequence + 1,
    calvingDate: input.occurredAt,
    startedAt: input.occurredAt,
    endedAt: null,
    status: "active",
    dryOffReason: null,
    source: "Registro de parto",
    sourceRecordId: null,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  const closedLactation: LactationRow | null = !sameDateLactation && activeLactation ? {
    ...activeLactation,
    status: "closed",
    endedAt: input.occurredAt,
    updatedAt: now,
  } : null;
  const eventState = existingEvent
    ? reproductiveEventRowCondition(existingEvent)
    : reproductiveEventAvailableCondition(eventId);
  const writeConditions = [
    femaleAnimalWriteScopeCondition(input.animalId, scope.fieldId, accessScope),
    birthAvailableCondition(birthId, input.animalId, input.occurredAt),
    eventState,
    sameDateLactationStateCondition(sameDateLactation ?? null, input.animalId, scope.fieldId, input.occurredAt),
    birthOffspringResolutionCondition(input.offspring.map((entry) => ({
      identifier: animalIdentifierKey(entry.temporaryIdentifier),
      animalId: linkedAnimals.get(animalIdentifierKey(entry.temporaryIdentifier)) ?? null,
    })), scope.fieldId),
    birthOffspringAvailableCondition(offspringValues),
  ];
  if (!sameDateLactation && lactationValues) {
    writeConditions.push(
      activeLactationStateCondition(activeLactation ?? null, input.animalId, scope.fieldId),
      noLaterLactationCondition(input.animalId, input.occurredAt),
      lactationSequenceCondition(input.animalId, currentSequence),
      lactationAvailableCondition(lactationValues.id, input.animalId, lactationValues.sequenceNumber),
    );
  }
  const writeCondition = combineSqlConditions(...writeConditions);
  const guardAuditId = crypto.randomUUID();
  const statements: D1PreparedStatement[] = [
    prepareConditionalAnimalRecordAudit(client, {
      id: guardAuditId,
      organizationId: scope.organizationId,
      fieldId: scope.fieldId,
      actor,
      action: "birth.created",
      entityType: "livestock_birth",
      entityId: birthId,
      before: null,
      after: { ...birthValues, offspring: offspringValues },
      occurredAt: now,
    }, writeCondition),
  ];
  if (!existingEvent) {
    statements.push(prepareConditionalAnimalRecordAudit(client, {
      organizationId: scope.organizationId,
      fieldId: scope.fieldId,
      actor,
      action: "reproductive_event.created_from_birth",
      entityType: "livestock_reproductive_event",
      entityId: eventId,
      before: null,
      after: eventValues,
      occurredAt: now,
    }, writeCondition));
  }
  if (closedLactation) {
    statements.push(prepareConditionalAnimalRecordAudit(client, {
      organizationId: scope.organizationId,
      fieldId: scope.fieldId,
      actor,
      action: "lactation.closed_by_new_calving",
      entityType: "livestock_lactation",
      entityId: closedLactation.id,
      before: activeLactation,
      after: closedLactation,
      occurredAt: now,
    }, writeCondition));
  }
  if (lactationValues) {
    statements.push(prepareConditionalAnimalRecordAudit(client, {
      organizationId: scope.organizationId,
      fieldId: scope.fieldId,
      actor,
      action: "lactation.created_from_birth",
      entityType: "livestock_lactation",
      entityId: lactationValues.id,
      before: null,
      after: lactationValues,
      occurredAt: now,
    }, writeCondition));
  }

  const guardCondition = auditRowCondition(guardAuditId, "birth.created", birthId);
  if (!existingEvent) {
    statements.push(prepareReproductiveEventInsert(client, eventValues, combineSqlConditions(writeCondition, guardCondition)));
  }
  const eventReady = combineSqlConditions(
    guardCondition,
    reproductiveEventRowCondition(existingEvent ?? eventValues),
  );
  if (closedLactation) {
    statements.push(prepareLactationUpdate(
      client,
      closedLactation,
      combineSqlConditions(eventReady, lactationRowCondition(activeLactation!)),
    ));
  }
  if (lactationValues) {
    statements.push(prepareLactationInsert(client, lactationValues, combineSqlConditions(
      eventReady,
      closedLactation
        ? lactationRowCondition(closedLactation)
        : activeLactationStateCondition(null, input.animalId, scope.fieldId),
      lactationSequenceCondition(input.animalId, currentSequence),
      lactationAvailableCondition(lactationValues.id, input.animalId, lactationValues.sequenceNumber),
    )));
  }
  const lactationReady = sameDateLactation
    ? sameDateLactationStateCondition(sameDateLactation, input.animalId, scope.fieldId, input.occurredAt)
    : lactationRowCondition(lactationValues!);
  statements.push(prepareBirthInsert(client, birthValues, combineSqlConditions(eventReady, lactationReady)));
  for (const offspring of offspringValues) {
    statements.push(prepareBirthOffspringInsert(client, offspring, combineSqlConditions(
      guardCondition,
      birthRowCondition(birthValues),
      birthOffspringRowAvailableCondition(offspring),
    )));
  }
  await executeBirthBatch(client, statements);
  return requireAnimalRecord(input.animalId, accessScope);
}

export async function saveHealthEvent(
  input: HealthEventInput,
  actor: string,
  accessScope: OrganizationFieldScope,
): Promise<AnimalRecord> {
  const scope = await resolveAnimalScope(input.animalId, accessScope);
  if (!scope) throw new DomainRuleError("El animal seleccionado no existe.");
  const db = getDb();
  const id = `health-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const values = {
    id,
    fieldId: scope.fieldId,
    animalId: input.animalId,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    status: input.status,
    condition: input.condition,
    productName: input.productName,
    activeIngredient: input.activeIngredient,
    doseAmount: input.doseAmount,
    doseUnit: input.doseUnit,
    route: input.route,
    withdrawalMilkUntil: input.withdrawalMilkUntil,
    withdrawalMeatUntil: input.withdrawalMeatUntil,
    professional: input.professional,
    notes: input.notes,
    metadata: {},
    source: "Registro manual",
    sourceRecordId: null,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  const writeCondition = animalWriteScopeCondition(input.animalId, scope.fieldId, accessScope);
  const client = db.$client;
  const [eventResult, auditResult] = await client.batch([
    client.prepare(`
      INSERT INTO livestock_health_events (
        id, field_id, animal_id, event_type, occurred_at, status, condition,
        product_name, active_ingredient, dose_amount, dose_unit, route,
        withdrawal_milk_until, withdrawal_meat_until, professional, notes,
        metadata, source, source_record_id, created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${writeCondition.sql}
    `).bind(
      values.id,
      values.fieldId,
      values.animalId,
      values.eventType,
      values.occurredAt,
      values.status,
      values.condition,
      values.productName,
      values.activeIngredient,
      values.doseAmount,
      values.doseUnit,
      values.route,
      values.withdrawalMilkUntil,
      values.withdrawalMeatUntil,
      values.professional,
      values.notes,
      JSON.stringify(values.metadata),
      values.source,
      values.sourceRecordId,
      values.createdBy,
      values.createdAt,
      values.updatedAt,
      ...writeCondition.bindings,
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, source_record_id, occurred_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${writeCondition.sql}
    `).bind(
      crypto.randomUUID(),
      scope.organizationId,
      scope.fieldId,
      actor,
      "health_event.created",
      "livestock_health_event",
      id,
      null,
      JSON.stringify(values),
      null,
      now,
      ...writeCondition.bindings,
    ),
  ]);
  if (eventResult.meta.changes !== 1 || auditResult.meta.changes !== 1) {
    throw new DomainRuleError(
      "La pertenencia del animal cambió mientras se guardaba el evento sanitario.",
      "FIELD_SCOPE_CONFLICT",
    );
  }
  return requireAnimalRecord(input.animalId, accessScope);
}

const renumberConflictMessage =
  "No fue posible cambiar el número: revisa que no esté en uso por otro animal del mismo fundo y vuelve a abrir la ficha.";

export async function saveAnimalRenumber(
  input: RenumberInput,
  actor: string,
  accessScope: OrganizationFieldScope,
): Promise<AnimalRecord> {
  const scope = await resolveAnimalScope(input.animalId, accessScope);
  if (!scope) throw new DomainRuleError("El animal seleccionado no existe.");
  const previousTag = scope.animal.tag;
  if (normalizeAnimalTag(previousTag) === normalizeAnimalTag(input.newTag)) {
    throw new DomainRuleError("El número nuevo es igual al actual.", "RENUMBER_UNCHANGED");
  }

  const db = getDb();
  const [activeIdentifier] = await db
    .select({ validFrom: livestockAnimalIdentifiers.validFrom })
    .from(livestockAnimalIdentifiers)
    .where(and(
      eq(livestockAnimalIdentifiers.animalId, input.animalId),
      eq(livestockAnimalIdentifiers.sourceSystem, "manual"),
      eq(livestockAnimalIdentifiers.kind, "tag"),
      isNull(livestockAnimalIdentifiers.validTo),
    ))
    .limit(1);
  if (activeIdentifier?.validFrom && input.effectiveOn < activeIdentifier.validFrom) {
    throw new DomainRuleError(
      `El número vigente rige desde el ${activeIdentifier.validFrom}; el cambio no puede quedar antes de esa fecha.`,
      "RENUMBER_DATE_BEFORE_CURRENT",
    );
  }

  const now = new Date().toISOString();
  const plan = buildAnimalRenumberPlan({
    animalId: input.animalId,
    fieldId: scope.fieldId,
    organizationId: scope.organizationId,
    fieldIds: accessScope.fieldIds,
    previousTag,
    previousNormalizedTag: normalizeAnimalTag(previousTag),
    newTag: input.newTag,
    newNormalizedTag: normalizeAnimalTag(input.newTag),
    effectiveOn: input.effectiveOn,
    reason: input.reason,
    actor,
    now,
    historyIdentifierId: `identifier-${crypto.randomUUID()}`,
    activeIdentifierId: `identifier-${crypto.randomUUID()}`,
    auditId: crypto.randomUUID(),
  });

  const client = db.$client;
  const statements = plan.map((statement) => client.prepare(statement.sql).bind(...statement.bindings));
  // La última sentencia afirma el estado final: si no se cumple provoca un desborde
  // entero que aborta el lote completo, de modo que nunca queda un cambio a medias.
  let results: D1Result[];
  try {
    results = await client.batch(statements);
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint/iu.test(cause.message)) {
      throw new DomainRuleError(renumberConflictMessage, "RENUMBER_CONFLICT");
    }
    throw cause;
  }
  const applied = assertRenumberPlanApplied(
    plan.map((statement, index) => ({ label: statement.label, changes: results[index]?.meta.changes ?? 0 })),
  );
  if (!applied) throw new DomainRuleError(renumberConflictMessage, "RENUMBER_CONFLICT");
  return requireAnimalRecord(input.animalId, accessScope);
}

export async function saveHealthEventsBatch(inputs: HealthEventInput[], actor: string, batchId: string): Promise<number> {
  if (inputs.length === 0) return 0;
  if (inputs.length > 40) throw new DomainRuleError("Un tratamiento grupal admite hasta 40 animales por operación atómica.");
  const db = getDb();
  type BatchItem = Parameters<typeof db.batch>[0][number];
  const statements: BatchItem[] = [];
  for (const input of inputs) {
    const [scope] = await db
      .select({ fieldId: livestockLots.fieldId, organizationId: fields.organizationId })
      .from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(eq(livestockAnimals.id, input.animalId))
      .limit(1);
    if (!scope) throw new DomainRuleError(`El animal ${input.animalId} no existe.`);
    const id = `health-batch:${batchId}:${input.animalId}`;
    const now = new Date().toISOString();
    const values = {
      id, fieldId: scope.fieldId, animalId: input.animalId, eventType: input.eventType,
      occurredAt: input.occurredAt, status: input.status, condition: input.condition,
      productName: input.productName, activeIngredient: input.activeIngredient,
      doseAmount: input.doseAmount, doseUnit: input.doseUnit, route: input.route,
      withdrawalMilkUntil: input.withdrawalMilkUntil, withdrawalMeatUntil: input.withdrawalMeatUntil,
      professional: input.professional, notes: input.notes, metadata: { batch: true },
      source: "Registro grupal", sourceRecordId: null, createdBy: actor, createdAt: now, updatedAt: now,
    };
    statements.push(
      db.insert(livestockHealthEvents).values(values).onConflictDoNothing(),
      db.insert(auditLog).values({
        id: `audit:${id}`, organizationId: scope.organizationId, fieldId: scope.fieldId, actor,
        action: "health_event.batch_created", entityType: "livestock_health_event", entityId: id,
        before: null, after: values, occurredAt: now,
      }).onConflictDoNothing(),
    );
  }
  await db.batch(statements as [BatchItem, ...BatchItem[]]);
  return inputs.length;
}

async function requireAnimalRecord(animalId: string, scope: OrganizationFieldScope): Promise<AnimalRecord> {
  const record = await getAnimalRecord(animalId, scope);
  if (!record) throw new Error("La ficha animal no quedó disponible después de guardar.");
  return record;
}

async function resolveAnimalScope(animalId: string, accessScope: OrganizationFieldScope) {
  if (accessScope.fieldIds.length === 0) return null;
  const [animalScope] = await getDb()
    .select({
      animal: livestockAnimals,
      fieldId: livestockLots.fieldId,
      organizationId: fields.organizationId,
    })
    .from(livestockAnimals)
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockAnimals.id, animalId),
      eq(fields.organizationId, accessScope.organizationId),
      inArray(fields.id, accessScope.fieldIds),
    ))
    .limit(1);
  return animalScope ?? null;
}

function animalWriteScopeCondition(
  animalId: string,
  fieldId: string,
  accessScope: OrganizationFieldScope,
): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_animals AS current_animal
        INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
        INNER JOIN fields AS current_field ON current_field.id = current_lot.field_id
        WHERE current_animal.id = ?
          AND current_field.id = ?
          AND current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
      )
    `,
    bindings: [animalId, fieldId, accessScope.organizationId, JSON.stringify(accessScope.fieldIds)],
  };
}

function combineSqlConditions(...conditions: SqlCondition[]): SqlCondition {
  return {
    sql: conditions.map((condition) => `(${condition.sql})`).join(" AND "),
    bindings: conditions.flatMap((condition) => condition.bindings),
  };
}

function femaleAnimalWriteScopeCondition(
  animalId: string,
  fieldId: string,
  accessScope: OrganizationFieldScope,
): SqlCondition {
  return combineSqlConditions(
    animalWriteScopeCondition(animalId, fieldId, accessScope),
    {
      sql: `
        EXISTS (
          SELECT 1 FROM livestock_animals AS eligible_animal
          WHERE eligible_animal.id = ? AND eligible_animal.sex <> 'male'
        )
      `,
      bindings: [animalId],
    },
  );
}

function reproductiveEventAvailableCondition(id: string): SqlCondition {
  return {
    sql: "NOT EXISTS (SELECT 1 FROM livestock_reproductive_events AS competing_event WHERE competing_event.id = ?)",
    bindings: [id],
  };
}

function reproductiveEventRowCondition(event: ReproductiveEventRow): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_reproductive_events AS current_event
        WHERE current_event.id = ?
          AND current_event.field_id = ?
          AND current_event.animal_id = ?
          AND current_event.event_type = ?
          AND current_event.occurred_at = ?
          AND current_event.method IS ?
          AND current_event.result IS ?
          AND current_event.sire_identifier IS ?
          AND current_event.notes = ?
          AND current_event.metadata = ?
          AND current_event.source = ?
          AND current_event.source_record_id IS ?
          AND current_event.created_by = ?
          AND current_event.created_at = ?
          AND current_event.updated_at = ?
      )
    `,
    bindings: [
      event.id,
      event.fieldId,
      event.animalId,
      event.eventType,
      event.occurredAt,
      event.method,
      event.result,
      event.sireIdentifier,
      event.notes,
      JSON.stringify(event.metadata) ?? "{}",
      event.source,
      event.sourceRecordId,
      event.createdBy,
      event.createdAt,
      event.updatedAt,
    ],
  };
}

function activeLactationStateCondition(
  lactation: LactationRow | null,
  animalId: string,
  fieldId: string,
): SqlCondition {
  if (!lactation) {
    return {
      sql: `
        NOT EXISTS (
          SELECT 1 FROM livestock_lactations AS active_lactation
          WHERE active_lactation.animal_id = ? AND active_lactation.status = 'active'
        )
      `,
      bindings: [animalId],
    };
  }
  return combineSqlConditions(
    lactationRowCondition(lactation),
    {
      sql: `
        EXISTS (
          SELECT 1 FROM livestock_lactations AS active_lactation
          WHERE active_lactation.id = ?
            AND active_lactation.animal_id = ?
            AND active_lactation.field_id = ?
            AND active_lactation.status = 'active'
        )
      `,
      bindings: [lactation.id, animalId, fieldId],
    },
  );
}

function lactationRowCondition(lactation: LactationRow): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_lactations AS current_lactation
        WHERE current_lactation.id = ?
          AND current_lactation.field_id = ?
          AND current_lactation.animal_id = ?
          AND current_lactation.sequence_number = ?
          AND current_lactation.calving_date IS ?
          AND current_lactation.started_at = ?
          AND current_lactation.ended_at IS ?
          AND current_lactation.status = ?
          AND current_lactation.dry_off_reason IS ?
          AND current_lactation.source = ?
          AND current_lactation.source_record_id IS ?
          AND current_lactation.created_by = ?
          AND current_lactation.created_at = ?
          AND current_lactation.updated_at = ?
      )
    `,
    bindings: [
      lactation.id,
      lactation.fieldId,
      lactation.animalId,
      lactation.sequenceNumber,
      lactation.calvingDate,
      lactation.startedAt,
      lactation.endedAt,
      lactation.status,
      lactation.dryOffReason,
      lactation.source,
      lactation.sourceRecordId,
      lactation.createdBy,
      lactation.createdAt,
      lactation.updatedAt,
    ],
  };
}

function lactationSequenceCondition(animalId: string, expectedSequence: number): SqlCondition {
  return {
    sql: "? = COALESCE((SELECT MAX(sequence_number) FROM livestock_lactations WHERE animal_id = ?), 0)",
    bindings: [expectedSequence, animalId],
  };
}

function lactationAvailableCondition(id: string, animalId: string, sequenceNumber: number): SqlCondition {
  return {
    sql: `
      NOT EXISTS (
        SELECT 1 FROM livestock_lactations AS competing_lactation
        WHERE competing_lactation.id = ?
           OR (competing_lactation.animal_id = ? AND competing_lactation.sequence_number = ?)
      )
    `,
    bindings: [id, animalId, sequenceNumber],
  };
}

function birthAvailableCondition(id: string, animalId: string, occurredAt: string): SqlCondition {
  return {
    sql: `
      NOT EXISTS (
        SELECT 1 FROM livestock_births AS competing_birth
        WHERE competing_birth.id = ?
           OR (competing_birth.dam_animal_id = ? AND competing_birth.occurred_at = ?)
      )
    `,
    bindings: [id, animalId, occurredAt],
  };
}

function birthRowCondition(birth: BirthRow): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1 FROM livestock_births AS current_birth
        WHERE current_birth.id = ?
          AND current_birth.field_id = ?
          AND current_birth.dam_animal_id = ?
          AND current_birth.reproductive_event_id IS ?
          AND current_birth.occurred_at = ?
          AND current_birth.calving_type = ?
          AND current_birth.difficulty = ?
          AND current_birth.outcome = ?
          AND current_birth.sire_identifier IS ?
          AND current_birth.notes = ?
          AND current_birth.source = ?
          AND current_birth.source_record_id IS ?
          AND current_birth.created_by = ?
          AND current_birth.created_at = ?
          AND current_birth.updated_at = ?
      )
    `,
    bindings: [
      birth.id,
      birth.fieldId,
      birth.damAnimalId,
      birth.reproductiveEventId,
      birth.occurredAt,
      birth.calvingType,
      birth.difficulty,
      birth.outcome,
      birth.sireIdentifier,
      birth.notes,
      birth.source,
      birth.sourceRecordId,
      birth.createdBy,
      birth.createdAt,
      birth.updatedAt,
    ],
  };
}

function sameDateLactationStateCondition(
  lactation: LactationRow | null,
  animalId: string,
  fieldId: string,
  occurredAt: string,
): SqlCondition {
  if (!lactation) {
    return {
      sql: `
        NOT EXISTS (
          SELECT 1 FROM livestock_lactations AS same_date_lactation
          WHERE same_date_lactation.animal_id = ? AND same_date_lactation.calving_date = ?
        )
      `,
      bindings: [animalId, occurredAt],
    };
  }
  return combineSqlConditions(
    lactationRowCondition(lactation),
    {
      sql: `
        ? = (
          SELECT same_date_lactation.id
          FROM livestock_lactations AS same_date_lactation
          WHERE same_date_lactation.animal_id = ?
            AND same_date_lactation.field_id = ?
            AND same_date_lactation.calving_date = ?
          ORDER BY same_date_lactation.id
          LIMIT 1
        )
      `,
      bindings: [lactation.id, animalId, fieldId, occurredAt],
    },
  );
}

function noLaterLactationCondition(animalId: string, occurredAt: string): SqlCondition {
  return {
    sql: `
      NOT EXISTS (
        SELECT 1 FROM livestock_lactations AS later_lactation
        WHERE later_lactation.animal_id = ? AND later_lactation.started_at > ?
      )
    `,
    bindings: [animalId, occurredAt],
  };
}

function birthOffspringResolutionCondition(
  offspring: Array<{ identifier: string; animalId: string | null }>,
  fieldId: string,
): SqlCondition {
  const candidateSql = `
    SELECT candidate_animal.id AS animal_id
    FROM livestock_animals AS candidate_animal
    INNER JOIN livestock_lots AS candidate_lot ON candidate_lot.id = candidate_animal.lot_id
    WHERE candidate_lot.field_id = ? AND UPPER(TRIM(candidate_animal.tag)) = ?
    UNION
    SELECT candidate_identifier.animal_id
    FROM livestock_animal_identifiers AS candidate_identifier
    INNER JOIN livestock_animals AS identified_animal ON identified_animal.id = candidate_identifier.animal_id
    INNER JOIN livestock_lots AS identified_lot ON identified_lot.id = identified_animal.lot_id
    WHERE candidate_identifier.field_id = ?
      AND identified_lot.field_id = ?
      AND candidate_identifier.valid_to IS NULL
      AND candidate_identifier.normalized_value = ?
  `;
  const conditions = offspring.map((entry): SqlCondition => entry.animalId
    ? {
      sql: `
        ? = (
          SELECT CASE WHEN COUNT(DISTINCT animal_id) = 1 THEN MIN(animal_id) ELSE '' END
          FROM (${candidateSql}) AS offspring_candidates
        )
      `,
      bindings: [entry.animalId, fieldId, entry.identifier, fieldId, fieldId, entry.identifier],
    }
    : {
      sql: `
        0 = (
          SELECT COUNT(DISTINCT animal_id)
          FROM (${candidateSql}) AS offspring_candidates
        )
      `,
      bindings: [fieldId, entry.identifier, fieldId, fieldId, entry.identifier],
    });
  return conditions.length > 0 ? combineSqlConditions(...conditions) : { sql: "1 = 1", bindings: [] };
}

function birthOffspringAvailableCondition(offspring: BirthOffspringRow[]): SqlCondition {
  const ids = offspring.map((entry) => entry.id);
  const animalIds = offspring.flatMap((entry) => entry.animalId ? [entry.animalId] : []);
  return {
    sql: `
      NOT EXISTS (
        SELECT 1 FROM livestock_birth_offspring AS competing_offspring
        WHERE competing_offspring.id IN (SELECT value FROM json_each(?))
           OR (
             competing_offspring.animal_id IS NOT NULL
             AND competing_offspring.animal_id IN (SELECT value FROM json_each(?))
           )
      )
    `,
    bindings: [JSON.stringify(ids), JSON.stringify(animalIds)],
  };
}

function birthOffspringRowAvailableCondition(offspring: BirthOffspringRow): SqlCondition {
  return {
    sql: `
      NOT EXISTS (
        SELECT 1 FROM livestock_birth_offspring AS competing_offspring
        WHERE competing_offspring.id = ?
           OR (? IS NOT NULL AND competing_offspring.animal_id = ?)
      )
    `,
    bindings: [offspring.id, offspring.animalId, offspring.animalId],
  };
}

function auditRowCondition(id: string, action: string, entityId: string): SqlCondition {
  return {
    sql: `
      EXISTS (
        SELECT 1 FROM audit_log AS guard_audit
        WHERE guard_audit.id = ? AND guard_audit.action = ? AND guard_audit.entity_id = ?
      )
    `,
    bindings: [id, action, entityId],
  };
}

function prepareConditionalAnimalRecordAudit(
  client: D1Database,
  row: {
    id?: string;
    organizationId: string;
    fieldId: string;
    actor: string;
    action: string;
    entityType: string;
    entityId: string;
    before: object | null;
    after: object | null;
    occurredAt: string;
  },
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
    WHERE ${condition.sql}
  `).bind(
    row.id ?? crypto.randomUUID(),
    row.organizationId,
    row.fieldId,
    row.actor,
    row.action,
    row.entityType,
    row.entityId,
    row.before ? JSON.stringify(row.before) ?? null : null,
    row.after ? JSON.stringify(row.after) ?? null : null,
    row.occurredAt,
    ...condition.bindings,
  );
}

function prepareBirthInsert(
  client: D1Database,
  birth: BirthRow,
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    INSERT INTO livestock_births (
      id, field_id, dam_animal_id, reproductive_event_id, occurred_at,
      calving_type, difficulty, outcome, sire_identifier, notes, source,
      source_record_id, created_by, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${condition.sql}
  `).bind(
    birth.id,
    birth.fieldId,
    birth.damAnimalId,
    birth.reproductiveEventId,
    birth.occurredAt,
    birth.calvingType,
    birth.difficulty,
    birth.outcome,
    birth.sireIdentifier,
    birth.notes,
    birth.source,
    birth.sourceRecordId,
    birth.createdBy,
    birth.createdAt,
    birth.updatedAt,
    ...condition.bindings,
  );
}

function prepareBirthOffspringInsert(
  client: D1Database,
  offspring: BirthOffspringRow,
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    INSERT INTO livestock_birth_offspring (
      id, birth_id, animal_id, temporary_identifier, sex, outcome,
      birth_weight_kg, notes, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${condition.sql}
  `).bind(
    offspring.id,
    offspring.birthId,
    offspring.animalId,
    offspring.temporaryIdentifier,
    offspring.sex,
    offspring.outcome,
    offspring.birthWeightKg,
    offspring.notes,
    offspring.createdAt,
    offspring.updatedAt,
    ...condition.bindings,
  );
}

function prepareReproductiveEventInsert(
  client: D1Database,
  event: ReproductiveEventRow,
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    INSERT INTO livestock_reproductive_events (
      id, field_id, animal_id, event_type, occurred_at, method, result,
      sire_identifier, notes, metadata, source, source_record_id,
      created_by, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${condition.sql}
  `).bind(
    event.id,
    event.fieldId,
    event.animalId,
    event.eventType,
    event.occurredAt,
    event.method,
    event.result,
    event.sireIdentifier,
    event.notes,
    JSON.stringify(event.metadata) ?? "{}",
    event.source,
    event.sourceRecordId,
    event.createdBy,
    event.createdAt,
    event.updatedAt,
    ...condition.bindings,
  );
}

function prepareReproductiveEventUpdate(
  client: D1Database,
  event: ReproductiveEventRow,
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    UPDATE livestock_reproductive_events
    SET method = ?, result = ?, sire_identifier = ?, notes = ?, created_by = ?, updated_at = ?
    WHERE id = ? AND ${condition.sql}
  `).bind(
    event.method,
    event.result,
    event.sireIdentifier,
    event.notes,
    event.createdBy,
    event.updatedAt,
    event.id,
    ...condition.bindings,
  );
}

function prepareLactationInsert(
  client: D1Database,
  lactation: LactationRow,
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    INSERT INTO livestock_lactations (
      id, field_id, animal_id, sequence_number, calving_date, started_at,
      ended_at, status, dry_off_reason, source, source_record_id,
      created_by, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${condition.sql}
  `).bind(
    lactation.id,
    lactation.fieldId,
    lactation.animalId,
    lactation.sequenceNumber,
    lactation.calvingDate,
    lactation.startedAt,
    lactation.endedAt,
    lactation.status,
    lactation.dryOffReason,
    lactation.source,
    lactation.sourceRecordId,
    lactation.createdBy,
    lactation.createdAt,
    lactation.updatedAt,
    ...condition.bindings,
  );
}

function prepareLactationUpdate(
  client: D1Database,
  lactation: LactationRow,
  condition: SqlCondition,
): D1PreparedStatement {
  return client.prepare(`
    UPDATE livestock_lactations
    SET status = ?, ended_at = ?, dry_off_reason = ?, updated_at = ?
    WHERE id = ? AND ${condition.sql}
  `).bind(
    lactation.status,
    lactation.endedAt,
    lactation.dryOffReason,
    lactation.updatedAt,
    lactation.id,
    ...condition.bindings,
  );
}

async function executeReproductiveBatch(
  client: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  const results = await client.batch(statements);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new DomainRuleError(
      "El animal, el evento o la lactancia cambiaron mientras se guardaba el evento reproductivo.",
      "FIELD_SCOPE_CONFLICT",
    );
  }
}

async function executeBirthBatch(
  client: D1Database,
  statements: D1PreparedStatement[],
): Promise<void> {
  const results = await client.batch(statements);
  if (results.some((result) => result.meta.changes !== 1)) {
    throw new DomainRuleError(
      "La madre, la lactancia o la genealogía cambiaron mientras se guardaba el parto.",
      "FIELD_SCOPE_CONFLICT",
    );
  }
}

function milkControlWriteCondition(
  values: MilkControlRow,
  existing: MilkControlRow | null,
  accessScope: OrganizationFieldScope,
): SqlCondition {
  const animalScope = femaleAnimalWriteScopeCondition(values.animalId, values.fieldId, accessScope);
  const lactationSelection: SqlCondition = {
    sql: `
      ? IS (
        SELECT eligible_lactation.id
        FROM livestock_lactations AS eligible_lactation
        WHERE eligible_lactation.animal_id = ?
          AND eligible_lactation.field_id = ?
          AND eligible_lactation.started_at <= ?
          AND (eligible_lactation.ended_at IS NULL OR eligible_lactation.ended_at >= ?)
        ORDER BY eligible_lactation.started_at DESC, eligible_lactation.id DESC
        LIMIT 1
      )
    `,
    bindings: [values.lactationId, values.animalId, values.fieldId, values.controlDate, values.controlDate],
  };
  const controlCondition: SqlCondition = existing
    ? {
      sql: `
        EXISTS (
          SELECT 1
          FROM livestock_milk_controls AS current_control
          WHERE current_control.id = ?
            AND current_control.field_id = ?
            AND current_control.animal_id = ?
            AND current_control.lactation_id IS ?
            AND current_control.control_date = ?
            AND current_control.morning_liters IS ?
            AND current_control.afternoon_liters IS ?
            AND current_control.third_milking_liters IS ?
            AND current_control.total_liters = ?
            AND current_control.fat_pct IS ?
            AND current_control.protein_pct IS ?
            AND current_control.somatic_cell_count IS ?
            AND current_control.notes = ?
            AND current_control.source = ?
            AND current_control.source_record_id IS ?
            AND current_control.created_by = ?
            AND current_control.created_at = ?
            AND current_control.updated_at = ?
        )
      `,
      bindings: [
        existing.id,
        existing.fieldId,
        existing.animalId,
        existing.lactationId,
        existing.controlDate,
        existing.morningLiters,
        existing.afternoonLiters,
        existing.thirdMilkingLiters,
        existing.totalLiters,
        existing.fatPct,
        existing.proteinPct,
        existing.somaticCellCount,
        existing.notes,
        existing.source,
        existing.sourceRecordId,
        existing.createdBy,
        existing.createdAt,
        existing.updatedAt,
      ],
    }
    : {
      sql: `
        NOT EXISTS (
          SELECT 1
          FROM livestock_milk_controls AS competing_control
          WHERE competing_control.id = ?
             OR (competing_control.animal_id = ? AND competing_control.control_date = ?)
        )
      `,
      bindings: [values.id, values.animalId, values.controlDate],
    };
  return {
    sql: `
      (${animalScope.sql})
      AND (${lactationSelection.sql})
      AND (${controlCondition.sql})
    `,
    bindings: [
      ...animalScope.bindings,
      ...lactationSelection.bindings,
      ...controlCondition.bindings,
    ],
  };
}

async function resolveKnownAnimalIds(identifiers: string[], fieldId: string): Promise<Map<string, string>> {
  const values = new Set(identifiers.map(animalIdentifierKey).filter(Boolean));
  const result = new Map<string, string>();
  if (values.size === 0) return result;
  const db = getDb();
  const [animals, externalIdentifiers] = await Promise.all([
    db.select({ id: livestockAnimals.id, value: livestockAnimals.tag })
      .from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .where(eq(livestockLots.fieldId, fieldId)),
    db.select({ id: livestockAnimalIdentifiers.animalId, value: livestockAnimalIdentifiers.value })
      .from(livestockAnimalIdentifiers)
      .where(and(eq(livestockAnimalIdentifiers.fieldId, fieldId), isNull(livestockAnimalIdentifiers.validTo))),
  ]);
  const candidates = new Map<string, Set<string>>();
  for (const entry of [...animals, ...externalIdentifiers]) {
    const key = animalIdentifierKey(entry.value);
    if (!values.has(key)) continue;
    const matches = candidates.get(key) ?? new Set<string>();
    matches.add(entry.id);
    candidates.set(key, matches);
  }
  for (const [key, matches] of candidates) {
    if (matches.size > 1) throw new Error(`El identificador ${key} coincide con más de un animal del fundo.`);
    result.set(key, [...matches][0]);
  }
  return result;
}

function animalIdentifierKey(value: string): string {
  return value.trim().normalize("NFKC").toLocaleUpperCase("es");
}

async function buildParentage(offspringRows: Array<typeof livestockBirthOffspring.$inferSelect>): Promise<AnimalParentageLink[]> {
  if (offspringRows.length === 0) return [];
  const db = getDb();
  const birthIds = [...new Set(offspringRows.map((entry) => entry.birthId))];
  const births = await db.select().from(livestockBirths).where(inArray(livestockBirths.id, birthIds));
  if (births.length === 0) return [];
  const parentIds = [...new Set(births.flatMap((entry) => [entry.damAnimalId, entry.sireAnimalId]).filter((value): value is string => Boolean(value)))];
  const parents = await db.select({ id: livestockAnimals.id, tag: livestockAnimals.tag }).from(livestockAnimals).where(inArray(livestockAnimals.id, parentIds));
  const parentTagById = new Map(parents.map((entry) => [entry.id, entry.tag]));
  return births.map((birth) => ({
    birthId: birth.id,
    occurredAt: birth.occurredAt,
    damAnimalId: birth.damAnimalId,
    damTag: parentTagById.get(birth.damAnimalId) ?? birth.damAnimalId,
    sireIdentifier: birth.sireIdentifier,
    sireAnimalId: birth.sireAnimalId,
    sireTag: birth.sireAnimalId ? parentTagById.get(birth.sireAnimalId) ?? birth.sireIdentifier : birth.sireIdentifier,
  }));
}

function toAnimal(row: AnimalRow, weighing?: WeighingRow): LivestockAnimal {
  return {
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
  };
}

function toWeighing(row: WeighingRow): LivestockWeighing {
  return {
    id: row.id,
    lotId: row.lotId,
    animalId: row.animalId,
    recordedAt: row.recordedAt,
    weightKg: row.weightKg,
    notes: row.notes,
    source: row.source,
    createdAt: row.createdAt,
  };
}

function toLactation(row: typeof livestockLactations.$inferSelect): LivestockLactation {
  return row;
}

function toMilkControl(row: typeof livestockMilkControls.$inferSelect): LivestockMilkControl {
  return row;
}

function toReproductiveEvent(row: typeof livestockReproductiveEvents.$inferSelect): LivestockReproductiveEvent {
  return row;
}

function toBirth(row: typeof livestockBirths.$inferSelect, offspring: LivestockBirthOffspring[]): LivestockBirth {
  return { ...row, offspring };
}

function toBirthOffspring(row: typeof livestockBirthOffspring.$inferSelect): LivestockBirthOffspring {
  return row;
}

function toHealthEvent(row: typeof livestockHealthEvents.$inferSelect): LivestockHealthEvent {
  return row;
}

function buildTimeline(input: {
  births: LivestockBirth[];
  healthEvents: LivestockHealthEvent[];
  lactations: LivestockLactation[];
  milkControls: LivestockMilkControl[];
  parentage: AnimalParentageLink[];
  reproductiveEvents: LivestockReproductiveEvent[];
  weighings: LivestockWeighing[];
}): AnimalTimelineItem[] {
  const items: AnimalTimelineItem[] = [];
  const birthEventIds = new Set(input.births.map((entry) => entry.reproductiveEventId).filter(Boolean));
  for (const entry of input.milkControls) {
    const quality = [entry.fatPct !== null ? `${entry.fatPct.toLocaleString("es-CL")}% grasa` : null, entry.proteinPct !== null ? `${entry.proteinPct.toLocaleString("es-CL")}% proteína` : null].filter(Boolean).join(" · ");
    items.push({ id: entry.id, occurredAt: entry.controlDate, kind: "milk_control", title: "Control lechero", summary: `${entry.totalLiters.toLocaleString("es-CL")} L${quality ? ` · ${quality}` : ""}`, tone: "blue" });
  }
  for (const entry of input.reproductiveEvents) {
    if (birthEventIds.has(entry.id)) continue;
    const detail = [entry.result, entry.method, entry.sireIdentifier ? `Toro ${entry.sireIdentifier}` : null].filter(Boolean).join(" · ") || entry.notes || "Evento registrado";
    items.push({ id: entry.id, occurredAt: entry.occurredAt, kind: "reproductive_event", title: LIVESTOCK_REPRODUCTIVE_EVENT_LABELS[entry.eventType], summary: detail, tone: entry.eventType === "abortion" ? "red" : entry.eventType === "pregnancy_diagnosis" || entry.eventType === "calving" ? "green" : "amber" });
  }
  for (const entry of input.births) {
    const linked = entry.offspring.filter((offspring) => offspring.animalId !== null).length;
    const weights = entry.offspring.filter((offspring) => offspring.birthWeightKg !== null).map((offspring) => `${offspring.temporaryIdentifier}: ${offspring.birthWeightKg} kg`);
    const detail = [`${entry.offspring.length} cría${entry.offspring.length === 1 ? "" : "s"}`, LIVESTOCK_CALVING_DIFFICULTY_LABELS[entry.difficulty], linked > 0 ? `${linked} vinculada${linked === 1 ? "" : "s"}` : "genealogía pendiente", ...weights].join(" · ");
    items.push({ id: entry.id, occurredAt: entry.occurredAt, kind: "birth", title: "Parto y crías", summary: detail, tone: entry.outcome === "stillbirth" ? "red" : entry.difficulty === "dystocia" ? "amber" : "green" });
  }
  for (const entry of input.parentage) {
    items.push({ id: `${entry.birthId}:parentage`, occurredAt: entry.occurredAt, kind: "birth", title: "Nacimiento y genealogía", summary: [`Madre ${entry.damTag}`, entry.sireIdentifier ? `Padre ${entry.sireIdentifier}` : "Padre pendiente"].join(" · "), tone: "green" });
  }
  for (const entry of input.healthEvents) {
    const detail = [entry.condition, entry.productName, entry.doseAmount !== null ? `${entry.doseAmount} ${entry.doseUnit}` : null, entry.status === "open" ? "Seguimiento abierto" : null].filter(Boolean).join(" · ") || entry.notes || "Evento sanitario registrado";
    items.push({ id: entry.id, occurredAt: entry.occurredAt, kind: "health_event", title: LIVESTOCK_HEALTH_EVENT_LABELS[entry.eventType], summary: detail, tone: entry.status === "open" ? "amber" : entry.eventType === "diagnosis" ? "red" : "blue" });
  }
  for (const entry of input.weighings) {
    items.push({ id: entry.id, occurredAt: entry.recordedAt, kind: "weighing", title: "Pesaje", summary: `${entry.weightKg.toLocaleString("es-CL")} kg${entry.notes ? ` · ${entry.notes}` : ""}`, tone: "neutral" });
  }
  for (const entry of input.lactations) {
    items.push({ id: `${entry.id}:start`, occurredAt: entry.startedAt, kind: "lactation", title: `Inicio lactancia ${entry.sequenceNumber}`, summary: entry.calvingDate ? "Generada desde parto registrado" : entry.source, tone: "green" });
  }
  return items.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt));
}
