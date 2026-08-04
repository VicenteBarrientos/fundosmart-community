import type { LivestockReproductiveEvent } from "../../ganado/ficha/domain/types";

export type ReproductiveMetricEvent = Pick<
  LivestockReproductiveEvent,
  "id" | "animalId" | "eventType" | "occurredAt" | "result" | "metadata"
>;

export type DaysOpenMetric = {
  days: number;
  status: "open" | "conceived" | "insufficient_data";
  reason?: string;
  calvingDate: string;
  conceptionDate: string | null;
};

export type CalvingIntervalMetric = {
  days: number;
  previousCalvingDate: string;
  latestCalvingDate: string;
  previousEventId?: string | null;
  latestEventId?: string | null;
  sourceRecordIds?: string[];
};

export type ReproductiveRates = {
  periodStart: string;
  periodEnd: string;
  eligibleAnimalCount: number;
  eligibleCycleCount: number;
  detectedHeatCycleCount: number;
  breedingAttemptCount: number;
  conceptionCount: number;
  heatDetectionRatePct: number | null;
  conceptionRatePct: number | null;
  pregnancyRatePct: number | null;
};

export type ReproductiveWorkItem = {
  animalId: string;
  dueDate: string;
  daysUntilDue: number;
  daysOverdue: number;
  basisEventId: string;
  reason: "observed_heat" | "breeding" | "confirmed_conception" | "last_heat_or_breeding" | "voluntary_wait_complete";
};

export type ReproductiveWorklists = {
  expectedHeat: ReproductiveWorkItem[];
  toInseminate: ReproductiveWorkItem[];
  pregnancyChecks: ReproductiveWorkItem[];
  dryOff: ReproductiveWorkItem[];
};

export function calculateDaysOpen(events: ReproductiveMetricEvent[], asOf: string | Date): DaysOpenMetric | null;
export function calculateCalvingInterval(events: ReproductiveMetricEvent[], asOf: string | Date): CalvingIntervalMetric | null;
export function calculateReproductiveRates(events: ReproductiveMetricEvent[], options: {
  periodStart: string | Date;
  periodEnd: string | Date;
  animalIds?: string[];
  voluntaryWaitingPeriodDays?: number;
  cycleDays?: number;
}): ReproductiveRates;
export function buildReproductiveWorklists(
  events: ReproductiveMetricEvent[],
  asOf: string | Date,
  options?: {
    lookAheadDays?: number;
    voluntaryWaitingPeriodDays?: number;
    cycleDays?: number;
    pregnancyCheckDays?: number;
    gestationDays?: number;
    dryPeriodDays?: number;
    inseminationWindowDays?: number;
  },
): ReproductiveWorklists;
export function isPositivePregnancyDiagnosis(event: ReproductiveMetricEvent): boolean;
