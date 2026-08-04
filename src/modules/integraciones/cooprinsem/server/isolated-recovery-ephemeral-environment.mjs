import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  copyFile,
  open,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  createAuthenticatedIsolatedRecoveryWorkspace,
  destroyAuthenticatedIsolatedRecoveryWorkspace,
} from "./isolated-recovery-orphan-reaper.mjs";
import { createIsolatedMemoryObjectStore } from "./isolated-recovery-processor.mjs";
import { ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS } from "./isolated-recovery-workspace-keyring.mjs";

export const EPHEMERAL_ENVIRONMENT_MANIFEST_FORMAT =
  "fundosmart.isolated-recovery-environment-manifest.v1";
export const EPHEMERAL_ENVIRONMENT_RECEIPT_FORMAT =
  "fundosmart.isolated-recovery-environment-destruction.v1";

const OPERATOR_CAPABILITY = "execute_isolated_recovery";
const MAX_OPERATOR_TTL_MS = ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export class IsolatedRecoveryEnvironmentExecutionError extends Error {
  constructor(receipt) {
    super("La ejecución del entorno efímero falló y sus recursos fueron destruidos.");
    this.name = "IsolatedRecoveryEnvironmentExecutionError";
    this.code = "isolated_environment_execution_failed";
    this.receipt = receipt;
  }
}

export class IsolatedRecoveryEnvironmentCleanupError extends Error {
  constructor(receipt) {
    super("La destrucción verificable del entorno efímero no pudo completarse.");
    this.name = "IsolatedRecoveryEnvironmentCleanupError";
    this.code = "isolated_environment_cleanup_failed";
    this.receipt = receipt;
  }
}

export async function runInIsolatedRecoveryEphemeralEnvironment(input, execute) {
  assertGuard(input?.guard);
  const runtimeGuard = Object.freeze({
    target: "isolated_sqlite_memory",
    productWritesEnabled: false,
  });
  if (typeof execute !== "function") throw new Error("execute debe ser una función local.");
  const recoveryJobId = requiredText(input?.recoveryJobId, "recoveryJobId");
  const expectedSourceDatabaseSha256 = validSha256(
    input?.expectedSourceDatabaseSha256,
    "expectedSourceDatabaseSha256",
  );
  const createdAt = new Date().toISOString();
  const operator = normalizeOperator(input?.operator, createdAt);
  const workspaceKeyring = input?.workspaceKeyring;
  const sourceDatabasePath = await canonicalSourceDatabasePath(input?.sourceDatabasePath);
  await assertClosedSourceDatabase(sourceDatabasePath);
  const sourceDatabaseSha256 = await sha256File(sourceDatabasePath);
  if (sourceDatabaseSha256 !== expectedSourceDatabaseSha256) {
    throw new Error("La huella del SQLite de origen no coincide con el manifiesto.");
  }

  const environmentId = randomUUID();
  const manifest = Object.freeze({
    format: EPHEMERAL_ENVIRONMENT_MANIFEST_FORMAT,
    target: "isolated_sqlite_file_clone",
    sourceDatabaseSha256,
    recoveryJobSha256: sha256Text(recoveryJobId),
    operatorAttestationSha256: sha256Text(JSON.stringify(operator)),
    objectNamespaceSha256: sha256Text(environmentId),
    schemaContract: "fundosmart.isolated-recovery-schema.v2",
    createdAt,
    expiresAt: operator.expiresAt,
    productWritesEnabled: false,
    remoteWrites: false,
  });
  const manifestSha256 = sha256Text(JSON.stringify(manifest));

  let workspacePath = null;
  let workspaceRootPath = null;
  let database = null;
  let objectStore = null;
  let result;
  let executionFailed = false;
  let objectCountDestroyed = 0;
  let localArtifactCountDestroyed = 0;
  const cleanupIssues = [];

  try {
    const workspace = await createAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath: input?.workspaceRootPath,
      workspaceKeyring,
      workspaceId: environmentId,
      manifestSha256,
      createdAt,
      expiresAt: operator.expiresAt,
    });
    workspacePath = workspace.workspacePath;
    workspaceRootPath = workspace.workspaceRootPath;
    const clonePath = path.join(workspacePath, "recovery.sqlite");
    await copyFile(sourceDatabasePath, clonePath, fsConstants.COPYFILE_EXCL);
    if (await sha256File(clonePath) !== sourceDatabaseSha256) {
      throw new Error("La copia SQLite efímera no conserva la huella de origen.");
    }
    database = new DatabaseSync(path.toNamespacedPath(clonePath));
    database.exec("PRAGMA foreign_keys = ON");
    assertRecoveryClone(database, recoveryJobId);
    objectStore = Object.freeze(createIsolatedMemoryObjectStore());
    result = await execute(Object.freeze({
      database,
      objectStore,
      manifest,
      localWorkspacePath: workspacePath,
      guard: runtimeGuard,
    }));
  } catch {
    executionFailed = true;
  }

  if (database) {
    try {
      database.close();
    } catch {
      cleanupIssues.push("database_close_failed");
    }
  }
  if (objectStore) {
    try {
      const keys = objectStore.keys();
      for (const key of keys) await objectStore.delete(key);
      if (objectStore.keys().length !== 0) {
        cleanupIssues.push("object_store_not_empty");
      } else {
        objectCountDestroyed = keys.length;
      }
    } catch {
      cleanupIssues.push("object_store_cleanup_failed");
    }
  }
  if (workspacePath) {
    try {
      const destroyed = await destroyAuthenticatedIsolatedRecoveryWorkspace({
        workspaceRootPath,
        workspacePath,
        workspaceKeyring,
      });
      localArtifactCountDestroyed = destroyed.localArtifactCountDestroyed;
    } catch {
      cleanupIssues.push("workspace_cleanup_failed");
    }
  }

  let sourceDatabaseUnchanged = false;
  try {
    sourceDatabaseUnchanged = await sha256File(sourceDatabasePath) === sourceDatabaseSha256;
  } catch {
    cleanupIssues.push("source_revalidation_failed");
  }
  if (!sourceDatabaseUnchanged) cleanupIssues.push("source_database_changed");
  let destructionVerified = workspacePath === null;
  if (workspacePath !== null) {
    try {
      destructionVerified = !(await pathExists(workspacePath));
    } catch {
      cleanupIssues.push("workspace_revalidation_failed");
    }
  }
  if (!destructionVerified) cleanupIssues.push("workspace_still_present");
  const cleanupFailed = cleanupIssues.length > 0;
  const receipt = Object.freeze({
    format: EPHEMERAL_ENVIRONMENT_RECEIPT_FORMAT,
    manifestSha256,
    outcome: cleanupFailed ? "cleanup_failed" : executionFailed ? "failed" : "succeeded",
    objectCountDestroyed,
    localArtifactCountDestroyed,
    sourceDatabaseUnchanged,
    destructionVerified,
    destroyedAt: new Date().toISOString(),
    productWritesEnabled: false,
    remoteWrites: false,
  });

  if (cleanupFailed) throw new IsolatedRecoveryEnvironmentCleanupError(receipt);
  if (executionFailed) throw new IsolatedRecoveryEnvironmentExecutionError(receipt);
  return { manifest, result, receipt };
}

