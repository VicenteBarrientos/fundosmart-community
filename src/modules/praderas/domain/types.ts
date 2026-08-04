import type { ManualDryMatterInput, NdviProviderDecision } from "./pasture-planning.mjs";

export type PastureProviderMode = "unconfigured" | "configured";
export type PastureCalibrationStatus = "draft" | "active" | "retired";
export type PastureObservationSourceKind = "manual" | "ndvi";
export type PastureObservationStorageStatus = "pending" | "stored";
export type PastureBiomassMethod = "manual_direct" | "manual_quadrat" | "ndvi_linear_calibration";
export type PastureRotationPlanStatus = "feasible" | "infeasible";
export const PASTURE_CDSE_PROVIDER_KEY = "cdse-sentinel-2";

export type PastureProviderStatus = NdviProviderDecision | {
  mode: "unconfigured";
  providerKey: null;
  decidedAt: null;
};

export type PastureBiomassEstimate = {
  id: string;
  observationId: string;
  paddockId: string;
  paddockName: string;
  sourceKind: "manual" | "ndvi";
  method: string;
  kgDmPerHectare: number;
  calibrationId: string | null;
  capturedAt: string;
  computedAt: string;
};

export type PastureGrowthRate = {
  paddockId: string;
  paddockName: string;
  status: "available" | "insufficient_data";
  statusReason: string | null;
  from: string | null;
  to: string | null;
  elapsedDays: number | null;
  kgDmPerHaPerDay: number | null;
};

export type PasturePaddockSnapshot = {
  id: string;
  name: string;
  areaHectares: number;
  latestEstimate: PastureBiomassEstimate | null;
};

export type PasturePlanningLotBasis = {
  id: string;
  name: string;
  animalCount: number;
  animalCountSource: "individual_active_animals" | "lot_summary";
  averageLiveWeightKg: number | null;
  averageLiveWeightSource: "latest_individual_weighings" | "lot_average" | "unavailable";
  weightSampleCount: number;
  dailyGrossDemandKgDm: number | null;
  ration: null | {
    productName: string;
    kgPerAnimalDayAsFed: number;
    dailyQuantityKgAsFed: number;
    unitCostClpPerKg: number | null;
    projectedDailyCostClp: number | null;
  };
};

export type PasturePlanningBasis = {
  status: "available" | "unavailable";
  statusReason: string | null;
  herdId: string | null;
  animalCount: number;
  weightedAverageLiveWeightKg: number | null;
  intakePercentLiveWeight: number;
  dailyDemandKgDm: number | null;
  totalSupplyKgDm: number;
  availableDays: number | null;
  paddockBudgets: Array<{
    paddockId: string;
    paddockName: string;
    currentKgDmPerHectare: number | null;
    availableKgDm: number | null;
    herdDailyDemandKgDm: number | null;
    availableDays: number | null;
  }>;
  lots: PasturePlanningLotBasis[];
  supplement: {
    status: "available" | "partial" | "unavailable";
    statusReason: string | null;
    dailyQuantityKgAsFed: number;
    projectedDailyCostClp: number | null;
  };
  economics: {
    status: "available" | "partial" | "unavailable";
    statusReason: string | null;
    period: string | null;
    feedCostClp: number | null;
    iofcClp: number | null;
    costPerLiterClp: number | null;
    sourceProjectionId: string | null;
    computedAt: string | null;
  };
  rotationContext: {
    settings: null | { recentDays: number; longRestDays: number; version: number };
    activeCellsByPaddock: Record<string, number>;
    activeCellIdsByPaddock: Record<string, Array<{ id: string; name: string }>>;
    compatibility: "complementary_read_model";
  };
  evidence: {
    demandUnit: "kg_dm_per_day";
    supplementUnit: "kg_as_fed_per_day";
    supplyUnit: "kg_dm";
    animalCountSources: string[];
    weightSources: string[];
    intakeAssumption: "3_percent_live_weight_dm";
    biomassSource: "latest_stored_pasture_biomass_estimate";
    economicsSource: "analytics_herd_metrics_current_projection";
  };
};

export type PastureSyntheticNdviSample = {
  paddockId: string;
  paddockName: string;
  capturedAt: string;
  meanNdvi: number;
  usablePixelPercent: number;
  indicativeKgDmPerHectare: number;
  model: "demo.synthetic.v1";
  operational: false;
};

export type StoredPastureRotationPlan = {
  id: string;
  operationId: string;
  fieldId: string;
  feasible: boolean;
  plan: Record<string, unknown>;
  createdAt: string;
};

export type PastureDashboard = {
  organizationId: string;
  fieldId: string;
  provider: PastureProviderStatus;
  paddocks: PasturePaddockSnapshot[];
  recentEstimates: PastureBiomassEstimate[];
  growthRates: PastureGrowthRate[];
  rotationPlans: StoredPastureRotationPlan[];
  planningBasis: PasturePlanningBasis;
  syntheticNdviSamples: PastureSyntheticNdviSample[];
};

export type CreatePastureRotationPlanRequest = {
  operationId: string;
  fieldId: string;
  startDate: string;
  horizonDays: number;
};

export type ManualPastureObservationRequest = {
  operationId: string;
  fieldId: string;
  paddockId: string;
  capturedAt: string;
  measurement: ManualDryMatterInput;
  notes?: string;
};

export type NdviCalibration = {
  id: string;
  providerKey: string;
  slopeKgDmPerHa: number;
  interceptKgDmPerHa: number;
  minNdvi: number;
  maxNdvi: number;
};

export type NdviCanonicalObservation = {
  operationId: string;
  fieldId: string;
  paddockId: string;
  capturedAt: string;
  providerKey: string;
  meanNdvi: number;
  usablePixelPercent: number;
  rawDocument: unknown;
};

export type PastureObservationResult = {
  id: string;
  fieldId: string;
  paddockId: string;
  sourceKind: "manual" | "ndvi";
  objectKey: string;
  sha256: string;
  kgDmPerHectare: number;
  capturedAt: string;
  storedAt: string;
  idempotentReplay: boolean;
};

export type PastureNdviCollectionQueue = {
  fieldId: string;
  providerKey: typeof PASTURE_CDSE_PROVIDER_KEY;
  dueAt: string;
  jobIds: string[];
};
