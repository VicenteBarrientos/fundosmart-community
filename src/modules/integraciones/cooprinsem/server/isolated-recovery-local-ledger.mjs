import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  chmod,
  lstat,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { canonicalJson } from "./backup-format.mjs";
import {
  ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
  ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT,
} from "./isolated-recovery-workspace-keyring.mjs";

export const ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT =
  "fundosmart.isolated-recovery-local-ledger.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_ANCHOR_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-anchor.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_ENTRY_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-entry.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_VERIFICATION_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-verification.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_APPEND_RECEIPT_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-append.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_INTENT_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-intent.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_RESULT_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-result.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_PENDING_FORMAT =
  "fundosmart.isolated-recovery-local-ledger-pending.v1";
export const ISOLATED_RECOVERY_LOCAL_LEDGER_FILE =
  ".fundosmart-isolated-recovery-ledger.sqlite3";

const ORPHAN_REAPER_RECEIPT_FORMAT = "fundosmart.isolated-recovery-orphan-reaper.v2";
const CLOSE_RECEIPT_FORMAT = "fundosmart.isolated-recovery-local-ledger-close.v1";
const GENESIS_FORMAT = "fundosmart.isolated-recovery-local-ledger-genesis.v1";
const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_ENTRY_COUNT = 100_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const KEY_ID_PATTERN = /^[a-z0-9][a-z0-9_]{2,31}$/;
const EVENT_KINDS = Object.freeze([
  "keyring_prune",
  "keyring_rotation",
  "workspace_sweep",
]);
const SWEEP_COUNT_KEYS = Object.freeze([
  "candidateWorkspaceCount",
  "authenticatedWorkspaceCount",
  "unauthenticatedWorkspaceCount",
  "markerMissingCount",
  "markerInvalidCount",
  "unknownKeyIdWorkspaceCount",
  "legacyWorkspaceCount",
  "unexpiredWorkspaceCount",
  "expiredWorkspaceCount",
  "liveWorkspaceCount",
  "destroyedWorkspaceCount",
  "failedWorkspaceCount",
  "localArtifactCountDestroyed",
]);
const ledgerState = new WeakMap();

const TRIGGER_SQL = Object.freeze({
  isolated_recovery_local_entries_insert_guard: `
    CREATE TRIGGER isolated_recovery_local_entries_insert_guard
    BEFORE INSERT ON isolated_recovery_local_entries
    WHEN NEW.sequence != (SELECT head_sequence + 1 FROM isolated_recovery_local_metadata WHERE singleton = 1)
      OR NEW.previous_entry_sha256 != (SELECT head_entry_sha256 FROM isolated_recovery_local_metadata WHERE singleton = 1)
      OR NEW.workspace_root_sha256 != (SELECT workspace_root_sha256 FROM isolated_recovery_local_metadata WHERE singleton = 1)
      OR NEW.occurred_at < COALESCE((SELECT occurred_at FROM isolated_recovery_local_entries ORDER BY sequence DESC LIMIT 1), NEW.occurred_at)
    BEGIN
      SELECT RAISE(ABORT, 'isolated_recovery_local_entry_stale');
    END`,
  isolated_recovery_local_entries_no_update: `
    CREATE TRIGGER isolated_recovery_local_entries_no_update
    BEFORE UPDATE ON isolated_recovery_local_entries
    BEGIN
      SELECT RAISE(ABORT, 'isolated_recovery_local_entries_append_only');
    END`,
  isolated_recovery_local_entries_no_delete: `
    CREATE TRIGGER isolated_recovery_local_entries_no_delete
    BEFORE DELETE ON isolated_recovery_local_entries
    BEGIN
      SELECT RAISE(ABORT, 'isolated_recovery_local_entries_append_only');
    END`,
  isolated_recovery_local_metadata_insert_guard: `
    CREATE TRIGGER isolated_recovery_local_metadata_insert_guard
    BEFORE INSERT ON isolated_recovery_local_metadata
    WHEN EXISTS (SELECT 1 FROM isolated_recovery_local_metadata)
    BEGIN
      SELECT RAISE(ABORT, 'isolated_recovery_local_metadata_singleton');
    END`,
  isolated_recovery_local_metadata_no_delete: `
    CREATE TRIGGER isolated_recovery_local_metadata_no_delete
    BEFORE DELETE ON isolated_recovery_local_metadata
    BEGIN
      SELECT RAISE(ABORT, 'isolated_recovery_local_metadata_append_only');
    END`,
  isolated_recovery_local_metadata_update_guard: `
    CREATE TRIGGER isolated_recovery_local_metadata_update_guard
    BEFORE UPDATE ON isolated_recovery_local_metadata
    WHEN NEW.singleton IS NOT OLD.singleton
      OR NEW.format IS NOT OLD.format
      OR NEW.workspace_root_sha256 IS NOT OLD.workspace_root_sha256
      OR NEW.ledger_id_sha256 IS NOT OLD.ledger_id_sha256
      OR NEW.created_at IS NOT OLD.created_at
      OR NEW.genesis_sha256 IS NOT OLD.genesis_sha256
      OR NEW.genesis_signature IS NOT OLD.genesis_signature
      OR NEW.head_sequence != OLD.head_sequence + 1
      OR NEW.head_entry_sha256 != (SELECT entry_sha256 FROM isolated_recovery_local_entries WHERE sequence = NEW.head_sequence)
      OR OLD.head_entry_sha256 != (SELECT previous_entry_sha256 FROM isolated_recovery_local_entries WHERE sequence = NEW.head_sequence)
    BEGIN
      SELECT RAISE(ABORT, 'isolated_recovery_local_metadata_invalid_transition');
    END`,
});

const TABLE_SQL = `
  CREATE TABLE isolated_recovery_local_metadata (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format TEXT NOT NULL,
    workspace_root_sha256 TEXT NOT NULL CHECK (length(workspace_root_sha256) = 64),
    ledger_id_sha256 TEXT NOT NULL CHECK (length(ledger_id_sha256) = 64),
    created_at TEXT NOT NULL,
    genesis_sha256 TEXT NOT NULL CHECK (length(genesis_sha256) = 64),
    genesis_signature TEXT NOT NULL CHECK (length(genesis_signature) = 64),
    head_sequence INTEGER NOT NULL CHECK (head_sequence >= 0 AND head_sequence <= ${MAX_ENTRY_COUNT}),
    head_entry_sha256 TEXT NOT NULL CHECK (length(head_entry_sha256) = 64)
  ) STRICT;

  CREATE TABLE isolated_recovery_local_entries (
    sequence INTEGER PRIMARY KEY CHECK (sequence > 0 AND sequence <= ${MAX_ENTRY_COUNT}),
    format TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('workspace_sweep', 'keyring_rotation', 'keyring_prune')),
    workspace_root_sha256 TEXT NOT NULL CHECK (length(workspace_root_sha256) = 64),
    occurred_at TEXT NOT NULL,
    previous_entry_sha256 TEXT NOT NULL CHECK (length(previous_entry_sha256) = 64),
    payload_json TEXT NOT NULL CHECK (length(payload_json) <= ${MAX_PAYLOAD_BYTES}),
    payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64),
    entry_sha256 TEXT NOT NULL UNIQUE CHECK (length(entry_sha256) = 64),
    entry_signature TEXT NOT NULL CHECK (length(entry_signature) = 64),
    UNIQUE (kind, payload_sha256)
  ) STRICT;
`;

