const ACTIVE_STATUSES_SQL = "'prepared', 'copying', 'applying', 'verifying', 'compensating'";
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60 * 1_000;

export function claimIsolatedRecoveryLease(database, input) {
  assertGuard(input?.guard);
  const values = leaseInput(input);
  const result = database.prepare(`
    UPDATE restore_recovery_jobs
    SET lease_token = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
    WHERE id = ? AND execution_enabled = 0
      AND status IN (${ACTIVE_STATUSES_SQL})
      AND (lease_token IS NULL OR lease_expires_at <= ?)
  `).run(values.leaseToken, values.expiresAt, values.now, values.jobId, values.now);
  return leaseResult(database, values.jobId, Number(result.changes) === 1, "claim");
}

export function renewIsolatedRecoveryLease(database, input) {
  assertGuard(input?.guard);
  const values = leaseInput(input);
  const result = database.prepare(`
    UPDATE restore_recovery_jobs
    SET lease_expires_at = ?, updated_at = ?
    WHERE id = ? AND execution_enabled = 0
      AND status IN (${ACTIVE_STATUSES_SQL})
      AND lease_token = ? AND lease_expires_at > ?
  `).run(values.expiresAt, values.now, values.jobId, values.leaseToken, values.now);
  return leaseResult(database, values.jobId, Number(result.changes) === 1, "renew");
}

export function releaseIsolatedRecoveryLease(database, input) {
  assertGuard(input?.guard);
  const jobId = requiredText(input.jobId, "jobId");
  const leaseToken = requiredText(input.leaseToken, "leaseToken");
  const now = validNow(input.now);
  const result = database.prepare(`
    UPDATE restore_recovery_jobs
    SET lease_token = NULL, lease_expires_at = NULL, updated_at = ?
    WHERE id = ? AND execution_enabled = 0
      AND status IN (${ACTIVE_STATUSES_SQL})
      AND lease_token = ? AND lease_expires_at > ?
  `).run(now, jobId, leaseToken, now);
  return leaseResult(database, jobId, Number(result.changes) === 1, "release");
}

export function readIsolatedRecoveryCheckpoint(database, input) {
  assertGuard(input?.guard);
  const jobId = requiredText(input.jobId, "jobId");
  const row = database.prepare(`
    SELECT id, status, execution_enabled, attempt_count, lease_token, lease_expires_at,
      object_cursor_import_job_id, copied_object_count,
      compensation_cursor_import_job_id, compensated_object_count,
      applied_row_count, verified_row_count,
      expected_row_count, updated_at
    FROM restore_recovery_jobs WHERE id = ?
  `).get(jobId);
  if (!row) return null;
  return {
    jobId: String(row.id),
    status: String(row.status),
    executionEnabled: Boolean(row.execution_enabled),
    attemptCount: Number(row.attempt_count),
    leaseToken: row.lease_token == null ? null : String(row.lease_token),
    leaseExpiresAt: row.lease_expires_at == null ? null : String(row.lease_expires_at),
    objectCursorImportJobId: row.object_cursor_import_job_id == null ? null : String(row.object_cursor_import_job_id),
    copiedObjectCount: Number(row.copied_object_count),
    compensationCursorImportJobId: row.compensation_cursor_import_job_id == null ? null : String(row.compensation_cursor_import_job_id),
    compensatedObjectCount: Number(row.compensated_object_count),
    appliedRowCount: Number(row.applied_row_count),
    verifiedRowCount: Number(row.verified_row_count),
    expectedRowCount: Number(row.expected_row_count),
    updatedAt: String(row.updated_at),
    productWritesEnabled: false,
  };
}

function leaseResult(database, jobId, changed, operation) {
  return {
    operation,
    changed,
    checkpoint: readIsolatedRecoveryCheckpoint(database, {
      jobId,
      guard: { target: "isolated_sqlite_memory", productWritesEnabled: false },
    }),
    productWritesEnabled: false,
  };
}

function leaseInput(input) {
  const jobId = requiredText(input.jobId, "jobId");
  const leaseToken = requiredText(input.leaseToken, "leaseToken");
  const now = validNow(input.now);
  const ttlMs = Number(input.ttlMs);
  if (!Number.isInteger(ttlMs) || ttlMs < MIN_LEASE_MS || ttlMs > MAX_LEASE_MS) {
    throw new Error("El lease aislado requiere un TTL entre 1 segundo y 5 minutos.");
  }
  return { jobId, leaseToken, now, expiresAt: new Date(Date.parse(now) + ttlMs).toISOString() };
}

function validNow(value) {
  const now = requiredText(value, "now");
  if (!Number.isFinite(Date.parse(now))) throw new Error("now debe ser una fecha ISO valida.");
  return now;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El simulador de lease solo admite SQLite aislado con escrituras productivas deshabilitadas.");
  }
}
