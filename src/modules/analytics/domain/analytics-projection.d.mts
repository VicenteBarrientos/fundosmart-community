export type AnalyticsMetricStatus = "available" | "partial" | "insufficient_data" | "unavailable";
export type AnalyticsAlertStatus = "triggered" | "clear" | "unavailable";
export type AnalyticsAlertSeverity = "warning" | "critical";

export type AnalyticsWindow = {
  period: string | null;
  start: string;
  end: string;
  requestedEnd: string;
  asOf: string;
  complete: boolean;
  dayCount: number;
  timeZone: "America/Santiago";
  boundaries: "inclusive";
  comparison: { start: string; end: string; dayCount: number };
};

export type AnalyticsSourceReference = {
  kind: string;
  count: number;
  sourceIds: string[];
  observedFrom: string | null;
  observedThrough: string | null;
  subject?: {
    type: "animal" | "lot";
    id: string;
    label: string;
  };
};

export type AnalyticsMetric = {
  key: string;
  status: AnalyticsMetricStatus;
  statusReason: string | null;
  value: number | null;
  unit: string;
  numerator: number | null;
  denominator: number | null;
  sampleCount: number;
  window: AnalyticsWindow;
  method: string;
  references: AnalyticsSourceReference[];
};

export type AnalyticsAlert = {
  code: string;
  status: AnalyticsAlertStatus;
  severity: AnalyticsAlertSeverity;
  explanation: string;
  evidence: {
    metricKey: string;
    observed: number | null;
    operator: "lt" | "lte" | "gte";
    threshold: number;
    unit: string | null;
    numerator: number | null;
    denominator: number | null;
    sampleCount: number;
    subject?: {
      type: "animal";
      id: string;
      label: string;
    };
    observations?: Array<{
      date: string;
      value: number;
    }>;
    anchorDate?: string;
    anchorType?: string;
    expectedDate?: string;
    suppressedBy?: { date: string; eventType: string } | null;
  };
  window: AnalyticsWindow | null;
};

export type AnalyticsThresholds = {
  milkDropPct: number;
  somaticCellHigh: number;
  somaticCellCritical: number;
  mastitisRatePct: number;
  pregnancyRatePctMinimum: number;
  daysOpenMaximum: number;
  calvingIntervalDaysMaximum: number;
  averageDailyGainKgMinimum: number;
  mortalityRatePctMaximum: number;
  discardRatePctMaximum: number;
  iofcMinimumClp: number;
  expectedHeatCycleDays: number;
};

export type AnalyticsThresholdConfiguration = {
  revision: string;
  thresholds: AnalyticsThresholds;
  source: "default" | "configured";
  createdAt: string | null;
  createdBy: string | null;
};

type ReferencedFact = { id?: string; sourceId?: string };
type DatedFact = ReferencedFact & { date: string | Date };

export type AnalyticsProjectionInput = {
  organizationId?: string | null;
  fieldId?: string | null;
  datasetRevision?: string | null;
  outcomesComplete?: boolean;
  period?: string;
  start?: string | Date;
  end?: string | Date;
  asOf?: string | Date;
  window?: string | {
    period?: string | null;
    start?: string | Date;
    end?: string | Date;
    asOf?: string | Date;
    timeZone?: "America/Santiago";
  };
  milkProduction?: Array<DatedFact & {
    liters: number;
    milkingCowCount?: number | null;
  }>;
  milkQuality?: Array<DatedFact & {
    fatPct?: number | null;
    proteinPct?: number | null;
    somaticCellCount?: number | null;
    liters?: number | null;
  }>;
  reproductiveEvents?: Array<ReferencedFact & {
    animalId: string;
    animalLabel?: string | null;
    eventType: string;
    occurredAt: string | Date;
    result?: unknown;
    metadata?: unknown;
  }>;
  reproductiveAnimalIds?: string[];
  lactations?: Array<ReferencedFact & {
    animalId: string;
    animalLabel?: string | null;
    startedAt: string | Date;
    endedAt?: string | Date | null;
    status?: string | null;
  }>;
  milkControls?: Array<ReferencedFact & {
    animalId: string;
    animalLabel?: string | null;
    lactationId?: string | null;
    date: string | Date;
    totalLiters: number;
    somaticCellCount?: number | null;
    historicalLotId?: string | null;
    historicalLotName?: string | null;
  }>;
  weights?: Array<DatedFact & { animalId: string; weightKg: number }>;
  outcomes?: Array<DatedFact & {
    animalId: string;
    type: "death" | "discard" | "mastitis";
  }>;
  herdExposure?: Array<DatedFact & { activeAnimals: number }>;
  finances?: Array<DatedFact & {
    milkRevenueClp?: number | null;
    feedCostClp?: number | null;
    otherCostClp?: number | null;
  }>;
};

export type AnalyticsProjection = {
  schemaVersion: "fundosmart.analytics.projection.v1";
  window: AnalyticsWindow;
  reference: {
    organizationId: string | null;
    fieldId: string | null;
    datasetRevision: string | null;
    sourceCounts: Record<string, number>;
    sourceCoverage: { outcomesComplete: boolean };
  };
  quality: {
    state: "available" | "partial" | "unavailable";
    issues: Array<{ code: string; count: number }>;
    domains: Record<string, "available" | "partial" | "unavailable">;
  };
  metrics: AnalyticsMetric[];
  recommendationEngine: {
    version: "fundosmart.analytics.recommendation-engine.v1";
    adapterId: string;
    strategy: "rules";
  };
  alertEvaluations: AnalyticsAlert[];
  alerts: AnalyticsAlert[];
};

export const ANALYTICS_SCHEMA_VERSION: "fundosmart.analytics.projection.v1";
export const ANALYTICS_TIME_ZONE: "America/Santiago";
export const DEFAULT_ANALYTICS_THRESHOLDS: Readonly<AnalyticsThresholds>;
export const DEFAULT_ANALYTICS_THRESHOLD_REVISION: "5bd5eadb9ae99326057b24198669677b0748f1e1b3a412d46d3ca96263a81685";

export function normalizeAnalyticsThresholds(
  thresholds?: Partial<AnalyticsThresholds> | null,
): AnalyticsThresholds;

export function normalizeAnalyticsWindow(input: string | {
  period?: string;
  start?: string | Date;
  end?: string | Date;
  asOf?: string | Date;
  timeZone?: "America/Santiago";
}): AnalyticsWindow;

export function buildAnalyticsProjection(
  input: AnalyticsProjectionInput,
  options?: {
    thresholds?: Partial<AnalyticsThresholds>;
    recommendationEngine?: import("./recommendation-engine.mjs").AnalyticsRecommendationEngine<{
      metrics: AnalyticsMetric[];
      reproductiveEvents: Array<Record<string, unknown>>;
      thresholds: AnalyticsThresholds;
      window: AnalyticsWindow;
    }>;
  },
): AnalyticsProjection;

export function evaluateAnalyticsAlerts(
  input: AnalyticsMetric[] | { metrics: AnalyticsMetric[]; window?: AnalyticsWindow },
  thresholds?: Partial<AnalyticsThresholds>,
): AnalyticsAlert[];

export function evaluateExpectedHeatAlerts(
  reproductiveEvents: Array<Record<string, unknown>>,
  window: AnalyticsWindow,
  thresholds?: Partial<AnalyticsThresholds>,
): AnalyticsAlert[];
