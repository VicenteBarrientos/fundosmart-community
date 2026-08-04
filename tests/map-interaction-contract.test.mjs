import assert from "node:assert/strict";
import test from "node:test";
import { createMapEditCommandFacade } from "../src/modules/potreros/map-core/command-facade.ts";
import {
  createMapEditTransaction,
  mapAdapterSnapshot,
  mapEditCanRedo,
  mapEditCanUndo,
  transitionMapEdit,
} from "../src/modules/potreros/map-core/edit-transaction.ts";
import {
  createMapWorkspace,
  transitionMapWorkspace,
} from "../src/modules/potreros/map-core/workspace.ts";

const OUTER = [
  [-40.61, -73.12],
  [-40.61, -73.119],
  [-40.609, -73.119],
  [-40.609, -73.12],
];
const HOLE = [
  [-40.6098, -73.1198],
  [-40.6098, -73.1196],
  [-40.6096, -73.1196],
  [-40.6096, -73.1198],
];
const draft = () => ({
  outer: OUTER.map((coordinate) => [...coordinate]),
  holes: [HOLE.map((coordinate) => [...coordinate])],
});

function transaction(overrides = {}) {
  return createMapEditTransaction({
    id: "map-edit:field-1:create-paddock",
    fieldId: "field-1",
    objective: "create-paddock",
    adapterId: "leaflet-current-v1",
    initialDraft: draft(),
    canonicalVersion: "v1",
    ...overrides,
  });
}

function accepted(result) {
  assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
  return result.transaction;
}

test("EditTransaction keeps normalized holes, pins one adapter, and never mutates inputs", () => {
  const initial = draft();
  const edit = createMapEditTransaction({
    id: "map-edit:1",
    fieldId: "field-1",
    objective: "create-paddock",
    entityIds: ["paddock-1", "paddock-1"],
    adapterId: "leaflet-current-v1",
    initialDraft: initial,
  });

  initial.outer[0][0] = 0;
  initial.holes[0][0][0] = 0;

  assert.deepEqual(edit.draft.outer, OUTER);
  assert.deepEqual(edit.draft.holes[0], HOLE);
  assert.equal(edit.adapterId, "leaflet-current-v1");
  assert.deepEqual(edit.entityIds, ["paddock-1"]);
  assert.deepEqual(edit.baseline, { outer: [], holes: [] });
  assert.equal(edit.dirty, true);
  assert.equal(Object.hasOwn(edit, "gateway"), false);
  assert.equal(Object.hasOwn(edit, "client"), false);
  assert.throws(() => edit.draft.outer.push([-40, -73]), TypeError);
  assert.throws(() => {
    edit.validation.errors.push("mutación");
  }, TypeError);
});

test("gesture commands are deterministic, bounded, and support undo/redo before commit", () => {
  let edit = transaction({ historyLimit: 2 });
  const firstMove = {
    type: "move-vertex",
    target: { kind: "outer" },
    vertexIndex: 0,
    coordinate: [-40.6101, -73.1201],
    source: "manual",
  };

  const resultA = transitionMapEdit(edit, firstMove);
  const resultB = transitionMapEdit(edit, firstMove);
  assert.deepEqual(resultA, resultB);
  edit = accepted(resultA);
  assert.equal(edit.dirty, true);
  assert.equal(mapEditCanUndo(edit), true);

  edit = accepted(transitionMapEdit(edit, {
    type: "insert-vertex",
    target: { kind: "hole", index: 0 },
    edgeIndex: 0,
    coordinate: [-40.6098, -73.1197],
    source: "manual",
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "append-vertex",
    target: { kind: "outer" },
    coordinate: [-40.6089, -73.1195],
    source: "gps",
  }));
  assert.equal(edit.history.past.length, 2);
  assert.equal(edit.source, "gps");

  edit = accepted(transitionMapEdit(edit, { type: "undo" }));
  assert.equal(mapEditCanRedo(edit), true);
  assert.equal(edit.source, "manual");
  edit = accepted(transitionMapEdit(edit, { type: "redo" }));
  assert.equal(edit.draft.outer.length, 5);
  assert.equal(edit.source, "gps");
});

