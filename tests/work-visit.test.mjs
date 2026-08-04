import assert from "node:assert/strict";
import test from "node:test";

import {
  closeWorkVisitAndCommitOrigin,
  createWorkVisit,
  resetInMemoryWorkVisitsStore,
} from "../src/modules/visitas/server/visit-repository.ts";

import {
  validateClinicalGuardrail,
  validateWorkVisitInput,
  VisitRuleError,
} from "../src/modules/visitas/domain/visit-rules.mjs";

test.beforeEach(() => {
  resetInMemoryWorkVisitsStore();
});

test("validates work visit inputs and creates a planned work visit (Ticket 108)", async () => {
  assert.throws(
    () => validateWorkVisitInput(null),
    (err) => err instanceof VisitRuleError && err.code === "VISIT_INPUT_INVALID"
  );

  assert.throws(
    () => validateWorkVisitInput({ fieldId: "f1", visitKind: "invalid", visitDate: "2026-07-30", professionalName: "Dr. Perez", title: "Test", items: [] }),
    (err) => err instanceof VisitRuleError && err.code === "VISIT_KIND_INVALID"
  );

  const visit = await createWorkVisit({
    fieldId: "field-101",
    organizationId: "org-101",
    visitKind: "veterinary",
    visitDate: "2026-07-30",
    professionalName: "Dra. Sofía Morales",
    title: "Revisión reproductiva de lote lechería",
    items: [
      {
        targetKind: "animal",
        targetId: "cow-101",
        targetLabel: "99010001",
        lotName: "Lechería",
        reason: "Parto reciente - evaluar celo",
        supportMetric: "175 días abiertos",
      },
    ],
  });

  assert.ok(visit.id.startsWith("visit_"));
  assert.equal(visit.status, "planned");
  assert.equal(visit.version, 1);
  assert.equal(visit.items.length, 1);
  assert.equal(visit.items[0].status, "pending");
});

test("detects item target collisions across active visits", async () => {
  await createWorkVisit({
    fieldId: "field-101",
    organizationId: "org-101",
    visitKind: "veterinary",
    visitDate: "2026-07-30",
    professionalName: "Dra. Sofía Morales",
    title: "Visita 1",
    items: [
      { targetKind: "animal", targetId: "cow-101", targetLabel: "99010001", reason: "Revisión 1" },
    ],
  });

  await assert.rejects(
    createWorkVisit({
      fieldId: "field-101",
      organizationId: "org-101",
      visitKind: "veterinary",
      visitDate: "2026-07-31",
      professionalName: "Dr. Soto",
      title: "Visita 2",
      items: [
        { targetKind: "animal", targetId: "cow-101", targetLabel: "99010001", reason: "Revisión 2" },
      ],
    }),
    (err) => err instanceof VisitRuleError && err.code === "TARGET_COLLISION_DETECTED"
  );
});

test("enforces clinical guardrail blocking diagnoses, products and doses", () => {
  assert.doesNotThrow(() => validateClinicalGuardrail("Animal en celo activo, condición corporal 3.5"));

  assert.throws(
    () => validateClinicalGuardrail("Diagnóstico de mastitis clínica, aplicar penicilina 10ml"),
    (err) => err instanceof VisitRuleError && err.code === "CLINICAL_GUARDRAIL_VIOLATION"
  );

  assert.throws(
    () => validateClinicalGuardrail("Administrar dosis de oxitetraciclina"),
    (err) => err instanceof VisitRuleError && err.code === "CLINICAL_GUARDRAIL_VIOLATION"
  );
});

test("closes a work visit, commits origin operations, and handles idempotent replay (Ticket 109)", async () => {
  const visit = await createWorkVisit({
    fieldId: "field-101",
    organizationId: "org-101",
    visitKind: "veterinary",
    visitDate: "2026-07-30",
    professionalName: "Dra. Sofía Morales",
    title: "Visita veterinaria",
    items: [
      {
        targetKind: "animal",
        targetId: "cow-101",
        targetLabel: "99010001",
        reason: "Revisión ecográfica",
      },
    ],
  });

  const closeResult = await closeWorkVisitAndCommitOrigin({
    visitId: visit.id,
    expectedVersion: 1,
    outcomes: [
      {
        itemId: visit.items[0].id,
        status: "completed",
        observation: "Celo detectado en ecografía",
        outcomeValue: "positivo",
      },
    ],
  });

  assert.equal(closeResult.reused, false);
  assert.equal(closeResult.visit.status, "completed");
  assert.equal(closeResult.committedOriginCount, 1);
  assert.equal(closeResult.originDetails[0].originEntity, "livestock_reproductive_events");

  // Replay idempotency check
  const replayedResult = await closeWorkVisitAndCommitOrigin({
    visitId: visit.id,
    expectedVersion: 2,
    outcomes: [],
  });

  assert.equal(replayedResult.reused, true);
  assert.equal(replayedResult.visit.status, "completed");
  assert.equal(replayedResult.committedOriginCount, 1);
});

test("prevents closure on optimistic locking version mismatch", async () => {
  const visit = await createWorkVisit({
    fieldId: "field-101",
    organizationId: "org-101",
    visitKind: "agronomic",
    visitDate: "2026-07-30",
    professionalName: "Ing. Agrónomo Ruiz",
    title: "Medición de pradera",
    items: [
      {
        targetKind: "paddock",
        targetId: "paddock-4",
        targetLabel: "Potrero 4",
        reason: "Estimación biomasa",
      },
    ],
  });

  await assert.rejects(
    closeWorkVisitAndCommitOrigin({
      visitId: visit.id,
      expectedVersion: 99,
      outcomes: [],
    }),
    (err) => err instanceof VisitRuleError && err.code === "OPTIMISTIC_LOCK_CONFLICT"
  );
});
