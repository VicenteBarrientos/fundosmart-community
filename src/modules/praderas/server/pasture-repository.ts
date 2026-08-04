import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import {
  calculateGrowthRate,
  PastureDomainError,
  deriveBiomassObservation,
  planLotRotations,
} from "@/src/modules/praderas/domain/pasture-planning.mjs";
import { buildPastureObservationId, buildPastureRawObjectKey } from "@/src/modules/praderas/domain/pasture-storage.mjs";
import {
  PASTURE_CDSE_PROVIDER_KEY,
  type CreatePastureRotationPlanRequest,
  type ManualPastureObservationRequest,
  type NdviCalibration,
  type NdviCanonicalObservation,
  type PastureNdviCollectionQueue,
  type PastureBiomassEstimate,
  type PastureDashboard,
  type PastureGrowthRate,
  type PastureObservationResult,
  type PasturePaddockSnapshot,
  type PasturePlanningBasis,
  type PasturePlanningLotBasis,
  type PastureProviderStatus,
  type PastureSyntheticNdviSample,
  type StoredPastureRotationPlan,
} from "@/src/modules/praderas/domain/types";
import type {
  PaddockNdviNoDataReason,
  PaddockNdviPaddockSnapshot,
} from "@/src/modules/potreros/domain/paddock-ndvi";
import type { PaddockNdviCandidate } from "@/src/modules/potreros/server/paddock-ndvi-repository";
import { env } from "cloudflare:workers";

type D1Value = string | number | null;

type ProviderRow = { mode: string; provider_key: string | null; decided_at: string };
type PaddockRow = {
  id: string;
  name: string;
  area_hectares: number;
  estimate_id: string | null;
  observation_id: string | null;
  source_kind: string | null;
  method: string | null;
  kg_dm_per_hectare: number | null;
  calibration_id: string | null;
  captured_at: string | null;
  computed_at: string | null;
};
type EstimateRow = {
  id: string;
  observation_id: string;
  paddock_id: string;
  paddock_name: string;
  source_kind: string;
  method: string;
  kg_dm_per_hectare: number;
  calibration_id: string | null;
  captured_at: string;
  computed_at: string;
};
type PlanRow = { id: string; operation_id: string; field_id: string; status: string; plan_json: string; created_at: string };
type PlanningLotRow = {
  id: string;
  name: string;
  tracking_mode: string;
  planned_animal_count: number;
  active_animal_count: number;
  lot_average_weight_kg: number | null;
  measured_average_weight_kg: number | null;
  weight_sample_count: number;
  ration_product_name: string | null;
  ration_kg_per_animal_day: number | null;
  ration_unit_cost_clp: number | null;
};
type RotationSettingsRow = { recent_days: number; long_rest_days: number; version: number };
type ActiveCellRow = { paddock_id: string; cell_id: string; cell_name: string; cell_index: number };
type AnalyticsMetricRow = {
  projection_id: string;
  period: string;
  computed_at: string;
  metric_key: string;
  status: string;
  status_reason: string | null;
  value: number | null;
};
type FieldModeRow = { is_demo: number };
type ReplayRow = {
  id: string;
  field_id: string;
  paddock_id: string;
  source_kind: string;
  object_key: string;
  sha256: string;
  request_hash: string;
  storage_status: string;
  captured_at: string;
  stored_at: string | null;
  kg_dm_per_hectare: number | null;
};
type NdviNoDataRow = {
  id: string;
  field_id: string;
  paddock_id: string;
  month: string;
  no_data_reason: PaddockNdviNoDataReason;
  observed_at: string | null;
  sample_count: number;
  no_data_count: number;
  computed_at: string;
  geometry_snapshot_token: string;
};

export type PastureNdviNoDataRecord = {
  id: string;
  fieldId: string;
  paddockId: string;
  month: string;
  reason: PaddockNdviNoDataReason;
  observedAt: string | null;
  sampleCount: number;
  noDataCount: number;
  computedAt: string;
  geometrySnapshotToken: string;
  idempotentReplay: boolean;
};

export class PastureScopeError extends Error {
  readonly code = "FIELD_SCOPE_CONFLICT";

  constructor() {
    super("Tu acceso al fundo o la configuración de pastoreo cambió. Actualiza la página e inténtalo nuevamente.");
    this.name = "PastureScopeError";
  }
}

