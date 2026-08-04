import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import { addChileDays, chileDateKey } from "@/src/modules/leche/domain/chile-date.mjs";
import {
  ANALYTICS_SCHEMA_VERSION,
  DEFAULT_ANALYTICS_THRESHOLDS,
  DEFAULT_ANALYTICS_THRESHOLD_REVISION,
  buildAnalyticsProjection,
  normalizeAnalyticsWindow,
  normalizeAnalyticsThresholds,
  type AnalyticsAlert,
  type AnalyticsMetric,
  type AnalyticsProjection,
  type AnalyticsThresholdConfiguration,
  type AnalyticsThresholds,
  type AnalyticsWindow,
} from "../domain/analytics-projection.mjs";
import {
  ANALYTICS_RECOMMENDATION_ENGINE_VERSION,
  RULE_BASED_RECOMMENDATION_ADAPTER_ID,
} from "../domain/recommendation-engine.mjs";
import { compareAgainstOwnHistory } from "../domain/own-history-comparison.mjs";
import type { OwnHistoryComparisonResult } from "../domain/own-history-comparison.d.mts";

const ANALYTICS_JOB_TYPE = "analytics.recompute.v1";
const ANALYTICS_JOB_INTERVAL_SECONDS = 31_536_000;
const SOURCE_REVISION = /^[a-f0-9]{64}$/u;

type D1Value = string | number | null;

type ProjectionRunRow = {
  id: string;
  organizationId: string;
  fieldId: string;
  period: string;
  windowStart: string;
  windowEnd: string;
  comparisonStart: string;
  comparisonEnd: string;
  sourceRevision: string;
  thresholdRevision: string;
  thresholdsJson: string;
  schemaVersion: string;
  qualityState: AnalyticsProjection["quality"]["state"];
  qualityIssuesJson: string;
  qualityDomainsJson: string;
  sourceCountsJson: string;
  sourceCoverageJson: string;
  computedAt: string;
};

type MetricRow = {
  metricKey: string;
  status: AnalyticsMetric["status"];
  statusReason: string | null;
  value: number | null;
  unit: string;
  numerator: number | null;
  denominator: number | null;
  sampleCount: number;
  method: string;
  referencesJson: string;
};

type AlertRow = {
  code: string;
  status: AnalyticsAlert["status"];
  severity: AnalyticsAlert["severity"];
  explanation: string;
  evidenceJson: string;
};

type FieldRow = { id: string; name: string; isDemo: number };
type ThresholdRevisionRow = {
  revision: string;
  thresholdsJson: string;
  createdBy: string;
  createdAt: string;
};
type ScheduledJobLeaseRow = { leaseOwner: string | null; leaseExpiresAt: string };
type FingerprintRow = { fingerprint: string };
type MilkRow = { id: string; date: string; liters: number; milkingCowCount: number | null };
type QualityRow = {
  id: string;
  date: string;
  fatPct: number | null;
  proteinPct: number | null;
  somaticCellCount: number | null;
  liters: number | null;
};
type ReproductiveRow = {
  id: string;
  animalId: string;
  animalLabel: string;
  eventType: string;
  occurredAt: string;
  result: string | null;
  metadata: string;
};
type AnimalIdRow = { animalId: string };
type LactationRow = {
  id: string;
  animalId: string;
  animalLabel: string;
  startedAt: string;
  endedAt: string | null;
  status: string;
};
type MilkControlRow = {
  id: string;
  animalId: string;
  animalLabel: string;
  lactationId: string | null;
  date: string;
  totalLiters: number;
  somaticCellCount: number | null;
  historicalLotId: string | null;
  historicalLotName: string | null;
};
type WeightRow = { id: string; animalId: string; date: string; weightKg: number };
type OutcomeRow = { id: string; animalId: string; date: string; type: "death" | "discard" | "mastitis" };
type ExposureAnimalRow = {
  id: string;
  entryDate: string | null;
  birthDate: string | null;
  purchaseDate: string | null;
  createdAt: string;
  status: string;
  statusDate: string | null;
};
type CoverageRow = { summaryLots: number; declaredAnimals: number; registeredAnimals: number; missingStatusDates: number };
type SettlementRow = { id: string; period: string; milkRevenueClp: number; totalLiters: number };
type FeedRow = { id: string; date: string; feedCostClp: number };
type ExpenseRow = { id: string; date: string; category: string; amountClp: number };

type LoadedSources = {
  field: FieldRow;
  fingerprint: string;
  milkProduction: MilkRow[];
  milkQuality: QualityRow[];
  reproductiveEvents: Array<Omit<ReproductiveRow, "metadata"> & { metadata: Record<string, unknown> }>;
  reproductiveAnimalIds: string[];
  lactations: LactationRow[];
  milkControls: MilkControlRow[];
  weights: WeightRow[];
  outcomes: OutcomeRow[];
  herdExposure: Array<{ id: string; date: string; activeAnimals: number }>;
  finances: Array<{
    id: string;
    date: string;
    milkRevenueClp?: number;
    feedCostClp?: number;
    otherCostClp?: number;
  }>;
  outcomesComplete: boolean;
  thresholdConfiguration: AnalyticsThresholdConfiguration;
};

export type AnalyticsDashboard = {
  field: { id: string; name: string; isDemo: boolean };
  projection: (AnalyticsProjection & { computedAt: string }) | null;
  thresholdConfiguration: AnalyticsThresholdConfiguration;
  projectionThresholdConfiguration: AnalyticsThresholdConfiguration | null;
};

export type AnalyticsRecomputeJobPayload = {
  schemaVersion: "fundosmart.analytics.recompute-job.v1";
  organizationId: string;
  fieldId: string;
  period: string;
  expectedSourceRevision?: string | null;
  cause: "manual" | "scheduled" | "domain_events";
  requestedBy?: string;
};

export class AnalyticsScopeError extends Error {
  readonly code = "ANALYTICS_SCOPE_DENIED";

  constructor() {
    super("La analítica no está habilitada para este fundo o el alcance ya no está disponible.");
    this.name = "AnalyticsScopeError";
  }
}

export class AnalyticsConflictError extends Error {
  readonly code: "ANALYTICS_SOURCE_CONFLICT" | "ANALYTICS_RECOMPUTE_IN_PROGRESS";

  constructor(
    message = "Los datos fuente cambiaron; vuelve a cargar la analítica antes de reintentar.",
    code: "ANALYTICS_SOURCE_CONFLICT" | "ANALYTICS_RECOMPUTE_IN_PROGRESS" = "ANALYTICS_SOURCE_CONFLICT",
  ) {
    super(message);
    this.code = code;
    this.name = "AnalyticsConflictError";
  }
}

export class AnalyticsRecomputeInProgressError extends AnalyticsConflictError {
  constructor() {
    super(
      "Ya hay un recálculo analítico en curso para este fundo y período; vuelve a intentarlo cuando termine.",
      "ANALYTICS_RECOMPUTE_IN_PROGRESS",
    );
    this.name = "AnalyticsRecomputeInProgressError";
  }
}

export class AnalyticsRequestError extends Error {
  readonly code = "ANALYTICS_REQUEST_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "AnalyticsRequestError";
  }
}