test("invalid geometry commands fail closed without changing the transaction", () => {
  const edit = transaction({
    initialDraft: {
      outer: OUTER.slice(0, 3),
      holes: [],
    },
  });
  const result = transitionMapEdit(edit, {
    type: "remove-vertex",
    target: { kind: "outer" },
    vertexIndex: 0,
    source: "manual",
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid-draft");
  assert.strictEqual(result.transaction, edit);
});

test("validation, preview, save, conflict, and canonical reread form an explicit lifecycle", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-finished",
    validation: { errors: [], warnings: ["Revisar vecino."] },
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "preview-ready",
    preview: {
      affectedEntityIds: ["paddock-1", "paddock-2"],
      warnings: ["Revisar vecino."],
      areaBeforeSquareMeters: 10_000,
      areaAfterSquareMeters: 10_000,
    },
  }));
  edit = accepted(transitionMapEdit(edit, { type: "save-started" }));
  assert.equal(mapEditCanUndo(edit), false);
  edit = accepted(transitionMapEdit(edit, { type: "sync-deferred" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "conflict-detected",
    conflict: { code: "stale-version", message: "Existe una versión más reciente.", serverVersion: "v2" },
  }));
  assert.equal(edit.phase, "conflict");
  assert.deepEqual(edit.draft.holes[0], HOLE);

  const canonical = {
    outer: OUTER.map(([latitude, longitude]) => [latitude + 0.00001, longitude]),
    holes: [],
  };
  edit = accepted(transitionMapEdit(edit, {
    type: "canonical-reloaded",
    draft: canonical,
    canonicalVersion: "v2",
  }));
  assert.equal(edit.phase, "saved");
  assert.equal(edit.dirty, false);
  assert.deepEqual(edit.draft, canonical);
  assert.deepEqual(edit.history, { past: [], future: [], limit: 50 });
});

test("blocking validation cannot produce preview or start persistence", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-finished",
    validation: { errors: ["El límite se cruza."], warnings: [] },
  }));

  const preview = transitionMapEdit(edit, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  });
  assert.equal(preview.ok, false);
  assert.equal(preview.error.code, "validation-failed");
  const save = transitionMapEdit(edit, { type: "save-started" });
  assert.equal(save.ok, false);
});

test("a preview cannot reuse missing or stale validation", () => {
  const initial = transaction();
  const withoutValidation = transitionMapEdit(initial, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  });
  assert.equal(withoutValidation.ok, false);
  assert.equal(withoutValidation.error.code, "validation-failed");

  let validated = accepted(transitionMapEdit(initial, { type: "validation-started" }));
  validated = accepted(transitionMapEdit(validated, {
    type: "validation-finished",
    validation: { errors: [], warnings: [] },
  }));
  const changed = accepted(transitionMapEdit(validated, {
    type: "move-vertex",
    target: { kind: "outer" },
    vertexIndex: 0,
    coordinate: [-40.6102, -73.1202],
    source: "manual",
  }));
  const stale = transitionMapEdit(changed, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "validation-failed");
});

test("an interrupted validator returns to a recoverable draft with an explicit error", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-aborted",
    message: "La validación excedió el tiempo disponible.",
  }));

  assert.equal(edit.phase, "draft");
  assert.equal(edit.validationFailure, "La validación excedió el tiempo disponible.");
  assert.equal(edit.validatedRevision, null);
  assert.equal(transitionMapEdit(edit, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  }).ok, false);
});

test("saving and pending sync cannot be edited or cancelled before canonical reconciliation", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-finished",
    validation: { errors: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, { type: "save-started" }));

  const gesture = transitionMapEdit(edit, {
    type: "move-vertex",
    target: { kind: "outer" },
    vertexIndex: 0,
    coordinate: [-40.6102, -73.1202],
    source: "manual",
  });
  assert.equal(gesture.ok, false);
  assert.equal(transitionMapEdit(edit, { type: "cancel" }).ok, false);

  edit = accepted(transitionMapEdit(edit, { type: "sync-deferred" }));
  assert.equal(transitionMapEdit(edit, { type: "cancel" }).ok, false);
});

