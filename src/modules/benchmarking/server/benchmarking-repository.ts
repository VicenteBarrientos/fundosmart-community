import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import {
  aggregateBenchmarkContributions,
  BENCHMARK_METRIC_KEYS,
  BENCHMARK_SCHEMA_VERSION,
  BENCHMARK_TERMS_REVISION,
  DEFAULT_BENCHMARK_K,
  BenchmarkPrivacyError,
  benchmarkCohortKey,
  normalizeBenchmarkConsent,
  normalizeBenchmarkProfile,
  normalizeKThreshold,
  normalizePeriod,
  type BenchmarkAggregate,
  type BenchmarkContributionInput,
  type BenchmarkHerdSizeBand,
  type BenchmarkPrivatePosition,
  type BenchmarkProductionSystem,
  type BenchmarkProfile,
  type BenchmarkZone,
} from "../domain/benchmarking-rules.mjs";

const ANALYTICS_SCHEMA_VERSION = "fundosmart.analytics.projection.v1";
export const BENCHMARK_JOB_TYPE = "benchmark.aggregate.v1";

type ConsentStatus = "opted_in" | "opted_out";
type ConsentRow = {
  status: ConsentStatus | null;
  termsRevision: string | null;
  consentedAt: string | null;
  optedOutAt: string | null;
};
type ScopeRow = ConsentRow & {
  fieldId: string;
  fieldName: string;
  zone: string | null;
  herdSizeBand: string | null;
  productionSystem: string | null;
};
type AggregateRow = {
  cohortKey: string;
  metricKey: string;
  unit: string;
  status: "published" | "suppressed";
  kThreshold: number;
  p10: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  p90: number | null;
  ownValue: number | null;
  percentileRank: number | null;
  computedAt: string;
  authorizationSentinel: number;
};
type BenchmarkOperationEnvelope<T> = {
  schemaVersion: "fundosmart.benchmarking.operation.v1";
  requestHash: string;
  result: T;
};
type BenchmarkOperationRow = {
  action: string;
  entityType: string;
  entityId: string;
  after: string;
};
type AnalyticsContributionRow = {
  organizationId: string;
  fieldId: string;
  period: string;
  zone: string;
  herdSizeBand: string;
  productionSystem: string;
  metricKey: string;
  status: "available" | "partial";
  value: number;
  unit: string;
};
type ProjectionParticipant = {
  organizationId: string;
  fieldId: string;
  cohortKey: string;
  metricKey: string;
};

export type BenchmarkDashboard = {
  field: { id: string; name: string };
  period: string;
  eligible: boolean;
  reason: "demo_excluded" | "consent_required" | "profile_required" | null;
  consent: ConsentRow;
  profile: BenchmarkProfile | null;
  privacy: {
    schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
    peerRowsExposed: false;
    suppressedCountsHidden: true;
    exactParticipantCountsExposed: false;
  };
  metrics: Array<{
    metricKey: string;
    unit: string;
    status: "published" | "suppressed";
    kThreshold: number;
    percentiles: { p10: number; p25: number; p50: number; p75: number; p90: number } | null;
    own: { value: number; percentileRank: number } | null;
    computedAt: string;
  }>;
};

export class BenchmarkRepositoryError extends Error {
  constructor(message: string, public readonly code = "BENCHMARK_REPOSITORY_INVALID") {
    super(message);
    this.name = "BenchmarkRepositoryError";
  }
}

type BenchmarkPeriodJobResult = {
  period: string;
  aggregates: number;
  positions: number;
  skippedForConsentRace: number;
};

type BenchmarkRollingJobResult = {
  mode: "rolling";
  periods: BenchmarkPeriodJobResult[];
};