export async function getPastureDashboard(fieldId: string, actor: AccessContext): Promise<PastureDashboard> {
  const client = getDb().$client;
  const accessSql = currentPastureAccessSql(false);
  const bindings = accessBindings(actor, fieldId);
  const [providerResult, paddockResult, estimateResult, planResult, lotResult, settingsResult, cellResult, metricResult, fieldModeResult] = await client.batch([
    client.prepare(`
      SELECT mode, provider_key, decided_at
      FROM pasture_provider_decisions
      WHERE organization_id = ? AND field_id = ? AND ${accessSql}
      ORDER BY decided_at DESC LIMIT 1
    `).bind(actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      WITH ranked_estimates AS (
        SELECT estimate.id, estimate.raw_observation_id, estimate.paddock_id,
          estimate.method, estimate.kg_dm_per_hectare, estimate.calibration_id,
          raw.source_kind, raw.captured_at, estimate.computed_at,
          ROW_NUMBER() OVER (
            PARTITION BY estimate.paddock_id
            ORDER BY raw.captured_at DESC, estimate.computed_at DESC, estimate.id DESC
          ) AS rank
        FROM pasture_biomass_estimates AS estimate
        JOIN pasture_raw_observations AS raw
          ON raw.id = estimate.raw_observation_id
         AND raw.organization_id = estimate.organization_id
         AND raw.field_id = estimate.field_id
        WHERE estimate.organization_id = ? AND estimate.field_id = ?
          AND raw.storage_status = 'stored'
      )
      SELECT paddock.id, paddock.name, paddock.area_hectares,
        latest.id AS estimate_id, latest.raw_observation_id AS observation_id,
        latest.source_kind, latest.method, latest.kg_dm_per_hectare,
        latest.calibration_id, latest.captured_at, latest.computed_at
      FROM potreros AS paddock
      JOIN fields AS field ON field.id = paddock.field_id AND field.organization_id = ?
      LEFT JOIN ranked_estimates AS latest ON latest.paddock_id = paddock.id AND latest.rank = 1
      WHERE paddock.field_id = ? AND paddock.deleted_at IS NULL AND paddock.archived_at IS NULL
        AND ${accessSql}
      ORDER BY paddock.name COLLATE NOCASE, paddock.id
    `).bind(actor.organizationId, fieldId, actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      WITH ranked_history AS (
        SELECT estimate.id, estimate.raw_observation_id AS observation_id,
          estimate.paddock_id, paddock.name AS paddock_name, raw.source_kind,
          estimate.method, estimate.kg_dm_per_hectare, estimate.calibration_id,
          raw.captured_at, estimate.computed_at,
          ROW_NUMBER() OVER (
            PARTITION BY estimate.paddock_id
            ORDER BY raw.captured_at DESC, estimate.computed_at DESC, estimate.id DESC
          ) AS history_rank
        FROM pasture_biomass_estimates AS estimate
        JOIN pasture_raw_observations AS raw
          ON raw.id = estimate.raw_observation_id
         AND raw.organization_id = estimate.organization_id
         AND raw.field_id = estimate.field_id
        JOIN potreros AS paddock ON paddock.id = estimate.paddock_id AND paddock.field_id = estimate.field_id
        WHERE estimate.organization_id = ? AND estimate.field_id = ?
          AND raw.storage_status = 'stored' AND ${accessSql}
      )
      SELECT id, observation_id, paddock_id, paddock_name, source_kind, method,
        kg_dm_per_hectare, calibration_id, captured_at, computed_at
      FROM ranked_history WHERE history_rank <= 2
      ORDER BY captured_at DESC, id DESC
    `).bind(actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      SELECT id, operation_id, field_id, status, plan_json, created_at
      FROM pasture_rotation_plans
      WHERE organization_id = ? AND field_id = ? AND ${accessSql}
      ORDER BY created_at DESC, id DESC LIMIT 10
    `).bind(actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      WITH latest_weights AS (
        SELECT animal.lot_id, weighing.animal_id, weighing.weight_kg,
          ROW_NUMBER() OVER (
            PARTITION BY weighing.animal_id
            ORDER BY weighing.recorded_at DESC, weighing.id DESC
          ) AS rank
        FROM livestock_weighings AS weighing
        JOIN livestock_animals AS animal ON animal.id = weighing.animal_id AND animal.status = 'active'
      ), lot_weight_summary AS (
        SELECT lot_id, AVG(weight_kg) AS average_weight_kg, COUNT(*) AS sample_count
        FROM latest_weights WHERE rank = 1 GROUP BY lot_id
      )
      SELECT lot.id, lot.name, lot.tracking_mode,
        lot.animal_count AS planned_animal_count,
        (SELECT COUNT(*) FROM livestock_animals AS animal
          WHERE animal.lot_id = lot.id AND animal.status = 'active') AS active_animal_count,
        lot.average_weight_kg AS lot_average_weight_kg,
        weights.average_weight_kg AS measured_average_weight_kg,
        COALESCE(weights.sample_count, 0) AS weight_sample_count,
        ration.product_name AS ration_product_name,
        ration.kg_per_animal_day AS ration_kg_per_animal_day,
        (SELECT inventory.unit_cost_clp
          FROM livestock_feed_inventory AS inventory
          WHERE inventory.field_id = lot.field_id
            AND lower(trim(inventory.product_name)) = lower(trim(ration.product_name))
          ORDER BY inventory.updated_at DESC, inventory.id DESC LIMIT 1) AS ration_unit_cost_clp
      FROM livestock_lots AS lot
      JOIN fields AS field ON field.id = lot.field_id AND field.organization_id = ?
      LEFT JOIN lot_weight_summary AS weights ON weights.lot_id = lot.id
      LEFT JOIN livestock_feeding_plans AS ration ON ration.lot_id = lot.id
      WHERE lot.field_id = ? AND lot.status = 'active' AND ${accessSql}
      ORDER BY lot.name COLLATE NOCASE, lot.id
    `).bind(actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      SELECT settings.recent_days, settings.long_rest_days, settings.version
      FROM paddock_rotation_settings AS settings
      JOIN fields AS field ON field.id = settings.field_id AND field.organization_id = ?
      WHERE settings.field_id = ? AND ${accessSql}
      LIMIT 1
    `).bind(actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      SELECT cell.paddock_id, cell.id AS cell_id, cell.name AS cell_name, cell.cell_index
      FROM paddock_cells AS cell
      JOIN potreros AS paddock ON paddock.id = cell.paddock_id AND paddock.field_id = cell.field_id
      JOIN fields AS field ON field.id = cell.field_id AND field.organization_id = ?
      WHERE cell.field_id = ? AND cell.active_to IS NULL AND ${accessSql}
      ORDER BY cell.paddock_id, cell.cell_index, cell.id
    `).bind(actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      WITH latest_run AS (
        SELECT id, period, computed_at
        FROM analytics_projection_runs
        WHERE organization_id = ? AND field_id = ? AND is_current = 1
        ORDER BY computed_at DESC, id DESC LIMIT 1
      )
      SELECT run.id AS projection_id, run.period, run.computed_at,
        metric.metric_key, metric.status, metric.status_reason, metric.value
      FROM latest_run AS run
      JOIN analytics_herd_metrics AS metric
        ON metric.projection_id = run.id AND metric.organization_id = ? AND metric.field_id = ?
      WHERE metric.metric_key IN ('finance.feed_cost_clp', 'finance.iofc_clp', 'finance.cost_per_liter_clp')
        AND ${accessSql}
      ORDER BY metric.metric_key
    `).bind(actor.organizationId, fieldId, actor.organizationId, fieldId, ...bindings),
    client.prepare(`
      SELECT field.is_demo
      FROM fields AS field
      WHERE field.organization_id = ? AND field.id = ? AND ${accessSql}
      LIMIT 1
    `).bind(actor.organizationId, fieldId, ...bindings),
  ]);
  const provider = firstResult<ProviderRow>(providerResult);
  const paddocks = allResults<PaddockRow>(paddockResult).map(toPaddockSnapshot);
  const fieldMode = firstResult<FieldModeRow>(fieldModeResult);
  if (!fieldMode) throw new PastureScopeError();
  const planningBasis = await buildPlanningBasis({
    fieldId,
    lots: allResults<PlanningLotRow>(lotResult),
    paddocks,
    settings: firstResult<RotationSettingsRow>(settingsResult),
    activeCells: allResults<ActiveCellRow>(cellResult),
    metrics: allResults<AnalyticsMetricRow>(metricResult),
  });
  const isDemo = fieldMode.is_demo === 1;
  const recentEstimates = allResults<EstimateRow>(estimateResult).map(toEstimate);
  return {
    organizationId: actor.organizationId,
    fieldId,
    provider: toProviderStatus(provider),
    paddocks,
    recentEstimates,
    growthRates: buildGrowthRates(paddocks, recentEstimates),
    rotationPlans: allResults<PlanRow>(planResult).map(toRotationPlan),
    planningBasis,
    syntheticNdviSamples: isDemo ? buildSyntheticNdviSamples(paddocks) : [],
  };
}

export async function recordManualPastureObservation(
  request: ManualPastureObservationRequest,
  actor: AccessContext,
): Promise<PastureObservationResult> {
  const operationId = normalizeOperationId(request.operationId);
  const observationId = await buildPastureObservationId({
    organizationId: actor.organizationId,
    fieldId: request.fieldId,
    operationId,
  });
  const rawDocument = {
    version: 1,
    kind: "manual",
    observationId,
    fieldId: request.fieldId,
    paddockId: request.paddockId,
    capturedAt: request.capturedAt,
    measurement: request.measurement,
    notes: request.notes?.trim().slice(0, 500) ?? "",
  };
  const estimate = deriveBiomassObservation({
    id: observationId,
    kind: "manual",
    paddockId: request.paddockId,
    capturedAt: request.capturedAt,
    measurement: request.measurement,
  });
  return persistRawObservation({
    actor,
    operationId,
    fieldId: request.fieldId,
    paddockId: request.paddockId,
    sourceKind: "manual",
    providerKey: null,
    capturedAt: String(estimate.capturedAt),
    rawDocument,
    estimate: {
      method: String(estimate.method),
      kgDmPerHectare: Number(estimate.kgDmPerHectare),
      calibrationId: null,
      evidence: estimate.evidence,
    },
    observationId,
  });
}

export async function recordNdviPastureObservation(
  request: NdviCanonicalObservation,
  calibration: NdviCalibration,
  actor: AccessContext,
): Promise<PastureObservationResult> {
  const operationId = normalizeOperationId(request.operationId);
  const observationId = await buildPastureObservationId({
    organizationId: actor.organizationId,
    fieldId: request.fieldId,
    operationId,
  });
  const estimate = deriveBiomassObservation({
    id: observationId,
    kind: "ndvi",
    paddockId: request.paddockId,
    capturedAt: request.capturedAt,
    providerKey: request.providerKey,
    meanNdvi: request.meanNdvi,
    usablePixelPercent: request.usablePixelPercent,
  }, calibration);
  return persistRawObservation({
    actor,
    operationId,
    fieldId: request.fieldId,
    paddockId: request.paddockId,
    sourceKind: "ndvi",
    providerKey: request.providerKey,
    capturedAt: String(estimate.capturedAt),
    rawDocument: request.rawDocument,
    estimate: {
      method: String(estimate.method),
      kgDmPerHectare: Number(estimate.kgDmPerHectare),
      calibrationId: String(estimate.calibrationId),
      evidence: estimate.evidence,
    },
    observationId,
  });
}

export async function getPastureProviderDecision(fieldId: string, actor: AccessContext): Promise<PastureProviderStatus> {
  const accessSql = currentPastureAccessSql(false);
  const row = await getDb().$client.prepare(`
    SELECT mode, provider_key, decided_at
    FROM pasture_provider_decisions
    WHERE organization_id = ? AND field_id = ? AND ${accessSql}
    ORDER BY decided_at DESC LIMIT 1
  `).bind(actor.organizationId, fieldId, ...accessBindings(actor, fieldId)).first<ProviderRow>();
  return toProviderStatus(row ?? null);
}

export async function getActiveNdviCalibration(
  fieldId: string,
  providerKey: string,
  actor: AccessContext,
): Promise<NdviCalibration | null> {
  const accessSql = currentPastureAccessSql(false);
  const row = await getDb().$client.prepare(`
    SELECT id, provider_key, slope_kg_dm_per_ha, intercept_kg_dm_per_ha, min_ndvi, max_ndvi
    FROM pasture_ndvi_calibrations
    WHERE organization_id = ? AND field_id = ? AND provider_key = ? AND status = 'active'
      AND ${accessSql}
    ORDER BY valid_from DESC, id DESC LIMIT 1
  `).bind(actor.organizationId, fieldId, providerKey, ...accessBindings(actor, fieldId)).first<{
    id: string;
    provider_key: string;
    slope_kg_dm_per_ha: number;
    intercept_kg_dm_per_ha: number;
    min_ndvi: number;
    max_ndvi: number;
  }>();
  return row ? {
    id: row.id,
    providerKey: row.provider_key,
    slopeKgDmPerHa: row.slope_kg_dm_per_ha,
    interceptKgDmPerHa: row.intercept_kg_dm_per_ha,
    minNdvi: row.min_ndvi,
    maxNdvi: row.max_ndvi,
  } : null;
}

export async function getStoredPastureObservationReplay(
  fieldId: string,
  operationIdValue: string,
  actor: AccessContext,
): Promise<PastureObservationResult | null> {
  const operationId = normalizeOperationId(operationIdValue);
  const replay = await findObservationReplay(actor, fieldId, operationId);
  return replay ? storedObservationReplay(replay) : null;
}

export async function getStoredPastureNdviNoDataReplay(
  input: {
    fieldId: string;
    providerKey: string;
    calibrationId: string;
    interval: { from: string; to: string };
    candidate: PaddockNdviCandidate;
  },
  actor: AccessContext,
): Promise<PastureNdviNoDataRecord | null> {
  const month = monthlyIntervalStart(input.interval);
  const accessSql = currentPastureAccessSql(true);
  const access = accessBindings(actor, input.fieldId);
  const configuration = currentObservationConfiguration({
    actor,
    fieldId: input.fieldId,
    sourceKind: "ndvi",
    providerKey: input.providerKey,
    estimate: { calibrationId: input.calibrationId },
  });
  const snapshot = currentPaddockSnapshot(input.candidate, actor.organizationId, input.fieldId);
  const row = await getDb().$client.prepare(`
    SELECT cached.id, cached.field_id, cached.paddock_id, cached.month,
      cached.no_data_reason, cached.observed_at, cached.sample_count,
      cached.no_data_count, cached.computed_at, cached.geometry_snapshot_token
    FROM paddock_ndvi AS cached
    WHERE cached.organization_id = ? AND cached.field_id = ? AND cached.paddock_id = ?
      AND cached.month = ? AND cached.status = 'no_data'
      AND cached.interval_from = ? AND cached.interval_to = ?
      AND cached.geometry_snapshot_token = ?
      AND ${accessSql} AND ${configuration.sql} AND ${snapshot.sql}
    LIMIT 1
  `).bind(
    actor.organizationId, input.fieldId, input.candidate.paddockId, month,
    input.interval.from, input.interval.to, input.candidate.geometrySnapshotToken,
    ...access, ...configuration.bindings, ...snapshot.bindings,
  ).first<NdviNoDataRow>();
  return row ? toPastureNdviNoDataRecord(row, true) : null;
}

export async function recordPastureNdviNoData(
  input: {
    fieldId: string;
    providerKey: string;
    calibrationId: string;
    interval: { from: string; to: string };
    candidate: PaddockNdviCandidate;
    result: {
      reason: PaddockNdviNoDataReason;
      observedAt: string | null;
      interval: { from: string; to: string } | null;
      sampleCount: number;
      noDataCount: number;
      validSampleCount: 0;
    };
  },
  actor: AccessContext,
): Promise<PastureNdviNoDataRecord> {
  const resultInterval = input.result.interval ?? input.interval;
  if (
    Date.parse(resultInterval.from) !== Date.parse(input.interval.from)
    || Date.parse(resultInterval.to) !== Date.parse(input.interval.to)
  ) {
    throw new PastureDomainError(
      "El intervalo NDVI devuelto no coincide con el mes solicitado.",
      "PASTURE_NDVI_INTERVAL_MISMATCH",
    );
  }
  const month = monthlyIntervalStart(resultInterval);
  const computedAt = new Date().toISOString();
  const id = `paddock-ndvi:${actor.organizationId}:${input.fieldId}:${input.candidate.paddockId}:${month}`;
  const row: NdviNoDataRow = {
    id,
    field_id: input.fieldId,
    paddock_id: input.candidate.paddockId,
    month,
    no_data_reason: input.result.reason,
    observed_at: input.result.observedAt,
    sample_count: input.result.sampleCount,
    no_data_count: input.result.noDataCount,
    computed_at: computedAt,
    geometry_snapshot_token: input.candidate.geometrySnapshotToken,
  };
  const accessSql = currentPastureAccessSql(true);
  const access = accessBindings(actor, input.fieldId);
  const configuration = currentObservationConfiguration({
    actor,
    fieldId: input.fieldId,
    sourceKind: "ndvi",
    providerKey: input.providerKey,
    estimate: { calibrationId: input.calibrationId },
  });
  const snapshot = currentPaddockSnapshot(input.candidate, actor.organizationId, input.fieldId);
  const auditId = crypto.randomUUID();
  const afterJson = JSON.stringify({
    status: "no_data",
    providerKey: input.providerKey,
    calibrationId: input.calibrationId,
    reason: row.no_data_reason,
    interval: resultInterval,
    sampleCount: row.sample_count,
    noDataCount: row.no_data_count,
    geometrySnapshotToken: row.geometry_snapshot_token,
  });
  const client = getDb().$client;
  try {
    await client.batch([
      client.prepare(`
        INSERT INTO paddock_ndvi (
          id, organization_id, field_id, paddock_id, month, status, mean_ndvi,
          no_data_reason, cloud_pct, cloud_pct_is_approximate, interval_from,
          interval_to, observed_at, sample_count, no_data_count, valid_sample_count,
          computed_at, geometry_snapshot, paddock_snapshot, geometry_snapshot_token
        )
        SELECT ?, ?, ?, ?, ?, 'no_data', NULL, ?, NULL, 0, ?, ?, ?, ?, ?, 0,
          ?, ?, ?, ?
        WHERE ${accessSql} AND ${configuration.sql} AND ${snapshot.sql}
        ON CONFLICT (organization_id, field_id, paddock_id, month) DO UPDATE SET
          id = excluded.id, status = 'no_data', mean_ndvi = NULL,
          no_data_reason = excluded.no_data_reason, cloud_pct = NULL,
          cloud_pct_is_approximate = 0, interval_from = excluded.interval_from,
          interval_to = excluded.interval_to, observed_at = excluded.observed_at,
          sample_count = excluded.sample_count, no_data_count = excluded.no_data_count,
          valid_sample_count = 0, computed_at = excluded.computed_at,
          geometry_snapshot = excluded.geometry_snapshot,
          paddock_snapshot = excluded.paddock_snapshot,
          geometry_snapshot_token = excluded.geometry_snapshot_token
        WHERE excluded.computed_at >= paddock_ndvi.computed_at
          AND (
            paddock_ndvi.status = 'no_data'
            OR paddock_ndvi.geometry_snapshot_token <> excluded.geometry_snapshot_token
          )
      `).bind(
        row.id, actor.organizationId, input.fieldId, input.candidate.paddockId, month,
        row.no_data_reason, resultInterval.from, resultInterval.to, row.observed_at,
        row.sample_count, row.no_data_count, computedAt,
        JSON.stringify(input.candidate.snapshot.coordinates),
        JSON.stringify(input.candidate.snapshot), row.geometry_snapshot_token,
        ...access, ...configuration.bindings, ...snapshot.bindings,
      ),
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          after, occurred_at
        )
        SELECT ?, ?, ?, ?, 'pasture.ndvi.no_data.stored', 'paddock_ndvi', ?, ?, ?
        WHERE changes() = 1 AND ${accessSql} AND ${configuration.sql} AND ${snapshot.sql}
          AND EXISTS (
            SELECT 1 FROM paddock_ndvi AS saved
            WHERE saved.id = ? AND saved.organization_id = ? AND saved.field_id = ?
              AND saved.paddock_id = ? AND saved.month = ? AND saved.status = 'no_data'
              AND saved.computed_at = ? AND saved.geometry_snapshot_token = ?
          )
      `).bind(
        auditId, actor.organizationId, input.fieldId, actor.email, row.id, afterJson, computedAt,
        ...access, ...configuration.bindings, ...snapshot.bindings,
        row.id, actor.organizationId, input.fieldId, input.candidate.paddockId,
        month, computedAt, row.geometry_snapshot_token,
      ),
      client.prepare(`
        SELECT CASE WHEN ${accessSql} AND ${configuration.sql} AND ${snapshot.sql}
          AND EXISTS (
            SELECT 1 FROM paddock_ndvi AS saved
            WHERE saved.id = ? AND saved.organization_id = ? AND saved.field_id = ?
              AND saved.paddock_id = ? AND saved.month = ? AND saved.status = 'no_data'
              AND saved.computed_at = ? AND saved.geometry_snapshot_token = ?
          )
          AND EXISTS (
            SELECT 1 FROM audit_log AS audit
            WHERE audit.id = ? AND audit.organization_id = ? AND audit.field_id = ?
              AND audit.entity_id = ? AND audit.action = 'pasture.ndvi.no_data.stored'
          )
          THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
      `).bind(
        ...access, ...configuration.bindings, ...snapshot.bindings,
        row.id, actor.organizationId, input.fieldId, input.candidate.paddockId,
        month, computedAt, row.geometry_snapshot_token,
        auditId, actor.organizationId, input.fieldId, row.id,
      ),
    ]);
  } catch (cause) {
    if (cause instanceof Error && /integer overflow|constraint/i.test(cause.message)) {
      throw new PastureScopeError();
    }
    throw cause;
  }
  return toPastureNdviNoDataRecord(row, false);
}

