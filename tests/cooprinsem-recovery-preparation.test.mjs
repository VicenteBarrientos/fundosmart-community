import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  matchesRestorePreparationPhrase,
  restorePreparationPhrase,
} from "../src/modules/integraciones/cooprinsem/domain/restore-challenge.mjs";
import {
  buildRecoveryPreparationStatements,
  recoveryPreparationMatches,
} from "../src/modules/integraciones/cooprinsem/server/recovery-job-preparation.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";

const root = process.cwd();
const NOW = "2026-07-18T08:30:00.000Z";
const TOKEN_HASH = "a".repeat(64);
const BACKUP_HASH = "b".repeat(64);
const SNAPSHOT_HASH = "c".repeat(64);
const PLAN_HASH = "d".repeat(64);
const RESTORE_ACCESS = { membershipId: "member-owner", email: "owner@example.com" };

test("prepara trabajo, objetos, consumo y auditoria en una sola transaccion", async () => {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const spec = recoverySpec();
  executeTransactionalBatch(db, productionPreparationStatements(spec));

  const confirmation = db.prepare("SELECT status, consumed_at FROM restore_confirmation_tokens WHERE id = 'confirmation-1'").get();
  const job = db.prepare("SELECT * FROM restore_recovery_jobs WHERE confirmation_token_id = 'confirmation-1'").get();
  const objects = db.prepare("SELECT * FROM restore_recovery_objects WHERE recovery_job_id = ? ORDER BY sequence_number").all(job.id);
  const audit = db.prepare("SELECT action, after FROM audit_log WHERE entity_id = ?").get(job.id);
  assert.deepEqual({ ...confirmation }, { status: "consumed", consumed_at: NOW });
  assert.equal(job.status, "prepared");
  assert.equal(job.execution_enabled, 0);
  assert.deepEqual(objects.map((object) => [object.import_job_id, object.sequence_number, object.status]), [
    ["import-1", 0, "pending"],
    ["import-2", 1, "pending"],
  ]);
  assert.equal(audit.action, "backup.restore.recovery_prepared");
  assert.deepEqual(JSON.parse(audit.after), {
    backupSha256: BACKUP_HASH,
    snapshotSha256: SNAPSHOT_HASH,
    planSha256: PLAN_HASH,
    expectedRowCount: 42,
    originalFileCount: 2,
    status: "prepared",
    executionEnabled: false,
  });
  assert.doesNotMatch(audit.after, /objectKey|destination|exception/i);
  assert.equal(recoveryPreparationMatches(camelJob(job), objects.map(camelObject), spec), true);
  db.close();
});

test("cada statement mantiene exactamente sus bindings", () => {
  const statements = productionPreparationStatements();
  for (const statement of statements) {
    assert.equal((statement.sql.match(/\?/g) ?? []).length, statement.params.length, statement.name);
  }
});

test("una confirmacion expirada o con binding distinto no produce efectos parciales", async () => {
  for (const variant of ["expired", "stale"]) {
    const db = await migratedDatabase();
    seedConfirmation(db, variant === "expired" ? "2026-07-18T08:29:59.000Z" : "2026-07-18T08:45:00.000Z");
    const spec = recoverySpec(variant === "stale" ? { planSha256: "e".repeat(64) } : {});
    executeTransactionalBatch(db, productionPreparationStatements(spec));
    assert.equal(db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-1'").get().status, "active");
    assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_jobs").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_objects").get().count, 0);
    assert.equal(db.prepare("SELECT count(*) AS count FROM audit_log").get().count, 0);
    db.close();
  }
});

