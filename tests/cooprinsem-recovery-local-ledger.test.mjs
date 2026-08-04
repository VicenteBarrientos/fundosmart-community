import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  appendIsolatedRecoveryKeyringPruneResult,
  appendIsolatedRecoveryKeyringPruneIntent,
  appendIsolatedRecoveryKeyringRotationResult,
  appendIsolatedRecoveryKeyringRotationIntent,
  appendIsolatedRecoverySweepResult,
  appendIsolatedRecoverySweepIntent,
  closeIsolatedRecoveryLocalLedger,
  createIsolatedRecoveryLocalLedger,
  ISOLATED_RECOVERY_LOCAL_LEDGER_ANCHOR_FORMAT,
  ISOLATED_RECOVERY_LOCAL_LEDGER_FILE,
  ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT,
  openIsolatedRecoveryLocalLedger,
  readPendingIsolatedRecoveryLocalIntents,
  readIsolatedRecoveryLocalLedgerAnchor,
  verifyIsolatedRecoveryLocalLedger,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-local-ledger.mjs";

const root = process.cwd();
const LEDGER_KEY = new Uint8Array(32).fill(0x6b);
const WRONG_KEY = new Uint8Array(32).fill(0x77);

test("el ledger persiste un barrido, reabre con ancla y nunca guarda rutas ni claves", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    const ledger = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    assert.equal(ledger.format, ISOLATED_RECOVERY_LOCAL_LEDGER_FORMAT);
    assert.equal(ledger.productWritesEnabled, false);
    assert.equal(ledger.remoteWrites, false);
    assert.doesNotMatch(JSON.stringify(ledger), /workspaceRootPath|signingKey|key_alpha/i);

    const sweptAt = new Date().toISOString();
    const sweepReceipt = emptySweep(ledger.workspaceRootSha256, sweptAt);
    const intent = appendIsolatedRecoverySweepIntent(ledger, {
      keyring: keyring(ledger.workspaceRootSha256, {
        activeKeyId: "key_alpha",
        createdAt: new Date(Date.parse(sweptAt) - 1).toISOString(),
      }),
      requestedAt: new Date(Date.parse(sweptAt) - 1).toISOString(),
    });
    assert.equal(readPendingIsolatedRecoveryLocalIntents(ledger).pendingIntentCount, 1);
    const append = appendIsolatedRecoverySweepResult(ledger, {
      intent,
      reaperReceipt: sweepReceipt,
    });
    assert.equal(append.sequence, 2);
    assert.equal(append.kind, "workspace_sweep");
    assert.equal(append.phase, "result");
    assert.equal(append.replayed, false);
    assert.equal(append.anchor.format, ISOLATED_RECOVERY_LOCAL_LEDGER_ANCHOR_FORMAT);
    const verification = verifyIsolatedRecoveryLocalLedger(ledger, {
      expectedAnchor: append.anchor,
    });
    assert.deepEqual(verification.eventCounts, {
      workspaceSweepCount: 1,
      keyringRotationCount: 0,
      keyringPruneCount: 0,
    });
    assert.equal(verification.sqliteIntegrityVerified, true);
    assert.equal(verification.appendOnlySchemaVerified, true);
    assert.equal(verification.chainVerified, true);
    assert.equal(verification.anchorVerified, true);
    const closed = closeIsolatedRecoveryLocalLedger(ledger);
    assert.equal(verification.operationIntentCount, 1);
    assert.equal(verification.pendingIntentCount, 0);
    assert.equal(closed.entryCount, 2);
    assert.throws(() => readIsolatedRecoveryLocalLedgerAnchor(ledger), /debe estar abierto/);

    const reopened = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: closed.anchor,
    });
    assert.equal(verifyIsolatedRecoveryLocalLedger(reopened).entryCount, 2);
    closeIsolatedRecoveryLocalLedger(reopened);

    const bytes = await readFile(path.join(workspaceRootPath, ISOLATED_RECOVERY_LOCAL_LEDGER_FILE));
    assert.equal(bytes.includes(Buffer.from(LEDGER_KEY)), false);
    assert.doesNotMatch(bytes.toString("latin1"), /key_alpha|key_bravo|fundosmart-ledger-test-/i);
  });
});

