import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createAuthenticatedIsolatedRecoveryWorkspace,
  destroyAuthenticatedIsolatedRecoveryWorkspace,
  ISOLATED_RECOVERY_ORPHAN_REAPER_RECEIPT_FORMAT,
  ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE,
  sweepIsolatedRecoveryOrphanWorkspaces,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-orphan-reaper.mjs";
import {
  createIsolatedRecoveryWorkspaceKeyring,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-workspace-keyring.mjs";

const root = process.cwd();
const SIGNING_KEY = new Uint8Array(32).fill(0x6b);
const WRONG_SIGNING_KEY = new Uint8Array(32).fill(0x31);
const MANIFEST_SHA256 = "d".repeat(64);

test("una muerte abrupta conserva hasta expirar y luego destruye solo el workspace autenticado", async (t) => {
  await withReaperRoot(async (workspaceRootPath) => {
    const workspaceKeyring = await keyringFor(workspaceRootPath, "key_current", SIGNING_KEY);
    const wrongKeyring = await keyringFor(workspaceRootPath, "key_wrong", WRONG_SIGNING_KEY);
    const forgedPath = path.join(
      workspaceRootPath,
      "fundosmart-isolated-recovery-v1-0000000000000-forged",
    );
    await mkdir(forgedPath);
    const readyPath = path.join(workspaceRootPath, "crash-owner-ready.json");
    const child = spawnCrashOwner({ workspaceRootPath, readyPath, signingKey: SIGNING_KEY });
    const ready = await waitForReady(readyPath, child);
    assert.equal(path.dirname(ready.workspacePath), workspaceRootPath);
    t.mock.timers.enable({
      apis: ["Date"],
      now: Date.parse(ready.expiresAt) - 1,
    });
    const exited = once(child, "exit");
    assert.equal(child.kill("SIGKILL"), true);
    await exited;
    await rm(path.join(ready.workspacePath, ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE), { force: false });

    const beforeExpiry = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring,
    });
    assert.equal(beforeExpiry.candidateWorkspaceCount, 2);
    assert.equal(beforeExpiry.authenticatedWorkspaceCount, 1);
    assert.equal(beforeExpiry.unauthenticatedWorkspaceCount, 1);
    assert.equal(beforeExpiry.markerMissingCount, 1);
    assert.equal(beforeExpiry.unexpiredWorkspaceCount, 1);
    assert.equal(beforeExpiry.destroyedWorkspaceCount, 0);
    assert.equal(await pathExists(ready.workspacePath), true);

    t.mock.timers.setTime(Date.parse(ready.expiresAt) + 75);
    const wrongKey = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring: wrongKeyring,
    });
    assert.equal(wrongKey.authenticatedWorkspaceCount, 0);
    assert.equal(wrongKey.unauthenticatedWorkspaceCount, 2);
    assert.equal(wrongKey.unknownKeyIdWorkspaceCount, 1);
    assert.equal(wrongKey.destroyedWorkspaceCount, 0);

    const receipt = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring,
    });
    assert.equal(receipt.format, ISOLATED_RECOVERY_ORPHAN_REAPER_RECEIPT_FORMAT);
    assert.equal(
      receipt.workspaceRootSha256,
      createHash("sha256").update(workspaceRootPath).digest("hex"),
    );
    assert.equal(receipt.authenticatedWorkspaceCount, 1);
    assert.equal(receipt.unauthenticatedWorkspaceCount, 1);
    assert.equal(receipt.markerMissingCount, 1);
    assert.equal(receipt.expiredWorkspaceCount, 1);
    assert.equal(receipt.liveWorkspaceCount, 0);
    assert.equal(receipt.destroyedWorkspaceCount, 1);
    assert.equal(receipt.failedWorkspaceCount, 0);
    assert.ok(receipt.localArtifactCountDestroyed >= 1);
    assert.equal(receipt.destructionVerified, true);
    assert.equal(receipt.productWritesEnabled, false);
    assert.equal(receipt.remoteWrites, false);
    assert.equal(
      receipt.activeKeyIdSha256,
      createHash("sha256").update("key_current").digest("hex"),
    );
    assert.deepEqual(receipt.keyUsage, [{
      keyIdSha256: createHash("sha256").update("key_current").digest("hex"),
      authenticatedWorkspaceCount: 1,
    }]);
    assert.equal(await pathExists(ready.workspacePath), false);
    assert.equal(await pathExists(forgedPath), true);
    assert.doesNotMatch(JSON.stringify(receipt), /key_current|workspacePath|workspaceId|signing|crash-owner|\\|:\//i);
  });
});

