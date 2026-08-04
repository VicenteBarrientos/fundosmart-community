import type {
  Activity,
  LivestockAnimal,
  LivestockExpense,
  LivestockLot,
  MilkSettlement,
} from "@/src/core/domain/types";

export type DashboardMilkMetrics = {
  grossAmountClp?: number;
  netAmountClp?: number;
  netPricePerLiterClp?: number;
  period: string;
  totalLiters: number;
};

export type DashboardMetrics = {
  activeAnimals: number;
  activeLots: number;
  latestMilk: DashboardMilkMetrics | null;
  latestWeightDate: string | null;
  litersPerMilkingCowDay: number | null;
  milkChangePercent: number | null;
  milkingCows: number;
  operatingResultClp: number | null;
  periodCostsClp: number | null;
  weightCoveragePercent: number | null;
};

export type DashboardActivityCost = {
  fieldId: string;
  period: string;
  costClp: number;
};

export function calculateDashboardMetrics(input: {
  activities: Activity[];
  activityCostsByPeriod?: DashboardActivityCost[] | null;
  animals: LivestockAnimal[];
  canViewFinance: boolean;
  expenses: LivestockExpense[];
  lots: LivestockLot[];
  settlements: MilkSettlement[];
}): DashboardMetrics;
