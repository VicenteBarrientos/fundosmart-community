import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  INTEGRITY_SWEEP_MAX_BYTES,
  selectIntegritySweepBatch,
  summarizeIntegritySweepResults,
} from "../src/modules/integraciones/cooprinsem/server/integrity-sweep-rules.mjs";

const migration = readFileSync(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/integrity-sweep-repository.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/conservacion-programada/route.ts", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
const vite = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");

test("selecciona un lote acotado por archivos y bytes sin bloquear originales grandes", () => {
  const mib = 1024 * 1024;
  const candidates = [
    { id: "a", fileSizeBytes: 12 * mib },
    { id: "b", fileSizeBytes: 11 * mib },
    { id: "c", fileSizeBytes: 2 * mib },
  ];
  const first = selectIntegritySweepBatch(candidates);
  assert.deepEqual(first.selected.map((entry) => entry.id), ["a", "b"]);
  assert.equal(first.reservedBytes, 23 * mib);
  assert.equal(first.hasMore, true);
  assert.equal(first.reservedBytes <= INTEGRITY_SWEEP_MAX_BYTES, true);

  const oversized = selectIntegritySweepBatch([{ id: "legacy", fileSizeBytes: 30 * mib }]);
  assert.equal(oversized.selected[0].id, "legacy");
  assert.equal(oversized.reservedBytes, 0);
  assert.equal(oversized.hasMore, false);
});

test("resume totales de salud, faltantes, diferencias y bytes", () => {
  assert.deepEqual(summarizeIntegritySweepResults([
    { status: "healthy", readBytes: 100 },
    { status: "missing", readBytes: 0 },
    { status: "content_mismatch", readBytes: 80 },
  ]), {
    processedCount: 3,
    healthyCount: 1,
    missingCount: 1,
    mismatchCount: 1,
    issueCount: 2,
    readBytes: 180,
  });
});

test("la migración persiste progreso e incidentes con restricciones", () => {
  assert.match(migration, /CREATE TABLE `original_integrity_sweep_states`/);
  assert.match(migration, /CREATE TABLE `original_integrity_incidents`/);
  assert.match(migration, /original_integrity_incidents_import_unique/);
  assert.match(migration, /original_integrity_sweep_status_check/);
  assert.doesNotMatch(migration, /^(?:DROP|DELETE|ALTER)\b/im);

  const db = migratedDatabase();
  db.exec("INSERT INTO organizations (id, name) VALUES ('org-test', 'Organización')");
  db.exec("INSERT INTO fields (id, organization_id, name) VALUES ('field-test', 'org-test', 'Fundo')");
  db.exec("INSERT INTO original_integrity_sweep_states (field_id, organization_id, cycle_id) VALUES ('field-test', 'org-test', 'cycle-1')");
  assert.throws(() => db.exec("UPDATE original_integrity_sweep_states SET status = 'unknown' WHERE field_id = 'field-test'"), /CHECK constraint failed/);
  db.exec(`INSERT INTO import_jobs (
    id, organization_id, field_id, source_format, source_table, original_filename,
    file_size_bytes, object_key, sha256, mapping_version, requested_by
  ) VALUES (
    'job-test', 'org-test', 'field-test', 'dbf', '_Traspasos.DBF', 'origen.dbf',
    10, 'private/key', '${"a".repeat(64)}', 'test', 'owner@example.com'
  )`);
  db.exec(`INSERT INTO original_integrity_incidents (
    id, organization_id, field_id, import_job_id, issue_type, summary,
    expected_size_bytes, expected_sha256, first_detected_at, last_detected_at, updated_at
  ) VALUES (
    'incident-1', 'org-test', 'field-test', 'job-test', 'missing', 'Falta',
    10, '${"a".repeat(64)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )`);
  assert.throws(() => db.exec(`INSERT INTO original_integrity_incidents (
    id, organization_id, field_id, import_job_id, issue_type, summary,
    expected_size_bytes, expected_sha256, first_detected_at, last_detected_at, updated_at
  ) VALUES (
    'incident-2', 'org-test', 'field-test', 'job-test', 'missing', 'Duplicado',
    10, '${"a".repeat(64)}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
  )`), /UNIQUE constraint failed/);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("el ejecutor usa cursor, lease, presupuesto, incidentes idempotentes y reintento", () => {
  assert.match(repository, /LEASE_MILLISECONDS/);
  assert.match(repository, /leaseAvailable/);
  assert.match(repository, /cursorCreatedAt[\s\S]+cursorImportJobId/);
  assert.match(repository, /selectIntegritySweepBatch\(candidates\)/);
  assert.match(repository, /readImportFile\(candidate\.objectKey\)/);
  assert.match(repository, /sha256Hex\(bytes\)/);
  assert.match(repository, /ON CONFLICT\(import_job_id\) DO UPDATE SET/);
  assert.match(repository, /SET status = 'resolved'/);
  assert.match(repository, /'import\.originals\.sweep\.batch', 'field'/);
  assert.match(repository, /RETRY_MILLISECONDS/);
  assert.match(repository, /IntegritySweepFieldAccess/);
  assert.match(repository, /IntegritySweepScopeError/);
  assert.match(repository, /currentFieldGuard\(input\.fieldId, scope\.organizationId, access\)/);
  assert.match(repository, /candidateSnapshotJson/);
  assert.match(repository, /current_job\.organization_id = sweep\.organization_id/);
  assert.match(repository, /guardedIncidentStatement/);
  assert.match(repository, /abs\(-9223372036854775807 - 1\)/);
  assert.match(repository, /lease_token = NULL/);
  assert.doesNotMatch(repository.match(/getOriginalIntegritySweepDashboard[\s\S]+?^}/m)?.[0] ?? "", /objectKey/);
});

test("la ejecución programada y manual excluye disparos previos a autenticación", () => {
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireContextField\(access, fieldId\)/);
  assert.match(route, /actorEmail: access\.email/);
  assert.match(route, /fieldIds: access\.fieldIds/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /organizationId: access\.organizationId/);
  assert.match(route, /access: repositoryAccess/);
  assert.match(route, /IntegritySweepScopeError/);
  assert.match(route, /status: 409/);
  assert.match(route, /action !== "run_next_batch"/);
  assert.match(route, /trigger: "manual"/);
  assert.match(worker, /scheduled\(_controller: ScheduledController/);
  assert.match(worker, /trigger: "scheduled"/);
  assert.match(repository, /runDueOriginalIntegritySweep\(input: \{\s+trigger: "scheduled";/);
  assert.doesNotMatch(worker, /request_heartbeat|nextIntegrityHeartbeatAt/);
  assert.doesNotMatch(worker, /url\.pathname === "\/integraciones\/cooprinsem"/);
  assert.match(vite, /crons: \["17 \*\/6 \* \* \*"\]/);
  assert.match(page, /Cobertura reanudable/);
  assert.match(page, /Procesar siguiente lote/);
  assert.match(page, /Incidentes activos/);
});

function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = path.join(process.cwd(), "drizzle");
  for (const name of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(migrationDirectory, name), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return db;
}
