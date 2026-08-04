import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { SyncMutationInput } from "@/src/modules/sync/domain/types";
import {
  SyncWriteAccessRevokedError,
  syncWriteAccessCondition,
} from "@/src/modules/sync/server/sync-write-access";
import {
  AnimalRecordRuleError,
  normalizeHealthEventInput,
  normalizeReproductiveEventInput,
} from "@/src/modules/ganado/ficha/server/animal-record-rules.mjs";
import { listLivestockWeighings, recordWeighingSession } from "@/src/modules/ganado/server/livestock-weighing-repository";

export type OfflineProjectionResult = { action: "applied" } | { action: "conflict"; reason: string };

export async function applyOfflineFieldCapture(
  actor: AccessContext,
  mutation: SyncMutationInput,
): Promise<OfflineProjectionResult> {
  if (mutation.entity === "livestock_weighing") return applyWeighing(actor, mutation);
  if (mutation.entity === "livestock_health") return applyHealth(actor, mutation);
  if (mutation.entity === "livestock_estrus") return applyEstrus(actor, mutation);
  if (mutation.entity === "livestock_movement") return validateMovement(actor, mutation);
  return { action: "applied" };
}

async function applyWeighing(actor: AccessContext, mutation: SyncMutationInput): Promise<OfflineProjectionResult> {
  const payload = mutation.payload as unknown as {
    lotId: string;
    recordedAt: string;
    notes?: string;
    entries: { animalId: string; weightKg: number }[];
  };
  const lotScope = await getDb().$client.prepare(`
    SELECT lot.field_id AS fieldId
    FROM livestock_lots AS lot
    INNER JOIN fields AS field ON field.id = lot.field_id
    WHERE lot.id = ? AND field.organization_id = ? AND lot.field_id = ?
    LIMIT 1
  `).bind(payload.lotId, actor.organizationId, mutation.fieldId).first<{ fieldId: string }>();
  if (!lotScope || !actor.fieldIds.includes(lotScope.fieldId)) return scopedConflict();

  const requested = payload.entries.map((entry) => ({ animalId: entry.animalId, weightKg: Number(entry.weightKg), snapshotToken: null }));
  const current = (await listLivestockWeighings({ organizationId: actor.organizationId, fieldIds: [mutation.fieldId] }))
    .filter((entry) => entry.recordedAt === payload.recordedAt && requested.some((candidate) => candidate.animalId === entry.animalId));
  if (current.length > 0) {
    const exact = current.length === requested.length && requested.every((entry) => current.some((stored) => (
      stored.animalId === entry.animalId && stored.weightKg === entry.weightKg && stored.lotId === payload.lotId
    )));
    return exact ? { action: "applied" } : { action: "conflict", reason: "Ya existe un pesaje distinto para uno de los animales y la fecha." };
  }
  try {
    await recordWeighingSession(payload.lotId, payload.recordedAt, requested, boundedText(payload.notes, 1_000), {
      organizationId: actor.organizationId,
      fieldIds: [mutation.fieldId],
    }, actor);
    return { action: "applied" };
  } catch (cause) {
    if (cause instanceof DomainRuleError) return { action: "conflict", reason: cause.message };
    throw cause;
  }
}

