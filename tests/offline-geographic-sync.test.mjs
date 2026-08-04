import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  applyGeographicEvents,
  buildPaddockGeometryVersion,
  decidePaddockGeometryLww,
  parseFieldLandmarkPayload,
  parsePaddockGeometryPayload,
  validateGeographicSyncMutation,
} from "../src/modules/potreros/sync/geographic-sync-rules.mjs";

const geometry = { outer: [[-40.6, -73.2], [-40.6, -73.19], [-40.59, -73.19]], holes: [] };

test("geographic payloads are closed, bounded and version the whole paddock batch", () => {
  const updates = [
    { id: "paddock-b", expectedVersion: "2026-07-21T10:00:00.000Z", geometry, holeKinds: [] },
    { id: "paddock-a", expectedVersion: "2026-07-21T09:00:00.000Z", geometry, holeKinds: [] },
  ];
  const version = buildPaddockGeometryVersion(updates);
  assert.equal(version, buildPaddockGeometryVersion([...updates].reverse()));
  const mutation = {
    entity: "paddock_geometry",
    entityId: "paddock-a",
    op: "update",
    clientTs: "2026-07-21T12:00:00.000Z",
    expectedVersion: version,
    payload: { capturedAt: "2026-07-21T12:00:00.000Z", source: "gps", updates },
  };
  assert.equal(validateGeographicSyncMutation(mutation), null);
  assert.deepEqual(parsePaddockGeometryPayload(mutation.payload), mutation.payload);
  assert.match(validateGeographicSyncMutation({ ...mutation, payload: { ...mutation.payload, areaHectares: 999 } }), /campos no permitidos/iu);
  assert.match(validateGeographicSyncMutation({ ...mutation, expectedVersion: "last-write-wins" }), /versión/iu);
  assert.match(validateGeographicSyncMutation({ ...mutation, clientTs: "2026-07-21T12:00:01.000Z" }), /mismo instante/iu);
  assert.throws(() => parsePaddockGeometryPayload({
    ...mutation.payload,
    updates: [{ ...updates[0], geometry: { outer: [[-91, -73], ...geometry.outer.slice(1)], holes: [] } }],
  }), /WGS84/u);

  const landmark = {
    action: "upsert",
    kind: "bebedero",
    geometryType: "point",
    geometry: [[-40.6, -73.2]],
    name: "Bebedero norte",
    notes: "GPS",
  };
  assert.deepEqual(parseFieldLandmarkPayload(landmark), landmark);
  assert.throws(() => parseFieldLandmarkPayload({ ...landmark, fieldId: "field-b" }), /campos no permitidos/iu);
  assert.match(validateGeographicSyncMutation({
    entity: "field_landmark", entityId: "landmark-a", op: "update", expectedVersion: null, payload: landmark,
  }), /versión vigente/iu);
});

test("geographic LWW v1 accepts only a provably newer client clock", () => {
  const base = {
    nowIso: "2026-07-21T12:10:00.000Z",
    currentUpdatedAt: "2026-07-21T12:09:00.000Z",
    lastAcceptedClientTs: "2026-07-21T12:00:00.000Z",
    acceptedProjectionMatchesCurrent: true,
  };
  assert.deepEqual(decidePaddockGeometryLww({ ...base, clientTs: "2026-07-21T12:01:00.000Z" }), {
    action: "apply", reason: null, comparedClientTs: base.lastAcceptedClientTs,
  });
  assert.equal(decidePaddockGeometryLww({ ...base, clientTs: base.lastAcceptedClientTs }).action, "conflict");
  assert.equal(decidePaddockGeometryLww({ ...base, clientTs: "2026-07-21T12:16:00.000Z" }).action, "conflict");
  assert.equal(decidePaddockGeometryLww({ ...base, clientTs: "2026-07-21T12:08:00.000Z", acceptedProjectionMatchesCurrent: false }).action, "conflict");
});

test("pull projections converge by entity without leaking a sibling field", () => {
  const snapshot = {
    fieldId: "field-a",
    paddocks: [{ id: "paddock-old", fieldId: "field-a", updatedAt: "v1" }],
    landmarks: [{ id: "landmark-old", fieldId: "field-a", version: 1, deletedAt: null }],
  };
  const projectedPaddock = { id: "paddock-old", fieldId: "field-a", updatedAt: "v2", geometry };
  const projectedLandmark = { id: "landmark-old", fieldId: "field-a", version: 2, deletedAt: "2026-07-21T12:00:00.000Z" };
  const result = applyGeographicEvents(snapshot, [
    { entity: "paddock_geometry", fieldId: "field-a", payload: { projection: { kind: "paddock_geometry", paddocks: [projectedPaddock] } } },
    { entity: "paddock_geometry", fieldId: "field-b", payload: { projection: { kind: "paddock_geometry", paddocks: [{ ...projectedPaddock, fieldId: "field-b" }] } } },
    { entity: "field_landmark", fieldId: "field-a", payload: { projection: { kind: "field_landmark", landmark: projectedLandmark } } },
  ]);
  assert.deepEqual(result.paddocks, [projectedPaddock]);
  assert.deepEqual(result.landmarks, [projectedLandmark]);
});

test("potreros uses signed direct IndexedDB partitions and never blocks landmark editing on network state", async () => {
  const [offline, page, panel, worker] = await Promise.all([
    readFile(new URL("../src/modules/potreros/sync/geographic-offline.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/PotrerosPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/FieldLandmarksPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(offline, /getActiveOfflineSession\(scope\)/u);
  assert.match(offline, /offlinePartitionFromSession\(session, input\.fieldId\)/u);
  assert.match(offline, /sendOrQueueSyncMutations/u);
  assert.match(offline, /getOfflineReadModel<GeographicOfflineSnapshot>/u);
  assert.match(offline, /putOfflineReadModel/u);
  assert.match(offline, /pullOfflineChanges<DomainEventRecord>/u);
  assert.doesNotMatch(offline, /localStorage|sessionStorage|Authorization|Cookie/u);
  assert.match(page, /queuePaddockGeometrySync/u);
  assert.match(page, /queueFieldLandmarkUpsert/u);
  assert.match(page, /queueFieldLandmarkArchive/u);
  assert.match(page, /landmarkListingFromSnapshot\(activeFieldId, geographic\.snapshot\.landmarks\)/u);
  assert.doesNotMatch(page, /if \(!selectedFundoId \|\| !canMutate \|\| !networkOnline\) return;/u);
  assert.doesNotMatch(panel, /disabled=\{!networkOnline \|\| busy\}/u);
  assert.doesNotMatch(panel, /busy \|\| !networkOnline \|\| !geometryReady/u);
  assert.match(worker, /fundosmart:offline-sync-request/u);
  assert.match(page, /navigator\.serviceWorker\?\.addEventListener\("message", handleWorker\)/u);
});
