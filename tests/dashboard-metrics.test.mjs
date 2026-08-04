import assert from "node:assert/strict";
import test from "node:test";
import {
  DEMO_ACTIVITIES,
  DEMO_ANIMALS,
  DEMO_EXPENSES,
  DEMO_LOTS,
  DEMO_MILK_SETTLEMENTS,
} from "../src/modules/demo/data/demo-data.mjs";
import { calculateDashboardMetrics } from "../src/modules/dashboard/dashboard-metrics.mjs";

const animals = DEMO_ANIMALS.map(({ weightKg, ...animal }) => ({
  ...animal,
  latestWeightDate: "2026-07-10",
  latestWeightKg: weightKg,
}));

test("the operational dashboard reconciles the complete demo herd", () => {
  const metrics = calculateDashboardMetrics({
    activities: DEMO_ACTIVITIES,
    animals,
    canViewFinance: true,
    expenses: DEMO_EXPENSES,
    lots: DEMO_LOTS,
    settlements: DEMO_MILK_SETTLEMENTS,
  });

  assert.equal(metrics.activeAnimals, 92);
  assert.equal(metrics.activeLots, 4);
  assert.equal(metrics.milkingCows, 48);
  assert.equal(metrics.latestWeightDate, "2026-07-10");
  assert.equal(metrics.weightCoveragePercent, 100);
});

test("the operational dashboard compares milk and matches period costs", () => {
  const expectedPeriodCostsClp = 5_216_000;
  const metrics = calculateDashboardMetrics({
    activities: DEMO_ACTIVITIES,
    animals,
    canViewFinance: true,
    expenses: DEMO_EXPENSES,
    lots: DEMO_LOTS,
    settlements: DEMO_MILK_SETTLEMENTS,
  });

  assert.equal(metrics.latestMilk?.period, "2026-06");
  assert.equal(metrics.latestMilk?.totalLiters, 27_920);
  assert.equal(metrics.periodCostsClp, expectedPeriodCostsClp);
  assert.ok(Math.abs((metrics.milkChangePercent ?? 0) - (-2.5139664804469275)) < 0.000001);
  assert.ok(Math.abs((metrics.litersPerMilkingCowDay ?? 0) - 19.38888888888889) < 0.000001);
  assert.equal(metrics.operatingResultClp, (metrics.latestMilk?.netAmountClp ?? 0) - expectedPeriodCostsClp);
});

test("financial metrics stay unavailable for roles without finance access", () => {
  const metrics = calculateDashboardMetrics({
    activities: DEMO_ACTIVITIES,
    animals,
    canViewFinance: false,
    expenses: DEMO_EXPENSES,
    lots: DEMO_LOTS,
    settlements: DEMO_MILK_SETTLEMENTS,
  });

  assert.equal(metrics.periodCostsClp, null);
  assert.equal(metrics.operatingResultClp, null);
  assert.equal(metrics.latestMilk?.totalLiters, 27_920);
  assert.equal("grossAmountClp" in metrics.latestMilk, false);
  assert.equal("netAmountClp" in metrics.latestMilk, false);
  assert.equal("netPricePerLiterClp" in metrics.latestMilk, false);
  assert.doesNotMatch(JSON.stringify(metrics), /grossAmountClp|netAmountClp|netPricePerLiterClp/);
});

test("bounded dashboard snapshots use monthly activity cost aggregates", () => {
  const aggregateCostClp = 123_456;
  const metrics = calculateDashboardMetrics({
    activities: DEMO_ACTIVITIES.map((activity) => ({ ...activity, costClp: 99_999_999 })),
    activityCostsByPeriod: [{ fieldId: "field-a", period: "2026-06", costClp: aggregateCostClp }],
    animals,
    canViewFinance: true,
    expenses: DEMO_EXPENSES,
    lots: DEMO_LOTS,
    settlements: DEMO_MILK_SETTLEMENTS,
  });
  const expectedExpensesClp = DEMO_EXPENSES
    .filter((expense) => expense.date?.startsWith("2026-06"))
    .reduce((sum, expense) => sum + expense.amountClp, 0);

  assert.equal(metrics.periodCostsClp, expectedExpensesClp + aggregateCostClp);
});
