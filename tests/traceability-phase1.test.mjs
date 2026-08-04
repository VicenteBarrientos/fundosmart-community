import assert from "node:assert/strict";
import test from "node:test";

import {
  SAG_MAX_FMA_DIIO,
  buildDeaDocumentProjection,
  buildFmaDocumentProjections,
  decideDiioTransition,
  isValidDiio,
  normalizeDiio,
  normalizeEstablishmentIdentity,
  normalizeTraceabilityInventory,
  reconcileDiioInventory,
  stageDiioImport,
  validateDiioDevice,
} from "../src/modules/trazabilidad/domain/traceability-rules.mjs";

const ESTABLISHMENT = Object.freeze({
  id: "establishment-1",
  organizationId: "org-1",
  fieldId: "field-1",
  rup: "01.02.1234",
  type: "dairy",
  status: "active",
  dataMode: "real",
});

const PROFILE = Object.freeze({
  fieldId: "field-1",
  holderRut: "12.345.678-5",
  holderName: "Agrícola Los Robles SpA",
  commune: "Osorno",
  address: "Camino Rural 123",
});

function availableDevice(index, overrides = {}) {
  return {
    id: `device-${index}`,
    organizationId: "org-1",
    fieldId: "field-1",
    officialNumber: String(100_000_000 + index),
    deviceType: "double_ear_tag",
    rfidId: null,
    animalId: null,
    status: "available",
    assignedAt: null,
    endedAt: null,
    replacesDeviceId: null,
    replacedByDeviceId: null,
    lastTransitionKey: null,
    version: 1,
    ...overrides,
  };
}

function assignedDevice(index, animalId = `animal-${index}`, overrides = {}) {
  return availableDevice(index, {
    animalId,
    status: "assigned",
    assignedAt: "2026-07-20T09:00:00.000Z",
    ...overrides,
  });
}

function movement(overrides = {}) {
  return {
    id: "movement-1",
    sourceRup: "01.02.1234",
    destinationRup: "02.03.4321",
    destinationCommune: "Río Negro",
    destinationAddress: "Ruta U-500 km 12",
    destinationPurpose: "domestic",
    departureDate: "2026-07-20",
    departureTime: "08:30",
    arrivalDate: "2026-07-20",
    arrivalTime: "10:15",
    carrierName: "Transportes del Sur",
    carrierRut: "9.876.543-3",
    vehiclePlate: "ABCD12",
    trailerPlate: "EFGH34",
    observations: "Traslado programado",
    declarations: { noQuarantine: true, noSymptoms: true, noActiveWithdrawal: true },
    ...overrides,
  };
}

function animal(index, overrides = {}) {
  return {
    id: `animal-${index}`,
    organizationId: "org-1",
    fieldId: "field-1",
    locationRup: "01.02.1234",
    diio: String(100_000_000 + index),
    speciesCode: "bovine",
    categoryCode: index % 2 === 0 ? "heifer" : "cow",
    status: "active",
    ...overrides,
  };
}

function documentInput(overrides = {}) {
  return {
    documentId: "doc-1",
    revision: 1,
    generatedAt: "2026-07-20T12:00:00.000Z",
    ...overrides,
  };
}

test("keeps real RUP identity tenant-scoped and makes demo identity explicitly fake", () => {
  const real = normalizeEstablishmentIdentity(ESTABLISHMENT);
  assert.equal(real.validation.valid, true);
  assert.equal(real.establishment.officialRup, "01.02.1234");
  assert.equal(real.establishment.isOfficialIdentity, true);

  const demo = normalizeEstablishmentIdentity({ ...ESTABLISHMENT, id: "demo-1", rup: "DEMO-EJEMPLO", dataMode: "demo" });
  assert.equal(demo.validation.valid, true);
  assert.equal(demo.establishment.officialRup, null);
  assert.equal(demo.establishment.displayRup, "DEMO-EJEMPLO");
  assert.equal(demo.establishment.isOfficialIdentity, false);
  assert.equal(Object.isFrozen(demo.establishment), true);

  const unsafeDemo = normalizeEstablishmentIdentity({ ...ESTABLISHMENT, dataMode: "demo" });
  assert.equal(unsafeDemo.validation.valid, false);
  assert.equal(unsafeDemo.validation.errors.some((entry) => entry.code === "DEMO_RUP_MUST_BE_FAKE"), true);
  assert.equal(normalizeEstablishmentIdentity({ ...ESTABLISHMENT, organizationId: "../org" }).validation.valid, false);
});