export async function getAnalyticsDashboard(input: {
  actor: AccessContext;
  fieldId: string;
  period: string;
  now?: Date;
}): Promise<AnalyticsDashboard> {
  const period = normalizePeriod(input.period);
  const client = getDb().$client;
  const access = currentMemberAccess(input.actor, input.fieldId, false);
  const statements = [
    client.prepare(`
      SELECT current_field.id, current_field.name, current_field.is_demo AS isDemo
      FROM fields AS current_field
      WHERE current_field.id = ? AND current_field.organization_id = ?
        AND ${access.sql}
    `).bind(input.fieldId, input.actor.organizationId, ...access.bindings),
    client.prepare(`
      SELECT
        run.id,
        run.organization_id AS organizationId,
        run.field_id AS fieldId,
        run.period,
        run.window_start AS windowStart,
        run.window_end AS windowEnd,
        run.comparison_start AS comparisonStart,
        run.comparison_end AS comparisonEnd,
        run.source_revision AS sourceRevision,
        run.threshold_revision AS thresholdRevision,
        run.thresholds_json AS thresholdsJson,
        run.schema_version AS schemaVersion,
        run.quality_state AS qualityState,
        run.quality_issues_json AS qualityIssuesJson,
        run.quality_domains_json AS qualityDomainsJson,
        run.source_counts_json AS sourceCountsJson,
        run.source_coverage_json AS sourceCoverageJson,
        run.computed_at AS computedAt
      FROM analytics_projection_runs AS run
      WHERE run.organization_id = ? AND run.field_id = ? AND run.period = ? AND run.is_current = 1
        AND ${access.sql}
      ORDER BY run.computed_at DESC, run.id DESC
      LIMIT 1
    `).bind(input.actor.organizationId, input.fieldId, period, ...access.bindings),
    client.prepare(`
      SELECT
        metric.metric_key AS metricKey,
        metric.status,
        metric.status_reason AS statusReason,
        metric.value,
        metric.unit,
        metric.numerator,
        metric.denominator,
        metric.sample_count AS sampleCount,
        metric.method,
        metric.references_json AS referencesJson
      FROM analytics_herd_metrics AS metric
      INNER JOIN analytics_projection_runs AS run ON run.id = metric.projection_id
      WHERE run.organization_id = ? AND run.field_id = ? AND run.period = ? AND run.is_current = 1
        AND metric.organization_id = run.organization_id AND metric.field_id = run.field_id
        AND run.id = (
          SELECT selected_run.id
          FROM analytics_projection_runs AS selected_run
          WHERE selected_run.organization_id = run.organization_id
            AND selected_run.field_id = run.field_id
            AND selected_run.period = run.period
            AND selected_run.is_current = 1
          ORDER BY selected_run.computed_at DESC, selected_run.id DESC
          LIMIT 1
        )
        AND ${access.sql}
      ORDER BY metric.metric_key
    `).bind(input.actor.organizationId, input.fieldId, period, ...access.bindings),
    client.prepare(`
      SELECT
        evaluation.code,
        evaluation.status,
        evaluation.severity,
        evaluation.explanation,
        evaluation.evidence_json AS evidenceJson
      FROM analytics_alert_evaluations AS evaluation
      INNER JOIN analytics_projection_runs AS run ON run.id = evaluation.projection_id
      WHERE run.organization_id = ? AND run.field_id = ? AND run.period = ? AND run.is_current = 1
        AND evaluation.organization_id = run.organization_id AND evaluation.field_id = run.field_id
        AND run.id = (
          SELECT selected_run.id
          FROM analytics_projection_runs AS selected_run
          WHERE selected_run.organization_id = run.organization_id
            AND selected_run.field_id = run.field_id
            AND selected_run.period = run.period
            AND selected_run.is_current = 1
          ORDER BY selected_run.computed_at DESC, selected_run.id DESC
          LIMIT 1
        )
        AND ${access.sql}
      ORDER BY evaluation.code
    `).bind(input.actor.organizationId, input.fieldId, period, ...access.bindings),
    currentThresholdStatement(input.actor, input.fieldId, access),
  ];
  const [fieldResult, runResult, metricResult, alertResult, thresholdResult] = await client.batch(statements);
  const field = firstResult<FieldRow>(fieldResult);
  if (!field) throw new AnalyticsScopeError();
  const run = firstResult<ProjectionRunRow>(runResult);
  const thresholdConfiguration = restoreThresholdConfiguration(firstResult<ThresholdRevisionRow>(thresholdResult));
  if (!run && Boolean(field.isDemo)) {
    const computed = await computeAnalyticsProjection({
      organizationId: input.actor.organizationId,
      fieldId: input.fieldId,
      period,
      now: input.now,
    });
    return {
      field: { id: field.id, name: field.name, isDemo: true },
      projection: { ...computed.projection, computedAt: deterministicDemoComputedAt(computed.projection.window) },
      thresholdConfiguration: computed.thresholdConfiguration,
      projectionThresholdConfiguration: computed.thresholdConfiguration,
    };
  }
  return {
    field: { id: field.id, name: field.name, isDemo: Boolean(field.isDemo) },
    projection: run
      ? restoreProjection(
        run,
        resultRows<MetricRow>(metricResult),
        resultRows<AlertRow>(alertResult),
      )
      : null,
    thresholdConfiguration,
    projectionThresholdConfiguration: run ? thresholdConfigurationFromRun(run) : null,
  };
}

export async function saveAnalyticsThresholdConfiguration(input: {
  actor: AccessContext;
  fieldId: string;
  expectedRevision: string;
  thresholds: unknown;
  now?: Date;
}): Promise<AnalyticsThresholdConfiguration> {
  assertSourceRevision(input.expectedRevision);
  const thresholds = normalizeCompleteThresholds(input.thresholds);
  const revision = await sha256Hex(canonicalJson(thresholds));
  const now = (input.now ?? new Date()).toISOString();
  const access = thresholdWriteAccess(input.actor, input.fieldId);
  const expected = currentThresholdRevisionGuard(
    input.actor.organizationId,
    input.fieldId,
    input.expectedRevision,
  );
  const id = `analytics-threshold:${input.actor.organizationId}:${input.fieldId}:${revision}`;
  const auditId = crypto.randomUUID();
  const client = getDb().$client;
  try {
    await client.batch([
      client.prepare(`
        INSERT INTO analytics_threshold_revisions (
          id, organization_id, field_id, revision, thresholds_json,
          created_by, created_at, is_current
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 0
        WHERE ${access.sql} AND ${expected.sql}
        ON CONFLICT(organization_id, field_id, revision) DO NOTHING
      `).bind(
        id,
        input.actor.organizationId,
        input.fieldId,
        revision,
        JSON.stringify(thresholds),
        input.actor.email,
        now,
        ...access.bindings,
        ...expected.bindings,
      ),
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          before, after, occurred_at
        )
        SELECT ?, ?, ?, ?, 'analytics.thresholds.configured', 'analytics_threshold_revision', ?, ?, ?, ?
        WHERE ${access.sql} AND ${expected.sql}
          AND EXISTS (
            SELECT 1 FROM analytics_threshold_revisions AS target_revision
            WHERE target_revision.organization_id = ? AND target_revision.field_id = ?
              AND target_revision.revision = ?
          )
          AND NOT EXISTS (
            SELECT 1 FROM analytics_threshold_revisions AS current_revision
            WHERE current_revision.organization_id = ? AND current_revision.field_id = ?
              AND current_revision.revision = ? AND current_revision.is_current = 1
          )
      `).bind(
        auditId,
        input.actor.organizationId,
        input.fieldId,
        input.actor.email,
        id,
        JSON.stringify({ revision: input.expectedRevision }),
        JSON.stringify({ revision, thresholds }),
        now,
        ...access.bindings,
        ...expected.bindings,
        input.actor.organizationId,
        input.fieldId,
        revision,
        input.actor.organizationId,
        input.fieldId,
        revision,
      ),
      client.prepare(`
        UPDATE analytics_threshold_revisions
        SET is_current = 0
        WHERE organization_id = ? AND field_id = ? AND is_current = 1 AND revision <> ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND organization_id = ? AND field_id = ?)
      `).bind(
        input.actor.organizationId,
        input.fieldId,
        revision,
        auditId,
        input.actor.organizationId,
        input.fieldId,
      ),
      client.prepare(`
        UPDATE analytics_threshold_revisions
        SET is_current = 1
        WHERE organization_id = ? AND field_id = ? AND revision = ?
          AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND organization_id = ? AND field_id = ?)
      `).bind(
        input.actor.organizationId,
        input.fieldId,
        revision,
        auditId,
        input.actor.organizationId,
        input.fieldId,
      ),
      client.prepare(`
        SELECT CASE WHEN (
          ${access.sql}
          AND (
            EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND organization_id = ? AND field_id = ?)
            OR (? = ? AND EXISTS (
              SELECT 1 FROM analytics_threshold_revisions AS exact_replay
              WHERE exact_replay.organization_id = ? AND exact_replay.field_id = ?
                AND exact_replay.revision = ? AND exact_replay.is_current = 1
            ))
          )
        ) THEN 1 ELSE json_extract('fundosmart_analytics_threshold_conflict', '$') END
          AS analytics_threshold_postcondition
      `).bind(
        ...access.bindings,
        auditId,
        input.actor.organizationId,
        input.fieldId,
        input.expectedRevision,
        revision,
        input.actor.organizationId,
        input.fieldId,
        revision,
      ),
    ]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes("malformed JSON")) {
      throw new AnalyticsConflictError("Los umbrales cambiaron; vuelve a cargar antes de guardar.");
    }
    throw cause;
  }
  const saved = await client.prepare(`
    SELECT revision, thresholds_json AS thresholdsJson, created_by AS createdBy, created_at AS createdAt
    FROM analytics_threshold_revisions
    WHERE organization_id = ? AND field_id = ? AND revision = ? AND is_current = 1
      AND ${access.sql}
  `).bind(
    input.actor.organizationId,
    input.fieldId,
    revision,
    ...access.bindings,
  ).first<ThresholdRevisionRow>();
  if (!saved) throw new AnalyticsConflictError("Los umbrales cambiaron antes de confirmar la escritura.");
  return restoreThresholdConfiguration(saved);
}

export async function enqueueAnalyticsRecompute(input: {
  actor: AccessContext;
  fieldId: string;
  period: string;
  expectedSourceRevision: string | null;
  now?: Date;
}): Promise<{ jobId: string; status: "queued"; dueAt: string }> {
  const period = normalizePeriod(input.period);
  assertSourceRevision(input.expectedSourceRevision);
  const now = input.now ?? new Date();
  const dueAt = now.toISOString();
  const jobId = `analytics:${input.actor.organizationId}:${input.fieldId}:${period}`;
  const access = currentMemberAccess(input.actor, input.fieldId, true);
  const payload: AnalyticsRecomputeJobPayload = {
    schemaVersion: "fundosmart.analytics.recompute-job.v1",
    organizationId: input.actor.organizationId,
    fieldId: input.fieldId,
    period,
    expectedSourceRevision: input.expectedSourceRevision,
    cause: "manual",
    requestedBy: input.actor.email,
  };
  const client = getDb().$client;
  const revisionGuard = currentProjectionRevisionGuard(
    input.actor.organizationId,
    input.fieldId,
    period,
    input.expectedSourceRevision,
  );
  const jobStatement = client.prepare(`
    INSERT INTO scheduled_jobs (
      id, organization_id, field_id, type, payload, status, due_at, interval_seconds,
      lease_owner, lease_expires_at, attempt_count, last_error_type, updated_at
    )
    SELECT ?, ?, ?, ?, ?, 'active', ?, ?, NULL, NULL, 0, NULL, ?
    WHERE ${access.sql} AND ${revisionGuard.sql}
    ON CONFLICT(id) DO UPDATE SET
      organization_id = excluded.organization_id,
      field_id = excluded.field_id,
      type = excluded.type,
      payload = excluded.payload,
      status = 'active',
      due_at = excluded.due_at,
      interval_seconds = excluded.interval_seconds,
      lease_owner = NULL,
      lease_expires_at = NULL,
      attempt_count = 0,
      last_error_type = NULL,
      updated_at = excluded.updated_at
    WHERE scheduled_jobs.lease_expires_at IS NULL
      OR scheduled_jobs.lease_expires_at <= excluded.updated_at
  `).bind(
    jobId,
    input.actor.organizationId,
    input.fieldId,
    ANALYTICS_JOB_TYPE,
    JSON.stringify(payload),
    dueAt,
    ANALYTICS_JOB_INTERVAL_SECONDS,
    dueAt,
    ...access.bindings,
    ...revisionGuard.bindings,
  );
  const auditId = crypto.randomUUID();
  const auditStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at
    )
    SELECT ?, ?, ?, ?, 'analytics.recompute.enqueued', 'scheduled_job', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM scheduled_jobs AS queued_job
      WHERE queued_job.id = ? AND queued_job.organization_id = ? AND queued_job.field_id = ?
        AND queued_job.type = ? AND queued_job.payload = ? AND queued_job.status = 'active'
        AND queued_job.due_at = ? AND queued_job.updated_at = ?
        AND queued_job.lease_owner IS NULL AND queued_job.lease_expires_at IS NULL
    )
  `).bind(
    auditId,
    input.actor.organizationId,
    input.fieldId,
    input.actor.email,
    jobId,
    JSON.stringify({ period, expectedSourceRevision: input.expectedSourceRevision }),
    dueAt,
    jobId,
    input.actor.organizationId,
    input.fieldId,
    ANALYTICS_JOB_TYPE,
    JSON.stringify(payload),
    dueAt,
    dueAt,
  );
  const activeLeaseStatement = client.prepare(`
    SELECT leased_job.lease_owner AS leaseOwner, leased_job.lease_expires_at AS leaseExpiresAt
    FROM scheduled_jobs AS leased_job
    WHERE leased_job.id = ? AND leased_job.organization_id = ? AND leased_job.field_id = ?
      AND leased_job.lease_expires_at > ?
      AND ${access.sql}
    LIMIT 1
  `).bind(
    jobId,
    input.actor.organizationId,
    input.fieldId,
    dueAt,
    ...access.bindings,
  );
  const [jobResult, auditResult, activeLeaseResult] = await client.batch([
    jobStatement,
    auditStatement,
    activeLeaseStatement,
  ]);
  if (changes(jobResult) !== 1) {
    if (firstResult<ScheduledJobLeaseRow>(activeLeaseResult)) throw new AnalyticsRecomputeInProgressError();
    throw new AnalyticsConflictError();
  }
  if (changes(auditResult) !== 1) throw new AnalyticsConflictError();
  return { jobId, status: "queued", dueAt };
}

