import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repository = await readFile(new URL("../src/modules/potreros/server/activity-repository.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/actividades/route.ts", import.meta.url), "utf8");

test("altas, cambios y eliminaciones de manejo auditan dentro del mismo batch", () => {
  assert.match(repository, /auditSource: "activity" \| "assistant\.activity"/);
  assert.match(repository, /INSERT INTO audit_log[\s\S]+activity\.deleted/);
  assert.match(repository, /const statements = \[mutation\][\s\S]+INSERT INTO audit_log[\s\S]+client\.batch\(statements\)/);
  assert.match(repository, /entity_type, entity_id[\s\S]+SELECT \?, \?, \?, \?, \?, 'activity'/);
  assert.match(route, /upsertActivity\(payload as Activity, access, access\.email\)/);
  assert.match(route, /deleteActivity\(id, access, expectedUpdatedAt, access\.email\)/);
});
