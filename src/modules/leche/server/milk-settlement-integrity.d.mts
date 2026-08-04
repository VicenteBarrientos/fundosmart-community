export const MILK_SETTLEMENT_LIMITS: Readonly<{
  plant: 128;
  purchaseOrder: 128;
  producerCode: 128;
  partyName: 200;
  sourceDocumentName: 255;
  notes: 4000;
  lineItems: 200;
  lineItemDescription: 200;
  lineItemMeasurement: 200;
}>;

export function deriveMilkSettlementPrices<T extends {
  totalLiters: number;
  netAmountClp: number;
  grossAmountClp: number;
}>(value: T): T | (
  Omit<T, "netPricePerLiterClp" | "grossPricePerLiterClp"> & {
    netPricePerLiterClp: number;
    grossPricePerLiterClp: number;
  }
);

export function milkSettlementIntegrityIssues(value: unknown): string[];
export function portableMilkSettlementIntegrityIssues(value: unknown): string[];