export async function recomputeAnalyticsProjection(input: {
  organizationId: string;
  fieldId: string;
  period: string;
  actor?: string;
  now?: Date;
}): Promise<AnalyticsProjection & { computedAt: string }> {
  const computed = await computeAnalyticsProjection(input);
  if (computed.isDemo) {
    return {
      ...computed.projection,
      computedAt: deterministicDemoComputedAt(computed.projection.window),
    };
  }
  const computedAt = (input.now ?? new Date()).toISOString();
  await persistProjection({
    projection: computed.projection,
    sourceFingerprint: computed.sourceFingerprint,
    thresholdConfiguration: computed.thresholdConfiguration,
    computedAt,
    actor: input.actor?.trim() || "system:analytics",
  });
  return { ...computed.projection, computedAt };
}

export async function runAnalyticsRecomputeJob(
  rawPayload: Record<string, unknown>,
  options: { now?: Date } = {},
): Promise<{ status: "recomputed" | "superseded"; sourceRevision: string | null }> {
  const payload = parseJobPayload(rawPayload);
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(rawPayload, "expectedSourceRevision");
  if (hasExpectedRevision) {
    const currentRevision = await getCurrentProjectionRevision(payload.organizationId, payload.fieldId, payload.period);
    if (currentRevision !== payload.expectedSourceRevision) {
      return { status: "superseded", sourceRevision: currentRevision };
    }
  }
  const projection = await recomputeAnalyticsProjection({
    organizationId: payload.organizationId,
    fieldId: payload.fieldId,
    period: payload.period,
    actor: payload.requestedBy ?? `system:${payload.cause}`,
    now: options.now,
  });
  return { status: "recomputed", sourceRevision: projection.reference.datasetRevision };
}

