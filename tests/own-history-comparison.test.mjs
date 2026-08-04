import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_MINIMUM_BAND_PERIODS,
  OWN_HISTORY_COMPARISON_VERSION,
  compareAgainstOwnHistory,
  selectOwnHistoryAgendaSignals,
} from "../src/modules/analytics/domain/own-history-comparison.mjs";

const metric = (key, value, overrides = {}) => ({
  key,
  value,
  unit: "liters",
  status: value === null ? "unavailable" : "available",
  statusReason: null,
  ...overrides,
});

const snapshot = (period, metrics) => ({ period, metrics });
const find = (result, key) => result.comparisons.find((entry) => entry.key === key);

test("rejects a malformed period, a duplicated one and an empty series", () => {
  assert.throws(() => compareAgainstOwnHistory([]), /al menos un período/);
  assert.throws(() => compareAgainstOwnHistory([snapshot("2026-4", [])]), /formato aaaa-mm/);
  assert.throws(() => compareAgainstOwnHistory([snapshot("2026-13", [])]), /mes fuera de rango/);
  assert.throws(
    () => compareAgainstOwnHistory([snapshot("2026-04", []), snapshot("2026-04", [])]),
    /aparece más de una vez/,
  );
  assert.throws(
    () => compareAgainstOwnHistory([snapshot("2026-04", [])], { targetPeriod: "2025-01" }),
    /no está en la serie/,
  );
});

test("compares against the same period of the previous year by default", () => {
  // Autumn against autumn, not autumn against winter.
  const result = compareAgainstOwnHistory([
    snapshot("2025-04", [metric("milk.liters", 40_000)]),
    snapshot("2025-06", [metric("milk.liters", 20_000)]),
    snapshot("2026-04", [metric("milk.liters", 44_000)]),
  ]);

  assert.equal(result.schemaVersion, OWN_HISTORY_COMPARISON_VERSION);
  assert.equal(result.targetPeriod, "2026-04");
  assert.equal(result.yearOverYearBasisPeriod, "2025-04");
  assert.equal(result.periodOverPeriodBasisPeriod, "2025-06");

  const comparison = find(result, "milk.liters");
  assert.equal(comparison.primary, "yearOverYear");
  assert.equal(comparison.yearOverYear.basisPeriod, "2025-04");
  assert.equal(comparison.yearOverYear.deltaAbsolute, 4_000);
  assert.equal(comparison.yearOverYear.deltaPct, 10);
  assert.equal(comparison.yearOverYear.direction, "up");
  assert.equal(comparison.verdict, "changed");
  assert.deepEqual(comparison.notes, []);

  // The sequential comparison is still computed, just not the primary one.
  assert.equal(comparison.periodOverPeriod.basisPeriod, "2025-06");
  assert.equal(comparison.periodOverPeriod.deltaAbsolute, 24_000);
});

test("declares the fallback when the previous year's period is missing", () => {
  const result = compareAgainstOwnHistory([
    snapshot("2026-04", [metric("milk.liters", 28_640)]),
    snapshot("2026-06", [metric("milk.liters", 27_920)]),
  ]);

  const comparison = find(result, "milk.liters");
  assert.equal(comparison.primary, "periodOverPeriod");
  // The year-over-year comparison still answers, naming the period it would need.
  assert.equal(comparison.yearOverYear.status, "insufficient_data");
  assert.equal(comparison.yearOverYear.statusReason, "basis_period_absent");
  assert.equal(comparison.yearOverYear.basisPeriod, "2025-06");
  assert.equal(comparison.periodOverPeriod.deltaAbsolute, -720);
  assert.equal(comparison.periodOverPeriod.direction, "down");

  // A comparison across seasons must state that limitation explicitly.
  const note = comparison.notes.find((entry) => entry.code === "SEASONAL_COMPARISON");
  assert.ok(note);
  // Names both the period it could not use and the one it settled for.
  assert.match(note.message, /No hay 2025-06/);
  assert.match(note.message, /se comparó con 2026-04/);
  assert.match(note.message, /otra estación/);
  assert.equal(result.summary.seasonalFallbackCount, 1);
  assert.equal(result.summary.yearOverYearCount, 0);
});

