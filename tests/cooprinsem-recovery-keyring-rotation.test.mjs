import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAuthenticatedIsolatedRecoveryWorkspace,
  destroyAuthenticatedIsolatedRecoveryWorkspace,
  sweepIsolatedRecoveryOrphanWorkspaces,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-orphan-reaper.mjs";
import {
  createIsolatedRecoveryWorkspaceKeyring,
  ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
  ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT,
  pruneIsolatedRecoveryWorkspaceKeyring,
  readActiveIsolatedRecoveryWorkspaceKey,
  rotateIsolatedRecoveryWorkspaceKeyring,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-workspace-keyring.mjs";

const root = process.cwd();
const KEY_A = new Uint8Array(32).fill(0x41);
const KEY_B = new Uint8Array(32).fill(0x42);
const KEY_C = new Uint8Array(32).fill(0x43);
const KEY_D = new Uint8Array(32).fill(0x44);
const KEY_E = new Uint8Array(32).fill(0x45);

test("el descriptor del keyring es publico pero sus secretos quedan fuera y se copian", async () => {
  await withKeyringRoot(async (workspaceRootPath) => {
    const keyring = await createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_alpha",
      activeKey: KEY_A,
    });
    assert.equal(keyring.format, ISOLATED_RECOVERY_WORKSPACE_KEYRING_FORMAT);
    assert.equal(keyring.maxWorkspaceTtlMs, ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS);
    assert.deepEqual(keyring.verificationKeys, []);
    assert.deepEqual(Object.keys(keyring).sort(), [
      "activeKeyId",
      "createdAt",
      "format",
      "maxWorkspaceTtlMs",
      "verificationKeys",
      "workspaceRootSha256",
    ]);
    assert.doesNotMatch(JSON.stringify(keyring), /activeKey"|"0":|workspaceKey|secret/i);
    const active = readActiveIsolatedRecoveryWorkspaceKey(
      keyring,
      keyring.workspaceRootSha256,
    );
    active.key[0] = 0;
    assert.equal(readActiveIsolatedRecoveryWorkspaceKey(
      keyring,
      keyring.workspaceRootSha256,
    ).key[0], KEY_A[0]);
    assert.throws(() => readActiveIsolatedRecoveryWorkspaceKey(
      keyring,
      "0".repeat(64),
    ), /no pertenece a la raiz/);
    const createdAt = new Date().toISOString();
    await assert.rejects(() => createAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspaceKeyring: keyring,
      workspaceId: randomUUID(),
      manifestSha256: "d".repeat(64),
      createdAt,
      expiresAt: new Date(
        Date.parse(createdAt) + ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS + 1,
      ).toISOString(),
    }), /como maximo una hora/);

    const rotated = rotateIsolatedRecoveryWorkspaceKeyring(keyring, {
      nextKeyId: "key_bravo",
      nextKey: KEY_B,
    });
    assert.equal(rotated.activeKeyId, "key_bravo");
    assert.equal(rotated.verificationKeys.length, 1);
    assert.equal(rotated.verificationKeys[0].keyId, "key_alpha");
    assert.equal(
      Date.parse(rotated.verificationKeys[0].verifyUntil) - Date.parse(rotated.createdAt),
      ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS,
    );
    assert.equal(keyring.activeKeyId, "key_alpha");
  });
});

test("las rotaciones rapidas nunca descartan una generacion aun necesaria", async () => {
  await withKeyringRoot(async (workspaceRootPath) => {
    let keyring = await createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_alpha",
      activeKey: KEY_A,
    });
    keyring = rotateIsolatedRecoveryWorkspaceKeyring(keyring, {
      nextKeyId: "key_bravo",
      nextKey: KEY_B,
    });
    keyring = rotateIsolatedRecoveryWorkspaceKeyring(keyring, {
      nextKeyId: "key_charlie",
      nextKey: KEY_C,
    });
    keyring = rotateIsolatedRecoveryWorkspaceKeyring(keyring, {
      nextKeyId: "key_delta",
      nextKey: KEY_D,
    });
    assert.equal(keyring.verificationKeys.length, 3);
    assert.throws(() => rotateIsolatedRecoveryWorkspaceKeyring(keyring, {
      nextKeyId: "key_echo",
      nextKey: KEY_E,
    }), /maximo cuatro claves/);
    assert.throws(() => rotateIsolatedRecoveryWorkspaceKeyring(keyring, {
      nextKeyId: "key_alpha",
      nextKey: KEY_E,
    }), /reutilizar un keyId/);
    assert.deepEqual(keyring.verificationKeys.map((entry) => entry.keyId), [
      "key_alpha",
      "key_bravo",
      "key_charlie",
    ]);
  });
});

