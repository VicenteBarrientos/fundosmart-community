export const OWN_HISTORY_COMPARISON_VERSION: "fundosmart.analytics.own-history.v1";
export const DEFAULT_MINIMUM_BAND_PERIODS: 3;
export const DEFAULT_UNCHANGED_TOLERANCE_PCT: 1;

/** Canonical metric as produced by the Fase 3 projection. */
export type OwnHistoryMetric = {
  key: string;
  value: number | null;
  unit?: string | null;
  status: string;
  statusReason?: string | null;
};

export type OwnHistorySnapshot = {
  /** Civil period in `aaaa-mm`. */
  period: string;
  metrics: OwnHistoryMetric[];
};

export type OwnHistoryDeltaStatus = "available" | "insufficient_data";

export type OwnHistoryDelta = {
  basisPeriod: string | null;
  basisValue: number | null;
  deltaAbsolute: number | null;
  deltaPct: number | null;
  /** Stated as a fact; whether up is good belongs to the analytics thresholds. */
  direction: "up" | "down" | "flat" | null;
  status: OwnHistoryDeltaStatus;
  statusReason: string | null;
};

export type OwnHistoryBand = {
  status: "available" | "insufficient_data";
  statusReason: string | null;
  periodsUsed: number;
  periods?: string[];
  minimum: number | null;
  maximum: number | null;
  mean: number | null;
  position: "inside" | "above" | "below" | null;
};

export type OwnHistoryNote = {
  code: "SEASONAL_COMPARISON";
  message: string;
};

export type OwnHistoryComparison = {
  key: string;
  unit: string | null;
  target: {
    period: string;
    value: number | null;
    status: string;
    statusReason: string | null;
  };
  /** Always present: names the period it would have needed when that period is absent. */
  yearOverYear: OwnHistoryDelta;
  /** Null when the target is the first period in the series. */
  periodOverPeriod: OwnHistoryDelta | null;
  primary: "yearOverYear" | "periodOverPeriod" | null;
  band: OwnHistoryBand;
  verdict: "changed" | "unchanged" | "insufficient_data";
  reason: string | null;
  notes: OwnHistoryNote[];
};

export type OwnHistorySummary = {
  metricCount: number;
  changed: number;
  unchanged: number;
  insufficientData: number;
  yearOverYearCount: number;
  seasonalFallbackCount: number;
  outsideBandCount: number;
};

export type OwnHistoryComparisonResult = {
  schemaVersion: typeof OWN_HISTORY_COMPARISON_VERSION;
  targetPeriod: string;
  yearOverYearBasisPeriod: string | null;
  periodOverPeriodBasisPeriod: string | null;
  periodsAvailable: string[];
  minimumBandPeriods: number;
  comparisons: OwnHistoryComparison[];
  summary: OwnHistorySummary;
};

export type OwnHistoryAgendaSignal = {
  key: string;
  period: string;
  value: number | null;
  unit: string | null;
  position: "above" | "below";
  band: { minimum: number | null; maximum: number | null; periodsUsed: number };
  reason: string;
};

export function compareAgainstOwnHistory(
  snapshots: OwnHistorySnapshot[],
  options?: {
    targetPeriod?: string;
    minimumBandPeriods?: number;
    unchangedTolerancePct?: number;
  },
): OwnHistoryComparisonResult;

export function selectOwnHistoryAgendaSignals(
  comparison: OwnHistoryComparisonResult,
): OwnHistoryAgendaSignal[];