export async function createIsolatedRecoveryLocalLedger(input) {
  const workspaceRootPath = await canonicalWorkspaceRoot(input?.workspaceRootPath);
  const workspaceRootSha256 = sha256Text(workspaceRootPath);
  const signingKey = normalizeSecret(input?.signingKey, "signingKey");
  const ledgerPath = path.join(workspaceRootPath, ISOLATED_RECOVERY_LOCAL_LEDGER_FILE);
  const createdAt = new Date().toISOString();
  const ledgerIdSha256 = sha256Bytes(randomBytes(32));
  let reserved = false;
  let database;
  try {
    const handle = await open(ledgerPath, "wx", 0o600);
    reserved = true;
    await handle.close();
    await chmod(ledgerPath, 0o600);
    database = new DatabaseSync(ledgerPath);
    configureDatabase(database);
    database.exec("BEGIN IMMEDIATE");
    database.exec(TABLE_SQL);
    for (const sql of Object.values(TRIGGER_SQL)) database.exec(sql);
    database.exec("PRAGMA user_version = 1");
    const genesis = genesisRecord({
      workspaceRootSha256,
      ledgerIdSha256,
      createdAt,
    });
    const genesisSha256 = sha256Text(canonicalJson(genesis));
    const genesisSignature = hmacHex(signingKey, genesisSha256);
    database.prepare(`
      INSERT INTO isolated_recovery_local_metadata (
        singleton, format, workspace_root_sha256, ledger_id_sha256, created_at,
        genesis_sha256, genesis_signature, head_sequence, head_entry_sha256
      ) VALUES (1, ?, ?, ?, ?, ?, ?, 0, ?)
    `).run(
      ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT,
      workspaceRootSha256,
      ledgerIdSha256,
      createdAt,
      genesisSha256,
      genesisSignature,
      genesisSha256,
    );
    database.exec("COMMIT");
    const descriptor = createDescriptor({
      workspaceRootSha256,
      ledgerIdSha256,
      createdAt,
    });
    const state = {
      database,
      signingKey,
      workspaceRootSha256,
      ledgerIdSha256,
      createdAt,
      closed: false,
      anchor: null,
    };
    state.anchor = createAnchor(state, 0, genesisSha256);
    ledgerState.set(descriptor, state);
    verifyState(state, state.anchor);
    return descriptor;
  } catch (error) {
    try {
      database?.exec("ROLLBACK");
    } catch {
      // La transaccion puede no haber comenzado.
    }
    try {
      database?.close();
    } catch {
      // El descriptor nunca se publico.
    }
    signingKey.fill(0);
    if (reserved) await removeCreatedLedgerFiles(ledgerPath);
    if (error?.code === "EEXIST") {
      throw new Error("El ledger local ya existe; debe reabrirse con su ultima ancla.");
    }
    throw new Error("No se pudo crear el ledger local de recuperacion.");
  }
}

export async function openIsolatedRecoveryLocalLedger(input) {
  const workspaceRootPath = await canonicalWorkspaceRoot(input?.workspaceRootPath);
  const workspaceRootSha256 = sha256Text(workspaceRootPath);
  const signingKey = normalizeSecret(input?.signingKey, "signingKey");
  let expectedAnchor;
  try {
    expectedAnchor = normalizeAnchor(input?.expectedAnchor, signingKey);
  } catch {
    signingKey.fill(0);
    throw new Error("El ledger local o su ancla no superaron la verificacion.");
  }
  if (expectedAnchor.workspaceRootSha256 !== workspaceRootSha256) {
    signingKey.fill(0);
    throw new Error("El ancla no pertenece a la raiz efimera solicitada.");
  }
  const ledgerPath = path.join(workspaceRootPath, ISOLATED_RECOVERY_LOCAL_LEDGER_FILE);
  let database;
  try {
    await assertLedgerFile(ledgerPath);
    database = new DatabaseSync(ledgerPath);
    configureDatabase(database);
    const metadata = readMetadata(database);
    const descriptor = createDescriptor({
      workspaceRootSha256: metadata.workspace_root_sha256,
      ledgerIdSha256: metadata.ledger_id_sha256,
      createdAt: metadata.created_at,
    });
    const state = {
      database,
      signingKey,
      workspaceRootSha256: metadata.workspace_root_sha256,
      ledgerIdSha256: metadata.ledger_id_sha256,
      createdAt: metadata.created_at,
      closed: false,
      anchor: expectedAnchor,
    };
    if (state.workspaceRootSha256 !== workspaceRootSha256) {
      throw new Error("El ledger no pertenece a la raiz efimera solicitada.");
    }
    ledgerState.set(descriptor, state);
    verifyState(state, expectedAnchor);
    return descriptor;
  } catch {
    try {
      database?.close();
    } catch {
      // La apertura falla cerrada.
    }
    signingKey.fill(0);
    throw new Error("El ledger local o su ancla no superaron la verificacion.");
  }
}

export function appendIsolatedRecoverySweepIntent(ledger, input) {
  const state = requiredState(ledger);
  const keyring = normalizeKeyring(input?.keyring, state.workspaceRootSha256, "keyring");
  return appendOperationIntent(state, {
    kind: "workspace_sweep",
    requestedAt: input?.requestedAt,
    operation: {
      keyring: summarizeKeyring(keyring),
      keyringSha256: sha256Text(canonicalJson(summarizeKeyring(keyring))),
    },
  });
}

export function appendIsolatedRecoveryKeyringRotationIntent(ledger, input) {
  const state = requiredState(ledger);
  const previous = normalizeKeyring(
    input?.previousKeyring,
    state.workspaceRootSha256,
    "previousKeyring",
  );
  return appendOperationIntent(state, {
    kind: "keyring_rotation",
    requestedAt: input?.requestedAt,
    operation: {
      previousKeyring: summarizeKeyring(previous),
      previousKeyringSha256: sha256Text(canonicalJson(summarizeKeyring(previous))),
    },
  });
}

export function appendIsolatedRecoveryKeyringPruneIntent(ledger, input) {
  const state = requiredState(ledger);
  const previous = normalizeKeyring(
    input?.previousKeyring,
    state.workspaceRootSha256,
    "previousKeyring",
  );
  const sweep = normalizeSweepReceipt(input?.reaperReceipt, state.workspaceRootSha256);
  const authorizingSweepSha256 = sha256Text(canonicalJson(sweep));
  assertStoredSweepResult(state.database, authorizingSweepSha256, state.workspaceRootSha256);
  return appendOperationIntent(state, {
    kind: "keyring_prune",
    requestedAt: input?.requestedAt,
    operation: {
      previousKeyring: summarizeKeyring(previous),
      previousKeyringSha256: sha256Text(canonicalJson(summarizeKeyring(previous))),
      authorizingSweepSha256,
    },
  });
}

export function appendIsolatedRecoverySweepResult(ledger, input) {
  const state = requiredState(ledger);
  const payload = normalizeSweepReceipt(input?.reaperReceipt, state.workspaceRootSha256);
  return completeOperationIntent(state, input?.intent, {
    kind: "workspace_sweep",
    occurredAt: payload.sweptAt,
    result: payload,
  });
}

export function appendIsolatedRecoveryKeyringRotationResult(ledger, input) {
  const state = requiredState(ledger);
  const transition = normalizeRotationTransition(
    input?.previousKeyring,
    input?.nextKeyring,
    state.workspaceRootSha256,
  );
  return completeOperationIntent(state, input?.intent, {
    kind: "keyring_rotation",
    occurredAt: transition.nextKeyring.createdAt,
    result: transition,
  });
}

export function appendIsolatedRecoveryKeyringPruneResult(ledger, input) {
  const state = requiredState(ledger);
  const sweep = normalizeSweepReceipt(input?.reaperReceipt, state.workspaceRootSha256);
  const transition = normalizePruneTransition(
    input?.previousKeyring,
    input?.nextKeyring,
    sweep,
    state.workspaceRootSha256,
  );
  return completeOperationIntent(state, input?.intent, {
    kind: "keyring_prune",
    occurredAt: transition.nextKeyring.createdAt,
    result: transition,
    requiredSweepPayloadSha256: transition.authorizingSweepSha256,
  });
}

