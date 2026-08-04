import assert from "node:assert/strict";
import test from "node:test";

import {
  chileDateKey,
  chileDaysBetween,
} from "../src/modules/leche/domain/chile-date.mjs";
import {
  calculate305DayProjection,
  calculateDaysInMilk,
  calculateRollingHerdAverage,
  evaluateDryOffRecommendation,
  getCurrentProduction,
} from "../src/modules/leche/domain/lactation-metrics.mjs";

test("normalizes instants to America/Santiago and counts civil days across DST", () => {
  assert.equal(chileDateKey("2026-07-20T02:30:00Z"), "2026-07-19");
  assert.equal(chileDaysBetween("2026-09-05", "2026-09-07"), 2);
  assert.throws(() => chileDateKey("2026-02-30"), /no es válida/);
});

test("counts lactation start as DEL 1 and caps completed lactations", () => {
  const active = {
    id: "l1",
    animalId: "cow-1",
    startedAt: "2026-01-01",
    endedAt: null,
    status: "active",
  };
  const closed = { ...active, endedAt: "2026-01-10", status: "closed" };

  assert.equal(calculateDaysInMilk(active, "2026-01-01"), 1);
  assert.equal(calculateDaysInMilk(active, "2026-01-02T02:00:00Z"), 1);
  assert.equal(calculateDaysInMilk(closed, "2026-02-01"), 10);
  assert.equal(calculateDaysInMilk(active, "2025-12-31"), null);
});

test("reports current production from the latest valid control in the lactation", () => {
  const lactation = {
    id: "l1",
    animalId: "cow-1",
    startedAt: "2026-01-01",
    endedAt: null,
    status: "active",
  };
  const controls = [
    {
      animalId: "cow-1",
      lactationId: "l1",
      controlDate: "2026-01-01",
      totalLiters: 10,
    },
    {
      animalId: "cow-1",
      lactationId: "l1",
      controlDate: "2026-01-11",
      totalLiters: 20,
    },
    {
      animalId: "cow-1",
      lactationId: "other",
      controlDate: "2026-01-14",
      totalLiters: 99,
    },
    {
      animalId: "cow-2",
      lactationId: "l1",
      controlDate: "2026-01-14",
      totalLiters: 88,
    },
  ];

  assert.deepEqual(getCurrentProduction(lactation, controls, "2026-01-15"), {
    controlDate: "2026-01-11",
    liters: 20,
    ageDays: 4,
  });
});

test("recommends dry-off by DEL or sustained low production with explicit defaults", () => {
  assert.deepEqual(
    evaluateDryOffRecommendation({
      lactationStatus: "active",
      daysInMilk: 305,
      latestLiters: 14,
    }),
    { shouldDryOff: true, reason: "days_in_milk" },
  );
  assert.deepEqual(
    evaluateDryOffRecommendation({
      lactationStatus: "active",
      daysInMilk: 240,
      latestLiters: 8,
    }),
    { shouldDryOff: true, reason: "low_production" },
  );
  assert.deepEqual(
    evaluateDryOffRecommendation({
      lactationStatus: "active",
      daysInMilk: 219,
      latestLiters: 5,
    }),
    { shouldDryOff: false, reason: null },
  );
  assert.deepEqual(
    evaluateDryOffRecommendation({
      lactationStatus: "dry",
      daysInMilk: 320,
      latestLiters: 5,
    }),
    { shouldDryOff: false, reason: null },
  );
  assert.throws(
    () =>
      evaluateDryOffRecommendation(
        { lactationStatus: "active", daysInMilk: 10, latestLiters: 5 },
        { maxDaysInMilk: 0 },
      ),
    /positivos/,
  );
});

test("projects 305 days with explicit midpoint and carry-forward assumptions", () => {
  const lactation = {
    id: "l1",
    animalId: "cow-1",
    startedAt: "2026-01-01",
    endedAt: null,
    status: "active",
  };
  const controls = [
    {
      animalId: "cow-1",
      lactationId: "l1",
      controlDate: "2026-01-01",
      totalLiters: 10,
    },
    {
      animalId: "cow-1",
      lactationId: "l1",
      controlDate: "2026-01-11",
      totalLiters: 20,
    },
  ];

  assert.deepEqual(
    calculate305DayProjection(lactation, controls, "2026-01-11"),
    {
      startDate: "2026-01-01",
      throughDate: "2026-01-11",
      controlCount: 2,
      observedDays: 11,
      estimatedToDateLiters: 160,
      projected305Liters: 6040,
      method: "nearest-test-day-carry-forward",
    },
  );

  const closed = { ...lactation, endedAt: "2026-01-20", status: "closed" };
  assert.equal(
    calculate305DayProjection(closed, controls, "2026-01-31")
      .projected305Liters,
    340,
  );
});

test("calculates RHA over 365 civil days and includes dry days as zero", () => {
  const result = calculateRollingHerdAverage({
    asOf: "2026-12-31",
    lactations: [
      {
        id: "l1",
        animalId: "cow-1",
        startedAt: "2026-01-01",
        endedAt: "2026-01-10",
        status: "closed",
      },
      {
        id: "l2",
        animalId: "cow-2",
        startedAt: "2026-12-30",
        endedAt: null,
        status: "active",
      },
    ],
    controls: [
      {
        animalId: "cow-1",
        lactationId: "l1",
        controlDate: "2026-01-05",
        totalLiters: 10,
      },
      {
        animalId: "cow-2",
        lactationId: "l2",
        controlDate: "2026-12-30",
        totalLiters: 20,
      },
    ],
  });

  assert.deepEqual(result, {
    windowStart: "2026-01-01",
    windowEnd: "2026-12-31",
    cowCount: 2,
    estimatedMilkLiters: 140,
    litersPerCow: 70,
    method: "365-day-nearest-test-day",
  });
});
