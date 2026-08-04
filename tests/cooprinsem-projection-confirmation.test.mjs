import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const repository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/projection-repository.ts", import.meta.url),
  "utf8",
);

test("animal projection binds one guarded workset instead of independent chunks", () => {
  const executableRepository = repository.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(executableRepository, /CONFIRMATION_CHUNK_SIZE|persistProjectionRows|projectionStatements/);
  assert.doesNotMatch(executableRepository, /INSERT OR IGNORE INTO livestock_(?:animals|lot_memberships)/);
  assert.match(repository, /WITH input\(payload\) AS \(VALUES \(\?\)\)[\s\S]+UPDATE import_jobs/);
  assert.match(repository, /failure_message = \(SELECT payload FROM input\)/);
  assert.match(repository, /json_extract\(current_job\.failure_message, '\$\.confirmationId'\)/);
  assert.match(repository, /json_each\(input\.payload, '\$\.rows'\)/);
  assert.match(repository, /json_each\(input\.payload, '\$\.workRows'\)/);
  assert.match(repository, /json_each\(work\.value, '\$\.identifierTargets'\)/);
});

test("the confirmation batch covers every durable effect and rolls back incomplete work", () => {
  assert.match(repository, /const statements = \[[\s\S]+lockJob,[\s\S]+confirmationGuard,/);
  assert.match(repository, /ensureQuarantineLot,[\s\S]+quarantineAudit,/);
  assert.match(repository, /ensureFieldIdentifier,[\s\S]+fieldIdentifierSource,[\s\S]+fieldIdentifierAudit,/);
  assert.match(repository, /createAnimals,[\s\S]+createMemberships,[\s\S]+createIdentifiers,/);
  assert.match(repository, /animalSources,[\s\S]+identifierSources,[\s\S]+animalAudits,/);
  assert.match(repository, /updateImportRows,[\s\S]+updateLotSummaries,[\s\S]+assertComplete,/);
  assert.match(repository, /finalizeJob,[\s\S]+assertFinalized,/);
  assert.match(repository, /current_actor\.id = json_extract\(input\.payload, '\$\.access\.membershipId'\)/);
  assert.match(repository, /current_actor\.normalized_email = lower\(trim\(json_extract\(input\.payload, '\$\.access\.email'\)\)\)/);
  assert.match(repository, /current_actor\.status = 'active'/);
  assert.match(repository, /current_field\.is_demo = 0/);
  assert.match(repository, /membership_field_access AS current_scope/);
  assert.match(repository, /assertCurrentImportActorAccess\(access, \[context\.job\.fieldId\]\)/);
  assert.match(repository, /abs\(-9223372036854775807 - 1\)/);
  assert.match(repository, /UNIQUE constraint failed\|CHECK constraint failed\|FOREIGN KEY constraint failed\|integer overflow/);
});
