import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, FUNDOSMART_BACKUP_FORMAT, sha256Hex } from "../src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import { applyInsertOnlyRestoreSimulation } from "../src/modules/integraciones/cooprinsem/server/isolated-restore-writer.mjs";
import {
  buildRestoreActorAccess,
  buildRestoreConfirmationBinding,
  isRestorePlanConfirmable,
  restorePlanSha256,
  restoreSnapshotSha256,
  restoreConfirmationTokenSha256,
  validateRestoreConfirmation,
} from "../src/modules/integraciones/cooprinsem/server/restore-confirmation-rules.mjs";
import { buildPortableRestorePlan, validatePortableBackup } from "../src/modules/integraciones/cooprinsem/server/restore-rules.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };

test("la confirmacion vincula actor, alcance, archivo, snapshot y plan, y expira", async () => {
  const backup = await sampleBackup();
  const plan = buildPortableRestorePlan(await validatePortableBackup(backup), {});
  assert.equal(isRestorePlanConfirmable(plan), true);
  const binding = buildRestoreConfirmationBinding({
    actorEmail: " Owner@Example.com ",
    organizationId: "org-fundosmart",
    fieldId: "field-restore",
    backupSha256: "a".repeat(64),
    snapshotSha256: "b".repeat(64),
    planSha256: await restorePlanSha256(plan),
  });
  const record = { ...binding, status: "active", expiresAt: "2026-07-18T05:15:00.000Z" };
  assert.deepEqual(validateRestoreConfirmation(record, binding, "2026-07-18T05:00:00.000Z"), { valid: true, code: "valid" });
  assert.equal(validateRestoreConfirmation(record, { ...binding, snapshotSha256: "c".repeat(64) }, "2026-07-18T05:00:00.000Z").code, "stale_binding");
  assert.equal(validateRestoreConfirmation(record, binding, "2026-07-18T05:15:00.000Z").code, "expired");
  assert.equal(validateRestoreConfirmation({ ...record, status: "consumed" }, binding, "2026-07-18T05:00:00.000Z").code, "consumed");
  assert.deepEqual(buildRestoreActorAccess({
    membershipId: "member-owner",
    email: " Owner@Example.com ",
    fieldIds: ["field-restore", "field-restore"],
  }, binding.actorEmail), {
    membershipId: "member-owner",
    email: "owner@example.com",
    fieldIds: ["field-restore"],
  });
  assert.equal(buildRestoreActorAccess({
    membershipId: "member-other",
    email: "other@example.com",
    fieldIds: ["field-restore"],
  }, binding.actorEmail), null);
  assert.equal(buildRestoreActorAccess({
    membershipId: "member-demo",
    email: "demo@fundosmart.local",
    fieldIds: ["field-restore"],
  }, "demo@fundosmart.local"), null);
  assert.notEqual(
    await restoreConfirmationTokenSha256("same-token", "member-owner"),
    await restoreConfirmationTokenSha256("same-token", "member-replacement"),
  );
});

test("el snapshot ignora solo la auditoria interna que genera el propio ensayo", async () => {
  const base = { fields: [{ id: "field-1", name: "Fundo" }], auditLog: [] };
  const expected = await restoreSnapshotSha256(base);
  const withInternalEvents = {
    ...base,
    auditLog: [
      { id: "preview", action: "backup.restore.previewed" },
      { id: "confirmation", action: "backup.restore.confirmation_issued" },
      { id: "prepared", action: "backup.restore.recovery_prepared" },
    ],
  };
  assert.equal(await restoreSnapshotSha256(withInternalEvents), expected);
  assert.notEqual(await restoreSnapshotSha256({
    ...withInternalEvents,
    auditLog: [...withInternalEvents.auditLog, { id: "finance", action: "finance.expense.created" }],
  }), expected);
  assert.notEqual(await restoreSnapshotSha256({ ...base, fields: [{ id: "field-1", name: "Fundo cambiado" }] }), expected);
});

test("el escritor insert-only restaura un plan real solo en SQLite aislado", async () => {
  const db = await isolatedDatabase();
  const backup = await sampleBackup();
  const validated = await validatePortableBackup(backup);
  const plan = buildPortableRestorePlan(validated, {});
  const result = applyInsertOnlyRestoreSimulation(db, { backup: validated, currentData: {}, plan, guard });
  assert.equal(result.insertedRowCount, 3);
  assert.equal(result.productWritesEnabled, false);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fields WHERE id = 'field-restore'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM livestock_lots WHERE id = 'lot-restore'").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM livestock_animals WHERE id = 'animal-restore'").get().count, 1);
  db.close();
});

