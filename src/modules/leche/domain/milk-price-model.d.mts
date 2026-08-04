import type { MilkSettlement } from "@/src/core/domain/types";
import type { MilkLineItemCategory, MilkQualityMetric } from "./milk-settlement-analysis.d.mts";

export type MilkRateScope = "firstHalf" | "secondHalf" | "total";
export type MilkRateProvenance = "contractual" | "derived" | "unavailable";
export type MilkMeasurementIssue = "absent" | "notNumeric" | "looksLikeRate" | "missingLiters" | null;
export type MilkQualityFitConfidence = "insufficient" | "low" | "moderate" | "high";
export type MilkRateSource = "override" | "qualityFit" | "stable" | "latestOfUnstable";
export type MilkProjectionFailureReason = "unstableRate" | "noRate" | "missingLiters" | "componentAbsentFromModel";

export type MilkSettlementForModel = Pick<
  MilkSettlement,
  "period" | "buyerName" | "plant" | "litersFirstHalf" | "litersSecondHalf" | "totalLiters" | "netAmountClp" | "lineItems"
>;

export type MilkComponentIdentity = {
  key: string;
  label: string;
  qualityMetric: MilkQualityMetric | null;
  recognized: boolean;
};

export type MilkRateObservation = {
  componentKey: string;
  label: string;
  category: MilkLineItemCategory;
  period: string;
  scope: MilkRateScope;
  lineItemIndex: number;
  liters: number | null;
  amountClp: number | null;
  contractualRateClpPerLiter: number | null;
  derivedRateClpPerLiter: number | null;
  rateClpPerLiter: number | null;
  provenance: MilkRateProvenance;
  measurement: string | null;
  measurementValue: number | null;
  measurementIssue: MilkMeasurementIssue;
  recognized: boolean;
  qualityMetric: MilkQualityMetric | null;
};

export type MilkQualityFitPoint = {
  measurement: number;
  rateClpPerLiter: number;
  period: string;
  scope: MilkRateScope;
};

export type MilkQualitySensitivity = {
  confidence: MilkQualityFitConfidence;
  slopeClpPerLiterPerPoint: number | null;
  interceptClpPerLiter: number | null;
  rSquared: number | null;
  pointCount: number;
  distinctMeasurementCount: number;
  measurementRange: { min: number; max: number } | null;
  banded: boolean;
  points: MilkQualityFitPoint[];
  excluded: Array<{ period: string; scope: MilkRateScope; reason: string }>;
};

export type MilkRateStability = {
  stable: boolean;
  distinctRateCount: number;
  spreadClpPerLiter: number | null;
  ratesByPeriod: Array<{ period: string; rateClpPerLiter: number | null }>;
};

export type MilkPriceModelComponent = {
  componentKey: string;
  label: string;
  category: MilkLineItemCategory;
  recognized: boolean;
  qualityMetric: MilkQualityMetric | null;
  provenance: MilkRateProvenance;
  rateClpPerLiter: number | null;
  rateStability: MilkRateStability;
  scopes: MilkRateScope[];
  periodsObserved: string[];
  periodsMissing: string[];
  qualitySensitivity: MilkQualitySensitivity | null;
  observations: MilkRateObservation[];
};

export type MilkPriceModel = {
  schemaVersion: string;
  buyerName: string | null;
  plants: string[];
  periods: string[];
  periodCount: number;
  components: MilkPriceModelComponent[];
  coverage: {
    componentCount: number;
    contractual: number;
    derived: number;
    unavailable: number;
    unstable: number;
    withQualitySensitivity: number;
    unrecognized: number;
  };
};

export type MilkQualityInput = Partial<Record<MilkQualityMetric, number>>;

export type MilkProjectionInput = {
  litersFirstHalf?: number | null;
  litersSecondHalf?: number | null;
  totalLiters?: number | null;
  quality?: MilkQualityInput;
  qualityFirstHalf?: MilkQualityInput;
  qualitySecondHalf?: MilkQualityInput;
  rateOverridesClpPerLiter?: Record<string, number>;
  allowUnstableRates?: boolean;
  allowQualityFit?: boolean;
};

