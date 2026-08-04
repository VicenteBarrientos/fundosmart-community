import type { AnalyticsProjection } from "./analytics-projection.mjs";

export type AnalyticsCsvDashboard = {
  field: { id: string; name: string; isDemo: boolean };
  projection: (AnalyticsProjection & { computedAt: string }) | null;
};

export function formatAnalyticsDate(value: string): string;
export function formatAnalyticsDateTime(value: string): string;
export function shiftAnalyticsPeriod(period: string, delta: number): string;
export function buildAnalyticsCsv(dashboard: AnalyticsCsvDashboard | null): string;

export function buildOwnHistoryCsv(input?: {
  comparison?: import("./own-history-comparison.d.mts").OwnHistoryComparisonResult | null;
  fieldName?: string;
}): string;
