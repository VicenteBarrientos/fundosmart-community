import assert from "node:assert/strict";
import test from "node:test";

import { buildAnimalInsights } from "../src/modules/ganado/ficha/server/animal-insights.mjs";
import {
  AnimalRecordRuleError,
  normalizeMilkControlInput,
  normalizeReproductiveEventInput,
} from "../src/modules/ganado/ficha/server/animal-record-rules.mjs";

test("normalizes a milk control and derives the total from milkings", () => {
  const result = normalizeMilkControlInput({
    animalId: "animal-1",
    controlDate: "2026-07-17",
    morningLiters: "8,5",
    afternoonLiters: 7.25,
    thirdMilkingLiters: 1,
    totalLiters: null,
    fatPct: 3.8,
    proteinPct: 3.2,
    somaticCellCount: 180000,
    notes: "  Control mensual  ",
  });

  assert.equal(result.totalLiters, 16.75);
  assert.equal(result.morningLiters, 8.5);
  assert.equal(result.notes, "Control mensual");
});

test("rejects inconsistent totals and implausible percentages", () => {
  assert.throws(
    () => normalizeMilkControlInput({ animalId: "animal-1", controlDate: "2026-07-17", morningLiters: 8, afternoonLiters: 8, totalLiters: 10 }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "MILK_TOTAL_MISMATCH",
  );
  assert.throws(
    () => normalizeMilkControlInput({ animalId: "animal-1", controlDate: "2026-07-17", totalLiters: 10, fatPct: 21 }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "MILK_PERCENTAGE_INVALID",
  );
});

test("validates the reproductive event contract", () => {
  assert.deepEqual(normalizeReproductiveEventInput({
    animalId: "animal-1",
    eventType: "insemination",
    occurredAt: "2026-06-01",
    method: "  IA  ",
    result: "",
    sireIdentifier: "TORO-42",
    notes: "",
  }), {
    animalId: "animal-1",
    eventType: "insemination",
    occurredAt: "2026-06-01",
    method: "IA",
    result: null,
    sireIdentifier: "TORO-42",
    notes: "",
  });
  assert.throws(
    () => normalizeReproductiveEventInput({ animalId: "animal-1", eventType: "unknown", occurredAt: "2026-06-01" }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "REPRODUCTIVE_EVENT_INVALID",
  );
});

test("detects a production drop and a pending pregnancy check", () => {
  const insights = buildAnimalInsights({
    lactations: [{ startedAt: "2026-01-01", status: "active" }],
    milkControls: [
      { controlDate: "2026-07-10", totalLiters: 12 },
      { controlDate: "2026-06-20", totalLiters: 20 },
      { controlDate: "2026-05-30", totalLiters: 19 },
    ],
    reproductiveEvents: [{ occurredAt: "2026-05-20", eventType: "insemination" }],
    weighings: [],
  }, "2026-07-18T12:00:00Z");

  assert.ok(insights.some((entry) => entry.code === "MILK_DROP"));
  assert.ok(insights.some((entry) => entry.code === "PREGNANCY_CHECK_DUE"));
  assert.ok(insights.some((entry) => entry.code === "ACTIVE_LACTATION"));
});

test("a later pregnancy diagnosis clears the follow-up alert", () => {
  const insights = buildAnimalInsights({
    lactations: [],
    milkControls: [],
    reproductiveEvents: [
      { occurredAt: "2026-06-30", eventType: "pregnancy_diagnosis" },
      { occurredAt: "2026-05-20", eventType: "service" },
    ],
    weighings: [],
  }, "2026-07-18T12:00:00Z");
  assert.equal(insights.some((entry) => entry.code === "PREGNANCY_CHECK_DUE"), false);
});
