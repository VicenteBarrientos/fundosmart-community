import type { LivestockHealthEvent, LivestockMilkControl } from "../../ganado/ficha/domain/types";

export type HealthRuleEvent = Pick<
  LivestockHealthEvent,
  | "id"
  | "animalId"
  | "eventType"
  | "occurredAt"
  | "status"
  | "condition"
  | "productName"
  | "withdrawalMilkUntil"
  | "withdrawalMeatUntil"
  | "notes"
  | "metadata"
>;

export type MammaryMilkControl = Pick<
  LivestockMilkControl,
  "animalId" | "controlDate" | "totalLiters" | "somaticCellCount"
>;

export type SomaticCellThresholds = { elevated: number; high: number; critical: number };
export type SomaticCellStatus = "normal" | "elevated" | "high" | "critical" | "unknown";

export const DEFAULT_SOMATIC_CELL_THRESHOLDS: Readonly<SomaticCellThresholds>;

export type WithdrawalEntry = {
  eventId: string;
  animalId: string;
  occurredAt: string;
  condition: string | null;
  productName: string | null;
  milkUntil: string | null;
  meatUntil: string | null;
  milkActive: boolean;
  meatActive: boolean;
  doNotDeliverMilk: boolean;
};

export type ActiveWithdrawals = {
  asOf: string;
  entries: WithdrawalEntry[];
  milk: WithdrawalEntry[];
  meat: WithdrawalEntry[];
  animalIdsWithMilkWithdrawal: string[];
  animalIdsWithMeatWithdrawal: string[];
};

export type MammaryAnimalMetric = {
  animalId: string;
  controlDate: string;
  ageDays: number;
  stale: boolean;
  totalLiters: number;
  somaticCellCount: number;
  status: SomaticCellStatus;
  trendPct: number | null;
  trend: "increasing" | "decreasing" | "stable" | "unavailable";
};

export type MastitisCase = {
  eventId: string;
  animalId: string;
  occurredAt: string;
  status: LivestockHealthEvent["status"];
  condition: string | null;
  active: boolean;
};

export type MammaryHealthMetrics = {
  asOf: string;
  evaluatedAnimalCount: number;
  currentAnimalCount: number;
  staleAnimalCount: number;
  herdSomaticCellCount: number | null;
  herdStatus: SomaticCellStatus;
  categoryCounts: Record<SomaticCellStatus, number>;
  animals: MammaryAnimalMetric[];
  mastitisCases: MastitisCase[];
  highRiskAnimalIds: string[];
};

export type MammaryWorkItem = {
  animalId: string;
  priority: "urgent" | "high" | "medium" | "review";
  action: "review_now" | "review_soon" | "schedule_recheck" | "update_control";
  controlDate: string | null;
  ageDays: number | null;
  totalLiters: number | null;
  somaticCellCount: number | null;
  status: SomaticCellStatus;
  trend: MammaryAnimalMetric["trend"];
  hasOpenMastitis: boolean;
  mastitisEventIds: string[];
  reasonCodes: Array<
    | "open_mastitis_case"
    | "critical_rcs"
    | "high_rcs"
    | "elevated_rcs"
    | "increasing_trend"
    | "stale_control"
  >;
};

export function buildActiveWithdrawals(events: HealthRuleEvent[], asOf: string | Date): ActiveWithdrawals;
export function classifySomaticCellCount(value: number | null, thresholds?: SomaticCellThresholds): SomaticCellStatus;
export function calculateMammaryHealth(
  controls: MammaryMilkControl[],
  healthEvents: HealthRuleEvent[],
  asOf: string | Date,
  options?: { maxControlAgeDays?: number; mastitisLookbackDays?: number; thresholds?: SomaticCellThresholds },
): MammaryHealthMetrics;
export function buildMammaryWorklist(mammaryHealth: MammaryHealthMetrics): MammaryWorkItem[];
