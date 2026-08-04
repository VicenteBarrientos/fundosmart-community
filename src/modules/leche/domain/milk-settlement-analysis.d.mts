import type { MilkSettlement, MilkSettlementLineItem } from "@/src/core/domain/types";

export type MilkLineItemCategory = "base" | "composicion" | "calidad" | "sanitario" | "bonos" | "otros";
export type MilkQualityMetric = "fatPct" | "proteinPct" | "totalSolidsPct" | "somaticCellCount" | "bacterialCountUfc";
export type MilkSettlementPeriodPart = "firstHalf" | "secondHalf" | null;

export type MilkQualityThresholds = {
  rcs?: number | string | null;
  ufc?: number | string | null;
};

export type MilkQualityObservation = {
  metric: MilkQualityMetric;
  value: number;
  rawValue: number;
  unit: "percent" | "perMl";
  periodPart: MilkSettlementPeriodPart;
  lineItemIndex: number | null;
  description: string;
  measurement: string | null;
};

export type MilkSettlementQuality = {
  fatPct: number | null;
  proteinPct: number | null;
  totalSolidsPct: number | null;
  somaticCellCount: number | null;
  bacterialCountUfc: number | null;
  observations: MilkQualityObservation[];
};

export type AnalyzedMilkLineItem = MilkSettlementLineItem & {
  lineItemIndex: number;
  category: MilkLineItemCategory;
  amountPerLiterClp: number | null;
};

export type MilkPaymentCategoryContribution = {
  category: MilkLineItemCategory;
  label: string;
  amountClp: number;
  amountPerLiterClp: number | null;
  sharePct: number | null;
  lineItemCount: number;
};

export type MilkPaymentComposition = {
  lineItems: AnalyzedMilkLineItem[];
  categories: MilkPaymentCategoryContribution[];
  totalAmountClp: number;
  totalAmountPerLiterClp: number | null;
  reconciliationDifferenceClp: number | null;
};

export type MilkQualityAlert = {
  code: "RCS_THRESHOLD_EXCEEDED" | "UFC_THRESHOLD_EXCEEDED";
  metric: "rcs" | "ufc";
  severity: "warning";
  value: number;
  threshold: number;
  unit: "perMl";
  periodPart: MilkSettlementPeriodPart;
  lineItemIndex: number | null;
  message: string;
};

export const DEFAULT_MILK_QUALITY_THRESHOLDS: Readonly<{ rcs: 700000; ufc: 1000000 }>;

export function parseChileanNumber(value: unknown): number | null;
export function classifyMilkLineItem(lineItemOrDescription: MilkSettlementLineItem | string | null | undefined): MilkLineItemCategory;
export function parseMilkQualityLineItem(lineItem: MilkSettlementLineItem, lineItemIndex?: number | null): MilkQualityObservation | null;
export function extractMilkSettlementQuality(settlement: Pick<MilkSettlement, "lineItems" | "litersFirstHalf" | "litersSecondHalf">): MilkSettlementQuality;
export function calculateMilkPaymentComposition(settlement: Pick<MilkSettlement, "lineItems" | "totalLiters" | "netAmountClp">): MilkPaymentComposition;
export function calculateMilkPaymentComposition(lineItems: MilkSettlementLineItem[], totalLiters?: number | null, netAmountClp?: number | null): MilkPaymentComposition;
export function evaluateMilkQualityAlerts(quality: MilkSettlementQuality, thresholds?: MilkQualityThresholds): MilkQualityAlert[];
export function analyzeMilkSettlement(
  settlement: Pick<MilkSettlement, "lineItems" | "litersFirstHalf" | "litersSecondHalf" | "totalLiters" | "netAmountClp">,
  options?: { thresholds?: MilkQualityThresholds },
): { quality: MilkSettlementQuality; payment: MilkPaymentComposition; alerts: MilkQualityAlert[] };