test("reports a move under the tolerance as unchanged", () => {
  const result = compareAgainstOwnHistory(
    [
      snapshot("2025-04", [metric("price.clp_per_liter", 457.31)]),
      snapshot("2026-04", [metric("price.clp_per_liter", 459.0)]),
    ],
    { unchangedTolerancePct: 1 },
  );
  const comparison = find(result, "price.clp_per_liter");
  assert.equal(comparison.verdict, "unchanged");
  assert.equal(comparison.yearOverYear.direction, "flat");
  assert.ok(Math.abs(comparison.yearOverYear.deltaPct) < 1);

  const strict = compareAgainstOwnHistory(
    [
      snapshot("2025-04", [metric("price.clp_per_liter", 457.31)]),
      snapshot("2026-04", [metric("price.clp_per_liter", 459.0)]),
    ],
    { unchangedTolerancePct: 0 },
  );
  assert.equal(find(strict, "price.clp_per_liter").verdict, "changed");
});

test("never turns a metric the projection could not compute into a delta", () => {
  // days_open now reports insufficient_data when the source has no breeding events;
  // subtracting two of those would manufacture a trend out of nothing.
  const result = compareAgainstOwnHistory([
    snapshot("2025-04", [metric("reproduction.days_open_average", 120)]),
    snapshot("2026-04", [
      metric("reproduction.days_open_average", null, {
        status: "insufficient_data",
        statusReason: "no_service_or_insemination_events",
      }),
    ]),
  ]);

  const comparison = find(result, "reproduction.days_open_average");
  assert.equal(comparison.verdict, "insufficient_data");
  assert.equal(comparison.yearOverYear.status, "insufficient_data");
  assert.equal(comparison.yearOverYear.statusReason, "target_insufficient_data");
  assert.equal(comparison.yearOverYear.deltaAbsolute, null);
  assert.equal(comparison.target.status, "insufficient_data");
  assert.equal(comparison.target.statusReason, "no_service_or_insemination_events");
});

test("distinguishes a metric absent from one period from one that is merely unavailable", () => {
  const result = compareAgainstOwnHistory([
    snapshot("2025-04", [metric("milk.liters", 40_000)]),
    snapshot("2026-04", [metric("finance.cost_per_liter_clp", 300)]),
  ]);

  assert.equal(find(result, "milk.liters").yearOverYear.statusReason, "metric_absent_in_one_period");
  assert.equal(find(result, "milk.liters").target.statusReason, "metric_absent_in_period");
  assert.equal(find(result, "finance.cost_per_liter_clp").yearOverYear.statusReason, "metric_absent_in_one_period");
  assert.equal(result.summary.insufficientData, 2);
});

test("keeps the band unavailable until there are enough prior periods", () => {
  assert.equal(DEFAULT_MINIMUM_BAND_PERIODS, 3);
  const twoPeriods = compareAgainstOwnHistory([
    snapshot("2026-02", [metric("milk.liters", 30_000)]),
    snapshot("2026-04", [metric("milk.liters", 26_880)]),
  ]);
  const band = find(twoPeriods, "milk.liters").band;
  assert.equal(band.status, "insufficient_data");
  assert.equal(band.statusReason, "fewer_periods_than_minimum");
  assert.equal(band.periodsUsed, 1);
  assert.equal(band.position, null);
});

test("places the current value inside, above or below its own historical range", () => {
  const series = (latest) => [
    snapshot("2025-10", [metric("milk.liters", 30_000)]),
    snapshot("2025-11", [metric("milk.liters", 34_000)]),
    snapshot("2025-12", [metric("milk.liters", 32_000)]),
    snapshot("2026-01", [metric("milk.liters", latest)]),
  ];

  const inside = find(compareAgainstOwnHistory(series(31_000)), "milk.liters").band;
  assert.equal(inside.status, "available");
  assert.equal(inside.periodsUsed, 3);
  assert.deepEqual(inside.periods, ["2025-10", "2025-11", "2025-12"]);
  assert.equal(inside.minimum, 30_000);
  assert.equal(inside.maximum, 34_000);
  assert.equal(inside.mean, 32_000);
  assert.equal(inside.position, "inside");

  assert.equal(find(compareAgainstOwnHistory(series(38_000)), "milk.liters").band.position, "above");
  assert.equal(find(compareAgainstOwnHistory(series(21_000)), "milk.liters").band.position, "below");
});

