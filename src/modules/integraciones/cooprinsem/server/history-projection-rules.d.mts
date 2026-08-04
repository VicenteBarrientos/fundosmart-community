export const HISTORY_PROJECTION_FORMAT: "fundosmart.cooprinsem-history-assessment.v2";
export const COOPRINSEM_MILK_UNIT_CONTRACT_VERSION: "cooprinsem-leche-litros.v1";
export const COOPRINSEM_MILK_CANONICAL_UNIT: "liters";
export const COOPRINSEM_MILK_SOURCE_FIELDS: string[];

export type CooprinsemHistorySource = {
  importJobId: string | null;
  importRowId: string | null;
  sourceTable: string | null;
  sourceKey: string | null;
};

export type CooprinsemHistoricalRecordAssessment = {
  controlDate: string | null;
  milkControl: null | {
    state: "ready" | "blocked";
    controlDate: string | null;
    morningLiters: number | null;
    afternoonLiters: number | null;
    thirdMilkingLiters: number | null;
    totalLiters: number;
    fatPct: number | null;
    proteinPct: number | null;
    blockers: string[];
  };
  reproductiveServices: Array<{
    occurredAt: string | null;
    sireIdentifier: string | null;
    roles: string[];
    state: "ready" | "blocked";
    blockers: string[];
  }>;
};

export type CooprinsemHistoryEntry = {
  animalId: string;
  importJobId?: string;
  importRowId?: string;
  sourceTable?: string;
  sourceKey?: string | null;
  record: Record<string, unknown>;
  effectiveAt?: string | null;
};

export type CooprinsemHistoryWorkset = {
  milkControls: Array<{
    key: string;
    animalId: string;
    controlDate: string | null;
    morningLiters: number | null;
    afternoonLiters: number | null;
    thirdMilkingLiters: number | null;
    totalLiters: number;
    fatPct: number | null;
    proteinPct: number | null;
    state: "ready" | "blocked";
    blockers: string[];
    sources: CooprinsemHistorySource[];
  }>;
  reproductiveServices: Array<{
    key: string;
    animalId: string;
    occurredAt: string | null;
    sireIdentifier: string | null;
    roles: string[];
    state: "ready" | "blocked";
    blockers: string[];
    sources: CooprinsemHistorySource[];
  }>;
};

export type CooprinsemHistoryAssessment = {
  format: typeof HISTORY_PROJECTION_FORMAT;
  writeEnabled: false;
  eligibleRowCount: number;
  milkUnitContract: {
    requiredVersion: typeof COOPRINSEM_MILK_UNIT_CONTRACT_VERSION;
    confirmed: boolean;
    canonicalUnit: typeof COOPRINSEM_MILK_CANONICAL_UNIT | null;
  };
  milkControlCandidateCount: number;
  milkControlReadyCount: number;
  milkControlBlockedCount: number;
  reproductiveServiceCandidateCount: number;
  reproductiveServiceReadyCount: number;
  reproductiveServiceBlockedCount: number;
  blockers: string[];
};

export function assessCooprinsemHistoricalRecord(
  record: Record<string, unknown>,
  context?: { effectiveAt?: string | null; milkUnitContractVersion?: string | null },
): CooprinsemHistoricalRecordAssessment;

export function buildCooprinsemHistoryWorkset(
  entries: CooprinsemHistoryEntry[],
  options?: { milkUnitContractVersion?: string | null },
): CooprinsemHistoryWorkset;

export function buildCooprinsemHistoryAssessment(
  entries: CooprinsemHistoryEntry[],
  options?: { milkUnitContractVersion?: string | null },
): CooprinsemHistoryAssessment;
