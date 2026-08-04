import assert from "node:assert/strict";
import test from "node:test";
import { calculateAnimalMargin, calculateLotMargin } from "../src/modules/ganado/domain/livestock-margin.mjs";

test("calculateAnimalMargin with direct measurement and reconciled sale document", () => {
  const result = calculateAnimalMargin({
    animal: { id: "anim-1", salePriceClp: 650000 },
    saleLink: { allocatedAmountClp: 680000, allocatedWeightKg: 420 },
    feedConsumptions: [{ costClp: 120000 }, { costClp: 80000 }],
    expenses: [{ amountClp: 30000 }],
  });

  assert.equal(result.revenueClp, 680000);
  assert.equal(result.isReconciled, true);
  assert.equal(result.feedCostClp, 200000);
  assert.equal(result.isFeedMeasured, true);
  assert.equal(result.expensesCostClp, 30000);
  assert.equal(result.totalCostClp, 230000);
  assert.equal(result.marginClp, 450000);
  assert.equal(result.imputationRule, "medido");
});

test("calculateAnimalMargin with category feed cost imputation when unmeasured", () => {
  const result = calculateAnimalMargin({
    animal: { id: "anim-2", salePriceClp: 500000 },
    saleLink: null,
    feedConsumptions: [],
    expenses: [{ amountClp: 15000 }],
    categoryAvgDailyFeedCostClp: 1500,
    daysInField: 100,
  });

  assert.equal(result.revenueClp, 500000);
  assert.equal(result.isReconciled, false);
  assert.equal(result.feedCostClp, 150000);
  assert.equal(result.isFeedMeasured, false);
  assert.equal(result.imputedFeedCostClp, 150000);
  assert.equal(result.totalCostClp, 165000);
  assert.equal(result.marginClp, 335000);
  assert.equal(result.imputationRule, "imputado_por_categoria");
});

test("calculateLotMargin aggregates lot revenue and costs", () => {
  const result = calculateLotMargin({
    lot: { id: "lot-1", name: "Lote Vaquillas 2026" },
    animals: [{ id: "a1", daysInField: 60 }, { id: "a2", daysInField: 60 }],
    saleDocumentLinks: [{ allocatedAmountClp: 1200000 }],
    feedConsumptions: [{ costClp: 300000 }],
    expenses: [{ amountClp: 50000 }],
  });

  assert.equal(result.animalCount, 2);
  assert.equal(result.revenueClp, 1200000);
  assert.equal(result.feedCostClp, 300000);
  assert.equal(result.expensesCostClp, 50000);
  assert.equal(result.totalCostClp, 350000);
  assert.equal(result.marginClp, 850000);
  assert.equal(result.isReconciled, true);
});
