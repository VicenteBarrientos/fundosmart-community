import assert from "node:assert/strict";
import test from "node:test";

import { buildAnimalInsights } from "../src/modules/ganado/ficha/server/animal-insights.mjs";
import {
  AnimalRecordRuleError,
  normalizeBirthInput,
  normalizeHealthEventInput,
} from "../src/modules/ganado/ficha/server/animal-record-rules.mjs";

test("normalizes a twin birth with offspring genealogy data", () => {
  const result = normalizeBirthInput({
    animalId: "cow-1",
    occurredAt: "2026-07-17",
    calvingType: "twin",
    difficulty: "assisted",
    outcome: "live",
    sireIdentifier: " TORO-9 ",
    offspring: [
      { temporaryIdentifier: "CRIA-1", sex: "female", outcome: "alive", birthWeightKg: "38,5" },
      { temporaryIdentifier: "CRIA-2", sex: "male", outcome: "alive", birthWeightKg: 40 },
    ],
  });
  assert.equal(result.offspring.length, 2);
  assert.equal(result.offspring[0].birthWeightKg, 38.5);
  assert.equal(result.sireIdentifier, "TORO-9");
});

test("rejects inconsistent calving counts and duplicate offspring identifiers", () => {
  assert.throws(
    () => normalizeBirthInput({ animalId: "cow-1", occurredAt: "2026-07-17", calvingType: "twin", difficulty: "unassisted", outcome: "live", offspring: [{ temporaryIdentifier: "A", sex: "female", outcome: "alive" }] }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "CALVING_COUNT_MISMATCH",
  );
  assert.throws(
    () => normalizeBirthInput({ animalId: "cow-1", occurredAt: "2026-07-17", calvingType: "twin", difficulty: "unassisted", outcome: "live", offspring: [{ temporaryIdentifier: "A", sex: "female", outcome: "alive" }, { temporaryIdentifier: "a", sex: "male", outcome: "alive" }] }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "OFFSPRING_IDENTIFIER_DUPLICATE",
  );
});

test("normalizes a treatment with dose and withdrawal dates", () => {
  const result = normalizeHealthEventInput({
    animalId: "cow-1",
    eventType: "treatment",
    occurredAt: "2026-07-10",
    status: "completed",
    condition: " Mastitis ",
    productName: "Producto registrado",
    doseAmount: "12,5",
    doseUnit: "mL",
    withdrawalMilkUntil: "2026-07-15",
    withdrawalMeatUntil: "2026-07-25",
  });
  assert.equal(result.condition, "Mastitis");
  assert.equal(result.doseAmount, 12.5);
  assert.equal(result.withdrawalMilkUntil, "2026-07-15");
});

test("rejects incomplete doses and withdrawals before treatment", () => {
  const base = { animalId: "cow-1", eventType: "treatment", occurredAt: "2026-07-10", status: "completed", condition: "Mastitis", productName: "Producto" };
  assert.throws(
    () => normalizeHealthEventInput({ ...base, doseAmount: 10 }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "HEALTH_DOSE_INCOMPLETE",
  );
  assert.throws(
    () => normalizeHealthEventInput({ ...base, withdrawalMilkUntil: "2026-07-09" }),
    (error) => error instanceof AnimalRecordRuleError && error.code === "HEALTH_WITHDRAWAL_INVALID",
  );
});

test("surfaces active withdrawal, overdue health follow-up, and a recent birth", () => {
  const insights = buildAnimalInsights({
    births: [{ occurredAt: "2026-07-01", offspring: [{}, {}] }],
    healthEvents: [
      { eventType: "treatment", occurredAt: "2026-07-01", status: "open", condition: "Mastitis", withdrawalMilkUntil: "2026-07-20", withdrawalMeatUntil: null },
    ],
    lactations: [],
    milkControls: [],
    reproductiveEvents: [],
    weighings: [],
  }, "2026-07-18T12:00:00Z");
  assert.ok(insights.some((entry) => entry.code === "ACTIVE_WITHDRAWAL"));
  assert.ok(insights.some((entry) => entry.code === "HEALTH_FOLLOW_UP_DUE"));
  assert.ok(insights.some((entry) => entry.code === "RECENT_BIRTH"));
});
