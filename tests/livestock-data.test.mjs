import assert from "node:assert/strict";
import test from "node:test";

import {
  DEMO_ANIMALS,
  DEMO_EXPENSES,
  DEMO_FEEDING_PLANS,
  DEMO_LOTS,
  DEMO_WEIGHINGS,
} from "../src/modules/demo/data/demo-data.mjs";
import {
  accumulatedWeightGain,
  calculatePartnerBalances,
  suggestedTransfers,
  totalKgGained,
} from "../src/modules/ganado/lib/livestock-metrics.ts";

test("the synthetic demo herd is complete and internally consistent", () => {
  const tags = new Set(DEMO_ANIMALS.map((animal) => animal.tag));
  const animalsByLot = Object.groupBy(DEMO_ANIMALS, (animal) => animal.lotId);

  assert.equal(DEMO_LOTS.length, 4);
  assert.equal(DEMO_ANIMALS.length, 92);
  assert.equal(tags.size, DEMO_ANIMALS.length);
  assert.ok(DEMO_ANIMALS.every((animal) => animal.status === "active"));
  assert.ok(DEMO_ANIMALS.every((animal) => animal.source === "Demo FundoSmart"));
  assert.equal(DEMO_WEIGHINGS.length, 124);

  for (const lot of DEMO_LOTS) {
    assert.equal(animalsByLot[lot.id]?.length, lot.animalCount);
  }
});

test("synthetic feeding plans reconcile against the demo lots", () => {
  const lotsById = new Map(DEMO_LOTS.map((lot) => [lot.id, lot]));
  assert.ok(DEMO_FEEDING_PLANS.every((plan) => plan.sackWeightKg === 25));
  assert.ok(DEMO_FEEDING_PLANS.every((plan) => lotsById.has(plan.lotId)));

  const dailyKg = DEMO_FEEDING_PLANS.reduce(
    (sum, plan) => sum + plan.kgPerAnimalDay * (lotsById.get(plan.lotId)?.animalCount ?? 0),
    0,
  );
  assert.equal(dailyKg, 408.8);
  assert.equal(Number(((dailyKg * 7) / 25).toFixed(1)), 114.5);
});

test("synthetic livestock expenses reconcile by category", () => {
  const total = DEMO_EXPENSES.reduce((sum, expense) => sum + expense.amountClp, 0);
  const byCategory = Object.groupBy(DEMO_EXPENSES, (expense) => expense.category);
  const categoryTotal = (category) =>
    (byCategory[category] ?? []).reduce((sum, expense) => sum + expense.amountClp, 0);

  assert.equal(DEMO_EXPENSES.length, 6);
  assert.equal(total, 3_188_500);
  assert.equal(categoryTotal("alimento"), 1_530_500);
  assert.equal(categoryTotal("sanidad"), 318_000);
  assert.equal(categoryTotal("combustible"), 240_000);
  assert.equal(categoryTotal("flete"), 680_000);
  assert.equal(categoryTotal("otro"), 420_000);
});

test("weight gain and partner settlement calculations handle unordered inputs", () => {
  assert.deepEqual(
    accumulatedWeightGain([
      { recordedAt: "2026-05-11", weightKg: 111 },
      { recordedAt: "2026-05-01", weightKg: 100 },
    ]),
    { days: 10, deltaKg: 11, dailyGainKg: 1.1 },
  );

  const weighings = [
    { id: "w2", animalId: "a1", lotId: "l1", recordedAt: "2026-05-11", weightKg: 111 },
    { id: "w1", animalId: "a1", lotId: "l1", recordedAt: "2026-05-01", weightKg: 100 },
    { id: "w4", animalId: "a2", lotId: "l1", recordedAt: "2026-05-11", weightKg: 90 },
    { id: "w3", animalId: "a2", lotId: "l1", recordedAt: "2026-05-01", weightKg: 95 },
  ];
  assert.equal(totalKgGained(weighings), 6);

  const balances = calculatePartnerBalances([
    { id: "p1", name: "Socio A", contributionsClp: 600, paidExpensesClp: 900 },
    { id: "p2", name: "Socio B", contributionsClp: 400, paidExpensesClp: 100 },
  ]);
  assert.deepEqual(
    balances.map(({ name, participation, quotaClp, balanceClp }) => ({
      name,
      participation,
      quotaClp,
      balanceClp,
    })),
    [
      { name: "Socio A", participation: 0.6, quotaClp: 600, balanceClp: 300 },
      { name: "Socio B", participation: 0.4, quotaClp: 400, balanceClp: -300 },
    ],
  );
  assert.deepEqual(suggestedTransfers(balances), [
    { debtor: "Socio B", creditor: "Socio A", amountClp: 300 },
  ]);
});