export async function getBenchmarkDashboard(input: {
  actor: AccessContext;
  fieldId: string;
  period: string;
}): Promise<BenchmarkDashboard> {
  const fieldId = scopedFieldId(input.actor, input.fieldId);
  const period = normalizePeriod(input.period);
  if (input.actor.email === DEMO_EMAIL) return demoDashboard(fieldId, period);

  const scope = await getDb().$client.prepare(`
    SELECT f.id AS fieldId, f.name AS fieldName,
      c.status, c.terms_revision AS termsRevision,
      c.consented_at AS consentedAt, c.opted_out_at AS optedOutAt,
      p.zone, p.herd_size_band AS herdSizeBand, p.production_system AS productionSystem
    FROM fields AS f
    LEFT JOIN benchmark_consents AS c ON c.organization_id = f.organization_id
    LEFT JOIN benchmark_field_profiles AS p
      ON p.organization_id = f.organization_id AND p.field_id = f.id
    WHERE f.id = ? AND f.organization_id = ? AND f.is_demo = 0
      AND ${fieldAccessGuardSql("f", false)}
    LIMIT 1
  `).bind(
    fieldId,
    input.actor.organizationId,
    ...fieldAccessGuardBindings(input.actor),
  ).first<ScopeRow>();
  if (!scope) throw new BenchmarkRepositoryError("El fundo no está disponible para benchmarking.", "BENCHMARK_SCOPE_INVALID");

  const consent = toConsent(scope);
  const profile = toProfile(scope);
  if (consent.status !== "opted_in" || consent.termsRevision !== BENCHMARK_TERMS_REVISION) {
    return emptyDashboard(scope, period, consent, profile, "consent_required");
  }
  if (!profile) return emptyDashboard(scope, period, consent, null, "profile_required");
  const cohortKey = benchmarkCohortKey({ period, ...profile });
  const rows = await getDb().$client.prepare(`
    WITH authorized AS (
      SELECT 1 AS allowed
      FROM fields AS auth_field
      WHERE auth_field.id = ? AND auth_field.organization_id = ? AND auth_field.is_demo = 0
        AND ${fieldAccessGuardSql("auth_field", false)}
      LIMIT 1
    ), metric_rows AS (
    SELECT a.cohort_key AS cohortKey, a.metric_key AS metricKey, a.unit,
      a.status, a.k_threshold AS kThreshold,
      a.p10, a.p25, a.p50, a.p75, a.p90,
      own.own_value AS ownValue, own.percentile_rank AS percentileRank,
      a.computed_at AS computedAt, 0 AS authorizationSentinel
    FROM benchmark_aggregates AS a
    INNER JOIN authorized ON authorized.allowed = 1
    INNER JOIN benchmark_consents AS current_consent
      ON current_consent.organization_id = ? AND current_consent.status = 'opted_in'
      AND current_consent.terms_revision = ? AND current_consent.updated_at <= a.computed_at
    INNER JOIN benchmark_field_profiles AS current_profile
      ON current_profile.organization_id = ? AND current_profile.field_id = ?
      AND current_profile.zone = a.zone
      AND current_profile.herd_size_band = a.herd_size_band
      AND current_profile.production_system = a.production_system
      AND current_profile.updated_at <= a.computed_at
    LEFT JOIN benchmark_positions AS own
      ON own.organization_id = ? AND own.field_id = ? AND own.period = a.period
      AND own.cohort_key = a.cohort_key AND own.metric_key = a.metric_key
      AND own.schema_version = a.schema_version
    WHERE a.period = ? AND a.cohort_key = ? AND a.schema_version = ?
      AND (
        own.id IS NOT NULL
        OR (
          a.status = 'suppressed'
          AND EXISTS (
            SELECT 1 FROM analytics_herd_metrics AS own_metric
            WHERE own_metric.organization_id = ? AND own_metric.field_id = ?
              AND own_metric.period = a.period AND own_metric.metric_key = a.metric_key
              AND own_metric.schema_version = ?
              AND own_metric.status IN ('available', 'partial')
              AND own_metric.value IS NOT NULL AND own_metric.computed_at <= a.computed_at
          )
        )
    )
    )
    SELECT * FROM metric_rows
    UNION ALL
    SELECT '' AS cohortKey, '' AS metricKey, '' AS unit, 'suppressed' AS status,
      0 AS kThreshold, NULL AS p10, NULL AS p25, NULL AS p50, NULL AS p75,
      NULL AS p90, NULL AS ownValue, NULL AS percentileRank, '' AS computedAt,
      1 AS authorizationSentinel
    FROM authorized
    ORDER BY authorizationSentinel, metricKey
  `).bind(
    fieldId,
    input.actor.organizationId,
    ...fieldAccessGuardBindings(input.actor),
    input.actor.organizationId,
    BENCHMARK_TERMS_REVISION,
    input.actor.organizationId,
    fieldId,
    input.actor.organizationId,
    fieldId,
    period,
    cohortKey,
    BENCHMARK_SCHEMA_VERSION,
    input.actor.organizationId,
    fieldId,
    ANALYTICS_SCHEMA_VERSION,
  ).all<AggregateRow>();
  if (!rows.results.some((row) => Number(row.authorizationSentinel) === 1)) {
    throw new BenchmarkRepositoryError("El fundo ya no está disponible para benchmarking.", "BENCHMARK_SCOPE_INVALID");
  }

  return {
    field: { id: scope.fieldId, name: scope.fieldName },
    period,
    eligible: true,
    reason: null,
    consent,
    profile,
    privacy: privacyContract(),
    metrics: rows.results.filter((row) => Number(row.authorizationSentinel) === 0).map(toDashboardMetric),
  };
}

export async function setBenchmarkConsent(input: {
  actor: AccessContext;
  fieldId: string;
  idempotencyKey: string;
  status: unknown;
  termsRevision: unknown;
  confirmed: unknown;
  now?: Date;
}): Promise<ConsentRow> {
  assertBenchmarkAdministrator(input.actor);
  if (input.actor.email === DEMO_EMAIL) throw new BenchmarkRepositoryError("La demo no puede participar.", "BENCHMARK_DEMO_FORBIDDEN");
  const fieldId = scopedFieldId(input.actor, input.fieldId);
  const consent = normalizeBenchmarkConsent({
    status: input.status,
    termsRevision: input.termsRevision,
    confirmed: input.confirmed,
  });
  const now = (input.now ?? new Date()).toISOString();
  const id = `benchmark-consent:${input.actor.organizationId}`;
  const before = await currentConsent(input.actor.organizationId);
  const after: ConsentRow = before?.status === consent.status && before.termsRevision === consent.termsRevision
    ? before
    : {
        status: consent.status,
        termsRevision: consent.termsRevision,
        consentedAt: consent.status === "opted_in" ? now : null,
        optedOutAt: consent.status === "opted_out" ? now : null,
      };
  const action = consent.status === "opted_in" ? "benchmark.consent.opted_in" : "benchmark.consent.opted_out";
  const operation = await benchmarkOperation(input.actor, fieldId, input.idempotencyKey, {
    action,
    entityType: "benchmark_consent",
    entityId: id,
    request: {
      organizationId: input.actor.organizationId,
      fieldId,
      status: consent.status,
      termsRevision: consent.termsRevision,
    },
    result: after,
  });
  const replay = await loadBenchmarkOperation<ConsentRow>(input.actor, fieldId, operation);
  if (replay) return replay;
  const client = getDb().$client;
  try {
    await client.batch([
      benchmarkOperationInsert(client, input.actor, fieldId, operation, before, now),
      client.prepare(`
        INSERT INTO benchmark_consents (
          id, organization_id, status, terms_revision, consented_by,
          consented_at, opted_out_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1 AND ${administratorFieldGuardSql("guard_field")}
        ON CONFLICT (organization_id) DO UPDATE SET
          status = excluded.status,
          terms_revision = excluded.terms_revision,
          consented_by = CASE WHEN benchmark_consents.status = excluded.status
            AND benchmark_consents.terms_revision IS excluded.terms_revision
            THEN benchmark_consents.consented_by ELSE excluded.consented_by END,
          consented_at = CASE WHEN benchmark_consents.status = excluded.status
            AND benchmark_consents.terms_revision IS excluded.terms_revision
            THEN benchmark_consents.consented_at ELSE excluded.consented_at END,
          opted_out_at = CASE WHEN benchmark_consents.status = excluded.status
            AND benchmark_consents.terms_revision IS excluded.terms_revision
            THEN benchmark_consents.opted_out_at ELSE excluded.opted_out_at END,
          updated_at = CASE WHEN benchmark_consents.status = excluded.status
            AND benchmark_consents.terms_revision IS excluded.terms_revision
            THEN benchmark_consents.updated_at ELSE excluded.updated_at END
      `).bind(
        id,
        input.actor.organizationId,
        consent.status,
        consent.termsRevision,
        input.actor.email,
        after.consentedAt,
        after.optedOutAt,
        now,
        now,
        ...administratorFieldGuardBindings(input.actor, fieldId),
      ),
      atomicityAssertion(client),
    ]);
  } catch (cause) {
    if (!isAtomicityRollback(cause)) throw cause;
    const racedReplay = await loadBenchmarkOperation<ConsentRow>(input.actor, fieldId, operation);
    if (racedReplay) return racedReplay;
    throw new BenchmarkRepositoryError("El alcance cambió antes de guardar el consentimiento.", "BENCHMARK_SCOPE_CONFLICT");
  }
  return after;
}

