import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildProjectionCandidate,
  deterministicProjectionId,
  projectionIdentityKey,
  resolveProjectionMatches,
} from "../src/modules/integraciones/cooprinsem/server/projection-rules.mjs";

const migration = readFileSync(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const identityMigration = readFileSync(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/proyeccion/route.ts", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/projection-repository.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");
const animalRepository = readFileSync(new URL("../src/modules/ganado/server/livestock-animal-repository.ts", import.meta.url), "utf8");

test("builds a canonical identity without inferring animal attributes", () => {
  const candidate = buildProjectionCandidate({
    NUMPREDIO: "000123",
    FCONTROL: "2026-07-17",
    NUMVACA: 99990050,
    DV: "X",
    NOMBRE: " VACA-01 ",
    RP: "0007",
    CODBARRA: 7800000000001,
    GRUPO: 4,
  });
  assert.equal(candidate.canonicalTag, "99990050-X");
  assert.equal(candidate.sourceKey, "cooprinsem_numvaca_dv:99990050-X");
  assert.equal(candidate.normalizedFieldCode, "000123");
  assert.equal(candidate.groupCode, "4");
  assert.equal(candidate.effectiveAt, "2026-07-17");
  assert.deepEqual(candidate.identifiers.map((entry) => entry.kind), [
    "cooprinsem_numvaca",
    "cooprinsem_nombre",
    "rp",
    "barcode",
    "cooprinsem_numvaca_dv",
  ]);
  assert.equal(candidate.identifiers.find((entry) => entry.kind === "rp").value, "0007");
});

test("detects conflicting identities instead of merging animals", () => {
  const candidate = buildProjectionCandidate({ NUMVACA: 100, RP: "RP-9" });
  const existing = new Map([
    [projectionIdentityKey(candidate.identifiers[0]), new Set(["animal-a"])],
    [projectionIdentityKey(candidate.identifiers[1]), new Set(["animal-b"])],
  ]);
  const result = resolveProjectionMatches(candidate.identifiers, existing);
  assert.deepEqual(result.animalIds, ["animal-a", "animal-b"]);
});

test("reuses a deterministic proposed animal for duplicate rows", () => {
  const candidate = buildProjectionCandidate({ NUMVACA: 100, NOMBRE: "VACA-100" });
  const proposed = new Map(candidate.identifiers.map((entry) => [projectionIdentityKey(entry), "animal-proposed"]));
  const result = resolveProjectionMatches(candidate.identifiers, new Map(), proposed);
  assert.deepEqual(result.animalIds, ["animal-proposed"]);
  assert.equal(deterministicProjectionId("animal", ["field-1", "cooprinsem_numvaca", "100"]), "animal:field-1:cooprinsem_numvaca:100");
});

test("combines persisted and in-plan matches to expose a contradiction", () => {
  const candidate = buildProjectionCandidate({ NUMVACA: 100, RP: "RP-9" });
  const existing = new Map([[projectionIdentityKey(candidate.identifiers[0]), new Set(["animal-existing"])]]);
  const planned = new Map([[projectionIdentityKey(candidate.identifiers[1]), "animal-planned"]]);
  const result = resolveProjectionMatches(candidate.identifiers, existing, planned);
  assert.deepEqual(result.animalIds, ["animal-existing", "animal-planned"]);
});

test("removes global DIIO uniqueness while preserving fundo-scoped checks", () => {
  assert.doesNotMatch(migration, /CREATE UNIQUE INDEX `livestock_animals_tag_unique`/);
  assert.match(migration, /CREATE INDEX `livestock_animals_tag_idx`/);
  assert.match(animalRepository, /eq\(livestockLots\.fieldId, lot\.fieldId\)/);
});

test("enforces one active external identity per scope", () => {
  assert.match(identityMigration, /field_external_identifiers_one_active_unique[\s\S]+valid_to[^;]+IS NULL/);
  assert.match(identityMigration, /livestock_animal_identifiers_one_active_unique[\s\S]+valid_to[^;]+IS NULL/);
  assert.match(identityMigration, /livestock_lot_external_identifiers_one_active_unique[\s\S]+valid_to[^;]+IS NULL/);
});

test("projection is authenticated, explicit, idempotent, and source-linked", () => {
  const executableRepository = repository.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireResourceField\(access, "import_job"/);
  assert.match(repository, /input\.confirmation !== input\.importJobId/);
  assert.match(repository, /status = 'importing'/);
  assert.doesNotMatch(executableRepository, /INSERT OR IGNORE INTO livestock_animals/);
  assert.doesNotMatch(executableRepository, /CONFIRMATION_CHUNK_SIZE/);
  assert.match(repository, /failure_message = \(SELECT payload FROM input\)/);
  assert.match(repository, /json_each\(input\.payload, '\$\.workRows'\)/);
  assert.match(repository, /lockJob,[\s\S]+confirmationGuard,[\s\S]+assertComplete,[\s\S]+finalizeJob,[\s\S]+assertFinalized/);
  assert.match(repository, /targetState = target\.shouldInsert \? "insert"[\s\S]+INSERT INTO livestock_animal_identifiers/);
  assert.doesNotMatch(executableRepository, /INSERT OR IGNORE INTO livestock_animal_identifiers/);
  assert.match(repository, /INSERT INTO source_records/);
  assert.doesNotMatch(executableRepository, /INSERT OR IGNORE INTO source_records/);
  assert.match(repository, /UPDATE import_rows[\s\S]+status = 'imported'/);
  assert.match(repository, /import\.confirmed/);
  assert.match(repository, /proposedLotByAnimalId/);
  assert.match(repository, /se conservará la pertenencia actual del animal/);
  assert.match(repository, /IMPORT_PLAN_STALE/);
  assert.match(repository, /integer overflow/);
  assert.match(repository, /INSERT OR IGNORE INTO livestock_milk_controls/);
  assert.match(repository, /INSERT OR IGNORE INTO milk_quality_samples/);
  assert.doesNotMatch(executableRepository, /INSERT OR IGNORE INTO livestock_(?:reproductive_events|health_events)/);
  assert.match(page, /Simular integración canónica/);
  assert.match(page, /projectableMilkControlCount/);
  assert.match(page, /Revisé la simulación/);
});
