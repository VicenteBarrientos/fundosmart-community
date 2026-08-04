import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  AnimalRecordRuleError,
  normalizeAnimalTag,
  normalizeRenumberInput,
} from "../src/modules/ganado/ficha/server/animal-record-rules.mjs";
import {
  assertRenumberPlanApplied,
  buildAnimalRenumberPlan,
} from "../src/modules/ganado/ficha/server/animal-renumber-plan.mjs";

const repository = readFileSync(new URL("../src/modules/ganado/ficha/server/animal-record-repository.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/ganado/ficha/route.ts", import.meta.url), "utf8");
const forms = readFileSync(new URL("../src/modules/ganado/ficha/AnimalRecordForms.tsx", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/modules/ganado/ficha/AnimalRecordPage.tsx", import.meta.url), "utf8");
const animalRepository = readFileSync(new URL("../src/modules/ganado/server/livestock-animal-repository.ts", import.meta.url), "utf8");

const ORGANIZATION_ID = "org-1";
const FIELD_ID = "field-1";
const LOT_ID = "lot-1";
const ANIMAL_ID = "animal-1";
const ACTOR = "operator@example.com";

test("normalizes a renumber and rejects invalid numbers and dates", () => {
  const result = normalizeRenumberInput(
    { animalId: " animal-1 ", newTag: " 954.124 ", effectiveOn: "2026-07-20", reason: "  Crotal perdido  " },
    "2026-07-30",
  );
  assert.deepEqual(result, {
    animalId: "animal-1",
    newTag: "954.124",
    normalizedNewTag: "954.124",
    effectiveOn: "2026-07-20",
    reason: "Crotal perdido",
  });

  assert.throws(
    () => normalizeRenumberInput({ animalId: "animal-1", newTag: "954 124", effectiveOn: "2026-07-20" }, "2026-07-30"),
    (error) => error instanceof AnimalRecordRuleError && error.code === "RENUMBER_TAG_INVALID",
  );
  assert.throws(
    () => normalizeRenumberInput({ animalId: "animal-1", newTag: "A2", effectiveOn: "2026-08-15" }, "2026-07-30"),
    (error) => error instanceof AnimalRecordRuleError && error.code === "RENUMBER_DATE_FUTURE",
  );
  assert.throws(
    () => normalizeRenumberInput({ animalId: "animal-1", newTag: "", effectiveOn: "2026-07-20" }, "2026-07-30"),
    (error) => error instanceof AnimalRecordRuleError && error.code === "RENUMBER_TAG_REQUIRED",
  );
});

test("normalizes tags case-insensitively so a2 and A2 are the same number", () => {
  assert.equal(normalizeAnimalTag(" a2 "), "A2");
  assert.equal(normalizeAnimalTag(null), "");
});

test("a first renumber materializes the old number as closed history", () => {
  const db = migratedDatabase();
  seedHerd(db);

  runPlan(db, renumberPlan({ previousTag: "954.123", newTag: "954.124", effectiveOn: "2026-07-20" }));

  assert.equal(currentTag(db), "954.124");
  const history = identifierHistory(db);
  assert.deepEqual(history, [
    { value: "954.123", normalized_value: "954.123", valid_from: null, valid_to: "2026-07-20", is_primary: 0 },
    { value: "954.124", normalized_value: "954.124", valid_from: "2026-07-20", valid_to: null, is_primary: 1 },
  ]);
  const [audit] = db.prepare("SELECT action, before, after FROM audit_log WHERE entity_id = ?").all(ANIMAL_ID);
  assert.equal(audit.action, "animal.renumbered");
  assert.deepEqual(JSON.parse(audit.before), { tag: "954.123" });
  assert.equal(JSON.parse(audit.after).previousTag, "954.123");
  assert.equal(JSON.parse(audit.after).reason, "Crotal perdido");
  db.close();
});

test("a second renumber chains the history instead of overwriting it", () => {
  const db = migratedDatabase();
  seedHerd(db);

  runPlan(db, renumberPlan({ previousTag: "954.123", newTag: "954.124", effectiveOn: "2026-07-20" }));
  runPlan(db, renumberPlan({ previousTag: "954.124", newTag: "A-77", effectiveOn: "2026-07-28" }));

  assert.equal(currentTag(db), "A-77");
  assert.deepEqual(identifierHistory(db).map((row) => [row.value, row.valid_from, row.valid_to]), [
    ["954.123", null, "2026-07-20"],
    ["954.124", "2026-07-20", "2026-07-28"],
    ["A-77", "2026-07-28", null],
  ]);
  assert.equal(activeIdentifierCount(db), 1);
  db.close();
});

test("the old number keeps resolving the animal after the change", () => {
  const db = migratedDatabase();
  seedHerd(db);
  runPlan(db, renumberPlan({ previousTag: "954.123", newTag: "954.124", effectiveOn: "2026-07-20" }));

  // Así es como una importación reconcilia una fila histórica de Cliex.
  const [resolved] = db.prepare(`
    SELECT animal_id FROM livestock_animal_identifiers
    WHERE field_id = ? AND normalized_value = ?
  `).all(FIELD_ID, "954.123");
  assert.equal(resolved.animal_id, ANIMAL_ID);
  db.close();
});

test("a number already used by another animal of the field is rejected and rolls back", () => {
  const db = migratedDatabase();
  seedHerd(db);
  insertAnimal(db, "animal-2", "954.124");

  assert.throws(
    () => runPlan(db, renumberPlan({ previousTag: "954.123", newTag: "954.124", effectiveOn: "2026-07-20" })),
    /integer overflow/i,
  );

  assert.equal(currentTag(db), "954.123");
  db.close();
});

test("an animal outside the authorized field scope is never renumbered", () => {
  const db = migratedDatabase();
  seedHerd(db);

  const plan = buildAnimalRenumberPlan({
    ...planDefaults({ previousTag: "954.123", newTag: "954.124", effectiveOn: "2026-07-20" }),
    fieldIds: ["field-ajeno"],
  });
  assert.throws(() => runPlan(db, plan), /integer overflow/i);

  assert.equal(currentTag(db), "954.123");
  assert.equal(identifierHistory(db).length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS total FROM audit_log WHERE entity_id = ?").get(ANIMAL_ID).total, 0);
  db.close();
});

test("the plan result guard demands exactly one closure or backfill", () => {
  const applied = (changes) => assertRenumberPlanApplied([
    { label: "close_active_identifier", changes: changes.closed },
    { label: "backfill_previous_identifier", changes: changes.backfilled },
    { label: "open_active_identifier", changes: 1 },
    { label: "move_animal_tag", changes: 1 },
    { label: "audit", changes: 1 },
  ]);
  assert.equal(applied({ closed: 1, backfilled: 0 }), true);
  assert.equal(applied({ closed: 0, backfilled: 1 }), true);
  assert.equal(applied({ closed: 1, backfilled: 1 }), false);
  assert.equal(applied({ closed: 0, backfilled: 0 }), false);
});

test("the renumber is authenticated, scoped, atomic, and audited across every boundary", () => {
  assert.match(route, /action === "renumber"/);
  assert.match(route, /normalizeRenumberInput\(payload\)/);
  assert.match(route, /requireResourceField\(access, "animal", input\.animalId\)/);
  assert.match(repository, /saveAnimalRenumber/);
  assert.match(repository, /buildAnimalRenumberPlan/);
  assert.match(repository, /assertRenumberPlanApplied/);
  assert.match(repository, /client\.batch\(statements\)/);
  assert.match(repository, /RENUMBER_UNCHANGED/);
  assert.match(repository, /RENUMBER_DATE_BEFORE_CURRENT/);
  assert.match(repository, /RENUMBER_CONFLICT/);
  // El número anterior nunca se borra ni se sobrescribe.
  assert.doesNotMatch(repository, /DELETE FROM livestock_animal_identifiers/);
  assert.match(page, /RenumberForm/);
  assert.match(page, /Cambio de número/);
  assert.match(forms, /persistRenumber/);
  assert.match(forms, /El número anterior no se borra/);
});

test("the animal editor cannot overwrite a number that already has history", () => {
  assert.match(animalRepository, /existing\.animal\.tag !== animal\.tag/);
  assert.match(animalRepository, /eq\(livestockAnimalIdentifiers\.sourceSystem, "manual"\)/);
  assert.match(animalRepository, /eq\(livestockAnimalIdentifiers\.kind, "tag"\)/);
  assert.match(animalRepository, /RENUMBER_REQUIRED/);
});

function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(name, migrationDirectory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return db;
}

function seedHerd(db) {
  const now = "2026-07-01T00:00:00Z";
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)")
    .run(ORGANIZATION_ID, "Agrícola de prueba", now);
  db.prepare("INSERT INTO fields (id, organization_id, name, is_demo, created_at) VALUES (?, ?, ?, 0, ?)")
    .run(FIELD_ID, ORGANIZATION_ID, "Fundo de prueba", now);
  db.prepare(`
    INSERT INTO livestock_lots (id, field_id, name, category, animal_count, entry_date, tracking_mode, created_at, updated_at)
    VALUES (?, ?, ?, 'vacas', 0, ?, 'individual', ?, ?)
  `).run(LOT_ID, FIELD_ID, "Lote lechero", "2026-07-01", now, now);
  insertAnimal(db, ANIMAL_ID, "954.123");
}

function insertAnimal(db, id, tag) {
  const now = "2026-07-01T00:00:00Z";
  db.prepare(`
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status, notes, source, created_at, updated_at)
    VALUES (?, ?, ?, 'female', 'active', '', 'Registro manual', ?, ?)
  `).run(id, LOT_ID, tag, now, now);
}

function planDefaults({ previousTag, newTag, effectiveOn }) {
  return {
    animalId: ANIMAL_ID,
    fieldId: FIELD_ID,
    organizationId: ORGANIZATION_ID,
    fieldIds: [FIELD_ID],
    previousTag,
    previousNormalizedTag: normalizeAnimalTag(previousTag),
    newTag,
    newNormalizedTag: normalizeAnimalTag(newTag),
    effectiveOn,
    reason: "Crotal perdido",
    actor: ACTOR,
    now: `${effectiveOn}T12:00:00Z`,
    historyIdentifierId: `identifier-history-${newTag}`,
    activeIdentifierId: `identifier-active-${newTag}`,
    auditId: `audit-${newTag}`,
  };
}

function renumberPlan(values) {
  return buildAnimalRenumberPlan(planDefaults(values));
}

function runPlan(db, plan) {
  db.exec("BEGIN");
  try {
    for (const statement of plan) db.prepare(statement.sql).run(...statement.bindings);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function currentTag(db) {
  return db.prepare("SELECT tag FROM livestock_animals WHERE id = ?").get(ANIMAL_ID).tag;
}

function identifierHistory(db) {
  return db.prepare(`
    SELECT value, normalized_value, valid_from, valid_to, is_primary
    FROM livestock_animal_identifiers
    WHERE animal_id = ? AND source_system = 'manual' AND kind = 'tag'
    ORDER BY COALESCE(valid_to, '9999-12-31'), value
  `).all(ANIMAL_ID).map((row) => ({ ...row }));
}

function activeIdentifierCount(db) {
  return db.prepare(`
    SELECT COUNT(*) AS total FROM livestock_animal_identifiers
    WHERE animal_id = ? AND source_system = 'manual' AND kind = 'tag' AND valid_to IS NULL
  `).get(ANIMAL_ID).total;
}