test("el archivo marcador alterado o ausente no anula el marcador HMAC atomico", async () => {
  await withReaperRoot(async (workspaceRootPath) => {
    const workspaceKeyring = await keyringFor(workspaceRootPath, "key_current", SIGNING_KEY);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + 3_600_000).toISOString();
    const workspace = await createAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspaceKeyring,
      workspaceId: randomUUID(),
      manifestSha256: MANIFEST_SHA256,
      createdAt,
      expiresAt,
    });
    const markerPath = path.join(workspace.workspacePath, ISOLATED_RECOVERY_WORKSPACE_MARKER_FILE);
    const markerBytes = await readFile(markerPath);
    const altered = JSON.parse(markerBytes.toString("utf8"));
    altered.signature = "0".repeat(64);
    await writeFile(markerPath, `${JSON.stringify(altered)}\n`);

    const invalid = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring,
    });
    assert.equal(invalid.markerInvalidCount, 1);
    assert.equal(invalid.authenticatedWorkspaceCount, 1);
    assert.equal(invalid.unexpiredWorkspaceCount, 1);
    assert.equal(invalid.destroyedWorkspaceCount, 0);
    assert.equal(await pathExists(workspace.workspacePath), true);

    await rm(markerPath, { force: false });
    const missing = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring,
    });
    assert.equal(missing.markerMissingCount, 1);
    assert.equal(missing.authenticatedWorkspaceCount, 1);
    assert.equal(missing.unexpiredWorkspaceCount, 1);
    assert.equal(missing.destroyedWorkspaceCount, 0);

    await writeFile(markerPath, markerBytes, { flag: "wx", mode: 0o600 });
    const protectedPath = path.join(workspaceRootPath, "protected-outside-workspace");
    await mkdir(protectedPath);
    const protectedFile = path.join(protectedPath, "must-survive.txt");
    await writeFile(protectedFile, "preserve");
    await symlink(
      protectedPath,
      path.join(workspace.workspacePath, "external-link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const destroyed = await destroyAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspacePath: workspace.workspacePath,
      workspaceKeyring,
    });
    assert.equal(destroyed.localArtifactCountDestroyed, 2);
    assert.equal(await pathExists(workspace.workspacePath), false);
    assert.equal(await readFile(protectedFile, "utf8"), "preserve");
  });
});

test("un workspace vencido cuyo proceso propietario sigue vivo se conserva", async () => {
  await withReaperRoot(async (workspaceRootPath) => {
    await assert.rejects(() => createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_short",
      activeKey: new Uint8Array(31),
    }), /entre 32 y 4096 bytes/);
    const workspaceKeyring = await keyringFor(workspaceRootPath, "key_current", SIGNING_KEY);
    await assert.rejects(() => sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath: path.parse(workspaceRootPath).root,
      workspaceKeyring,
    }), /raiz del sistema de archivos/);
    const createdAt = new Date(Date.now() - 2_000).toISOString();
    const expiresAt = new Date(Date.now() - 1_000).toISOString();
    const workspace = await createAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspaceKeyring,
      workspaceId: randomUUID(),
      manifestSha256: MANIFEST_SHA256,
      createdAt,
      expiresAt,
    });
    const receipt = await sweepIsolatedRecoveryOrphanWorkspaces({
      workspaceRootPath,
      workspaceKeyring,
    });
    assert.equal(receipt.authenticatedWorkspaceCount, 1);
    assert.equal(receipt.expiredWorkspaceCount, 1);
    assert.equal(receipt.liveWorkspaceCount, 1);
    assert.equal(receipt.destroyedWorkspaceCount, 0);
    assert.equal(await pathExists(workspace.workspacePath), true);
    await destroyAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspacePath: workspace.workspacePath,
      workspaceKeyring,
    });
  });
});

