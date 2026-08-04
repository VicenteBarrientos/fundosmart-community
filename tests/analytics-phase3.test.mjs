import assert from "node:assert/strict";
import test from "node:test";

import {
  ANALYTICS_SCHEMA_VERSION,
  buildAnalyticsProjection,
  evaluateAnalyticsAlerts,
  normalizeAnalyticsWindow,
} from "../src/modules/analytics/domain/analytics-projection.mjs";
import {
  ANALYTICS_RECOMMENDATION_ENGINE_VERSION,
  createRuleBasedRecommendationEngine,
} from "../src/modules/analytics/domain/recommendation-engine.mjs";

function metric(projection, key) {
  const found = projection.metrics.find((entry) => entry.key === key);
  assert.ok(found, `missing metric ${key}`);
  return found;
}

function evaluation(projection, code) {
  const found = projection.alertEvaluations.find((entry) => entry.code === code);
  assert.ok(found, `missing alert evaluation ${code}`);
  return found;
}

test("normalizes monthly and partial windows on Chilean civil-day boundaries", () => {
  assert.deepEqual(normalizeAnalyticsWindow("2026-06"), {
    period: "2026-06",
    start: "2026-06-01",
    end: "2026-06-30",
    requestedEnd: "2026-06-30",
    asOf: "2026-06-30",
    complete: true,
    dayCount: 30,
    timeZone: "America/Santiago",
    boundaries: "inclusive",
    comparison: { start: "2026-05-01", end: "2026-05-31", dayCount: 31 },
  });

  const winterInstant = normalizeAnalyticsWindow({
    start: "2026-06-01",
    end: "2026-07-31",
    asOf: "2026-07-01T02:30:00Z",
  });
  assert.equal(winterInstant.end, "2026-06-30");
  assert.equal(winterInstant.dayCount, 30);
  assert.deepEqual(winterInstant.comparison, {
    start: "2026-05-02",
    end: "2026-05-31",
    dayCount: 30,
  });

  const summerInstant = normalizeAnalyticsWindow({
    start: "2026-01-01",
    end: "2026-01-31",
    asOf: "2026-01-02T02:30:00Z",
  });
  assert.equal(summerInstant.end, "2026-01-01");
  assert.equal(summerInstant.dayCount, 1);
  assert.deepEqual(summerInstant.comparison, {
    start: "2025-12-31",
    end: "2025-12-31",
    dayCount: 1,
  });

  assert.throws(
    () => normalizeAnalyticsWindow({ period: "2026-13" }),
    /YYYY-MM/,
  );
  assert.throws(
    () => normalizeAnalyticsWindow({ period: "2026-06", timeZone: "UTC" }),
    /America\/Santiago/,
  );
});

