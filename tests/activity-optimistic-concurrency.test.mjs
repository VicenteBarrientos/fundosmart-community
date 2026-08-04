import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("activity mutations carry the persisted optimistic version through every boundary", async () => {
  const [types, repository, replacementRepository, route, client, page] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/potreros/server/activity-repository.ts"),
    readSource("../src/modules/potreros/server/potrero-repository.ts"),
    readSource("../app/api/actividades/route.ts"),
    readSource("../src/modules/potreros/api/activities-client.ts"),
    readSource("../src/modules/potreros/PotrerosPage.tsx"),
  ]);

  assert.match(types, /export type Activity = \{[\s\S]+?updatedAt\?: string/);
  assert.match(repository, /updatedAt: row\.updatedAt/);
  assert.match(repository, /activity\.updatedAt !== existing\.activity\.updatedAt/);
  assert.match(repository, /existing\.activity\.updatedAt !== expectedUpdatedAt/);
  assert.match(replacementRepository, /function toReplacementActivity[\s\S]+?updatedAt: row\.updatedAt/);

  assert.match(repository, /sameActivityPayload\(existing\.activity, activity\)[\s\S]+?return toActivity\(existing\.activity\)/);
  assert.doesNotMatch(route, /if \(!payload\.updatedAt\?\.trim\(\)\)[\s\S]+?antes de editar/);
  assert.match(route, /if \(!expectedUpdatedAt\)[\s\S]+?status: 409/);
  assert.match(route, /deleteActivity\(id, access, expectedUpdatedAt, access\.email\)/);
  assert.match(route, /error\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);

  assert.match(client, /new URLSearchParams\(\{ id: activityId, updatedAt \}\)/);
  assert.match(page, /activities\.find\(\(activity\) => activity\.id === activityId\)\?\.updatedAt/);
  assert.match(page, /removeActivity\(activityId, expectedUpdatedAt\)/);
  assert.match(page, /activity\.updatedAt \?\? null/);
});