async function applyHealth(actor: AccessContext, mutation: SyncMutationInput): Promise<OfflineProjectionResult> {
  try {
    const input = normalizeHealthEventInput(mutation.payload);
    const scope = await loadAnimalScope(actor, mutation.fieldId, input.animalId, false);
    if (!scope) return scopedConflict();
    const id = `health-offline:${mutation.id}`;
    const existing = await getDb().$client.prepare(`
      SELECT field_id AS fieldId, animal_id AS animalId, event_type AS eventType, occurred_at AS occurredAt,
             status, condition, product_name AS productName, active_ingredient AS activeIngredient,
             dose_amount AS doseAmount, dose_unit AS doseUnit, route,
             withdrawal_milk_until AS withdrawalMilkUntil, withdrawal_meat_until AS withdrawalMeatUntil,
             professional, notes
      FROM livestock_health_events WHERE id = ? LIMIT 1
    `).bind(id).first<Record<string, unknown>>();
    if (existing) return exactHealth(existing, mutation.fieldId, input) ? { action: "applied" } : collisionConflict();
    const now = new Date().toISOString();
    const access = syncWriteAccessCondition(actor, mutation.fieldId);
    const guard = `
      EXISTS (
        SELECT 1 FROM livestock_animals AS animal
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS field ON field.id = lot.field_id
        WHERE animal.id = ? AND lot.field_id = ? AND field.organization_id = ?
      )
    `;
    const client = getDb().$client;
    const results = await client.batch([
      client.prepare(`
        INSERT INTO livestock_health_events (
          id, field_id, animal_id, event_type, occurred_at, status, condition, product_name,
          active_ingredient, dose_amount, dose_unit, route, withdrawal_milk_until,
          withdrawal_meat_until, professional, notes, metadata, source, source_record_id,
          created_by, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Captura offline', ?, ?, ?, ?
        WHERE ${guard} AND ${access.sql}
        ON CONFLICT(id) DO NOTHING
      `).bind(
        id, mutation.fieldId, input.animalId, input.eventType, input.occurredAt, input.status,
        input.condition, input.productName, input.activeIngredient, input.doseAmount, input.doseUnit,
        input.route, input.withdrawalMilkUntil, input.withdrawalMeatUntil, input.professional,
        input.notes, JSON.stringify({ sourceMutationId: mutation.id }), null, actor.email, now, now,
        input.animalId, mutation.fieldId, actor.organizationId,
        ...access.bindings,
      ),
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          before, after, source_record_id, occurred_at
        )
        SELECT ?, ?, ?, ?, 'health_event.offline_created', 'livestock_health_event', ?, NULL, ?, ?, ?
        WHERE changes() = 1
          AND EXISTS (SELECT 1 FROM livestock_health_events WHERE id = ? AND field_id = ? AND animal_id = ?)
          AND ${access.sql}
        ON CONFLICT(id) DO NOTHING
      `).bind(
        `audit:${id}`, actor.organizationId, mutation.fieldId, actor.email, id,
        JSON.stringify(input), null, now, id, mutation.fieldId, input.animalId,
        ...access.bindings,
      ),
      client.prepare(`
        SELECT CASE
          WHEN NOT (${access.sql}) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM livestock_health_events
            WHERE id = ? AND field_id = ? AND animal_id = ?
          ) AND EXISTS (
            SELECT 1 FROM audit_log
            WHERE id = ? AND organization_id = ? AND field_id = ? AND entity_id = ?
          ) THEN 1
          ELSE abs(-9223372036854775807 - 1)
        END AS complete
      `).bind(
        ...access.bindings,
        id,
        mutation.fieldId,
        input.animalId,
        `audit:${id}`,
        actor.organizationId,
        mutation.fieldId,
        id,
      ),
    ]);
    const completion = results[2]?.results[0] as { complete?: number } | undefined;
    if (Number(completion?.complete) !== 1) throw new SyncWriteAccessRevokedError();
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1
      ? { action: "applied" }
      : collisionConflict();
  } catch (cause) {
    if (cause instanceof Error && /integer overflow/iu.test(cause.message)) return collisionConflict();
    if (cause instanceof AnimalRecordRuleError || cause instanceof DomainRuleError) {
      return { action: "conflict", reason: cause.message };
    }
    throw cause;
  }
}

async function applyEstrus(actor: AccessContext, mutation: SyncMutationInput): Promise<OfflineProjectionResult> {
  try {
    const input = normalizeReproductiveEventInput({ ...mutation.payload, eventType: "heat" });
    const scope = await loadAnimalScope(actor, mutation.fieldId, input.animalId, true);
    if (!scope) return scopedConflict();
    const id = `repro-offline:${mutation.id}`;
    const existing = await getDb().$client.prepare(`
      SELECT field_id AS fieldId, animal_id AS animalId, event_type AS eventType, occurred_at AS occurredAt,
             method, result, sire_identifier AS sireIdentifier, notes
      FROM livestock_reproductive_events WHERE id = ? LIMIT 1
    `).bind(id).first<Record<string, unknown>>();
    if (existing) return exactEstrus(existing, mutation.fieldId, input) ? { action: "applied" } : collisionConflict();
    const now = new Date().toISOString();
    const access = syncWriteAccessCondition(actor, mutation.fieldId);
    const client = getDb().$client;
    const results = await client.batch([
      client.prepare(`
        INSERT INTO livestock_reproductive_events (
          id, field_id, animal_id, event_type, occurred_at, method, result, sire_identifier,
          sire_animal_id, notes, metadata, source, source_record_id, created_by, created_at, updated_at
        )
        SELECT ?, ?, ?, 'heat', ?, ?, ?, ?, NULL, ?, ?, 'Captura offline', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM livestock_animals AS animal
          INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
          INNER JOIN fields AS field ON field.id = lot.field_id
          WHERE animal.id = ? AND animal.sex = 'female' AND lot.field_id = ? AND field.organization_id = ?
        ) AND ${access.sql}
        ON CONFLICT(id) DO NOTHING
      `).bind(
        id, mutation.fieldId, input.animalId, input.occurredAt, input.method, input.result,
        input.sireIdentifier, input.notes, JSON.stringify({ sourceMutationId: mutation.id }),
        null, actor.email, now, now, input.animalId, mutation.fieldId, actor.organizationId,
        ...access.bindings,
      ),
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          before, after, source_record_id, occurred_at
        )
        SELECT ?, ?, ?, ?, 'reproductive_event.offline_created', 'livestock_reproductive_event', ?, NULL, ?, ?, ?
        WHERE changes() = 1
          AND EXISTS (SELECT 1 FROM livestock_reproductive_events WHERE id = ? AND field_id = ? AND animal_id = ?)
          AND ${access.sql}
        ON CONFLICT(id) DO NOTHING
      `).bind(
        `audit:${id}`, actor.organizationId, mutation.fieldId, actor.email, id,
        JSON.stringify(input), null, now, id, mutation.fieldId, input.animalId,
        ...access.bindings,
      ),
      client.prepare(`
        SELECT CASE
          WHEN NOT (${access.sql}) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM livestock_reproductive_events
            WHERE id = ? AND field_id = ? AND animal_id = ?
          ) AND EXISTS (
            SELECT 1 FROM audit_log
            WHERE id = ? AND organization_id = ? AND field_id = ? AND entity_id = ?
          ) THEN 1
          ELSE abs(-9223372036854775807 - 1)
        END AS complete
      `).bind(
        ...access.bindings,
        id,
        mutation.fieldId,
        input.animalId,
        `audit:${id}`,
        actor.organizationId,
        mutation.fieldId,
        id,
      ),
    ]);
    const completion = results[2]?.results[0] as { complete?: number } | undefined;
    if (Number(completion?.complete) !== 1) throw new SyncWriteAccessRevokedError();
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1
      ? { action: "applied" }
      : collisionConflict();
  } catch (cause) {
    if (cause instanceof Error && /integer overflow/iu.test(cause.message)) return collisionConflict();
    if (cause instanceof AnimalRecordRuleError || cause instanceof DomainRuleError) {
      return { action: "conflict", reason: cause.message };
    }
    throw cause;
  }
}