async function loadAnalyticsSources(
  organizationId: string,
  fieldId: string,
  window: AnalyticsWindow,
): Promise<LoadedSources> {
  const client = getDb().$client;
  const feature = effectiveAnalyticsFeature(organizationId, fieldId);
  const results = await client.batch([
    client.prepare(`
      SELECT current_field.id, current_field.name, current_field.is_demo AS isDemo
      FROM fields AS current_field
      WHERE current_field.organization_id = ? AND current_field.id = ? AND ${feature.sql}
    `).bind(organizationId, fieldId, ...feature.bindings),
    sourceFingerprintStatement(organizationId, fieldId),
    client.prepare(`
      SELECT
        production.id,
        substr(production.recorded_at, 1, 10) AS date,
        production.volume_liters AS liters,
        NULLIF((
          SELECT COUNT(DISTINCT lactation.animal_id)
          FROM livestock_lactations AS lactation
          WHERE lactation.field_id = production.field_id
            AND substr(lactation.started_at, 1, 10) <= substr(production.recorded_at, 1, 10)
            AND (lactation.ended_at IS NULL OR substr(lactation.ended_at, 1, 10) >= substr(production.recorded_at, 1, 10))
        ), 0) AS milkingCowCount
      FROM milk_bulk_production AS production
      WHERE production.organization_id = ? AND production.field_id = ?
        AND substr(production.recorded_at, 1, 10) BETWEEN ? AND ?
      ORDER BY date, production.id
    `).bind(organizationId, fieldId, window.comparison.start, window.end),
    client.prepare(`
      SELECT
        quality.id,
        substr(quality.sampled_at, 1, 10) AS date,
        quality.fat_percent AS fatPct,
        quality.protein_percent AS proteinPct,
        CASE quality.somatic_cell_count_unit
          WHEN 'thousand_cells_per_ml' THEN quality.somatic_cell_count * 1000
          ELSE quality.somatic_cell_count
        END AS somaticCellCount,
        (
          SELECT SUM(production.volume_liters)
          FROM milk_bulk_production AS production
          WHERE production.organization_id = quality.organization_id
            AND production.field_id = quality.field_id
            AND substr(production.recorded_at, 1, 10) = substr(quality.sampled_at, 1, 10)
        ) AS liters
      FROM milk_quality_samples AS quality
      WHERE quality.organization_id = ? AND quality.field_id = ?
        AND substr(quality.sampled_at, 1, 10) BETWEEN ? AND ?
      ORDER BY date, quality.id
    `).bind(organizationId, fieldId, window.comparison.start, window.end),
    client.prepare(`
      SELECT
        event.id,
        event.animal_id AS animalId,
        COALESCE(NULLIF(trim(animal.tag), ''), event.animal_id) AS animalLabel,
        event.event_type AS eventType,
        event.occurred_at AS occurredAt,
        event.result,
        event.metadata
      FROM livestock_reproductive_events AS event
      INNER JOIN fields AS scoped_field ON scoped_field.id = event.field_id
      LEFT JOIN livestock_animals AS animal ON animal.id = event.animal_id
      WHERE scoped_field.organization_id = ? AND event.field_id = ?
        AND substr(event.occurred_at, 1, 10) <= ?
      ORDER BY event.occurred_at, event.id
    `).bind(organizationId, fieldId, window.end),
    client.prepare(`
      SELECT animal.id AS animalId
      FROM livestock_animals AS animal
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ? AND lot.field_id = ? AND animal.sex = 'female'
      ORDER BY animal.id
    `).bind(organizationId, fieldId),
    client.prepare(`
      SELECT
        lactation.id,
        lactation.animal_id AS animalId,
        COALESCE(NULLIF(trim(animal.tag), ''), animal.id) AS animalLabel,
        substr(lactation.started_at, 1, 10) AS startedAt,
        substr(lactation.ended_at, 1, 10) AS endedAt,
        lactation.status
      FROM livestock_lactations AS lactation
      INNER JOIN livestock_animals AS animal ON animal.id = lactation.animal_id
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ?
        AND lot.field_id = ?
        AND lactation.field_id = lot.field_id
        AND substr(lactation.started_at, 1, 10) <= ?
      ORDER BY lactation.started_at, lactation.id
    `).bind(organizationId, fieldId, window.end),
    client.prepare(`
      SELECT
        control.id,
        control.animal_id AS animalId,
        COALESCE(NULLIF(trim(animal.tag), ''), animal.id) AS animalLabel,
        control.lactation_id AS lactationId,
        substr(control.control_date, 1, 10) AS date,
        control.total_liters AS totalLiters,
        control.somatic_cell_count AS somaticCellCount,
        (
          SELECT historical_membership.lot_id
          FROM livestock_lot_memberships AS historical_membership
          INNER JOIN livestock_lots AS historical_lot
            ON historical_lot.id = historical_membership.lot_id
            AND historical_lot.field_id = control.field_id
          WHERE historical_membership.animal_id = control.animal_id
            AND substr(historical_membership.started_at, 1, 10) <= substr(control.control_date, 1, 10)
            AND (historical_membership.ended_at IS NULL
              OR substr(historical_membership.ended_at, 1, 10) >= substr(control.control_date, 1, 10))
          ORDER BY historical_membership.started_at DESC, historical_membership.id DESC
          LIMIT 1
        ) AS historicalLotId,
        (
          SELECT historical_lot.name
          FROM livestock_lot_memberships AS historical_membership
          INNER JOIN livestock_lots AS historical_lot
            ON historical_lot.id = historical_membership.lot_id
            AND historical_lot.field_id = control.field_id
          WHERE historical_membership.animal_id = control.animal_id
            AND substr(historical_membership.started_at, 1, 10) <= substr(control.control_date, 1, 10)
            AND (historical_membership.ended_at IS NULL
              OR substr(historical_membership.ended_at, 1, 10) >= substr(control.control_date, 1, 10))
          ORDER BY historical_membership.started_at DESC, historical_membership.id DESC
          LIMIT 1
        ) AS historicalLotName
      FROM livestock_milk_controls AS control
      INNER JOIN livestock_animals AS animal ON animal.id = control.animal_id
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ?
        AND lot.field_id = ?
        AND control.field_id = lot.field_id
        AND substr(control.control_date, 1, 10) <= ?
      ORDER BY control.control_date, control.id
    `).bind(organizationId, fieldId, window.end),
    client.prepare(`
      SELECT
        weighing.id,
        weighing.animal_id AS animalId,
        substr(weighing.recorded_at, 1, 10) AS date,
        weighing.weight_kg AS weightKg
      FROM livestock_weighings AS weighing
      INNER JOIN livestock_animals AS animal ON animal.id = weighing.animal_id
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ? AND lot.field_id = ?
        AND substr(weighing.recorded_at, 1, 10) BETWEEN ? AND ?
      ORDER BY date, weighing.id
    `).bind(organizationId, fieldId, window.start, window.end),
    client.prepare(`
      SELECT
        'animal-status:' || animal.id AS id,
        animal.id AS animalId,
        substr(animal.status_date, 1, 10) AS date,
        CASE animal.status WHEN 'dead' THEN 'death' ELSE 'discard' END AS type
      FROM livestock_animals AS animal
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ? AND lot.field_id = ?
        AND animal.status IN ('dead', 'sold', 'departed')
        AND substr(animal.status_date, 1, 10) BETWEEN ? AND ?
      UNION ALL
      SELECT
        'health:' || health.id AS id,
        health.animal_id AS animalId,
        substr(health.occurred_at, 1, 10) AS date,
        'mastitis' AS type
      FROM livestock_health_events AS health
      INNER JOIN fields AS scoped_field ON scoped_field.id = health.field_id
      WHERE scoped_field.organization_id = ? AND health.field_id = ?
        AND health.status <> 'cancelled'
        AND lower(COALESCE(health.condition, '')) LIKE '%mastitis%'
        AND substr(health.occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY date, id
    `).bind(
      organizationId,
      fieldId,
      window.start,
      window.end,
      organizationId,
      fieldId,
      window.start,
      window.end,
    ),
    client.prepare(`
      SELECT
        animal.id,
        lot.entry_date AS entryDate,
        animal.birth_date AS birthDate,
        animal.purchase_date AS purchaseDate,
        animal.created_at AS createdAt,
        animal.status,
        animal.status_date AS statusDate
      FROM livestock_animals AS animal
      INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ? AND lot.field_id = ?
      ORDER BY animal.id
    `).bind(organizationId, fieldId),
    client.prepare(`
      SELECT
        SUM(CASE WHEN lot.tracking_mode <> 'individual' THEN 1 ELSE 0 END) AS summaryLots,
        COALESCE(SUM(CASE WHEN lot.tracking_mode = 'individual' THEN lot.animal_count ELSE 0 END), 0) AS declaredAnimals,
        (SELECT COUNT(*)
          FROM livestock_animals AS animal
          INNER JOIN livestock_lots AS animal_lot ON animal_lot.id = animal.lot_id
          WHERE animal_lot.field_id = ?) AS registeredAnimals,
        (SELECT COUNT(*)
          FROM livestock_animals AS animal
          INNER JOIN livestock_lots AS animal_lot ON animal_lot.id = animal.lot_id
          WHERE animal_lot.field_id = ? AND animal.status <> 'active' AND animal.status_date IS NULL) AS missingStatusDates
      FROM livestock_lots AS lot
      INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
      WHERE scoped_field.organization_id = ? AND lot.field_id = ? AND lot.status = 'active'
    `).bind(fieldId, fieldId, organizationId, fieldId),
    client.prepare(`
      SELECT
        settlement.id,
        settlement.period,
        settlement.net_amount_clp AS milkRevenueClp,
        settlement.total_liters AS totalLiters
      FROM milk_settlements AS settlement
      INNER JOIN fields AS scoped_field ON scoped_field.id = settlement.field_id
      WHERE scoped_field.organization_id = ? AND settlement.field_id = ?
        AND settlement.period BETWEEN ? AND ?
      ORDER BY settlement.period, settlement.id
    `).bind(organizationId, fieldId, window.comparison.start.slice(0, 7), window.end.slice(0, 7)),
    client.prepare(`
      SELECT consumption.id, substr(consumption.occurred_at, 1, 10) AS date, consumption.cost_clp AS feedCostClp
      FROM livestock_feed_consumptions AS consumption
      INNER JOIN fields AS scoped_field ON scoped_field.id = consumption.field_id
      WHERE scoped_field.organization_id = ? AND consumption.field_id = ?
        AND substr(consumption.occurred_at, 1, 10) BETWEEN ? AND ?
      ORDER BY date, consumption.id
    `).bind(organizationId, fieldId, window.start, window.end),
    client.prepare(`
      SELECT expense.id, substr(expense.date, 1, 10) AS date, expense.category, expense.amount_clp AS amountClp
      FROM livestock_expenses AS expense
      WHERE expense.organization_id = ? AND expense.field_id = ?
        AND substr(expense.date, 1, 10) BETWEEN ? AND ?
      ORDER BY date, expense.id
    `).bind(organizationId, fieldId, window.start, window.end),
    client.prepare(`
      SELECT revision, thresholds_json AS thresholdsJson, created_by AS createdBy, created_at AS createdAt
      FROM analytics_threshold_revisions
      WHERE organization_id = ? AND field_id = ? AND is_current = 1 AND ${feature.sql}
      LIMIT 1
    `).bind(organizationId, fieldId, ...feature.bindings),
  ]);
  const field = firstResult<FieldRow>(results[0]);
  if (!field) throw new AnalyticsScopeError();
  const fingerprint = firstResult<FingerprintRow>(results[1])?.fingerprint;
  if (!fingerprint) throw new AnalyticsConflictError("No fue posible fijar la revisión de las fuentes analíticas.");
  const exposureAnimals = resultRows<ExposureAnimalRow>(results[10]);
  const coverage = firstResult<CoverageRow>(results[11]) ?? {
    summaryLots: 0,
    declaredAnimals: 0,
    registeredAnimals: 0,
    missingStatusDates: 0,
  };
  const settlementRows = resultRows<SettlementRow>(results[12]);
  const usableSettlementRows = window.complete
    ? settlementRows.filter((row) => row.period === window.start.slice(0, 7))
    : [];
  const feedRows = resultRows<FeedRow>(results[13]);
  const expenseRows = resultRows<ExpenseRow>(results[14]);
  const settlementFinances: LoadedSources["finances"] = usableSettlementRows.map((row) => ({
    id: `settlement:${row.id}`,
    date: `${row.period}-15`,
    milkRevenueClp: row.milkRevenueClp,
  }));
  const feedFinances: LoadedSources["finances"] = feedRows.map((row) => ({
    id: `feed:${row.id}`,
    date: row.date,
    feedCostClp: row.feedCostClp,
  }));
  const expenseFinances = expenseRows.reduce<LoadedSources["finances"]>((accumulator, row) => {
    if (row.category === "alimento") {
      if (feedRows.length === 0) accumulator.push({ id: `expense:${row.id}`, date: row.date, feedCostClp: row.amountClp });
    } else {
      accumulator.push({ id: `expense:${row.id}`, date: row.date, otherCostClp: row.amountClp });
    }
    return accumulator;
  }, []);
  const finances: LoadedSources["finances"] = [
    ...settlementFinances,
    ...feedFinances,
    ...expenseFinances,
  ].sort(byDateAndId);
  const milkProduction = withSettlementProductionFallback(
    resultRows<MilkRow>(results[2]),
    settlementRows,
    window,
  );
  return {
    field,
    fingerprint,
    milkProduction,
    milkQuality: resultRows<QualityRow>(results[3]),
    reproductiveEvents: resultRows<ReproductiveRow>(results[4]).map((row) => ({
      ...row,
      metadata: parseJsonObject(row.metadata),
    })),
    reproductiveAnimalIds: resultRows<AnimalIdRow>(results[5]).map((row) => row.animalId),
    lactations: resultRows<LactationRow>(results[6]),
    milkControls: resultRows<MilkControlRow>(results[7]),
    weights: resultRows<WeightRow>(results[8]),
    outcomes: resultRows<OutcomeRow>(results[9]),
    herdExposure: buildDailyExposure(exposureAnimals, window),
    finances,
    outcomesComplete: coverage.registeredAnimals > 0
      && coverage.summaryLots === 0
      && coverage.registeredAnimals >= coverage.declaredAnimals
      && coverage.missingStatusDates === 0,
    thresholdConfiguration: restoreThresholdConfiguration(firstResult<ThresholdRevisionRow>(results[15])),
  };
}

