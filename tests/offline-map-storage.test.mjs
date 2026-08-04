import assert from "node:assert/strict";
import test from "node:test";
import {
  buildStorageKey,
  serializeOfflinePartition,
  deserializeOfflinePartition,
} from "../src/modules/potreros/sync/offline-map-storage.ts";

test("buildStorageKey aisla partidas por organizacion y fundo con codificación segura", () => {
  const key = buildStorageKey("org:1/special", "field:2");
  assert.equal(key, "fundosmart-map-offline:org%3A1%2Fspecial:field%3A2");
  assert.throws(() => buildStorageKey("  ", "field-1"), TypeError);
});

test("partition serialization hace round-trip completo", () => {
  const partition = {
    organizationId: "org-alpha",
    fieldId: "field-beta",
    paddockDrafts: [{ id: "p-1", fieldId: "field-beta", nombre: "Potrero 1", hectareas: 5, coordinates: [] }],
    updatedAt: "2026-07-28T13:00:00.000Z",
  };

  const serialized = serializeOfflinePartition(partition);
  const deserialized = deserializeOfflinePartition(serialized);

  assert.notEqual(deserialized, null);
  assert.equal(deserialized?.organizationId, "org-alpha");
  assert.equal(deserialized?.fieldId, "field-beta");
  assert.equal(deserialized?.paddockDrafts.length, 1);
});

test("deserializeOfflinePartition rechaza JSON invalido y descarta borrador malformado de forma segura", () => {
  assert.equal(deserializeOfflinePartition("invalid json"), null);
  assert.equal(deserializeOfflinePartition("{}"), null);

  const rawWithCorruptDraft = JSON.stringify({
    organizationId: "org-1",
    fieldId: "field-1",
    paddockDrafts: [{ id: "valid-p1" }, "corrupt-string", null, { noId: true }],
  });
  const res = deserializeOfflinePartition(rawWithCorruptDraft);
  assert.equal(res?.paddockDrafts.length, 1);
  assert.equal(res?.paddockDrafts[0].id, "valid-p1");
});
