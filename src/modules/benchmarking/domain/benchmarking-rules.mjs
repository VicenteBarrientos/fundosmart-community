export const BENCHMARK_SCHEMA_VERSION = "fundosmart.benchmarking.aggregate.v1";
export const BENCHMARK_TERMS_REVISION = "fundosmart.benchmarking.consent.v1";
export const DEFAULT_BENCHMARK_K = 5;

export const BENCHMARK_ZONES = Object.freeze([
  "los_lagos",
  "los_rios",
  "araucania",
  "nuble_biobio",
  "other_chile",
]);

export const BENCHMARK_HERD_SIZE_BANDS = Object.freeze([
  "lt_50",
  "50_99",
  "100_199",
  "200_plus",
]);

export const BENCHMARK_PRODUCTION_SYSTEMS = Object.freeze([
  "pasture",
  "mixed",
  "confined",
]);

export const BENCHMARK_METRIC_KEYS = Object.freeze([
  "milk.volume_liters",
  "milk.production_per_cow_day_liters",
  "milk.somatic_cell_count",
  "reproduction.pregnancy_rate_pct",
  "reproduction.days_open_average",
  "reproduction.calving_interval_days_average",
  "weight.average_daily_gain_kg",
  "health.mastitis_rate_pct",
  "outcomes.mortality_rate_pct",
  "outcomes.discard_rate_pct",
  "finance.iofc_clp",
  "finance.feed_cost_clp",
  "finance.cost_per_liter_clp",
]);

const ANALYTICS_SCHEMA_VERSION = "fundosmart.analytics.projection.v1";
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/u;
const CONTRIBUTION_KEYS = Object.freeze([
  "organizationId",
  "fieldId",
  "period",
  "dataMode",
  "consentStatus",
  "profile",
  "metrics",
]);
const PROFILE_KEYS = Object.freeze(["zone", "herdSizeBand", "productionSystem"]);
const METRIC_KEYS = Object.freeze(["key", "status", "value", "unit", "sourceSchemaVersion"]);

export class BenchmarkPrivacyError extends Error {
  constructor(message, code = "BENCHMARK_PRIVACY_INVALID") {
    super(message);
    this.name = "BenchmarkPrivacyError";
    this.code = code;
  }
}

/**
 * Converts the deliberately narrow hand-off from Phase 3 into an internal
 * contribution. Full analytics projections are rejected because references,
 * evidence and source identifiers must never cross this boundary.
 */
export function normalizeBenchmarkContribution(input) {
  assertPlainObject(input, "La contribución de benchmarking no es válida.");
  assertOnlyKeys(input, CONTRIBUTION_KEYS, "La contribución contiene datos fuera de la frontera permitida.");
  const organizationId = requiredIdentifier(input.organizationId, "organización");
  const fieldId = requiredIdentifier(input.fieldId, "fundo");
  const period = normalizePeriod(input.period);
  if (input.dataMode !== "real") {
    throw new BenchmarkPrivacyError("Los datos demo o sintéticos no participan en benchmarking.", "BENCHMARK_DEMO_FORBIDDEN");
  }
  if (input.consentStatus !== "opted_in") {
    throw new BenchmarkPrivacyError("La organización no tiene consentimiento vigente.", "BENCHMARK_CONSENT_REQUIRED");
  }
  const profile = normalizeBenchmarkProfile(input.profile);
  if (!Array.isArray(input.metrics) || input.metrics.length === 0 || input.metrics.length > BENCHMARK_METRIC_KEYS.length) {
    throw new BenchmarkPrivacyError("La contribución debe contener métricas derivadas permitidas.");
  }

  const seen = new Set();
  const metrics = input.metrics.map((metric) => {
    assertPlainObject(metric, "Una métrica de benchmarking no es válida.");
    assertOnlyKeys(metric, METRIC_KEYS, "La métrica contiene evidencia o datos fuente no permitidos.");
    if (!BENCHMARK_METRIC_KEYS.includes(metric.key)) {
      throw new BenchmarkPrivacyError("La métrica no pertenece al catálogo publicable.");
    }
    if (seen.has(metric.key)) throw new BenchmarkPrivacyError("La contribución repite una métrica.");
    seen.add(metric.key);
    if (!['available', 'partial'].includes(metric.status)) {
      throw new BenchmarkPrivacyError("Solo métricas disponibles pueden entrar al agregado.");
    }
    if (metric.sourceSchemaVersion !== ANALYTICS_SCHEMA_VERSION) {
      throw new BenchmarkPrivacyError("La métrica no proviene del contrato vigente de Fase 3.");
    }
    const value = Number(metric.value);
    if (!Number.isFinite(value)) throw new BenchmarkPrivacyError("La métrica debe tener un valor finito.");
    const unit = String(metric.unit ?? "").trim();
    if (!/^[a-z][a-z0-9_]{0,39}$/u.test(unit)) {
      throw new BenchmarkPrivacyError("La unidad de la métrica no es válida.");
    }
    return { key: metric.key, value, unit };
  }).sort((left, right) => left.key.localeCompare(right.key));

  return {
    organizationId,
    fieldId,
    participantKey: `${organizationId}:${fieldId}`,
    period,
    profile,
    cohortKey: benchmarkCohortKey({ period, ...profile }),
    metrics,
  };
}