test("un fundo movido de organizacion no consume ni prepara el trabajo", async () => {
  const db = await migratedDatabase();
  seedConfirmation(db);
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-other', 'Other', ?)").run(NOW);
  db.prepare("UPDATE fields SET organization_id = 'org-other' WHERE id = 'field-1'").run();
  executeTransactionalBatch(db, productionPreparationStatements());
  assert.equal(db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-1'").get().status, "active");
  assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_jobs").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_objects").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM audit_log").get().count, 0);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("un fallo intermedio revierte tambien el consumo de la confirmacion", async () => {
  const db = await migratedDatabase();
  seedConfirmation(db);
  const statements = productionPreparationStatements();
  statements.splice(2, 0, { name: "forced_failure", sql: "INSERT INTO missing_recovery_table (id) VALUES (?)", params: ["fail"] });
  assert.throws(() => executeTransactionalBatch(db, statements), /missing_recovery_table/);
  assert.equal(db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-1'").get().status, "active");
  assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_jobs").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM restore_recovery_objects").get().count, 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM audit_log").get().count, 0);
  db.close();
});

test("la comprobacion idempotente rechaza otro plan o inventario", () => {
  const spec = recoverySpec();
  const existingJob = { ...spec.job, id: "job-created-first", preparedAt: "2026-07-18T08:29:00.000Z" };
  const existingObjects = spec.objects.map((object) => ({ ...object, id: `first:${object.sequenceNumber}`, recoveryJobId: existingJob.id }));
  assert.equal(recoveryPreparationMatches(existingJob, existingObjects, recoverySpec({ jobId: "job-retry" })), true);
  assert.equal(recoveryPreparationMatches(existingJob, existingObjects, recoverySpec({ jobId: "job-retry", expectedRowCount: 43 })), false);
  const changedInventory = recoverySpec({ jobId: "job-retry", secondObjectSha256: "0".repeat(64) });
  assert.equal(recoveryPreparationMatches(existingJob, existingObjects, changedInventory), false);
});

test("la frase de preparacion es exacta y conserva el nombre normalizado del fundo", () => {
  assert.equal(restorePreparationPhrase("  Fundo   Los Álamos "), "PREPARAR Fundo Los Álamos");
  assert.equal(matchesRestorePreparationPhrase("PREPARAR Fundo Los Álamos", "Fundo Los Álamos"), true);
  assert.equal(matchesRestorePreparationPhrase("preparar Fundo Los Álamos", "Fundo Los Álamos"), false);
  assert.equal(matchesRestorePreparationPhrase("PREPARAR Otro fundo", "Fundo Los Álamos"), false);
});