export async function saveBenchmarkProfile(input: {
  actor: AccessContext;
  fieldId: string;
  period: string;
  idempotencyKey: string;
  profile: unknown;
  now?: Date;
}): Promise<BenchmarkProfile> {
  assertBenchmarkAdministrator(input.actor);
  if (input.actor.email === DEMO_EMAIL) throw new BenchmarkRepositoryError("La demo no puede participar.", "BENCHMARK_DEMO_FORBIDDEN");
  const fieldId = scopedFieldId(input.actor, input.fieldId);
  const period = normalizePeriod(input.period);
  const profile = normalizeBenchmarkProfile(input.profile);
  const now = (input.now ?? new Date()).toISOString();
  const id = `benchmark-profile:${input.actor.organizationId}:${fieldId}`;
  const before = await currentProfile(input.actor.organizationId, fieldId);
  const operation = await benchmarkOperation(input.actor, fieldId, input.idempotencyKey, {
    action: "benchmark.profile.saved",
    entityType: "benchmark_field_profile",
    entityId: id,
    request: { organizationId: input.actor.organizationId, fieldId, period, profile },
    result: profile,
  });
  const replay = await loadBenchmarkOperation<BenchmarkProfile>(input.actor, fieldId, operation);
  if (replay) return replay;
  const client = getDb().$client;
  try {
    await client.batch([
      benchmarkOperationInsert(client, input.actor, fieldId, operation, before, now),
      client.prepare(`
        INSERT INTO benchmark_field_profiles (
          id, organization_id, field_id, zone, herd_size_band,
          production_system, updated_by, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE changes() = 1 AND ${administratorFieldGuardSql("guard_field")}
        ON CONFLICT (organization_id, field_id) DO UPDATE SET
          zone = excluded.zone,
          herd_size_band = excluded.herd_size_band,
          production_system = excluded.production_system,
          updated_by = CASE WHEN benchmark_field_profiles.zone = excluded.zone
            AND benchmark_field_profiles.herd_size_band = excluded.herd_size_band
            AND benchmark_field_profiles.production_system = excluded.production_system
            THEN benchmark_field_profiles.updated_by ELSE excluded.updated_by END,
          updated_at = CASE WHEN benchmark_field_profiles.zone = excluded.zone
            AND benchmark_field_profiles.herd_size_band = excluded.herd_size_band
            AND benchmark_field_profiles.production_system = excluded.production_system
            THEN benchmark_field_profiles.updated_at ELSE excluded.updated_at END
        WHERE (
          benchmark_field_profiles.zone = excluded.zone
          AND benchmark_field_profiles.herd_size_band = excluded.herd_size_band
          AND benchmark_field_profiles.production_system = excluded.production_system
        ) OR NOT (${profileSnapshotExistsSql("benchmark_field_profiles")})
      `).bind(
        id,
        input.actor.organizationId,
        fieldId,
        profile.zone,
        profile.herdSizeBand,
        profile.productionSystem,
        input.actor.email,
        now,
        now,
        ...administratorFieldGuardBindings(input.actor, fieldId),
      ),
      atomicityAssertion(client),
    ]);
  } catch (cause) {
    if (!isAtomicityRollback(cause)) throw cause;
    const racedReplay = await loadBenchmarkOperation<BenchmarkProfile>(input.actor, fieldId, operation);
    if (racedReplay) return racedReplay;
    if (await benchmarkProfileIsFrozen(input.actor, fieldId)) {
      throw new BenchmarkRepositoryError(
        "La clasificación está congelada porque el fundo ya participó en un snapshot. Se requiere una versión de perfil por período para cambiarla.",
        "BENCHMARK_PROFILE_FROZEN",
      );
    }
    throw new BenchmarkRepositoryError("El alcance cambió antes de guardar la cohorte.", "BENCHMARK_SCOPE_CONFLICT");
  }
  return profile;
}