async function computeAnalyticsProjection(input: {
  organizationId: string;
  fieldId: string;
  period: string;
  now?: Date;
}): Promise<{
  projection: AnalyticsProjection;
  sourceFingerprint: string;
  thresholdConfiguration: AnalyticsThresholdConfiguration;
  isDemo: boolean;
}> {
  const period = normalizePeriod(input.period);
  const today = chileDateKey(input.now ?? new Date());
  const window = period === today.slice(0, 7)
    ? normalizeAnalyticsWindow({ period, asOf: today })
    : normalizeAnalyticsWindow(period);
  const loaded = await loadAnalyticsSources(input.organizationId, input.fieldId, window);
  const sourceRevision = await sha256Hex(canonicalJson({
    fieldId: input.fieldId,
    fingerprint: loaded.fingerprint,
    milkProduction: loaded.milkProduction,
    milkQuality: loaded.milkQuality,
    reproductiveEvents: loaded.reproductiveEvents,
    reproductiveAnimalIds: loaded.reproductiveAnimalIds,
    lactations: loaded.lactations,
    milkControls: loaded.milkControls,
    weights: loaded.weights,
    outcomes: loaded.outcomes,
    herdExposure: loaded.herdExposure,
    finances: loaded.finances,
    outcomesComplete: loaded.outcomesComplete,
  }));
  return {
    projection: buildAnalyticsProjection({
      organizationId: input.organizationId,
      fieldId: input.fieldId,
      datasetRevision: sourceRevision,
      outcomesComplete: loaded.outcomesComplete,
      window,
      milkProduction: loaded.milkProduction,
      milkQuality: loaded.milkQuality,
      reproductiveEvents: loaded.reproductiveEvents,
      reproductiveAnimalIds: loaded.reproductiveAnimalIds,
      lactations: loaded.lactations,
      milkControls: loaded.milkControls,
      weights: loaded.weights,
      outcomes: loaded.outcomes,
      herdExposure: loaded.herdExposure,
      finances: loaded.finances,
    }, { thresholds: loaded.thresholdConfiguration.thresholds }),
    sourceFingerprint: loaded.fingerprint,
    thresholdConfiguration: loaded.thresholdConfiguration,
    isDemo: Boolean(loaded.field.isDemo),
  };
}

