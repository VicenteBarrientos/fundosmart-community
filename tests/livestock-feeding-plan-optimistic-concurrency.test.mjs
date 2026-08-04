import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("feeding plan mutations carry the persisted version through every boundary", async () => {
  const [repository, route, client, page, section] = await Promise.all([
    readSource("../src/modules/ganado/server/livestock-ration-repository.ts"),
    readSource("../app/api/ganado/racion/route.ts"),
    readSource("../src/modules/ganado/api/livestock-client.ts"),
    readSource("../src/modules/ganado/GanadoPage.tsx"),
    readSource("../src/modules/ganado/components/RacionSection.tsx"),
  ]);

  assert.match(repository, /plan\.updatedAt !== existingForLot\.updatedAt/);
  assert.match(repository, /AND product_name = \?[\s\S]+?AND created_at = \? AND updated_at = \?/);
  assert.match(repository, /client\.batch\(\[mutation, savedStatement\]\)/);
  assert.match(repository, /expectedUpdatedAt !== existing\.updatedAt/);
  assert.match(repository, /deleteLivestockFeedingPlan\([\s\S]+?expectedUpdatedAt: string/);

  assert.match(route, /!payload\.updatedAt\?\.trim\(\)[\s\S]+?status: 409/);
  assert.match(route, /updatedAt: payload\.updatedAt\?\.trim\(\) \?\? now/);
  assert.match(route, /!expectedUpdatedAt[\s\S]+?status: 409/);
  assert.match(route, /deleteLivestockFeedingPlan\(id, access, expectedUpdatedAt\)/);
  assert.match(route, /cause\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);

  assert.match(client, /new URLSearchParams\(\{ id, updatedAt \}\)/);
  assert.match(page, /removeLivestockFeedingPlan\(id, updatedAt\)/);
  assert.match(section, /updatedAt: plan\?\.updatedAt \?\? now/);
  assert.match(section, /onDelete\(plan\.id, plan\.updatedAt\)/);
});
