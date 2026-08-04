import { getDb } from "@/db";
import type { AccessContext, OrganizationFieldScope } from "@/src/modules/access/domain/types";
import { throwFieldScopeConflict } from "@/src/modules/access/server/organization-field-scope";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type {
  PaddockNdviNoDataReason,
  PaddockNdviPaddockSnapshot,
  PaddockNdviValue,
} from "../domain/paddock-ndvi";
import { decodeStoredPolygon } from "../utils/polygon-rings";
import type { NdviStatisticalResult } from "../ndvi/sentinel";

type NdviScope = OrganizationFieldScope & Partial<Pick<AccessContext, "email">>;
type SqlBinding = string | number | null;

type PaddockNdviQueryRow = {
  paddockId: string;
  paddockName: string;
  fieldId: string;
  sector: string;
  areaHectares: number;
  coordinates: string;
  grazeableAreaHectares: number | null;
  landUse: PaddockNdviPaddockSnapshot["landUse"];
  holeKinds: string;
  soilPh: number | null;
  soilNitrogen: number | null;
  soilPhosphorus: number | null;
  soilPotassium: number | null;
  lastActivity: string;
  paddockStatus: PaddockNdviPaddockSnapshot["status"];
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  archivedAt: string | null;
  archiveReason: PaddockNdviPaddockSnapshot["archiveReason"];
  createdByOperationId: string | null;
  archivedByOperationId: string | null;
  cacheId: string | null;
  cacheOrganizationId: string | null;
  cacheFieldId: string | null;
  cachePaddockId: string | null;
  cacheMonth: string | null;
  cacheStatus: "ok" | "no_data" | null;
  cacheMeanNdvi: number | null;
  cacheNoDataReason: PaddockNdviNoDataReason | null;
  cacheCloudPct: number | null;
  cacheCloudPctIsApproximate: number | null;
  cacheIntervalFrom: string | null;
  cacheIntervalTo: string | null;
  cacheObservedAt: string | null;
  cacheSampleCount: number | null;
  cacheNoDataCount: number | null;
  cacheValidSampleCount: number | null;
  cacheComputedAt: string | null;
  cacheGeometrySnapshotToken: string | null;
};

export type PaddockNdviCandidate = Readonly<{
  paddockId: string;
  paddockName: string;
  rings: ReturnType<typeof decodeStoredPolygon>;
  snapshot: PaddockNdviPaddockSnapshot;
  geometrySnapshotToken: string;
  cache: PaddockNdviValue | null;
  history: readonly PaddockNdviValue[];
}>;