export async function enqueuePastureNdviCollection(
  fieldId: string,
  actor: AccessContext,
  options: { now?: Date } = {},
): Promise<PastureNdviCollectionQueue> {
  const provider = await getPastureProviderDecision(fieldId, actor);
  if (provider.mode !== "configured" || provider.providerKey !== PASTURE_CDSE_PROVIDER_KEY) {
    throw new PastureDomainError(
      `Configura explícitamente el proveedor ${PASTURE_CDSE_PROVIDER_KEY} antes de programar la ingesta.`,
      "NDVI_PROVIDER_UNCONFIGURED",
    );
  }
  const calibration = await getActiveNdviCalibration(fieldId, PASTURE_CDSE_PROVIDER_KEY, actor);
  if (!calibration) {
    throw new PastureDomainError("No existe una calibración NDVI activa para este fundo.", "NDVI_CALIBRATION_REQUIRED");
  }
  const accessSql = currentPastureAccessSql(true);
  const access = accessBindings(actor, fieldId);
  const paddocks = await getDb().$client.prepare(`
    SELECT paddock.id
    FROM potreros AS paddock
    JOIN fields AS field ON field.id = paddock.field_id AND field.organization_id = ?
    WHERE paddock.field_id = ? AND paddock.deleted_at IS NULL AND paddock.archived_at IS NULL
      AND field.is_demo = 0 AND ${accessSql}
    ORDER BY paddock.id
    LIMIT 65
  `).bind(actor.organizationId, fieldId, ...access).all<{ id: string }>();
  if (paddocks.results.length === 0) {
    throw new PastureDomainError("No hay potreros reales disponibles para programar NDVI.", "PASTURE_NDVI_PADDOCKS_UNAVAILABLE");
  }
  if (paddocks.results.length > 64) {
    throw new PastureDomainError("El fundo supera el máximo de 64 potreros por programación NDVI.", "PASTURE_NDVI_PADDOCK_LIMIT");
  }
  const now = options.now ?? new Date();
  const dueAt = now.toISOString();
  const intervalSeconds = 24 * 60 * 60;
  const jobs = paddocks.results.map(({ id: paddockId }) => ({
    id: `pasture-ndvi:${actor.organizationId}:${fieldId}:${paddockId}`,
    payload: JSON.stringify({
      schemaVersion: "fundosmart.pasture.ndvi-collection-job.v1",
      membershipId: actor.membershipId,
      requestedBy: actor.email,
      paddockId,
    }),
  }));
  const jobIds = jobs.map(({ id }) => id);
  const jobIdsJson = JSON.stringify(jobIds);
  const jobsJson = JSON.stringify(jobs);
  const client = getDb().$client;
  const scheduleConfigurationSql = `${accessSql}
    AND EXISTS (SELECT 1 FROM fields WHERE id = ? AND organization_id = ? AND is_demo = 0)
    AND EXISTS (
      SELECT 1 FROM pasture_provider_decisions
      WHERE organization_id = ? AND field_id = ? AND mode = 'configured' AND provider_key = ?
    )
    AND EXISTS (
      SELECT 1 FROM pasture_ndvi_calibrations
      WHERE organization_id = ? AND field_id = ? AND provider_key = ? AND status = 'active'
    )`;
  const scheduleConfigurationBindings: D1Value[] = [
    ...access, fieldId, actor.organizationId,
    actor.organizationId, fieldId, PASTURE_CDSE_PROVIDER_KEY,
    actor.organizationId, fieldId, PASTURE_CDSE_PROVIDER_KEY,
  ];
  const auditId = crypto.randomUUID();
  const statements = [client.prepare(`
    SELECT CASE WHEN ${scheduleConfigurationSql}
      AND NOT EXISTS (
        SELECT 1 FROM scheduled_jobs AS leased_job
        WHERE leased_job.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND leased_job.organization_id = ? AND leased_job.field_id = ?
          AND leased_job.lease_expires_at > ?
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS lease_safe
  `).bind(
    ...scheduleConfigurationBindings,
    jobIdsJson, actor.organizationId, fieldId, dueAt,
  ), ...jobs.map((job) => client.prepare(`
      INSERT INTO scheduled_jobs (
        id, organization_id, field_id, type, payload, status, due_at, interval_seconds,
        lease_owner, lease_expires_at, attempt_count, last_error_type, updated_at
      )
      SELECT ?, ?, ?, 'pasture.ndvi.collect.v1', ?, 'active', ?, ?, NULL, NULL, 0, NULL, ?
      WHERE ${scheduleConfigurationSql}
      ON CONFLICT(id) DO UPDATE SET
        payload = excluded.payload, status = 'active', due_at = excluded.due_at,
        interval_seconds = excluded.interval_seconds, lease_owner = NULL, lease_expires_at = NULL,
        attempt_count = 0, last_error_type = NULL, updated_at = excluded.updated_at
      WHERE scheduled_jobs.lease_expires_at IS NULL
        OR scheduled_jobs.lease_expires_at <= excluded.updated_at
    `).bind(
      job.id, actor.organizationId, fieldId, job.payload, dueAt, intervalSeconds, dueAt,
      ...scheduleConfigurationBindings,
    )), client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at
    )
    SELECT ?, ?, ?, ?, 'pasture.ndvi.collection.enqueued', 'scheduled_job', ?, ?, ?
    WHERE ${scheduleConfigurationSql}
      AND (SELECT COUNT(*) FROM scheduled_jobs AS job
        WHERE job.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND job.organization_id = ? AND job.field_id = ? AND job.updated_at = ?) = ?
  `).bind(
    auditId, actor.organizationId, fieldId, actor.email, jobIds[0],
    JSON.stringify({ providerKey: PASTURE_CDSE_PROVIDER_KEY, paddockCount: jobIds.length, jobIds }), dueAt,
    ...scheduleConfigurationBindings, jobIdsJson, actor.organizationId, fieldId, dueAt, jobIds.length,
  ), client.prepare(`
    SELECT CASE WHEN ${scheduleConfigurationSql}
      AND (
        SELECT COUNT(*)
        FROM json_each(?) AS expected_job
        JOIN scheduled_jobs AS queued_job
          ON queued_job.id = json_extract(expected_job.value, '$.id')
        WHERE queued_job.organization_id = ? AND queued_job.field_id = ?
          AND queued_job.type = 'pasture.ndvi.collect.v1'
          AND queued_job.payload = json_extract(expected_job.value, '$.payload')
          AND queued_job.status = 'active' AND queued_job.due_at = ?
          AND queued_job.interval_seconds = ? AND queued_job.lease_owner IS NULL
          AND queued_job.lease_expires_at IS NULL AND queued_job.attempt_count = 0
          AND queued_job.last_error_type IS NULL AND queued_job.updated_at = ?
      ) = ?
      AND EXISTS (
        SELECT 1 FROM audit_log AS audit
        WHERE audit.id = ? AND audit.organization_id = ? AND audit.field_id = ?
          AND audit.action = 'pasture.ndvi.collection.enqueued'
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    ...scheduleConfigurationBindings,
    jobsJson, actor.organizationId, fieldId, dueAt, intervalSeconds, dueAt, jobs.length,
    auditId, actor.organizationId, fieldId,
  )];
  try {
    const results = await client.batch(statements);
    const writeResults = results.slice(1, -1);
    if (writeResults.some((result) => result.meta.changes !== 1)) throw new PastureScopeError();
  } catch (cause) {
    if (!(cause instanceof Error) || !/integer overflow/i.test(cause.message)) throw cause;
    const activeLease = await client.prepare(`
      SELECT leased_job.id
      FROM scheduled_jobs AS leased_job
      WHERE ${scheduleConfigurationSql}
        AND leased_job.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        AND leased_job.organization_id = ? AND leased_job.field_id = ?
        AND leased_job.lease_expires_at > ?
      LIMIT 1
    `).bind(
      ...scheduleConfigurationBindings,
      jobIdsJson, actor.organizationId, fieldId, dueAt,
    ).first<{ id: string }>();
    if (activeLease) {
      throw new PastureDomainError(
        "La recolección NDVI ya está siendo procesada. Espera a que termine antes de reintentar.",
        "PASTURE_NDVI_COLLECTION_IN_PROGRESS",
      );
    }
    throw new PastureScopeError();
  }
  return { fieldId, providerKey: PASTURE_CDSE_PROVIDER_KEY, dueAt, jobIds };
}