test("el escritor aislado rechaza otro destino y revierte el lote completo ante drift de esquema", async () => {
  const backup = await sampleBackup();
  const validated = await validatePortableBackup(backup);
  const plan = buildPortableRestorePlan(validated, {});
  const db = await isolatedDatabase();
  assert.throws(() => applyInsertOnlyRestoreSimulation(db, {
    backup: validated,
    currentData: {},
    plan,
    guard: { target: "production_d1", productWritesEnabled: false },
  }), /solo admite SQLite aislado/);
  backup.data.livestockAnimals[0].unknown_column = "drift";
  assert.throws(() => applyInsertOnlyRestoreSimulation(db, { backup, currentData: {}, plan, guard }), /columnas ajenas/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM fields WHERE id = 'field-restore'").get().count, 0);
  db.close();
});

test("D1 persiste solo la huella del secreto y la ruta productiva no importa el escritor aislado", async () => {
  const migration = await readFile(path.join(root, "drizzle", "0000_public_schema.sql"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const repository = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "restore-confirmation-repository.ts"), "utf8");
  assert.match(migration, /token_sha256/);
  assert.doesNotMatch(migration, /`token`\s+text/);
  assert.match(migration, /status.*active.*consumed.*expired.*revoked/s);
  assert.doesNotMatch(route, /isolated-restore-writer/);
  assert.doesNotMatch(route, /consumeRestoreConfirmation/);
  assert.match(route, /issueRestoreConfirmation\(\{ \.\.\.binding, \.\.\.repositoryAccess \}\)/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /email: access\.email/);
  assert.match(route, /RestoreConfirmationScopeError/);
  assert.match(repository, /client\.batch\(\[revoke, insertToken, insertAudit, assertComplete\]\)/);
  assert.match(repository, /json_each/);
  assert.match(repository, /current_actor\.id = \?/);
  assert.match(repository, /current_actor\.role IN \('owner', 'admin'\)/);
  assert.match(repository, /restoreConfirmationTokenSha256\(token, access\.membershipId\)/);
  assert.match(repository, /THEN 1 ELSE abs\(-9223372036854775807 - 1\) END AS complete/);
});

async function isolatedDatabase() {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = path.join(root, "drizzle");
  for (const name of (await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql").sort()) {
    db.exec((await readFile(path.join(migrationDirectory, name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON; INSERT INTO organizations (id, name) VALUES ('org-fundosmart', 'FundoSmart');");
  return db;
}

async function sampleBackup() {
  const data = {
    fields: [{ id: "field-restore", organization_id: "org-fundosmart", name: "Fundo restaurado", location: "Osorno", is_demo: 0, area_hectares: 80, coordinates: [] }],
    livestockLots: [{ id: "lot-restore", field_id: "field-restore", paddock_id: null, name: "Lote restaurado", category: "dairy_cow", animal_count: 1, average_weight_kg: 520, entry_date: "2026-01-01", status: "active", tracking_mode: "individual" }],
    livestockAnimals: [{ id: "animal-restore", lot_id: "lot-restore", tag: "RP-9001", sex: "female", status: "active", source: "Respaldo portable" }],
  };
  const entries = Object.entries(data);
  return {
    manifest: {
      format: FUNDOSMART_BACKUP_FORMAT,
      generatedAt: "2026-07-18T05:00:00.000Z",
      generatedBy: "owner@example.com",
      encoding: "UTF-8 JSON",
      scope: { type: "field", id: "field-restore", name: "Fundo restaurado", organizationId: "org-fundosmart", organizationName: "FundoSmart", fieldId: "field-restore", fieldName: "Fundo restaurado" },
      recordCounts: Object.fromEntries(entries.map(([section, rows]) => [section, rows.length])),
      sectionSha256: Object.fromEntries(await Promise.all(entries.map(async ([section, rows]) => [section, await sha256Hex(canonicalJson(rows))]))),
      originalFiles: [],
      excluded: [],
    },
    data,
  };
}