export async function listPaddockNdviCandidates(
  fieldIdValue: string,
  scope: NdviScope,
  month?: string,
): Promise<PaddockNdviCandidate[]> {
  const fieldId = fieldIdValue.trim();
  if (!fieldId) throw invalidNdvi("Selecciona un fundo.");
  const monthFilter = month ? "AND cached.month = ?" : "";
  const bindings: SqlBinding[] = [scope.organizationId, fieldId];
  if (month) bindings.push(month);
  bindings.push(fieldId, scope.organizationId, JSON.stringify(scope.fieldIds));
  const result = await getDb().$client.prepare(`
    WITH ranked_cache AS (
      SELECT cached.*, ROW_NUMBER() OVER (
        PARTITION BY cached.paddock_id
        ORDER BY cached.month DESC, cached.computed_at DESC, cached.id DESC
      ) AS cache_rank
      FROM paddock_ndvi AS cached
      WHERE cached.organization_id = ? AND cached.field_id = ? ${monthFilter}
    ), scoped_paddocks AS (
      SELECT paddock.*
      FROM potreros AS paddock
      INNER JOIN fields AS current_field ON current_field.id = paddock.field_id
      WHERE paddock.field_id = ?
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND paddock.archived_at IS NULL
        AND paddock.deleted_at IS NULL
    )
    SELECT
      paddock.id AS "paddockId", paddock.name AS "paddockName", paddock.field_id AS "fieldId",
      paddock.sector AS "sector", paddock.area_hectares AS "areaHectares",
      paddock.coordinates AS "coordinates", paddock.grazeable_area_hectares AS "grazeableAreaHectares",
      paddock.land_use AS "landUse", paddock.hole_kinds AS "holeKinds",
      paddock.soil_ph AS "soilPh", paddock.soil_nitrogen AS "soilNitrogen",
      paddock.soil_phosphorus AS "soilPhosphorus", paddock.soil_potassium AS "soilPotassium",
      paddock.last_activity AS "lastActivity", paddock.status AS "paddockStatus",
      paddock.created_at AS "createdAt", paddock.updated_at AS "updatedAt",
      paddock.deleted_at AS "deletedAt", paddock.archived_at AS "archivedAt",
      paddock.archive_reason AS "archiveReason", paddock.created_by_operation_id AS "createdByOperationId",
      paddock.archived_by_operation_id AS "archivedByOperationId",
      cache.id AS "cacheId", cache.organization_id AS "cacheOrganizationId",
      cache.field_id AS "cacheFieldId", cache.paddock_id AS "cachePaddockId",
      cache.month AS "cacheMonth", cache.status AS "cacheStatus", cache.mean_ndvi AS "cacheMeanNdvi",
      cache.no_data_reason AS "cacheNoDataReason", cache.cloud_pct AS "cacheCloudPct",
      cache.cloud_pct_is_approximate AS "cacheCloudPctIsApproximate",
      cache.interval_from AS "cacheIntervalFrom", cache.interval_to AS "cacheIntervalTo",
      cache.observed_at AS "cacheObservedAt", cache.sample_count AS "cacheSampleCount",
      cache.no_data_count AS "cacheNoDataCount", cache.valid_sample_count AS "cacheValidSampleCount",
      cache.computed_at AS "cacheComputedAt", cache.geometry_snapshot_token AS "cacheGeometrySnapshotToken"
    FROM scoped_paddocks AS paddock
    LEFT JOIN ranked_cache AS cache ON cache.paddock_id = paddock.id AND cache.cache_rank <= 6
    ORDER BY paddock.name, paddock.id, cache.month DESC, cache.computed_at DESC, cache.id DESC
  `).bind(...bindings).all<PaddockNdviQueryRow>();
  if (!scope.fieldIds.includes(fieldId) || result.results.length === 0) {
    const exists = await scopedFieldExists(fieldId, scope);
    if (!exists) throwFieldScopeConflict("El fundo no existe o no está disponible.");
  }
  const rowsByPaddock = new Map<string, PaddockNdviQueryRow[]>();
  for (const row of result.results) {
    const rows = rowsByPaddock.get(row.paddockId) ?? [];
    rows.push(row);
    rowsByPaddock.set(row.paddockId, rows);
  }
  return Promise.all([...rowsByPaddock.values()].map(toCandidate));
}