async function persistProjection(input: {
  projection: AnalyticsProjection;
  sourceFingerprint: string;
  thresholdConfiguration: AnalyticsThresholdConfiguration;
  computedAt: string;
  actor: string;
}): Promise<void> {
  const organizationId = input.projection.reference.organizationId;
  const fieldId = input.projection.reference.fieldId;
  const sourceRevision = input.projection.reference.datasetRevision;
  if (!organizationId || !fieldId || !sourceRevision) throw new AnalyticsRequestError("La proyección no tiene alcance ni revisión.");
  const window = input.projection.window;
  const runId = await sha256Hex(canonicalJson({
    organizationId,
    fieldId,
    start: window.start,
    end: window.end,
    sourceRevision,
    thresholdRevision: input.thresholdConfiguration.revision,
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
  }));
  const client = getDb().$client;
  const feature = effectiveAnalyticsFeature(organizationId, fieldId);
  const sourceGuard = sourceFingerprintGuard(organizationId, fieldId, input.sourceFingerprint);
  const runStatement = client.prepare(`
    INSERT INTO analytics_projection_runs (
      id, organization_id, field_id, period, window_start, window_end,
      comparison_start, comparison_end, source_revision, threshold_revision, thresholds_json, schema_version,
      quality_state, quality_issues_json, quality_domains_json,
      source_counts_json, source_coverage_json, computed_at, is_current
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0
    WHERE ${feature.sql} AND ${sourceGuard.sql}
    ON CONFLICT(id) DO UPDATE SET
      quality_state = excluded.quality_state,
      quality_issues_json = excluded.quality_issues_json,
      quality_domains_json = excluded.quality_domains_json,
      source_counts_json = excluded.source_counts_json,
      source_coverage_json = excluded.source_coverage_json,
      computed_at = excluded.computed_at
  `).bind(
    runId,
    organizationId,
    fieldId,
    window.period,
    window.start,
    window.end,
    window.comparison.start,
    window.comparison.end,
    sourceRevision,
    input.thresholdConfiguration.revision,
    JSON.stringify(input.thresholdConfiguration.thresholds),
    ANALYTICS_SCHEMA_VERSION,
    input.projection.quality.state,
    JSON.stringify(input.projection.quality.issues),
    JSON.stringify(input.projection.quality.domains),
    JSON.stringify(input.projection.reference.sourceCounts),
    JSON.stringify(input.projection.reference.sourceCoverage),
    input.computedAt,
    ...feature.bindings,
    ...sourceGuard.bindings,
  );
  const deactivatePreviousStatement = client.prepare(`
    UPDATE analytics_projection_runs
    SET is_current = 0
    WHERE organization_id = ? AND field_id = ? AND period = ?
      AND id <> ?
      AND EXISTS (
        SELECT 1 FROM analytics_projection_runs AS accepted_run
        WHERE accepted_run.id = ? AND accepted_run.computed_at = ?
      )
  `).bind(organizationId, fieldId, window.period, runId, runId, input.computedAt);
  const activateCurrentStatement = client.prepare(`
    UPDATE analytics_projection_runs
    SET is_current = 1
    WHERE id = ? AND organization_id = ? AND field_id = ? AND computed_at = ?
  `).bind(runId, organizationId, fieldId, input.computedAt);
  const metricStatements = input.projection.metrics.map((metric) => client.prepare(`
    INSERT INTO analytics_herd_metrics (
      id, projection_id, organization_id, field_id, period, window_start, window_end,
      metric_key, status, status_reason, value, unit, numerator, denominator,
      sample_count, method, references_json, source_revision, schema_version, computed_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analytics_projection_runs AS accepted_run
      WHERE accepted_run.id = ? AND accepted_run.computed_at = ?
        AND accepted_run.organization_id = ? AND accepted_run.field_id = ?
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      status_reason = excluded.status_reason,
      value = excluded.value,
      numerator = excluded.numerator,
      denominator = excluded.denominator,
      sample_count = excluded.sample_count,
      method = excluded.method,
      references_json = excluded.references_json,
      computed_at = excluded.computed_at
  `).bind(
    `${runId}:${metric.key}`,
    runId,
    organizationId,
    fieldId,
    window.period,
    window.start,
    window.end,
    metric.key,
    metric.status,
    metric.statusReason,
    metric.value,
    metric.unit,
    metric.numerator,
    metric.denominator,
    metric.sampleCount,
    metric.method,
    JSON.stringify(metric.references),
    sourceRevision,
    ANALYTICS_SCHEMA_VERSION,
    input.computedAt,
    runId,
    input.computedAt,
    organizationId,
    fieldId,
  ));
  const alertStatements = input.projection.alertEvaluations.map((evaluation) => client.prepare(`
    INSERT INTO analytics_alert_evaluations (
      id, projection_id, organization_id, field_id, window_start, window_end,
      code, status, severity, explanation, evidence_json, threshold_revision, thresholds_json,
      source_revision, schema_version, computed_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analytics_projection_runs AS accepted_run
      WHERE accepted_run.id = ? AND accepted_run.computed_at = ?
        AND accepted_run.organization_id = ? AND accepted_run.field_id = ?
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      severity = excluded.severity,
      explanation = excluded.explanation,
      evidence_json = excluded.evidence_json,
      computed_at = excluded.computed_at
  `).bind(
    `${runId}:${evaluation.code}`,
    runId,
    organizationId,
    fieldId,
    window.start,
    window.end,
    evaluation.code,
    evaluation.status,
    evaluation.severity,
    evaluation.explanation,
    JSON.stringify(evaluation.evidence),
    input.thresholdConfiguration.revision,
    JSON.stringify(input.thresholdConfiguration.thresholds),
    sourceRevision,
    ANALYTICS_SCHEMA_VERSION,
    input.computedAt,
    runId,
    input.computedAt,
    organizationId,
    fieldId,
  ));
  const auditStatement = client.prepare(`
    INSERT OR IGNORE INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at
    )
    SELECT ?, ?, ?, ?, 'analytics.projection.recomputed', 'analytics_projection', ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM analytics_projection_runs AS accepted_run
      WHERE accepted_run.id = ? AND accepted_run.computed_at = ?
    )
  `).bind(
    `analytics:${runId}`,
    organizationId,
    fieldId,
    input.actor,
    runId,
    JSON.stringify({
      period: window.period,
      sourceRevision,
      thresholdRevision: input.thresholdConfiguration.revision,
      schemaVersion: ANALYTICS_SCHEMA_VERSION,
      metricCount: input.projection.metrics.length,
      triggeredAlertCount: input.projection.alerts.length,
      qualityState: input.projection.quality.state,
    }),
    input.computedAt,
    runId,
    input.computedAt,
  );
  const results = await client.batch([
    runStatement,
    deactivatePreviousStatement,
    activateCurrentStatement,
    ...metricStatements,
    ...alertStatements,
    auditStatement,
  ]);
  if (changes(results[0]) !== 1) throw new AnalyticsConflictError();
  if (changes(results[2]) !== 1) throw new AnalyticsConflictError();
  const metricOffset = 3;
  if (results.slice(metricOffset, metricOffset + metricStatements.length).some((result) => changes(result) !== 1)) {
    throw new AnalyticsConflictError("No fue posible reemplazar el conjunto completo de métricas.");
  }
  const alertOffset = metricOffset + metricStatements.length;
  if (results.slice(alertOffset, alertOffset + alertStatements.length).some((result) => changes(result) !== 1)) {
    throw new AnalyticsConflictError("No fue posible reemplazar el conjunto completo de alertas.");
  }
}

async function getCurrentProjectionRevision(
  organizationId: string,
  fieldId: string,
  period: string,
): Promise<string | null> {
  const feature = effectiveAnalyticsFeature(organizationId, fieldId);
  const row = await getDb().$client.prepare(`
    SELECT run.source_revision AS sourceRevision
    FROM analytics_projection_runs AS run
    WHERE run.organization_id = ? AND run.field_id = ? AND run.period = ? AND run.is_current = 1
      AND ${feature.sql}
    ORDER BY run.computed_at DESC, run.id DESC
    LIMIT 1
  `).bind(organizationId, fieldId, period, ...feature.bindings).first<{ sourceRevision: string }>();
  return row?.sourceRevision ?? null;
}

function restoreProjection(run: ProjectionRunRow, metrics: MetricRow[], alerts: AlertRow[]): AnalyticsProjection & { computedAt: string } {
  const normalizedWindow = normalizeAnalyticsWindow({
    period: run.period,
    asOf: run.windowEnd,
  });
  const window: AnalyticsWindow = {
    ...normalizedWindow,
    period: run.period,
    start: run.windowStart,
    end: run.windowEnd,
    asOf: run.windowEnd,
    dayCount: dayCount(run.windowStart, run.windowEnd),
    comparison: {
      start: run.comparisonStart,
      end: run.comparisonEnd,
      dayCount: dayCount(run.comparisonStart, run.comparisonEnd),
    },
  };
  const restoredMetrics: AnalyticsMetric[] = metrics.map((metric) => ({
    key: metric.metricKey,
    status: metric.status,
    statusReason: metric.statusReason,
    value: metric.value,
    unit: metric.unit,
    numerator: metric.numerator,
    denominator: metric.denominator,
    sampleCount: metric.sampleCount,
    window,
    method: metric.method,
    references: parseJsonArray(metric.referencesJson),
  }));
  const alertEvaluations: AnalyticsAlert[] = alerts.map((evaluation) => ({
    code: evaluation.code,
    status: evaluation.status,
    severity: evaluation.severity,
    explanation: evaluation.explanation,
    evidence: parseJsonObject(evaluation.evidenceJson) as AnalyticsAlert["evidence"],
    window,
  }));
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    window,
    reference: {
      organizationId: run.organizationId,
      fieldId: run.fieldId,
      datasetRevision: run.sourceRevision,
      sourceCounts: parseNumberRecord(run.sourceCountsJson),
      sourceCoverage: {
        outcomesComplete: parseJsonObject(run.sourceCoverageJson).outcomesComplete === true,
      },
    },
    quality: {
      state: run.qualityState,
      issues: parseJsonArray(run.qualityIssuesJson),
      domains: parseStringRecord(run.qualityDomainsJson) as AnalyticsProjection["quality"]["domains"],
    },
    metrics: restoredMetrics,
    recommendationEngine: {
      version: ANALYTICS_RECOMMENDATION_ENGINE_VERSION,
      adapterId: RULE_BASED_RECOMMENDATION_ADAPTER_ID,
      strategy: "rules",
    },
    alertEvaluations,
    alerts: alertEvaluations.filter((evaluation) => evaluation.status === "triggered"),
    computedAt: run.computedAt,
  };
}

function restoreThresholdConfiguration(row: ThresholdRevisionRow | null): AnalyticsThresholdConfiguration {
  if (!row) {
    return {
      revision: DEFAULT_ANALYTICS_THRESHOLD_REVISION,
      thresholds: { ...DEFAULT_ANALYTICS_THRESHOLDS },
      source: "default",
      createdAt: null,
      createdBy: null,
    };
  }
  return {
    revision: row.revision,
    thresholds: normalizeAnalyticsThresholds(parseJsonObject(row.thresholdsJson)),
    source: "configured",
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  };
}

function thresholdConfigurationFromRun(run: ProjectionRunRow): AnalyticsThresholdConfiguration {
  return {
    revision: run.thresholdRevision,
    thresholds: normalizeAnalyticsThresholds(parseJsonObject(run.thresholdsJson)),
    source: run.thresholdRevision === DEFAULT_ANALYTICS_THRESHOLD_REVISION ? "default" : "configured",
    createdAt: null,
    createdBy: null,
  };
}

