import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const birthHealthMigration = readFileSync(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/modules/ganado/ficha/server/animal-record-repository.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/ganado/ficha/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../app/(producto)/ganado/ficha/page.tsx", import.meta.url), "utf8");
const interfaceSource = readFileSync(new URL("../src/modules/ganado/ficha/AnimalRecordPage.tsx", import.meta.url), "utf8");

test("the canonical animal history migration is additive and constrained", () => {
  for (const table of ["livestock_lactations", "livestock_milk_controls", "livestock_reproductive_events"]) {
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.doesNotMatch(migration, /^(?:DROP|ALTER|DELETE)\b/im);
  assert.match(migration, /livestock_lactations_one_active_unique/);
  assert.match(migration, /livestock_milk_controls_animal_date_unique/);
  assert.match(migration, /livestock_milk_controls_total_check/);
  assert.match(migration, /livestock_reproductive_events_type_check/);
});

test("animal history writes are authenticated, atomic, and audited", () => {
  assert.match(route, /authorizeApiAccess\("operate"\)/);
  assert.match(route, /requireResourceField\(access, "animal"/);
  assert.match(route, /normalizeMilkControlInput/);
  assert.match(route, /normalizeReproductiveEventInput/);
  assert.match(repository, /client\.batch/);
  assert.match(repository, /audit_log/);
  assert.match(repository, /milkControlWriteCondition/);
  assert.match(repository, /livestock_milk_controls AS competing_control/);
  assert.match(repository, /current_control\.updated_at = \?/);
  assert.match(repository, /auditResult\.meta\.changes !== 1 \|\| mutationResult\.meta\.changes !== 1/);
  assert.match(repository, /executeReproductiveBatch/);
  assert.match(repository, /livestock_reproductive_events AS competing_event/);
  assert.match(repository, /current_event\.updated_at = \?/);
  assert.match(repository, /lactationSequenceCondition/);
  assert.match(repository, /results\.some\(\(result\) => result\.meta\.changes !== 1\)/);
  assert.match(repository, /lactation\.created_from_calving/);
  assert.match(repository, /lactation\.closed_by_dry_off/);
  assert.match(repository, /sourceRecordId/);
});

test("birth, offspring, and health records are additive and constrained", () => {
  for (const table of ["livestock_births", "livestock_birth_offspring", "livestock_health_events"]) {
    assert.match(birthHealthMigration, new RegExp("CREATE TABLE `" + table + "`"));
  }
  assert.doesNotMatch(birthHealthMigration, /^(?:DROP|ALTER|DELETE)\b/im);
  assert.match(birthHealthMigration, /livestock_births_dam_date_unique/);
  assert.match(birthHealthMigration, /livestock_birth_offspring_weight_check/);
  assert.match(birthHealthMigration, /livestock_health_events_milk_withdrawal_check/);
});

test("birth and health writes are authenticated, atomic, and auditable", () => {
  assert.match(route, /normalizeBirthInput/);
  assert.match(route, /normalizeHealthEventInput/);
  assert.match(repository, /birth\.created/);
  assert.match(repository, /health_event\.created/);
  assert.match(repository, /current_field\.organization_id = \?/);
  assert.match(repository, /current_field\.id IN \(SELECT value FROM json_each\(\?\)\)/);
  assert.match(repository, /eventResult\.meta\.changes !== 1 \|\| auditResult\.meta\.changes !== 1/);
  assert.match(repository, /lactation\.created_from_birth/);
  assert.match(repository, /resolveKnownAnimalIds/);
  assert.match(repository, /executeBirthBatch/);
  assert.match(repository, /livestock_births AS competing_birth/);
  assert.match(repository, /livestock_birth_offspring AS competing_offspring/);
  assert.match(repository, /auditRowCondition\(guardAuditId, "birth\.created", birthId\)/);
  assert.match(repository, /birthOffspringResolutionCondition/);
  assert.match(interfaceSource, /Parto y crías/);
  assert.match(interfaceSource, /Salud animal/);
});

test("the protected 360 record is discoverable from the livestock module", () => {
  assert.match(page, /requirePageAccess/);
  assert.match(page, /listAnimalDirectory\(access\)/);
  assert.match(page, /getAnimalRecord\(initialAnimal\.id, access\)/);
  assert.match(route, /getAnimalRecord\(animalId, access\)[\s\S]+reauthorizeApiAccess\(access, "view", record\.fieldId\)[\s\S]+Response\.json\(\{ record \}/);
  assert.match(page, /getAnimalRecord\(initialAnimal\.id, access\)[\s\S]+reauthorizePageAccess\([\s\S]+initialRecord\?\.fieldId \?\? initialAnimal\?\.fieldId[\s\S]+<AnimalRecordPage/);
  assert.match(page, /new Set\(animals\.map\(\(animal\) => animal\.fieldId\)\)[\s\S]+new Set\(currentAccess\.fieldIds\)[\s\S]+\.some\(\(fieldId\) => !currentFieldIds\.has\(fieldId\)\)[\s\S]+ACCESS_SCOPE_CHANGED[\s\S]+<AnimalRecordPage/);
  assert.equal((page.match(/reauthorizePageAccess\(/g) ?? []).length, 1);
  assert.match(page, /isDemo=\{currentAccess\.email === DEMO_EMAIL\}/);
  assert.match(page, /userName=\{currentAccess\.displayName\}/);
  assert.match(interfaceSource, /Ficha animal 360/);
  assert.match(interfaceSource, /Cronología unificada/);
  assert.match(interfaceSource, /Curva lechera/);
  assert.match(interfaceSource, /Señales para actuar/);
});