test("uses the canonical official 9-digit DIIO rule and validates state invariants", () => {
  assert.equal(normalizeDiio("123.456.789"), "123456789");
  assert.equal(isValidDiio("123-456-789"), true);
  assert.equal(isValidDiio("12345678"), false);
  assert.equal(validateDiioDevice(availableDevice(1)).valid, true);
  const invalid = validateDiioDevice(availableDevice(1, { officialNumber: "ABC", animalId: "animal-1" }));
  assert.equal(invalid.valid, false);
  assert.deepEqual(new Set(invalid.errors.map((entry) => entry.code)), new Set(["DIIO_NUMBER_INVALID", "DIIO_AVAILABLE_HAS_ANIMAL"]));
});

test("assigns one active DIIO per animal and replays an idempotency key without a second event", () => {
  const command = { action: "assign", animalId: "animal-1", actorId: "user-1", idempotencyKey: "mutation-1", occurredAt: "2026-07-20T09:00:00.000Z" };
  const assigned = decideDiioTransition({ current: availableDevice(1), activeAssignments: [], command });
  assert.equal(assigned.validation.valid, true);
  assert.equal(assigned.replay, false);
  assert.equal(assigned.updates[0].status, "assigned");
  assert.equal(assigned.updates[0].animalId, "animal-1");
  assert.equal(assigned.updates[0].version, 2);
  assert.equal(assigned.event.type, "traceability.diio.assign");

  const replay = decideDiioTransition({ current: assigned.updates[0], activeAssignments: [assigned.updates[0]], command });
  assert.equal(replay.validation.valid, true);
  assert.equal(replay.replay, true);
  assert.equal(replay.event, null);
  assert.deepEqual(replay.updates, []);

  const reused = decideDiioTransition({ current: assigned.updates[0], activeAssignments: [assigned.updates[0]], command: { ...command, occurredAt: "2026-07-20T10:00:00.000Z" } });
  assert.equal(reused.validation.valid, false);
  assert.equal(reused.validation.errors.some((entry) => entry.code === "IDEMPOTENCY_KEY_REUSED"), true);

  const duplicate = decideDiioTransition({ current: availableDevice(2), activeAssignments: [assigned.updates[0]], command: { ...command, idempotencyKey: "mutation-2" } });
  assert.equal(duplicate.validation.valid, false);
  assert.equal(duplicate.validation.errors.some((entry) => entry.code === "ANIMAL_ALREADY_HAS_ACTIVE_DIIO"), true);
});

test("supports lost, replacement, and retirement transitions with immutable lineage", () => {
  const lost = decideDiioTransition({
    current: assignedDevice(1),
    activeAssignments: [assignedDevice(1)],
    command: { action: "report_lost", actorId: "user-1", idempotencyKey: "lost-1", occurredAt: "2026-07-21T09:00:00.000Z" },
  });
  assert.equal(lost.validation.valid, true);
  assert.equal(lost.updates[0].status, "lost");

  const replacement = decideDiioTransition({
    current: lost.updates[0],
    replacement: availableDevice(2),
    activeAssignments: [],
    command: { action: "replace", actorId: "user-1", idempotencyKey: "replace-1", occurredAt: "2026-07-21T10:00:00.000Z" },
  });
  assert.equal(replacement.validation.valid, true);
  assert.deepEqual(replacement.updates.map((entry) => entry.status), ["replaced", "assigned"]);
  assert.equal(replacement.updates[0].replacedByDeviceId, "device-2");
  assert.equal(replacement.updates[1].replacesDeviceId, "device-1");
  assert.equal(replacement.updates[1].animalId, "animal-1");
  assert.equal(Object.isFrozen(replacement.updates), true);

  const retired = decideDiioTransition({
    current: replacement.updates[1],
    activeAssignments: [replacement.updates[1]],
    command: { action: "retire", actorId: "user-1", idempotencyKey: "retire-1", occurredAt: "2026-07-22T09:00:00.000Z" },
  });
  assert.equal(retired.validation.valid, true);
  assert.equal(retired.updates[0].status, "retired");
  assert.equal(decideDiioTransition({ current: replacement.updates[0], activeAssignments: [], command: { action: "assign", animalId: "animal-1", actorId: "user-1", idempotencyKey: "bad", occurredAt: "2026-07-22T09:00:00.000Z" } }).validation.valid, false);
});

