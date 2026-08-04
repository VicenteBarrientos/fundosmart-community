import type {
  Activity,
  Fundo,
  LivestockAnimal,
  LivestockExpense,
  LivestockLot,
  MilkSettlement,
  Potrero,
} from "@/src/core/domain/types";

export type OperationalReportFinance = {
  latestMilkNetAmountClp: number | null;
  latestMilkNetPricePerLiterClp: number | null;
  operatingResultClp: number | null;
  periodCostsClp: number | null;
};

export type OperationalReportRow = {
  activeAnimals: number;
  activeLots: number;
  activities30Days: number;
  availablePaddocks: number;
  coveragePercent: number;
  delimitedAreaHectares: number;
  fieldAreaHectares: number;
  fieldId: string;
  fieldName: string;
  finance?: OperationalReportFinance;
  grazingPaddocks: number;
  lastActivityDate: string | null;
  latestMilkPeriod: string | null;
  latestMilkTotalLiters: number | null;
  latestWeightDate: string | null;
  litersPerMilkingCowDay: number | null;
  milkChangePercent: number | null;
  milkingCows: number;
  paddockCount: number;
  restingPaddocks: number;
  weightCoveragePercent: number | null;
};

export type OperationalReport = {
  canViewFinance: boolean;
  fields: OperationalReportRow[];
  generatedAt: string;
  total: OperationalReportRow;
};

export function buildOperationalReport(input: {
  activities: Activity[];
  animals: LivestockAnimal[];
  canViewFinance: boolean;
  expenses: LivestockExpense[];
  fundos: Fundo[];
  generatedAt: string;
  lots: LivestockLot[];
  potreros: Potrero[];
  settlements: MilkSettlement[];
}): OperationalReport;