export async function commitPaddockNdviValue(input: Readonly<{
  scope: NdviScope;
  candidate: PaddockNdviCandidate;
  interval: Readonly<{ from: string; to: string }>;
  result: NdviStatisticalResult;
  computedAt: string;
  auditId: string;
}>): Promise<PaddockNdviValue> {
  const { candidate, scope } = input;
  const resultInterval = input.result.interval ?? input.interval;
  if (
    Date.parse(resultInterval.from) !== Date.parse(input.interval.from)
    || Date.parse(resultInterval.to) !== Date.parse(input.interval.to)
  ) throw invalidNdvi("El intervalo mensual devuelto por CDSE no coincide con el solicitado.");
  const month = resultInterval.from.slice(0, 10);
  const id = paddockNdviId(scope.organizationId, candidate.snapshot.fieldId, candidate.paddockId, month);
  const stored = toStoredValue({ ...input, interval: resultInterval, id, month });
  const guard = paddockSnapshotGuard();
  const guardValues = () => paddockSnapshotGuardValues(candidate, scope);
  const client = getDb().$client;
  const beforeJson = candidate.cache ? JSON.stringify(candidate.cache) : null;
  const afterJson = JSON.stringify(stored);
  const statements = [
    client.prepare(`
      INSERT INTO paddock_ndvi (
        id, organization_id, field_id, paddock_id, month, status, mean_ndvi, no_data_reason,
        cloud_pct, cloud_pct_is_approximate, interval_from, interval_to, observed_at,
        sample_count, no_data_count, valid_sample_count, computed_at, geometry_snapshot,
        paddock_snapshot, geometry_snapshot_token
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${guard}
      ON CONFLICT (organization_id, field_id, paddock_id, month) DO UPDATE SET
        id = excluded.id, status = excluded.status, mean_ndvi = excluded.mean_ndvi,
        no_data_reason = excluded.no_data_reason, cloud_pct = excluded.cloud_pct,
        cloud_pct_is_approximate = excluded.cloud_pct_is_approximate,
        interval_from = excluded.interval_from, interval_to = excluded.interval_to,
        observed_at = excluded.observed_at, sample_count = excluded.sample_count,
        no_data_count = excluded.no_data_count, valid_sample_count = excluded.valid_sample_count,
        computed_at = excluded.computed_at, geometry_snapshot = excluded.geometry_snapshot,
        paddock_snapshot = excluded.paddock_snapshot, geometry_snapshot_token = excluded.geometry_snapshot_token
      WHERE excluded.computed_at >= paddock_ndvi.computed_at
    `).bind(
      stored.id, stored.organizationId, stored.fieldId, stored.paddockId, stored.month,
      stored.status, stored.meanNdvi, stored.noDataReason, stored.cloudPct,
      stored.cloudPctIsApproximate ? 1 : 0, stored.interval.from, stored.interval.to,
      stored.observedAt, stored.sampleCount, stored.noDataCount, stored.validSampleCount,
      stored.computedAt, JSON.stringify(candidate.snapshot.coordinates), JSON.stringify(candidate.snapshot),
      stored.geometrySnapshotToken, ...guardValues(),
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, occurred_at
      )
      SELECT ?, ?, ?, ?, 'paddock.ndvi.refreshed', 'paddock_ndvi', ?, ?, ?, ?
      WHERE changes() = 1 AND ${guard}
        AND EXISTS (
          SELECT 1 FROM paddock_ndvi AS saved
          WHERE saved.id = ? AND saved.computed_at = ? AND saved.geometry_snapshot_token = ?
        )
    `).bind(
      input.auditId, scope.organizationId, candidate.snapshot.fieldId, scope.email ?? "unknown", stored.id,
      beforeJson, afterJson, stored.computedAt, ...guardValues(), stored.id, stored.computedAt,
      stored.geometrySnapshotToken,
    ),
    client.prepare(`
      SELECT CASE WHEN ${guard}
        AND EXISTS (
          SELECT 1 FROM paddock_ndvi AS saved
          WHERE saved.id = ? AND saved.organization_id = ? AND saved.field_id = ?
            AND saved.paddock_id = ? AND saved.month = ? AND saved.computed_at = ?
            AND saved.geometry_snapshot_token = ?
        )
        AND EXISTS (
          SELECT 1 FROM audit_log AS audit
          WHERE audit.id = ? AND audit.organization_id = ? AND audit.field_id = ?
            AND audit.entity_id = ? AND audit.action = 'paddock.ndvi.refreshed'
        )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
    `).bind(
      ...guardValues(), stored.id, stored.organizationId, stored.fieldId, stored.paddockId,
      stored.month, stored.computedAt, stored.geometrySnapshotToken,
      input.auditId, scope.organizationId, stored.fieldId, stored.id,
    ),
  ];
  try {
    await client.batch(statements);
    return stored;
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|UNIQUE constraint|FOREIGN KEY constraint/i.test(cause.message)) {
      throwFieldScopeConflict("El potrero cambió antes de confirmar el resultado satelital.");
    }
    throw cause;
  }
}

export async function hashPaddockGeometry(input: Readonly<{
  id: string;
  fieldId: string;
  rings: ReturnType<typeof decodeStoredPolygon>;
  holeKinds: PaddockNdviPaddockSnapshot["holeKinds"];
}>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(input)));
  return `paddock-ndvi-geometry:v1:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function toCandidate(rows: readonly PaddockNdviQueryRow[]): Promise<PaddockNdviCandidate> {
  const row = rows[0];
  if (!row) throw invalidNdvi("El potrero NDVI no es válido.");
  const coordinates = parseJson(row.coordinates);
  const snapshot: PaddockNdviPaddockSnapshot = {
    id: row.paddockId,
    fieldId: row.fieldId,
    name: row.paddockName,
    sector: row.sector,
    areaHectares: Number(row.areaHectares),
    coordinates: coordinates as PaddockNdviPaddockSnapshot["coordinates"],
    grazeableAreaHectares: nullableNumber(row.grazeableAreaHectares),
    landUse: row.landUse,
    holeKinds: parseStringArray(row.holeKinds) as PaddockNdviPaddockSnapshot["holeKinds"],
    soilPh: nullableNumber(row.soilPh),
    soilNitrogen: nullableNumber(row.soilNitrogen),
    soilPhosphorus: nullableNumber(row.soilPhosphorus),
    soilPotassium: nullableNumber(row.soilPotassium),
    lastActivity: row.lastActivity,
    status: row.paddockStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt,
    archivedAt: row.archivedAt,
    archiveReason: row.archiveReason,
    createdByOperationId: row.createdByOperationId,
    archivedByOperationId: row.archivedByOperationId,
  };
  const rings = decodeStoredPolygon(coordinates);
  const geometrySnapshotToken = await hashPaddockGeometry({
    id: snapshot.id,
    fieldId: snapshot.fieldId,
    rings,
    holeKinds: snapshot.holeKinds,
  });
  const history = rows.flatMap((historyRow) => historyRow.cacheId ? [cacheFromRow(historyRow)] : []);
  return {
    paddockId: row.paddockId,
    paddockName: row.paddockName,
    rings,
    snapshot,
    geometrySnapshotToken,
    cache: history[0] ?? null,
    history,
  };
}

function cacheFromRow(row: PaddockNdviQueryRow): PaddockNdviValue {
  if (
    !row.cacheId || !row.cacheOrganizationId || !row.cacheFieldId || !row.cachePaddockId
    || !row.cacheMonth || !row.cacheStatus || !row.cacheIntervalFrom || !row.cacheIntervalTo
    || row.cacheSampleCount === null || row.cacheNoDataCount === null || row.cacheValidSampleCount === null
    || !row.cacheComputedAt || !row.cacheGeometrySnapshotToken
  ) throw invalidNdvi("El caché NDVI almacenado no es válido.");
  return {
    id: row.cacheId,
    organizationId: row.cacheOrganizationId,
    fieldId: row.cacheFieldId,
    paddockId: row.cachePaddockId,
    month: row.cacheMonth,
    status: row.cacheStatus,
    meanNdvi: nullableNumber(row.cacheMeanNdvi),
    noDataReason: row.cacheNoDataReason,
    cloudPct: nullableNumber(row.cacheCloudPct),
    cloudPctIsApproximate: Boolean(row.cacheCloudPctIsApproximate),
    interval: { from: row.cacheIntervalFrom, to: row.cacheIntervalTo },
    observedAt: row.cacheObservedAt,
    sampleCount: Number(row.cacheSampleCount),
    noDataCount: Number(row.cacheNoDataCount),
    validSampleCount: Number(row.cacheValidSampleCount),
    computedAt: row.cacheComputedAt,
    geometrySnapshotToken: row.cacheGeometrySnapshotToken,
  };
}

function toStoredValue(input: Readonly<{
  id: string;
  month: string;
  scope: NdviScope;
  candidate: PaddockNdviCandidate;
  interval: Readonly<{ from: string; to: string }>;
  result: NdviStatisticalResult;
  computedAt: string;
}>): PaddockNdviValue {
  const common = {
    id: input.id,
    organizationId: input.scope.organizationId,
    fieldId: input.candidate.snapshot.fieldId,
    paddockId: input.candidate.paddockId,
    month: input.month,
    interval: input.interval,
    computedAt: input.computedAt,
    geometrySnapshotToken: input.candidate.geometrySnapshotToken,
  } as const;
  if (input.result.status === "ok") return {
    ...common,
    status: "ok",
    meanNdvi: input.result.meanNdvi,
    noDataReason: null,
    cloudPct: input.result.cloudPct,
    cloudPctIsApproximate: true,
    observedAt: input.result.observedAt,
    sampleCount: input.result.sampleCount,
    noDataCount: input.result.noDataCount,
    validSampleCount: input.result.validSampleCount,
  };
  return {
    ...common,
    status: "no_data",
    meanNdvi: null,
    noDataReason: input.result.reason,
    cloudPct: null,
    cloudPctIsApproximate: false,
    observedAt: input.result.observedAt,
    sampleCount: input.result.sampleCount,
    noDataCount: input.result.noDataCount,
    validSampleCount: 0,
  };
}

function paddockSnapshotGuard(): string {
  return `EXISTS (
    SELECT 1
    FROM potreros AS current_paddock
    INNER JOIN fields AS current_field ON current_field.id = current_paddock.field_id
    WHERE current_paddock.id = ? AND current_paddock.field_id = ?
      AND current_field.organization_id = ?
      AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      AND current_paddock.name = ? AND current_paddock.sector = ?
      AND current_paddock.area_hectares = ? AND json(current_paddock.coordinates) = json(?)
      AND current_paddock.grazeable_area_hectares IS ? AND current_paddock.land_use = ?
      AND json(current_paddock.hole_kinds) = json(?)
      AND current_paddock.soil_ph IS ? AND current_paddock.soil_nitrogen IS ?
      AND current_paddock.soil_phosphorus IS ? AND current_paddock.soil_potassium IS ?
      AND current_paddock.last_activity = ? AND current_paddock.status = ?
      AND current_paddock.created_at = ? AND current_paddock.updated_at = ?
      AND current_paddock.deleted_at IS ? AND current_paddock.archived_at IS ?
      AND current_paddock.archive_reason IS ? AND current_paddock.created_by_operation_id IS ?
      AND current_paddock.archived_by_operation_id IS ?
      AND current_paddock.deleted_at IS NULL AND current_paddock.archived_at IS NULL
  )`;
}

function paddockSnapshotGuardValues(candidate: PaddockNdviCandidate, scope: NdviScope): SqlBinding[] {
  const snapshot = candidate.snapshot;
  return [
    snapshot.id, snapshot.fieldId, scope.organizationId, JSON.stringify(scope.fieldIds),
    snapshot.name, snapshot.sector, snapshot.areaHectares, JSON.stringify(snapshot.coordinates),
    snapshot.grazeableAreaHectares, snapshot.landUse, JSON.stringify(snapshot.holeKinds),
    snapshot.soilPh, snapshot.soilNitrogen, snapshot.soilPhosphorus, snapshot.soilPotassium,
    snapshot.lastActivity, snapshot.status, snapshot.createdAt, snapshot.updatedAt,
    snapshot.deletedAt, snapshot.archivedAt, snapshot.archiveReason,
    snapshot.createdByOperationId, snapshot.archivedByOperationId,
  ];
}

async function scopedFieldExists(fieldId: string, scope: NdviScope): Promise<boolean> {
  const row = await getDb().$client.prepare(`
    SELECT 1 AS present FROM fields
    WHERE id = ? AND organization_id = ?
      AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    LIMIT 1
  `).bind(fieldId, scope.organizationId, JSON.stringify(scope.fieldIds)).first<{ present: number }>();
  return row?.present === 1;
}

function paddockNdviId(organizationId: string, fieldId: string, paddockId: string, month: string): string {
  return `paddock-ndvi:${organizationId}:${fieldId}:${paddockId}:${month}`;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidNdvi("La geometría almacenada no es válida.");
  }
}

function parseStringArray(value: string): string[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function nullableNumber(value: number | null): number | null {
  return value === null ? null : Number(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([first], [second]) => first.localeCompare(second))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function invalidNdvi(message: string): DomainRuleError {
  return new DomainRuleError(message, "PADDOCK_NDVI_INVALID");
}