function currentThresholdStatement(
  actor: AccessContext,
  fieldId: string,
  access: { sql: string; bindings: D1Value[] },
): D1PreparedStatement {
  return getDb().$client.prepare(`
    SELECT revision, thresholds_json AS thresholdsJson, created_by AS createdBy, created_at AS createdAt
    FROM analytics_threshold_revisions
    WHERE organization_id = ? AND field_id = ? AND is_current = 1 AND ${access.sql}
    LIMIT 1
  `).bind(actor.organizationId, fieldId, ...access.bindings);
}

function normalizeCompleteThresholds(value: unknown): AnalyticsThresholds {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AnalyticsRequestError("Entrega el conjunto completo de umbrales analíticos.");
  }
  const record = value as Record<string, unknown>;
  const expectedKeys = Object.keys(DEFAULT_ANALYTICS_THRESHOLDS).sort();
  const receivedKeys = Object.keys(record).sort();
  if (expectedKeys.length !== receivedKeys.length || expectedKeys.some((key, index) => key !== receivedKeys[index])) {
    throw new AnalyticsRequestError("El conjunto de umbrales no coincide con la revisión analítica vigente.");
  }
  try {
    return normalizeAnalyticsThresholds(record);
  } catch (cause) {
    throw new AnalyticsRequestError(cause instanceof Error ? cause.message : "Los umbrales no son válidos.");
  }
}

function thresholdWriteAccess(actor: AccessContext, fieldId: string): { sql: string; bindings: D1Value[] } {
  const access = currentMemberAccess(actor, fieldId, true);
  return {
    sql: `(${access.sql}) AND EXISTS (
      SELECT 1 FROM fields AS writable_field
      WHERE writable_field.organization_id = ? AND writable_field.id = ? AND writable_field.is_demo = 0
    )`,
    bindings: [...access.bindings, actor.organizationId, fieldId],
  };
}

function currentThresholdRevisionGuard(
  organizationId: string,
  fieldId: string,
  expectedRevision: string,
): { sql: string; bindings: D1Value[] } {
  if (expectedRevision === DEFAULT_ANALYTICS_THRESHOLD_REVISION) {
    return {
      sql: `(
        NOT EXISTS (
          SELECT 1 FROM analytics_threshold_revisions AS current_threshold
          WHERE current_threshold.organization_id = ? AND current_threshold.field_id = ? AND current_threshold.is_current = 1
        )
        OR EXISTS (
          SELECT 1 FROM analytics_threshold_revisions AS current_threshold
          WHERE current_threshold.organization_id = ? AND current_threshold.field_id = ?
            AND current_threshold.revision = ? AND current_threshold.is_current = 1
        )
      )`,
      bindings: [organizationId, fieldId, organizationId, fieldId, expectedRevision],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM analytics_threshold_revisions AS current_threshold
      WHERE current_threshold.organization_id = ? AND current_threshold.field_id = ?
        AND current_threshold.revision = ? AND current_threshold.is_current = 1
    )`,
    bindings: [organizationId, fieldId, expectedRevision],
  };
}

function deterministicDemoComputedAt(window: AnalyticsWindow): string {
  return `${window.end}T23:59:59.000Z`;
}

function currentMemberAccess(actor: AccessContext, fieldId: string, requireManager: boolean): { sql: string; bindings: D1Value[] } {
  const feature = effectiveAnalyticsFeature(actor.organizationId, fieldId);
  return {
    sql: `
      EXISTS (
        SELECT 1 FROM organization_memberships AS current_member
        WHERE current_member.id = ?
          AND current_member.organization_id = ?
          AND current_member.normalized_email = ?
          AND current_member.status = 'active'
          AND current_member.role IN (${requireManager ? "'owner', 'admin', 'manager'" : "'owner', 'admin', 'manager', 'operator', 'viewer'"})
          AND (
            current_member.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_field_access
              WHERE current_field_access.membership_id = current_member.id
                AND current_field_access.field_id = ?
            )
          )
      )
      AND ${feature.sql}
    `,
    bindings: [
      actor.membershipId,
      actor.organizationId,
      actor.email,
      fieldId,
      ...feature.bindings,
    ],
  };
}

function effectiveAnalyticsFeature(organizationId: string, fieldId: string): { sql: string; bindings: D1Value[] } {
  return {
    sql: `
      COALESCE(
        (SELECT field_flag.enabled
          FROM organization_feature_flags AS field_flag
          WHERE field_flag.organization_id = ? AND field_flag.field_id = ? AND field_flag.feature = 'analitica'
          LIMIT 1),
        (SELECT global_flag.enabled
          FROM organization_feature_flags AS global_flag
          WHERE global_flag.organization_id = ? AND global_flag.field_id IS NULL AND global_flag.feature = 'analitica'
          LIMIT 1),
        0
      ) = 1
    `,
    bindings: [organizationId, fieldId, organizationId],
  };
}

function currentProjectionRevisionGuard(
  organizationId: string,
  fieldId: string,
  period: string,
  expectedSourceRevision: string | null,
): { sql: string; bindings: D1Value[] } {
  if (expectedSourceRevision === null) {
    return {
      sql: `NOT EXISTS (
        SELECT 1 FROM analytics_projection_runs AS current_projection
        WHERE current_projection.organization_id = ? AND current_projection.field_id = ?
          AND current_projection.period = ? AND current_projection.is_current = 1
      )`,
      bindings: [organizationId, fieldId, period],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM analytics_projection_runs AS current_projection
      WHERE current_projection.organization_id = ? AND current_projection.field_id = ?
        AND current_projection.period = ? AND current_projection.is_current = 1
        AND current_projection.source_revision = ?
    )`,
    bindings: [organizationId, fieldId, period, expectedSourceRevision],
  };
}

function sourceFingerprintStatement(organizationId: string, fieldId: string): D1PreparedStatement {
  const fingerprint = sourceFingerprintSql();
  return getDb().$client.prepare(`SELECT ${fingerprint.sql} AS fingerprint`).bind(...fingerprint.bindings(organizationId, fieldId));
}

function sourceFingerprintGuard(
  organizationId: string,
  fieldId: string,
  expectedFingerprint: string,
): { sql: string; bindings: D1Value[] } {
  const fingerprint = sourceFingerprintSql();
  return {
    sql: `${fingerprint.sql} = ?`,
    bindings: [...fingerprint.bindings(organizationId, fieldId), expectedFingerprint],
  };
}

function sourceFingerprintSql(): {
  sql: string;
  bindings(organizationId: string, fieldId: string): D1Value[];
} {
  return {
    sql: `json_array(
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM milk_bulk_production WHERE organization_id = ? AND field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '') FROM milk_quality_samples WHERE organization_id = ? AND field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(event.updated_at), '')
        FROM livestock_reproductive_events AS event
        INNER JOIN fields AS scoped_field ON scoped_field.id = event.field_id
        WHERE scoped_field.organization_id = ? AND event.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(lactation.updated_at), '')
        FROM livestock_lactations AS lactation
        INNER JOIN fields AS scoped_field ON scoped_field.id = lactation.field_id
        WHERE scoped_field.organization_id = ? AND lactation.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(control.updated_at), '')
        FROM livestock_milk_controls AS control
        INNER JOIN fields AS scoped_field ON scoped_field.id = control.field_id
        WHERE scoped_field.organization_id = ? AND control.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(weighing.created_at), '')
        FROM livestock_weighings AS weighing
        INNER JOIN livestock_animals AS animal ON animal.id = weighing.animal_id
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
        WHERE scoped_field.organization_id = ? AND lot.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(animal.updated_at), '')
        FROM livestock_animals AS animal
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
        WHERE scoped_field.organization_id = ? AND lot.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(health.updated_at), '')
        FROM livestock_health_events AS health
        INNER JOIN fields AS scoped_field ON scoped_field.id = health.field_id
        WHERE scoped_field.organization_id = ? AND health.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(consumption.created_at), '')
        FROM livestock_feed_consumptions AS consumption
        INNER JOIN fields AS scoped_field ON scoped_field.id = consumption.field_id
        WHERE scoped_field.organization_id = ? AND consumption.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), '') FROM livestock_expenses WHERE organization_id = ? AND field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(settlement.updated_at), '')
        FROM milk_settlements AS settlement
        INNER JOIN fields AS scoped_field ON scoped_field.id = settlement.field_id
        WHERE scoped_field.organization_id = ? AND settlement.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(lot.updated_at), '')
        FROM livestock_lots AS lot
        INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
        WHERE scoped_field.organization_id = ? AND lot.field_id = ?),
      (SELECT COUNT(*) || ':' || COALESCE(MAX(membership.updated_at), '')
        FROM livestock_lot_memberships AS membership
        INNER JOIN livestock_lots AS lot ON lot.id = membership.lot_id
        INNER JOIN fields AS scoped_field ON scoped_field.id = lot.field_id
        WHERE scoped_field.organization_id = ? AND lot.field_id = ?)
    )`,
    bindings(organizationId, fieldId) {
      return Array.from({ length: 13 }, () => [organizationId, fieldId]).flat();
    },
  };
}

