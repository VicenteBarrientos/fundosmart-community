import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateCalvingInterval,
  calculateDaysOpen,
} from "../src/modules/leche/domain/reproduction-metrics.mjs";
import {
  buildAnalyticsProjection,
} from "../src/modules/analytics/domain/analytics-projection.mjs";

const event = (id, animalId, eventType, occurredAt, extra = {}) => ({
  id,
  animalId,
  eventType,
  occurredAt,
  result: null,
  metadata: {},
  raw: { id, sourceRecordId: `sr_${id}` },
  ...extra,
});

test("calculateCalvingInterval links previous and latest calving events with source references", () => {
  const events = [
    event("ev-c1", "cow-101", "calving", "2024-03-15"),
    event("ev-c2", "cow-101", "calving", "2025-04-01"),
  ];

  const result = calculateCalvingInterval(events, "2025-06-01");

  assert.ok(result);
  assert.equal(result.days, 382);
  assert.equal(result.previousCalvingDate, "2024-03-15");
  assert.equal(result.latestCalvingDate, "2025-04-01");
  assert.equal(result.previousEventId, "ev-c1");
  assert.equal(result.latestEventId, "ev-c2");
  assert.deepEqual(result.sourceRecordIds, ["sr_ev-c1", "sr_ev-c2"]);
});

test("calculateDaysOpen returns insufficient_data status when breeding events are missing", () => {
  const events = [
    event("ev-c1", "cow-101", "calving", "2024-03-15"),
    event("ev-c2", "cow-101", "calving", "2025-04-01"),
  ];

  const result = calculateDaysOpen(events, "2025-06-01");

  assert.ok(result);
  assert.equal(result.status, "insufficient_data");
  assert.equal(result.reason, "no_service_or_insemination_events");
  assert.equal(result.calvingDate, "2025-04-01");
  assert.equal(result.conceptionDate, null);
});

test("buildAnalyticsProjection emits calving_interval_days_average and insufficient_data for days_open_average", () => {
  const events = [
    event("ev-c1", "cow-101", "calving", "2024-03-15"),
    event("ev-c2", "cow-101", "calving", "2025-04-01"),
    event("ev-c3", "cow-102", "calving", "2024-05-10"),
    event("ev-c4", "cow-102", "calving", "2025-06-01"),
  ];

  const projection = buildAnalyticsProjection({
    reproductiveEvents: events,
    declaredAnimalIds: ["cow-101", "cow-102"],
    window: { start: "2024-01-01", end: "2025-12-31" },
  });

  const calvingIntervalMetric = projection.metrics.find(
    (m) => m.key === "reproduction.calving_interval_days_average"
  );
  assert.ok(calvingIntervalMetric);
  assert.equal(calvingIntervalMetric.status, "available");
  assert.equal(calvingIntervalMetric.value, 384.5); // (382 + 387) / 2

  const daysOpenMetric = projection.metrics.find(
    (m) => m.key === "reproduction.days_open_average"
  );
  assert.ok(daysOpenMetric);
  assert.equal(daysOpenMetric.status, "insufficient_data");
  assert.equal(daysOpenMetric.statusReason, "no_service_or_insemination_events");
});