async function validateMovement(actor: AccessContext, mutation: SyncMutationInput): Promise<OfflineProjectionResult> {
  const payload = mutation.payload as unknown as { animalIds: string[]; destinationRup: string; occurredAt: string };
  const animalIds = [...new Set(payload.animalIds.map((value) => String(value).trim()))];
  if (animalIds.length !== payload.animalIds.length || !/^[0-9A-Z.-]{4,32}$/u.test(payload.destinationRup.trim().toUpperCase())) {
    return { action: "conflict", reason: "El movimiento contiene animales repetidos o un RUP de destino inválido." };
  }
  const placeholders = animalIds.map(() => "?").join(",");
  const result = await getDb().$client.prepare(`
    SELECT COUNT(*) AS count
    FROM livestock_animals AS animal
    INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
    INNER JOIN fields AS field ON field.id = lot.field_id
    WHERE animal.id IN (${placeholders}) AND animal.status = 'active'
      AND lot.field_id = ? AND field.organization_id = ?
  `).bind(...animalIds, mutation.fieldId, actor.organizationId).first<{ count: number }>();
  return Number(result?.count) === animalIds.length ? { action: "applied" } : scopedConflict();
}

async function loadAnimalScope(actor: AccessContext, fieldId: string, animalId: string, femaleOnly: boolean) {
  if (!actor.fieldIds.includes(fieldId)) return null;
  return getDb().$client.prepare(`
    SELECT lot.field_id AS fieldId
    FROM livestock_animals AS animal
    INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
    INNER JOIN fields AS field ON field.id = lot.field_id
    WHERE animal.id = ? AND lot.field_id = ? AND field.organization_id = ?
      ${femaleOnly ? "AND animal.sex = 'female'" : ""}
    LIMIT 1
  `).bind(animalId, fieldId, actor.organizationId).first<{ fieldId: string }>();
}

function exactHealth(existing: Record<string, unknown>, fieldId: string, input: ReturnType<typeof normalizeHealthEventInput>): boolean {
  return existing.fieldId === fieldId
    && existing.animalId === input.animalId
    && existing.eventType === input.eventType
    && existing.occurredAt === input.occurredAt
    && existing.status === input.status
    && existing.condition === input.condition
    && existing.productName === input.productName
    && existing.activeIngredient === input.activeIngredient
    && existing.doseAmount === input.doseAmount
    && existing.doseUnit === input.doseUnit
    && existing.route === input.route
    && existing.withdrawalMilkUntil === input.withdrawalMilkUntil
    && existing.withdrawalMeatUntil === input.withdrawalMeatUntil
    && existing.professional === input.professional
    && existing.notes === input.notes;
}

function exactEstrus(existing: Record<string, unknown>, fieldId: string, input: ReturnType<typeof normalizeReproductiveEventInput>): boolean {
  return existing.fieldId === fieldId
    && existing.animalId === input.animalId
    && existing.eventType === "heat"
    && existing.occurredAt === input.occurredAt
    && existing.method === input.method
    && existing.result === input.result
    && existing.sireIdentifier === input.sireIdentifier
    && existing.notes === input.notes;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function scopedConflict(): OfflineProjectionResult {
  return { action: "conflict", reason: "El recurso cambió o no pertenece al fundo autorizado para esta captura." };
}

function collisionConflict(): OfflineProjectionResult {
  return { action: "conflict", reason: "El identificador de la captura ya pertenece a otro registro." };
}