test("rotacion, barrido y poda quedan ligados sin persistir keyId crudos", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    const ledger = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    const rootSha256 = ledger.workspaceRootSha256;
    const rotationAt = new Date(Date.now() - 90 * 60_000).toISOString();
    const previous = keyring(rootSha256, {
      activeKeyId: "key_alpha",
      createdAt: new Date(Date.parse(rotationAt) - 1_000).toISOString(),
    });
    const verifyUntil = new Date(Date.parse(rotationAt) + 60 * 60_000).toISOString();
    const rotated = keyring(rootSha256, {
      activeKeyId: "key_bravo",
      verificationKeys: [{ keyId: "key_alpha", verifyUntil }],
      createdAt: rotationAt,
    });
    const rotationIntent = appendIsolatedRecoveryKeyringRotationIntent(ledger, {
      previousKeyring: previous,
      requestedAt: rotationAt,
    });
    const rotation = appendIsolatedRecoveryKeyringRotationResult(ledger, {
      intent: rotationIntent,
      previousKeyring: previous,
      nextKeyring: rotated,
    });
    assert.equal(rotation.sequence, 2);

    const sweptAt = new Date().toISOString();
    const sweepReceipt = emptySweep(rootSha256, sweptAt, [
      ["key_alpha", 0],
      ["key_bravo", 0],
    ], "key_bravo");
    const sweepIntent = appendIsolatedRecoverySweepIntent(ledger, {
      keyring: rotated,
      requestedAt: sweptAt,
    });
    const sweep = appendIsolatedRecoverySweepResult(ledger, {
      intent: sweepIntent,
      reaperReceipt: sweepReceipt,
    });
    assert.equal(sweep.sequence, 4);
    const pruned = keyring(rootSha256, {
      activeKeyId: "key_bravo",
      createdAt: new Date(Date.parse(sweptAt) + 1).toISOString(),
    });
    const pruneIntent = appendIsolatedRecoveryKeyringPruneIntent(ledger, {
      previousKeyring: rotated,
      reaperReceipt: sweepReceipt,
      requestedAt: pruned.createdAt,
    });
    const prune = appendIsolatedRecoveryKeyringPruneResult(ledger, {
      intent: pruneIntent,
      previousKeyring: rotated,
      nextKeyring: pruned,
      reaperReceipt: sweepReceipt,
    });
    assert.equal(prune.sequence, 6);
    const verification = verifyIsolatedRecoveryLocalLedger(ledger);
    assert.deepEqual(verification.eventCounts, {
      workspaceSweepCount: 1,
      keyringRotationCount: 1,
      keyringPruneCount: 1,
    });
    const closed = closeIsolatedRecoveryLocalLedger(ledger);

    const database = new DatabaseSync(path.join(workspaceRootPath, ISOLATED_RECOVERY_LOCAL_LEDGER_FILE), {
      readOnly: true,
    });
    const rows = database.prepare(`
      SELECT sequence, kind, previous_entry_sha256, payload_json, payload_sha256,
        entry_sha256, entry_signature
      FROM isolated_recovery_local_entries ORDER BY sequence
    `).all();
    database.close();
    assert.deepEqual(rows.map((row) => row.sequence), [1, 2, 3, 4, 5, 6]);
    assert.equal(rows[1].previous_entry_sha256, rows[0].entry_sha256);
    assert.equal(rows[2].previous_entry_sha256, rows[1].entry_sha256);
    assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.entry_signature)));
    const persisted = rows.map((row) => row.payload_json).join("\n");
    assert.doesNotMatch(persisted, /key_alpha|key_bravo|signingKey|workspaceRootPath/);
    assert.match(persisted, new RegExp(sha256("key_alpha")));
    assert.match(persisted, new RegExp(sha256("key_bravo")));

    const reopened = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: closed.anchor,
    });
    assert.equal(verifyIsolatedRecoveryLocalLedger(reopened).entryCount, 6);
    closeIsolatedRecoveryLocalLedger(reopened);
  });
});

test("un rollback a un prefijo autentico solo abre con el ancla historica, no con la vigente", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    let ledger = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    const first = appendSweepOperation(
      ledger,
      emptySweep(ledger.workspaceRootSha256, "2026-07-19T10:00:00.000Z"),
    ).result;
    closeIsolatedRecoveryLocalLedger(ledger);
    const ledgerPath = path.join(workspaceRootPath, ISOLATED_RECOVERY_LOCAL_LEDGER_FILE);
    const prefixPath = path.join(workspaceRootPath, "ledger-prefix.sqlite3");
    await copyFile(ledgerPath, prefixPath);

    ledger = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: first.anchor,
    });
    const second = appendSweepOperation(
      ledger,
      emptySweep(ledger.workspaceRootSha256, "2026-07-19T10:01:00.000Z"),
    ).result;
    closeIsolatedRecoveryLocalLedger(ledger);
    await copyFile(prefixPath, ledgerPath);

    await assert.rejects(() => openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: second.anchor,
    }), /no superaron la verificacion/);
    const historical = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: first.anchor,
    });
    assert.equal(verifyIsolatedRecoveryLocalLedger(historical).entryCount, 2);
    closeIsolatedRecoveryLocalLedger(historical);
  });
});

