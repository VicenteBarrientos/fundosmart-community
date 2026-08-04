import { getDb } from "@/db";
import { fields, livestockAnimals, livestockLots, livestockWeighings } from "@/db/schema";
import type { LivestockWeighing } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import {
  SyncWriteAccessRevokedError,
  syncWriteAccessCondition,
} from "@/src/modules/sync/server/sync-write-access";
import { and, desc, eq, inArray } from "drizzle-orm";
import { prepareIndividualLotSummaryUpdate } from "./livestock-repository";

type WeighingRow = typeof livestockWeighings.$inferSelect;

export type LivestockWeighingEntry = {
  animalId: string;
  weightKg: number;
  snapshotToken: string | null;
};

async function weighingSnapshotToken(row: WeighingRow): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify({
    id: row.id,
    lotId: row.lotId,
    animalId: row.animalId,
    recordedAt: row.recordedAt,
    weightKg: row.weightKg,
    notes: row.notes,
    source: row.source,
    createdAt: row.createdAt,
  }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `livestock-weighing:v1:${hex}`;
}

async function toWeighing(row: WeighingRow): Promise<LivestockWeighing> {
  return {
    id: row.id,
    lotId: row.lotId,
    animalId: row.animalId,
    recordedAt: row.recordedAt,
    weightKg: row.weightKg,
    notes: row.notes,
    source: row.source,
    createdAt: row.createdAt,
    snapshotToken: await weighingSnapshotToken(row),
  };
}

export async function listLivestockWeighings(scope: OrganizationFieldScope): Promise<LivestockWeighing[]> {
  if (scope.fieldIds.length === 0) return [];
  const rows = await getDb()
    .select({ weighing: livestockWeighings })
    .from(livestockWeighings)
    .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockWeighings.animalId))
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(eq(fields.organizationId, scope.organizationId), inArray(fields.id, scope.fieldIds)))
    .orderBy(desc(livestockWeighings.recordedAt), desc(livestockWeighings.createdAt));
  return Promise.all(rows.map(({ weighing }) => toWeighing(weighing)));
}

