import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { createMapEditCommandFacade } from "../src/modules/potreros/map-core/command-facade.ts";
import { createMapEditTransaction } from "../src/modules/potreros/map-core/edit-transaction.ts";
import {
  createLeafletCreatePaddockAdapter,
  LEAFLET_CREATE_PADDOCK_ADAPTER_ID,
} from "../src/modules/potreros/components/map/leaflet-create-paddock-adapter.ts";
import {
  boundaryRingsEqual,
  edgeMidpoint,
  insertVertex,
  moveVertex,
  removeVertex,
} from "../src/modules/potreros/utils/boundary-editor.ts";

const FIRST = [-40.61, -73.12];
const SNAPPED_EDGE_POINT = [-40.61, -73.119];
const THIRD = [-40.609, -73.119];
const FOURTH = [-40.609, -73.12];
const MOVED_FIRST = [-40.6101, -73.1201];
const INSERTED = edgeMidpoint(SNAPPED_EDGE_POINT, THIRD);

test("create-paddock keeps the legacy draft and history for the same gesture sequence", () => {
  let legacy = legacyEditor();
  const published = [];
  const adapter = createLeafletCreatePaddockAdapter();
  const facade = createMapEditCommandFacade(createMapEditTransaction({
    id: "map-edit:field-1:create-paddock",
    fieldId: "field-1",
    objective: "create-paddock",
    adapterId: LEAFLET_CREATE_PADDOCK_ADAPTER_ID,
    initialDraft: { outer: [], holes: [] },
    source: "manual",
    historyLimit: 50,
  }), (next) => published.push(next));
  const connection = facade.connectAdapter(adapter);
  assert.equal(connection.ok, true, connection.ok ? undefined : connection.error.message);
  const lease = connection.lease;
  const emptyUndo = adapter.undo();
  assert.equal(emptyUndo.ok, false);
  assert.equal(emptyUndo.error.code, "history-empty");
  assert.deepEqual(emptyUndo.snapshot.draft, { outer: [], holes: [] });
  const gestures = [
    { type: "replace-draft", points: [FIRST] },
    { type: "replace-draft", points: [FIRST, SNAPPED_EDGE_POINT] },
    { type: "replace-draft", points: [FIRST, SNAPPED_EDGE_POINT, THIRD] },
    { type: "replace-draft", points: [FIRST, SNAPPED_EDGE_POINT, THIRD, FOURTH] },
    { type: "insert-vertex", edgeIndex: 1, coordinate: INSERTED },
    { type: "move-vertex", vertexIndex: 0, coordinate: MOVED_FIRST },
    { type: "remove-vertex", vertexIndex: 2 },
    { type: "undo" },
    { type: "redo" },
    { type: "replace-draft", points: [], intent: "clear" },
    { type: "undo" },
    { type: "replace-draft", points: [], intent: "cancel" },
  ];

  for (const gesture of gestures) {
    legacy = dispatchLegacy(legacy, gesture);
    dispatchAdapter(adapter, gesture);
    assertEditorParity(legacy, facade.read(), gesture);
  }

  assert.deepEqual(
    facade.read().history.past.at(-1)?.draft.outer,
    [MOVED_FIRST, SNAPPED_EDGE_POINT, THIRD, FOURTH],
    "cancel preserves the prior draft in undo history exactly like the legacy editor",
  );
  assert.deepEqual(
    published[1].draft.outer[1],
    SNAPPED_EDGE_POINT,
    "the adapter preserves the coordinate already resolved by Leaflet snap",
  );
  assert.equal(adapter.id, "leaflet-current-v1");
  assert.equal(Object.hasOwn(adapter, "save"), false);
  lease.disconnect();
});

