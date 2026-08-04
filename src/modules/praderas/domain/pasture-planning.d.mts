export class PastureDomainError extends Error {
  readonly code: string;
  constructor(message: string, code?: string);
}

export type NdviProviderDecision = Readonly<
  | { mode: "unconfigured"; providerKey: null; decidedAt: string }
  | { mode: "configured"; providerKey: string; decidedAt: string }
>;

export type ManualDryMatterInput =
  | { sampleKind: "direct"; kgDmPerHectare: number }
  | { sampleKind: "quadrat"; freshWeightGrams: number; dryMatterPercent: number; quadratAreaSquareMeters: number };

export type PasturePaddockInput = {
  id: string;
  name: string;
  areaHectares: number;
  currentKgDmPerHectare: number;
  residualKgDmPerHectare: number;
  utilizationPercent: number;
};

export type PastureHerdInput = {
  id?: string;
  animalCount: number;
  averageLiveWeightKg: number;
  intakePercentLiveWeight: number;
};

export function decideNdviProvider(input: { mode: "unconfigured" | "configured"; providerKey?: string | null; decidedAt: string }): NdviProviderDecision;
export function calculateManualDryMatter(input: ManualDryMatterInput): Readonly<{ method: "manual_direct" | "manual_quadrat"; kgDmPerHectare: number; evidence: Readonly<Record<string, string | number>> }>;
export function deriveBiomassObservation(raw: Record<string, unknown>, calibration?: Record<string, unknown> | null): Readonly<Record<string, unknown>>;
export function calculateGrowthRate(previous: { paddockId: string; capturedAt: string; kgDmPerHectare: number }, current: { paddockId: string; capturedAt: string; kgDmPerHectare: number }): Readonly<{ paddockId: string; from: string; to: string; elapsedDays: number; kgDmPerHaPerDay: number }>;
export function calculatePastureBudget(input: { herd: PastureHerdInput; paddocks: PasturePaddockInput[] }): Readonly<Record<string, unknown>>;
export function buildFeedWedge(input: { paddocks: PasturePaddockInput[]; entryTargetKgDmPerHectare: number; residualTargetKgDmPerHectare: number }): ReadonlyArray<Readonly<Record<string, string | number>>>;
export function planRotation(input: { startDate: string; horizonDays: number; maxPaddockDays: number; herd: PastureHerdInput & { id: string }; paddocks: PasturePaddockInput[]; entryTargetKgDmPerHectare: number; residualTargetKgDmPerHectare: number }): Readonly<Record<string, unknown>>;
export function planLotRotations(input: { startDate: string; horizonDays: number; maxPaddockDays: number; restDays: number; lots: Array<PastureHerdInput & { id: string; name: string }>; paddocks: Array<PasturePaddockInput & { cells?: Array<{ id: string; name: string }> }>; entryTargetKgDmPerHectare: number; residualTargetKgDmPerHectare: number }): Readonly<Record<string, unknown>>;
export function findRotationOverlaps(visits: Array<Record<string, unknown>>): ReadonlyArray<string>;