export async function createPastureRotationPlan(
  input: CreatePastureRotationPlanRequest,
  actor: AccessContext,
): Promise<StoredPastureRotationPlan> {
  const operationId = normalizeOperationId(input.operationId);
  if (!Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 90) {
    throw new PastureDomainError("El horizonte debe ser un número entero entre 1 y 90 días.", "PASTURE_HORIZON_INVALID");
  }
  const dashboard = await getPastureDashboard(input.fieldId, actor);
  const basis = dashboard.planningBasis;
  if (basis.status !== "available" || !basis.herdId || !basis.dailyDemandKgDm || !basis.weightedAverageLiveWeightKg) {
    throw new PastureDomainError(
      basis.statusReason ?? "No hay datos ganaderos suficientes para derivar la demanda.",
      "PASTURE_DEMAND_UNAVAILABLE",
    );
  }
  const measuredPaddocks = dashboard.paddocks
    .filter((paddock) => paddock.latestEstimate)
    .map((paddock) => ({
      id: paddock.id,
      name: paddock.name,
      areaHectares: paddock.areaHectares,
      currentKgDmPerHectare: paddock.latestEstimate?.kgDmPerHectare ?? 0,
      residualKgDmPerHectare: 1_500,
      utilizationPercent: 80,
    }));
  if (measuredPaddocks.length === 0) {
    throw new PastureDomainError("Registra biomasa almacenada antes de crear un plan.", "PASTURE_SUPPLY_UNAVAILABLE");
  }
  const planInput = {
    startDate: input.startDate,
    horizonDays: input.horizonDays,
    maxPaddockDays: 5,
    restDays: basis.rotationContext.settings?.longRestDays ?? 0,
    lots: basis.lots.filter((lot) => lot.animalCount > 0).map((lot) => ({
      id: lot.id,
      name: lot.name,
      animalCount: lot.animalCount,
      averageLiveWeightKg: lot.averageLiveWeightKg!,
      intakePercentLiveWeight: basis.intakePercentLiveWeight,
    })),
    paddocks: measuredPaddocks.map((paddock) => ({
      ...paddock,
      cells: basis.rotationContext.activeCellIdsByPaddock[paddock.id] ?? [],
    })),
    entryTargetKgDmPerHectare: 2_600,
    residualTargetKgDmPerHectare: 1_500,
  };
  const calculatedPlan = planLotRotations(planInput);
  const plan = {
    ...calculatedPlan,
    planningEvidence: {
      schemaVersion: "fundosmart.pasture.planning-evidence.v1",
      basis,
      authoritativeSources: [
        "livestock_lots",
        "livestock_animals",
        "livestock_weighings",
        "livestock_feeding_plans",
        "livestock_feed_inventory",
        "pasture_biomass_estimates",
        "analytics_herd_metrics",
        "paddock_rotation_settings",
        "paddock_cells",
      ],
      agronomicAssumptions: {
        residualKgDmPerHectare: 1_500,
        utilizationPercent: 80,
        entryTargetKgDmPerHectare: 2_600,
        maxPaddockDays: 5,
      },
    },
  };
  const requestJson = stableStringify({
    schemaVersion: "fundosmart.pasture.rotation-request.v3",
    request: { operationId, fieldId: input.fieldId, startDate: input.startDate, horizonDays: input.horizonDays },
    authoritativeInput: planInput,
    planningBasis: basis,
  });
  const requestHash = await sha256Hex(new TextEncoder().encode(requestJson));
  const existing = await findPlanReplay(actor, input.fieldId, operationId);
  if (existing) {
    if (existing.request_hash !== requestHash) throw new PastureDomainError("El identificador de operación ya fue usado con otro plan.", "PASTURE_IDEMPOTENCY_CONFLICT");
    return toRotationPlan(existing);
  }
  const id = `pasture-plan-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const planJson = stableStringify(plan);
  const paddockIdsJson = JSON.stringify(measuredPaddocks.map((paddock) => paddock.id));
  const accessSql = currentPastureAccessSql(true);
  const access = accessBindings(actor, input.fieldId);
  const [insert, audit] = await getDb().$client.batch([
    getDb().$client.prepare(`
      INSERT INTO pasture_rotation_plans (
        id, organization_id, field_id, operation_id, request_hash, herd_id,
        status, input_snapshot_json, plan_json, created_by, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${accessSql}
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) AS requested
          LEFT JOIN potreros AS paddock
            ON paddock.id = requested.value AND paddock.field_id = ?
           AND paddock.deleted_at IS NULL AND paddock.archived_at IS NULL
          WHERE paddock.id IS NULL
        )
        AND NOT EXISTS (
          SELECT 1 FROM pasture_rotation_plans
          WHERE organization_id = ? AND field_id = ? AND operation_id = ?
        )
        AND NOT EXISTS (
          SELECT 1
          FROM pasture_rotation_plans AS existing_plan
          JOIN json_each(existing_plan.plan_json, '$.visits') AS existing_visit
          JOIN json_each(?, '$.visits') AS requested_visit
          WHERE existing_plan.organization_id = ? AND existing_plan.field_id = ?
            AND (
              (
                (
                  existing_plan.herd_id = ?
                  OR COALESCE(
                    json_extract(existing_visit.value, '$.lotId'),
                    json_extract(existing_visit.value, '$.herdId')
                  ) = COALESCE(
                    json_extract(requested_visit.value, '$.lotId'),
                    json_extract(requested_visit.value, '$.herdId')
                  )
                )
                AND json_extract(existing_visit.value, '$.startsOn') < json_extract(requested_visit.value, '$.endsOn')
                AND json_extract(requested_visit.value, '$.startsOn') < json_extract(existing_visit.value, '$.endsOn')
              )
              OR (
                json_extract(existing_visit.value, '$.paddockId') = json_extract(requested_visit.value, '$.paddockId')
                AND json_extract(existing_visit.value, '$.startsOn') < COALESCE(
                  json_extract(requested_visit.value, '$.restUntil'),
                  json_extract(requested_visit.value, '$.endsOn')
                )
                AND json_extract(requested_visit.value, '$.startsOn') < COALESCE(
                  json_extract(existing_visit.value, '$.restUntil'),
                  json_extract(existing_visit.value, '$.endsOn')
                )
              )
            )
        )
    `).bind(
      id, actor.organizationId, input.fieldId, operationId, requestHash, basis.herdId,
      calculatedPlan.feasible ? "feasible" : "infeasible", requestJson, planJson, actor.email, now,
      ...access, paddockIdsJson, input.fieldId, actor.organizationId, input.fieldId, operationId,
      planJson, actor.organizationId, input.fieldId, basis.herdId,
    ),
    getDb().$client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at
      )
      SELECT ?, ?, ?, ?, 'pasture.rotation.created', 'pasture_rotation_plan', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM pasture_rotation_plans
        WHERE id = ? AND organization_id = ? AND field_id = ? AND request_hash = ?
      ) AND ${accessSql}
    `).bind(
      crypto.randomUUID(), actor.organizationId, input.fieldId, actor.email, id,
      JSON.stringify({
        feasible: calculatedPlan.feasible,
        coveredDays: calculatedPlan.coveredDays,
        shortageDays: calculatedPlan.shortageDays,
        animalCount: basis.animalCount,
        lotCount: basis.lots.filter((lot) => lot.animalCount > 0).length,
        dailyDemandKgDm: basis.dailyDemandKgDm,
      }), now,
      id, actor.organizationId, input.fieldId, requestHash, ...access,
    ),
  ]);
  if (insert.meta.changes !== 1 || audit.meta.changes !== 1) {
    const replay = await findPlanReplay(actor, input.fieldId, operationId);
    if (replay?.request_hash === requestHash) return toRotationPlan(replay);
    if (await hasPersistedPlanOverlap(actor, input.fieldId, basis.herdId, planJson)) {
      throw new PastureDomainError(
        "El plan se solapa con otra rotación persistida del mismo rebaño o potrero.",
        "PASTURE_ROTATION_OVERLAP",
      );
    }
    throw new PastureScopeError();
  }
  return { id, operationId, fieldId: input.fieldId, feasible: Boolean(calculatedPlan.feasible), plan, createdAt: now };
}