test("save failures expose safe retry and unknown-outcome reconciliation paths", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-finished",
    validation: { errors: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, { type: "save-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "save-failed",
    failure: {
      code: "network-unavailable",
      message: "Sin conexión.",
      retryable: true,
      canonicalStateUnknown: false,
    },
  }));
  assert.equal(edit.phase, "save-error");
  edit = accepted(transitionMapEdit(edit, { type: "retry-save" }));
  assert.equal(edit.phase, "saving");

  edit = accepted(transitionMapEdit(edit, {
    type: "save-failed",
    failure: {
      code: "timeout-after-send",
      message: "El servidor puede haber aplicado el cambio.",
      retryable: true,
      canonicalStateUnknown: true,
    },
  }));
  assert.equal(transitionMapEdit(edit, { type: "retry-save" }).ok, false);
  assert.equal(transitionMapEdit(edit, { type: "cancel" }).ok, false);
  edit = accepted(transitionMapEdit(edit, {
    type: "canonical-reconciled",
    outcome: "not-applied",
  }));
  assert.equal(edit.phase, "save-error");
  assert.equal(edit.saveFailure.canonicalStateUnknown, false);
  assert.equal(edit.dirty, true);
  edit = accepted(transitionMapEdit(edit, { type: "retry-save" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "save-failed",
    failure: {
      code: "timeout-after-send",
      message: "El servidor puede haber aplicado el cambio.",
      retryable: true,
      canonicalStateUnknown: true,
    },
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "canonical-reconciled",
    outcome: "applied",
    draft: draft(),
    canonicalVersion: "v2",
  }));
  assert.equal(edit.phase, "saved");
});

test("a non-retryable save error cannot bypass retry policy through save-started", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-finished",
    validation: { errors: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, { type: "save-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "save-failed",
    failure: {
      code: "permission-revoked",
      message: "El permiso cambió.",
      retryable: false,
      canonicalStateUnknown: false,
    },
  }));

  assert.equal(transitionMapEdit(edit, { type: "retry-save" }).ok, false);
  assert.equal(transitionMapEdit(edit, { type: "save-started" }).ok, false);
});