test("normalizes individual and summary inventory deterministically and rejects scope or identity collisions", () => {
  const entries = [
    { id: "summary-1", organizationId: "org-1", fieldId: "field-1", trackingMode: "summary", speciesCode: "ovine", categoryCode: "ewe", quantity: 12 },
    { id: "individual-1", organizationId: "org-1", fieldId: "field-1", trackingMode: "individual", animalId: "animal-1", diio: "100.000.001", speciesCode: "bovine", categoryCode: "cow", quantity: 1 },
  ];
  const result = normalizeTraceabilityInventory({ organizationId: "org-1", fieldId: "field-1", entries });
  const reversed = normalizeTraceabilityInventory({ organizationId: "org-1", fieldId: "field-1", entries: [...entries].reverse() });
  assert.equal(result.validation.valid, true);
  assert.deepEqual(result.entries, reversed.entries);
  assert.equal(result.entries[0].diio, "100000001");

  const invalid = normalizeTraceabilityInventory({ organizationId: "org-1", fieldId: "field-1", entries: [
    entries[1],
    { ...entries[1], id: "individual-2", organizationId: "org-2" },
    { ...entries[0], id: "summary-2", animalId: "animal-2" },
  ] });
  assert.equal(invalid.validation.valid, false);
  const codes = new Set(invalid.validation.errors.map((entry) => entry.code));
  assert.equal(codes.has("INVENTORY_ORGANIZATION_MISMATCH"), true);
  assert.equal(codes.has("INVENTORY_ANIMAL_DUPLICATE"), true);
  assert.equal(codes.has("INVENTORY_SUMMARY_HAS_IDENTITY"), true);
});

test("reconciles missing, orphaned, mismatched, and duplicate active DIIO assignments", () => {
  const entries = [
    { id: "entry-1", trackingMode: "individual", animalId: "animal-1", diio: "100000001", speciesCode: "bovine", categoryCode: "cow", quantity: 1 },
    { id: "entry-2", trackingMode: "individual", animalId: "animal-2", diio: null, speciesCode: "bovine", categoryCode: "cow", quantity: 1 },
    { id: "entry-3", trackingMode: "individual", animalId: "animal-3", diio: "100000003", speciesCode: "bovine", categoryCode: "cow", quantity: 1 },
  ];
  const result = reconcileDiioInventory({ organizationId: "org-1", fieldId: "field-1", entries, devices: [
    assignedDevice(1, "animal-1"),
    assignedDevice(4, "animal-3"),
    assignedDevice(5, "animal-3"),
    assignedDevice(6, "missing-animal"),
    assignedDevice(7, "animal-1"),
    assignedDevice(8, "animal-4", { officialNumber: "100000007" }),
  ] });
  assert.equal(result.validation.valid, true);
  assert.deepEqual(new Set(result.findings.map((entry) => entry.code)), new Set([
    "ANIMAL_WITHOUT_ACTIVE_DIIO",
    "ANIMAL_WITH_MULTIPLE_ACTIVE_DIIO",
    "ORPHAN_ASSIGNED_DIIO",
    "DIIO_ASSIGNED_TO_MULTIPLE_ANIMALS",
  ]));
});

