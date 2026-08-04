import assert from "node:assert/strict";
import test from "node:test";
import {
  AgendaRequestError,
  applyAgendaTaskStates,
  validateAgendaTaskMutation,
} from "../src/modules/dashboard/agenda-management.mjs";
import {
  agendaItemRevision,
  buildTodayAgenda,
} from "../src/modules/dashboard/today-agenda.mjs";

const baseItem = {
  id: "ganado:weighing:cow-1:2026-07-27",
  category: "weighing",
  source: "ganado",
  sourceLabel: "Ganado",
  fieldId: "field-1",
  animalId: "cow-1",
  animalTag: "TEST-001",
  lotName: "Lechería",
  urgency: "today",
  title: "Pesaje pendiente",
  reason: "Sin pesajes registrados.",
  evidenceDate: "2026-07-27",
  dateLabel: "Fecha objetivo",
  href: "/app/ganado/ficha?animalId=cow-1",
  actionLabel: "Abrir ficha",
};

test("derives a stable opaque revision and changes it with evidence", () => {
  const first = agendaItemRevision(baseItem);
  const replay = agendaItemRevision(structuredClone(baseItem));
  const changed = agendaItemRevision({
    ...baseItem,
    reason: "Último pesaje hace 150 días.",
  });

  assert.match(first, /^[0-9a-f]{16}$/u);
  assert.equal(replay, first);
  assert.notEqual(changed, first);
});

test("projects persistent lifecycle without suppressing a new evidence revision", () => {
  const [item] = buildTodayAgenda({
    herdWorkItems: [{
      id: "weighing:cow-1:2026-07-27",
      kind: "weighing",
      animalId: "cow-1",
      animalTag: "TEST-001",
      lotId: "lot-1",
      lotName: "Lechería",
      fieldId: "field-1",
      dueDate: "2026-07-27",
      priority: "today",
      title: "Pesaje pendiente",
      detail: "Sin pesajes registrados.",
    }],
    referenceDate: "2026-07-27",
  });
  const completed = state(item, {
    status: "completed",
    resolutionReason: "Pesaje registrado en terreno.",
  });

  assert.equal(applyAgendaTaskStates([item], [completed], "2026-07-27")[0].agendaView, "closed");
  assert.equal(
    applyAgendaTaskStates([{ ...item, revision: "f".repeat(16) }], [completed], "2026-07-27")[0].agendaView,
    "pending",
  );
});

test("keeps future postponements separate and makes due postponements actionable", () => {
  const item = {
    ...baseItem,
    revision: agendaItemRevision(baseItem),
    urgency: "review",
  };
  const future = state(item, {
    status: "postponed",
    scheduledFor: "2026-08-02",
    resolutionReason: "Esperar la próxima visita.",
  });
  const due = { ...future, scheduledFor: "2026-07-27" };

  const futureProjection = applyAgendaTaskStates([item], [future], "2026-07-27")[0];
  assert.equal(futureProjection.agendaView, "postponed");
  assert.equal(futureProjection.urgency, "review");

  const dueProjection = applyAgendaTaskStates([item], [due], "2026-07-27")[0];
  assert.equal(dueProjection.agendaView, "pending");
  assert.equal(dueProjection.urgency, "today");
});

test("validates idempotency, reason, source and action-specific fields", () => {
  const valid = validateAgendaTaskMutation(mutation());
  assert.equal(valid.action, "complete");
  assert.equal(valid.reason, "Trabajo confirmado");

  assertAgendaError(
    () => validateAgendaTaskMutation({ ...mutation(), reason: "x" }),
    "AGENDA_REASON_REQUIRED",
  );
  assertAgendaError(
    () => validateAgendaTaskMutation({
      ...mutation(),
      source: "leche",
      itemKey: "ganado:weighing:cow-1",
    }),
    "AGENDA_SOURCE_INVALID",
  );
  assertAgendaError(
    () => validateAgendaTaskMutation({
      ...mutation(),
      action: "postpone",
      scheduledFor: null,
    }),
    "AGENDA_DATE_REQUIRED",
  );
  assertAgendaError(
    () => validateAgendaTaskMutation({
      ...mutation(),
      action: "assign",
      reason: null,
      assigneeMembershipId: "membership-1",
    }),
    null,
    false,
  );
  assert.doesNotThrow(() => validateAgendaTaskMutation({
    ...mutation(),
    itemKey: "potreros:agronomic:recommendation-1",
    source: "potreros",
  }));
});

function mutation() {
  return {
    action: "complete",
    operationId: "00000000-0000-4000-8000-000000000001",
    fieldId: "field-1",
    itemKey: "ganado:weighing:cow-1",
    signalRevision: "a".repeat(16),
    source: "ganado",
    expectedVersion: null,
    reason: "Trabajo confirmado",
    scheduledFor: null,
    assigneeMembershipId: null,
  };
}

function state(item, overrides) {
  return {
    id: "agenda-state-1",
    organizationId: "org-1",
    fieldId: item.fieldId,
    itemKey: item.id,
    signalRevision: item.revision,
    source: item.source,
    status: "open",
    assigneeMembershipId: null,
    assigneeName: null,
    scheduledFor: null,
    resolutionReason: null,
    version: 1,
    lastOperationId: "00000000-0000-4000-8000-000000000002",
    createdAt: "2026-07-27T12:00:00.000Z",
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

function assertAgendaError(callback, code, shouldThrow = true) {
  if (!shouldThrow) {
    assert.doesNotThrow(callback);
    return;
  }
  assert.throws(callback, (error) =>
    error instanceof AgendaRequestError && error.code === code);
}