test("el marcador y el recolector permanecen fuera de API, Worker y adaptadores remotos", async () => {
  const moduleSource = await readFile(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-orphan-reaper.mjs",
  ), "utf8");
  const route = await readFile(path.join(
    root,
    "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts",
  ), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.doesNotMatch(moduleSource, /fetch\s*\(|--remote|wrangler|env\.(?:DB|FILES)|cloudflare|\bd1\b|\br2\b/i);
  assert.doesNotMatch(route, /sweepIsolatedRecoveryOrphanWorkspaces|isolated-recovery-orphan-reaper/);
  assert.doesNotMatch(worker, /sweepIsolatedRecoveryOrphanWorkspaces|fundosmart\.isolated-recovery-orphan-reaper\.v2/);
  assert.match(moduleSource, /timingSafeEqual/);
  assert.match(moduleSource, /process\.kill\(pid, 0\)/);
  assert.match(moduleSource, /assertDirectChild\(workspaceRootPath, workspacePath\)/);
  assert.match(moduleSource, /rm\(workspacePath, \{ recursive: true, force: false/);
  assert.doesNotMatch(moduleSource, /input\?\.now/);
});

function spawnCrashOwner({ workspaceRootPath, readyPath, signingKey }) {
  const moduleUrl = pathToFileURL(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-orphan-reaper.mjs",
  )).href;
  const keyringModuleUrl = pathToFileURL(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-workspace-keyring.mjs",
  )).href;
  const source = `
    import { randomUUID } from "node:crypto";
    import { writeFile } from "node:fs/promises";
    import path from "node:path";
    import { createAuthenticatedIsolatedRecoveryWorkspace } from ${JSON.stringify(moduleUrl)};
    import { createIsolatedRecoveryWorkspaceKeyring } from ${JSON.stringify(keyringModuleUrl)};
    const [workspaceRootPath, readyPath, signingKeyHex] = process.argv.slice(1);
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    const workspaceKeyring = await createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_current",
      activeKey: Buffer.from(signingKeyHex, "hex"),
    });
    const workspace = await createAuthenticatedIsolatedRecoveryWorkspace({
      workspaceRootPath,
      workspaceKeyring,
      workspaceId: randomUUID(),
      manifestSha256: "${MANIFEST_SHA256}",
      createdAt,
      expiresAt,
    });
    await writeFile(path.join(workspace.workspacePath, "pending.bin"), "pending");
    await writeFile(readyPath, JSON.stringify({ workspacePath: workspace.workspacePath, expiresAt }));
    setInterval(() => {}, 1000);
  `;
  return spawn(process.execPath, [
    "--input-type=module",
    "--eval",
    source,
    workspaceRootPath,
    readyPath,
    Buffer.from(signingKey).toString("hex"),
  ], { stdio: "ignore", windowsHide: true });
}

function keyringFor(workspaceRootPath, activeKeyId, activeKey) {
  return createIsolatedRecoveryWorkspaceKeyring({
    workspaceRootPath,
    activeKeyId,
    activeKey,
  });
}

async function waitForReady(readyPath, child) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      return JSON.parse(await readFile(readyPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    if (child.exitCode !== null) throw new Error("El proceso de prueba termino antes de crear el marcador.");
    await delay(20);
  }
  throw new Error("El proceso de prueba no creo el marcador a tiempo.");
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withReaperRoot(run) {
  const workspaceRootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-reaper-test-"));
  try {
    await run(workspaceRootPath);
  } finally {
    const resolved = path.resolve(workspaceRootPath);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^fundosmart-reaper-test-/);
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