export function readPendingIsolatedRecoveryLocalIntents(ledger) {
  const state = requiredState(ledger);
  const verification = verifyState(state, state.anchor);
  return Object.freeze({
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_PENDING_FORMAT,
    workspaceRootSha256: state.workspaceRootSha256,
    ledgerIdSha256: state.ledgerIdSha256,
    pendingIntentCount: verification.pendingIntents.length,
    intents: verification.pendingIntents,
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

function appendOperationIntent(state, input) {
  const requestedAt = input.requestedAt === undefined
    ? new Date().toISOString()
    : canonicalIso(input.requestedAt, "requestedAt");
  const payload = Object.freeze({
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_INTENT_FORMAT,
    operationIdSha256: sha256Bytes(randomBytes(32)),
    operationKind: input.kind,
    requestedAt,
    ...input.operation,
  });
  return appendEntry(state, {
    kind: input.kind,
    phase: "intent",
    occurredAt: requestedAt,
    payload,
  });
}

function completeOperationIntent(state, intentReceipt, input) {
  verifyState(state, state.anchor);
  const intentPayloadSha256 = normalizeIntentReceipt(intentReceipt, input.kind);
  const intentRow = state.database.prepare(`
    SELECT sequence, kind, occurred_at, payload_json, payload_sha256
    FROM isolated_recovery_local_entries
    WHERE payload_sha256 = ?
  `).get(intentPayloadSha256);
  if (!intentRow || intentRow.kind !== input.kind) {
    throw new Error("El resultado exige una intencion local registrada previamente.");
  }
  const intentMeta = validateStoredPayload(
    intentRow.kind,
    JSON.parse(intentRow.payload_json),
    state.workspaceRootSha256,
  );
  if (intentMeta.phase !== "intent") {
    throw new Error("La referencia del resultado no corresponde a una intencion local.");
  }
  const resultPayload = Object.freeze({
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_RESULT_FORMAT,
    operationIdSha256: intentMeta.operationIdSha256,
    intentPayloadSha256,
    result: input.result,
  });
  assertIntentResultPair(intentMeta, input.kind, input.result, input.occurredAt);
  const existing = findStoredOperationResult(state.database, intentPayloadSha256);
  if (existing) {
    if (existing.kind !== input.kind || existing.payload_json !== canonicalJson(resultPayload)) {
      throw new Error("La intencion ya tiene un resultado distinto; no puede reescribirse.");
    }
    return appendReceipt(state, existing, {
      phase: "result",
      intentPayloadSha256,
      replayed: true,
    });
  }
  return appendEntry(state, {
    kind: input.kind,
    phase: "result",
    occurredAt: input.occurredAt,
    payload: resultPayload,
    intentPayloadSha256,
    requiredSweepPayloadSha256: input.requiredSweepPayloadSha256,
  });
}

export function readIsolatedRecoveryLocalLedgerAnchor(ledger) {
  const state = requiredState(ledger);
  return copyAnchor(state.anchor);
}

export function verifyIsolatedRecoveryLocalLedger(ledger, input = {}) {
  const state = requiredState(ledger);
  const expectedAnchor = input.expectedAnchor === undefined
    ? state.anchor
    : normalizeAnchor(input.expectedAnchor, state.signingKey);
  return verifyState(state, expectedAnchor);
}

export function closeIsolatedRecoveryLocalLedger(ledger) {
  const state = requiredState(ledger);
  let verification;
  try {
    verification = verifyState(state, state.anchor);
  } finally {
    try {
      state.database.close();
    } finally {
      state.closed = true;
      state.signingKey.fill(0);
    }
  }
  return Object.freeze({
    format: CLOSE_RECEIPT_FORMAT,
    workspaceRootSha256: state.workspaceRootSha256,
    ledgerIdSha256: state.ledgerIdSha256,
    entryCount: verification.entryCount,
    anchor: copyAnchor(state.anchor),
    closed: true,
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

function appendEntry(state, input) {
  verifyState(state, state.anchor);
  const payloadJson = canonicalJson(input.payload);
  if (Buffer.byteLength(payloadJson, "utf8") > MAX_PAYLOAD_BYTES) {
    throw new Error("El resultado agregado excede el limite del ledger local.");
  }
  const payloadSha256 = sha256Text(payloadJson);
  let began = false;
  try {
    state.database.exec("BEGIN IMMEDIATE");
    began = true;
    const metadata = readMetadata(state.database);
    if (metadata.head_sequence !== state.anchor.sequence
      || metadata.head_entry_sha256 !== state.anchor.entrySha256) {
      throw new Error("La instancia del ledger quedo atras respecto de otro escritor.");
    }
    if (input.requiredSweepPayloadSha256) {
      assertStoredSweepResult(
        state.database,
        input.requiredSweepPayloadSha256,
        state.workspaceRootSha256,
      );
    }
    if (input.phase === "result"
      && (input.kind === "keyring_rotation" || input.kind === "keyring_prune")) {
      const lastTransition = lastStoredKeyringResult(state.database, state.workspaceRootSha256);
      if (lastTransition) {
        if (lastTransition.nextKeyringSha256 !== input.payload.result.previousKeyringSha256) {
          throw new Error("La transicion del keyring omite un estado local previo.");
        }
      }
    }
    const sequence = metadata.head_sequence + 1;
    if (sequence > MAX_ENTRY_COUNT) throw new Error("El ledger local alcanzo su limite de entradas.");
    const occurredAt = canonicalIso(input.occurredAt, "occurredAt");
    const entryBase = {
      format: ISOLATED_RECOVERY_LOCAL_LEDGER_ENTRY_FORMAT,
      sequence,
      kind: input.kind,
      workspaceRootSha256: state.workspaceRootSha256,
      occurredAt,
      previousEntrySha256: metadata.head_entry_sha256,
      payloadSha256,
    };
    const entrySha256 = sha256Text(canonicalJson(entryBase));
    const entrySignature = hmacHex(state.signingKey, entrySha256);
    state.database.prepare(`
      INSERT INTO isolated_recovery_local_entries (
        sequence, format, kind, workspace_root_sha256, occurred_at,
        previous_entry_sha256, payload_json, payload_sha256,
        entry_sha256, entry_signature
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sequence,
      entryBase.format,
      input.kind,
      state.workspaceRootSha256,
      occurredAt,
      metadata.head_entry_sha256,
      payloadJson,
      payloadSha256,
      entrySha256,
      entrySignature,
    );
    const update = state.database.prepare(`
      UPDATE isolated_recovery_local_metadata
      SET head_sequence = ?, head_entry_sha256 = ?
      WHERE singleton = 1 AND head_sequence = ? AND head_entry_sha256 = ?
    `).run(sequence, entrySha256, metadata.head_sequence, metadata.head_entry_sha256);
    if (update.changes !== 1) throw new Error("La cabeza del ledger cambio durante el append.");
    state.database.exec("COMMIT");
    began = false;
    state.anchor = createAnchor(state, sequence, entrySha256);
    return appendReceipt(state, {
      sequence,
      kind: input.kind,
      payload_sha256: payloadSha256,
      entry_sha256: entrySha256,
    }, {
      phase: input.phase,
      intentPayloadSha256: input.intentPayloadSha256
        ?? (input.phase === "intent" ? payloadSha256 : null),
      replayed: false,
    });
  } catch (error) {
    if (began) {
      try {
        state.database.exec("ROLLBACK");
      } catch {
        // El fallo original sigue siendo la causa operativa.
      }
    }
    throw error;
  }
}

function appendReceipt(state, row, input) {
  return Object.freeze({
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_APPEND_RECEIPT_FORMAT,
    kind: row.kind,
    phase: input.phase,
    sequence: row.sequence,
    payloadSha256: row.payload_sha256,
    intentPayloadSha256: input.intentPayloadSha256,
    entrySha256: row.entry_sha256,
    replayed: input.replayed,
    anchor: copyAnchor(state.anchor),
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

function verifyState(state, expectedAnchor) {
  assertDatabaseHealth(state.database);
  assertSchema(state.database);
  const metadata = readMetadata(state.database);
  assertMetadata(metadata, state);
  const genesis = genesisRecord({
    workspaceRootSha256: state.workspaceRootSha256,
    ledgerIdSha256: state.ledgerIdSha256,
    createdAt: state.createdAt,
  });
  const genesisSha256 = sha256Text(canonicalJson(genesis));
  if (metadata.genesis_sha256 !== genesisSha256
    || !safeEqualHex(metadata.genesis_signature, hmacHex(state.signingKey, genesisSha256))) {
    throw new Error("La genesis del ledger no es autentica.");
  }
  const rows = state.database.prepare(`
    SELECT sequence, format, kind, workspace_root_sha256, occurred_at,
      previous_entry_sha256, payload_json, payload_sha256,
      entry_sha256, entry_signature
    FROM isolated_recovery_local_entries
    ORDER BY sequence
  `).all();
  if (rows.length > MAX_ENTRY_COUNT) throw new Error("El ledger excede el limite verificable.");
  let previousEntrySha256 = genesisSha256;
  let previousOccurredAt = null;
  let lastKeyringSha256 = null;
  const priorSweepPayloads = new Map();
  const operationIntents = new Map();
  const completedIntentHashes = new Set();
  const eventCounts = {
    workspaceSweepCount: 0,
    keyringRotationCount: 0,
    keyringPruneCount: 0,
  };
  let operationIntentCount = 0;
  let legacyResultCount = 0;
  for (const [index, row] of rows.entries()) {
    const sequence = index + 1;
    if (row.sequence !== sequence
      || row.format !== ISOLATED_RECOVERY_LOCAL_LEDGER_ENTRY_FORMAT
      || !EVENT_KINDS.includes(row.kind)
      || row.workspace_root_sha256 !== state.workspaceRootSha256
      || row.previous_entry_sha256 !== previousEntrySha256) {
      throw new Error(`La cadena del ledger diverge en la secuencia ${sequence}.`);
    }
    const occurredAt = canonicalIso(row.occurred_at, "entry.occurredAt");
    if (previousOccurredAt !== null && occurredAt < previousOccurredAt) {
      throw new Error(`El ledger reordena resultados en la secuencia ${sequence}.`);
    }
    previousOccurredAt = occurredAt;
    if (Buffer.byteLength(row.payload_json, "utf8") > MAX_PAYLOAD_BYTES) {
      throw new Error(`El payload del ledger excede el limite en la secuencia ${sequence}.`);
    }
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      throw new Error(`El payload del ledger no es JSON en la secuencia ${sequence}.`);
    }
    if (canonicalJson(payload) !== row.payload_json) {
      throw new Error(`El payload del ledger no es canonico en la secuencia ${sequence}.`);
    }
    const payloadMeta = validateStoredPayload(row.kind, payload, state.workspaceRootSha256);
    if (payloadMeta.occurredAt !== occurredAt) {
      throw new Error(`La fecha del resultado diverge en la secuencia ${sequence}.`);
    }
    const payloadSha256 = sha256Text(row.payload_json);
    if (row.payload_sha256 !== payloadSha256) {
      throw new Error(`El payload del ledger fue alterado en la secuencia ${sequence}.`);
    }
    if (payloadMeta.phase === "intent") {
      if (operationIntents.has(payloadSha256)) {
        throw new Error(`La intencion local se duplica en la secuencia ${sequence}.`);
      }
      operationIntents.set(payloadSha256, Object.freeze({
        kind: row.kind,
        operationIdSha256: payloadMeta.operationIdSha256,
        intentPayloadSha256: payloadSha256,
        requestedAt: payloadMeta.occurredAt,
      }));
      operationIntentCount += 1;
    } else {
      if (payloadMeta.phase === "result") {
        const intent = operationIntents.get(payloadMeta.intentPayloadSha256);
        if (!intent || intent.kind !== row.kind
          || intent.operationIdSha256 !== payloadMeta.operationIdSha256
          || completedIntentHashes.has(payloadMeta.intentPayloadSha256)) {
          throw new Error(`El resultado no cierra una intencion previa unica en la secuencia ${sequence}.`);
        }
        const intentPayload = JSON.parse(state.database.prepare(`
          SELECT payload_json FROM isolated_recovery_local_entries WHERE payload_sha256 = ?
        `).get(payloadMeta.intentPayloadSha256).payload_json);
        const intentMeta = validateStoredPayload(row.kind, intentPayload, state.workspaceRootSha256);
        assertIntentResultPair(intentMeta, row.kind, payloadMeta.result, occurredAt);
        completedIntentHashes.add(payloadMeta.intentPayloadSha256);
      } else {
        legacyResultCount += 1;
      }
      const resultPayloadSha256 = sha256Text(canonicalJson(payloadMeta.result));
      if (row.kind === "workspace_sweep") {
        priorSweepPayloads.set(resultPayloadSha256, payloadMeta.result);
        eventCounts.workspaceSweepCount += 1;
      } else {
        if (lastKeyringSha256 !== null
          && payloadMeta.resultMeta.previousKeyringSha256 !== lastKeyringSha256) {
          throw new Error(`El ledger omite una transicion del keyring en la secuencia ${sequence}.`);
        }
        if (row.kind === "keyring_prune") {
          const authorizingSweep = priorSweepPayloads.get(
            payloadMeta.resultMeta.authorizingSweepSha256,
          );
          if (!authorizingSweep) {
            throw new Error(`La poda no tiene barrido previo en la secuencia ${sequence}.`);
          }
          assertStoredPruneAuthorization(payloadMeta.resultMeta, authorizingSweep, sequence);
        }
        lastKeyringSha256 = payloadMeta.resultMeta.nextKeyringSha256;
        eventCounts[row.kind === "keyring_rotation"
          ? "keyringRotationCount"
          : "keyringPruneCount"] += 1;
      }
    }
    const entryBase = {
      format: row.format,
      sequence,
      kind: row.kind,
      workspaceRootSha256: row.workspace_root_sha256,
      occurredAt,
      previousEntrySha256: row.previous_entry_sha256,
      payloadSha256,
    };
    const entrySha256 = sha256Text(canonicalJson(entryBase));
    if (row.entry_sha256 !== entrySha256
      || !safeEqualHex(row.entry_signature, hmacHex(state.signingKey, entrySha256))) {
      throw new Error(`La entrada del ledger no es autentica en la secuencia ${sequence}.`);
    }
    previousEntrySha256 = entrySha256;
  }
  if (metadata.head_sequence !== rows.length
    || metadata.head_entry_sha256 !== previousEntrySha256) {
    throw new Error("La cabeza mutable no coincide con la cadena append-only.");
  }
  const currentAnchor = createAnchor(state, rows.length, previousEntrySha256);
  assertExpectedAnchor(expectedAnchor, currentAnchor, state.signingKey);
  state.anchor = currentAnchor;
  const pendingIntents = Object.freeze([...operationIntents]
    .filter(([intentPayloadSha256]) => !completedIntentHashes.has(intentPayloadSha256))
    .map(([, intent]) => intent));
  return Object.freeze({
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_VERIFICATION_FORMAT,
    workspaceRootSha256: state.workspaceRootSha256,
    ledgerIdSha256: state.ledgerIdSha256,
    entryCount: rows.length,
    eventCounts: Object.freeze({ ...eventCounts }),
    operationIntentCount,
    legacyResultCount,
    pendingIntentCount: pendingIntents.length,
    pendingIntents,
    anchor: copyAnchor(currentAnchor),
    sqliteIntegrityVerified: true,
    appendOnlySchemaVerified: true,
    chainVerified: true,
    anchorVerified: true,
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

function normalizeSweepReceipt(value, workspaceRootSha256) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== ORPHAN_REAPER_RECEIPT_FORMAT
    || value.workspaceRootSha256 !== workspaceRootSha256
    || value.productWritesEnabled !== false
    || value.remoteWrites !== false
    || value.destructionVerified !== (value.failedWorkspaceCount === 0)
    || !Array.isArray(value.keyUsage)) {
    throw new Error("El resultado del barrido no cumple el contrato local v2.");
  }
  const normalized = {
    format: ORPHAN_REAPER_RECEIPT_FORMAT,
    workspaceRootSha256,
    activeKeyIdSha256: validSha256(value.activeKeyIdSha256, "activeKeyIdSha256"),
    keyUsage: value.keyUsage.map((usage, index) => ({
      keyIdSha256: validSha256(usage?.keyIdSha256, `keyUsage[${index}].keyIdSha256`),
      authenticatedWorkspaceCount: nonNegativeInteger(
        usage?.authenticatedWorkspaceCount,
        `keyUsage[${index}].authenticatedWorkspaceCount`,
      ),
    })).sort((left, right) => left.keyIdSha256.localeCompare(right.keyIdSha256)),
    ...Object.fromEntries(SWEEP_COUNT_KEYS.map((key) => [key, nonNegativeInteger(value[key], key)])),
    destructionVerified: value.destructionVerified,
    sweptAt: canonicalIso(value.sweptAt, "sweptAt"),
    productWritesEnabled: false,
    remoteWrites: false,
  };
  const keyHashes = normalized.keyUsage.map((usage) => usage.keyIdSha256);
  if (new Set(keyHashes).size !== keyHashes.length
    || !keyHashes.includes(normalized.activeKeyIdSha256)
    || sum(normalized.keyUsage.map((usage) => usage.authenticatedWorkspaceCount))
      !== normalized.authenticatedWorkspaceCount
    || normalized.candidateWorkspaceCount
      !== normalized.authenticatedWorkspaceCount + normalized.unauthenticatedWorkspaceCount
    || normalized.authenticatedWorkspaceCount
      !== normalized.unexpiredWorkspaceCount + normalized.expiredWorkspaceCount
    || normalized.expiredWorkspaceCount
      !== normalized.liveWorkspaceCount + normalized.destroyedWorkspaceCount
        + normalized.failedWorkspaceCount
    || normalized.markerMissingCount + normalized.markerInvalidCount
      > normalized.authenticatedWorkspaceCount
    || normalized.unknownKeyIdWorkspaceCount > normalized.unauthenticatedWorkspaceCount
    || normalized.legacyWorkspaceCount > normalized.authenticatedWorkspaceCount) {
    throw new Error("Los conteos del barrido local son incoherentes.");
  }
  return Object.freeze({
    ...normalized,
    keyUsage: Object.freeze(normalized.keyUsage.map((usage) => Object.freeze(usage))),
  });
}

function normalizeRotationTransition(previousValue, nextValue, workspaceRootSha256) {
  const previous = normalizeKeyring(previousValue, workspaceRootSha256, "previousKeyring");
  const next = normalizeKeyring(nextValue, workspaceRootSha256, "nextKeyring");
  if (previous.activeKeyId === next.activeKeyId
    || Date.parse(next.createdAt) < Date.parse(previous.createdAt)
    || next.verificationKeys.length !== previous.verificationKeys.length + 1) {
    throw new Error("La rotacion del keyring no contiene una sola generacion nueva.");
  }
  const expectedMovedUntil = new Date(
    Date.parse(next.createdAt) + ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
  ).toISOString();
  const nextMap = new Map(next.verificationKeys.map((entry) => [entry.keyId, entry.verifyUntil]));
  if (nextMap.get(previous.activeKeyId) !== expectedMovedUntil
    || previous.verificationKeys.some((entry) => nextMap.get(entry.keyId) !== entry.verifyUntil)) {
    throw new Error("La rotacion no retiene exactamente las generaciones anteriores.");
  }
  return transitionPayload(previous, next, {});
}

function normalizePruneTransition(previousValue, nextValue, sweep, workspaceRootSha256) {
  const previous = normalizeKeyring(previousValue, workspaceRootSha256, "previousKeyring");
  const next = normalizeKeyring(nextValue, workspaceRootSha256, "nextKeyring");
  if (previous.activeKeyId !== next.activeKeyId
    || Date.parse(next.createdAt) < Date.parse(previous.createdAt)
    || next.verificationKeys.length >= previous.verificationKeys.length
    || sweep.destructionVerified !== true || sweep.failedWorkspaceCount !== 0) {
    throw new Error("La poda del keyring no retira una generacion autorizada.");
  }
  const nextMap = new Map(next.verificationKeys.map((entry) => [entry.keyId, entry.verifyUntil]));
  const usage = new Map(sweep.keyUsage.map((entry) => [entry.keyIdSha256, entry.authenticatedWorkspaceCount]));
  const removed = [];
  for (const entry of previous.verificationKeys) {
    if (nextMap.has(entry.keyId)) {
      if (nextMap.get(entry.keyId) !== entry.verifyUntil) {
        throw new Error("La poda altero una generacion retenida.");
      }
      continue;
    }
    const keyIdSha256 = sha256Text(entry.keyId);
    if (Date.parse(entry.verifyUntil) > Date.parse(next.createdAt)
      || Date.parse(sweep.sweptAt) < Date.parse(entry.verifyUntil)
      || usage.get(keyIdSha256) !== 0) {
      throw new Error("La poda no tiene TTL vencido y uso cero posterior.");
    }
    removed.push(keyIdSha256);
  }
  if (next.verificationKeys.some((entry) => !previous.verificationKeys.some(
    (candidate) => candidate.keyId === entry.keyId,
  ))) {
    throw new Error("La poda no puede agregar generaciones.");
  }
  return transitionPayload(previous, next, {
    removedKeyIdSha256: Object.freeze(removed.sort()),
    authorizingSweepSha256: sha256Text(canonicalJson(sweep)),
  });
}

function transitionPayload(previous, next, extra) {
  const previousKeyring = summarizeKeyring(previous);
  const nextKeyring = summarizeKeyring(next);
  return Object.freeze({
    previousKeyring,
    nextKeyring,
    previousKeyringSha256: sha256Text(canonicalJson(previousKeyring)),
    nextKeyringSha256: sha256Text(canonicalJson(nextKeyring)),
    ...extra,
  });
}

function normalizeKeyring(value, workspaceRootSha256, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT
    || value.workspaceRootSha256 !== workspaceRootSha256
    || value.maxWorkspaceTtlMs !== ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS
    || !Array.isArray(value.verificationKeys)) {
    throw new Error(`${name} no cumple el contrato del keyring local.`);
  }
  const activeKeyId = validKeyId(value.activeKeyId, `${name}.activeKeyId`);
  const verificationKeys = value.verificationKeys.map((entry, index) => ({
    keyId: validKeyId(entry?.keyId, `${name}.verificationKeys[${index}].keyId`),
    verifyUntil: canonicalIso(
      entry?.verifyUntil,
      `${name}.verificationKeys[${index}].verifyUntil`,
    ),
  }));
  const ids = [activeKeyId, ...verificationKeys.map((entry) => entry.keyId)];
  if (verificationKeys.length > 3 || new Set(ids).size !== ids.length) {
    throw new Error(`${name} contiene generaciones invalidas.`);
  }
  return {
    format: ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT,
    workspaceRootSha256,
    activeKeyId,
    verificationKeys,
    maxWorkspaceTtlMs: ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
    createdAt: canonicalIso(value.createdAt, `${name}.createdAt`),
  };
}

function summarizeKeyring(keyring) {
  return Object.freeze({
    format: keyring.format,
    workspaceRootSha256: keyring.workspaceRootSha256,
    activeKeyIdSha256: sha256Text(keyring.activeKeyId),
    verificationKeys: Object.freeze(keyring.verificationKeys
      .map((entry) => Object.freeze({
        keyIdSha256: sha256Text(entry.keyId),
        verifyUntil: entry.verifyUntil,
      }))
      .sort((left, right) => left.keyIdSha256.localeCompare(right.keyIdSha256))),
    maxWorkspaceTtlMs: keyring.maxWorkspaceTtlMs,
    createdAt: keyring.createdAt,
  });
}

function validateStoredPayload(kind, payload, workspaceRootSha256) {
  if (payload?.format === ISOLATED_RECOVERY_LOCAL_LEDGER_INTENT_FORMAT) {
    return validateStoredIntent(kind, payload, workspaceRootSha256);
  }
  if (payload?.format === ISOLATED_RECOVERY_LOCAL_LEDGER_RESULT_FORMAT) {
    assertExactKeys(payload, [
      "format",
      "intentPayloadSha256",
      "operationIdSha256",
      "result",
    ], "resultado coordinado persistido");
    const resultMeta = validateOperationResult(kind, payload.result, workspaceRootSha256);
    return {
      phase: "result",
      occurredAt: resultMeta.occurredAt,
      operationIdSha256: validSha256(payload.operationIdSha256, "operationIdSha256"),
      intentPayloadSha256: validSha256(payload.intentPayloadSha256, "intentPayloadSha256"),
      result: payload.result,
      resultMeta,
    };
  }
  const resultMeta = validateOperationResult(kind, payload, workspaceRootSha256);
  return {
    phase: "legacy_result",
    occurredAt: resultMeta.occurredAt,
    result: payload,
    resultMeta,
  };
}

function validateOperationResult(kind, payload, workspaceRootSha256) {
  if (kind === "workspace_sweep") {
    const normalized = normalizeSweepReceipt(payload, workspaceRootSha256);
    if (canonicalJson(normalized) !== canonicalJson(payload)) {
      throw new Error("El resultado de barrido persistido contiene campos no permitidos.");
    }
    return { occurredAt: normalized.sweptAt, normalized };
  }
  const expectedKeys = kind === "keyring_rotation"
    ? ["nextKeyring", "nextKeyringSha256", "previousKeyring", "previousKeyringSha256"]
    : [
      "authorizingSweepSha256",
      "nextKeyring",
      "nextKeyringSha256",
      "previousKeyring",
      "previousKeyringSha256",
      "removedKeyIdSha256",
    ];
  assertExactKeys(payload, expectedKeys, "transicion persistida");
  const previous = validateStoredKeyringSummary(payload.previousKeyring, workspaceRootSha256);
  const next = validateStoredKeyringSummary(payload.nextKeyring, workspaceRootSha256);
  const previousKeyringSha256 = validSha256(
    payload.previousKeyringSha256,
    "previousKeyringSha256",
  );
  const nextKeyringSha256 = validSha256(payload.nextKeyringSha256, "nextKeyringSha256");
  if (previousKeyringSha256 !== sha256Text(canonicalJson(previous))
    || nextKeyringSha256 !== sha256Text(canonicalJson(next))) {
    throw new Error("Las huellas del keyring persistido no coinciden.");
  }
  const previousMap = new Map(previous.verificationKeys.map((entry) => [entry.keyIdSha256, entry.verifyUntil]));
  const nextMap = new Map(next.verificationKeys.map((entry) => [entry.keyIdSha256, entry.verifyUntil]));
  if (kind === "keyring_rotation") {
    const expectedMovedUntil = new Date(
      Date.parse(next.createdAt) + ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
    ).toISOString();
    if (Date.parse(next.createdAt) < Date.parse(previous.createdAt)
      || previous.activeKeyIdSha256 === next.activeKeyIdSha256
      || nextMap.get(previous.activeKeyIdSha256) !== expectedMovedUntil
      || nextMap.size !== previousMap.size + 1
      || [...previousMap].some(([key, until]) => nextMap.get(key) !== until)) {
      throw new Error("La rotacion persistida no conserva su predecesora.");
    }
    return {
      previousKeyringSha256,
      nextKeyringSha256,
      occurredAt: next.createdAt,
    };
  }
  const removed = normalizedShaList(payload.removedKeyIdSha256, "removedKeyIdSha256");
  const actualRemoved = [...previousMap.keys()].filter((key) => !nextMap.has(key)).sort();
  if (Date.parse(next.createdAt) < Date.parse(previous.createdAt)
    || previous.activeKeyIdSha256 !== next.activeKeyIdSha256
    || nextMap.size >= previousMap.size
    || [...nextMap].some(([key, until]) => previousMap.get(key) !== until)
    || canonicalJson(removed) !== canonicalJson(actualRemoved)) {
    throw new Error("La poda persistida no es un subconjunto exacto.");
  }
  return {
    previousKeyringSha256,
    nextKeyringSha256,
    occurredAt: next.createdAt,
    previousKeyring: previous,
    nextKeyring: next,
    removedKeyIdSha256: removed,
    authorizingSweepSha256: validSha256(
      payload.authorizingSweepSha256,
      "authorizingSweepSha256",
    ),
  };
}

function validateStoredIntent(kind, payload, workspaceRootSha256) {
  const commonKeys = [
    "format",
    "operationIdSha256",
    "operationKind",
    "requestedAt",
  ];
  const expectedKeys = kind === "workspace_sweep"
    ? [...commonKeys, "keyring", "keyringSha256"]
    : (kind === "keyring_rotation"
      ? [...commonKeys, "previousKeyring", "previousKeyringSha256"]
      : [
        ...commonKeys,
        "authorizingSweepSha256",
        "previousKeyring",
        "previousKeyringSha256",
      ]);
  assertExactKeys(payload, expectedKeys, "intencion local persistida");
  if (payload.operationKind !== kind) {
    throw new Error("La intencion local no corresponde a su tipo de operacion.");
  }
  const common = {
    phase: "intent",
    occurredAt: canonicalIso(payload.requestedAt, "intent.requestedAt"),
    operationIdSha256: validSha256(payload.operationIdSha256, "operationIdSha256"),
  };
  if (kind === "workspace_sweep") {
    const keyring = validateStoredKeyringSummary(payload.keyring, workspaceRootSha256);
    const keyringSha256 = validSha256(payload.keyringSha256, "keyringSha256");
    if (keyringSha256 !== sha256Text(canonicalJson(keyring))) {
      throw new Error("La intencion de barrido no coincide con su keyring.");
    }
    return { ...common, keyring, keyringSha256 };
  }
  const previousKeyring = validateStoredKeyringSummary(
    payload.previousKeyring,
    workspaceRootSha256,
  );
  const previousKeyringSha256 = validSha256(
    payload.previousKeyringSha256,
    "previousKeyringSha256",
  );
  if (previousKeyringSha256 !== sha256Text(canonicalJson(previousKeyring))) {
    throw new Error("La intencion de keyring no coincide con su estado previo.");
  }
  return {
    ...common,
    previousKeyring,
    previousKeyringSha256,
    ...(kind === "keyring_prune" ? {
      authorizingSweepSha256: validSha256(
        payload.authorizingSweepSha256,
        "authorizingSweepSha256",
      ),
    } : {}),
  };
}

function assertIntentResultPair(intentMeta, kind, result, occurredAt) {
  const resultAt = canonicalIso(occurredAt, "result.occurredAt");
  if (Date.parse(resultAt) < Date.parse(intentMeta.occurredAt)) {
    throw new Error("El resultado local no puede preceder a su intencion durable.");
  }
  if (kind === "workspace_sweep") {
    const expectedHashes = [
      intentMeta.keyring.activeKeyIdSha256,
      ...intentMeta.keyring.verificationKeys.map((entry) => entry.keyIdSha256),
    ].sort();
    const actualHashes = result.keyUsage.map((entry) => entry.keyIdSha256).sort();
    if (result.activeKeyIdSha256 !== intentMeta.keyring.activeKeyIdSha256
      || canonicalJson(actualHashes) !== canonicalJson(expectedHashes)) {
      throw new Error("El barrido no corresponde al keyring registrado en su intencion.");
    }
    return;
  }
  if (result.previousKeyringSha256 !== intentMeta.previousKeyringSha256) {
    throw new Error("La transicion no parte del keyring registrado en su intencion.");
  }
  if (kind === "keyring_prune"
    && result.authorizingSweepSha256 !== intentMeta.authorizingSweepSha256) {
    throw new Error("La poda no usa el barrido registrado en su intencion.");
  }
}

function normalizeIntentReceipt(value, kind) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.format !== ISOLATED_RECOVERY_LOCAL_LEDGER_APPEND_RECEIPT_FORMAT
    || value.kind !== kind || value.phase !== "intent") {
    throw new Error("El resultado exige el recibo de su intencion local.");
  }
  const payloadSha256 = validSha256(value.payloadSha256, "intent.payloadSha256");
  if (value.intentPayloadSha256 !== payloadSha256) {
    throw new Error("El recibo de intencion no conserva su huella canonica.");
  }
  return payloadSha256;
}

function findStoredOperationResult(database, intentPayloadSha256) {
  const rows = database.prepare(`
    SELECT sequence, kind, payload_json, payload_sha256, entry_sha256
    FROM isolated_recovery_local_entries ORDER BY sequence
  `).all();
  for (const row of rows) {
    let payload;
    try {
      payload = JSON.parse(row.payload_json);
    } catch {
      continue;
    }
    if (payload?.format === ISOLATED_RECOVERY_LOCAL_LEDGER_RESULT_FORMAT
      && payload.intentPayloadSha256 === intentPayloadSha256) {
      return row;
    }
  }
  return null;
}

function assertStoredSweepResult(database, resultPayloadSha256, workspaceRootSha256) {
  const rows = database.prepare(`
    SELECT payload_json FROM isolated_recovery_local_entries
    WHERE kind = 'workspace_sweep' ORDER BY sequence
  `).all();
  const found = rows.some((row) => {
    try {
      const payload = JSON.parse(row.payload_json);
      const meta = validateStoredPayload("workspace_sweep", payload, workspaceRootSha256);
      return meta.phase !== "intent"
        && sha256Text(canonicalJson(meta.result)) === resultPayloadSha256;
    } catch {
      return false;
    }
  });
  if (!found) throw new Error("La poda exige registrar antes su barrido autorizante.");
}

function lastStoredKeyringResult(database, workspaceRootSha256) {
  const rows = database.prepare(`
    SELECT kind, payload_json FROM isolated_recovery_local_entries
    WHERE kind IN ('keyring_rotation', 'keyring_prune')
    ORDER BY sequence DESC
  `).all();
  for (const row of rows) {
    const payload = JSON.parse(row.payload_json);
    const meta = validateStoredPayload(row.kind, payload, workspaceRootSha256);
    if (meta.phase !== "intent") return meta.resultMeta;
  }
  return null;
}

function assertStoredPruneAuthorization(payloadMeta, sweep, sequence) {
  const usage = new Map(sweep.keyUsage.map((entry) => [
    entry.keyIdSha256,
    entry.authenticatedWorkspaceCount,
  ]));
  const previousVerification = new Map(payloadMeta.previousKeyring.verificationKeys.map(
    (entry) => [entry.keyIdSha256, entry.verifyUntil],
  ));
  if (sweep.destructionVerified !== true || sweep.failedWorkspaceCount !== 0
    || Date.parse(payloadMeta.nextKeyring.createdAt) < Date.parse(sweep.sweptAt)
    || payloadMeta.removedKeyIdSha256.some((keyIdSha256) => {
      const verifyUntil = previousVerification.get(keyIdSha256);
      return verifyUntil === undefined
        || Date.parse(verifyUntil) > Date.parse(payloadMeta.nextKeyring.createdAt)
        || Date.parse(sweep.sweptAt) < Date.parse(verifyUntil)
        || usage.get(keyIdSha256) !== 0;
    })) {
    throw new Error(`La poda no tiene TTL vencido y uso cero en la secuencia ${sequence}.`);
  }
}

function validateStoredKeyringSummary(value, workspaceRootSha256) {
  assertExactKeys(value, [
    "activeKeyIdSha256",
    "createdAt",
    "format",
    "maxWorkspaceTtlMs",
    "verificationKeys",
    "workspaceRootSha256",
  ], "resumen de keyring");
  if (value.format !== ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT
    || value.workspaceRootSha256 !== workspaceRootSha256
    || value.maxWorkspaceTtlMs !== ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS
    || !Array.isArray(value.verificationKeys) || value.verificationKeys.length > 3) {
    throw new Error("El resumen persistido del keyring es invalido.");
  }
  const activeKeyIdSha256 = validSha256(value.activeKeyIdSha256, "activeKeyIdSha256");
  const verificationKeys = value.verificationKeys.map((entry, index) => {
    assertExactKeys(entry, ["keyIdSha256", "verifyUntil"], "generacion persistida");
    return {
      keyIdSha256: validSha256(entry.keyIdSha256, `verificationKeys[${index}].keyIdSha256`),
      verifyUntil: canonicalIso(entry.verifyUntil, `verificationKeys[${index}].verifyUntil`),
    };
  });
  const hashes = [activeKeyIdSha256, ...verificationKeys.map((entry) => entry.keyIdSha256)];
  if (new Set(hashes).size !== hashes.length
    || canonicalJson(verificationKeys) !== canonicalJson([...verificationKeys].sort(
      (left, right) => left.keyIdSha256.localeCompare(right.keyIdSha256),
    ))) {
    throw new Error("Las generaciones persistidas no son unicas y canonicas.");
  }
  return {
    format: value.format,
    workspaceRootSha256,
    activeKeyIdSha256,
    verificationKeys,
    maxWorkspaceTtlMs: value.maxWorkspaceTtlMs,
    createdAt: canonicalIso(value.createdAt, "keyring.createdAt"),
  };
}

function configureDatabase(database) {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = DELETE");
  database.exec("PRAGMA synchronous = FULL");
  database.exec("PRAGMA busy_timeout = 2500");
}

function assertDatabaseHealth(database) {
  const integrity = database.prepare("PRAGMA quick_check").all();
  if (integrity.length !== 1 || integrity[0].quick_check !== "ok") {
    throw new Error("SQLite no supera quick_check.");
  }
  if (database.prepare("PRAGMA foreign_key_check").all().length !== 0) {
    throw new Error("SQLite no supera foreign_key_check.");
  }
  const version = database.prepare("PRAGMA user_version").get();
  if (version.user_version !== 1) throw new Error("La version del ledger local es desconocida.");
}

function assertSchema(database) {
  const triggerRows = database.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'isolated_recovery_local_%'
    ORDER BY name
  `).all();
  const expectedNames = Object.keys(TRIGGER_SQL).sort();
  if (canonicalJson(triggerRows.map((row) => row.name)) !== canonicalJson(expectedNames)) {
    throw new Error("Faltan triggers append-only del ledger local.");
  }
  for (const row of triggerRows) {
    if (normalizeSql(row.sql) !== normalizeSql(TRIGGER_SQL[row.name])) {
      throw new Error(`El trigger ${row.name} no conserva su contrato.`);
    }
  }
  assertTableColumns(database, "isolated_recovery_local_metadata", [
    ["singleton", "INTEGER", 0, 1],
    ["format", "TEXT", 1, 0],
    ["workspace_root_sha256", "TEXT", 1, 0],
    ["ledger_id_sha256", "TEXT", 1, 0],
    ["created_at", "TEXT", 1, 0],
    ["genesis_sha256", "TEXT", 1, 0],
    ["genesis_signature", "TEXT", 1, 0],
    ["head_sequence", "INTEGER", 1, 0],
    ["head_entry_sha256", "TEXT", 1, 0],
  ]);
  assertTableColumns(database, "isolated_recovery_local_entries", [
    ["sequence", "INTEGER", 0, 1],
    ["format", "TEXT", 1, 0],
    ["kind", "TEXT", 1, 0],
    ["workspace_root_sha256", "TEXT", 1, 0],
    ["occurred_at", "TEXT", 1, 0],
    ["previous_entry_sha256", "TEXT", 1, 0],
    ["payload_json", "TEXT", 1, 0],
    ["payload_sha256", "TEXT", 1, 0],
    ["entry_sha256", "TEXT", 1, 0],
    ["entry_signature", "TEXT", 1, 0],
  ]);
}

function assertTableColumns(database, table, expected) {
  const actual = database.prepare(`PRAGMA table_info(${table})`).all()
    .map((column) => [column.name, column.type, column.notnull, column.pk]);
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error(`La tabla ${table} no conserva su esquema estricto.`);
  }
}

function readMetadata(database) {
  const rows = database.prepare(`
    SELECT singleton, format, workspace_root_sha256, ledger_id_sha256,
      created_at, genesis_sha256, genesis_signature,
      head_sequence, head_entry_sha256
    FROM isolated_recovery_local_metadata
  `).all();
  if (rows.length !== 1 || rows[0].singleton !== 1) {
    throw new Error("El ledger local no tiene metadata singleton.");
  }
  return rows[0];
}

function assertMetadata(metadata, state) {
  if (metadata.format !== ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT
    || metadata.workspace_root_sha256 !== state.workspaceRootSha256
    || metadata.ledger_id_sha256 !== state.ledgerIdSha256
    || metadata.created_at !== state.createdAt
    || !Number.isSafeInteger(metadata.head_sequence)
    || metadata.head_sequence < 0 || metadata.head_sequence > MAX_ENTRY_COUNT) {
    throw new Error("La metadata del ledger local es invalida.");
  }
  canonicalIso(metadata.created_at, "metadata.createdAt");
  validSha256(metadata.ledger_id_sha256, "metadata.ledgerIdSha256");
  validSha256(metadata.genesis_sha256, "metadata.genesisSha256");
  validSha256(metadata.genesis_signature, "metadata.genesisSignature");
  validSha256(metadata.head_entry_sha256, "metadata.headEntrySha256");
}

function createDescriptor(input) {
  return Object.freeze({
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT,
    workspaceRootSha256: input.workspaceRootSha256,
    ledgerIdSha256: input.ledgerIdSha256,
    createdAt: input.createdAt,
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

function genesisRecord(input) {
  return {
    format: GENESIS_FORMAT,
    workspaceRootSha256: input.workspaceRootSha256,
    ledgerIdSha256: input.ledgerIdSha256,
    createdAt: input.createdAt,
  };
}

function createAnchor(state, sequence, entrySha256) {
  const payload = {
    format: ISOLATED_RECOVERY_LOCAL_LEDGER_ANCHOR_FORMAT,
    workspaceRootSha256: state.workspaceRootSha256,
    ledgerIdSha256: state.ledgerIdSha256,
    sequence,
    entrySha256,
  };
  return Object.freeze({
    ...payload,
    signature: hmacHex(state.signingKey, canonicalJson(payload)),
  });
}

function normalizeAnchor(value, signingKey) {
  assertExactKeys(value, [
    "entrySha256",
    "format",
    "ledgerIdSha256",
    "sequence",
    "signature",
    "workspaceRootSha256",
  ], "ancla");
  const anchor = {
    format: value.format,
    workspaceRootSha256: validSha256(value.workspaceRootSha256, "anchor.workspaceRootSha256"),
    ledgerIdSha256: validSha256(value.ledgerIdSha256, "anchor.ledgerIdSha256"),
    sequence: nonNegativeInteger(value.sequence, "anchor.sequence"),
    entrySha256: validSha256(value.entrySha256, "anchor.entrySha256"),
    signature: validSha256(value.signature, "anchor.signature"),
  };
  if (anchor.format !== ISOLATED_RECOVERY_LOCAL_LEDGER_ANCHOR_FORMAT
    || anchor.sequence > MAX_ENTRY_COUNT
    || !safeEqualHex(anchor.signature, hmacHex(signingKey, canonicalJson({
      format: anchor.format,
      workspaceRootSha256: anchor.workspaceRootSha256,
      ledgerIdSha256: anchor.ledgerIdSha256,
      sequence: anchor.sequence,
      entrySha256: anchor.entrySha256,
    })))) {
    throw new Error("El ancla externa no es autentica.");
  }
  return Object.freeze(anchor);
}

function assertExpectedAnchor(expected, current, signingKey) {
  const normalized = normalizeAnchor(expected, signingKey);
  if (canonicalJson(normalized) !== canonicalJson(current)) {
    throw new Error("La cabeza del ledger no coincide con el ancla externa esperada.");
  }
}

function copyAnchor(anchor) {
  return Object.freeze({ ...anchor });
}

function requiredState(ledger) {
  const state = ledgerState.get(ledger);
  if (!state || state.closed) {
    throw new Error("El ledger debe estar abierto mediante el contrato local versionado.");
  }
  return state;
}

async function canonicalWorkspaceRoot(value) {
  const requested = path.resolve(requiredText(value, "workspaceRootPath"));
  const info = await stat(requested);
  if (!info.isDirectory()) throw new Error("workspaceRootPath debe ser un directorio local.");
  const canonical = await realpath(requested);
  if (pathsEqual(canonical, path.parse(canonical).root)) {
    throw new Error("workspaceRootPath no puede ser la raiz del sistema de archivos.");
  }
  return canonical;
}

async function assertLedgerFile(ledgerPath) {
  const info = await lstat(ledgerPath);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > MAX_LEDGER_BYTES) {
    throw new Error("El ledger local no es un archivo regular verificable.");
  }
  const canonical = await realpath(ledgerPath);
  if (!pathsEqual(canonical, ledgerPath)) {
    throw new Error("El ledger local no puede atravesar enlaces.");
  }
}

async function removeCreatedLedgerFiles(ledgerPath) {
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    try {
      await rm(`${ledgerPath}${suffix}`, { force: true });
    } catch {
      // Solo se intentan artefactos con nombre fijo creados en esta apertura fallida.
    }
  }
}

function normalizeSecret(value, name) {
  if (!(value instanceof Uint8Array) || value.byteLength < 32 || value.byteLength > 4_096) {
    throw new Error(`${name} debe contener entre 32 y 4096 bytes locales.`);
  }
  return Uint8Array.from(value);
}

function validKeyId(value, name) {
  const text = String(value ?? "");
  if (!KEY_ID_PATTERN.test(text)) {
    throw new Error(`${name} debe usar un keyId local valido.`);
  }
  return text;
}

function validSha256(value, name) {
  const text = String(value ?? "");
  if (!SHA256_PATTERN.test(text)) throw new Error(`${name} debe ser SHA-256 hexadecimal.`);
  return text;
}

function normalizedShaList(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} debe ser una lista no vacia.`);
  const hashes = value.map((entry, index) => validSha256(entry, `${name}[${index}]`));
  if (new Set(hashes).size !== hashes.length
    || canonicalJson(hashes) !== canonicalJson([...hashes].sort())) {
    throw new Error(`${name} debe ser unica y ordenada.`);
  }
  return hashes;
}

function canonicalIso(value, name) {
  const text = requiredText(value, name);
  const date = new Date(text);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== text) {
    throw new Error(`${name} debe ser una fecha ISO canonica.`);
  }
  return text;
}

function nonNegativeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} debe ser un entero no negativo.`);
  }
  return value;
}

function requiredText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${name} es obligatorio.`);
  return text;
}

function assertExactKeys(value, expected, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${name} no conserva su forma canonica.`);
  }
}

function hmacHex(signingKey, value) {
  return createHmac("sha256", signingKey).update(value).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqualHex(actual, expected) {
  const text = String(actual ?? "");
  if (!SHA256_PATTERN.test(text) || !SHA256_PATTERN.test(expected)) return false;
  return timingSafeEqual(Buffer.from(text, "hex"), Buffer.from(expected, "hex"));
}

function pathsEqual(first, second) {
  const left = path.resolve(first);
  const right = path.resolve(second);
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function normalizeSql(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().replace(/;$/, "").toLowerCase();
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}
