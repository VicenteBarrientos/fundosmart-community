import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("livestock lot mutations carry the persisted optimistic version through every boundary", async () => {
  const [types, repository, route, client, page, section, dialog] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/ganado/server/livestock-repository.ts"),
    readSource("../app/api/ganado/route.ts"),
    readSource("../src/modules/ganado/api/livestock-client.ts"),
    readSource("../src/modules/ganado/GanadoPage.tsx"),
    readSource("../src/modules/ganado/components/LotesSection.tsx"),
    readSource("../src/modules/ganado/components/ManageLivestockLotDialog.tsx"),
  ]);

  assert.match(types, /export type LivestockLot = \{[\s\S]+?updatedAt\?: string/);
  assert.match(repository, /updatedAt: row\.updatedAt/);
  assert.match(repository, /!lot\.updatedAt \|\| lot\.updatedAt !== existing\.updatedAt/);
  assert.match(repository, /existing\.updatedAt !== expectedUpdatedAt/);
  assert.match(repository, /WHERE id = \? AND field_id = \? AND created_at = \? AND updated_at = \?/);

  assert.match(route, /if \(!payload\.updatedAt\?\.trim\(\)\)[\s\S]+?status: 409/);
  assert.match(route, /if \(!expectedUpdatedAt\)[\s\S]+?status: 409/);
  assert.match(route, /deleteLivestockLot\(id, access, expectedUpdatedAt\)/);
  assert.match(route, /cause\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);

  assert.match(client, /new URLSearchParams\(\{ id, updatedAt \}\)/);
  assert.match(page, /removeLivestockLot\(id, updatedAt\)/);
  assert.match(section, /onDelete: \(id: string, updatedAt: string\)/);
  assert.match(dialog, /updatedAt: lot\?\.updatedAt/);
  assert.match(dialog, /onDelete\(lot\.id, lot\.updatedAt\)/);
});