async function persistRawObservation(input: {
  actor: AccessContext;
  operationId: string;
  observationId: string;
  fieldId: string;
  paddockId: string;
  sourceKind: "manual" | "ndvi";
  providerKey: string | null;
  capturedAt: string;
  rawDocument: unknown;
  estimate: { method: string; kgDmPerHectare: number; calibrationId: string | null; evidence: unknown };
}): Promise<PastureObservationResult> {
  const rawJson = stableStringify(input.rawDocument);
  const bytes = new TextEncoder().encode(rawJson);
  if (bytes.byteLength > 2_000_000) throw new PastureDomainError("La evidencia cruda supera el límite de 2 MB.", "PASTURE_RAW_TOO_LARGE");
  const sha256 = await sha256Hex(bytes);
  const requestHash = await sha256Hex(new TextEncoder().encode(stableStringify({
    operationId: input.operationId,
    fieldId: input.fieldId,
    paddockId: input.paddockId,
    sourceKind: input.sourceKind,
    providerKey: input.providerKey,
    capturedAt: input.capturedAt,
    rawSha256: sha256,
    estimate: input.estimate,
  })));
  const replay = await findObservationReplay(input.actor, input.fieldId, input.operationId);
  if (replay?.request_hash !== undefined && replay.request_hash !== requestHash) {
    throw new PastureDomainError("El identificador de operación ya fue usado con otra muestra.", "PASTURE_IDEMPOTENCY_CONFLICT");
  }
  if (replay?.storage_status === "stored") return storedObservationReplay(replay);
  if (replay && (replay.storage_status !== "pending" || replay.id !== input.observationId)) {
    throw new PastureDomainError("La muestra anterior todavía está pendiente de conciliación.", "PASTURE_RAW_PENDING");
  }
  const objectKey = replay?.object_key ?? buildPastureRawObjectKey({
    organizationId: input.actor.organizationId,
    fieldId: input.fieldId,
    observationId: input.observationId,
  });
  const now = new Date().toISOString();
  const accessSql = currentPastureAccessSql(true);
  const access = accessBindings(input.actor, input.fieldId);
  const currentConfiguration = currentObservationConfiguration(input);
  if (!replay) {
    const insert = await getDb().$client.prepare(`
    INSERT INTO pasture_raw_observations (
      id, organization_id, field_id, paddock_id, operation_id, request_hash,
      source_kind, provider_key, captured_at, object_key, content_type, size_bytes,
      sha256, etag, storage_status, created_by, stored_at, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'application/json', ?, ?, NULL, 'pending', ?, NULL, ?
    WHERE ${accessSql}
      AND EXISTS (
        SELECT 1 FROM potreros AS paddock
        JOIN fields AS field ON field.id = paddock.field_id AND field.organization_id = ?
        WHERE paddock.id = ? AND paddock.field_id = ?
          AND paddock.deleted_at IS NULL AND paddock.archived_at IS NULL
      )
      AND ${currentConfiguration.sql}
      AND NOT EXISTS (
        SELECT 1 FROM pasture_raw_observations
        WHERE organization_id = ? AND field_id = ? AND operation_id = ?
      )
  `).bind(
    input.observationId, input.actor.organizationId, input.fieldId, input.paddockId,
    input.operationId, requestHash, input.sourceKind, input.providerKey, input.capturedAt,
    objectKey, bytes.byteLength, sha256, input.actor.email, now,
    ...access, input.actor.organizationId, input.paddockId, input.fieldId,
    ...currentConfiguration.bindings,
    input.actor.organizationId, input.fieldId, input.operationId,
    ).run();
    if (insert.meta.changes !== 1) {
      const concurrent = await findObservationReplay(input.actor, input.fieldId, input.operationId);
      if (concurrent?.request_hash === requestHash && concurrent.storage_status === "stored") return storedObservationReplay(concurrent);
      if (!concurrent || concurrent.request_hash !== requestHash || concurrent.id !== input.observationId) throw new PastureScopeError();
    }
  }

  const stored = await env.FILES.put(objectKey, bytes, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      organizationId: input.actor.organizationId,
      fieldId: input.fieldId,
      observationId: input.observationId,
      sha256,
      sourceKind: input.sourceKind,
    },
    sha256,
  });
  const object = stored ?? await env.FILES.head(objectKey);
  if (!object || object.size !== bytes.byteLength || object.customMetadata?.sha256 !== sha256) {
    throw new PastureDomainError("No fue posible verificar la evidencia cruda en almacenamiento.", "PASTURE_RAW_STORAGE_FAILED");
  }
  const storedAt = new Date().toISOString();
  const estimateId = `pasture-estimate-${crypto.randomUUID()}`;
  let finalization: D1Result<unknown>[];
  try {
    finalization = await getDb().$client.batch([
      getDb().$client.prepare(`
      INSERT INTO pasture_biomass_estimates (
        id, organization_id, field_id, paddock_id, raw_observation_id,
        method, kg_dm_per_hectare, calibration_id, evidence_json, computed_at, created_by
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM pasture_raw_observations
        WHERE id = ? AND organization_id = ? AND field_id = ? AND paddock_id = ?
          AND request_hash = ? AND sha256 = ? AND storage_status = 'pending'
      ) AND ${currentConfiguration.sql} AND ${accessSql}
    `).bind(
      estimateId, input.actor.organizationId, input.fieldId, input.paddockId, input.observationId,
      input.estimate.method, input.estimate.kgDmPerHectare, input.estimate.calibrationId,
      stableStringify(input.estimate.evidence), storedAt, input.actor.email,
      input.observationId, input.actor.organizationId, input.fieldId, input.paddockId, requestHash, sha256,
      ...currentConfiguration.bindings, ...access,
      ),
      getDb().$client.prepare(`
      UPDATE pasture_raw_observations
      SET etag = ?, storage_status = 'stored', stored_at = ?
      WHERE id = ? AND organization_id = ? AND field_id = ? AND paddock_id = ?
        AND request_hash = ? AND sha256 = ? AND storage_status = 'pending'
        AND EXISTS (SELECT 1 FROM pasture_biomass_estimates WHERE id = ? AND raw_observation_id = ?)
        AND ${currentConfiguration.sql} AND ${accessSql}
    `).bind(
      object.httpEtag, storedAt, input.observationId, input.actor.organizationId, input.fieldId,
      input.paddockId, requestHash, sha256, estimateId, input.observationId,
      ...currentConfiguration.bindings, ...access,
      ),
      getDb().$client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at
      )
      SELECT ?, ?, ?, ?, 'pasture.observation.stored', 'pasture_raw_observation', ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM pasture_raw_observations
        WHERE id = ? AND organization_id = ? AND field_id = ?
          AND request_hash = ? AND storage_status = 'stored'
      ) AND ${currentConfiguration.sql} AND ${accessSql}
    `).bind(
      crypto.randomUUID(), input.actor.organizationId, input.fieldId, input.actor.email, input.observationId,
      JSON.stringify({ sourceKind: input.sourceKind, paddockId: input.paddockId, sha256, kgDmPerHectare: input.estimate.kgDmPerHectare }),
      storedAt, input.observationId, input.actor.organizationId, input.fieldId, requestHash,
      ...currentConfiguration.bindings, ...access,
      ),
    ]);
  } catch (cause) {
    const concurrent = await findObservationReplay(input.actor, input.fieldId, input.operationId);
    if (concurrent?.request_hash === requestHash && concurrent.storage_status === "stored") return storedObservationReplay(concurrent);
    await discardPendingObservation(input, objectKey, requestHash);
    throw cause;
  }
  const [estimateInsert, rawUpdate, audit] = finalization;
  if (estimateInsert.meta.changes !== 1 || rawUpdate.meta.changes !== 1 || audit.meta.changes !== 1) {
    const concurrent = await findObservationReplay(input.actor, input.fieldId, input.operationId);
    if (concurrent?.request_hash === requestHash && concurrent.storage_status === "stored") return storedObservationReplay(concurrent);
    await discardPendingObservation(input, objectKey, requestHash);
    throw new PastureScopeError();
  }
  return {
    id: input.observationId,
    fieldId: input.fieldId,
    paddockId: input.paddockId,
    sourceKind: input.sourceKind,
    objectKey,
    sha256,
    kgDmPerHectare: input.estimate.kgDmPerHectare,
    capturedAt: input.capturedAt,
    storedAt,
    idempotentReplay: false,
  };
}

function currentObservationConfiguration(input: {
  actor: AccessContext;
  fieldId: string;
  sourceKind: "manual" | "ndvi";
  providerKey: string | null;
  estimate: { calibrationId: string | null };
}): { sql: string; bindings: D1Value[] } {
  return {
    sql: `(
      ? = 'manual'
      OR EXISTS (
        SELECT 1
        FROM pasture_provider_decisions AS current_provider
        JOIN pasture_ndvi_calibrations AS current_calibration
          ON current_calibration.organization_id = current_provider.organization_id
         AND current_calibration.field_id = current_provider.field_id
         AND current_calibration.provider_key = current_provider.provider_key
         AND current_calibration.id = ?
         AND current_calibration.status = 'active'
        WHERE current_provider.organization_id = ? AND current_provider.field_id = ?
          AND current_provider.mode = 'configured' AND current_provider.provider_key = ?
      )
    )`,
    bindings: [
      input.sourceKind,
      input.estimate.calibrationId,
      input.actor.organizationId,
      input.fieldId,
      input.providerKey,
    ],
  };
}

function currentPaddockSnapshot(
  candidate: PaddockNdviCandidate,
  organizationId: string,
  fieldId: string,
): { sql: string; bindings: D1Value[] } {
  const snapshot: PaddockNdviPaddockSnapshot = candidate.snapshot;
  return {
    sql: `EXISTS (
      SELECT 1
      FROM potreros AS current_paddock
      JOIN fields AS current_field ON current_field.id = current_paddock.field_id
      WHERE current_paddock.id = ? AND current_paddock.field_id = ?
        AND current_field.organization_id = ? AND current_field.id = ?
        AND current_paddock.name = ? AND current_paddock.sector = ?
        AND current_paddock.area_hectares = ?
        AND json(current_paddock.coordinates) = json(?)
        AND current_paddock.grazeable_area_hectares IS ?
        AND current_paddock.land_use = ?
        AND json(current_paddock.hole_kinds) = json(?)
        AND current_paddock.soil_ph IS ? AND current_paddock.soil_nitrogen IS ?
        AND current_paddock.soil_phosphorus IS ? AND current_paddock.soil_potassium IS ?
        AND current_paddock.last_activity = ? AND current_paddock.status = ?
        AND current_paddock.created_at = ? AND current_paddock.updated_at = ?
        AND current_paddock.deleted_at IS ? AND current_paddock.archived_at IS ?
        AND current_paddock.archive_reason IS ?
        AND current_paddock.created_by_operation_id IS ?
        AND current_paddock.archived_by_operation_id IS ?
        AND current_paddock.deleted_at IS NULL AND current_paddock.archived_at IS NULL
    )`,
    bindings: [
      snapshot.id, fieldId, organizationId, fieldId,
      snapshot.name, snapshot.sector, snapshot.areaHectares,
      JSON.stringify(snapshot.coordinates), snapshot.grazeableAreaHectares,
      snapshot.landUse, JSON.stringify(snapshot.holeKinds), snapshot.soilPh,
      snapshot.soilNitrogen, snapshot.soilPhosphorus, snapshot.soilPotassium,
      snapshot.lastActivity, snapshot.status, snapshot.createdAt, snapshot.updatedAt,
      snapshot.deletedAt, snapshot.archivedAt, snapshot.archiveReason,
      snapshot.createdByOperationId, snapshot.archivedByOperationId,
    ],
  };
}

function monthlyIntervalStart(interval: { from: string; to: string }): string {
  const from = Date.parse(interval.from);
  const to = Date.parse(interval.to);
  const month = interval.from.slice(0, 10);
  if (
    !Number.isFinite(from)
    || !Number.isFinite(to)
    || from >= to
    || !/^\d{4}-(?:0[1-9]|1[0-2])-01$/u.test(month)
  ) {
    throw new PastureDomainError("El intervalo mensual NDVI no es válido.", "PASTURE_NDVI_INTERVAL_MISMATCH");
  }
  return month;
}

function toPastureNdviNoDataRecord(
  row: NdviNoDataRow,
  idempotentReplay: boolean,
): PastureNdviNoDataRecord {
  return {
    id: row.id,
    fieldId: row.field_id,
    paddockId: row.paddock_id,
    month: row.month,
    reason: row.no_data_reason,
    observedAt: row.observed_at,
    sampleCount: row.sample_count,
    noDataCount: row.no_data_count,
    computedAt: row.computed_at,
    geometrySnapshotToken: row.geometry_snapshot_token,
    idempotentReplay,
  };
}

async function discardPendingObservation(
  input: { actor: AccessContext; fieldId: string; observationId: string },
  objectKey: string,
  requestHash: string,
): Promise<void> {
  const client = getDb().$client;
  const cleanupId = `pasture:observation:cleanup:${input.observationId}:${requestHash}`;
  const now = new Date().toISOString();
  const cleanupPayload = JSON.stringify({ objectKey, requestHash, state: "cleanup_reserved" });
  try {
    await client.batch([
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at
        )
        SELECT ?, raw.organization_id, raw.field_id, ?, 'pasture.observation.cleanup_reserved',
          'pasture_raw_observation', raw.id, ?, ?
        FROM pasture_raw_observations AS raw
        WHERE raw.id = ? AND raw.organization_id = ? AND raw.field_id = ?
          AND raw.request_hash = ? AND raw.storage_status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM pasture_biomass_estimates
            WHERE raw_observation_id = raw.id
          )
        ON CONFLICT(id) DO NOTHING
      `).bind(
        cleanupId, input.actor.email, cleanupPayload, now, input.observationId,
        input.actor.organizationId, input.fieldId, requestHash,
      ),
      client.prepare(`
        DELETE FROM pasture_raw_observations
        WHERE id = ? AND organization_id = ? AND field_id = ?
          AND request_hash = ? AND storage_status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM pasture_biomass_estimates
            WHERE raw_observation_id = pasture_raw_observations.id
          )
          AND EXISTS (
            SELECT 1 FROM audit_log
            WHERE id = ? AND organization_id = ? AND field_id = ?
              AND action = 'pasture.observation.cleanup_reserved'
              AND entity_id = pasture_raw_observations.id
          )
      `).bind(
        input.observationId, input.actor.organizationId, input.fieldId, requestHash,
        cleanupId, input.actor.organizationId, input.fieldId,
      ),
    ]);
  } catch {
    // A failed D1 reservation cannot authorize deleting shared immutable evidence.
    return;
  }
  const reservedAndDetached = await client.prepare(`
    SELECT 1 AS safeToDelete
    FROM audit_log
    WHERE id = ? AND organization_id = ? AND field_id = ?
      AND action = 'pasture.observation.cleanup_reserved'
      AND entity_id = ? AND after = ?
      AND NOT EXISTS (
        SELECT 1 FROM pasture_raw_observations
        WHERE id = ? AND organization_id = ? AND field_id = ? AND request_hash = ?
      )
  `).bind(
    cleanupId, input.actor.organizationId, input.fieldId, input.observationId, cleanupPayload,
    input.observationId, input.actor.organizationId, input.fieldId, requestHash,
  ).first<{ safeToDelete: number }>();
  if (!reservedAndDetached) return;
  try {
    await env.FILES.delete(objectKey);
  } catch {
    // The cleanup audit remains as a durable catalog for a later retry.
  }
}