test("projects canonical production, quality, reproductive, weight, outcome and finance KPIs", () => {
  const outcomes = [
    ...Array.from({ length: 5 }, (_, index) => ({ id: `mastitis-${index}`, date: `2026-06-${String(index + 1).padStart(2, "0")}`, animalId: `m-${index}`, type: "mastitis" })),
    ...Array.from({ length: 3 }, (_, index) => ({ id: `death-${index}`, date: `2026-06-${String(index + 10).padStart(2, "0")}`, animalId: `d-${index}`, type: "death" })),
    ...Array.from({ length: 10 }, (_, index) => ({ id: `discard-${index}`, date: `2026-06-${String(index + 15).padStart(2, "0")}`, animalId: `x-${index}`, type: "discard" })),
  ];
  const projection = buildAnalyticsProjection({
    organizationId: "org-a",
    fieldId: "field-a",
    datasetRevision: "events:42",
    outcomesComplete: true,
    start: "2026-06-01",
    end: "2026-06-30",
    milkProduction: [
      { id: "prior-1", date: "2026-05-02", liters: 1_000, milkingCowCount: 100 },
      { id: "prior-2", date: "2026-05-03", liters: 1_000, milkingCowCount: 100 },
      { id: "current-1", date: "2026-06-01", liters: 850, milkingCowCount: 100 },
      { id: "current-2", date: "2026-06-02", liters: 850, milkingCowCount: 100 },
    ],
    milkQuality: [
      { id: "quality-prior", date: "2026-05-15", fatPct: 3.7, proteinPct: 3.2, somaticCellCount: 200_000, liters: 1_000 },
      { id: "quality-current-1", date: "2026-06-10", fatPct: 3.8, proteinPct: 3.3, somaticCellCount: 400_000, liters: 500 },
      { id: "quality-current-2", date: "2026-06-20", fatPct: 4, proteinPct: 3.5, somaticCellCount: 400_000, liters: 500 },
    ],
    reproductiveAnimalIds: ["cow-1"],
    reproductiveEvents: [
      { id: "calving-previous", animalId: "cow-1", eventType: "calving", occurredAt: "2024-12-31" },
      { id: "calving-current", animalId: "cow-1", eventType: "calving", occurredAt: "2026-01-01" },
      { id: "insemination", animalId: "cow-1", eventType: "insemination", occurredAt: "2026-06-05" },
      { id: "pregnancy", animalId: "cow-1", eventType: "pregnancy_diagnosis", occurredAt: "2026-06-20", result: "positive" },
    ],
    weights: [
      { id: "weight-1", animalId: "cow-1", date: "2026-06-01", weightKg: 300 },
      { id: "weight-2", animalId: "cow-1", date: "2026-06-11", weightKg: 300 },
    ],
    outcomes,
    herdExposure: [
      { id: "herd-start", date: "2026-06-01", activeAnimals: 100 },
      { id: "herd-end", date: "2026-06-30", activeAnimals: 100 },
    ],
    finances: [
      { id: "finance", date: "2026-06-30", milkRevenueClp: 100_000, feedCostClp: 100_000, otherCostClp: 70_000 },
    ],
  });

  assert.equal(projection.schemaVersion, ANALYTICS_SCHEMA_VERSION);
  assert.deepEqual(projection.reference, {
    organizationId: "org-a",
    fieldId: "field-a",
    datasetRevision: "events:42",
    sourceCounts: {
      milkProduction: 4,
      milkQuality: 3,
      reproductiveEvents: 4,
      lactations: 0,
      milkControls: 0,
      weights: 2,
      outcomes: 18,
      herdExposure: 2,
      finances: 1,
    },
    sourceCoverage: { outcomesComplete: true },
  });
  assert.equal(metric(projection, "milk.volume_liters").value, 1_700);
  assert.equal(metric(projection, "milk.volume_trend_pct").value, -15);
  assert.equal(metric(projection, "milk.production_per_cow_day_liters").value, 8.5);
  assert.equal(metric(projection, "milk.fat_pct").value, 3.9);
  assert.equal(metric(projection, "milk.fat_pct_change_pp").value, 0.2);
  assert.equal(metric(projection, "milk.protein_pct").value, 3.4);
  assert.equal(metric(projection, "milk.somatic_cell_count").value, 400_000);
  assert.equal(metric(projection, "milk.somatic_cell_count").method, "volume_weighted_mean");
  assert.equal(metric(projection, "reproduction.pregnancy_rate_pct").value, 100);
  assert.equal(metric(projection, "reproduction.days_open_average").value, 155);
  assert.equal(metric(projection, "reproduction.calving_interval_days_average").value, 366);
  assert.equal(metric(projection, "weight.average_daily_gain_kg").value, 0);
  assert.equal(metric(projection, "health.mastitis_rate_pct").value, 5);
  assert.equal(metric(projection, "outcomes.mortality_rate_pct").value, 3);
  assert.equal(metric(projection, "outcomes.discard_rate_pct").value, 10);
  assert.equal(metric(projection, "finance.feed_cost_clp").value, 100_000);
  assert.equal(metric(projection, "finance.iofc_clp").value, 0);
  assert.equal(metric(projection, "finance.cost_per_liter_clp").value, 100);

  for (const code of [
    "MILK_PRODUCTION_DROP",
    "SOMATIC_CELL_COUNT_HIGH",
    "MASTITIS_RATE_HIGH",
    "DAYS_OPEN_HIGH",
    "WEIGHT_GAIN_LOW",
    "MORTALITY_RATE_HIGH",
    "DISCARD_RATE_HIGH",
    "IOFC_LOW",
  ]) {
    assert.equal(evaluation(projection, code).status, "triggered", code);
  }
  assert.equal(evaluation(projection, "PREGNANCY_RATE_LOW").status, "clear");
  assert.equal(evaluation(projection, "CALVING_INTERVAL_HIGH").status, "clear");
  assert.equal(projection.alerts.length, 8);
  for (const alert of projection.alertEvaluations) {
    assert.equal(typeof alert.code, "string");
    assert.ok(alert.explanation.length > 0);
    assert.ok(alert.evidence.metricKey);
    assert.deepEqual(alert.window, projection.window);
  }
});