test("builds deterministic FMA projections in groups of at most 45 and blocks active withdrawal", () => {
  const animals = Array.from({ length: 91 }, (_, index) => animal(index + 1));
  const input = { establishment: ESTABLISHMENT, profile: PROFILE, movement: movement(), animals, withdrawals: [], document: documentInput() };
  const result = buildFmaDocumentProjections(input);
  const reordered = buildFmaDocumentProjections({ ...input, animals: [...animals].reverse() });
  assert.equal(result.validation.valid, true);
  assert.equal(SAG_MAX_FMA_DIIO, 45);
  assert.deepEqual(result.projections.map((entry) => entry.content.animals.length), [45, 45, 1]);
  assert.deepEqual(result.projections.map((entry) => entry.sha256Input), reordered.projections.map((entry) => entry.sha256Input));
  assert.equal(result.projections[0].metadata.officiallySubmittable, false);
  assert.equal(result.projections[0].content.officialFormatDecision, "pending_confirmation");
  assert.equal(Object.isFrozen(result.projections[0].metadata), true);

  const blocked = buildFmaDocumentProjections({ ...input, animals: [animal(1)], withdrawals: [{ animalId: "animal-1", status: "open", withdrawalMeatUntil: "2026-07-20" }] });
  assert.equal(blocked.validation.valid, false);
  assert.equal(blocked.validation.errors.some((entry) => entry.code === "FMA_ACTIVE_WITHDRAWAL"), true);
});

test("enforces FMA tenant, origin, time, responsibility, transport, and export declarations", () => {
  const result = buildFmaDocumentProjections({
    establishment: ESTABLISHMENT,
    profile: PROFILE,
    movement: movement({
      destinationPurpose: "international_export",
      arrivalTime: "07:30",
      carrierRut: "12.345.678-4",
      declarations: { noQuarantine: false, noSymptoms: false, noActiveWithdrawal: false },
    }),
    animals: [animal(1, { organizationId: "org-2", locationRup: "99.99.9999" })],
    document: documentInput(),
  });
  assert.equal(result.validation.valid, false);
  const codes = new Set(result.validation.errors.map((entry) => entry.code));
  for (const code of [
    "FMA_ANIMAL_ORGANIZATION_MISMATCH",
    "FMA_ANIMAL_ORIGIN_MISMATCH",
    "FMA_ARRIVAL_BEFORE_DEPARTURE",
    "FMA_EXPORT_AUTHORIZATION_REQUIRED",
    "FMA_EXPORT_COUNTRY_REQUIRED",
    "FMA_CARRIER_RUT_INVALID",
    "FMA_DECLARATION_QUARANTINE_REQUIRED",
    "FMA_DECLARATION_SYMPTOMS_REQUIRED",
    "FMA_DECLARATION_WITHDRAWAL_REQUIRED",
  ]) assert.equal(codes.has(code), true, `missing ${code}`);
});

test("marks every demo document projection as fake and forbids an official folio", () => {
  const establishment = { ...ESTABLISHMENT, id: "demo-1", dataMode: "demo", rup: "DEMO-EJEMPLO" };
  const valid = buildFmaDocumentProjections({ establishment, profile: PROFILE, movement: movement({ sourceRup: "DEMO-EJEMPLO" }), animals: [animal(1, { locationRup: "DEMO-EJEMPLO" })], document: documentInput() });
  assert.equal(valid.validation.valid, true);
  assert.equal(valid.projections[0].metadata.fakeData, true);
  assert.equal(valid.projections[0].content.fakeData, true);
  assert.equal(valid.projections[0].content.referenceFolio, null);
  assert.equal(valid.projections[0].metadata.officiallySubmittable, false);

  const folio = buildFmaDocumentProjections({ establishment, profile: PROFILE, movement: movement({ sourceRup: "DEMO-EJEMPLO", referenceFolio: "REAL-1" }), animals: [animal(1, { locationRup: "DEMO-EJEMPLO" })], document: documentInput() });
  assert.equal(folio.validation.errors.some((entry) => entry.code === "DEMO_FOLIO_FORBIDDEN"), true);
});

test("derives a versioned annual DEA from individual and summary inventory", () => {
  const inventoryEntries = [
    { id: "cow-1", trackingMode: "individual", animalId: "animal-1", diio: "100000001", speciesCode: "bovine", categoryCode: "cow", quantity: 1 },
    { id: "cow-summary", trackingMode: "summary", speciesCode: "bovine", categoryCode: "cow", quantity: 4 },
    { id: "ewe-summary", trackingMode: "summary", speciesCode: "ovine", categoryCode: "ewe", quantity: 8 },
  ];
  const input = { establishment: ESTABLISHMENT, profile: PROFILE, period: 2026, asOfDate: "2026-12-31", inventoryEntries, document: documentInput({ documentId: "dea-2026" }) };
  const result = buildDeaDocumentProjection(input);
  const replay = buildDeaDocumentProjection({ ...input, inventoryEntries: [...inventoryEntries].reverse() });
  assert.equal(result.validation.valid, true);
  assert.equal(result.projection.content.totalAnimals, 13);
  assert.equal(result.projection.content.period, 2026);
  assert.equal(result.projection.sha256Input, replay.projection.sha256Input);

  const invalid = buildDeaDocumentProjection({ ...input, period: 2025 });
  assert.equal(invalid.validation.errors.some((entry) => entry.code === "DEA_PERIOD_DATE_MISMATCH"), true);
});

