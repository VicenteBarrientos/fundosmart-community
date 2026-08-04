import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("legacy bulk subdivision commits through the non-destructive operation repository", async () => {
  const [repository, operations, route, client] = await Promise.all([
    readSource("../src/modules/potreros/server/potrero-repository.ts"),
    readSource("../src/modules/potreros/server/paddock-operation-repository.ts"),
    readSource("../app/api/potreros/lote/route.ts"),
    readSource("../src/modules/potreros/api/potreros-client.ts"),
  ]);

  assert.match(repository, /replacementSnapshotToken\(snapshot\) !== expectedSnapshotToken/);
  assert.match(repository, /return commitLegacyPaddockRedesign\(fundoId, replacements, scope\)/);
  assert.doesNotMatch(repository, /DELETE FROM (?:activities|potreros)/);
  assert.match(operations, /kind: "redesign"/);
  assert.match(operations, /archived_at = \?/);
  assert.match(operations, /created_by_operation_id/);
  assert.match(operations, /paddock_lineage_edges/);
  assert.match(route, /payload\.expectedSnapshotToken/);
  assert.match(route, /error\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);
  assert.match(client, /confirmReplace: true, expectedSnapshotToken/);
});