async function findObservationReplay(actor: AccessContext, fieldId: string, operationId: string): Promise<ReplayRow | null> {
  return getDb().$client.prepare(`
    SELECT raw.id, raw.field_id, raw.paddock_id, raw.source_kind, raw.object_key,
      raw.sha256, raw.request_hash, raw.storage_status, raw.captured_at, raw.stored_at,
      estimate.kg_dm_per_hectare
    FROM pasture_raw_observations AS raw
    LEFT JOIN pasture_biomass_estimates AS estimate ON estimate.raw_observation_id = raw.id
    WHERE raw.organization_id = ? AND raw.field_id = ? AND raw.operation_id = ?
      AND ${currentPastureAccessSql(true)}
    ORDER BY estimate.computed_at DESC LIMIT 1
  `).bind(actor.organizationId, fieldId, operationId, ...accessBindings(actor, fieldId)).first<ReplayRow>();
}

function storedObservationReplay(row: ReplayRow): PastureObservationResult {
  if (row.storage_status !== "stored" || !row.stored_at || row.kg_dm_per_hectare === null) {
    throw new PastureDomainError("La muestra anterior todavía está pendiente de conciliación.", "PASTURE_RAW_PENDING");
  }
  return {
    id: row.id,
    fieldId: row.field_id,
    paddockId: row.paddock_id,
    sourceKind: row.source_kind === "ndvi" ? "ndvi" : "manual",
    objectKey: row.object_key,
    sha256: row.sha256,
    kgDmPerHectare: row.kg_dm_per_hectare,
    capturedAt: row.captured_at,
    storedAt: row.stored_at,
    idempotentReplay: true,
  };
}