export async function enqueueBenchmarkAggregation(input: {
  actor: AccessContext;
  fieldId: string;
  period: string;
  idempotencyKey: string;
  kThreshold?: unknown;
  now?: Date;
}): Promise<{ jobId: string; type: typeof BENCHMARK_JOB_TYPE; period: string }> {
  assertBenchmarkAdministrator(input.actor);
  if (input.actor.email === DEMO_EMAIL) throw new BenchmarkRepositoryError("La demo no puede ejecutar benchmarking.", "BENCHMARK_DEMO_FORBIDDEN");
  const fieldId = scopedFieldId(input.actor, input.fieldId);
  const period = normalizePeriod(input.period);
  const kThreshold = normalizeKThreshold(input.kThreshold ?? DEFAULT_BENCHMARK_K);
  const requestedAt = input.now ?? new Date();
  const now = requestedAt.toISOString();
  const jobId = `${BENCHMARK_JOB_TYPE}:${period}`;
  const result = { jobId, type: BENCHMARK_JOB_TYPE, period } as const;
  const operation = await benchmarkOperation(input.actor, fieldId, input.idempotencyKey, {
    action: "benchmark.recompute.enqueued",
    entityType: "scheduled_job",
    entityId: jobId,
    request: { organizationId: input.actor.organizationId, fieldId, period, kThreshold },
    result,
  });
  const replay = await loadBenchmarkOperation<typeof result>(input.actor, fieldId, operation);
  if (replay) return replay;
  if (kThreshold < DEFAULT_BENCHMARK_K) {
    throw new BenchmarkRepositoryError(
      `La solicitud no puede reducir el umbral de privacidad bajo ${DEFAULT_BENCHMARK_K}.`,
      "BENCHMARK_K_DOWNGRADE_FORBIDDEN",
    );
  }
  if (kThreshold !== DEFAULT_BENCHMARK_K) {
    throw new BenchmarkRepositoryError(
      `Las solicitudes tenant usan el umbral fijo ${DEFAULT_BENCHMARK_K}; solo un job central revisado puede cambiarlo.`,
      "BENCHMARK_K_OVERRIDE_FORBIDDEN",
    );
  }
  if (period !== rollingPeriods(requestedAt)[0]) {
    throw new BenchmarkRepositoryError(
      "Solo el período mensual abierto puede solicitarse manualmente; los períodos cerrados son inmutables.",
      "BENCHMARK_PERIOD_CLOSED",
    );
  }
  const client = getDb().$client;
  const rollingStatement = client.prepare(`
      INSERT INTO scheduled_jobs (
        id, organization_id, field_id, type, payload, status,
        due_at, interval_seconds, created_at, updated_at
      )
      SELECT ?, NULL, NULL, ?, json(?), 'active', ?, 86400, ?, ?
      WHERE ${administratorFieldGuardSql("guard_field")}
      ON CONFLICT (id) DO NOTHING
    `).bind(
      `${BENCHMARK_JOB_TYPE}:rolling`,
      BENCHMARK_JOB_TYPE,
      JSON.stringify({ mode: "rolling", kThreshold: DEFAULT_BENCHMARK_K }),
      now,
      now,
      now,
      ...administratorFieldGuardBindings(input.actor, fieldId),
    );
  try {
    await client.batch([
      benchmarkOperationInsert(client, input.actor, fieldId, operation, null, now),
      client.prepare(`
        INSERT INTO scheduled_jobs (
          id, organization_id, field_id, type, payload, status,
          due_at, interval_seconds, created_at, updated_at
        )
        SELECT ?, NULL, NULL, ?, json(?), 'active', ?, 86400, ?, ?
        WHERE changes() = 1 AND ${administratorFieldGuardSql("guard_field")}
        ON CONFLICT (id) DO NOTHING
      `).bind(
        jobId,
        BENCHMARK_JOB_TYPE,
        JSON.stringify({ period, kThreshold }),
        now,
        now,
        now,
        ...administratorFieldGuardBindings(input.actor, fieldId),
      ),
      atomicityAssertion(client),
      rollingStatement,
    ]);
  } catch (cause) {
    if (!isAtomicityRollback(cause)) throw cause;
    const racedReplay = await loadBenchmarkOperation<typeof result>(input.actor, fieldId, operation);
    if (racedReplay) return racedReplay;
    if (await benchmarkPeriodJobExists(input.actor, fieldId, jobId)) {
      throw new BenchmarkRepositoryError(
        "Este período ya tiene una solicitud durable; el job rodante aplicará las siguientes actualizaciones.",
        "BENCHMARK_RECOMPUTE_COOLDOWN",
      );
    }
    throw new BenchmarkRepositoryError("El alcance cambió antes de encolar el cálculo.", "BENCHMARK_SCOPE_CONFLICT");
  }
  return result;
}

/** Entry point for the shared dispatcher. It never reads transactional tables. */
export async function executeBenchmarkAggregationJob(job: {
  id?: string;
  type: string;
  payload: unknown;
  now?: Date;
}): Promise<BenchmarkPeriodJobResult | BenchmarkRollingJobResult> {
  if (job.type !== BENCHMARK_JOB_TYPE) throw new BenchmarkRepositoryError("El tipo de job no es compatible.");
  if (!job.payload || typeof job.payload !== "object" || Array.isArray(job.payload)) {
    throw new BenchmarkRepositoryError("El payload del job no es válido.");
  }
  const payload = job.payload as Record<string, unknown>;
  if (Object.keys(payload).some((key) => !["period", "kThreshold", "mode"].includes(key))) {
    throw new BenchmarkRepositoryError("El payload del job contiene campos no permitidos.");
  }
  const kThreshold = normalizeKThreshold(payload.kThreshold ?? DEFAULT_BENCHMARK_K);
  const now = job.now ?? new Date();
  const computedAt = now.toISOString();
  if (payload.mode === "rolling") {
    if (payload.period !== undefined) throw new BenchmarkRepositoryError("El job rodante no acepta un período fijo.");
    const periods = [];
    for (const period of rollingPeriods(now)) {
      periods.push(await executeBenchmarkPeriod({ period, kThreshold, computedAt }));
    }
    return { mode: "rolling", periods };
  }
  if (payload.mode !== undefined) throw new BenchmarkRepositoryError("El modo del job no es válido.");
  const period = normalizePeriod(payload.period);
  const result = await executeBenchmarkPeriod({ period, kThreshold, computedAt });
  if (job.id) await pauseCompletedPeriodJob(job.id);
  return result;
}

async function pauseCompletedPeriodJob(jobId: string): Promise<void> {
  const result = await getDb().$client.prepare(`
    UPDATE scheduled_jobs
    SET status = 'paused', updated_at = ?
    WHERE id = ? AND type = ? AND status = 'active'
  `).bind(new Date().toISOString(), jobId, BENCHMARK_JOB_TYPE).run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new BenchmarkRepositoryError("El job mensual perdió su reserva antes de cerrarse.", "BENCHMARK_JOB_LEASE_LOST");
  }
}

async function executeBenchmarkPeriod(input: {
  period: string;
  kThreshold: number;
  computedAt: string;
}): Promise<BenchmarkPeriodJobResult> {
  const { period, kThreshold, computedAt } = input;
  const contributionRows = await readDerivedContributions(period);
  const contributions = groupContributionRows(contributionRows);
  const projection = aggregateBenchmarkContributions(contributions, { kThreshold });
  const participants = projectionParticipants(contributionRows);
  const persisted = await replacePeriodProjection({ period, computedAt, participants, ...projection });
  return { period, ...persisted };
}

function rollingPeriods(now: Date): string[] {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now).map((part) => [part.type, part.value]));
  const current = `${parts.year}-${parts.month}`;
  if (parts.day !== "01") return [current];
  const previous = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 2, 1));
  return [current, `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`];
}