export async function recordWeighingSession(
  lotId: string,
  recordedAt: string,
  entries: LivestockWeighingEntry[],
  notes: string,
  scope: OrganizationFieldScope,
  syncActor?: AccessContext,
): Promise<LivestockWeighing[]> {
  const db = getDb();
  if (entries.length === 0 || new Set(entries.map((entry) => entry.animalId)).size !== entries.length) {
    throw new DomainRuleError("La sesión de pesaje no contiene animales únicos.");
  }

  const [lot] = await db
    .select({ id: livestockLots.id })
    .from(livestockLots)
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockLots.id, lotId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!lot) throw new DomainRuleError("El lote seleccionado no existe.");

  const animalIds = entries.map((entry) => entry.animalId);
  const animals = animalIds.length
    ? await db
        .select({ id: livestockAnimals.id, lotId: livestockAnimals.lotId })
        .from(livestockAnimals)
        .where(inArray(livestockAnimals.id, animalIds))
    : [];
  const known = new Map(animals.map((animal) => [animal.id, animal.lotId]));
  for (const entry of entries) {
    if (known.get(entry.animalId) !== lotId) {
      throw new DomainRuleError("Uno de los animales pesados no pertenece al lote seleccionado.");
    }
  }

  const currentWeighings = await db
    .select()
    .from(livestockWeighings)
    .where(and(
      eq(livestockWeighings.recordedAt, recordedAt),
      inArray(livestockWeighings.animalId, animalIds),
    ));
  const currentByAnimal = new Map(currentWeighings.map((weighing) => [weighing.animalId, weighing]));
  for (const entry of entries) {
    const current = currentByAnimal.get(entry.animalId);
    const currentSnapshotToken = current ? await weighingSnapshotToken(current) : null;
    if (entry.snapshotToken !== currentSnapshotToken) {
      throwFieldScopeConflict("Los pesajes cambiaron desde la última carga.");
    }
  }
  const createdAt = new Date().toISOString();
  const requested = JSON.stringify(entries.map((entry) => {
    const current = currentByAnimal.get(entry.animalId);
    return {
      id: `weight-${entry.animalId}-${recordedAt}`,
      animalId: entry.animalId,
      recordedAt,
      weightKg: entry.weightKg,
      current: current ? {
        id: current.id,
        lotId: current.lotId,
        weightKg: current.weightKg,
        notes: current.notes,
        source: current.source,
        createdAt: current.createdAt,
      } : null,
    };
  }));
  const client = db.$client;
  const syncAccess = syncActor ? syncWriteAccessCondition(syncActor, scope.fieldIds[0] ?? "") : null;
  const results = await client.batch([
    client.prepare(`
      INSERT INTO livestock_weighings (
        id, lot_id, animal_id, recorded_at, weight_kg, notes, source, created_at
      )
      WITH requested AS (
        SELECT
          CAST(json_extract(value, '$.id') AS TEXT) AS id,
          CAST(json_extract(value, '$.animalId') AS TEXT) AS animal_id,
          CAST(json_extract(value, '$.recordedAt') AS TEXT) AS recorded_at,
          CAST(json_extract(value, '$.weightKg') AS REAL) AS weight_kg,
          CASE WHEN json_type(value, '$.current') = 'object' THEN 1 ELSE 0 END AS had_current,
          CAST(json_extract(value, '$.current.id') AS TEXT) AS current_id,
          CAST(json_extract(value, '$.current.lotId') AS TEXT) AS current_lot_id,
          CAST(json_extract(value, '$.current.weightKg') AS REAL) AS current_weight_kg,
          CAST(json_extract(value, '$.current.notes') AS TEXT) AS current_notes,
          CAST(json_extract(value, '$.current.source') AS TEXT) AS current_source,
          CAST(json_extract(value, '$.current.createdAt') AS TEXT) AS current_created_at
        FROM json_each(?)
      ),
      authorized AS (
        SELECT requested.*
        FROM requested
        INNER JOIN livestock_animals AS animal ON animal.id = requested.animal_id
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields ON fields.id = lot.field_id
        WHERE lot.id = ?
          AND fields.organization_id = ?
          AND fields.id IN (SELECT value FROM json_each(?))
          AND ${syncAccess?.sql ?? "1 = 1"}
      ),
      eligible AS (
        SELECT authorized.*
        FROM authorized
        WHERE (
          authorized.had_current = 0
          AND NOT EXISTS (
            SELECT 1 FROM livestock_weighings AS date_weighing
            WHERE date_weighing.animal_id = authorized.animal_id
              AND date_weighing.recorded_at = authorized.recorded_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM livestock_weighings AS id_weighing
            WHERE id_weighing.id = authorized.id
          )
        ) OR (
          authorized.had_current = 1
          AND EXISTS (
            SELECT 1 FROM livestock_weighings AS current_weighing
            WHERE current_weighing.id = authorized.current_id
              AND current_weighing.animal_id = authorized.animal_id
              AND current_weighing.recorded_at = authorized.recorded_at
              AND current_weighing.lot_id IS authorized.current_lot_id
              AND current_weighing.weight_kg IS authorized.current_weight_kg
              AND current_weighing.notes = authorized.current_notes
              AND current_weighing.source = authorized.current_source
              AND current_weighing.created_at = authorized.current_created_at
          )
          AND NOT EXISTS (
            SELECT 1 FROM livestock_weighings AS conflicting_id
            WHERE conflicting_id.id = authorized.id
              AND conflicting_id.id <> authorized.current_id
          )
        )
      )
      SELECT id, ?, animal_id, recorded_at, weight_kg, ?, 'Sesión de pesaje', ?
      FROM eligible
      WHERE (SELECT COUNT(*) FROM eligible) = (SELECT COUNT(*) FROM requested)
      ON CONFLICT(animal_id, recorded_at) DO UPDATE SET
        lot_id = excluded.lot_id,
        weight_kg = excluded.weight_kg,
        notes = excluded.notes,
        source = excluded.source
    `).bind(
      requested,
      lotId,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
      ...(syncAccess?.bindings ?? []),
      lotId,
      notes,
      createdAt,
    ),
    prepareIndividualLotSummaryUpdate(client, lotId, scope, createdAt, true),
    ...(syncAccess ? [client.prepare(`
      SELECT CASE WHEN ${syncAccess.sql} THEN 1 ELSE 0 END AS authorized
    `).bind(...syncAccess.bindings)] : []),
  ]);
  if (syncAccess) {
    const accessResult = results[2]?.results[0] as { authorized?: number } | undefined;
    if (Number(accessResult?.authorized) !== 1) throw new SyncWriteAccessRevokedError();
  }
  if (results[0].meta.changes !== entries.length) {
    throw new DomainRuleError("La pertenencia de los animales cambió durante la sesión de pesaje.");
  }
  return listLivestockWeighings(scope);
}

export async function deleteWeighing(
  id: string,
  scope: OrganizationFieldScope,
  expectedSnapshotToken: string,
): Promise<boolean> {
  if (scope.fieldIds.length === 0) return false;
  const db = getDb();
  const [existing] = await db
    .select({ weighing: livestockWeighings, currentLotId: livestockAnimals.lotId })
    .from(livestockWeighings)
    .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockWeighings.animalId))
    .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
    .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
    .where(and(
      eq(livestockWeighings.id, id),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!existing) return false;
  if (expectedSnapshotToken !== await weighingSnapshotToken(existing.weighing)) {
    throwFieldScopeConflict("El pesaje cambió desde la última carga.");
  }

  const client = db.$client;
  const results = await client.batch([
    client.prepare(`
      DELETE FROM livestock_weighings
      WHERE id = ?
        AND lot_id IS ?
        AND animal_id = ?
        AND recorded_at = ?
        AND weight_kg IS ?
        AND notes = ?
        AND source = ?
        AND created_at = ?
        AND EXISTS (
          SELECT 1
          FROM livestock_animals AS animal
          INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
          INNER JOIN fields ON fields.id = lot.field_id
          WHERE animal.id = livestock_weighings.animal_id
            AND lot.id = ?
            AND fields.organization_id = ?
            AND fields.id IN (SELECT value FROM json_each(?))
        )
    `).bind(
      id,
      existing.weighing.lotId,
      existing.weighing.animalId,
      existing.weighing.recordedAt,
      existing.weighing.weightKg,
      existing.weighing.notes,
      existing.weighing.source,
      existing.weighing.createdAt,
      existing.currentLotId,
      scope.organizationId,
      JSON.stringify(scope.fieldIds),
    ),
    prepareIndividualLotSummaryUpdate(client, existing.currentLotId, scope, new Date().toISOString(), true),
  ]);
  return results[0].meta.changes > 0;
}