test("builds a reproducible lactation curve and only flags problem cows from linked controls", () => {
  const projection = buildAnalyticsProjection({
    period: "2026-06",
    lactations: [
      { id: "lactation-cow-1", animalId: "cow-1", animalLabel: "Vaca 101", startedAt: "2026-01-01", status: "active" },
      { id: "lactation-cow-2", animalId: "cow-2", animalLabel: "Vaca 202", startedAt: "2026-04-01", status: "active" },
    ],
    milkControls: [
      { id: "c1-1", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-01-15", totalLiters: 30, somaticCellCount: 150_000 },
      { id: "c1-2", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-02-15", totalLiters: 35, somaticCellCount: 170_000 },
      { id: "c1-3", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-03-15", totalLiters: 32, somaticCellCount: 190_000 },
      { id: "c1-4", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-04-15", totalLiters: 28, somaticCellCount: 220_000 },
      { id: "c1-5", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-05-15", totalLiters: 25, somaticCellCount: 350_000 },
      { id: "c1-6", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-06-15", totalLiters: 20, somaticCellCount: 800_000 },
      { id: "c2-1", animalId: "cow-2", animalLabel: "Vaca 202", lactationId: "lactation-cow-2", date: "2026-04-15", totalLiters: 20, somaticCellCount: 100_000 },
      { id: "c2-2", animalId: "cow-2", animalLabel: "Vaca 202", lactationId: "lactation-cow-2", date: "2026-05-15", totalLiters: 22, somaticCellCount: 110_000 },
      { id: "unlinked", animalId: "cow-2", date: "2026-06-15", totalLiters: 99, somaticCellCount: 900_000 },
    ],
  });

  assert.equal(metric(projection, "lactation.days_in_milk_average").value, 136);
  assert.equal(metric(projection, "lactation.curve.dim_001_030_liters").value, 25);
  assert.equal(metric(projection, "lactation.curve.dim_031_060_liters").value, 28.5);
  assert.equal(metric(projection, "lactation.curve.dim_151_180_liters").value, 20);
  assert.deepEqual(metric(projection, "lactation.curve.dim_151_180_liters").references[0].sourceIds, ["c1-6"]);
  assert.equal(metric(projection, "lactation.curve.dim_271_305_liters").status, "unavailable");
  assert.equal(metric(projection, "milk.production.animal:cow-1:liters_per_control_day").value, 20);
  assert.equal(metric(projection, "lactation.curve.animal:cow-1:dim_151_180_liters").value, 20);
  assert.equal(metric(projection, "lactation.historical_lot_membership_coverage_pct").status, "unavailable");
  assert.equal(metric(projection, "lactation.historical_lot_membership_coverage_pct").statusReason, "historical_lot_membership_unavailable");

  const productionDrop = evaluation(projection, "PROBLEM_COW_PRODUCTION_DROP:cow-1");
  assert.equal(productionDrop.evidence.observed, -28.57);
  assert.deepEqual(productionDrop.evidence.observations, [
    { date: "2026-04-15", value: 28 },
    { date: "2026-05-15", value: 25 },
    { date: "2026-06-15", value: 20 },
  ]);
  assert.deepEqual(productionDrop.evidence.subject, { type: "animal", id: "cow-1", label: "Vaca 101" });
  const highScc = evaluation(projection, "PROBLEM_COW_SOMATIC_CELL_HIGH:cow-1");
  assert.equal(highScc.severity, "critical");
  assert.equal(highScc.evidence.observed, 800_000);
  assert.equal(projection.alertEvaluations.some((entry) => entry.code.includes("cow-2")), false);
  assert.deepEqual(projection.quality.issues, [
    { code: "historical_lot_membership_unavailable", count: 8 },
    { code: "unlinked_milk_control", count: 1 },
  ]);

  const replay = buildAnalyticsProjection({
    period: "2026-06",
    lactations: [
      { id: "lactation-cow-2", animalId: "cow-2", animalLabel: "Vaca 202", startedAt: "2026-04-01", status: "active" },
      { id: "lactation-cow-1", animalId: "cow-1", animalLabel: "Vaca 101", startedAt: "2026-01-01", status: "active" },
    ],
    milkControls: [
      { id: "c1-6", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-06-15", totalLiters: 20, somaticCellCount: 800_000 },
      { id: "c1-5", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-05-15", totalLiters: 25, somaticCellCount: 350_000 },
      { id: "c1-4", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-04-15", totalLiters: 28, somaticCellCount: 220_000 },
      { id: "c1-3", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-03-15", totalLiters: 32, somaticCellCount: 190_000 },
      { id: "c1-2", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-02-15", totalLiters: 35, somaticCellCount: 170_000 },
      { id: "c1-1", animalId: "cow-1", animalLabel: "Vaca 101", lactationId: "lactation-cow-1", date: "2026-01-15", totalLiters: 30, somaticCellCount: 150_000 },
      { id: "c2-2", animalId: "cow-2", animalLabel: "Vaca 202", lactationId: "lactation-cow-2", date: "2026-05-15", totalLiters: 22, somaticCellCount: 110_000 },
      { id: "c2-1", animalId: "cow-2", animalLabel: "Vaca 202", lactationId: "lactation-cow-2", date: "2026-04-15", totalLiters: 20, somaticCellCount: 100_000 },
      { id: "unlinked", animalId: "cow-2", date: "2026-06-15", totalLiters: 99, somaticCellCount: 900_000 },
    ],
  });
  assert.deepEqual(replay.metrics.filter((entry) => entry.key.startsWith("lactation.")), projection.metrics.filter((entry) => entry.key.startsWith("lactation.")));
  assert.deepEqual(replay.alerts, projection.alerts);

  const shortNoise = buildAnalyticsProjection({
    period: "2026-06",
    lactations: [{ id: "short-lactation", animalId: "cow-short", startedAt: "2026-01-01", status: "active" }],
    milkControls: [
      { id: "short-1", animalId: "cow-short", lactationId: "short-lactation", date: "2026-06-10", totalLiters: 30 },
      { id: "short-2", animalId: "cow-short", lactationId: "short-lactation", date: "2026-06-12", totalLiters: 25 },
      { id: "short-3", animalId: "cow-short", lactationId: "short-lactation", date: "2026-06-14", totalLiters: 20 },
    ],
  });
  assert.equal(shortNoise.alerts.some((entry) => entry.code.startsWith("PROBLEM_COW_PRODUCTION_DROP:")), false);
});

test("attributes individual production and curves to the historical lot only when membership is resolved", () => {
  const projection = buildAnalyticsProjection({
    period: "2026-06",
    lactations: [{ id: "lactation-1", animalId: "cow-1", animalLabel: "Vaca 101", startedAt: "2026-05-01", status: "active" }],
    milkControls: [
      {
        id: "control-1",
        animalId: "cow-1",
        animalLabel: "Vaca 101",
        lactationId: "lactation-1",
        historicalLotId: "lot-milking",
        historicalLotName: "Ordeña 1",
        date: "2026-06-10",
        totalLiters: 26,
      },
    ],
  });
  const lotProduction = metric(projection, "milk.production.lot:lot-milking:liters_per_control_day");
  assert.equal(lotProduction.value, 26);
  assert.deepEqual(lotProduction.references[0].subject, { type: "lot", id: "lot-milking", label: "Ordeña 1" });
  assert.equal(metric(projection, "lactation.curve.lot:lot-milking:dim_031_060_liters").value, 26);
  assert.equal(metric(projection, "lactation.historical_lot_membership_coverage_pct").value, 100);
  assert.equal(projection.quality.issues.some((entry) => entry.code.includes("historical_lot")), false);
});

test("explains expected heat with a configurable cycle and keeps the recommendation adapter pluggable", () => {
  const projection = buildAnalyticsProjection({
    period: "2026-06",
    reproductiveEvents: [
      { id: "heat-1", animalId: "cow-1", animalLabel: "Vaca 101", eventType: "heat", occurredAt: "2026-06-03" },
    ],
  }, { thresholds: { expectedHeatCycleDays: 18 } });
  const heat = evaluation(projection, "EXPECTED_HEAT:cow-1:2026-06-21");
  assert.equal(heat.status, "triggered");
  assert.equal(heat.evidence.threshold, 18);
  assert.equal(heat.evidence.anchorDate, "2026-06-03");
  assert.equal(heat.evidence.expectedDate, "2026-06-21");
  assert.deepEqual(heat.evidence.subject, { type: "animal", id: "cow-1", label: "Vaca 101" });
  assert.equal(projection.recommendationEngine.version, ANALYTICS_RECOMMENDATION_ENGINE_VERSION);
  assert.equal(projection.recommendationEngine.strategy, "rules");

  const adapter = createRuleBasedRecommendationEngine({
    adapterId: "fundosmart.analytics.test-rules.v1",
    evaluate: ({ window }) => [{
      code: "TEST_RULE",
      status: "clear",
      severity: "warning",
      explanation: "Adapter de prueba sin ML.",
      evidence: {
        metricKey: "test.rule",
        observed: 0,
        operator: "gte",
        threshold: 1,
        unit: null,
        numerator: 0,
        denominator: 1,
        sampleCount: 1,
      },
      window,
    }],
  });
  const plugged = buildAnalyticsProjection({ period: "2026-06" }, { recommendationEngine: adapter });
  assert.equal(plugged.recommendationEngine.adapterId, "fundosmart.analytics.test-rules.v1");
  assert.deepEqual(plugged.alertEvaluations.map((entry) => entry.code), ["TEST_RULE"]);
});

test("keeps zero denominators explicit and never emits NaN or Infinity", () => {
  const projection = buildAnalyticsProjection({
    period: "2026-06",
    outcomesComplete: true,
    milkProduction: [
      { id: "prior-zero", date: "2026-05-15", liters: 0, milkingCowCount: 0 },
      { id: "current-zero", date: "2026-06-15", liters: 0, milkingCowCount: 0 },
    ],
    herdExposure: [{ id: "empty-herd", date: "2026-06-15", activeAnimals: 0 }],
    outcomes: [{ id: "death", date: "2026-06-15", animalId: "cow-1", type: "death" }],
    finances: [{ id: "cost", date: "2026-06-15", milkRevenueClp: 0, feedCostClp: 1_000, otherCostClp: 500 }],
  });

  assert.deepEqual(
    [metric(projection, "milk.volume_trend_pct").status, metric(projection, "milk.volume_trend_pct").statusReason],
    ["insufficient_data", "zero_comparison_denominator"],
  );
  assert.deepEqual(
    [metric(projection, "milk.production_per_cow_day_liters").status, metric(projection, "milk.production_per_cow_day_liters").statusReason],
    ["insufficient_data", "zero_or_missing_cow_days"],
  );
  assert.equal(metric(projection, "outcomes.mortality_rate_pct").status, "insufficient_data");
  assert.equal(metric(projection, "finance.cost_per_liter_clp").status, "insufficient_data");
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("NaN"), false);
  assert.equal(serialized.includes("Infinity"), false);
});

test("degrades sparse and invalid facts to explicit quality and metric states", () => {
  const projection = buildAnalyticsProjection({
    period: "2026-06",
    milkProduction: [
      { id: "invalid", date: "2026-06-01", liters: -1 },
      { id: "sparse", date: "2026-06-02", liters: 15 },
      { id: "future", date: "2026-07-01", liters: 999, milkingCowCount: 1 },
    ],
    weights: [{ id: "single-weight", date: "2026-06-02", animalId: "cow-1", weightKg: 300 }],
    milkQuality: [
      { id: "bad-quality", date: "not-a-date", somaticCellCount: 100_000 },
      { id: "partially-bad-quality", date: "2026-06-05", fatPct: -1, somaticCellCount: 100_000 },
    ],
  });

  assert.equal(projection.quality.state, "partial");
  assert.deepEqual(projection.quality.issues, [
    { code: "invalid_milk_production", count: 1 },
    { code: "invalid_milk_quality", count: 1 },
    { code: "invalid_milk_quality_value", count: 1 },
  ]);
  assert.equal(metric(projection, "milk.volume_liters").value, 15);
  assert.equal(metric(projection, "milk.production_per_cow_day_liters").status, "insufficient_data");
  assert.equal(metric(projection, "weight.average_daily_gain_kg").status, "insufficient_data");
  assert.equal(metric(projection, "milk.somatic_cell_count").status, "available");
  assert.equal(evaluation(projection, "SOMATIC_CELL_COUNT_HIGH").status, "clear");
  assert.equal(projection.alerts.length, 0);
});

test("reports overall quality as partial until every analytics domain is represented", () => {
  const milkOnly = buildAnalyticsProjection({
    period: "2026-06",
    milkProduction: [
      { id: "milk-only", date: "2026-06-15", liters: 100, milkingCowCount: 10 },
    ],
  });
  assert.equal(milkOnly.quality.domains.milk, "available");
  assert.deepEqual(
    Object.entries(milkOnly.quality.domains)
      .filter(([, state]) => state === "unavailable")
      .map(([domain]) => domain),
    ["reproduction", "lactation", "weight", "outcomes", "finance"],
  );
  assert.equal(milkOnly.quality.issues.length, 0);
  assert.equal(milkOnly.quality.state, "partial");

  const empty = buildAnalyticsProjection({ period: "2026-06" });
  assert.equal(empty.quality.state, "unavailable");
  assert.equal(Object.values(empty.quality.domains).every((state) => state === "unavailable"), true);
});

test("does not infer zero outcome rates unless source completeness is declared", () => {
  const unknown = buildAnalyticsProjection({
    period: "2026-06",
    outcomes: [{ id: "observed-death", date: "2026-06-10", animalId: "cow-1", type: "death" }],
    herdExposure: [{ id: "herd", date: "2026-06-15", activeAnimals: 100 }],
  });
  assert.equal(metric(unknown, "outcomes.mortality_rate_pct").status, "unavailable");
  assert.equal(metric(unknown, "outcomes.mortality_rate_pct").statusReason, "outcome_source_not_confirmed_complete");

  const confirmedEmpty = buildAnalyticsProjection({
    period: "2026-06",
    outcomesComplete: true,
    outcomes: [],
    herdExposure: [{ id: "herd", date: "2026-06-15", activeAnimals: 100 }],
  });
  assert.equal(metric(confirmedEmpty, "outcomes.mortality_rate_pct").status, "available");
  assert.equal(metric(confirmedEmpty, "outcomes.mortality_rate_pct").value, 0);
  assert.equal(metric(confirmedEmpty, "health.mastitis_case_count").value, 0);
});

test("flags robust outliers without silently excluding them", () => {
  const milkProduction = [20, 21, 22, 1_000].map((liters, index) => ({
    id: `milk-${index}`,
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    liters,
  }));
  const weights = [300, 301, 302, 10_000].map((weightKg, index) => ({
    id: `weight-${index}`,
    animalId: "cow-1",
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    weightKg,
  }));
  const milkQuality = [100_000, 101_000, 102_000, 5_000_000].map((somaticCellCount, index) => ({
    id: `quality-${index}`,
    date: `2026-06-${String(index + 1).padStart(2, "0")}`,
    somaticCellCount,
  }));
  const projection = buildAnalyticsProjection({
    period: "2026-06",
    milkProduction,
    weights,
    milkQuality,
  });

  assert.equal(metric(projection, "milk.volume_liters").value, 1_063);
  assert.equal(metric(projection, "milk.somatic_cell_count").value, 1_325_750);
  assert.deepEqual(projection.quality.issues, [
    { code: "suspected_outlier_milk_liters", count: 1 },
    { code: "suspected_outlier_somatic_cell_count", count: 1 },
    { code: "suspected_outlier_weight", count: 1 },
  ]);
});

test("is stable across input ordering and repeated recomputation", () => {
  const facts = {
    period: "2026-06",
    datasetRevision: "stable-1",
    milkProduction: [
      { id: "b", date: "2026-06-02", liters: 10, milkingCowCount: 2 },
      { id: "a", date: "2026-06-01", liters: 20, milkingCowCount: 2 },
      { id: "p", date: "2026-05-01", liters: 30, milkingCowCount: 2 },
    ],
    weights: [
      { id: "w2", animalId: "cow-1", date: "2026-06-10", weightKg: 110 },
      { id: "w1", animalId: "cow-1", date: "2026-06-01", weightKg: 100 },
    ],
    finances: [
      { id: "f2", date: "2026-06-02", feedCostClp: 10 },
      { id: "f1", date: "2026-06-01", milkRevenueClp: 100, otherCostClp: 5 },
    ],
  };
  const first = buildAnalyticsProjection(facts);
  const second = buildAnalyticsProjection({
    ...facts,
    milkProduction: [...facts.milkProduction].reverse(),
    weights: [...facts.weights].reverse(),
    finances: [...facts.finances].reverse(),
  });
  const third = buildAnalyticsProjection(facts);
  assert.deepEqual(first, second);
  assert.deepEqual(first, third);
});

test("validates threshold configuration and exposes unavailable rule evidence", () => {
  const projection = buildAnalyticsProjection({ period: "2026-06" });
  const unavailable = evaluation(projection, "IOFC_LOW");
  assert.deepEqual(unavailable.evidence, {
    metricKey: "finance.iofc_clp",
    observed: null,
    operator: "lte",
    threshold: 0,
    unit: "clp",
    numerator: null,
    denominator: null,
    sampleCount: 0,
  });
  assert.equal(unavailable.status, "unavailable");
  assert.throws(
    () => evaluateAnalyticsAlerts(projection, { somaticCellHigh: 800_000, somaticCellCritical: 700_000 }),
    /ordenados/,
  );
  assert.throws(
    () => evaluateAnalyticsAlerts(projection, { milkDropPct: 5 }),
    /cero o negativo/,
  );
  assert.throws(
    () => evaluateAnalyticsAlerts(projection, { expectedHeatCycleDays: 60.5 }),
    /entero entre 1 y 60/,
  );
});
