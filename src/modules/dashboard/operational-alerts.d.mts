import type { DashboardMetrics } from "./dashboard-metrics.mjs";

export type OperationalAlertTone = "attention" | "warning" | "info";

export type OperationalAlert = {
  detail: string;
  href: string;
  id: string;
  title: string;
  tone: OperationalAlertTone;
};

export function buildOperationalAlerts(input: {
  availablePaddockCount: number;
  canViewFinance: boolean;
  lastActivityDate: string | null;
  metrics: DashboardMetrics;
  paddockCount: number;
  referenceDate: string;
}): OperationalAlert[];