test("excludes unavailable periods from the band instead of treating them as zero", () => {
  const result = compareAgainstOwnHistory([
    snapshot("2025-09", [metric("milk.liters", 30_000)]),
    snapshot("2025-10", [metric("milk.liters", null, { status: "unavailable" })]),
    snapshot("2025-11", [metric("milk.liters", 34_000)]),
    snapshot("2025-12", [metric("milk.liters", 32_000)]),
    snapshot("2026-01", [metric("milk.liters", 31_000)]),
  ]);
  const band = find(result, "milk.liters").band;
  assert.equal(band.periodsUsed, 3);
  assert.ok(!band.periods.includes("2025-10"));
  assert.equal(band.minimum, 30_000);
});

test("raises an agenda signal only when a metric leaves its own range", () => {
  const series = (latest) => [
    snapshot("2025-10", [metric("herd.somatic_cell_count", 250_000)]),
    snapshot("2025-11", [metric("herd.somatic_cell_count", 280_000)]),
    snapshot("2025-12", [metric("herd.somatic_cell_count", 265_000)]),
    snapshot("2026-01", [metric("herd.somatic_cell_count", latest)]),
  ];

  assert.deepEqual(selectOwnHistoryAgendaSignals(compareAgainstOwnHistory(series(270_000))), []);

  const [signal] = selectOwnHistoryAgendaSignals(compareAgainstOwnHistory(series(410_000)));
  assert.ok(signal);
  assert.equal(signal.key, "herd.somatic_cell_count");
  assert.equal(signal.period, "2026-01");
  assert.equal(signal.position, "above");
  assert.equal(signal.band.maximum, 280_000);
  assert.equal(signal.band.periodsUsed, 3);
  // The signal states the band it left, not a verdict about the herd.
  assert.match(signal.reason, /sobre su propio máximo histórico \(280000\)/);

  const [low] = selectOwnHistoryAgendaSignals(compareAgainstOwnHistory(series(100_000)));
  assert.equal(low.position, "below");
  assert.match(low.reason, /bajo su propio mínimo/);
});

test("produces no signal while the band is still insufficient", () => {
  const result = compareAgainstOwnHistory([
    snapshot("2025-12", [metric("milk.liters", 30_000)]),
    snapshot("2026-01", [metric("milk.liters", 90_000)]),
  ]);
  // A single prior period cannot establish a range, so a tripled value raises nothing.
  assert.deepEqual(selectOwnHistoryAgendaSignals(result), []);
  assert.equal(result.summary.outsideBandCount, 0);
});

test("targets an explicit period and ignores anything after it", () => {
  const series = [
    snapshot("2025-04", [metric("milk.liters", 40_000)]),
    snapshot("2026-04", [metric("milk.liters", 44_000)]),
    snapshot("2026-06", [metric("milk.liters", 21_000)]),
  ];
  const result = compareAgainstOwnHistory(series, { targetPeriod: "2026-04" });
  assert.equal(result.targetPeriod, "2026-04");
  assert.equal(find(result, "milk.liters").yearOverYear.basisPeriod, "2025-04");
  // 2026-06 comes after the target, so it must not become its basis or its band.
  assert.equal(find(result, "milk.liters").periodOverPeriod.basisPeriod, "2025-04");
});

test("summarizes the comparison and rejects invalid tuning", () => {
  const result = compareAgainstOwnHistory([
    snapshot("2025-04", [metric("a", 10), metric("b", 20), metric("c", 30)]),
    snapshot("2026-04", [metric("a", 20), metric("b", 20), metric("c", null, { status: "unavailable" })]),
  ]);
  assert.deepEqual(result.summary, {
    metricCount: 3,
    changed: 1,
    unchanged: 1,
    insufficientData: 1,
    yearOverYearCount: 2,
    seasonalFallbackCount: 0,
    outsideBandCount: 0,
  });

  assert.throws(() => compareAgainstOwnHistory([snapshot("2026-04", [])], { minimumBandPeriods: 0 }), /entero positivo/);
  assert.throws(() => compareAgainstOwnHistory([snapshot("2026-04", [])], { unchangedTolerancePct: -1 }), /no negativo/);
});

test("does not mutate the snapshots it was given", () => {
  const snapshots = [
    snapshot("2025-04", [metric("milk.liters", 40_000)]),
    snapshot("2026-04", [metric("milk.liters", 44_000)]),
  ];
  const before = JSON.stringify(snapshots);
  compareAgainstOwnHistory(snapshots);
  selectOwnHistoryAgendaSignals(compareAgainstOwnHistory(snapshots));
  assert.equal(JSON.stringify(snapshots), before);
});