test("MapaPotreros routes only create-paddock gestures through the adapter and keeps save outside", async () => {
  const component = await readFile(
    resolve("src/modules/potreros/components/MapaPotreros.tsx"),
    "utf8",
  );
  const adapter = await readFile(
    resolve("src/modules/potreros/components/map/leaflet-create-paddock-adapter.ts"),
    "utf8",
  );

  assert.match(component, /const adapter = createLeafletCreatePaddockAdapter\(\)/u);
  assert.match(component, /objective: "create-paddock"[\s\S]*adapterId: adapter\.id/u);
  assert.match(component, /createMapEditCommandFacade\(transaction,[\s\S]*facade\.connectAdapter\(adapter\)/u);
  assert.match(component, /activeEditorKind === "new"[\s\S]*adapter\.replaceDraft\(snapshot\.points\)/u);
  assert.match(
    component,
    /createPaddockDraftPublisherRef\.current\(cloneRing\(result\.snapshot\.draft\.outer\)\)/u,
  );
  assert.match(component, /result\.error\.code === "history-empty"[\s\S]*setEditorInteractionError\(null\)/u);
  assert.match(component, /setEditorInteractionError\(result\.error\.message\)/u);
  assert.match(
    component,
    /boundaryRingsEqual\(draftPoints, session\.facade\.read\(\)\.draft\.outer\)[\s\S]*session\.lease\.disconnect\(\)[\s\S]*createPaddockSessionRef\.current = null/u,
  );
  assert.match(
    component,
    /draftPoints\.map\(\(point, index\) => \([\s\S]*?click\(event\) \{[\s\S]*?event\.originalEvent\.stopPropagation\(\);[\s\S]*?if \(drawing\) \{[\s\S]*?index === 0 && draftPoints\.length >= 3[\s\S]*?setDrawing\(false\);[\s\S]*?setDrawingSnap\(null\);[\s\S]*?return;[\s\S]*?setSelectedBoundaryVertex/u,
  );
  assert.doesNotMatch(component, /bubblingMouseEvents=\{drawing/u);
  assert.match(component, /onClick=\{onCreateSaveRequest\}/u);
  assert.doesNotMatch(adapter, /\bfetch\s*\(|gateway|repository|onCreateSaveRequest/iu);
});

test("an external clear starts the next gesture and undo from the cleared draft", () => {
  const firstSession = connectedSession([FIRST, SNAPPED_EDGE_POINT, THIRD]);
  firstSession.adapter.appendVertex(FOURTH);
  assert.equal(firstSession.facade.read().history.past.length, 1);

  const externalDraft = [];
  assert.equal(
    boundaryRingsEqual(externalDraft, firstSession.facade.read().draft.outer),
    false,
    "the React reconciliation effect must invalidate this stale session",
  );
  firstSession.lease.disconnect();

  const reconciledSession = connectedSession(externalDraft);
  assert.equal(reconciledSession.adapter.appendVertex(FIRST).ok, true);
  const undo = reconciledSession.adapter.undo();
  assert.equal(undo.ok, true);
  assert.deepEqual(undo.snapshot.draft, { outer: [], holes: [] });
  assert.equal(reconciledSession.facade.read().history.past.length, 0);
  reconciledSession.lease.disconnect();
});

function connectedSession(initialDraft) {
  const adapter = createLeafletCreatePaddockAdapter();
  const facade = createMapEditCommandFacade(
    createMapEditTransaction({
      id: "map-edit:field-1:external-reconciliation",
      fieldId: "field-1",
      objective: "create-paddock",
      adapterId: LEAFLET_CREATE_PADDOCK_ADAPTER_ID,
      initialDraft: { outer: initialDraft, holes: [] },
      source: "manual",
      historyLimit: 50,
    }),
    () => {},
  );
  const connection = facade.connectAdapter(adapter);
  assert.equal(connection.ok, true, connection.ok ? undefined : connection.error.message);
  return { adapter, facade, lease: connection.lease };
}

function dispatchAdapter(adapter, gesture) {
  switch (gesture.type) {
    case "replace-draft":
      adapter.replaceDraft(gesture.points);
      return;
    case "insert-vertex":
      adapter.insertVertex(gesture.edgeIndex, gesture.coordinate);
      return;
    case "move-vertex":
      adapter.moveVertex(gesture.vertexIndex, gesture.coordinate);
      return;
    case "remove-vertex":
      adapter.removeVertex(gesture.vertexIndex);
      return;
    case "undo":
      adapter.undo();
      return;
    case "redo":
      adapter.redo();
      return;
    default:
      assert.fail(`Unknown adapter gesture: ${gesture.type}`);
  }
}

function legacyEditor() {
  return { draft: [], past: [], future: [] };
}

function dispatchLegacy(editor, gesture) {
  if (gesture.type === "undo") {
    const previous = editor.past.at(-1);
    if (!previous) return editor;
    return {
      draft: cloneRing(previous),
      past: editor.past.slice(0, -1),
      future: [...editor.future, cloneRing(editor.draft)].slice(-50),
    };
  }
  if (gesture.type === "redo") {
    const next = editor.future.at(-1);
    if (!next) return editor;
    return {
      draft: cloneRing(next),
      past: [...editor.past, cloneRing(editor.draft)].slice(-50),
      future: editor.future.slice(0, -1),
    };
  }

  const next = gesture.type === "replace-draft"
    ? cloneRing(gesture.points)
    : gesture.type === "insert-vertex"
      ? insertVertex(editor.draft, gesture.edgeIndex, gesture.coordinate)
      : gesture.type === "move-vertex"
        ? moveVertex(editor.draft, gesture.vertexIndex, gesture.coordinate)
        : removeVertex(editor.draft, gesture.vertexIndex);
  if (boundaryRingsEqual(editor.draft, next)) return editor;
  return {
    draft: cloneRing(next),
    past: [...editor.past, cloneRing(editor.draft)].slice(-50),
    future: [],
  };
}

function assertEditorParity(legacy, transaction, gesture) {
  const label = `${gesture.type}${gesture.intent ? `:${gesture.intent}` : ""}`;
  assert.deepEqual(transaction.draft, { outer: legacy.draft, holes: [] }, `${label} draft`);
  assert.deepEqual(
    transaction.history.past.map(({ draft }) => draft.outer),
    legacy.past,
    `${label} undo history`,
  );
  assert.deepEqual(
    transaction.history.future.map(({ draft }) => draft.outer),
    legacy.future,
    `${label} redo history`,
  );
}

function cloneRing(ring) {
  return ring.map(([latitude, longitude]) => [latitude, longitude]);
}
