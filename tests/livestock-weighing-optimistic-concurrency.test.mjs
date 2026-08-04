import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("weighing mutations carry a canonical snapshot through every boundary", async () => {
  const [types, repository, route, client, page, section] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/ganado/server/livestock-weighing-repository.ts"),
    readSource("../app/api/ganado/pesajes/route.ts"),
    readSource("../src/modules/ganado/api/livestock-client.ts"),
    readSource("../src/modules/ganado/GanadoPage.tsx"),
    readSource("../src/modules/ganado/components/PesajesSection.tsx"),
  ]);

  assert.match(types, /export type LivestockWeighing = \{[\s\S]+?snapshotToken\?: string/);
  assert.match(repository, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(repository, /return `livestock-weighing:v1:\$\{hex\}`/);
  assert.match(repository, /entry\.snapshotToken !== currentSnapshotToken/);
  assert.match(repository, /expectedSnapshotToken !== await weighingSnapshotToken\(existing\.weighing\)/);

  assert.match(route, /entry\.snapshotToken === undefined[\s\S]+?status: 409/);
  assert.match(route, /if \(!expectedSnapshotToken\)[\s\S]+?status: 409/);
  assert.match(route, /deleteWeighing\(id, access, expectedSnapshotToken\)/);
  assert.match(route, /cause\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);

  assert.match(client, /entries: \{ animalId: string; weightKg: number; snapshotToken: string \| null \}\[\]/);
  assert.match(client, /new URLSearchParams\(\{ id, snapshotToken \}\)/);
  assert.match(page, /removeWeighing\(id, snapshotToken\)/);
  assert.match(section, /current\?\.snapshotToken \?\? null/);
  assert.match(section, /onDeleteWeighing\(weighing\.id, weighing\.snapshotToken\)/);
});