test("una clave vencida solo se poda con barrido posterior, limpio y uso cero", async () => {
  await withKeyringRoot(async (workspaceRootPath) => {
    const verifyUntil = new Date(Date.now() - 2_000).toISOString();
    const keyring = await createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_bravo",
      activeKey: KEY_B,
      verificationKeys: [{ keyId: "key_alpha", key: KEY_A, verifyUntil }],
    });
    const receipt = reaperReceipt(keyring, {
      sweptAt: new Date().toISOString(),
      oldKeyUsage: 0,
    });
    const pruned = pruneIsolatedRecoveryWorkspaceKeyring(keyring, { reaperReceipt: receipt });
    assert.deepEqual(pruned.verificationKeys, []);

    const used = pruneIsolatedRecoveryWorkspaceKeyring(keyring, {
      reaperReceipt: reaperReceipt(keyring, {
        sweptAt: new Date().toISOString(),
        oldKeyUsage: 1,
      }),
    });
    assert.equal(used.verificationKeys.length, 1);
    const stale = pruneIsolatedRecoveryWorkspaceKeyring(keyring, {
      reaperReceipt: reaperReceipt(keyring, {
        sweptAt: new Date(Date.parse(verifyUntil) - 1_000).toISOString(),
        oldKeyUsage: 0,
      }),
    });
    assert.equal(stale.verificationKeys.length, 1);
    assert.throws(() => pruneIsolatedRecoveryWorkspaceKeyring(keyring, {
      reaperReceipt: { ...receipt, destructionVerified: false },
    }), /no autoriza podar/);
    assert.throws(() => pruneIsolatedRecoveryWorkspaceKeyring(keyring, {
      reaperReceipt: { ...receipt, workspaceRootSha256: "0".repeat(64) },
    }), /no autoriza podar/);
  });
});

test("el keyring nuevo sigue autenticando nombres HMAC v1 sin keyId", async () => {
  await withKeyringRoot(async (workspaceRootPath) => {
    const keyring = await createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_legacy",
      activeKey: KEY_A,
    });
    const legacyWorkspacePath = await createLegacyWorkspace(workspaceRootPath, KEY_A);
    const receipt = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring: keyring,
    });
    assert.equal(receipt.authenticatedWorkspaceCount, 1);
    assert.equal(receipt.legacyWorkspaceCount, 1);
    assert.equal(receipt.markerMissingCount, 0);
    assert.equal(receipt.markerInvalidCount, 0);
    assert.equal(receipt.unexpiredWorkspaceCount, 1);
    assert.deepEqual(receipt.keyUsage, [{
      keyIdSha256: sha256("key_legacy"),
      authenticatedWorkspaceCount: 1,
    }]);
    await destroyAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspacePath: legacyWorkspacePath,
      workspaceKeyring: keyring,
    });
    assert.equal(await pathExists(legacyWorkspacePath), false);
  });
});

test("el keyring y su rotacion permanecen fuera de API, Worker y persistencia", async () => {
  const moduleSource = await readFile(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-workspace-keyring.mjs",
  ), "utf8");
  const route = await readFile(path.join(
    root,
    "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts",
  ), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.doesNotMatch(moduleSource, /fetch\s*\(|--remote|wrangler|env\.|cloudflare|\bd1\b|\br2\b|writeFile|appendFile/i);
  assert.doesNotMatch(route, /rotateIsolatedRecoveryWorkspaceKeyring|isolated-recovery-workspace-keyring/);
  assert.doesNotMatch(worker, /rotateIsolatedRecoveryWorkspaceKeyring|fundosmart\.isolated-recovery-workspace-keyring\.v1/);
  assert.match(moduleSource, /const keyringState = new WeakMap\(\)/);
  assert.match(moduleSource, /ISOLATED_RECOVERY_MAX_WORKSPACE_TTL_MS/);
});

function reaperReceipt(keyring, { sweptAt, oldKeyUsage }) {
  return {
    format: "fundosmart.isolated-recovery-orphan-reaper.v2",
    workspaceRootSha256: keyring.workspaceRootSha256,
    destructionVerified: true,
    failedWorkspaceCount: 0,
    sweptAt,
    keyUsage: [
      { keyIdSha256: sha256("key_alpha"), authenticatedWorkspaceCount: oldKeyUsage },
      { keyIdSha256: sha256("key_bravo"), authenticatedWorkspaceCount: 0 },
    ],
  };
}

async function createLegacyWorkspace(workspaceRootPath, signingKey) {
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const workspaceId = randomUUID();
  const workspaceRootSha256 = sha256(workspaceRootPath);
  const payload = {
    format: "fundosmart.isolated-recovery-workspace-marker.v1",
    workspaceId,
    workspaceRootSha256,
    createdAt,
    expiresAt,
    ownerPid: process.pid,
  };
  const signature = createHmac("sha256", signingKey)
    .update(JSON.stringify(payload))
    .digest("hex");
  const workspaceName = [
    "fundosmart-isolated-recovery-v1",
    Date.parse(createdAt),
    Date.parse(expiresAt),
    process.pid,
    workspaceId,
    signature,
  ].join("-");
  const workspacePath = path.join(workspaceRootPath, workspaceName);
  await mkdir(workspacePath);
  const markerPayload = {
    format: payload.format,
    workspaceName,
    workspaceId,
    workspaceRootSha256,
    manifestSha256: "d".repeat(64),
    createdAt,
    expiresAt,
    ownerPid: process.pid,
  };
  const markerSignature = createHmac("sha256", signingKey)
    .update(JSON.stringify(markerPayload))
    .digest("hex");
  await writeFile(
    path.join(workspacePath, ".fundosmart-recovery-workspace.json"),
    `${JSON.stringify({ ...markerPayload, signature: markerSignature })}\n`,
  );
  await writeFile(path.join(workspacePath, "legacy.bin"), "legacy");
  return workspacePath;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function withKeyringRoot(run) {
  const workspaceRootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-keyring-test-"));
  try {
    await run(workspaceRootPath);
  } finally {
    const resolved = path.resolve(workspaceRootPath);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^fundosmart-keyring-test-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
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