function assertRecoveryClone(database, recoveryJobId) {
  const quickCheck = database.prepare("PRAGMA quick_check").all();
  if (quickCheck.length !== 1 || Object.values(quickCheck[0])[0] !== "ok") {
    throw new Error("El SQLite efímero no supera quick_check.");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("El SQLite efímero contiene referencias inválidas.");
  }
  const eventColumns = new Set(database.prepare("PRAGMA table_info(restore_recovery_events)")
    .all()
    .map((row) => String(row.name)));
  for (const column of ["evidence_version", "pre_restore_backup_sha256", "post_restore_sha256"]) {
    if (!eventColumns.has(column)) throw new Error("El SQLite efímero no cumple el esquema de evidencia v2.");
  }
  const triggers = new Set(database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger' AND tbl_name = 'restore_recovery_events'
  `).all().map((row) => String(row.name)));
  if (!triggers.has("restore_recovery_events_no_update")
    || !triggers.has("restore_recovery_events_no_delete")) {
    throw new Error("El SQLite efímero no conserva el diario append-only.");
  }
  const job = database.prepare(`
    SELECT execution_enabled FROM restore_recovery_jobs WHERE id = ?
  `).get(recoveryJobId);
  if (!job) throw new Error("El trabajo de recuperación no existe en el clon efímero.");
  if (Number(job.execution_enabled) !== 0) {
    throw new Error("El trabajo del clon efímero debe conservar execution_enabled = 0.");
  }
}

function normalizeOperator(value, now) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("La atestación del operador es obligatoria.");
  }
  const operatorId = requiredText(value.operatorId, "operator.operatorId");
  if (!/^[a-z0-9][a-z0-9:_-]{2,63}$/.test(operatorId)) {
    throw new Error("operator.operatorId debe ser un identificador técnico acotado.");
  }
  if (value.capability !== OPERATOR_CAPABILITY) {
    throw new Error(`La capacidad del operador debe ser ${OPERATOR_CAPABILITY}.`);
  }
  const issuedAt = canonicalIso(value.issuedAt, "operator.issuedAt");
  const expiresAt = canonicalIso(value.expiresAt, "operator.expiresAt");
  const issuedMs = Date.parse(issuedAt);
  const expiresMs = Date.parse(expiresAt);
  const nowMs = Date.parse(now);
  if (expiresMs <= issuedMs || expiresMs - issuedMs > MAX_OPERATOR_TTL_MS) {
    throw new Error("La atestación del operador debe durar como máximo una hora.");
  }
  if (nowMs < issuedMs || nowMs >= expiresMs) {
    throw new Error("La atestación del operador no está vigente.");
  }
  return { operatorId, capability: OPERATOR_CAPABILITY, issuedAt, expiresAt };
}

async function canonicalSourceDatabasePath(value) {
  const sourcePath = path.resolve(requiredText(value, "sourceDatabasePath"));
  const info = await stat(sourcePath);
  if (!info.isFile()) throw new Error("sourceDatabasePath debe apuntar a un archivo SQLite cerrado.");
  return realpath(sourcePath);
}

async function assertClosedSourceDatabase(sourcePath) {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    if (await pathExists(`${sourcePath}${suffix}`)) {
      throw new Error("El SQLite de origen debe estar cerrado y sin sidecars pendientes.");
    }
  }
}

async function sha256File(filePath) {
  const handle = await open(filePath, "r");
  const hash = createHash("sha256");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(new Uint8Array(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validSha256(value, name) {
  const text = String(value ?? "");
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser SHA-256 hexadecimal.`);
  return text;
}

function canonicalIso(value, name) {
  const text = requiredText(value, name);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${name} debe ser una fecha ISO canónica.`);
  }
  return text;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertGuard(guard) {
  if (guard?.target !== "isolated_sqlite_memory" || guard?.productWritesEnabled !== false) {
    throw new Error("El entorno efímero solo admite recuperación SQLite aislada y apagada.");
  }
}