async function findPlanReplay(actor: AccessContext, fieldId: string, operationId: string): Promise<(PlanRow & { request_hash: string }) | null> {
  return getDb().$client.prepare(`
    SELECT id, operation_id, field_id, status, plan_json, created_at, request_hash
    FROM pasture_rotation_plans
    WHERE organization_id = ? AND field_id = ? AND operation_id = ?
      AND ${currentPastureAccessSql(true)}
    LIMIT 1
  `).bind(actor.organizationId, fieldId, operationId, ...accessBindings(actor, fieldId)).first<PlanRow & { request_hash: string }>();
}

async function hasPersistedPlanOverlap(
  actor: AccessContext,
  fieldId: string,
  herdId: string,
  requestedPlanJson: string,
): Promise<boolean> {
  const row = await getDb().$client.prepare(`
    SELECT 1 AS collision
    FROM pasture_rotation_plans AS existing_plan
    JOIN json_each(existing_plan.plan_json, '$.visits') AS existing_visit
    JOIN json_each(?, '$.visits') AS requested_visit
    WHERE existing_plan.organization_id = ? AND existing_plan.field_id = ?
      AND (
        (
          (
            existing_plan.herd_id = ?
            OR COALESCE(
              json_extract(existing_visit.value, '$.lotId'),
              json_extract(existing_visit.value, '$.herdId')
            ) = COALESCE(
              json_extract(requested_visit.value, '$.lotId'),
              json_extract(requested_visit.value, '$.herdId')
            )
          )
          AND json_extract(existing_visit.value, '$.startsOn') < json_extract(requested_visit.value, '$.endsOn')
          AND json_extract(requested_visit.value, '$.startsOn') < json_extract(existing_visit.value, '$.endsOn')
        )
        OR (
          json_extract(existing_visit.value, '$.paddockId') = json_extract(requested_visit.value, '$.paddockId')
          AND json_extract(existing_visit.value, '$.startsOn') < COALESCE(
            json_extract(requested_visit.value, '$.restUntil'),
            json_extract(requested_visit.value, '$.endsOn')
          )
          AND json_extract(requested_visit.value, '$.startsOn') < COALESCE(
            json_extract(existing_visit.value, '$.restUntil'),
            json_extract(existing_visit.value, '$.endsOn')
          )
        )
      )
      AND ${currentPastureAccessSql(true)}
    LIMIT 1
  `).bind(
    requestedPlanJson,
    actor.organizationId,
    fieldId,
    herdId,
    ...accessBindings(actor, fieldId),
  ).first<{ collision: number }>();
  return row?.collision === 1;
}

async function buildPlanningBasis(input: {
  fieldId: string;
  lots: PlanningLotRow[];
  paddocks: PasturePaddockSnapshot[];
  settings: RotationSettingsRow | null;
  activeCells: ActiveCellRow[];
  metrics: AnalyticsMetricRow[];
}): Promise<PasturePlanningBasis> {
  const intakePercentLiveWeight = 3;
  const lots: PasturePlanningLotBasis[] = input.lots.map((row) => {
    const animalCountSource = row.tracking_mode === "individual" ? "individual_active_animals" : "lot_summary";
    const animalCount = Math.max(0, Math.trunc(animalCountSource === "individual_active_animals"
      ? Number(row.active_animal_count)
      : Number(row.planned_animal_count)));
    const hasMeasuredWeight = Number(row.weight_sample_count) > 0
      && Number.isFinite(Number(row.measured_average_weight_kg))
      && Number(row.measured_average_weight_kg) > 0;
    const hasLotWeight = Number.isFinite(Number(row.lot_average_weight_kg)) && Number(row.lot_average_weight_kg) > 0;
    const averageLiveWeightKg = hasMeasuredWeight
      ? roundNumber(Number(row.measured_average_weight_kg), 2)
      : hasLotWeight ? roundNumber(Number(row.lot_average_weight_kg), 2) : null;
    const averageLiveWeightSource = hasMeasuredWeight
      ? "latest_individual_weighings"
      : hasLotWeight ? "lot_average" : "unavailable";
    const rationKgPerAnimalDay = Number(row.ration_kg_per_animal_day);
    const hasRation = Boolean(row.ration_product_name?.trim())
      && Number.isFinite(rationKgPerAnimalDay)
      && rationKgPerAnimalDay > 0;
    const rationUnitCost = Number(row.ration_unit_cost_clp);
    const hasRationCost = row.ration_unit_cost_clp !== null && Number.isFinite(rationUnitCost) && rationUnitCost >= 0;
    const dailyQuantityKgAsFed = hasRation ? roundNumber(animalCount * rationKgPerAnimalDay, 2) : 0;
    return {
      id: row.id,
      name: row.name,
      animalCount,
      animalCountSource,
      averageLiveWeightKg,
      averageLiveWeightSource,
      weightSampleCount: Math.max(0, Math.trunc(Number(row.weight_sample_count) || 0)),
      dailyGrossDemandKgDm: animalCount > 0 && averageLiveWeightKg !== null
        ? roundNumber(animalCount * averageLiveWeightKg * (intakePercentLiveWeight / 100), 2)
        : null,
      ration: hasRation ? {
        productName: row.ration_product_name!.trim(),
        kgPerAnimalDayAsFed: roundNumber(rationKgPerAnimalDay, 3),
        dailyQuantityKgAsFed,
        unitCostClpPerKg: hasRationCost ? roundNumber(rationUnitCost, 2) : null,
        projectedDailyCostClp: hasRationCost ? Math.round(dailyQuantityKgAsFed * rationUnitCost) : null,
      } : null,
    };
  });
  const activeLots = lots.filter((lot) => lot.animalCount > 0);
  const animalCount = activeLots.reduce((sum, lot) => sum + lot.animalCount, 0);
  const missingWeight = activeLots.some((lot) => lot.averageLiveWeightKg === null);
  const dailyDemandKgDm = animalCount > 0 && !missingWeight
    ? roundNumber(activeLots.reduce((sum, lot) => sum + (lot.dailyGrossDemandKgDm ?? 0), 0), 2)
    : null;
  const weightedAverageLiveWeightKg = dailyDemandKgDm === null
    ? null
    : roundNumber(activeLots.reduce((sum, lot) => sum + ((lot.averageLiveWeightKg ?? 0) * lot.animalCount), 0) / animalCount, 2);
  const statusReason = animalCount === 0
    ? "No hay animales activos en los lotes del fundo."
    : missingWeight ? "Falta peso vivo en uno o más lotes activos; la demanda no se inventa." : null;
  const status = statusReason ? "unavailable" : "available";
  const paddockBudgets = input.paddocks.map((paddock) => {
    const current = paddock.latestEstimate?.kgDmPerHectare;
    const hasCurrent = current !== undefined && Number.isFinite(current);
    const availableKgDm = hasCurrent
      ? roundNumber(Math.max(0, current - 1_500) * paddock.areaHectares * 0.8, 2)
      : null;
    return {
      paddockId: paddock.id,
      paddockName: paddock.name,
      currentKgDmPerHectare: hasCurrent ? current : null,
      availableKgDm,
      herdDailyDemandKgDm: dailyDemandKgDm,
      availableDays: availableKgDm !== null && dailyDemandKgDm
        ? roundNumber(availableKgDm / dailyDemandKgDm, 2)
        : null,
    };
  });
  const totalSupplyKgDm = roundNumber(paddockBudgets.reduce((sum, paddock) => sum + (paddock.availableKgDm ?? 0), 0), 2);
  const rations = activeLots.flatMap((lot) => lot.ration ? [lot.ration] : []);
  const dailyQuantityKgAsFed = roundNumber(rations.reduce((sum, ration) => sum + ration.dailyQuantityKgAsFed, 0), 2);
  const missingRationCost = rations.some((ration) => ration.projectedDailyCostClp === null);
  const supplementStatus = rations.length === 0 ? "unavailable" : missingRationCost ? "partial" : "available";
  const projectedDailyCostClp = rations.length > 0 && !missingRationCost
    ? rations.reduce((sum, ration) => sum + (ration.projectedDailyCostClp ?? 0), 0)
    : null;
  const metric = (key: string) => input.metrics.find((row) => row.metric_key === key) ?? null;
  const metricValue = (key: string): number | null => {
    const row = metric(key);
    return row && (row.status === "available" || row.status === "partial")
      && row.value !== null && Number.isFinite(Number(row.value)) ? Number(row.value) : null;
  };
  const feedCostClp = metricValue("finance.feed_cost_clp");
  const iofcClp = metricValue("finance.iofc_clp");
  const costPerLiterClp = metricValue("finance.cost_per_liter_clp");
  const latestMetric = input.metrics[0] ?? null;
  const economicsStatus = feedCostClp !== null && iofcClp !== null
    ? "available"
    : feedCostClp !== null || iofcClp !== null || costPerLiterClp !== null ? "partial" : "unavailable";
  const activeCellIdsByPaddock: Record<string, Array<{ id: string; name: string }>> = {};
  for (const row of input.activeCells) {
    (activeCellIdsByPaddock[row.paddock_id] ??= []).push({ id: row.cell_id, name: row.cell_name });
  }
  const activeCellsByPaddock = Object.fromEntries(Object.entries(activeCellIdsByPaddock).map(([paddockId, cells]) => [
    paddockId,
    cells.length,
  ]));
  const herdSource = lots.map((lot) => `${lot.id}:${lot.animalCount}`).sort().join("|");
  const herdId = animalCount > 0
    ? `pasture-herd-${(await sha256Hex(new TextEncoder().encode(`${input.fieldId}|${herdSource}`))).slice(0, 32)}`
    : null;
  return {
    status,
    statusReason,
    herdId,
    animalCount,
    weightedAverageLiveWeightKg,
    intakePercentLiveWeight,
    dailyDemandKgDm,
    totalSupplyKgDm,
    availableDays: dailyDemandKgDm ? roundNumber(totalSupplyKgDm / dailyDemandKgDm, 2) : null,
    paddockBudgets,
    lots,
    supplement: {
      status: supplementStatus,
      statusReason: rations.length === 0
        ? "No hay raciones activas para los lotes con animales."
        : missingRationCost ? "Hay raciones sin costo unitario coincidente en inventario." : null,
      dailyQuantityKgAsFed,
      projectedDailyCostClp,
    },
    economics: {
      status: economicsStatus,
      statusReason: economicsStatus === "unavailable"
        ? "La proyección F3 actual no tiene costo de alimento ni IOFC disponible."
        : economicsStatus === "partial" ? "La proyección F3 actual tiene cobertura financiera parcial." : null,
      period: latestMetric?.period ?? null,
      feedCostClp,
      iofcClp,
      costPerLiterClp,
      sourceProjectionId: latestMetric?.projection_id ?? null,
      computedAt: latestMetric?.computed_at ?? null,
    },
    rotationContext: {
      settings: input.settings ? {
        recentDays: Number(input.settings.recent_days),
        longRestDays: Number(input.settings.long_rest_days),
        version: Number(input.settings.version),
      } : null,
      activeCellsByPaddock,
      activeCellIdsByPaddock,
      compatibility: "complementary_read_model",
    },
    evidence: {
      demandUnit: "kg_dm_per_day",
      supplementUnit: "kg_as_fed_per_day",
      supplyUnit: "kg_dm",
      animalCountSources: [...new Set(lots.map((lot) => lot.animalCountSource))],
      weightSources: [...new Set(lots.map((lot) => lot.averageLiveWeightSource))],
      intakeAssumption: "3_percent_live_weight_dm",
      biomassSource: "latest_stored_pasture_biomass_estimate",
      economicsSource: "analytics_herd_metrics_current_projection",
    },
  };
}