export type MilkProjectionWarning = {
  code: "COMPONENT_NOT_PROJECTABLE" | "UNSTABLE_RATE_USED" | "LOW_CONFIDENCE_QUALITY_FIT";
  componentKey: string;
  message: string;
};

export type MilkProjectedComponent = {
  componentKey: string;
  label: string;
  category: MilkLineItemCategory;
  projected: boolean;
  rateSource: MilkRateSource | null;
  amountClp: number | null;
  amountPerLiterClp: number | null;
  parts: Array<{
    scope: MilkRateScope;
    liters: number;
    rateClpPerLiter: number;
    amountClp: number;
    rateSource: MilkRateSource;
  }>;
  reason: MilkProjectionFailureReason | null;
};

export type MilkSettlementProjection = {
  schemaVersion: string;
  buyerName: string | null;
  basisPeriods: string[];
  halves: Array<{ scope: MilkRateScope; liters: number; quality: MilkQualityInput }>;
  totalLiters: number;
  components: MilkProjectedComponent[];
  netAmountClp: number;
  netPricePerLiterClp: number | null;
  complete: boolean;
  notProjectedComponentKeys: string[];
  warnings: MilkProjectionWarning[];
};

export type MilkBacktestComponentResult = {
  componentKey: string;
  label: string;
  actualAmountClp: number;
  predictedAmountClp: number | null;
  differenceClp: number | null;
  rateSource: MilkRateSource | null;
  covered: boolean;
  reason: MilkProjectionFailureReason | null;
};

export type MilkBacktestPeriodResult = {
  period: string;
  mode: "holdout" | "inSample" | "unavailable";
  reason: "singlePeriodHistory" | null;
  actualNetClp: number | null;
  predictedNetClp: number | null;
  differenceClp: number | null;
  differencePct: number | null;
  withinTolerance: boolean | null;
  /** Difference restricted to concepts the period actually paid. */
  matchedDifferenceClp?: number | null;
  matchedWithinTolerance?: boolean | null;
  uncoveredComponentKeys?: string[];
  /** Concepts the model projects that this period never paid. */
  extraComponentKeys?: string[];
  extraAmountClp?: number;
  components: MilkBacktestComponentResult[];
};

export type MilkBacktestReport = {
  schemaVersion: string;
  mode: "holdout" | "inSample";
  toleranceClp: number;
  periodCount: number;
  evaluatedCount: number;
  unevaluatedCount: number;
  matchedEvaluatedCount: number;
  allMatchedWithinTolerance: boolean;
  allWithinTolerance: boolean;
  worstDifferenceClp: number | null;
  results: MilkBacktestPeriodResult[];
};

export type MilkSensitivityRow = {
  componentKey: string;
  label: string;
  qualityMetric: MilkQualityMetric;
  usable: boolean;
  step: number;
  confidence: MilkQualityFitConfidence;
  banded: boolean;
  distinctMeasurementCount: number;
  slopeClpPerLiterPerPoint: number | null;
  clpPerLiterPerStep: number | null;
  clpPerPeriodPerStep: number | null;
  excludedPointCount: number;
};

export const MILK_PRICE_MODEL_SCHEMA_VERSION: string;

export function resolveMilkComponentKey(description: string | null | undefined): MilkComponentIdentity;

export function extractMilkRateObservations(settlement: MilkSettlementForModel): MilkRateObservation[];

export function fitMilkPriceModel(
  settlements: MilkSettlementForModel[],
  options?: { excludeSuspectMeasurements?: boolean },
): MilkPriceModel;

export function projectMilkSettlement(model: MilkPriceModel, input?: MilkProjectionInput): MilkSettlementProjection;

export function backtestMilkPriceModel(
  settlements: MilkSettlementForModel[],
  options?: {
    toleranceClp?: number;
    mode?: "holdout" | "inSample";
    fitOptions?: { excludeSuspectMeasurements?: boolean };
  },
): MilkBacktestReport;

export function calculateQualitySensitivityTable(
  model: MilkPriceModel,
  options?: { totalLiters?: number | null; step?: number },
): MilkSensitivityRow[];

export function projectionInputFromSettlement(settlement: MilkSettlementForModel): MilkProjectionInput;