test("alterar, reordenar o abrir con otra clave falla cerrado", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    const ledger = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    const append = appendSweepOperation(
      ledger,
      emptySweep(ledger.workspaceRootSha256, "2026-07-19T11:00:00.000Z"),
    ).result;
    closeIsolatedRecoveryLocalLedger(ledger);
    await assert.rejects(() => openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: WRONG_KEY,
      expectedAnchor: append.anchor,
    }), /ancla|verificacion/);

    const ledgerPath = path.join(workspaceRootPath, ISOLATED_RECOVERY_LOCAL_LEDGER_FILE);
    const database = new DatabaseSync(ledgerPath);
    assert.throws(() => database.exec(
      "UPDATE isolated_recovery_local_entries SET sequence = 2 WHERE sequence = 1",
    ), /append_only|constraint/i);
    database.exec("DROP TRIGGER isolated_recovery_local_entries_no_update");
    database.prepare(`
      UPDATE isolated_recovery_local_entries SET occurred_at = ? WHERE sequence = 1
    `).run("2026-07-19T11:00:01.000Z");
    database.close();
    await assert.rejects(() => openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: append.anchor,
    }), /no superaron la verificacion/);
  });
});

test("dos escritores con la misma ancla no pueden bifurcar ni duplicar un resultado", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    const created = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    const genesisAnchor = readIsolatedRecoveryLocalLedgerAnchor(created);
    closeIsolatedRecoveryLocalLedger(created);
    const firstWriter = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: genesisAnchor,
    });
    const staleWriter = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: genesisAnchor,
    });
    const receipt = emptySweep(firstWriter.workspaceRootSha256, "2026-07-19T12:00:00.000Z");
    const intent = appendIsolatedRecoverySweepIntent(firstWriter, {
      keyring: keyring(firstWriter.workspaceRootSha256, {
        activeKeyId: "key_alpha",
        createdAt: new Date(Date.parse(receipt.sweptAt) - 1).toISOString(),
      }),
      requestedAt: new Date(Date.parse(receipt.sweptAt) - 1).toISOString(),
    });
    assert.throws(() => appendIsolatedRecoverySweepIntent(staleWriter, {
      keyring: keyring(staleWriter.workspaceRootSha256, {
        activeKeyId: "key_alpha",
        createdAt: new Date(Date.parse(receipt.sweptAt) - 1).toISOString(),
      }),
      requestedAt: new Date(Date.parse(receipt.sweptAt) - 1).toISOString(),
    }), /ancla externa|atras/);
    const completed = appendIsolatedRecoverySweepResult(firstWriter, {
      intent,
      reaperReceipt: receipt,
    });
    assert.throws(() => closeIsolatedRecoveryLocalLedger(staleWriter), /ancla externa/);
    const replay = appendIsolatedRecoverySweepResult(firstWriter, {
      intent,
      reaperReceipt: receipt,
    });
    assert.equal(replay.sequence, completed.sequence);
    assert.equal(replay.replayed, true);
    const closed = closeIsolatedRecoveryLocalLedger(firstWriter);
    assert.equal(closed.entryCount, 2);
  });
});

test("una muerte despues de la intencion se reconcilia al reabrir y el resultado es idempotente", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    let ledger = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    const sweptAt = "2026-07-19T13:00:00.000Z";
    const descriptor = keyring(ledger.workspaceRootSha256, {
      activeKeyId: "key_alpha",
      createdAt: "2026-07-19T12:59:00.000Z",
    });
    const intent = appendIsolatedRecoverySweepIntent(ledger, {
      keyring: descriptor,
      requestedAt: "2026-07-19T12:59:59.000Z",
    });
    const crashedAnchor = readIsolatedRecoveryLocalLedgerAnchor(ledger);
    assert.equal(readPendingIsolatedRecoveryLocalIntents(ledger).pendingIntentCount, 1);
    closeIsolatedRecoveryLocalLedger(ledger);

    ledger = await openIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
      expectedAnchor: crashedAnchor,
    });
    const pending = readPendingIsolatedRecoveryLocalIntents(ledger);
    assert.equal(pending.pendingIntentCount, 1);
    assert.equal(pending.intents[0].intentPayloadSha256, intent.payloadSha256);
    const receipt = emptySweep(ledger.workspaceRootSha256, sweptAt);
    const completed = appendIsolatedRecoverySweepResult(ledger, {
      intent,
      reaperReceipt: receipt,
    });
    const replay = appendIsolatedRecoverySweepResult(ledger, {
      intent,
      reaperReceipt: receipt,
    });
    assert.equal(completed.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.entrySha256, completed.entrySha256);
    assert.equal(readPendingIsolatedRecoveryLocalIntents(ledger).pendingIntentCount, 0);
    closeIsolatedRecoveryLocalLedger(ledger);
  });
});