async function readDerivedContributions(period: string): Promise<AnalyticsContributionRow[]> {
  const allowedMetricPlaceholders = BENCHMARK_METRIC_KEYS.map(() => "?").join(", ");
  const result = await getDb().$client.prepare(`
    SELECT metric.organization_id AS organizationId, metric.field_id AS fieldId,
      metric.period, profile.zone,
      profile.herd_size_band AS herdSizeBand,
      profile.production_system AS productionSystem,
      metric.metric_key AS metricKey, metric.status, metric.value, metric.unit
    FROM analytics_herd_metrics AS metric
    INNER JOIN benchmark_consents AS consent
      ON consent.organization_id = metric.organization_id
      AND consent.status = 'opted_in' AND consent.terms_revision = ?
    INNER JOIN benchmark_field_profiles AS profile
      ON profile.organization_id = metric.organization_id AND profile.field_id = metric.field_id
    INNER JOIN fields AS field
      ON field.organization_id = metric.organization_id AND field.id = metric.field_id AND field.is_demo = 0
    WHERE metric.period = ? AND metric.schema_version = ?
      AND metric.status IN ('available', 'partial') AND metric.value IS NOT NULL
      AND metric.metric_key IN (${allowedMetricPlaceholders})
      AND COALESCE(
        (
          SELECT field_flag.enabled
          FROM organization_feature_flags AS field_flag
          WHERE field_flag.organization_id = metric.organization_id
            AND field_flag.field_id = metric.field_id
            AND field_flag.feature = 'benchmarking'
          LIMIT 1
        ),
        (
          SELECT global_flag.enabled
          FROM organization_feature_flags AS global_flag
          WHERE global_flag.organization_id = metric.organization_id
            AND global_flag.field_id IS NULL
            AND global_flag.feature = 'benchmarking'
          LIMIT 1
        ),
        0
      ) = 1
      AND metric.computed_at = (
        SELECT MAX(latest.computed_at) FROM analytics_herd_metrics AS latest
        WHERE latest.organization_id = metric.organization_id
          AND latest.field_id = metric.field_id
          AND latest.period = metric.period
          AND latest.metric_key = metric.metric_key
          AND latest.schema_version = metric.schema_version
      )
    ORDER BY metric.organization_id, metric.field_id, metric.metric_key
  `).bind(BENCHMARK_TERMS_REVISION, period, ANALYTICS_SCHEMA_VERSION, ...BENCHMARK_METRIC_KEYS).all<AnalyticsContributionRow>();
  return result.results;
}

function groupContributionRows(rows: AnalyticsContributionRow[]): BenchmarkContributionInput[] {
  const grouped = new Map<string, BenchmarkContributionInput>();
  for (const row of rows) {
    const key = `${row.organizationId}:${row.fieldId}`;
    const existing = grouped.get(key) ?? {
      organizationId: row.organizationId,
      fieldId: row.fieldId,
      period: row.period,
      dataMode: "real" as const,
      consentStatus: "opted_in" as const,
      profile: {
        zone: row.zone as BenchmarkZone,
        herdSizeBand: row.herdSizeBand as BenchmarkHerdSizeBand,
        productionSystem: row.productionSystem as BenchmarkProductionSystem,
      },
      metrics: [],
    };
    existing.metrics.push({
      key: row.metricKey as BenchmarkContributionInput["metrics"][number]["key"],
      status: row.status,
      value: Number(row.value),
      unit: row.unit,
      sourceSchemaVersion: ANALYTICS_SCHEMA_VERSION,
    });
    grouped.set(key, existing);
  }
  return [...grouped.values()];
}

function projectionParticipants(rows: AnalyticsContributionRow[]): ProjectionParticipant[] {
  const participants = new Map<string, ProjectionParticipant>();
  for (const row of rows) {
    const cohortKey = benchmarkCohortKey({
      period: row.period,
      zone: row.zone as BenchmarkZone,
      herdSizeBand: row.herdSizeBand as BenchmarkHerdSizeBand,
      productionSystem: row.productionSystem as BenchmarkProductionSystem,
    });
    const participant = {
      organizationId: row.organizationId,
      fieldId: row.fieldId,
      cohortKey,
      metricKey: row.metricKey,
    };
    participants.set(`${participant.organizationId}|${participant.fieldId}|${cohortKey}|${row.metricKey}`, participant);
  }
  return [...participants.values()];
}

