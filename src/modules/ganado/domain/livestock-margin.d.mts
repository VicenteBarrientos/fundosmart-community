export type AnimalMarginInput = {
  animal?: {
    id: string;
    salePriceClp?: number | null;
    saleWeightKg?: number | null;
  } | null;
  saleLink?: {
    allocatedAmountClp: number;
    allocatedWeightKg?: number | null;
  } | null;
  feedConsumptions?: Array<{ costClp?: number | null }>;
  expenses?: Array<{ amountClp?: number | null }>;
  categoryAvgDailyFeedCostClp?: number;
  daysInField?: number;
};

export type AnimalMarginResult = {
  revenueClp: number | null;
  feedCostClp: number;
  isFeedMeasured: boolean;
  imputedFeedCostClp: number;
  expensesCostClp: number;
  totalCostClp: number;
  marginClp: number | null;
  isReconciled: boolean;
  imputationRule: "medido" | "imputado_por_categoria" | "sin_costo_registrado";
  imputationExplanation: string;
};

export type LotMarginInput = {
  lot?: { id: string; name: string } | null;
  animals?: Array<{ id: string; daysInField?: number }>;
  saleDocumentLinks?: Array<{ allocatedAmountClp: number }>;
  feedConsumptions?: Array<{ costClp?: number | null }>;
  expenses?: Array<{ amountClp?: number | null }>;
  categoryAvgDailyFeedCostClp?: number;
};

export type LotMarginResult = {
  lotId: string | null;
  lotName: string;
  animalCount: number;
  revenueClp: number;
  feedCostClp: number;
  isFeedMeasured: boolean;
  imputedFeedCostClp: number;
  expensesCostClp: number;
  totalCostClp: number;
  marginClp: number | null;
  isReconciled: boolean;
};

export declare function calculateAnimalMargin(input: AnimalMarginInput): AnimalMarginResult;
export declare function calculateLotMargin(input: LotMarginInput): LotMarginResult;
