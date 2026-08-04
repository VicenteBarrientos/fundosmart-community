import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("paddock mutations carry the persisted optimistic version through every boundary", async () => {
  const [types, repository, route, boundariesRoute, client, page] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/potreros/server/potrero-repository.ts"),
    readSource("../app/api/potreros/route.ts"),
    readSource("../app/api/potreros/limites/route.ts"),
    readSource("../src/modules/potreros/api/potreros-client.ts"),
    readSource("../src/modules/potreros/PotrerosPage.tsx"),
  ]);

  assert.match(types, /updatedAt\?: string/);
  assert.match(repository, /updatedAt: row\.updatedAt/);
  assert.match(repository, /potrero\.updatedAt !== existing\.updatedAt/);
  assert.match(repository, /existing\.paddock\.updatedAt !== expectedUpdatedAt/);
  assert.match(repository, /requestedById\.get\(paddock\.id\)\?\.updatedAt !== paddock\.updatedAt/);

  assert.match(repository, /samePotreroPayload\(existing, values\)[\s\S]+?return toPotrero\(existing\)/);
  assert.doesNotMatch(route, /if \(!payload\.updatedAt\?\.trim\(\)\)[\s\S]+?antes de editar/);
  assert.match(route, /if \(!expectedUpdatedAt\)[\s\S]+?status: 409/);
  assert.match(route, /deletePotrero\(id, access, expectedUpdatedAt\)/);
  assert.match(boundariesRoute, /if \(!potrero\.updatedAt\?\.trim\(\)\)[\s\S]+?status: 409/);

  assert.match(client, /new URLSearchParams\(\{ id: potreroId, updatedAt \}\)/);
  assert.match(page, /potreros\.find\(\(potrero\) => potrero\.id === potreroId\)\?\.updatedAt/);
  assert.match(page, /removePotrero\(potreroId, expectedUpdatedAt\)/);
});