async function replacePeriodProjection(input: {
  period: string;
  computedAt: string;
  kThreshold: number;
  aggregates: BenchmarkAggregate[];
  positions: BenchmarkPrivatePosition[];
  groupCounts: Array<{ cohortKey: string; metricKey: string; participantCount: number }>;
  participants: ProjectionParticipant[];
}): Promise<{ aggregates: number; positions: number; skippedForConsentRace: number }> {
  const participants = new Map<string, Array<{ organizationId: string; fieldId: string }>>();
  for (const participant of input.participants) {
    const key = `${participant.cohortKey}|${participant.metricKey}`;
    const current = participants.get(key) ?? [];
    current.push({ organizationId: participant.organizationId, fieldId: participant.fieldId });
    participants.set(key, current);
  }
  const aggregateRows = input.aggregates.map((aggregate) => ({
    id: `benchmark-aggregate:${aggregate.cohortKey}:${aggregate.metricKey}`,
    ...aggregate,
    participantCountStored: aggregate.status === "published"
      ? aggregate.participantCount
      : input.groupCounts.find((group) => group.cohortKey === aggregate.cohortKey && group.metricKey === aggregate.metricKey)?.participantCount ?? 0,
    participants: participants.get(`${aggregate.cohortKey}|${aggregate.metricKey}`) ?? [],
    computedAt: input.computedAt,
  }));
  const positionRows = input.positions.map((position) => ({
    id: `benchmark-position:${position.organizationId}:${position.fieldId}:${position.period}:${position.metricKey}`,
    ...position,
    cohort: input.aggregates.find((aggregate) => (
      aggregate.cohortKey === position.cohortKey && aggregate.metricKey === position.metricKey
    ))?.cohort,
    computedAt: input.computedAt,
  }));
  const client = getDb().$client;
  const [, aggregateInsert, , positionInsert] = await client.batch([
    client.prepare("DELETE FROM benchmark_aggregates WHERE period = ?").bind(input.period),
    client.prepare(`
      INSERT INTO benchmark_aggregates (
        id, cohort_key, period, zone, herd_size_band, production_system,
        metric_key, unit, status, participant_count, k_threshold,
        p10, p25, p50, p75, p90, schema_version, computed_at
      )
      SELECT
        json_extract(row.value, '$.id'),
        json_extract(row.value, '$.cohortKey'),
        json_extract(row.value, '$.period'),
        json_extract(row.value, '$.cohort.zone'),
        json_extract(row.value, '$.cohort.herdSizeBand'),
        json_extract(row.value, '$.cohort.productionSystem'),
        json_extract(row.value, '$.metricKey'),
        json_extract(row.value, '$.unit'),
        json_extract(row.value, '$.status'),
        json_extract(row.value, '$.participantCountStored'),
        json_extract(row.value, '$.kThreshold'),
        json_extract(row.value, '$.percentiles.p10'),
        json_extract(row.value, '$.percentiles.p25'),
        json_extract(row.value, '$.percentiles.p50'),
        json_extract(row.value, '$.percentiles.p75'),
        json_extract(row.value, '$.percentiles.p90'),
        json_extract(row.value, '$.schemaVersion'),
        json_extract(row.value, '$.computedAt')
      FROM json_each(?) AS row
      WHERE NOT EXISTS (
        SELECT 1 FROM json_each(json_extract(row.value, '$.participants')) AS participant
        LEFT JOIN benchmark_consents AS consent
          ON consent.organization_id = json_extract(participant.value, '$.organizationId')
          AND consent.status = 'opted_in' AND consent.terms_revision = ?
        LEFT JOIN fields AS field
          ON field.organization_id = json_extract(participant.value, '$.organizationId')
          AND field.id = json_extract(participant.value, '$.fieldId') AND field.is_demo = 0
        LEFT JOIN benchmark_field_profiles AS profile
          ON profile.organization_id = json_extract(participant.value, '$.organizationId')
          AND profile.field_id = json_extract(participant.value, '$.fieldId')
          AND profile.zone = json_extract(row.value, '$.cohort.zone')
          AND profile.herd_size_band = json_extract(row.value, '$.cohort.herdSizeBand')
          AND profile.production_system = json_extract(row.value, '$.cohort.productionSystem')
        WHERE consent.organization_id IS NULL OR field.id IS NULL OR profile.field_id IS NULL
          OR COALESCE(
            (
              SELECT field_flag.enabled FROM organization_feature_flags AS field_flag
              WHERE field_flag.organization_id = json_extract(participant.value, '$.organizationId')
                AND field_flag.field_id = json_extract(participant.value, '$.fieldId')
                AND field_flag.feature = 'benchmarking'
              LIMIT 1
            ),
            (
              SELECT global_flag.enabled FROM organization_feature_flags AS global_flag
              WHERE global_flag.organization_id = json_extract(participant.value, '$.organizationId')
                AND global_flag.field_id IS NULL
                AND global_flag.feature = 'benchmarking'
              LIMIT 1
            ),
            0
          ) <> 1
      )
    `).bind(JSON.stringify(aggregateRows), BENCHMARK_TERMS_REVISION),
    client.prepare("DELETE FROM benchmark_positions WHERE period = ?").bind(input.period),
    client.prepare(`
      INSERT INTO benchmark_positions (
        id, organization_id, field_id, cohort_key, period, metric_key,
        unit, own_value, percentile_rank, schema_version, computed_at
      )
      SELECT
        json_extract(row.value, '$.id'),
        json_extract(row.value, '$.organizationId'),
        json_extract(row.value, '$.fieldId'),
        json_extract(row.value, '$.cohortKey'),
        json_extract(row.value, '$.period'),
        json_extract(row.value, '$.metricKey'),
        json_extract(row.value, '$.unit'),
        json_extract(row.value, '$.ownValue'),
        json_extract(row.value, '$.percentileRank'),
        json_extract(row.value, '$.schemaVersion'),
        json_extract(row.value, '$.computedAt')
      FROM json_each(?) AS row
      INNER JOIN benchmark_consents AS consent
        ON consent.organization_id = json_extract(row.value, '$.organizationId')
        AND consent.status = 'opted_in' AND consent.terms_revision = ?
      INNER JOIN fields AS field
        ON field.organization_id = json_extract(row.value, '$.organizationId')
        AND field.id = json_extract(row.value, '$.fieldId') AND field.is_demo = 0
      INNER JOIN benchmark_field_profiles AS profile
        ON profile.organization_id = json_extract(row.value, '$.organizationId')
        AND profile.field_id = json_extract(row.value, '$.fieldId')
        AND profile.zone = json_extract(row.value, '$.cohort.zone')
        AND profile.herd_size_band = json_extract(row.value, '$.cohort.herdSizeBand')
        AND profile.production_system = json_extract(row.value, '$.cohort.productionSystem')
      INNER JOIN benchmark_aggregates AS aggregate
        ON aggregate.cohort_key = json_extract(row.value, '$.cohortKey')
        AND aggregate.period = json_extract(row.value, '$.period')
        AND aggregate.metric_key = json_extract(row.value, '$.metricKey')
        AND aggregate.schema_version = json_extract(row.value, '$.schemaVersion')
        AND aggregate.status = 'published'
      WHERE COALESCE(
        (
          SELECT field_flag.enabled FROM organization_feature_flags AS field_flag
          WHERE field_flag.organization_id = json_extract(row.value, '$.organizationId')
            AND field_flag.field_id = json_extract(row.value, '$.fieldId')
            AND field_flag.feature = 'benchmarking'
          LIMIT 1
        ),
        (
          SELECT global_flag.enabled FROM organization_feature_flags AS global_flag
          WHERE global_flag.organization_id = json_extract(row.value, '$.organizationId')
            AND global_flag.field_id IS NULL
            AND global_flag.feature = 'benchmarking'
          LIMIT 1
        ),
        0
      ) = 1
    `).bind(JSON.stringify(positionRows), BENCHMARK_TERMS_REVISION),
  ]);
  const aggregates = aggregateInsert.meta.changes ?? 0;
  const positions = positionInsert.meta.changes ?? 0;
  return {
    aggregates,
    positions,
    skippedForConsentRace: input.aggregates.length - aggregates,
  };
}

