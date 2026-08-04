import assert from "node:assert/strict";
import test from "node:test";
import {
  aggregateBenchmarkContributions,
  BENCHMARK_TERMS_REVISION,
  BenchmarkPrivacyError,
  normalizeBenchmarkConsent,
  normalizeBenchmarkContribution,
  normalizeBenchmarkProfile,
} from "../src/modules/benchmarking/domain/benchmarking-rules.mjs";

const profile = {
  zone: "los_lagos",
  herdSizeBand: "100_199",
  productionSystem: "pasture",
};

function contribution(index, value, overrides = {}) {
  return {
    organizationId: `org-${index}`,
    fieldId: `field-${index}`,
    period: "2026-06",
    dataMode: "real",
    consentStatus: "opted_in",
    profile,
    metrics: [{
      key: "milk.production_per_cow_day_liters",
      status: "available",
      value,
      unit: "liters_per_cow_day",
      sourceSchemaVersion: "fundosmart.analytics.projection.v1",
    }],
    ...overrides,
  };
}

test("Type 7 percentiles and private ranks are deterministic", () => {
  const values = [contribution(1, 10), contribution(2, 20), contribution(3, 30), contribution(4, 40), contribution(5, 50)];
  const first = aggregateBenchmarkContributions(values, { kThreshold: 5 });
  const reordered = aggregateBenchmarkContributions([...values].reverse(), { kThreshold: 5 });
  assert.deepEqual(first, reordered);
  assert.deepEqual(first.aggregates[0].percentiles, { p10: 14, p25: 20, p50: 30, p75: 40, p90: 46 });
  assert.equal(first.aggregates[0].participantCount, 5);
  assert.deepEqual(first.positions.map((row) => row.percentileRank), [10, 30, 50, 70, 90]);
});

test("cohorts below k are suppressed without count, values or private positions", () => {
  const result = aggregateBenchmarkContributions([
    contribution(1, 10),
    contribution(2, 999),
    contribution(3, 20),
    contribution(4, 30),
  ], { kThreshold: 5 });
  assert.deepEqual(result.positions, []);
  assert.equal(result.aggregates[0].status, "suppressed");
  assert.equal(result.aggregates[0].participantCount, null);
  assert.equal(result.aggregates[0].percentiles, null);
  assert.equal(result.groupCounts[0].participantCount, 4);
  const serialized = JSON.stringify(result.aggregates);
  assert.doesNotMatch(serialized, /org-|field-|999/u);
});

test("the one-way boundary rejects raw evidence, references and source identifiers", () => {
  const withReferences = contribution(1, 10);
  withReferences.metrics[0].references = [{ sourceIds: ["animal-secret"] }];
  assert.throws(() => normalizeBenchmarkContribution(withReferences), BenchmarkPrivacyError);

  const withRawFacts = { ...contribution(1, 10), livestockAnimals: [{ id: "animal-secret" }] };
  assert.throws(() => normalizeBenchmarkContribution(withRawFacts), /frontera permitida/u);

  const wrongContract = contribution(1, 10);
  wrongContract.metrics[0].sourceSchemaVersion = "legacy.analytics.v0";
  assert.throws(() => normalizeBenchmarkContribution(wrongContract), /Fase 3/u);
});

test("demo, missing consent and duplicate contributions never enter an aggregate", () => {
  assert.throws(
    () => normalizeBenchmarkContribution(contribution(1, 10, { dataMode: "demo" })),
    (error) => error.code === "BENCHMARK_DEMO_FORBIDDEN",
  );
  assert.throws(
    () => normalizeBenchmarkContribution(contribution(1, 10, { consentStatus: "opted_out" })),
    (error) => error.code === "BENCHMARK_CONSENT_REQUIRED",
  );
  assert.throws(
    () => aggregateBenchmarkContributions([contribution(1, 10), contribution(1, 10)], { kThreshold: 3 }),
    /dos veces/u,
  );
});

test("opt-in is explicit and versioned while opt-out is unconditional", () => {
  assert.throws(
    () => normalizeBenchmarkConsent({ status: "opted_in", termsRevision: BENCHMARK_TERMS_REVISION, confirmed: false }),
    (error) => error.code === "BENCHMARK_EXPLICIT_CONSENT_REQUIRED",
  );
  assert.throws(
    () => normalizeBenchmarkConsent({ status: "opted_in", termsRevision: "old", confirmed: true }),
    (error) => error.code === "BENCHMARK_TERMS_MISMATCH",
  );
  assert.deepEqual(
    normalizeBenchmarkConsent({ status: "opted_in", termsRevision: BENCHMARK_TERMS_REVISION, confirmed: true }),
    { status: "opted_in", termsRevision: BENCHMARK_TERMS_REVISION },
  );
  assert.deepEqual(
    normalizeBenchmarkConsent({ status: "opted_out", termsRevision: "ignored", confirmed: false }),
    { status: "opted_out", termsRevision: null },
  );
});

test("cohort dimensions are closed catalogs, not identifying free text", () => {
  assert.deepEqual(normalizeBenchmarkProfile(profile), profile);
  assert.throws(
    () => normalizeBenchmarkProfile({ ...profile, zone: "sector-los-robles-owner-name" }),
    /catálogo/u,
  );
  assert.throws(
    () => normalizeBenchmarkProfile({ ...profile, breed: "rare-private-breed" }),
    /dimensiones no permitidas/u,
  );
});
