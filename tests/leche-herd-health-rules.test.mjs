import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActiveWithdrawals,
  buildMammaryWorklist,
  calculateMammaryHealth,
  classifySomaticCellCount,
} from "../src/modules/leche/domain/herd-health-rules.mjs";

const healthEvent = (id, animalId, occurredAt, extra = {}) => ({
  id,
  animalId,
  eventType: "treatment",
  occurredAt,
  status: "completed",
  condition: null,
  productName: null,
  withdrawalMilkUntil: null,
  withdrawalMeatUntil: null,
  notes: "",
  metadata: {},
  ...extra,
});

test("keeps withdrawals active through the until date and separates milk from meat", () => {
  const events = [healthEvent("t1", "cow-1", "2026-07-10", {
    condition: "Mastitis",
    productName: "Antibiótico A",
    withdrawalMilkUntil: "2026-07-20",
    withdrawalMeatUntil: "2026-07-25",
  })];

  const active = buildActiveWithdrawals(events, "2026-07-20");
  assert.equal(active.entries.length, 1);
  assert.equal(active.entries[0].doNotDeliverMilk, true);
  assert.deepEqual(active.animalIdsWithMilkWithdrawal, ["cow-1"]);
  assert.deepEqual(active.animalIdsWithMeatWithdrawal, ["cow-1"]);

  const nextDay = buildActiveWithdrawals(events, "2026-07-21");
  assert.equal(nextDay.milk.length, 0);
  assert.equal(nextDay.meat.length, 1);
});

test("applies an explicit milk clearance without clearing the meat withdrawal", () => {
  const events = [
    healthEvent("t1", "cow-1", "2026-07-10", {
      withdrawalMilkUntil: "2026-07-25",
      withdrawalMeatUntil: "2026-07-25",
    }),
    healthEvent("clear-1", "cow-1", "2026-07-19", {
      eventType: "withdrawal_clearance",
      metadata: { clearsEventId: "t1", withdrawalType: "milk" },
    }),
  ];

  const active = buildActiveWithdrawals(events, "2026-07-20");
  assert.equal(active.milk.length, 0);
  assert.equal(active.meat.length, 1);
  assert.equal(active.entries[0].milkActive, false);
  assert.equal(active.entries[0].meatActive, true);
});

test("a general same-day clearance cannot erase a newly recorded withdrawal", () => {
  const treatment = healthEvent("t-new", "cow-1", "2026-07-20", {
    withdrawalMilkUntil: "2026-07-25",
  });
  const generalClearance = healthEvent(
    "clear-general",
    "cow-1",
    "2026-07-20",
    { eventType: "withdrawal_clearance" },
  );

  const ambiguous = buildActiveWithdrawals(
    [treatment, generalClearance],
    "2026-07-21",
  );
  assert.deepEqual(ambiguous.animalIdsWithMilkWithdrawal, ["cow-1"]);

  const targeted = buildActiveWithdrawals(
    [
      treatment,
      {
        ...generalClearance,
        metadata: { clearsEventId: treatment.id, withdrawalType: "milk" },
      },
    ],
    "2026-07-21",
  );
  assert.deepEqual(targeted.animalIdsWithMilkWithdrawal, []);
});

test("classifies individual RCS using explicit operational thresholds", () => {
  assert.equal(classifySomaticCellCount(null), "unknown");
  assert.equal(classifySomaticCellCount(199_999), "normal");
  assert.equal(classifySomaticCellCount(200_000), "elevated");
  assert.equal(classifySomaticCellCount(400_000), "high");
  assert.equal(classifySomaticCellCount(700_000), "critical");
});

test("calculates volume-weighted herd RCS, trends, mastitis cases and stale controls", () => {
  const controls = [
    { animalId: "cow-1", controlDate: "2026-06-10", totalLiters: 19, somaticCellCount: 250_000 },
    { animalId: "cow-1", controlDate: "2026-07-10", totalLiters: 20, somaticCellCount: 500_000 },
    { animalId: "cow-2", controlDate: "2026-07-10", totalLiters: 10, somaticCellCount: 100_000 },
    { animalId: "cow-3", controlDate: "2026-05-01", totalLiters: 15, somaticCellCount: 800_000 },
    { animalId: "cow-4", controlDate: "2026-07-10", totalLiters: 12, somaticCellCount: null },
  ];
  const events = [
    healthEvent("mastitis-open", "cow-2", "2026-07-01", { status: "open", condition: "Mastitis clínica" }),
    healthEvent("old-case", "cow-3", "2026-01-01", { status: "completed", condition: "Mastitis" }),
  ];

  const result = calculateMammaryHealth(controls, events, "2026-07-20");
  assert.equal(result.herdSomaticCellCount, 366_667);
  assert.equal(result.evaluatedAnimalCount, 3);
  assert.equal(result.herdStatus, "elevated");
  assert.deepEqual(result.categoryCounts, { normal: 1, elevated: 0, high: 1, critical: 0, unknown: 1 });
  assert.deepEqual(result.highRiskAnimalIds, ["cow-1", "cow-2"]);
  assert.equal(result.mastitisCases.length, 1);
  assert.equal(result.animals.find((animal) => animal.animalId === "cow-1").trend, "increasing");
  assert.equal(result.animals.find((animal) => animal.animalId === "cow-3").stale, true);
});

test("builds a mammary review queue without inferring diagnoses or treatments", () => {
  const metrics = calculateMammaryHealth([
    { animalId: "cow-critical", controlDate: "2026-07-19", totalLiters: 12, somaticCellCount: 800_000 },
    { animalId: "cow-elevated", controlDate: "2026-06-20", totalLiters: 14, somaticCellCount: 210_000 },
    { animalId: "cow-elevated", controlDate: "2026-07-19", totalLiters: 13, somaticCellCount: 300_000 },
    { animalId: "cow-stale", controlDate: "2026-05-01", totalLiters: 15, somaticCellCount: 100_000 },
  ], [
    healthEvent("mastitis-open", "cow-case", "2026-07-18", {
      eventType: "diagnosis",
      status: "open",
      condition: "Mastitis clínica",
    }),
  ], "2026-07-20");

  const worklist = buildMammaryWorklist(metrics);
  assert.deepEqual(worklist.map((item) => [item.animalId, item.priority, item.action]), [
    ["cow-case", "urgent", "review_now"],
    ["cow-critical", "urgent", "review_now"],
    ["cow-elevated", "high", "schedule_recheck"],
    ["cow-stale", "review", "update_control"],
  ]);
  assert.deepEqual(worklist[0].reasonCodes, ["open_mastitis_case"]);
  assert.deepEqual(worklist[2].reasonCodes, ["elevated_rcs", "increasing_trend"]);
  assert.equal(worklist.some((item) => "diagnosis" in item || "treatment" in item), false);
});