async function currentConsent(organizationId: string): Promise<ConsentRow | null> {
  return getDb().$client.prepare(`
    SELECT status, terms_revision AS termsRevision,
      consented_at AS consentedAt, opted_out_at AS optedOutAt
    FROM benchmark_consents WHERE organization_id = ? LIMIT 1
  `).bind(organizationId).first<ConsentRow>();
}

async function currentProfile(organizationId: string, fieldId: string): Promise<BenchmarkProfile | null> {
  const row = await getDb().$client.prepare(`
    SELECT zone, herd_size_band AS herdSizeBand, production_system AS productionSystem
    FROM benchmark_field_profiles
    WHERE organization_id = ? AND field_id = ?
    LIMIT 1
  `).bind(organizationId, fieldId).first<Pick<ScopeRow, "zone" | "herdSizeBand" | "productionSystem">>();
  return row ? toProfile({
    ...row,
    fieldId,
    fieldName: "",
    status: null,
    termsRevision: null,
    consentedAt: null,
    optedOutAt: null,
  }) : null;
}

type PreparedBenchmarkOperation<T> = {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  envelope: BenchmarkOperationEnvelope<T>;
};

async function benchmarkOperation<T>(
  actor: AccessContext,
  fieldId: string,
  idempotencyKey: string,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    request: unknown;
    result: T;
  },
): Promise<PreparedBenchmarkOperation<T>> {
  const key = requireIdempotencyKey(idempotencyKey);
  const keyHash = await sha256Text(`${actor.organizationId}|${key}`);
  const requestHash = await sha256Text(canonicalJson(input.request));
  return {
    id: `benchmark-operation:${keyHash}`,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    envelope: {
      schemaVersion: "fundosmart.benchmarking.operation.v1",
      requestHash: await sha256Text(canonicalJson({ fieldId, action: input.action, requestHash })),
      result: input.result,
    },
  };
}

function benchmarkOperationInsert<T>(
  client: ReturnType<typeof getDb>["$client"],
  actor: AccessContext,
  fieldId: string,
  operation: PreparedBenchmarkOperation<T>,
  before: unknown,
  occurredAt: string,
) {
  return client.prepare(`
    INSERT OR IGNORE INTO audit_log (
      id, organization_id, actor, action, entity_type, entity_id,
      before, after, occurred_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE ${administratorFieldGuardSql("guard_field")}
  `).bind(
    operation.id,
    actor.organizationId,
    actor.email,
    operation.action,
    operation.entityType,
    operation.entityId,
    before === null ? null : JSON.stringify(before),
    JSON.stringify(operation.envelope),
    occurredAt,
    ...administratorFieldGuardBindings(actor, fieldId),
  );
}

async function loadBenchmarkOperation<T>(
  actor: AccessContext,
  fieldId: string,
  operation: PreparedBenchmarkOperation<T>,
): Promise<T | null> {
  const row = await getDb().$client.prepare(`
    SELECT operation.action, operation.entity_type AS entityType,
      operation.entity_id AS entityId, operation.after
    FROM audit_log AS operation
    WHERE operation.id = ? AND operation.organization_id = ?
      AND ${administratorFieldGuardSql("guard_field")}
    LIMIT 1
  `).bind(
    operation.id,
    actor.organizationId,
    ...administratorFieldGuardBindings(actor, fieldId),
  ).first<BenchmarkOperationRow>();
  if (!row) return null;
  let envelope: BenchmarkOperationEnvelope<T> | null = null;
  try {
    envelope = JSON.parse(row.after) as BenchmarkOperationEnvelope<T>;
  } catch {
    // A deterministic operation id must never accept a legacy or malformed audit row.
  }
  if (!envelope ||
    row.action !== operation.action
    || row.entityType !== operation.entityType
    || row.entityId !== operation.entityId
    || envelope.schemaVersion !== "fundosmart.benchmarking.operation.v1"
    || envelope.requestHash !== operation.envelope.requestHash
  ) {
    throw new BenchmarkRepositoryError(
      "La clave de idempotencia ya fue usada con otra operación o contenido.",
      "BENCHMARK_IDEMPOTENCY_CONFLICT",
    );
  }
  return envelope.result;
}

function atomicityAssertion(client: ReturnType<typeof getDb>["$client"]) {
  return client.prepare(`
    SELECT CASE WHEN changes() = 1
      THEN 1 ELSE json_extract('BENCHMARK_ATOMICITY_VIOLATION', '$') END
  `);
}

function isAtomicityRollback(cause: unknown): boolean {
  return cause instanceof Error && cause.message.toLowerCase().includes("malformed json");
}

function requireIdempotencyKey(value: string): string {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(key)) {
    throw new BenchmarkRepositoryError(
      "La clave de idempotencia es obligatoria y debe tener entre 1 y 128 caracteres seguros.",
      "BENCHMARK_IDEMPOTENCY_KEY_INVALID",
    );
  }
  return key;
}