function buildSyntheticNdviSamples(paddocks: PasturePaddockSnapshot[]): PastureSyntheticNdviSample[] {
  return paddocks.slice(0, 4).map((paddock, index) => {
    const meanNdvi = roundNumber(Math.max(0.35, 0.68 - (index * 0.07)), 2);
    return {
      paddockId: paddock.id,
      paddockName: paddock.name,
      capturedAt: "2026-07-15T12:00:00.000Z",
      meanNdvi,
      usablePixelPercent: 92 - (index * 3),
      indicativeKgDmPerHectare: Math.round(900 + (meanNdvi * 2_400)),
      model: "demo.synthetic.v1",
      operational: false,
    };
  });
}

function roundNumber(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function currentPastureAccessSql(requireWrite: boolean): string {
  const scopedRoles = requireWrite ? "('manager', 'operator')" : "('manager', 'operator', 'viewer')";
  return `EXISTS (
    SELECT 1
    FROM fields AS pasture_access_field
    JOIN organization_memberships AS pasture_access_membership
      ON pasture_access_membership.id = ?
     AND pasture_access_membership.organization_id = pasture_access_field.organization_id
     AND pasture_access_membership.normalized_email = ?
     AND pasture_access_membership.status = 'active'
    LEFT JOIN membership_field_access AS pasture_field_access
      ON pasture_field_access.membership_id = pasture_access_membership.id
     AND pasture_field_access.field_id = pasture_access_field.id
    WHERE pasture_access_field.organization_id = ?
      AND pasture_access_field.id = ?
      AND (
        pasture_access_membership.role IN ('owner', 'admin')
        OR (pasture_access_membership.role IN ${scopedRoles} AND pasture_field_access.field_id IS NOT NULL)
      )
      AND COALESCE(
        (SELECT enabled FROM organization_feature_flags
          WHERE organization_id = pasture_access_field.organization_id
            AND field_id = pasture_access_field.id AND feature = 'pastoreo' LIMIT 1),
        (SELECT enabled FROM organization_feature_flags
          WHERE organization_id = pasture_access_field.organization_id
            AND field_id IS NULL AND feature = 'pastoreo' LIMIT 1),
        0
      ) = 1
  )`;
}

function accessBindings(actor: AccessContext, fieldId: string): D1Value[] {
  return [actor.membershipId, actor.email.trim().toLowerCase(), actor.organizationId, fieldId];
}

function normalizeOperationId(value: string): string {
  const operationId = value?.trim();
  if (!operationId || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(operationId)) {
    throw new PastureDomainError("Falta un identificador de operación válido.", "PASTURE_OPERATION_INVALID");
  }
  return operationId;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new PastureDomainError("La evidencia contiene un número no finito.");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new PastureDomainError("La evidencia no se puede serializar como JSON.");
  }
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toProviderStatus(row: ProviderRow | null): PastureProviderStatus {
  if (!row || row.mode !== "configured" || !row.provider_key) return { mode: "unconfigured", providerKey: null, decidedAt: row?.decided_at ?? null };
  return { mode: "configured", providerKey: row.provider_key, decidedAt: row.decided_at };
}

function toPaddockSnapshot(row: PaddockRow): PasturePaddockSnapshot {
  const latestEstimate = row.estimate_id && row.observation_id && row.source_kind && row.method
    && row.kg_dm_per_hectare !== null && row.captured_at && row.computed_at
    ? toEstimate({
      id: row.estimate_id,
      observation_id: row.observation_id,
      paddock_id: row.id,
      paddock_name: row.name,
      source_kind: row.source_kind,
      method: row.method,
      kg_dm_per_hectare: row.kg_dm_per_hectare,
      calibration_id: row.calibration_id,
      captured_at: row.captured_at,
      computed_at: row.computed_at,
    })
    : null;
  return { id: row.id, name: row.name, areaHectares: row.area_hectares, latestEstimate };
}

function toEstimate(row: EstimateRow): PastureBiomassEstimate {
  return {
    id: row.id,
    observationId: row.observation_id,
    paddockId: row.paddock_id,
    paddockName: row.paddock_name,
    sourceKind: row.source_kind === "ndvi" ? "ndvi" : "manual",
    method: row.method,
    kgDmPerHectare: row.kg_dm_per_hectare,
    calibrationId: row.calibration_id,
    capturedAt: row.captured_at,
    computedAt: row.computed_at,
  };
}

function buildGrowthRates(
  paddocks: PasturePaddockSnapshot[],
  estimates: PastureBiomassEstimate[],
): PastureGrowthRate[] {
  return paddocks.map((paddock) => {
    const history = estimates
      .filter((estimate) => estimate.paddockId === paddock.id)
      .sort((left, right) => left.capturedAt.localeCompare(right.capturedAt) || left.id.localeCompare(right.id));
    if (history.length < 2) {
      return {
        paddockId: paddock.id,
        paddockName: paddock.name,
        status: "insufficient_data" as const,
        statusReason: "Se necesitan dos observaciones almacenadas con fechas distintas.",
        from: null,
        to: null,
        elapsedDays: null,
        kgDmPerHaPerDay: null,
      };
    }
    const previous = history.at(-2)!;
    const current = history.at(-1)!;
    try {
      const rate = calculateGrowthRate({
        paddockId: paddock.id,
        capturedAt: previous.capturedAt,
        kgDmPerHectare: previous.kgDmPerHectare,
      }, {
        paddockId: paddock.id,
        capturedAt: current.capturedAt,
        kgDmPerHectare: current.kgDmPerHectare,
      });
      return {
        paddockId: paddock.id,
        paddockName: paddock.name,
        status: "available" as const,
        statusReason: null,
        from: rate.from,
        to: rate.to,
        elapsedDays: rate.elapsedDays,
        kgDmPerHaPerDay: rate.kgDmPerHaPerDay,
      };
    } catch {
      return {
        paddockId: paddock.id,
        paddockName: paddock.name,
        status: "insufficient_data" as const,
        statusReason: "Las dos observaciones más recientes no definen un intervalo válido.",
        from: previous.capturedAt,
        to: current.capturedAt,
        elapsedDays: null,
        kgDmPerHaPerDay: null,
      };
    }
  });
}

function toRotationPlan(row: PlanRow): StoredPastureRotationPlan {
  return {
    id: row.id,
    operationId: row.operation_id,
    fieldId: row.field_id,
    feasible: row.status === "feasible",
    plan: JSON.parse(row.plan_json) as Record<string, unknown>,
    createdAt: row.created_at,
  };
}

function allResults<T>(result: D1Result<unknown>): T[] {
  return (result.results ?? []) as T[];
}

function firstResult<T>(result: D1Result<unknown>): T | null {
  return allResults<T>(result)[0] ?? null;
}
