import type { ImportRecord } from "../domain/types";

export type CooprinsemMilkControlCandidate = {
  controlDate: string;
  morningLiters: number | null;
  afternoonLiters: number | null;
  thirdMilkingLiters: number | null;
  totalLiters: number;
  fatPct: number | null;
  proteinPct: number | null;
  somaticCellCount: number | null;
};

export type CooprinsemMilkQualityCandidate = {
  sampledAt: string;
  period: string;
  kind: "laboratory";
  fatPercent: number | null;
  proteinPercent: number | null;
  totalSolidsPercent: number | null;
  somaticCellCount: number | null;
  somaticCellCountUnit: "cells_per_ml" | "thousand_cells_per_ml" | null;
  bacterialCount: number | null;
  bacterialCountUnit: "cfu_per_ml" | "thousand_cfu_per_ml" | null;
  sanitaryFlags: Record<string, never>;
  source: "cooprinsem_laboratory";
};

export function mapCooprinsemMilkControl(
  record: ImportRecord,
  options?: { effectiveAt?: string | null },
): { control: CooprinsemMilkControlCandidate | null; matchedFields: string[]; issues: string[] };

export function mapCooprinsemMilkQualitySample(
  record: ImportRecord,
  options?: {
    sampledAt?: string | null;
    somaticCellCountUnit?: "cells_per_ml" | "thousand_cells_per_ml" | null;
    bacterialCountUnit?: "cfu_per_ml" | "thousand_cfu_per_ml" | null;
  },
): { sample: CooprinsemMilkQualityCandidate | null; matchedFields: string[]; issues: string[] };