test("un resultado sin intencion o con otro keyring falla cerrado y conserva la intencion", async () => {
  await withLedgerRoot(async (workspaceRootPath) => {
    const ledger = await createIsolatedRecoveryLocalLedger({
      workspaceRootPath,
      signingKey: LEDGER_KEY,
    });
    const descriptor = keyring(ledger.workspaceRootSha256, {
      activeKeyId: "key_alpha",
      createdAt: "2026-07-19T13:59:00.000Z",
    });
    const intent = appendIsolatedRecoverySweepIntent(ledger, {
      keyring: descriptor,
      requestedAt: "2026-07-19T13:59:59.000Z",
    });
    const wrongReceipt = emptySweep(
      ledger.workspaceRootSha256,
      "2026-07-19T14:00:00.000Z",
      [["key_bravo", 0]],
      "key_bravo",
    );
    assert.throws(() => appendIsolatedRecoverySweepResult(ledger, {
      intent,
      reaperReceipt: wrongReceipt,
    }), /no corresponde al keyring/);
    assert.equal(readPendingIsolatedRecoveryLocalIntents(ledger).pendingIntentCount, 1);
    assert.throws(() => appendIsolatedRecoverySweepResult(ledger, {
      intent: { ...intent, phase: "result" },
      reaperReceipt: emptySweep(ledger.workspaceRootSha256, "2026-07-19T14:00:01.000Z"),
    }), /recibo de su intencion/);
    closeIsolatedRecoveryLocalLedger(ledger);
  });
});

test("el ledger es Node-only, local y permanece fuera de API y Worker", async () => {
  const moduleSource = await readFile(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-local-ledger.mjs",
  ), "utf8");
  const route = await readFile(path.join(
    root,
    "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts",
  ), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.match(moduleSource, /new DatabaseSync/);
  assert.match(moduleSource, /BEGIN IMMEDIATE/);
  assert.match(moduleSource, /timingSafeEqual/);
  assert.match(moduleSource, /const ledgerState = new WeakMap\(\)/);
  assert.doesNotMatch(moduleSource, /fetch\s*\(|--remote|wrangler|cloudflare|env\./i);
  assert.doesNotMatch(route, /isolated-recovery-local-ledger|appendIsolatedRecoverySweepResult/);
  assert.doesNotMatch(worker, /fundosmart\.isolated-recovery-local-ledger|appendIsolatedRecoverySweepResult/);
});

function keyring(workspaceRootSha256, input) {
  return Object.freeze({
    format: "fundosmart.isolated-recovery-workspace-keyring.v1",
    workspaceRootSha256,
    activeKeyId: input.activeKeyId,
    verificationKeys: Object.freeze(input.verificationKeys ?? []),
    maxWorkspaceTtlMs: 3_600_000,
    createdAt: input.createdAt,
  });
}

function appendSweepOperation(ledger, receipt) {
  const descriptor = keyring(ledger.workspaceRootSha256, {
    activeKeyId: "key_alpha",
    createdAt: new Date(Date.parse(receipt.sweptAt) - 2).toISOString(),
  });
  const intent = appendIsolatedRecoverySweepIntent(ledger, {
    keyring: descriptor,
    requestedAt: new Date(Date.parse(receipt.sweptAt) - 1).toISOString(),
  });
  return {
    intent,
    result: appendIsolatedRecoverySweepResult(ledger, {
      intent,
      reaperReceipt: receipt,
    }),
  };
}

function emptySweep(
  workspaceRootSha256,
  sweptAt,
  usages = [["key_alpha", 0]],
  activeKeyId = "key_alpha",
) {
  return Object.freeze({
    format: "fundosmart.isolated-recovery-orphan-reaper.v2",
    workspaceRootSha256,
    activeKeyIdSha256: sha256(activeKeyId),
    keyUsage: Object.freeze(usages.map(([keyId, authenticatedWorkspaceCount]) => Object.freeze({
      keyIdSha256: sha256(keyId),
      authenticatedWorkspaceCount,
    })).sort((left, right) => left.keyIdSha256.localeCompare(right.keyIdSha256))),
    candidateWorkspaceCount: 0,
    authenticatedWorkspaceCount: 0,
    unauthenticatedWorkspaceCount: 0,
    markerMissingCount: 0,
    markerInvalidCount: 0,
    unknownKeyIdWorkspaceCount: 0,
    legacyWorkspaceCount: 0,
    unexpiredWorkspaceCount: 0,
    expiredWorkspaceCount: 0,
    liveWorkspaceCount: 0,
    destroyedWorkspaceCount: 0,
    failedWorkspaceCount: 0,
    localArtifactCountDestroyed: 0,
    destructionVerified: true,
    sweptAt,
    productWritesEnabled: false,
    remoteWrites: false,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withLedgerRoot(run) {
  const workspaceRootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-ledger-test-"));
  try {
    await run(workspaceRootPath);
  } finally {
    const resolved = path.resolve(workspaceRootPath);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^fundosmart-ledger-test-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    assert.equal(await pathExists(resolved), false);
  }
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