export function normalizeBenchmarkProfile(input) {
  assertPlainObject(input, "La clasificación de cohorte no es válida.");
  assertOnlyKeys(input, PROFILE_KEYS, "La clasificación contiene dimensiones no permitidas.");
  const profile = {
    zone: String(input.zone ?? "").trim(),
    herdSizeBand: String(input.herdSizeBand ?? "").trim(),
    productionSystem: String(input.productionSystem ?? "").trim(),
  };
  if (!BENCHMARK_ZONES.includes(profile.zone)) throw new BenchmarkPrivacyError("La zona no pertenece al catálogo de cohortes.");
  if (!BENCHMARK_HERD_SIZE_BANDS.includes(profile.herdSizeBand)) throw new BenchmarkPrivacyError("El tramo de rebaño no es válido.");
  if (!BENCHMARK_PRODUCTION_SYSTEMS.includes(profile.productionSystem)) throw new BenchmarkPrivacyError("El sistema productivo no es válido.");
  return profile;
}

export function benchmarkCohortKey(input) {
  const period = normalizePeriod(input?.period);
  const profile = normalizeBenchmarkProfile({
    zone: input?.zone,
    herdSizeBand: input?.herdSizeBand,
    productionSystem: input?.productionSystem,
  });
  return `${period}|${profile.zone}|${profile.herdSizeBand}|${profile.productionSystem}`;
}

/**
 * Builds public distributions and separately scoped private positions. Public
 * rows never contain participant identifiers or the underlying value vector.
 */