async function sha256Text(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

async function benchmarkProfileIsFrozen(actor: AccessContext, fieldId: string): Promise<boolean> {
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN ${profileSnapshotExistsSql("current_profile")} THEN 1 ELSE 0 END AS frozen
    FROM benchmark_field_profiles AS current_profile
    WHERE current_profile.organization_id = ? AND current_profile.field_id = ?
      AND ${administratorFieldGuardSql("guard_field")}
    LIMIT 1
  `).bind(
    actor.organizationId,
    fieldId,
    ...administratorFieldGuardBindings(actor, fieldId),
  ).first<{ frozen: number }>();
  return Number(row?.frozen) === 1;
}

async function benchmarkPeriodJobExists(actor: AccessContext, fieldId: string, jobId: string): Promise<boolean> {
  const row = await getDb().$client.prepare(`
    SELECT 1 AS found
    FROM scheduled_jobs AS job
    WHERE job.id = ? AND job.type = ?
      AND ${administratorFieldGuardSql("guard_field")}
    LIMIT 1
  `).bind(
    jobId,
    BENCHMARK_JOB_TYPE,
    ...administratorFieldGuardBindings(actor, fieldId),
  ).first<{ found: number }>();
  return Number(row?.found) === 1;
}

function profileSnapshotExistsSql(profileAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM benchmark_positions AS position
    WHERE position.organization_id = ${profileAlias}.organization_id
      AND position.field_id = ${profileAlias}.field_id
    UNION ALL
    SELECT 1
    FROM benchmark_aggregates AS snapshot
    INNER JOIN analytics_herd_metrics AS own_metric
      ON own_metric.organization_id = ${profileAlias}.organization_id
      AND own_metric.field_id = ${profileAlias}.field_id
      AND own_metric.period = snapshot.period
      AND own_metric.metric_key = snapshot.metric_key
      AND own_metric.schema_version = '${ANALYTICS_SCHEMA_VERSION}'
      AND own_metric.status IN ('available', 'partial')
      AND own_metric.value IS NOT NULL
      AND own_metric.computed_at <= snapshot.computed_at
    WHERE snapshot.schema_version = '${BENCHMARK_SCHEMA_VERSION}'
      AND snapshot.zone = ${profileAlias}.zone
      AND snapshot.herd_size_band = ${profileAlias}.herd_size_band
      AND snapshot.production_system = ${profileAlias}.production_system
    LIMIT 1
  )`;
}

function toConsent(row: ScopeRow): ConsentRow {
  return {
    status: row.status,
    termsRevision: row.termsRevision,
    consentedAt: row.consentedAt,
    optedOutAt: row.optedOutAt,
  };
}

function toProfile(row: ScopeRow): BenchmarkProfile | null {
  if (!row.zone || !row.herdSizeBand || !row.productionSystem) return null;
  try {
    return normalizeBenchmarkProfile({
      zone: row.zone,
      herdSizeBand: row.herdSizeBand,
      productionSystem: row.productionSystem,
    });
  } catch (cause) {
    if (cause instanceof BenchmarkPrivacyError) return null;
    throw cause;
  }
}

function toDashboardMetric(row: AggregateRow): BenchmarkDashboard["metrics"][number] {
  const published = row.status === "published";
  const percentiles = published && [row.p10, row.p25, row.p50, row.p75, row.p90].every((value) => value !== null)
    ? { p10: row.p10!, p25: row.p25!, p50: row.p50!, p75: row.p75!, p90: row.p90! }
    : null;
  return {
    metricKey: row.metricKey,
    unit: row.unit,
    status: row.status,
    kThreshold: Number(row.kThreshold),
    percentiles,
    own: published && row.ownValue !== null && row.percentileRank !== null
      ? { value: Number(row.ownValue), percentileRank: Number(row.percentileRank) }
      : null,
    computedAt: row.computedAt,
  };
}

function emptyDashboard(
  scope: ScopeRow,
  period: string,
  consent: ConsentRow,
  profile: BenchmarkProfile | null,
  reason: "consent_required" | "profile_required",
): BenchmarkDashboard {
  return {
    field: { id: scope.fieldId, name: scope.fieldName },
    period,
    eligible: false,
    reason,
    consent,
    profile,
    privacy: privacyContract(),
    metrics: [],
  };
}

function demoDashboard(fieldId: string, period: string): BenchmarkDashboard {
  return {
    field: { id: fieldId, name: "Cuenta demo" },
    period,
    eligible: false,
    reason: "demo_excluded",
    consent: { status: null, termsRevision: null, consentedAt: null, optedOutAt: null },
    profile: null,
    privacy: privacyContract(),
    metrics: [],
  };
}

function privacyContract() {
  return {
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    peerRowsExposed: false as const,
    suppressedCountsHidden: true as const,
    exactParticipantCountsExposed: false as const,
  };
}

function assertBenchmarkAdministrator(actor: AccessContext): void {
  if (!['owner', 'admin'].includes(actor.role)) {
    throw new BenchmarkRepositoryError("Solo propietarios y administradores pueden cambiar la participación.", "BENCHMARK_CAPABILITY_REQUIRED");
  }
}

function scopedFieldId(actor: AccessContext, value: string): string {
  const fieldId = String(value ?? "").trim();
  if (!fieldId || !actor.fieldIds.includes(fieldId)) {
    throw new BenchmarkRepositoryError("El fundo no está disponible para tu membresía.", "BENCHMARK_SCOPE_INVALID");
  }
  return fieldId;
}

function administratorFieldGuardSql(fieldAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM fields AS ${fieldAlias}
    WHERE ${fieldAlias}.id = ? AND ${fieldAlias}.organization_id = ?
      AND ${fieldAlias}.is_demo = 0
      AND ${fieldAccessGuardSql(fieldAlias, true)}
      AND ${fieldAlias}.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
  )`;
}

function administratorFieldGuardBindings(actor: AccessContext, fieldId: string): Array<string> {
  return [
    fieldId,
    actor.organizationId,
    ...fieldAccessGuardBindings(actor),
    JSON.stringify(actor.fieldIds),
  ];
}

function fieldAccessGuardSql(fieldAlias: string, requireAdministrator: boolean): string {
  const roleGuard = requireAdministrator
    ? "current_actor.role IN ('owner', 'admin')"
    : "current_actor.role IN ('owner', 'admin', 'manager', 'operator', 'viewer')";
  const fieldGuard = requireAdministrator
    ? "1 = 1"
    : `(current_actor.role IN ('owner', 'admin') OR EXISTS (
        SELECT 1 FROM membership_field_access AS current_access
        WHERE current_access.membership_id = current_actor.id
          AND current_access.field_id = ${fieldAlias}.id
      ))`;
  return `EXISTS (
    SELECT 1 FROM organization_memberships AS current_actor
    WHERE current_actor.id = ? AND current_actor.organization_id = ?
      AND current_actor.normalized_email = ? AND current_actor.status = 'active'
      AND ${roleGuard} AND ${fieldGuard}
  ) AND COALESCE(
    (
      SELECT field_flag.enabled FROM organization_feature_flags AS field_flag
      WHERE field_flag.organization_id = ${fieldAlias}.organization_id
        AND field_flag.field_id = ${fieldAlias}.id
        AND field_flag.feature = 'benchmarking'
      LIMIT 1
    ),
    (
      SELECT global_flag.enabled FROM organization_feature_flags AS global_flag
      WHERE global_flag.organization_id = ${fieldAlias}.organization_id
        AND global_flag.field_id IS NULL
        AND global_flag.feature = 'benchmarking'
      LIMIT 1
    ),
    0
  ) = 1`;
}

function fieldAccessGuardBindings(actor: AccessContext): Array<string> {
  return [actor.membershipId, actor.organizationId, actor.email];
}
