import type {
  MilkBulkProduction,
  MilkQualitySample,
  PabcoComplianceItem,
} from "@/src/core/domain/types";

export const MILK_MODULE_SECTIONS = [
  "settlements",
  "simulator",
  "production",
  "herd",
  "reproduction",
  "health",
] as const;

export type MilkModuleSection = (typeof MILK_MODULE_SECTIONS)[number];

export type MilkReconciliationPeriod = {
  fieldId: string;
  period: string;
  litersProduced: number;
  litersSettled: number;
  deltaLiters: number;
  deltaPercent: number | null;
  netAmountClp: number;
  realPricePerLiterClp: number | null;
};

export type MilkHerdAnimalSummary = {
  animalId: string;
  fieldId: string;
  tag: string;
  lotId: string;
  lotName: string;
  lactationId: string | null;
  lactationStatus: "active" | "dry" | "closed" | null;
  lactationNumber: number | null;
  daysInMilk: number | null;
  dryOffAlert: boolean;
  dryOffReason: "days_in_milk" | "low_production" | null;
  lastControlDate: string | null;
  lastLiters: number | null;
  fatPercent: number | null;
  proteinPercent: number | null;
  somaticCellCount: number | null;
  projected305Liters: number | null;
  rollingHerdAverageLiters: number | null;
  controlSeries: Array<{
    date: string;
    liters: number;
  }>;
};

export type MilkReproductionKpis = {
  openDaysAverage: number | null;
  calvingIntervalDaysAverage: number | null;
  pregnancyRatePercent: number | null;
  conceptionRatePercent: number | null;
  heatDetectionRatePercent: number | null;
};

export type MilkReproductionWorkItem = {
  animalId: string;
  fieldId: string;
  tag: string;
  lotName: string;
  action: "breed" | "pregnancy_check" | "dry_off" | "heat_watch";
  dueAt: string;
  reason: string;
};

export type MilkWithdrawalAlert = {
  eventId: string;
  animalId: string;
  fieldId: string;
  tag: string;
  condition: string | null;
  productName: string | null;
  milkUntil: string | null;
  meatUntil: string | null;
  noMilkDelivery: boolean;
};

export type MilkMammaryHealthSummary = {
  evaluatedAnimalCount: number;
  currentAnimalCount: number;
  staleAnimalCount: number;
  herdSomaticCellCount: number | null;
  herdStatus: "normal" | "elevated" | "high" | "critical" | "unknown";
  mastitisCaseCount: number;
  highRiskAnimalIds: string[];
};

export type MilkMammaryWorkItem = {
  animalId: string;
  fieldId: string;
  tag: string;
  lotName: string;
  priority: "urgent" | "high" | "medium" | "review";
  action: "review_now" | "review_soon" | "schedule_recheck" | "update_control";
  controlDate: string | null;
  ageDays: number | null;
  totalLiters: number | null;
  somaticCellCount: number | null;
  status: "normal" | "elevated" | "high" | "critical" | "unknown";
  trend: "increasing" | "decreasing" | "stable" | "unavailable";
  hasOpenMastitis: boolean;
  reasonCodes: string[];
};

export type MilkFieldMetrics = {
  fieldId: string;
  reproductionKpis: MilkReproductionKpis;
  mammaryHealth: MilkMammaryHealthSummary;
};

export type MilkModuleSnapshot = {
  asOf: string;
  bulkProduction: MilkBulkProduction[];
  qualitySamples: MilkQualitySample[];
  pabcoItems: PabcoComplianceItem[];
  reconciliation: MilkReconciliationPeriod[];
  herd: MilkHerdAnimalSummary[];
  reproduction: {
    kpis: MilkReproductionKpis;
    workItems: MilkReproductionWorkItem[];
  };
  withdrawals: MilkWithdrawalAlert[];
  mammaryHealth: MilkMammaryHealthSummary;
  mammaryWorkItems: MilkMammaryWorkItem[];
  fieldMetrics: MilkFieldMetrics[];
  generatedAt: string;
};

export type BulkMilkControlRowInput = {
  animalId: string;
  controlDate: string;
  morningLiters: number | null;
  afternoonLiters: number | null;
  thirdMilkingLiters: number | null;
  totalLiters: number;
  fatPercent: number | null;
  proteinPercent: number | null;
  somaticCellCount: number | null;
};

export type MilkOperationResource =
  "bulk_production" | "quality_sample" | "pabco_item" | "milk_controls";