test("la ruta conecta la preparacion durable sin habilitar ejecucion ni R2", async () => {
  const repository = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "recovery-job-preparation-repository.ts"), "utf8");
  const statements = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "server", "recovery-job-preparation.mjs"), "utf8");
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const client = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "api", "import-client.ts"), "utf8");
  const page = await readFile(path.join(root, "src", "modules", "integraciones", "cooprinsem", "CooprinsemImportPage.tsx"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.match(repository, /client\.batch/);
  assert.match(repository, /validateRestoreConfirmation/);
  assert.match(repository, /loadConfirmation\(tokenSha256, binding, access\)/);
  assert.match(repository, /loadPreparedRecovery\(confirmation\.id, binding, access\)/);
  assert.match(repository, /buildRecoveryPreparationStatements\(candidate, tokenSha256, access\.fieldIds, access\)/);
  assert.match(repository, /executionEnabled: false/);
  assert.match(statements, /current_field\.organization_id = restore_confirmation_tokens\.organization_id/);
  assert.match(statements, /json_each/);
  assert.match(statements, /current_actor\.role IN \('owner', 'admin'\)/);
  assert.doesNotMatch(repository, /\.put\(|\.delete\(|planNextRecoveryAction|copy_original/);
  assert.match(route, /intent !== "prepare_recovery"/);
  assert.match(route, /prepareDurableRecoveryJob/);
  assert.match(route, /prepareDurableRecoveryJob\(\{[\s\S]*\.\.\.repositoryAccess/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /portableRestoreOriginalInventory/);
  assert.match(route, /matchesRestorePreparationPhrase/);
  assert.doesNotMatch(route, /planNextRecoveryAction|copy_original|FILES\.put|FILES\.delete/);
  assert.match(client, /preparePortableRecovery/);
  assert.match(page, /Confirmar ensayo durable/);
  assert.match(page, /ejecución deshabilitada/);
  assert.match(worker, /backup\.restore\.recovery_prepared/);
  assert.doesNotMatch(worker, /isolated_sqlite_memory|fundosmart\.recovery-rehearsal\.v1/);
});

async function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql").sort()) {
    db.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

function seedConfirmation(db, expiresAt = "2026-07-18T08:45:00.000Z") {
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)").run(NOW);
  db.prepare("INSERT INTO fields (id, organization_id, name, is_demo, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', 0, ?)").run(NOW);
  db.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    ) VALUES (?, 'org-fundosmart', ?, ?, 'Owner', 'owner', 'active', 'test', ?, ?)
  `).run(RESTORE_ACCESS.membershipId, RESTORE_ACCESS.email, RESTORE_ACCESS.email, NOW, NOW);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com', ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(TOKEN_HASH, BACKUP_HASH, SNAPSHOT_HASH, PLAN_HASH, expiresAt, NOW, NOW);
}

function productionPreparationStatements(spec = recoverySpec(), access = RESTORE_ACCESS) {
  return buildRecoveryPreparationStatements(spec, TOKEN_HASH, ["field-1"], access);
}

function recoverySpec(overrides = {}) {
  return prepareRecoveryJobSpec({
    jobId: overrides.jobId ?? "recovery-1",
    confirmationTokenId: "confirmation-1",
    binding: {
      actorEmail: "owner@example.com",
      organizationId: "org-fundosmart",
      fieldId: "field-1",
      backupSha256: BACKUP_HASH,
      snapshotSha256: SNAPSHOT_HASH,
      planSha256: overrides.planSha256 ?? PLAN_HASH,
    },
    originalFiles: [
      { importJobId: "import-1", sha256: "e".repeat(64), fileSizeBytes: 10 },
      { importJobId: "import-2", sha256: overrides.secondObjectSha256 ?? "f".repeat(64), fileSizeBytes: 20 },
    ],
    expectedRowCount: overrides.expectedRowCount ?? 42,
    now: NOW,
  });
}

function executeTransactionalBatch(db, statements) {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements) db.prepare(statement.sql).run(...statement.params);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw cause;
  }
}

function camelJob(row) {
  return {
    organizationId: row.organization_id,
    fieldId: row.field_id,
    confirmationTokenId: row.confirmation_token_id,
    actorEmail: row.actor_email,
    backupSha256: row.backup_sha256,
    snapshotSha256: row.snapshot_sha256,
    planSha256: row.plan_sha256,
    status: row.status,
    executionEnabled: Boolean(row.execution_enabled),
    expectedRowCount: row.expected_row_count,
    attemptCount: row.attempt_count,
    leaseToken: row.lease_token,
    leaseExpiresAt: row.lease_expires_at,
    objectCursorImportJobId: row.object_cursor_import_job_id,
    copiedObjectCount: row.copied_object_count,
    compensationCursorImportJobId: row.compensation_cursor_import_job_id,
    compensatedObjectCount: row.compensated_object_count,
    appliedRowCount: row.applied_row_count,
    verifiedRowCount: row.verified_row_count,
    preRestoreBackupObjectKey: row.pre_restore_backup_object_key,
    preRestoreBackupSha256: row.pre_restore_backup_sha256,
    postRestoreSha256: row.post_restore_sha256,
    failureCode: row.failure_code,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function camelObject(row) {
  return {
    importJobId: row.import_job_id,
    sequenceNumber: row.sequence_number,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
    destinationObjectKey: row.destination_object_key,
    wasPreexisting: Boolean(row.was_preexisting),
    attemptCount: row.attempt_count,
    lastErrorCode: row.last_error_code,
  };
}
