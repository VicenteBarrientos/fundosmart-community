export type BenchmarkZone = "los_lagos" | "los_rios" | "araucania" | "nuble_biobio" | "other_chile";
export type BenchmarkHerdSizeBand = "lt_50" | "50_99" | "100_199" | "200_plus";
export type BenchmarkProductionSystem = "pasture" | "mixed" | "confined";
export type BenchmarkConsentStatus = "opted_in" | "opted_out";
export type BenchmarkAggregateStatus = "published" | "suppressed";
export type BenchmarkMetricKey =
  | "milk.volume_liters"
  | "milk.production_per_cow_day_liters"
  | "milk.somatic_cell_count"
  | "reproduction.pregnancy_rate_pct"
  | "reproduction.days_open_average"
  | "reproduction.calving_interval_days_average"
  | "weight.average_daily_gain_kg"
  | "health.mastitis_rate_pct"
  | "outcomes.mortality_rate_pct"
  | "outcomes.discard_rate_pct"
  | "finance.iofc_clp"
  | "finance.feed_cost_clp"
  | "finance.cost_per_liter_clp";

export type BenchmarkProfile = {
  zone: BenchmarkZone;
  herdSizeBand: BenchmarkHerdSizeBand;
  productionSystem: BenchmarkProductionSystem;
};

export type BenchmarkContributionInput = {
  organizationId: string;
  fieldId: string;
  period: string;
  dataMode: "real" | "demo";
  consentStatus: "opted_in" | "opted_out";
  profile: BenchmarkProfile;
  metrics: Array<{
    key: BenchmarkMetricKey;
    status: "available" | "partial" | "insufficient_data" | "unavailable";
    value: number | null;
    unit: string;
    sourceSchemaVersion: "fundosmart.analytics.projection.v1";
  }>;
};

export type BenchmarkContribution = {
  organizationId: string;
  fieldId: string;
  participantKey: string;
  period: string;
  profile: BenchmarkProfile;
  cohortKey: string;
  metrics: Array<{ key: BenchmarkMetricKey; value: number; unit: string }>;
};

export type BenchmarkAggregate = {
  schemaVersion: "fundosmart.benchmarking.aggregate.v1";
  cohortKey: string;
  period: string;
  cohort: BenchmarkProfile;
  metricKey: BenchmarkMetricKey;
  unit: string;
  status: "published" | "suppressed";
  participantCount: number | null;
  kThreshold: number;
  percentiles: null | { p10: number; p25: number; p50: number; p75: number; p90: number };
};

export type BenchmarkPrivatePosition = {
  schemaVersion: "fundosmart.benchmarking.aggregate.v1";
  organizationId: string;
  fieldId: string;
  cohortKey: string;
  period: string;
  metricKey: BenchmarkMetricKey;
  unit: string;
  ownValue: number;
  percentileRank: number;
};

export class BenchmarkPrivacyError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}

export const BENCHMARK_SCHEMA_VERSION: "fundosmart.benchmarking.aggregate.v1";
export const BENCHMARK_TERMS_REVISION: "fundosmart.benchmarking.consent.v1";
export const DEFAULT_BENCHMARK_K: 5;
export const BENCHMARK_ZONES: readonly BenchmarkZone[];
export const BENCHMARK_HERD_SIZE_BANDS: readonly BenchmarkHerdSizeBand[];
export const BENCHMARK_PRODUCTION_SYSTEMS: readonly BenchmarkProductionSystem[];
export const BENCHMARK_METRIC_KEYS: readonly BenchmarkMetricKey[];

export function normalizeBenchmarkContribution(input: BenchmarkContributionInput): BenchmarkContribution;
export function normalizeBenchmarkProfile(input: unknown): BenchmarkProfile;
export function benchmarkCohortKey(input: BenchmarkProfile & { period: string }): string;
export function aggregateBenchmarkContributions(
  values: BenchmarkContributionInput[],
  options?: { kThreshold?: number },
): {
  schemaVersion: typeof BENCHMARK_SCHEMA_VERSION;
  kThreshold: number;
  aggregates: BenchmarkAggregate[];
  positions: BenchmarkPrivatePosition[];
  groupCounts: Array<{ cohortKey: string; metricKey: BenchmarkMetricKey; participantCount: number }>;
};
export function normalizeBenchmarkConsent(input: unknown): {
  status: "opted_in" | "opted_out";
  termsRevision: typeof BENCHMARK_TERMS_REVISION | null;
};
export function normalizeKThreshold(value: unknown): number;
export function normalizePeriod(value: unknown): string;
