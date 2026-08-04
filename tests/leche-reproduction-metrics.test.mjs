import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReproductiveWorklists,
  calculateCalvingInterval,
  calculateDaysOpen,
  calculateReproductiveRates,
  isPositivePregnancyDiagnosis,
} from "../src/modules/leche/domain/reproduction-metrics.mjs";

const event = (id, animalId, eventType, occurredAt, extra = {}) => ({
  id,
  animalId,
  eventType,
  occurredAt,
  result: null,
  metadata: {},
  ...extra,
});

test("infers conception from an explicitly positive diagnosis and calculates days open", () => {
  const events = [
    event("c0", "cow-1", "calving", "2025-01-01"),
    event("c1", "cow-1", "calving", "2026-01-01"),
    event("i1", "cow-1", "insemination", "2026-03-10"),
    event("p1", "cow-1", "pregnancy_diagnosis", "2026-04-15", { result: "Preñada" }),
  ];

  assert.equal(isPositivePregnancyDiagnosis(events[3]), true);
  assert.deepEqual(calculateDaysOpen(events, "2026-07-20"), {
    days: 68,
    status: "conceived",
    calvingDate: "2026-01-01",
    conceptionDate: "2026-03-10",
  });
  assert.deepEqual(calculateCalvingInterval(events, "2026-07-20"), {
    days: 365,
    previousCalvingDate: "2025-01-01",
    latestCalvingDate: "2026-01-01",
    previousEventId: "c0",
    latestEventId: "c1",
    sourceRecordIds: ["c0", "c1"],
  });
});

test("keeps days open through asOf when pregnancy is not explicitly confirmed", () => {
  const events = [
    event("c1", "cow-1", "calving", "2026-01-01"),
    event("i1", "cow-1", "insemination", "2026-03-10"),
    event("p1", "cow-1", "pregnancy_diagnosis", "2026-04-15", { result: "Negativo" }),
  ];
  assert.deepEqual(calculateDaysOpen(events, "2026-04-20"), {
    days: 109,
    status: "open",
    calvingDate: "2026-01-01",
    conceptionDate: null,
  });
});

test("a later negative pregnancy diagnosis invalidates the confirmed conception", () => {
  const events = [
    event("c1", "cow-1", "calving", "2026-01-01"),
    event("i1", "cow-1", "insemination", "2026-03-01"),
    event("p1", "cow-1", "pregnancy_diagnosis", "2026-04-05", { result: "Positivo" }),
    event("n1", "cow-1", "pregnancy_diagnosis", "2026-06-01", { result: "Negativo" }),
  ];

  assert.deepEqual(calculateDaysOpen(events, "2026-07-01"), {
    days: 181,
    status: "open",
    calvingDate: "2026-01-01",
    conceptionDate: null,
  });

  const lists = buildReproductiveWorklists(events, "2026-10-01", {
    lookAheadDays: 7,
  });
  assert.deepEqual(lists.dryOff, []);
  assert.deepEqual(
    lists.expectedHeat.map((item) => item.animalId),
    ["cow-1"],
  );
});

test("calculates heat detection, conception and pregnancy rates over 21-day opportunities", () => {
  const events = [
    event("c1", "cow-1", "calving", "2026-01-01"),
    event("h1", "cow-1", "heat", "2026-01-05"),
    event("i1", "cow-1", "insemination", "2026-01-05"),
    event("n1", "cow-1", "pregnancy_diagnosis", "2026-01-20", { result: "Negativo" }),
    event("h2", "cow-1", "heat", "2026-01-25"),
    event("i2", "cow-1", "insemination", "2026-01-25"),
    event("p2", "cow-1", "pregnancy_diagnosis", "2026-02-05", { result: "Positivo" }),
  ];

  assert.deepEqual(calculateReproductiveRates(events, {
    periodStart: "2026-01-01",
    periodEnd: "2026-02-11",
    voluntaryWaitingPeriodDays: 0,
  }), {
    periodStart: "2026-01-01",
    periodEnd: "2026-02-11",
    eligibleAnimalCount: 1,
    eligibleCycleCount: 2,
    detectedHeatCycleCount: 2,
    breedingAttemptCount: 2,
    conceptionCount: 1,
    heatDetectionRatePct: 100,
    conceptionRatePct: 50,
    pregnancyRatePct: 50,
  });
});

test("builds de-duplicated worklists for heat, insemination, pregnancy check and dry-off", () => {
  const events = [
    event("heat-now", "cow-heat", "heat", "2026-07-20"),
    event("calving-check", "cow-check", "calving", "2026-01-01"),
    event("breed-check", "cow-check", "insemination", "2026-06-01"),
    event("calving-pregnant", "cow-pregnant", "calving", "2025-10-01"),
    event("breed-pregnant", "cow-pregnant", "service", "2025-12-01"),
    event("positive", "cow-pregnant", "pregnancy_diagnosis", "2026-01-10", { metadata: { pregnant: true } }),
    event("calving-wait", "cow-wait", "calving", "2026-06-01"),
  ];

  const lists = buildReproductiveWorklists(events, "2026-07-20", { lookAheadDays: 7 });
  assert.deepEqual(lists.toInseminate.map((item) => item.animalId), ["cow-heat"]);
  assert.deepEqual(lists.pregnancyChecks.map((item) => item.animalId), ["cow-check"]);
  assert.deepEqual(lists.dryOff.map((item) => item.animalId), ["cow-pregnant"]);
  assert.deepEqual(lists.expectedHeat.map((item) => item.animalId), ["cow-wait"]);
  assert.equal(lists.pregnancyChecks[0].daysOverdue, 14);
  assert.equal(lists.expectedHeat[0].dueDate, "2026-07-21");
});