test("conflict resolution requires an explicit canonical baseline and version", () => {
  let edit = accepted(transitionMapEdit(transaction(), { type: "validation-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "validation-finished",
    validation: { errors: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, {
    type: "preview-ready",
    preview: { affectedEntityIds: [], warnings: [] },
  }));
  edit = accepted(transitionMapEdit(edit, { type: "save-started" }));
  edit = accepted(transitionMapEdit(edit, {
    type: "conflict-detected",
    conflict: { code: "stale-version", message: "Existe una versión más reciente.", serverVersion: "v2" },
  }));

  const canonicalDraft = draft();
  const resolvedDraft = draft();
  resolvedDraft.outer[0] = [-40.6102, -73.1202];
  edit = accepted(transitionMapEdit(edit, {
    type: "conflict-resolved",
    canonicalDraft,
    resolvedDraft,
    canonicalVersion: "v2",
  }));

  assert.equal(edit.phase, "draft");
  assert.equal(edit.canonicalVersion, "v2");
  assert.equal(edit.source, "recovery");
  assert.equal(edit.dirty, true);
  assert.deepEqual(edit.baseline, canonicalDraft);
  assert.deepEqual(edit.draft, resolvedDraft);
});

test("an adapter can remount from the same normalized snapshot without a persistence capability", () => {
  const published = [];
  const facade = createMapEditCommandFacade(transaction(), (next) => published.push(next));
  const contexts = [];
  const adapter = {
    id: "leaflet-current-v1",
    renderer: "leaflet",
    capabilities: {
      moveVertex: true,
      insertVertex: true,
      removeVertex: true,
      holes: true,
      touch: true,
    },
    connect(context) {
      contexts.push(context);
      return { disconnect() {} };
    },
  };

  const wrongAdapter = {
    ...adapter,
    id: "other-renderer-v1",
  };
  const mismatch = facade.connectAdapter(wrongAdapter);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.error.code, "adapter-mismatch");

  const failedConnection = facade.connectAdapter({
    ...adapter,
    connect() {
      throw new Error("fallo de montaje");
    },
  });
  assert.equal(failedConnection.ok, false);
  assert.equal(failedConnection.error.code, "adapter-connect-failed");

  const firstConnection = facade.connectAdapter(adapter);
  assert.equal(firstConnection.ok, true);
  const duplicateConnection = facade.connectAdapter(adapter);
  assert.equal(duplicateConnection.ok, false);
  assert.equal(duplicateConnection.error.code, "adapter-active");
  const rejectedGesture = contexts[0].dispatch({
    type: "move-vertex",
    target: { kind: "hole", index: 99 },
    vertexIndex: 0,
    coordinate: [-40.6102, -73.1189],
    source: "manual",
  });
  assert.equal(rejectedGesture.ok, false);
  assert.equal(rejectedGesture.error.code, "invalid-draft");
  assert.equal(published.length, 0);

  const acceptedGesture = contexts[0].dispatch({
    type: "move-vertex",
    target: { kind: "outer" },
    vertexIndex: 1,
    coordinate: [-40.6102, -73.1189],
    source: "manual",
  });
  assert.equal(acceptedGesture.ok, true);
  const beforeRemount = contexts[0].read();
  firstConnection.lease.disconnect();
  const disconnectedGesture = contexts[0].dispatch({
    type: "move-vertex",
    target: { kind: "outer" },
    vertexIndex: 1,
    coordinate: [-40, -73],
    source: "manual",
  });
  assert.equal(disconnectedGesture.ok, false);
  assert.equal(disconnectedGesture.error.code, "adapter-disconnected");
  assert.equal(published.length, 1, "a disconnected adapter cannot dispatch");

  const secondConnection = facade.connectAdapter(adapter);
  assert.equal(secondConnection.ok, true);
  const afterRemount = contexts[1].read();

  assert.deepEqual(afterRemount, beforeRemount);
  assert.deepEqual(afterRemount, mapAdapterSnapshot(facade.read()));
  assert.deepEqual(Object.keys(contexts[0]).sort(), ["dispatch", "read"]);
  assert.equal(published.length, 1);
  assert.throws(() => {
    facade.read().draft.outer[0][0] = 0;
  }, TypeError);
});

test("MapWorkspace owns navigation and layers while allowing at most one structural edit", () => {
  let workspace = createMapWorkspace({
    fieldId: "field-1",
    viewport: { center: [-40.61, -73.12], zoom: 15 },
  });
  workspace = transitionMapWorkspace(workspace, {
    type: "register-layer",
    layer: {
      id: "osm",
      kind: "external-context",
      label: "Calles",
      source: "OpenStreetMap",
      status: "available",
      visible: true,
      observedAt: null,
      version: "2026-07-28",
      attribution: "© OpenStreetMap contributors",
      error: null,
    },
  }).workspace;
  workspace = transitionMapWorkspace(workspace, {
    type: "select-paddocks",
    ids: ["paddock-1", "paddock-1", "paddock-2"],
  }).workspace;
  workspace = transitionMapWorkspace(workspace, {
    type: "begin-edit",
    transactionId: "edit-1",
    fieldId: "field-1",
  }).workspace;

  const competing = transitionMapWorkspace(workspace, {
    type: "begin-edit",
    transactionId: "edit-2",
    fieldId: "field-1",
  });
  assert.equal(competing.ok, false);
  assert.equal(competing.error.code, "transaction-active");
  assert.deepEqual(workspace.selectedPaddockIds, ["paddock-1", "paddock-2"]);
  assert.equal(workspace.layers.osm.attribution, "© OpenStreetMap contributors");

  const missingAttribution = transitionMapWorkspace(workspace, {
    type: "register-layer",
    layer: {
      id: "imagery",
      kind: "external-context",
      label: "Imagen",
      source: "Proveedor",
      status: "loading",
      visible: true,
      observedAt: null,
      version: null,
      attribution: null,
      error: null,
    },
  });
  assert.equal(missingAttribution.ok, false);

  const duplicate = transitionMapWorkspace(workspace, {
    type: "register-layer",
    layer: workspace.layers.osm,
  });
  assert.equal(duplicate.ok, false);

  const wrongField = transitionMapWorkspace(workspace, {
    type: "begin-edit",
    transactionId: "edit-3",
    fieldId: "field-2",
  });
  assert.equal(wrongField.ok, false);
  assert.throws(() => workspace.selectedPaddockIds.push("paddock-3"), TypeError);
  assert.throws(() => {
    workspace.viewport.center[0] = 0;
  }, TypeError);
  assert.throws(() => {
    workspace.layers.osm.status = "error";
  }, TypeError);

  const errorWithoutMessage = transitionMapWorkspace(workspace, {
    type: "set-layer-status",
    id: "osm",
    status: "error",
  });
  assert.equal(errorWithoutMessage.ok, false);
  const availableWithError = transitionMapWorkspace(workspace, {
    type: "set-layer-status",
    id: "osm",
    status: "available",
    error: "No corresponde.",
  });
  assert.equal(availableWithError.ok, false);
});

test("the public map-core barrel loads in the native TypeScript test runtime", async () => {
  const publicApi = await import("../src/modules/potreros/map-core/index.ts");
  assert.equal(typeof publicApi.createMapEditTransaction, "function");
  assert.equal(typeof publicApi.createMapWorkspace, "function");
});
