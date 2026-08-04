import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildConfirmationToken,
  markDuplicateGenealogyCandidates,
  normalizeCooprinsemGroupCode,
  resolveGenealogyCandidate,
} from "../src/modules/integraciones/cooprinsem/server/configuration-rules.mjs";

const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/configuration-repository.ts", import.meta.url), "utf8");
const actorAccessGuard = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/current-actor-access.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/configuracion/route.ts", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemConfigurationWorkspace.tsx", import.meta.url), "utf8");
const importPage = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");
const animalRecord = readFileSync(new URL("../src/modules/ganado/ficha/server/animal-record-repository.ts", import.meta.url), "utf8");

test("normalizes Cooprinsem group codes without dropping significant text", () => {
  assert.equal(normalizeCooprinsemGroupCode("  grupo-04 "), "GRUPO-04");
  assert.equal(normalizeCooprinsemGroupCode(4), "4");
});

test("reconciles genealogy only for one compatible candidate", () => {
  const ready = resolveGenealogyCandidate({
    damAnimalId: "dam-1",
    occurredAt: "2026-05-10",
    sex: "female",
    matches: [{ animalId: "calf-1", tag: "DIIO-10", sex: "female", birthDate: "2026-05-10", matchedBy: ["cooprinsem_numvaca_dv"] }],
  });
  assert.equal(ready.status, "ready");
  assert.equal(ready.candidateAnimalId, "calf-1");

  const conflict = resolveGenealogyCandidate({
    damAnimalId: "dam-1",
    occurredAt: "2026-05-10",
    sex: "female",
    matches: [{ animalId: "calf-1", tag: "DIIO-10", sex: "male", birthDate: "2026-05-11", matchedBy: ["tag"] }],
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.issues.length, 2);
});

test("marks one animal proposed for multiple offspring as a conflict", () => {
  const base = {
    birthId: "birth-1", occurredAt: "2026-05-10", damAnimalId: "dam-1", damTag: "DAM-1",
    temporaryIdentifier: "CALF-1", sex: "female", status: "ready", candidateAnimalId: "calf-1",
    candidateTag: "CALF-1", matchedBy: ["tag"], issues: [],
  };
  const rows = markDuplicateGenealogyCandidates([
    { ...base, offspringId: "offspring-1" },
    { ...base, offspringId: "offspring-2", temporaryIdentifier: "ALIAS-1" },
  ]);
  assert.deepEqual(rows.map((row) => row.status), ["conflict", "conflict"]);
});

test("confirmation tokens are stable and invalidate changed plans", async () => {
  const first = await buildConfirmationToken("group", { fieldId: "field-1", group: "4", lot: "lot-a" });
  const repeated = await buildConfirmationToken("group", { fieldId: "field-1", group: "4", lot: "lot-a" });
  const changed = await buildConfirmationToken("group", { fieldId: "field-1", group: "4", lot: "lot-b" });
  assert.equal(first, repeated);
  assert.notEqual(first, changed);
});

test("configuration writes are authenticated, simulated, temporal, and audited", () => {
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireContextField\(access, fieldId\)/);
  assert.match(route, /actorEmail: access\.email/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /getCooprinsemConfiguration\(\{ fieldId, \.\.\.repositoryAccess \}\)/);
  assert.match(route, /simulate_group_mapping/);
  assert.match(route, /confirm_quarantine_reassignment/);
  assert.match(route, /confirm_genealogy_reconciliation/);
  assert.match(repository, /isNull\(livestockLotExternalIdentifiers\.validTo\)/);
  assert.match(repository, /import\.group_mapping\.(?:created|changed)/);
  assert.match(repository, /import\.group_mapping\.deactivated/);
  assert.match(repository, /import\.group_lot\.reassigned/);
  assert.match(repository, /livestock_lot_membership/);
  assert.match(repository, /genealogy\.offspring\.linked/);
  assert.match(repository, /CONFIGURATION_PLAN_STALE/);
  assert.match(repository, /membershipId: input\.membershipId/);
  assert.match(actorAccessGuard, /current_actor\.status = 'active'/);
  assert.match(actorAccessGuard, /current_actor\.role IN \('owner', 'admin', 'manager'\)/);
  assert.match(actorAccessGuard, /membership_field_access AS current_scope/);
  assert.match(actorAccessGuard, /\$\{fieldAlias\}\.is_demo = 0/);
  assert.match(repository, /eq\(importJobs\.organizationId, scope\.organizationId\)/);
  assert.match(repository, /sameFieldScope\(scope, currentScope\)/);
});

test("every raw reassignment and genealogy statement prepares on the migrated schema", () => {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(name, migrationDirectory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  const statements = [...repository.matchAll(/client\.prepare\(`([\s\S]*?)`\)/g)]
    .map((match) => match[1]
      .replaceAll("${actorGuard.sql}", "1 = 1")
      .replaceAll("${guard.sql}", "1 = 1"));
  assert.ok(statements.length >= 7);
  for (const sql of statements) db.prepare(sql);
  db.close();
});

test("the UI separates mapping, movement, and genealogy confirmations", () => {
  assert.match(importPage, /label="Configuración"/);
  assert.match(workspace, /Simular mapeo/);
  assert.match(workspace, /La reasignación tiene su propia simulación/);
  assert.match(workspace, /Reconciliación de genealogía/);
  assert.match(workspace, /Revisé las coincidencias únicas/);
});

test("manual birth linkage is scoped to the field and rejects reused offspring", () => {
  assert.match(animalRecord, /resolveKnownAnimalIds\([^,]+, scope\.fieldId\)/);
  assert.match(animalRecord, /eq\(livestockLots\.fieldId, fieldId\)/);
  assert.match(animalRecord, /isNull\(livestockAnimalIdentifiers\.validTo\)/);
  assert.match(animalRecord, /ya está enlazado como cría de otro parto/);
});
