import type { MilkBulkProduction } from "@/src/core/domain/types";
import type { MilkReconciliationPeriod } from "./types";

export type MilkReconciliationSettlementInput = {
  fieldId: string;
  period: string;
  totalLiters: number;
  netAmountClp: number;
};

export function buildMilkReconciliation(
  production: Array<
    Pick<
      MilkBulkProduction,
      "fieldId" | "recordedAt" | "kind" | "volumeLiters"
    > &
      Partial<Pick<MilkBulkProduction, "source">>
  >,
  settlements: MilkReconciliationSettlementInput[],
): MilkReconciliationPeriod[];