test("stages import aliases deterministically and keeps exact existing assignments unchanged", () => {
  const rows = [
    { fila: 2, id_origen: "source-2", "Nro DIIO": "100.000.002", identificador_animal: "animal-2", tipo_dispositivo: "botón", RUP: "01.02.1234" },
    { fila: 1, id_origen: "source-1", DIIO: "100000001", animal_id: "animal-1", tipo_diio: "arete" },
  ];
  const input = { organizationId: "org-1", fieldId: "field-1", rup: "01.02.1234", sourceKind: "sipec_file", rows, existingDevices: [assignedDevice(1)] };
  const result = stageDiioImport(input);
  const replay = stageDiioImport({ ...input, rows: [...rows] });
  const reordered = stageDiioImport({ ...input, rows: [...rows].reverse() });
  assert.equal(result.validation.valid, true);
  assert.equal(result.summary.total, 2);
  assert.equal(result.summary.accepted, 1);
  assert.equal(result.summary.unchanged, 1);
  assert.equal(result.accepted[0].officialNumber, "100000002");
  assert.equal(result.accepted[0].deviceType, "ear_button");
  assert.equal(result.canonicalStage, replay.canonicalStage);
  assert.equal(result.canonicalStage, reordered.canonicalStage);
  assert.equal(Object.isFrozen(result), true);
});

test("reports malformed, duplicate, conflicting, terminal, and cross-scope imports without silent writes", () => {
  const rows = [
    { fila: 1, id_origen: "a", diio: "bad", animal_id: "animal-1" },
    { fila: 2, id_origen: "b", diio: "100000002", animal_id: "animal-2" },
    { fila: 3, id_origen: "c", diio: "100000002", animal_id: "animal-3" },
    { fila: 4, id_origen: "d", diio: "100000004", animal_id: "animal-4" },
    { fila: 5, id_origen: "e", diio: "100000005", animal_id: "animal-5" },
  ];
  const existingDevices = [
    assignedDevice(4, "someone-else"),
    assignedDevice(9, "animal-5"),
    availableDevice(5, { status: "retired", endedAt: "2026-07-19T09:00:00.000Z" }),
  ];
  const result = stageDiioImport({ organizationId: "org-1", fieldId: "field-1", rup: "01.02.1234", sourceKind: "cliex_dbf", rows, existingDevices });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.rowIssues.some((entry) => entry.code === "IMPORT_DIIO_INVALID"), true);
  const codes = new Set(result.conflicts.map((entry) => entry.code));
  assert.equal(codes.has("IMPORT_DIIO_DUPLICATE"), true);
  assert.equal(codes.has("IMPORT_DIIO_ASSIGNED_TO_OTHER_ANIMAL"), true);
  assert.equal(codes.has("IMPORT_ANIMAL_HAS_OTHER_DIIO"), true);
  assert.equal(codes.has("IMPORT_DIIO_TERMINAL"), true);

  const leakedScope = stageDiioImport({ organizationId: "org-1", fieldId: "field-1", rup: "01.02.1234", sourceKind: "sipec_file", rows: [], existingDevices: [availableDevice(8, { organizationId: "org-2" })] });
  assert.equal(leakedScope.validation.valid, false);
  assert.equal(leakedScope.validation.errors.some((entry) => entry.code === "IMPORT_EXISTING_SCOPE_INVALID"), true);

  const invalidStage = stageDiioImport({ organizationId: "../org", fieldId: "field-1", rup: "01.02.1234", sourceKind: "sipec_file", rows: [{ fila: 1, diio: "100000001", animal_id: "animal-1" }] });
  assert.equal(invalidStage.validation.valid, false);
  assert.deepEqual(invalidStage.accepted, []);
});
