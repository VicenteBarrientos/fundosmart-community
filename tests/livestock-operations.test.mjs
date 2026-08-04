import assert from "node:assert/strict";
import test from "node:test";

import { buildHerdOperations } from "../src/modules/ganado/lib/operations-rules.ts";

const NOW = "2026-07-20T12:00:00.000Z";
const FIELD_ID = "field-1";

function lot(overrides = {}) {
  return {
    id: "lot-dairy",
    fieldId: FIELD_ID,
    paddockId: null,
    name: "Vacas lecheras",
    category: "dairy_cow",
    animalCount: 0,
    averageWeightKg: null,
    entryDate: "2025-01-01",
    status: "active",
    ownerName: null,
    trackingMode: "individual",
    notes: "",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function animal(overrides = {}) {
  return {
    id: "animal-1",
    lotId: "lot-dairy",
    tag: "DIIO-001",
    sex: "female",
    status: "active",
    statusDate: null,
    statusReason: null,
    birthDate: "2023-01-01",
    purchasePriceClp: null,
    purchaseDate: null,
    salePriceClp: null,
    saleBuyer: null,
    saleWeightKg: null,
    origin: null,
    notes: "",
    source: "Prueba",
    latestWeightKg: null,
    latestWeightDate: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function reproductiveEvent(overrides = {}) {
  return {
    id: "repro-1",
    fieldId: FIELD_ID,
    animalId: "animal-1",
    eventType: "insemination",
    occurredAt: "2026-01-01",
    method: "IA",
    result: null,
    sireIdentifier: "TORO-1",
    sireAnimalId: null,
    notes: "",
    metadata: {},
    source: "Prueba",
    sourceRecordId: null,
    createdBy: "tester@example.com",
    createdAt: "2026-01-01T12:00:00.000Z",
    updatedAt: "2026-01-01T12:00:00.000Z",
    ...overrides,
  };
}

function birth(overrides = {}) {
  return {
    id: "birth-1",
    fieldId: FIELD_ID,
    damAnimalId: "animal-1",
    reproductiveEventId: null,
    occurredAt: "2026-07-01",
    calvingType: "single",
    difficulty: "unassisted",
    outcome: "live",
    sireIdentifier: null,
    sireAnimalId: null,
    notes: "",
    source: "Prueba",
    sourceRecordId: null,
    createdBy: "tester@example.com",
    createdAt: "2026-07-01T12:00:00.000Z",
    updatedAt: "2026-07-01T12:00:00.000Z",
    offspring: [],
    ...overrides,
  };
}

function healthEvent(overrides = {}) {
  return {
    id: "health-1",
    fieldId: FIELD_ID,
    animalId: "animal-1",
    eventType: "treatment",
    occurredAt: "2026-07-10",
    status: "completed",
    condition: "Mastitis",
    productName: "Producto veterinario",
    activeIngredient: null,
    doseAmount: 10,
    doseUnit: "mL",
    route: "IM",
    withdrawalMilkUntil: null,
    withdrawalMeatUntil: null,
    professional: "Veterinario",
    notes: "",
    metadata: {},
    source: "Prueba",
    sourceRecordId: null,
    createdBy: "tester@example.com",
    createdAt: "2026-07-10T12:00:00.000Z",
    updatedAt: "2026-07-10T12:00:00.000Z",
    ...overrides,
  };
}

function weighing(overrides = {}) {
  return {
    id: "weight-1",
    lotId: "lot-dairy",
    animalId: "animal-1",
    recordedAt: "2026-07-01",
    weightKg: 500,
    notes: "",
    source: "Prueba",
    createdAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

function expense(overrides = {}) {
  return {
    id: "expense-1",
    fieldId: FIELD_ID,
    date: "2026-06-01",
    description: "Alimento",
    category: "alimento",
    amountClp: 100_000,
    paymentSource: "society",
    paidById: null,
    lotId: "lot-dairy",
    createdAt: "2026-06-01T12:00:00.000Z",
    ...overrides,
  };
}

function operations(overrides = {}) {
  return buildHerdOperations({
    animals: [],
    lots: [],
    weighings: [],
    reproductiveEvents: [],
    births: [],
    healthEvents: [],
    expenses: [],
    now: NOW,
    ...overrides,
  });
}

function addDays(value, days) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(left, right) {
  return Math.round((new Date(`${right}T12:00:00.000Z`) - new Date(`${left}T12:00:00.000Z`)) / 86_400_000);
}

test("projects category-specific bovine and ovine pregnancies", () => {
  const dairyLot = lot();
  const sheepLot = lot({ id: "lot-sheep", name: "Ovejas", category: "sheep" });
  const cow = animal();
  const ewe = animal({ id: "animal-ewe", lotId: sheepLot.id, tag: "OVINO-001" });
  const result = operations({
    animals: [cow, ewe],
    lots: [dairyLot, sheepLot],
    weighings: [
      weighing(),
      weighing({ id: "weight-ewe", animalId: ewe.id, lotId: sheepLot.id }),
    ],
    reproductiveEvents: [
      reproductiveEvent(),
      reproductiveEvent({ id: "diag-cow", eventType: "pregnancy_diagnosis", occurredAt: "2026-02-10", result: "positive" }),
      reproductiveEvent({ id: "service-ewe", animalId: ewe.id }),
      reproductiveEvent({ id: "diag-ewe", animalId: ewe.id, eventType: "pregnancy_diagnosis", occurredAt: "2026-02-10", result: "positive" }),
    ],
  });

  const cowProjection = result.projections.find((entry) => entry.animalId === cow.id);
  const eweProjection = result.projections.find((entry) => entry.animalId === ewe.id);
  assert.ok(cowProjection);
  assert.ok(eweProjection);
  assert.deepEqual(
    {
      diagnosis: cowProjection.diagnosisDueDate,
      dryOff: cowProjection.dryOffDueDate,
      calving: cowProjection.calvingDueDate,
      confirmed: cowProjection.confirmedPregnant,
    },
    { diagnosis: "2026-02-05", dryOff: "2026-08-12", calving: "2026-10-11", confirmed: true },
  );
  assert.deepEqual(
    { dryOff: eweProjection.dryOffDueDate, calving: eweProjection.calvingDueDate, confirmed: eweProjection.confirmedPregnant },
    { dryOff: "2026-03-29", calving: "2026-05-28", confirmed: true },
  );
  assert.equal(result.workItems.some((entry) => entry.kind === "dry_off" && entry.animalId === cow.id), true);
  assert.equal(result.workItems.some((entry) => entry.kind === "dry_off" && entry.animalId === ewe.id), false);
  assert.equal(result.workItems.some((entry) => entry.kind === "calving" && entry.animalId === ewe.id), true);
});
test("a negative diagnosis cancels the projection and its reproductive work", () => {
  const cow = animal();
  const result = operations({
    animals: [cow],
    lots: [lot()],
    weighings: [weighing()],
    reproductiveEvents: [
      reproductiveEvent(),
      reproductiveEvent({ id: "diag-negative", eventType: "pregnancy_diagnosis", occurredAt: "2026-02-10", result: "negative" }),
    ],
  });

  assert.deepEqual(result.projections, []);
  assert.equal(result.workItems.some((entry) => ["pregnancy_check", "dry_off", "calving"].includes(entry.kind)), false);
});

test("calving and abortion events close an earlier pregnancy projection", async (t) => {
  for (const closingType of ["calving", "abortion"]) {
    await t.test(closingType, () => {
      const cow = animal({ id: `animal-${closingType}`, tag: `DIIO-${closingType}` });
      const result = operations({
        animals: [cow],
        lots: [lot()],
        weighings: [weighing({ animalId: cow.id })],
        reproductiveEvents: [
          reproductiveEvent({ id: `service-${closingType}`, animalId: cow.id }),
          reproductiveEvent({ id: `diag-${closingType}`, animalId: cow.id, eventType: "pregnancy_diagnosis", occurredAt: "2026-02-10", result: "positive" }),
          reproductiveEvent({ id: `close-${closingType}`, animalId: cow.id, eventType: closingType, occurredAt: "2026-06-01", result: closingType }),
        ],
      });
      assert.deepEqual(result.projections, []);
      assert.equal(result.workItems.some((entry) => ["pregnancy_check", "dry_off", "calving"].includes(entry.kind)), false);
    });
  }
});

test("the latest service supersedes an older reproductive cycle", () => {
  const cow = animal();
  const result = operations({
    animals: [cow],
    lots: [lot()],
    weighings: [weighing()],
    reproductiveEvents: [
      reproductiveEvent({ id: "service-old", occurredAt: "2025-10-01" }),
      reproductiveEvent({ id: "diag-old", eventType: "pregnancy_diagnosis", occurredAt: "2025-11-10", result: "positive" }),
      reproductiveEvent({ id: "service-new", occurredAt: "2026-06-15" }),
    ],
  });

  assert.equal(result.projections.length, 1);
  assert.equal(result.projections[0].serviceDate, "2026-06-15");
  assert.equal(result.projections[0].confirmedPregnant, false);
  assert.equal(result.projections[0].diagnosisDueDate, "2026-07-20");
  assert.equal(result.workItems.find((entry) => entry.kind === "pregnancy_check")?.priority, "today");
});

test("work agenda is ordered by priority, due date, and animal tag", () => {
  const herdLot = lot();
  const overdue = animal({ id: "animal-overdue", tag: "DIIO-010", sex: "male" });
  const today = animal({ id: "animal-today", tag: "DIIO-020", sex: "male" });
  const soonZulu = animal({ id: "animal-soon-z", tag: "DIIO-040", sex: "male" });
  const soonAlpha = animal({ id: "animal-soon-a", tag: "DIIO-030", sex: "male" });
  const watch = animal({ id: "animal-watch", tag: "DIIO-050" });
  const result = operations({
    animals: [overdue, today, soonZulu, soonAlpha, watch],
    lots: [herdLot],
    weighings: [
      weighing({ id: "weight-overdue", animalId: overdue.id, recordedAt: "2026-01-01" }),
      weighing({ id: "weight-soon-z", animalId: soonZulu.id, recordedAt: addDays(NOW, -110) }),
      weighing({ id: "weight-soon-a", animalId: soonAlpha.id, recordedAt: addDays(NOW, -110) }),
      weighing({ id: "weight-watch", animalId: watch.id, recordedAt: "2026-07-20" }),
    ],
    reproductiveEvents: [reproductiveEvent({ id: "service-watch", animalId: watch.id, occurredAt: "2026-07-05" })],
  });

  assert.deepEqual(
    result.workItems.map(({ kind, animalId, priority, dueDate }) => ({ kind, animalId, priority, dueDate })),
    [
      { kind: "weighing", animalId: overdue.id, priority: "overdue", dueDate: "2026-05-01" },
      { kind: "weighing", animalId: today.id, priority: "today", dueDate: "2026-07-20" },
      { kind: "weighing", animalId: soonAlpha.id, priority: "soon", dueDate: "2026-07-30" },
      { kind: "weighing", animalId: soonZulu.id, priority: "soon", dueDate: "2026-07-30" },
      { kind: "pregnancy_check", animalId: watch.id, priority: "watch", dueDate: "2026-08-09" },
    ],
  );
});

test("agenda includes active withdrawals and overdue or missing weighings only", () => {
  const herdLot = lot();
  const treated = animal({ id: "animal-treated", tag: "DIIO-101" });
  const neverWeighed = animal({ id: "animal-never", tag: "DIIO-102", sex: "male" });
  const recent = animal({ id: "animal-recent", tag: "DIIO-103", sex: "male" });
  const inactive = animal({ id: "animal-inactive", tag: "DIIO-104", status: "sold", statusDate: "2026-06-01" });
  const result = operations({
    animals: [treated, neverWeighed, recent, inactive],
    lots: [herdLot],
    weighings: [
      weighing({ id: "weight-treated", animalId: treated.id, recordedAt: "2026-02-01" }),
      weighing({ id: "weight-recent", animalId: recent.id, recordedAt: "2026-07-01" }),
    ],
    healthEvents: [
      healthEvent({ id: "active-withdrawal", animalId: treated.id, withdrawalMilkUntil: "2026-07-22", withdrawalMeatUntil: "2026-07-30" }),
      healthEvent({ id: "expired-withdrawal", animalId: treated.id, occurredAt: "2026-06-01", withdrawalMilkUntil: "2026-06-10" }),
      healthEvent({ id: "cancelled-withdrawal", animalId: treated.id, status: "cancelled", withdrawalMeatUntil: "2026-08-15" }),
      healthEvent({ id: "inactive-withdrawal", animalId: inactive.id, withdrawalMeatUntil: "2026-08-15" }),
    ],
  });

  const withdrawals = result.workItems.filter((entry) => entry.kind === "withdrawal");
  assert.equal(withdrawals.length, 1);
  assert.deepEqual(
    { animalId: withdrawals[0].animalId, dueDate: withdrawals[0].dueDate, priority: withdrawals[0].priority },
    { animalId: treated.id, dueDate: "2026-07-30", priority: "soon" },
  );
  assert.deepEqual(
    result.workItems.filter((entry) => entry.kind === "weighing").map(({ animalId, dueDate, priority }) => ({ animalId, dueDate, priority })),
    [
      { animalId: treated.id, dueDate: "2026-06-01", priority: "overdue" },
      { animalId: neverWeighed.id, dueDate: "2026-07-20", priority: "today" },
    ],
  );
  assert.equal(result.workItems.some((entry) => entry.animalId === recent.id && entry.kind === "weighing"), false);
  assert.equal(result.workItems.some((entry) => entry.animalId === inactive.id), false);
});

test("reproductive KPIs use the last 365 days and complete birth records", () => {
  const herdLot = lot();
  const confirmed = animal({ id: "cow-confirmed", tag: "DIIO-201" });
  const unconfirmed = animal({ id: "cow-unconfirmed", tag: "DIIO-202" });
  const eligibleUnserved = animal({ id: "cow-unserved", tag: "DIIO-203" });
  const soldFemale = animal({ id: "cow-sold", tag: "DIIO-204", status: "sold", statusDate: "2026-01-01" });
  const male = animal({ id: "bull-1", tag: "TORO-1", sex: "male" });
  const firstBirthDate = "2025-08-01";
  const secondBirthDate = "2026-07-01";
  const result = operations({
    animals: [confirmed, unconfirmed, eligibleUnserved, soldFemale, male],
    lots: [herdLot],
    reproductiveEvents: [
      reproductiveEvent({ id: "service-c1-a", animalId: confirmed.id, eventType: "service", occurredAt: "2026-01-01" }),
      reproductiveEvent({ id: "service-c1-b", animalId: confirmed.id, occurredAt: "2026-01-20" }),
      reproductiveEvent({ id: "diag-c1", animalId: confirmed.id, eventType: "pregnancy_diagnosis", occurredAt: "2026-02-25", result: "positive" }),
      reproductiveEvent({ id: "service-c2", animalId: unconfirmed.id, occurredAt: "2026-03-01" }),
      reproductiveEvent({ id: "diag-c2", animalId: unconfirmed.id, eventType: "pregnancy_diagnosis", occurredAt: "2026-04-10", result: "negative" }),
      reproductiveEvent({ id: "old-service", animalId: eligibleUnserved.id, occurredAt: "2025-07-19" }),
    ],
    births: [
      birth({ id: "birth-first", damAnimalId: confirmed.id, occurredAt: firstBirthDate, difficulty: "assisted" }),
      birth({ id: "birth-second", damAnimalId: confirmed.id, occurredAt: secondBirthDate, difficulty: "unassisted" }),
    ],
  });

  assert.deepEqual(result.kpis, {
    eligibleFemales: 3,
    servedFemales: 2,
    confirmedPregnancies: 1,
    pregnancyRatePct: 50,
    servicesPerConception: 3,
    averageCalvingIntervalDays: daysBetween(firstBirthDate, secondBirthDate),
    difficultBirthRatePct: 50,
  });
});

test("estimated margins exclude animal purchases and expenses after the sale", () => {
  const herdLot = lot({ animalCount: 2 });
  const sold = animal({
    id: "animal-sold",
    tag: "DIIO-301",
    status: "sold",
    statusDate: "2026-06-30",
    statusReason: "Venta en feria",
    purchasePriceClp: 400_000,
    purchaseDate: "2025-01-10",
    salePriceClp: 1_000_000,
    saleBuyer: "Feria ganadera",
    saleWeightKg: 500,
  });
  const retained = animal({ id: "animal-retained", tag: "DIIO-302" });
  const result = operations({
    animals: [sold, retained],
    lots: [herdLot, lot({ id: "lot-other", fieldId: "field-2", name: "Otro lote" })],
    expenses: [
      expense({ id: "purchase", category: "compra_animales", description: "Compra del animal", amountClp: 400_000 }),
      expense({ id: "feed", amountClp: 100_000 }),
      expense({ id: "undated-health", category: "sanidad", description: "Sanidad sin fecha", date: null, amountClp: 20_000 }),
      expense({ id: "after-sale", category: "flete", description: "Flete posterior", date: "2026-07-01", amountClp: 60_000 }),
      expense({ id: "other-lot", lotId: "lot-other", amountClp: 900_000 }),
      expense({ id: "field-only", lotId: null, amountClp: 700_000 }),
    ],
  });

  assert.deepEqual(result.animalMargins, [{
    animalId: sold.id,
    animalTag: sold.tag,
    lotId: herdLot.id,
    lotName: herdLot.name,
    salePriceClp: 1_000_000,
    purchasePriceClp: 400_000,
    allocatedExpenseClp: 60_000,
    marginClp: 540_000,
    saleWeightKg: 500,
    marginPerKgClp: 1_080,
    buyer: "Feria ganadera",
  }]);
  assert.deepEqual(result.lotMargins, [{
    lotId: herdLot.id,
    lotName: herdLot.name,
    soldAnimals: 1,
    revenueClp: 1_000_000,
    purchaseCostClp: 400_000,
    allocatedExpenseClp: 60_000,
    marginClp: 540_000,
  }]);
});
