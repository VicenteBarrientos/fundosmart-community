import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  EPHEMERAL_ENVIRONMENT_MANIFEST_FORMAT,
  EPHEMERAL_ENVIRONMENT_RECEIPT_FORMAT,
  IsolatedRecoveryEnvironmentCleanupError,
  IsolatedRecoveryEnvironmentExecutionError,
  runInIsolatedRecoveryEphemeralEnvironment,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-ephemeral-environment.mjs";
import {
  runIsolatedRecoveryProcessorStep,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-processor.mjs";
import { prepareRecoveryJobSpec } from "../src/modules/integraciones/cooprinsem/server/recovery-job-rules.mjs";
import {
  coordinateIsolatedRecoveryPreparationEvent,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-state-event-coordinator.mjs";
import {
  createIsolatedRecoveryWorkspaceKeyring,
} from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-workspace-keyring.mjs";

const root = process.cwd();
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };
const TOKEN_HASH = "a".repeat(64);
const WORKSPACE_KEYRING = await createIsolatedRecoveryWorkspaceKeyring({
  activeKeyId: "key_current",
  activeKey: new Uint8Array(32).fill(0x5a),
});

test("ejecuta el procesador en un clon dedicado y destruye objetos y archivos sin tocar el origen", async () => {
  await withSourceFixture(async (fixture) => {
    let localWorkspacePath;
    const execution = await runInIsolatedRecoveryEphemeralEnvironment({
      sourceDatabasePath: fixture.databasePath,
      expectedSourceDatabaseSha256: fixture.sha256,
      recoveryJobId: "recovery-1",
      operator: operatorAttestation(),
      guard,
      workspaceKeyring: WORKSPACE_KEYRING,
    }, async (runtime) => {
      const times = timeSeries(runtime.manifest.createdAt, 10);
      localWorkspacePath = runtime.localWorkspacePath;
      assert.notEqual(path.resolve(runtime.localWorkspacePath), path.resolve(fixture.rootPath));
      assert.equal(runtime.manifest.format, EPHEMERAL_ENVIRONMENT_MANIFEST_FORMAT);
      assert.equal(runtime.manifest.sourceDatabaseSha256, fixture.sha256);
      assert.equal(runtime.manifest.productWritesEnabled, false);
      assert.equal(runtime.manifest.remoteWrites, false);
      assert.equal(Object.isFrozen(runtime.guard), true);
      assert.equal(Object.isFrozen(runtime.objectStore), true);
      assert.notEqual(runtime.guard, guard);
      assert.deepEqual(runtime.guard, guard);

      const actions = [];
      const backupBytes = new TextEncoder().encode("respaldo-previo-efimero");
      const operations = {
        async capturePreRestoreBackup({ objectStore }) {
          const objectKey = "pre-restore/recovery-1";
          await objectStore.put(objectKey, backupBytes, { scope: "isolated" });
          return { objectKey, sha256: sha256Bytes(backupBytes) };
        },
        applyRows({ to }) {
          return { appliedThrough: to };
        },
        verifyRows({ to }) {
          return { verifiedThrough: to, postRestoreSha256: "f".repeat(64) };
        },
      };
      let terminal;
      for (let index = 1; index <= 6; index += 1) {
        terminal = await runIsolatedRecoveryProcessorStep(runtime.database, {
          jobId: "recovery-1",
          leaseToken: "local-worker",
          now: times[index],
          ttlMs: 300_000,
          guard: runtime.guard,
          objectStore: runtime.objectStore,
          operations,
        });
        actions.push(terminal.action);
        assert.equal(terminal.reconciliation.consistent, true, JSON.stringify(terminal.reconciliation));
      }
      return { actions, status: terminal.status };
    });

    assert.deepEqual(execution.result, {
      actions: [
        "lease_claimed",
        "pre_restore_backup_captured",
        "originals_verified",
        "rows_applied",
        "succeeded",
        "terminal",
      ],
      status: "succeeded",
    });
    assert.equal(execution.receipt.format, EPHEMERAL_ENVIRONMENT_RECEIPT_FORMAT);
    assert.equal(execution.receipt.manifestSha256, sha256Bytes(JSON.stringify(execution.manifest)));
    assert.equal(execution.receipt.outcome, "succeeded");
    assert.equal(execution.receipt.objectCountDestroyed, 1);
    assert.ok(execution.receipt.localArtifactCountDestroyed >= 1);
    assert.equal(execution.receipt.sourceDatabaseUnchanged, true);
    assert.equal(execution.receipt.destructionVerified, true);
    assert.equal(await pathExists(localWorkspacePath), false);
    assert.equal(await sha256File(fixture.databasePath), fixture.sha256);

    const source = new DatabaseSync(fixture.databasePath, { readOnly: true });
    assert.equal(source.prepare(`
      SELECT status FROM restore_recovery_jobs WHERE id = 'recovery-1'
    `).get().status, "prepared");
    assert.equal(source.prepare(`
      SELECT COUNT(*) count FROM restore_recovery_events WHERE recovery_job_id = 'recovery-1'
    `).get().count, 1);
    source.close();
    assert.doesNotMatch(JSON.stringify({
      manifest: execution.manifest,
      receipt: execution.receipt,
    }), /recovery-1|operator-local|local-worker|fundosmart-recovery-source|\\|:\//i);
  });
});

test("abre y destruye el clon SQLite aunque su ruta local exceda el límite clásico de Windows", async () => {
  await withLongWorkspaceRoot(async (workspaceRootPath) => {
    const workspaceKeyring = await createIsolatedRecoveryWorkspaceKeyring({
      workspaceRootPath,
      activeKeyId: "key_current",
      activeKey: new Uint8Array(32).fill(0x5a),
    });
    await withSourceFixture(async (fixture) => {
      let clonePath;
      const execution = await runInIsolatedRecoveryEphemeralEnvironment({
        sourceDatabasePath: fixture.databasePath,
        expectedSourceDatabaseSha256: fixture.sha256,
        recoveryJobId: "recovery-1",
        operator: operatorAttestation(),
        guard,
        workspaceRootPath,
        workspaceKeyring,
      }, (runtime) => {
        clonePath = path.join(runtime.localWorkspacePath, "recovery.sqlite");
        assert.ok(clonePath.length >= 260, `ruta de regresión demasiado corta: ${clonePath.length}`);
        runtime.database.exec("BEGIN IMMEDIATE");
        try {
          runtime.database.prepare(`
            UPDATE restore_recovery_jobs SET updated_at = ? WHERE id = 'recovery-1'
          `).run(runtime.manifest.createdAt);
        } finally {
          runtime.database.exec("ROLLBACK");
        }
        return "opened";
      });

      assert.equal(execution.result, "opened");
      assert.equal(execution.receipt.outcome, "succeeded");
      assert.equal(execution.receipt.destructionVerified, true);
      assert.equal(await pathExists(path.dirname(clonePath)), false);
    });
  });
});

test("una excepción sensible se sanitiza y aun produce destrucción verificable", async () => {
  await withSourceFixture(async (fixture) => {
    let localWorkspacePath;
    let caught;
    try {
      await runInIsolatedRecoveryEphemeralEnvironment({
        sourceDatabasePath: fixture.databasePath,
        expectedSourceDatabaseSha256: fixture.sha256,
        recoveryJobId: "recovery-1",
        operator: operatorAttestation(),
        guard,
        workspaceKeyring: WORKSPACE_KEYRING,
      }, async (runtime) => {
        localWorkspacePath = runtime.localWorkspacePath;
        await runtime.objectStore.put("created/a", new Uint8Array([1]));
        await runtime.objectStore.put("created/b", new Uint8Array([2]));
        throw new Error("ruta C:/privada y token super-secreto");
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof IsolatedRecoveryEnvironmentExecutionError);
    assert.equal(caught.code, "isolated_environment_execution_failed");
    assert.doesNotMatch(caught.message, /privada|token|secreto/i);
    assert.equal(caught.cause, undefined);
    assert.equal(caught.receipt.outcome, "failed");
    assert.equal(caught.receipt.objectCountDestroyed, 2);
    assert.equal(caught.receipt.sourceDatabaseUnchanged, true);
    assert.equal(caught.receipt.destructionVerified, true);
    assert.equal(await pathExists(localWorkspacePath), false);
  });
});

test("dos entornos concurrentes aíslan la misma clave lógica en namespaces distintos", async () => {
  await withSourceFixture(async (fixture) => {
    const workspacePaths = [];
    const runEnvironment = (marker) => runInIsolatedRecoveryEphemeralEnvironment({
      sourceDatabasePath: fixture.databasePath,
      expectedSourceDatabaseSha256: fixture.sha256,
      recoveryJobId: "recovery-1",
      operator: operatorAttestation(),
      guard,
      workspaceKeyring: WORKSPACE_KEYRING,
    }, async (runtime) => {
      workspacePaths.push(runtime.localWorkspacePath);
      await runtime.objectStore.put("shared/logical-key", new Uint8Array([marker]));
      await new Promise((resolve) => setImmediate(resolve));
      const stored = await runtime.objectStore.get("shared/logical-key");
      return stored.bytes[0];
    });
    const [first, second] = await Promise.all([runEnvironment(11), runEnvironment(22)]);
    assert.equal(first.result, 11);
    assert.equal(second.result, 22);
    assert.notEqual(first.manifest.objectNamespaceSha256, second.manifest.objectNamespaceSha256);
    assert.equal(first.receipt.objectCountDestroyed, 1);
    assert.equal(second.receipt.objectCountDestroyed, 1);
    assert.equal(first.receipt.destructionVerified, true);
    assert.equal(second.receipt.destructionVerified, true);
    assert.equal(new Set(workspacePaths).size, 2);
    assert.deepEqual(await Promise.all(workspacePaths.map(pathExists)), [false, false]);
  });
});

test("una mutación externa del origen invalida el recibo aunque el clon se destruya", async () => {
  await withSourceFixture(async (fixture) => {
    let localWorkspacePath;
    let caught;
    try {
      await runInIsolatedRecoveryEphemeralEnvironment({
        sourceDatabasePath: fixture.databasePath,
        expectedSourceDatabaseSha256: fixture.sha256,
        recoveryJobId: "recovery-1",
        operator: operatorAttestation(),
        guard,
        workspaceKeyring: WORKSPACE_KEYRING,
      }, (runtime) => {
        localWorkspacePath = runtime.localWorkspacePath;
        const source = new DatabaseSync(fixture.databasePath);
        source.prepare(`
          UPDATE restore_recovery_jobs SET updated_at = ? WHERE id = 'recovery-1'
        `).run(new Date(Date.parse(runtime.manifest.createdAt) + 1_000).toISOString());
        source.close();
      });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof IsolatedRecoveryEnvironmentCleanupError);
    assert.equal(caught.code, "isolated_environment_cleanup_failed");
    assert.equal(caught.receipt.outcome, "cleanup_failed");
    assert.equal(caught.receipt.sourceDatabaseUnchanged, false);
    assert.equal(caught.receipt.destructionVerified, true);
    assert.equal(await pathExists(localWorkspacePath), false);
  });
});

test("rechaza manifiesto, operador, guard y SQLite abierto antes de ejecutar", async () => {
  await withSourceFixture(async (fixture) => {
    let executed = false;
    const execute = () => {
      executed = true;
    };
    const input = {
      sourceDatabasePath: fixture.databasePath,
      expectedSourceDatabaseSha256: fixture.sha256,
      recoveryJobId: "recovery-1",
      operator: operatorAttestation(),
      guard,
      workspaceKeyring: WORKSPACE_KEYRING,
    };
    await assert.rejects(() => runInIsolatedRecoveryEphemeralEnvironment({
      ...input,
      expectedSourceDatabaseSha256: "0".repeat(64),
    }, execute), /huella.*no coincide/i);
    await assert.rejects(() => runInIsolatedRecoveryEphemeralEnvironment({
      ...input,
      operator: { ...input.operator, expiresAt: input.operator.issuedAt },
    }, execute), /como máximo una hora/i);
    const wallClockMs = Date.now();
    await assert.rejects(() => runInIsolatedRecoveryEphemeralEnvironment({
      ...input,
      now: new Date(wallClockMs - 90_000).toISOString(),
      operator: {
        ...input.operator,
        issuedAt: new Date(wallClockMs - 120_000).toISOString(),
        expiresAt: new Date(wallClockMs - 60_000).toISOString(),
      },
    }, execute), /no está vigente/i);
    await assert.rejects(() => runInIsolatedRecoveryEphemeralEnvironment({
      ...input,
      operator: { ...input.operator, capability: "deploy_production" },
    }, execute), /execute_isolated_recovery/);
    await assert.rejects(() => runInIsolatedRecoveryEphemeralEnvironment({
      ...input,
      guard: { target: "production_d1", productWritesEnabled: false },
    }, execute), /SQLite aislada y apagada/);
    await writeFile(`${fixture.databasePath}-wal`, "pending");
    await assert.rejects(() => runInIsolatedRecoveryEphemeralEnvironment(input, execute), /cerrado y sin sidecars/);
    assert.equal(executed, false);
  });
});

test("un clon sin contrato append-only falla cerrado y también se destruye", async () => {
  await withSourceFixture(async (fixture) => {
    const source = new DatabaseSync(fixture.databasePath);
    source.exec("DROP TRIGGER restore_recovery_events_no_delete");
    source.close();
    const alteredSha256 = await sha256File(fixture.databasePath);
    let caught;
    try {
      await runInIsolatedRecoveryEphemeralEnvironment({
        sourceDatabasePath: fixture.databasePath,
        expectedSourceDatabaseSha256: alteredSha256,
        recoveryJobId: "recovery-1",
        operator: operatorAttestation(),
        guard,
        workspaceKeyring: WORKSPACE_KEYRING,
      }, () => assert.fail("no debe ejecutar el callback"));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof IsolatedRecoveryEnvironmentExecutionError);
    assert.doesNotMatch(caught.message, /trigger|append-only|restore_recovery_events/i);
    assert.equal(caught.receipt.outcome, "failed");
    assert.equal(caught.receipt.sourceDatabaseUnchanged, true);
    assert.equal(caught.receipt.destructionVerified, true);
    assert.ok(caught.receipt.localArtifactCountDestroyed >= 1);
  });
});

test("el runner permanece fuera de API, Worker y adaptadores remotos", async () => {
  const moduleSource = await readFile(path.join(
    root,
    "src", "modules", "integraciones", "cooprinsem", "server",
    "isolated-recovery-ephemeral-environment.mjs",
  ), "utf8");
  const route = await readFile(path.join(
    root,
    "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts",
  ), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.doesNotMatch(moduleSource, /fetch\s*\(|--remote|wrangler|env\.(?:DB|FILES)|cloudflare|\bd1\b|\br2\b/i);
  assert.doesNotMatch(route, /isolated-recovery-ephemeral-environment|runInIsolatedRecoveryEphemeralEnvironment/);
  assert.doesNotMatch(worker, /runInIsolatedRecoveryEphemeralEnvironment|fundosmart\.isolated-recovery-environment-manifest\.v1/);
  assert.match(moduleSource, /createAuthenticatedIsolatedRecoveryWorkspace\(/);
  assert.match(moduleSource, /destroyAuthenticatedIsolatedRecoveryWorkspace\(/);
  assert.match(moduleSource, /new DatabaseSync\(path\.toNamespacedPath\(clonePath\)\)/);
});

async function withLongWorkspaceRoot(run) {
  const containerPath = await mkdtemp(path.join(tmpdir(), "fundosmart-long-workspace-"));
  const workspaceRootPath = path.join(containerPath, `nested-${"x".repeat(96)}`);
  try {
    await mkdir(workspaceRootPath);
    await run(workspaceRootPath);
  } finally {
    const resolved = path.resolve(containerPath);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^fundosmart-long-workspace-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

async function withSourceFixture(run) {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "fundosmart-recovery-source-"));
  const databasePath = path.join(sourceRoot, "source.sqlite");
  const createdAt = new Date(Date.now() - 20_000).toISOString();
  try {
    const database = new DatabaseSync(databasePath);
    for (const name of (await readdir(path.join(root, "drizzle")))
      .filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql")
      .sort()) {
      database.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
        .replaceAll("--> statement-breakpoint", ""));
    }
    database.exec("PRAGMA foreign_keys = ON");
    seedConfirmation(database, createdAt);
    const prepared = coordinateIsolatedRecoveryPreparationEvent(database, {
      spec: prepareRecoveryJobSpec({
        jobId: "recovery-1",
        confirmationTokenId: "confirmation-1",
        binding: confirmationBinding(),
        originalFiles: [],
        expectedRowCount: 0,
        now: createdAt,
      }),
      tokenSha256: TOKEN_HASH,
      guard,
    });
    assert.equal(prepared.changed, true);
    database.close();
    await run({
      rootPath: sourceRoot,
      databasePath,
      createdAt,
      sha256: await sha256File(databasePath),
    });
  } finally {
    const resolved = path.resolve(sourceRoot);
    assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
    assert.match(path.basename(resolved), /^fundosmart-recovery-source-/);
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

function seedConfirmation(database, createdAt) {
  database.prepare("INSERT INTO organizations (id, name, created_at) VALUES ('org-fundosmart', 'FundoSmart', ?)")
    .run(createdAt);
  database.prepare("INSERT INTO fields (id, organization_id, name, created_at) VALUES ('field-1', 'org-fundosmart', 'Fundo 1', ?)")
    .run(createdAt);
  database.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at
    ) VALUES ('confirmation-1', 'org-fundosmart', 'field-1', 'owner@example.com',
      ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    TOKEN_HASH,
    "b".repeat(64),
    "c".repeat(64),
    "d".repeat(64),
    new Date(Date.parse(createdAt) + 3_600_000).toISOString(),
    createdAt,
    createdAt,
  );
}

function confirmationBinding() {
  return {
    actorEmail: "owner@example.com",
    organizationId: "org-fundosmart",
    fieldId: "field-1",
    backupSha256: "b".repeat(64),
    snapshotSha256: "c".repeat(64),
    planSha256: "d".repeat(64),
  };
}

function operatorAttestation() {
  const nowMs = Date.now();
  return {
    operatorId: "operator-local",
    capability: "execute_isolated_recovery",
    issuedAt: new Date(nowMs - 1_000).toISOString(),
    expiresAt: new Date(nowMs + 30 * 60_000).toISOString(),
  };
}

function timeSeries(origin, count) {
  const base = Date.parse(origin) + 2_000;
  return Array.from({ length: count }, (_, index) => new Date(base + index * 1_000).toISOString());
}

async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