export function aggregateBenchmarkContributions(values, options = {}) {
  if (!Array.isArray(values)) throw new BenchmarkPrivacyError("Las contribuciones deben ser una lista.");
  const kThreshold = normalizeKThreshold(options.kThreshold ?? DEFAULT_BENCHMARK_K);
  const contributions = values.map(normalizeBenchmarkContribution);
  const groups = new Map();
  const uniqueness = new Set();

  for (const contribution of contributions) {
    for (const metric of contribution.metrics) {
      const duplicateKey = `${contribution.participantKey}|${contribution.period}|${metric.key}`;
      if (uniqueness.has(duplicateKey)) {
        throw new BenchmarkPrivacyError("Un fundo no puede aportar dos veces la misma métrica y período.");
      }
      uniqueness.add(duplicateKey);
      const groupKey = `${contribution.cohortKey}|${metric.key}|${metric.unit}`;
      const current = groups.get(groupKey) ?? [];
      current.push({ contribution, metric });
      groups.set(groupKey, current);
    }
  }

  const aggregates = [];
  const positions = [];
  const groupCounts = [];
  for (const [, rows] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
    rows.sort((left, right) => left.contribution.participantKey.localeCompare(right.contribution.participantKey));
    const first = rows[0];
    const valuesForMetric = rows.map((row) => row.metric.value).sort((left, right) => left - right);
    const participantCount = rows.length;
    const published = participantCount >= kThreshold;
    const aggregate = {
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      cohortKey: first.contribution.cohortKey,
      period: first.contribution.period,
      cohort: { ...first.contribution.profile },
      metricKey: first.metric.key,
      unit: first.metric.unit,
      status: published ? "published" : "suppressed",
      participantCount: published ? participantCount : null,
      kThreshold,
      percentiles: published ? {
        p10: percentile(valuesForMetric, 0.10),
        p25: percentile(valuesForMetric, 0.25),
        p50: percentile(valuesForMetric, 0.50),
        p75: percentile(valuesForMetric, 0.75),
        p90: percentile(valuesForMetric, 0.90),
      } : null,
    };
    aggregates.push(aggregate);
    groupCounts.push({
      cohortKey: aggregate.cohortKey,
      metricKey: aggregate.metricKey,
      participantCount,
    });
    if (!published) continue;
    for (const row of rows) {
      positions.push({
        schemaVersion: BENCHMARK_SCHEMA_VERSION,
        organizationId: row.contribution.organizationId,
        fieldId: row.contribution.fieldId,
        cohortKey: row.contribution.cohortKey,
        period: row.contribution.period,
        metricKey: row.metric.key,
        unit: row.metric.unit,
        ownValue: row.metric.value,
        percentileRank: empiricalPercentileRank(valuesForMetric, row.metric.value),
      });
    }
  }

  positions.sort((left, right) => positionKey(left).localeCompare(positionKey(right)));
  return { schemaVersion: BENCHMARK_SCHEMA_VERSION, kThreshold, aggregates, positions, groupCounts };
}

export function normalizeBenchmarkConsent(input) {
  assertPlainObject(input, "El consentimiento no es válido.");
  assertOnlyKeys(input, ["status", "termsRevision", "confirmed"], "El consentimiento contiene campos no permitidos.");
  if (!['opted_in', 'opted_out'].includes(input.status)) {
    throw new BenchmarkPrivacyError("Selecciona una decisión de consentimiento válida.");
  }
  if (input.status === "opted_in") {
    if (input.confirmed !== true) throw new BenchmarkPrivacyError("Debes confirmar expresamente la participación.", "BENCHMARK_EXPLICIT_CONSENT_REQUIRED");
    if (input.termsRevision !== BENCHMARK_TERMS_REVISION) {
      throw new BenchmarkPrivacyError("La versión del consentimiento no está vigente.", "BENCHMARK_TERMS_MISMATCH");
    }
  }
  return {
    status: input.status,
    termsRevision: input.status === "opted_in" ? BENCHMARK_TERMS_REVISION : null,
  };
}

export function normalizeKThreshold(value) {
  const k = Number(value);
  if (!Number.isSafeInteger(k) || k < 3 || k > 50) {
    throw new BenchmarkPrivacyError("El umbral k debe ser un entero entre 3 y 50.");
  }
  return k;
}

export function normalizePeriod(value) {
  const period = String(value ?? "").trim();
  if (!PERIOD_PATTERN.test(period)) throw new BenchmarkPrivacyError("El período debe usar YYYY-MM.");
  return period;
}

function percentile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const value = lower === upper
    ? sorted[lower]
    : sorted[lower] + ((sorted[upper] - sorted[lower]) * (index - lower));
  return round(value, 6);
}

function empiricalPercentileRank(sorted, value) {
  const less = sorted.filter((candidate) => candidate < value).length;
  const equal = sorted.filter((candidate) => candidate === value).length;
  return round(((less + (equal / 2)) / sorted.length) * 100, 2);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function positionKey(value) {
  return `${value.organizationId}|${value.fieldId}|${value.period}|${value.metricKey}`;
}

function requiredIdentifier(value, label) {
  const identifier = String(value ?? "").trim();
  if (!identifier || identifier.length > 128 || /[\u0000-\u001f]/u.test(identifier)) {
    throw new BenchmarkPrivacyError(`Falta el identificador de ${label}.`);
  }
  return identifier;
}

function assertPlainObject(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkPrivacyError(message);
}

function assertOnlyKeys(value, allowed, message) {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) throw new BenchmarkPrivacyError(message);
}
