import type {
  LivestockLactation,
  LivestockMilkControl,
} from "../../ganado/ficha/domain/types";

export type LactationMetricInput = Pick<
  LivestockLactation,
  "id" | "animalId" | "startedAt" | "endedAt" | "status"
> &
  Partial<Pick<LivestockLactation, "calvingDate">>;

export type MilkControlMetricInput = Pick<
  LivestockMilkControl,
  "animalId" | "lactationId" | "controlDate" | "totalLiters"
>;

export type CurrentProduction = {
  controlDate: string;
  liters: number;
  ageDays: number;
};

export type DryOffRecommendation = {
  shouldDryOff: boolean;
  reason: "days_in_milk" | "low_production" | null;
};

export type Lactation305Projection = {
  startDate: string;
  throughDate: string;
  controlCount: number;
  observedDays: number;
  estimatedToDateLiters: number;
  projected305Liters: number;
  method: "nearest-test-day-carry-forward";
};

export type RollingHerdAverage = {
  windowStart: string;
  windowEnd: string;
  cowCount: number;
  estimatedMilkLiters: number;
  litersPerCow: number | null;
  method: "365-day-nearest-test-day";
};

export function calculateDaysInMilk(
  lactation: LactationMetricInput,
  asOf: string | Date,
): number | null;
export function getCurrentProduction(
  lactation: LactationMetricInput,
  controls: MilkControlMetricInput[],
  asOf: string | Date,
): CurrentProduction | null;
export function evaluateDryOffRecommendation(
  input: {
    lactationStatus: LactationMetricInput["status"] | null;
    daysInMilk: number | null;
    latestLiters: number | null;
  },
  options?: {
    maxDaysInMilk?: number;
    lowProductionLiters?: number;
    minimumDaysForLowProduction?: number;
  },
): DryOffRecommendation;
export function calculate305DayProjection(
  lactation: LactationMetricInput,
  controls: MilkControlMetricInput[],
  asOf: string | Date,
): Lactation305Projection | null;
export function calculateRollingHerdAverage(input: {
  lactations: LactationMetricInput[];
  controls: MilkControlMetricInput[];
  asOf: string | Date;
}): RollingHerdAverage;