function withSettlementProductionFallback(
  production: MilkRow[],
  settlements: SettlementRow[],
  window: AnalyticsWindow,
): MilkRow[] {
  const combined = [...production];
  if (!window.complete) return combined.sort(byDateAndId);
  const periods = new Set([
    window.comparison.start.slice(0, 7),
    window.start.slice(0, 7),
  ]);
  for (const period of periods) {
    if (combined.some((row) => row.date.slice(0, 7) === period)) continue;
    for (const settlement of settlements) {
      if (settlement.period !== period || !Number.isFinite(settlement.totalLiters) || settlement.totalLiters <= 0) continue;
      combined.push({
        id: `settlement:${settlement.id}`,
        date: `${period}-15`,
        liters: settlement.totalLiters,
        milkingCowCount: null,
      });
    }
  }
  return combined.sort(byDateAndId);
}

function buildDailyExposure(rows: ExposureAnimalRow[], window: AnalyticsWindow): LoadedSources["herdExposure"] {
  const exposure: LoadedSources["herdExposure"] = [];
  for (let date = window.start; date <= window.end; date = addChileDays(date, 1)) {
    const activeAnimals = rows.filter((row) => {
      const enteredAt = firstDate(row.purchaseDate, row.entryDate, row.birthDate, row.createdAt);
      if (!enteredAt || enteredAt > date) return false;
      const statusDate = dateKeyOrNull(row.statusDate);
      return row.status === "active" || !statusDate || statusDate > date;
    }).length;
    exposure.push({ id: `exposure:${date}`, date, activeAnimals });
  }
  return exposure;
}

function parseJobPayload(raw: Record<string, unknown>): AnalyticsRecomputeJobPayload {
  const organizationId = boundedText(raw.organizationId, 120);
  const fieldId = boundedText(raw.fieldId, 120);
  const period = normalizePeriod(raw.period);
  const cause = raw.cause;
  if (!organizationId || !fieldId || !["manual", "scheduled", "domain_events"].includes(String(cause))) {
    throw new AnalyticsRequestError("El trabajo de analítica no tiene un alcance válido.");
  }
  const expectedSourceRevision = raw.expectedSourceRevision === null || raw.expectedSourceRevision === undefined
    ? raw.expectedSourceRevision
    : boundedText(raw.expectedSourceRevision, 64);
  if (expectedSourceRevision !== undefined) assertSourceRevision(expectedSourceRevision);
  const requestedBy = boundedText(raw.requestedBy, 254) || undefined;
  return {
    schemaVersion: "fundosmart.analytics.recompute-job.v1",
    organizationId,
    fieldId,
    period,
    expectedSourceRevision,
    cause: cause as AnalyticsRecomputeJobPayload["cause"],
    requestedBy,
  };
}

function normalizePeriod(value: unknown): string {
  const period = boundedText(value, 7);
  try {
    const window = normalizeAnalyticsWindow(period);
    if (!window.period) throw new TypeError("missing period");
    return window.period;
  } catch {
    throw new AnalyticsRequestError("El período debe usar YYYY-MM.");
  }
}

function assertSourceRevision(value: string | null): void {
  if (value !== null && !SOURCE_REVISION.test(value)) {
    throw new AnalyticsRequestError("La revisión analítica esperada no es válida.");
  }
}

function restoreJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = restoreJson(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function parseJsonArray<T>(value: string): T[] {
  const parsed = restoreJson(value);
  return Array.isArray(parsed) ? parsed as T[] : [];
}

function parseNumberRecord(value: string): Record<string, number> {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
}

function parseStringRecord(value: string): Record<string, string> {
  const parsed = parseJsonObject(value);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function resultRows<T>(result: D1Result<unknown>): T[] {
  return (result.results ?? []) as T[];
}

function firstResult<T>(result: D1Result<unknown>): T | null {
  return resultRows<T>(result)[0] ?? null;
}

function changes(result: D1Result<unknown>): number {
  return Number(result.meta.changes ?? 0);
}

function dateKeyOrNull(value: string | null | undefined): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})/u.exec(value ?? "");
  return match?.[1] ?? null;
}

function firstDate(...values: Array<string | null>): string | null {
  for (const value of values) {
    const date = dateKeyOrNull(value);
    if (date) return date;
  }
  return null;
}

function dayCount(start: string, end: string): number {
  let count = 0;
  for (let date = start; date <= end; date = addChileDays(date, 1)) count += 1;
  return count;
}

function boundedText(value: unknown, maximum: number): string {
  return typeof value === "string" && value.trim().length <= maximum ? value.trim() : "";
}

function byDateAndId(left: { date: string; id: string }, right: { date: string; id: string }): number {
  return left.date.localeCompare(right.date) || left.id.localeCompare(right.id);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Periods read for an own-history comparison. Twenty-four covers two full seasons. */
const OWN_HISTORY_PERIOD_LIMIT = 24;

/**
 * Reads a field's metric history and compares it against itself.
 *
 * This deliberately shares nothing across tenants, which is what frees it from the
 * consent, cohort and `k`-threshold machinery that benchmarking has to carry. Demo
 * fields are included on purpose: the exclusion in Fase 5 exists to keep demo numbers
 * out of a shared cohort, and here nothing is shared — a demo workspace comparing its
 * own demo data is the feature working, not a leak.
 */
export async function getOwnHistoryComparison(input: {
  actor: AccessContext;
  fieldId: string;
  targetPeriod?: string;
  minimumBandPeriods?: number;
}): Promise<{
  field: { id: string; name: string; isDemo: boolean };
  comparison: OwnHistoryComparisonResult | null;
  periodsRead: number;
  reason: string | null;
}> {
  const client = getDb().$client;
  const access = currentMemberAccess(input.actor, input.fieldId, false);
  const targetPeriod = input.targetPeriod ? normalizePeriod(input.targetPeriod) : null;

  const [fieldResult, metricResult] = await client.batch([
    client.prepare(`
      SELECT current_field.id, current_field.name, current_field.is_demo AS isDemo
      FROM fields AS current_field
      WHERE current_field.id = ? AND current_field.organization_id = ?
        AND ${access.sql}
    `).bind(input.fieldId, input.actor.organizationId, ...access.bindings),
    client.prepare(`
      SELECT period, metric_key AS metricKey, status, status_reason AS statusReason, value, unit
      FROM analytics_herd_metrics
      WHERE organization_id = ? AND field_id = ?
        AND period IN (
          SELECT DISTINCT period FROM analytics_herd_metrics
          WHERE organization_id = ? AND field_id = ?
          ORDER BY period DESC
          LIMIT ?
        )
      ORDER BY period ASC, metric_key ASC
    `).bind(
      input.actor.organizationId,
      input.fieldId,
      input.actor.organizationId,
      input.fieldId,
      OWN_HISTORY_PERIOD_LIMIT,
    ),
  ]);

  const fieldRow = (fieldResult.results as { id: string; name: string; isDemo: number }[])[0];
  if (!fieldRow) throw new AnalyticsScopeError();
  const field = { id: fieldRow.id, name: fieldRow.name, isDemo: fieldRow.isDemo === 1 };

  const rows = metricResult.results as {
    period: string;
    metricKey: string;
    status: string;
    statusReason: string | null;
    value: number | null;
    unit: string;
  }[];

  const byPeriod = new Map<string, { period: string; metrics: { key: string; value: number | null; unit: string; status: string; statusReason: string | null }[] }>();
  for (const row of rows) {
    if (!byPeriod.has(row.period)) byPeriod.set(row.period, { period: row.period, metrics: [] });
    byPeriod.get(row.period)!.metrics.push({
      key: row.metricKey,
      value: row.value,
      unit: row.unit,
      status: row.status,
      statusReason: row.statusReason,
    });
  }
  const snapshots = [...byPeriod.values()];

  // A comparison needs something to compare against; saying so beats an empty screen.
  if (snapshots.length === 0) {
    return { field, comparison: null, periodsRead: 0, reason: "no_projected_periods" };
  }
  if (targetPeriod && !byPeriod.has(targetPeriod)) {
    return { field, comparison: null, periodsRead: snapshots.length, reason: "target_period_not_projected" };
  }
  if (snapshots.length === 1) {
    return { field, comparison: null, periodsRead: 1, reason: "single_period_history" };
  }

  return {
    field,
    comparison: compareAgainstOwnHistory(snapshots, {
      ...(targetPeriod ? { targetPeriod } : {}),
      ...(input.minimumBandPeriods === undefined ? {} : { minimumBandPeriods: input.minimumBandPeriods }),
    }),
    periodsRead: snapshots.length,
    reason: null,
  };
}
