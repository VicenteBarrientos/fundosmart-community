import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  FUNDOSMART_BACKUP_FORMAT,
  sha256Hex,
} from "../../src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import { createIsolatedMemoryObjectStore } from "../../src/modules/integraciones/cooprinsem/server/isolated-recovery-processor.mjs";
import { runIsolatedRecoveryRehearsal } from "../../src/modules/integraciones/cooprinsem/server/isolated-recovery-rehearsal.mjs";
import {
  restorePlanSha256,
  restoreSnapshotSha256,
} from "../../src/modules/integraciones/cooprinsem/server/restore-confirmation-rules.mjs";
import {
  buildPortableRestorePlan,
  validatePortableBackup,
} from "../../src/modules/integraciones/cooprinsem/server/restore-rules.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const ARTIFACT_DIRECTORY = path.join(REPOSITORY_ROOT, ".wrangler", "e2e-artifacts");
const FAILURE_SCREENSHOT = path.join(ARTIFACT_DIRECTORY, "critical-journeys.png");
const FAILURE_DIAGNOSTICS = path.join(ARTIFACT_DIRECTORY, "critical-journeys.json");
const COMMAND_TIMEOUT_MS = 120_000;
const JOURNEY_TIMEOUT_MS = 285_000;
const POLL_INTERVAL_MS = 200;
const TEST_FIELD_NAME = "Fundo E2E";
const TEST_FIELD_LOCATION = "Osorno E2E";
const TEST_PADDOCK_NAME = "Potrero 1";
const TEST_IMPORT_FILENAME = "PreDetimp-e2e.dbf";
const TEST_ANIMAL_TAG = "1001";
const TEST_COOPRINSEM_FIELD_CODE = "E2E0001";
const TEST_OFFLINE_CONDITION = "Control sanitario E2E";
const TEST_OFFLINE_PRODUCT = "Producto E2E";
const TEST_REVOKED_PADDOCK_NAME = "No persistir tras cambio de rol";
const SAFE_ENVIRONMENT_KEYS = [
  "APPDATA",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NUMBER_OF_PROCESSORS",
  "OS",
  "PATH",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, "[email]")
    .replace(/((?:set-)?cookie|authorization)\s*[:=][^\r\n]*/giu, "$1=[redacted]")
    .replace(/(__Host-|__Secure-)?fundosmart_[A-Za-z0-9_-]+=[^;\s]*/gu, "[cookie]");
}

function appendTail(current, chunk, maximum = 16_000) {
  return `${current}${sanitizeDiagnostic(chunk)}`.slice(-maximum);
}

async function isExecutable(candidate) {
  if (!candidate) return false;
  try {
    await access(candidate, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function executableFromPath(names) {
  const directories = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")
    : [""];
  for (const directory of directories) {
    for (const name of names) {
      for (const extension of extensions) {
        const candidate = path.join(directory, process.platform === "win32" ? `${name}${extension}` : name);
        if (await isExecutable(candidate)) return candidate;
      }
    }
  }
  return null;
}

async function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.GOOGLE_CHROME_SHIM,
    process.platform === "win32" && process.env.ProgramFiles
      ? path.join(process.env.ProgramFiles, "Google", "Chrome", "Application", "chrome.exe")
      : null,
    process.platform === "win32" && process.env["ProgramFiles(x86)"]
      ? path.join(process.env["ProgramFiles(x86)"], "Google", "Chrome", "Application", "chrome.exe")
      : null,
    process.platform === "win32" && process.env.LOCALAPPDATA
      ? path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")
      : null,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : null,
    process.platform === "darwin" ? "/Applications/Chromium.app/Contents/MacOS/Chromium" : null,
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }

  const fromPath = await executableFromPath([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
  ]);
  if (fromPath) return fromPath;
  throw new Error("No se encontró Chrome o Chromium. Define CHROME_PATH con su ejecutable.");
}

function packageExecutable(packageName, relativeExecutable) {
  const require = createRequire(path.join(REPOSITORY_ROOT, "package.json"));
  const packagePath = require.resolve(`${packageName}/package.json`);
  return path.join(path.dirname(packagePath), relativeExecutable);
}

function isolatedEnvironment(overrides = {}) {
  const environment = {};
  for (const name of SAFE_ENVIRONMENT_KEYS) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return { ...environment, ...overrides };
}

async function runCommand(executable, args, { environment, label, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output = appendTail(output, chunk);
    });
    child.stderr.on("data", (chunk) => {
      output = appendTail(output, chunk);
    });
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label ?? executable} superó ${timeoutMs} ms.`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(`${label ?? executable} terminó con ${code ?? signal}.\n${output}`));
    });
  });
}

async function writeSyntheticCooprinsemDbf(filePath) {
  const fields = [
    { name: "NUMPREDIO", type: "C", length: 8 },
    { name: "FCONTROL", type: "D", length: 8 },
    { name: "NUMVACA", type: "N", length: 8 },
    { name: "NOMBRE", type: "C", length: 12 },
    { name: "RP", type: "C", length: 10 },
    { name: "LECHE", type: "N", length: 8, decimals: 1 },
    { name: "CODBARRA", type: "C", length: 13 },
    { name: "LECHEPM", type: "N", length: 8, decimals: 2 },
    { name: "LECHEAM", type: "N", length: 8, decimals: 2 },
    { name: "LECHE3RA", type: "N", length: 8, decimals: 2 },
  ];
  const record = {
    NUMPREDIO: TEST_COOPRINSEM_FIELD_CODE,
    FCONTROL: "20260729",
    NUMVACA: Number(TEST_ANIMAL_TAG),
    NOMBRE: "VACA-E2E",
    RP: "E2E-RP",
    LECHE: 10,
    CODBARRA: "0000000001001",
    LECHEPM: 4,
    LECHEAM: 6,
    LECHE3RA: 0,
  };
  const encoder = new TextEncoder();
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((total, field) => total + field.length, 0);
  const bytes = new Uint8Array(headerLength + recordLength + 1);
  const view = new DataView(bytes.buffer);

  bytes.fill(0x20);
  bytes[0] = 0x30;
  view.setUint32(4, 1, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);

  fields.forEach((field, index) => {
    const offset = 32 + index * 32;
    bytes.fill(0, offset, offset + 32);
    bytes.set(encoder.encode(field.name).subarray(0, 11), offset);
    bytes[offset + 11] = field.type.charCodeAt(0);
    bytes[offset + 16] = field.length;
    bytes[offset + 17] = field.decimals ?? 0;
  });
  bytes[headerLength - 1] = 0x0d;
  bytes[headerLength] = 0x20;

  let fieldOffset = headerLength + 1;
  for (const field of fields) {
    const value = field.type === "N"
      ? (field.decimals ? Number(record[field.name]).toFixed(field.decimals) : String(record[field.name]))
        .padStart(field.length, " ")
        .slice(-field.length)
      : String(record[field.name]).padEnd(field.length, " ").slice(0, field.length);
    bytes.set(encoder.encode(value), fieldOffset);
    fieldOffset += field.length;
  }
  bytes[bytes.length - 1] = 0x1a;
  await writeFile(filePath, bytes);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("No se pudo reservar un puerto local."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitUntil(predicate, { label, timeoutMs = 30_000, intervalMs = POLL_INTERVAL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await predicate();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError instanceof Error ? ` Último error: ${lastError.message}` : "";
  throw new Error(`${label ?? "La condición"} no se cumplió en ${timeoutMs} ms.${suffix}`);
}

async function waitForHttp(origin, timeoutMs = 90_000) {
  return waitUntil(async () => {
    const response = await fetch(`${origin}/healthz`, { redirect: "manual" });
    return response.ok;
  }, { label: `El servidor ${origin}`, timeoutMs, intervalMs: 350 });
}

function createServerEnvironment(statePath, identity) {
  const environment = isolatedEnvironment({
    CI: "true",
    CLOUDFLARE_INCLUDE_PROCESS_ENV: "true",
    FUNDOSMART_DEPLOY_ENVIRONMENT: "development",
    FUNDOSMART_LOCAL_STATE_PATH: statePath,
    MINIFLARE_REGISTRY_PATH: path.join(statePath, "registry"),
    OFFLINE_SESSION_SECRET: randomUUID(),
    WRANGLER_LOG_PATH: path.join(statePath, "wrangler.log"),
    WRANGLER_WRITE_LOGS: "false",
  });
  if (identity) {
    environment.DEV_AUTH_EMAIL = identity.email;
    environment.DEV_AUTH_NAME = identity.name;
  } else {
    delete environment.DEV_AUTH_EMAIL;
    delete environment.DEV_AUTH_NAME;
  }
  return environment;
}

async function startVite({ statePath, identity }) {
  const port = await freePort();
  const viteExecutable = packageExecutable("vite", path.join("bin", "vite.js"));
  const environment = createServerEnvironment(statePath, identity);
  const child = spawn(process.execPath, [
    viteExecutable,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--strictPort",
    "--clearScreen", "false",
  ], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const server = {
    child,
    origin: `http://127.0.0.1:${port}`,
    tail: "",
  };
  child.stdout.on("data", (chunk) => {
    server.tail = appendTail(server.tail, chunk);
  });
  child.stderr.on("data", (chunk) => {
    server.tail = appendTail(server.tail, chunk);
  });
  child.once("error", (error) => {
    server.tail = appendTail(server.tail, error.stack ?? error.message);
  });
  try {
    await waitForHttp(server.origin);
    return server;
  } catch (error) {
    await stopProcess(child);
    throw new Error(`${error instanceof Error ? error.message : error}\n${server.tail}`);
  }
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([exited, delay(3_000)]);
  }
}

async function removeTemporaryRoot(temporaryRoot) {
  const resolvedRoot = path.resolve(temporaryRoot);
  const allowedRoot = `${path.resolve(tmpdir())}${path.sep}`;
  if (
    !resolvedRoot.startsWith(allowedRoot)
    || !path.basename(resolvedRoot).startsWith("fundosmart-e2e-")
  ) {
    throw new Error(`Se rechazó limpiar una ruta fuera del espacio E2E: ${resolvedRoot}`);
  }

  let lastError = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    try {
      await rm(resolvedRoot, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      if (!["EBUSY", "ENOTEMPTY", "EPERM"].includes(error?.code)) throw error;
      await delay(250);
    }
  }
  throw lastError;
}

async function applyMigrations(statePath) {
  const wranglerExecutable = createRequire(path.join(REPOSITORY_ROOT, "package.json")).resolve("wrangler");
  const configPath = path.join(REPOSITORY_ROOT, "scripts", "development", "wrangler.local-d1.jsonc");
  await runCommand(process.execPath, [
    wranglerExecutable,
    "d1", "migrations", "apply", "DB",
    "--local",
    "--persist-to", statePath,
    "-c", configPath,
  ], {
    environment: isolatedEnvironment({
      CI: "true",
      WRANGLER_LOG_PATH: path.join(statePath, "migration.log"),
      WRANGLER_WRITE_LOGS: "false",
    }),
    label: "Las migraciones D1 locales",
  });
}

async function isolatedRecoveryDatabase(backup, currentData, binding, token, now) {
  const database = new DatabaseSync(":memory:");
  try {
    const migrationDirectory = path.join(REPOSITORY_ROOT, "drizzle");
    const migrations = (await readdir(migrationDirectory))
      .filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql")
      .sort();
    for (const name of migrations) {
      const sql = await readFile(path.join(migrationDirectory, name), "utf8");
      database.exec(sql.replaceAll("--> statement-breakpoint", ""));
    }
    database.exec("PRAGMA foreign_keys = ON");

    const field = currentData.fields[0];
    database.prepare(
      "INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)",
    ).run(
      backup.manifest.scope.organizationId,
      backup.manifest.scope.organizationName,
      now,
    );
    database.prepare(`
      INSERT INTO fields
        (id, organization_id, name, location, is_demo, area_hectares, coordinates, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      field.id,
      field.organization_id,
      field.name,
      field.location,
      field.is_demo,
      field.area_hectares,
      canonicalJson(field.coordinates),
      field.created_at,
    );
    database.prepare(`
      INSERT INTO restore_confirmation_tokens
        (id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
         snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
    `).run(
      `e2e-confirmation-${randomUUID()}`,
      binding.organizationId,
      binding.fieldId,
      binding.actorEmail,
      await sha256Hex(token),
      binding.backupSha256,
      binding.snapshotSha256,
      binding.planSha256,
      new Date(Date.parse(now) + 15 * 60 * 1_000).toISOString(),
      now,
      now,
    );
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

async function runIsolatedPortableRecovery(backupPath, fixturePath, fieldId, attestation) {
  const backupBytes = await readFile(backupPath);
  assert.equal(backupBytes.byteLength, attestation.attestedSize);
  assert.equal(await sha256Hex(backupBytes), attestation.attestedSha256);
  const backupPayload = backupBytes.toString("utf8");
  assert.ok(backupPayload.endsWith("\n"), "El respaldo descargado debe conservar sus bytes UTF-8 completos.");
  const backup = await validatePortableBackup(JSON.parse(backupPayload));
  assert.equal(backup.manifest.format, FUNDOSMART_BACKUP_FORMAT);
  assert.equal(backup.manifest.scope.type, "field");
  assert.equal(backup.manifest.scope.id, fieldId);
  assert.equal(backup.manifest.scope.fieldId, fieldId);
  assert.equal(backup.data.fields.length, 1);

  const originalFiles = backup.manifest.originalFiles ?? [];
  assert.equal(originalFiles.length, 1, "El escenario E2E debe conservar un solo DBF original.");
  const original = originalFiles[0];
  const originalBytes = await readFile(fixturePath);
  assert.equal(original.originalFilename, TEST_IMPORT_FILENAME);
  assert.equal(original.fileSizeBytes, originalBytes.byteLength);
  assert.equal(original.sha256, await sha256Hex(originalBytes));

  const currentData = Object.fromEntries(
    Object.entries(backup.data).map(([section, rows]) => [
      section,
      section === "fields" ? rows : [],
    ]),
  );
  const plan = buildPortableRestorePlan(backup, currentData);
  assert.equal(plan.assessment, "ready");
  assert.equal(plan.writeEnabled, false);
  assert.ok(plan.totals.insertableRowCount > 0, "El destino aislado debe tener filas por restaurar.");

  const now = new Date().toISOString();
  const token = `e2e-recovery-${randomUUID()}-${randomUUID()}`;
  const binding = {
    actorEmail: backup.manifest.generatedBy,
    organizationId: backup.manifest.scope.organizationId,
    fieldId,
    backupSha256: await sha256Hex(backupPayload),
    snapshotSha256: await restoreSnapshotSha256(currentData),
    planSha256: await restorePlanSha256(plan),
  };
  const database = await isolatedRecoveryDatabase(backup, currentData, binding, token, now);
  const objectStore = createIsolatedMemoryObjectStore();
  try {
    const report = await runIsolatedRecoveryRehearsal(database, {
      backup,
      backupPayload,
      currentData,
      plan,
      confirmation: { token, binding, now },
      originalFiles: new Map([[String(original.importJobId), originalBytes]]),
      objectStore,
      guard: {
        target: "isolated_sqlite_memory",
        productWritesEnabled: false,
      },
    });
    const expectedRowCount = Object.values(backup.manifest.recordCounts)
      .reduce((total, count) => total + Number(count), 0);
    assert.equal(report.format, "fundosmart.recovery-rehearsal.v1");
    assert.equal(report.productWritesEnabled, false);
    assert.equal(report.tokenConsumed, true);
    assert.equal(report.insertedRowCount, plan.totals.insertableRowCount);
    assert.equal(report.verifiedRowCount, expectedRowCount);
    assert.equal(report.verifiedSectionCount, Object.keys(backup.data).length);
    assert.equal(report.originalFileCount, 1);
    assert.equal(report.originalBytes, originalBytes.byteLength);
    assert.equal(report.foreignKeyIssueCount, 0);
    assert.match(report.postRestoreSha256, /^[a-f0-9]{64}$/u);
    assert.equal(report.preRestoreBackup.rowCounts.fields, 1);
    assert.equal(
      database.prepare("SELECT status FROM restore_confirmation_tokens WHERE token_sha256 = ?")
        .get(await sha256Hex(token)).status,
      "consumed",
    );
    assert.equal(objectStore.keys().length, 1);
  } finally {
    database.close();
  }
}

async function launchChrome(profilePath) {
  const executable = await findChromeExecutable();
  const child = spawn(executable, [
    "--headless=new",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--user-data-dir=${profilePath}`,
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-dev-shm-usage",
    "--disable-extensions",
    "--disable-features=Translate",
    "--disable-gpu",
    "--disable-sync",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--no-sandbox",
    "about:blank",
  ], {
    cwd: REPOSITORY_ROOT,
    env: isolatedEnvironment(),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const chrome = { child, tail: "" };
  child.stdout.on("data", (chunk) => {
    chrome.tail = appendTail(chrome.tail, chunk);
  });
  child.stderr.on("data", (chunk) => {
    chrome.tail = appendTail(chrome.tail, chunk);
  });

  const activePortPath = path.join(profilePath, "DevToolsActivePort");
  const port = await waitUntil(async () => {
    const raw = await readFile(activePortPath, "utf8");
    const parsed = Number(raw.split(/\r?\n/u)[0]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, { label: "El puerto CDP de Chrome", timeoutMs: 30_000, intervalMs: 100 });
  const target = await waitUntil(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    const targets = await response.json();
    return targets.find((candidate) => candidate.type === "page" && candidate.webSocketDebuggerUrl) ?? null;
  }, { label: "Una pestaña CDP", timeoutMs: 10_000 });
  return { ...chrome, port, target };
}

class CdpClient {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Set();
    socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      for (const { reject, timeout } of this.pending.values()) {
        clearTimeout(timeout);
        reject(new Error("Chrome cerró la conexión CDP."));
      }
      this.pending.clear();
      for (const { reject, timeout } of this.eventWaiters) {
        clearTimeout(timeout);
        reject(new Error("Chrome cerró la conexión CDP."));
      }
      this.eventWaiters.clear();
    });
  }

  static async connect(url) {
    if (typeof WebSocket === "undefined") {
      throw new Error("Este harness requiere WebSocket global de Node 22.");
    }
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Chrome no abrió la conexión CDP.")), 10_000);
      socket.addEventListener("open", () => {
        clearTimeout(timeout);
        resolve();
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timeout);
        reject(new Error("Chrome rechazó la conexión CDP."));
      }, { once: true });
    });
    return new CdpClient(socket);
  }

  async handleMessage(raw) {
    const text = typeof raw === "string"
      ? raw
      : raw instanceof Blob
        ? await raw.text()
        : new TextDecoder().decode(raw);
    const message = JSON.parse(text);
    if (!message.id) {
      if (!message.method) return;
      for (const waiter of [...this.eventWaiters]) {
        if (waiter.method !== message.method) continue;
        try {
          if (!waiter.predicate(message.params ?? {})) continue;
          this.eventWaiters.delete(waiter);
          clearTimeout(waiter.timeout);
          waiter.resolve(message.params ?? {});
        } catch (error) {
          this.eventWaiters.delete(waiter);
          clearTimeout(waiter.timeout);
          waiter.reject(error);
        }
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.error) {
      pending.reject(new Error(`CDP ${pending.method}: ${message.error.message}`));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  send(method, params = {}, timeoutMs = 15_000) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} superó ${timeoutMs} ms.`));
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timeout });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  waitForEvent(method, predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const waiter = {
        method,
        predicate,
        resolve,
        reject,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        this.eventWaiters.delete(waiter);
        reject(new Error(`CDP ${method} no emitió el evento esperado en ${timeoutMs} ms.`));
      }, timeoutMs);
      this.eventWaiters.add(waiter);
    });
  }

  close() {
    this.socket.close();
  }
}

async function evaluate(client, expression) {
  const response = await client.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description
      ?? response.exceptionDetails.text
      ?? "Excepción sin detalle";
    throw new Error(sanitizeDiagnostic(description));
  }
  return response.result?.value;
}

async function navigate(client, url) {
  await client.send("Page.navigate", { url });
  await waitUntil(async () => evaluate(
    client,
    `document.readyState === "complete" && location.href.startsWith(${JSON.stringify(new URL(url).origin)})`,
  ), { label: `La navegación a ${new URL(url).pathname}`, timeoutMs: 60_000 });
}

async function waitForBodyText(client, text, timeoutMs = 45_000) {
  const expected = JSON.stringify(
    String(text).normalize("NFKC").toLocaleLowerCase("es-CL"),
  );
  return waitUntil(
    () => evaluate(
      client,
      `String(document.body?.innerText ?? "")
        .normalize("NFKC")
        .toLocaleLowerCase("es-CL")
        .includes(${expected})`,
    ),
    { label: `El texto "${text}"`, timeoutMs },
  );
}

function visibleHeadingExpression(heading) {
  const expected = JSON.stringify(
    String(heading).normalize("NFKC").toLocaleLowerCase("es-CL"),
  );
  return `(() => {
    const expected = ${expected};
    const normalize = (value) => String(value ?? "")
      .replace(/\\s+/g, " ")
      .trim()
      .normalize("NFKC")
      .toLocaleLowerCase("es-CL");
    return [...document.querySelectorAll("h1, h2, h3, [role=heading]")]
      .some((element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return normalize(element.textContent) === expected
          && style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      });
  })()`;
}

async function activateIdempotentControl(client, {
  name,
  heading,
  attempts = 3,
  attemptTimeoutMs = 3_000,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await evaluate(client, visibleHeadingExpression(heading))) return;
    await clickControl(client, name);
    try {
      await waitUntil(
        () => evaluate(client, visibleHeadingExpression(heading)),
        {
          label: `El encabezado "${heading}" tras activar "${name}"`,
          timeoutMs: attemptTimeoutMs,
        },
      );
      return;
    } catch (error) {
      lastError = error;
    }
  }
  const detail = lastError instanceof Error ? ` ${lastError.message}` : "";
  throw new Error(
    `El control idempotente "${name}" no activó el encabezado "${heading}" `
    + `tras ${attempts} intentos.${detail}`,
  );
}

function semanticControlExpression(name, { allowDisabled = false } = {}) {
  return `(() => {
    const expected = ${JSON.stringify(name)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const accessibleName = (element) => normalize(
      element.getAttribute("aria-label")
      || element.getAttribute("title")
      || element.textContent
      || element.innerText
    );
    const element = [...document.querySelectorAll("a, button, [role=button]")]
      .find((candidate) => isVisible(candidate)
        && accessibleName(candidate) === expected
        && (${allowDisabled ? "true" : "!(candidate.disabled || candidate.getAttribute(\"aria-disabled\") === \"true\")"}));
    if (!element) return null;
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      name: accessibleName(element),
    };
  })()`;
}

async function locateControl(client, name, options = {}) {
  return waitUntil(
    () => evaluate(client, semanticControlExpression(name, options)),
    { label: `El control "${name}"`, timeoutMs: options.timeoutMs ?? 45_000 },
  );
}

async function visibleEnabledControls(client, names) {
  return evaluate(client, `(() => {
    const expected = new Set(${JSON.stringify(names)});
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    return [...document.querySelectorAll("a, button, [role=button]")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const name = normalize(
          element.getAttribute("aria-label")
          || element.getAttribute("title")
          || element.textContent
          || element.innerText
        );
        return expected.has(name)
          && rect.width > 0
          && rect.height > 0
          && style.display !== "none"
          && style.visibility !== "hidden"
          && !(element.disabled || element.getAttribute("aria-disabled") === "true");
      })
      .map((element) => normalize(
        element.getAttribute("aria-label")
        || element.getAttribute("title")
        || element.textContent
        || element.innerText
      ));
  })()`);
}

async function clickAt(client, x, y, clickCount = 1) {
  await client.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await client.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    buttons: 1,
    clickCount,
  });
  await client.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    buttons: 0,
    clickCount,
  });
}

async function clickControl(client, name, options = {}) {
  await locateControl(client, name, options);
  await delay(100);
  const point = await locateControl(client, name, options);
  await clickAt(client, point.x, point.y);
  await delay(150);
}

function labeledInputExpression(label) {
  return `(() => {
    const expected = ${JSON.stringify(label)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (element) => {
      const explicit = element.id
        ? [...document.querySelectorAll("label")].find((candidate) => candidate.htmlFor === element.id)
        : null;
      return normalize(
        element.getAttribute("aria-label")
        || explicit?.textContent
        || element.closest("label")?.textContent
        || element.getAttribute("placeholder")
      );
    };
    const element = [...document.querySelectorAll("input, textarea")]
      .find((candidate) => isVisible(candidate) && !candidate.disabled && labelFor(candidate) === expected);
    if (!element) return null;
    element.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

async function fillLabeledInput(client, label, value) {
  const locate = () => waitUntil(
    () => evaluate(client, labeledInputExpression(label)),
    { label: `El campo "${label}"`, timeoutMs: 30_000 },
  );
  await locate();
  await delay(100);
  const point = await locate();
  await clickAt(client, point.x, point.y, 3);
  await client.send("Input.insertText", { text: value });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
  await client.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Tab",
    code: "Tab",
    windowsVirtualKeyCode: 9,
  });
}

function labeledSelectExpression(label, optionLabel) {
  return `(() => {
    const expectedLabel = ${JSON.stringify(label)};
    const expectedOption = ${JSON.stringify(optionLabel)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const labelFor = (element) => {
      const explicit = element.id
        ? [...document.querySelectorAll("label")].find((candidate) => candidate.htmlFor === element.id)
        : null;
      const owner = explicit ?? element.closest("label");
      const ownerText = owner
        ? [...owner.childNodes].map((node) => {
            if (node === element) return "";
            if (node.nodeType === Node.ELEMENT_NODE && node.contains(element)) return "";
            return node.textContent;
          }).join(" ")
        : "";
      return normalize(element.getAttribute("aria-label") || ownerText);
    };
    const element = [...document.querySelectorAll("select")]
      .find((candidate) => isVisible(candidate) && !candidate.disabled && labelFor(candidate) === expectedLabel);
    if (!element) return null;
    const option = [...element.options]
      .find((candidate) => normalize(candidate.textContent) === expectedOption);
    if (!option) return null;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    if (!setter) return null;
    setter.call(element, option.value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return {
      label: labelFor(element),
      option: normalize(element.selectedOptions[0]?.textContent),
      value: element.value,
    };
  })()`;
}

async function selectLabeledOption(client, label, optionLabel) {
  await waitUntil(
    () => evaluate(client, labeledSelectExpression(label, optionLabel)),
    { label: `La opción "${optionLabel}" del campo "${label}"`, timeoutMs: 30_000 },
  );
  await delay(150);
}

function labeledFileInputExpression(label) {
  return `(() => {
    const expected = ${JSON.stringify(label)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const input = [...document.querySelectorAll('input[type="file"]')]
      .find((candidate) => {
        let current = candidate.parentElement;
        while (current) {
          if (current.tagName === "LABEL"
            && [...current.children].some((child) => normalize(child.textContent) === expected)) {
            return true;
          }
          current = current.parentElement;
        }
        return false;
      });
    return input ?? null;
  })()`;
}

async function setLabeledFileInput(client, label, filePath) {
  const response = await client.send("Runtime.evaluate", {
    expression: labeledFileInputExpression(label),
    objectGroup: "fundosmart-e2e-file-input",
    returnByValue: false,
    userGesture: true,
  });
  if (response.exceptionDetails) {
    throw new Error(`No fue posible localizar el archivo "${label}".`);
  }
  const objectId = response.result?.objectId;
  if (!objectId) {
    throw new Error(`No se encontró el archivo "${label}".`);
  }
  try {
    await client.send("DOM.setFileInputFiles", {
      files: [path.resolve(filePath)],
      objectId,
    });
  } finally {
    await client.send("Runtime.releaseObject", { objectId }).catch(() => {});
  }
  const expectedFilename = path.basename(filePath);
  await waitForBodyText(client, expectedFilename, 15_000);
}

async function configureBrowserDownloads(client, downloadPath) {
  await mkdir(downloadPath, { recursive: true });
  try {
    await client.send("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath,
      eventsEnabled: true,
    });
  } catch (browserError) {
    try {
      await client.send("Page.setDownloadBehavior", {
        behavior: "allow",
        downloadPath,
      });
    } catch {
      throw browserError;
    }
  }
}

function responseHeader(headers, name) {
  const expected = name.toLowerCase();
  if (Array.isArray(headers)) {
    const entry = headers.find((header) => String(header?.name ?? "").toLowerCase() === expected);
    return entry ? String(entry.value ?? "") : "";
  }
  const entry = Object.entries(headers ?? {})
    .find(([headerName]) => headerName.toLowerCase() === expected);
  return entry ? String(entry[1]) : "";
}

function exactFetchUrlPattern(url) {
  return url
    .replaceAll("\\", "\\\\")
    .replaceAll("*", "\\*")
    .replaceAll("?", "\\?");
}

function isFieldBackupResponse(event, expectedUrl) {
  try {
    return new URL(event.request?.url ?? "").href === expectedUrl;
  } catch {
    return false;
  }
}

async function waitForDownloadedPortableBackup(downloadPath) {
  return waitUntil(async () => {
    const entries = await readdir(downloadPath, { withFileTypes: true });
    if (entries.some((entry) => entry.name.endsWith(".crdownload"))) return null;
    const candidates = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".fundosmart.json"))
      .map((entry) => path.join(downloadPath, entry.name));
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) {
      throw new Error(`Se descargaron ${candidates.length} respaldos portables; se esperaba uno.`);
    }
    const metadata = await stat(candidates[0]);
    return metadata.size > 0 ? candidates[0] : null;
  }, {
    label: "La descarga portable completa del fundo",
    timeoutMs: 30_000,
    intervalMs: 150,
  });
}

async function downloadPortableBackup(client, origin, downloadPath, fieldId) {
  await configureBrowserDownloads(client, downloadPath);
  const backupUrl = new URL(
    `/api/integraciones/cooprinsem/respaldos?scope=field&id=${encodeURIComponent(fieldId)}&asset=backup`,
    origin,
  ).href;
  let pausedResponse = null;
  try {
    await client.send("Fetch.enable", {
      patterns: [{
        urlPattern: exactFetchUrlPattern(backupUrl),
        requestStage: "Response",
      }],
    });
    const responsePromise = client.waitForEvent(
      "Fetch.requestPaused",
      () => true,
      30_000,
    );
    try {
      await clickControl(client, "Descargar respaldo completo del fundo");
    } catch (error) {
      void responsePromise.catch(() => {});
      throw error;
    }
    pausedResponse = await responsePromise;
    const requestId = pausedResponse.requestId;
    const responseUrl = pausedResponse.request?.url;
    const responseErrorReason = pausedResponse.responseErrorReason;
    const responseStatusCode = pausedResponse.responseStatusCode;
    const attestedSha256 = responseHeader(
      pausedResponse.responseHeaders,
      "X-FundoSmart-SHA256",
    );
    const attestedSize = Number(responseHeader(
      pausedResponse.responseHeaders,
      "Content-Length",
    ));
    await client.send("Fetch.continueRequest", { requestId });
    pausedResponse = null;
    assert.ok(
      isFieldBackupResponse({ request: { url: responseUrl } }, backupUrl),
      "La respuesta pausada no pertenece al respaldo exacto del fundo.",
    );
    assert.equal(responseErrorReason, undefined);
    assert.equal(responseStatusCode, 200);
    assert.match(attestedSha256, /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(attestedSize) && attestedSize > 0);
    const backupPath = await waitForDownloadedPortableBackup(downloadPath);
    const downloadedBytes = await readFile(backupPath);
    assert.equal(downloadedBytes.byteLength, attestedSize);
    assert.equal(await sha256Hex(downloadedBytes), attestedSha256);
    return { backupPath, attestedSha256, attestedSize };
  } finally {
    if (pausedResponse?.requestId) {
      await client.send("Fetch.continueRequest", {
        requestId: pausedResponse.requestId,
      }).catch(() => {});
    }
    await client.send("Fetch.disable").catch(() => {});
  }
}

function labeledCheckboxExpression(label) {
  return `(() => {
    const expected = ${JSON.stringify(label)};
    const normalize = (value) => String(value ?? "").replace(/\\s+/g, " ").trim();
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const input = [...document.querySelectorAll('input[type="checkbox"]')]
      .find((candidate) => isVisible(candidate)
        && !candidate.disabled
        && normalize(candidate.closest("label")?.textContent).includes(expected));
    if (!input) return null;
    input.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = input.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
}

async function clickLabeledCheckbox(client, label) {
  const point = await waitUntil(
    () => evaluate(client, labeledCheckboxExpression(label)),
    { label: `La casilla "${label}"`, timeoutMs: 30_000 },
  );
  await clickAt(client, point.x, point.y);
  await delay(150);
}

async function mapRectangle(client) {
  return waitUntil(() => evaluate(client, `(() => {
    const map = document.querySelector(".leaflet-container");
    if (!map) return null;
    map.scrollIntoView({ behavior: "instant", block: "center", inline: "center" });
    const rect = map.getBoundingClientRect();
    if (rect.width < 400 || rect.height < 300) return null;
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  })()`), { label: "El lienzo Leaflet", timeoutMs: 45_000 });
}

// DrawingEvents (MapaPotreros.tsx) defers every map click by 280 ms to tell a
// single click from a double click, and a second click inside that window
// cancels the pending one *without* scheduling its own. Two clicks that land
// close together therefore produce zero vertices, not two.
//
// A fixed delay between clicks cannot rule that out: it is measured from when
// the CDP command returns, not from when the page handled the click, so under
// load two clicks can still land within 280 ms of each other in page time. The
// only reliable proof that the debounce elapsed is the vertex itself appearing.
const DRAW_CLICK_DEBOUNCE_MS = 280;
const DRAW_CLICK_QUIET_MS = DRAW_CLICK_DEBOUNCE_MS + 220;
const VERTEX_CLICK_ATTEMPTS = 3;

// Every draft vertex renders a Leaflet divIcon with one of these classes.
// Clicking a vertex swaps its icon to the selected variant, so all three must
// be counted or the count would drop on selection.
const DRAFT_VERTEX_SELECTOR =
  ".potrero-vertex-marker, .fundo-vertex-marker, .boundary-vertex-marker-selected";

async function draftVertexCount(client) {
  return evaluate(client, `document.querySelectorAll(${JSON.stringify(DRAFT_VERTEX_SELECTOR)}).length`);
}

// Saving the fundo boundary re-runs fitBounds, so the geography under the
// canvas keeps moving after the request resolves. Best effort on purpose: a map
// that never settles must not become a new way to fail a release.
async function waitForMapIdle(client) {
  let previous = null;
  await waitUntil(async () => {
    const sample = await evaluate(client, `(() => {
      const map = document.querySelector(".leaflet-container");
      if (!map || map.classList.contains("leaflet-zoom-anim")) return null;
      const pane = map.querySelector(".leaflet-map-pane");
      return pane ? getComputedStyle(pane).transform : "none";
    })()`);
    if (sample === null) {
      previous = null;
      return false;
    }
    const settled = previous === sample;
    previous = sample;
    return settled;
  }, { label: "El mapa Leaflet quieto", timeoutMs: 10_000 }).catch(() => null);
}

async function placeDraftVertex(client, point, expected) {
  for (let attempt = 1; attempt <= VERTEX_CLICK_ATTEMPTS; attempt += 1) {
    await clickAt(client, point.x, point.y);
    // Reaching the count proves applyClick already ran, so the pending click
    // reference is clear and the next click cannot cancel anything.
    const registered = await waitUntil(
      async () => (await draftVertexCount(client)) >= expected,
      { label: `El vértice ${expected}`, timeoutMs: 6_000 },
    ).catch(() => false);
    if (registered) return;
    // Let the debounce expire before retrying, then look again: a click issued
    // inside the window would cancel the pending one instead of adding a vertex.
    await delay(DRAW_CLICK_QUIET_MS);
    if ((await draftVertexCount(client)) >= expected) return;
  }
  throw new Error(`El vértice ${expected} no se registró tras ${VERTEX_CLICK_ATTEMPTS} intentos.`);
}

// Closing goes through the marker of vertex 0, whose handler is not debounced.
// It only fires with three vertices already committed, which the loop above
// guarantees.
//
// The postcondition is asserted on the save control itself: it stays disabled
// while the editor is still drawing, so waiting for it to become enabled is the
// one check that cannot pass by accident. Counting vertices could not tell a
// closed ring from a close click that was dropped altogether.
async function closeDraftRing(client, point, saveControl) {
  const before = await draftVertexCount(client);
  await clickAt(client, point.x, point.y);
  const closed = await waitUntil(
    async () => (await visibleEnabledControls(client, [saveControl])).includes(saveControl),
    { label: `El cierre del trazado con "${saveControl}"`, timeoutMs: 12_000 },
  ).catch(() => false);
  if (closed) return;
  const after = await draftVertexCount(client);
  throw new Error(after > before
    ? `El clic de cierre agregó un vértice (${before} → ${after}) en vez de cerrar el trazado.`
    : `El editor no habilitó "${saveControl}" con ${after} vértices tras el clic de cierre.`);
}

// The editor toolbar and the sidebar float over the Leaflet canvas, and the
// toolbar grows as the draft gains vertices and validation errors. A click that
// lands on a panel is swallowed and the vertex is never created, which is what
// made this journey block releases: the run continued a vertex short and the
// closing click became a plain vertex instead of closing the ring.
//
// Every point is therefore checked against the canvas immediately before it is
// clicked. A covered point names its blocker straight away instead of surfacing
// 45 s later as a disabled save button.
async function assertCanvasPoint(client, point, label) {
  const blocker = await evaluate(client, `(() => {
    const map = document.querySelector(".leaflet-container");
    if (!map) return "no hay lienzo Leaflet";
    const element = document.elementFromPoint(${Math.round(point.x)}, ${Math.round(point.y)});
    if (!element) return "el punto queda fuera de la ventana";
    // Zoom and attribution controls sit inside the container but must never be
    // clicked: hitting them would zoom the map mid-draw.
    if (element.closest(".leaflet-control-container")) return "un control de Leaflet";
    if (!map.contains(element)) {
      const name = element.getAttribute("class") || element.tagName;
      return "el panel " + String(name).slice(0, 70);
    }
    return null;
  })()`);
  if (blocker) {
    throw new Error(`${label} en ${Math.round(point.x)},${Math.round(point.y)} no cae sobre el mapa sino sobre ${blocker}.`);
  }
}

async function drawPolygon(client, ratios, saveControl) {
  await waitForMapIdle(client);
  const rectangle = await mapRectangle(client);
  const points = ratios.map(([xRatio, yRatio]) => ({
    x: rectangle.left + rectangle.width * xRatio,
    y: rectangle.top + rectangle.height * yRatio,
  }));
  const baseline = await draftVertexCount(client);
  for (const [index, point] of points.entries()) {
    await assertCanvasPoint(client, point, `El vértice ${index + 1}`);
    await placeDraftVertex(client, point, baseline + index + 1);
  }
  await assertCanvasPoint(client, points[0], "El clic de cierre");
  await closeDraftRing(client, points[0], saveControl);
}

async function pageFetch(client, pathname, options = {}) {
  const serializedOptions = JSON.stringify(options);
  return evaluate(client, `(async () => {
    const response = await fetch(${JSON.stringify(pathname)}, ${serializedOptions});
    let body = null;
    try { body = await response.json(); } catch {}
    return { status: response.status, body };
  })()`);
}

async function waitForPersonalData(client) {
  return waitUntil(async () => {
    const response = await pageFetch(client, "/api/fundos", { cache: "no-store" });
    if (response.status !== 200) return null;
    const fundos = response.body?.fundos;
    return Array.isArray(fundos)
      && fundos.length === 1
      && fundos[0]?.name === TEST_FIELD_NAME
      ? fundos[0]
      : null;
  }, { label: "El fundo recién creado en la API", timeoutMs: 45_000, intervalMs: 350 });
}

async function waitForPaddock(client, fieldId) {
  return waitUntil(async () => {
    const response = await pageFetch(client, `/api/potreros?fundoId=${encodeURIComponent(fieldId)}`, {
      cache: "no-store",
    });
    if (response.status !== 200) return null;
    const paddocks = response.body?.potreros;
    return Array.isArray(paddocks)
      && paddocks.length === 1
      && paddocks[0]?.name === TEST_PADDOCK_NAME
      ? paddocks[0]
      : null;
  }, { label: "El primer potrero en la API", timeoutMs: 45_000, intervalMs: 350 });
}

async function waitForConfirmedCooprinsemImport(client) {
  return waitUntil(async () => {
    const [importsResponse, animalsResponse] = await Promise.all([
      pageFetch(client, "/api/integraciones/cooprinsem/importaciones", { cache: "no-store" }),
      pageFetch(client, "/api/ganado/animales", { cache: "no-store" }),
    ]);
    if (importsResponse.status !== 200 || animalsResponse.status !== 200) return null;
    const imports = importsResponse.body?.dashboard?.imports;
    const animals = animalsResponse.body?.animals;
    const importItem = Array.isArray(imports)
      ? imports.find((item) => item.originalFilename === TEST_IMPORT_FILENAME)
      : null;
    const animal = Array.isArray(animals)
      ? animals.find((item) => item.tag === TEST_ANIMAL_TAG)
      : null;
    return importItem?.confirmedAt && animal ? { animal, importItem } : null;
  }, {
    label: "La importación Cooprinsem confirmada en el maestro animal",
    timeoutMs: 45_000,
    intervalMs: 350,
  });
}

async function ensureOfflineServiceWorker(client) {
  await waitUntil(
    () => evaluate(client, `(async () => {
      if (!("serviceWorker" in navigator)) return false;
      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      const ready = await navigator.serviceWorker.ready;
      return ready.scope === registration.scope && Boolean(ready.active);
    })()`),
    { label: "El Service Worker local para la cola offline", timeoutMs: 30_000 },
  );
}

async function setBrowserOffline(client, offline) {
  await client.send("Network.emulateNetworkConditions", {
    offline,
    latency: 0,
    downloadThroughput: offline ? 0 : -1,
    uploadThroughput: offline ? 0 : -1,
    connectionType: offline ? "none" : "wifi",
  });
  await waitUntil(
    () => evaluate(client, `navigator.onLine === ${offline ? "false" : "true"}`),
    {
      label: offline ? "El corte de red del navegador" : "La reconexión del navegador",
      timeoutMs: 15_000,
    },
  );
}

async function waitForAnimalHealthRecord(client, animalId) {
  const pathName = `/api/ganado/ficha?animalId=${encodeURIComponent(animalId)}`;
  return waitUntil(async () => {
    const response = await pageFetch(client, pathName, { cache: "no-store" });
    if (response.status !== 200) return null;
    const events = response.body?.record?.healthEvents;
    return Array.isArray(events)
      ? events.find((entry) => entry.condition === TEST_OFFLINE_CONDITION
        && entry.productName === TEST_OFFLINE_PRODUCT) ?? null
      : null;
  }, {
    label: "La captura offline reflejada en la ficha animal",
    timeoutMs: 45_000,
    intervalMs: 350,
  });
}

async function runCooprinsemImportJourney(client, origin, fieldId, fixturePath) {
  process.stdout.write("e2e: importación Cooprinsem sintética\n");
  await navigate(
    client,
    `${origin}/app/integraciones/cooprinsem?fieldId=${encodeURIComponent(fieldId)}`,
  );
  await waitForBodyText(client, "Integración Cooprinsem");
  await clickControl(client, "Nueva carga");
  await setLabeledFileInput(client, "Archivo DBF", fixturePath);
  await clickControl(client, "Generar vista previa");
  await waitForBodyText(client, "Vista previa persistida");
  await waitForBodyText(client, TEST_IMPORT_FILENAME);
  await clickControl(client, "Simular integración");
  await waitForBodyText(client, "Resultado de simulación");
  await waitForBodyText(client, TEST_ANIMAL_TAG);
  await clickLabeledCheckbox(client, "Revisé la simulación.");
  await clickControl(client, "Integrar 1 filas seguras");
  await waitForBodyText(client, "Integración confirmada");
  return waitForConfirmedCooprinsemImport(client);
}

async function runOfflineCaptureJourney(client, origin, animal) {
  process.stdout.write("e2e: captura offline, reconexión y ficha\n");
  await navigate(client, `${origin}/app/ganado`);
  await waitForBodyText(client, "Ganado");
  await activateIdempotentControl(client, {
    name: "Terreno",
    heading: "Sanidad, celo o movimiento",
  });
  await waitForBodyText(client, "Sesión local válida hasta");
  await ensureOfflineServiceWorker(client);

  let offline = false;
  try {
    await setBrowserOffline(client, true);
    offline = true;
    await waitForBodyText(client, "Modo sin señal");
    await selectLabeledOption(client, "Animal", TEST_ANIMAL_TAG);
    await fillLabeledInput(client, "Producto", TEST_OFFLINE_PRODUCT);
    await fillLabeledInput(client, "Detalle", TEST_OFFLINE_CONDITION);
    await clickControl(client, "Guardar ahora o en cola");
    await waitForBodyText(client, "Pendientes 1");
    await waitForBodyText(client, "1 captura local");

    await setBrowserOffline(client, false);
    offline = false;
    await clickControl(client, "Sincronizar ahora");
    await waitForAnimalHealthRecord(client, animal.id);
    await waitForBodyText(client, "Pendientes 0");
    await waitForBodyText(client, "Últimas capturas confirmadas");
  } finally {
    if (offline) {
      await setBrowserOffline(client, false).catch(() => {});
    }
  }

  await navigate(client, `${origin}/app/ganado/ficha`);
  await waitForBodyText(client, TEST_ANIMAL_TAG);
  await waitForBodyText(client, TEST_OFFLINE_CONDITION);
  await waitForBodyText(client, TEST_OFFLINE_PRODUCT);
}

async function runPortableRecoveryJourney(client, origin, fieldId, fixturePath, downloadPath) {
  process.stdout.write("e2e: exportación portable y restauración aislada\n");
  await navigate(
    client,
    `${origin}/app/integraciones/cooprinsem?fieldId=${encodeURIComponent(fieldId)}`,
  );
  await waitForBodyText(client, "Integración Cooprinsem");
  await clickControl(client, "Respaldos");
  await waitForBodyText(client, "Respaldos abiertos");
  const download = await downloadPortableBackup(client, origin, downloadPath, fieldId);

  await setLabeledFileInput(client, "Seleccionar .fundosmart.json", download.backupPath);
  await clickControl(client, "Ejecutar dry-run");
  await waitForBodyText(client, "Resultado del dry-run");
  await waitForBodyText(client, "Sin cambios pendientes");
  await waitForBodyText(client, "Escritura deshabilitada");

  await runIsolatedPortableRecovery(
    download.backupPath,
    fixturePath,
    fieldId,
    download,
  );
}

async function runRoleChangeJourney(client, origin, field, paddock, identity) {
  process.stdout.write("e2e: cambio de rol durante una mutación\n");
  await navigate(client, `${origin}/app/potreros`);
  await waitForBodyText(client, "Fundos y potreros");
  await waitForBodyText(client, paddock.name);
  await locateControl(client, "Dibujar");

  const backupOwner = await pageFetch(client, "/api/configuracion/accesos", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: `e2e-backup-${randomUUID()}@example.invalid`,
      displayName: "Respaldo E2E",
      role: "owner",
      status: "active",
      fieldIds: [],
    }),
  });
  assert.equal(backupOwner.status, 200, "El D1 efímero debe conservar otro propietario activo.");
  assert.ok(backupOwner.body?.dashboard, "La creación del propietario de respaldo debe ser visible al owner.");

  const roleChange = await pageFetch(client, "/api/configuracion/accesos", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: identity.email,
      displayName: identity.name,
      role: "viewer",
      status: "active",
      fieldIds: [field.id],
    }),
  });
  assert.equal(
    roleChange.status,
    403,
    "La misma mutación que retira manage_members debe fallar cerrada en su barrera final.",
  );
  assert.equal(roleChange.body?.code, "CAPABILITY_REQUIRED");
  assert.equal(
    roleChange.body?.dashboard,
    undefined,
    "La respuesta no debe serializar el dashboard privilegiado leído antes del cambio.",
  );

  await locateControl(client, "Dibujar");
  const deniedMutation = await pageFetch(client, "/api/potreros", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...paddock,
      name: TEST_REVOKED_PADDOCK_NAME,
    }),
  });
  assert.equal(
    deniedMutation.status,
    403,
    "Una mutación iniciada desde el DOM owner obsoleto debe respetar el rol viewer vigente.",
  );
  assert.equal(deniedMutation.body?.code, "CAPABILITY_REQUIRED");

  const scopedRead = await pageFetch(
    client,
    `/api/potreros?fundoId=${encodeURIComponent(field.id)}`,
    { cache: "no-store" },
  );
  assert.equal(scopedRead.status, 200, "El viewer debe conservar lectura del fundo asignado.");
  assert.deepEqual(
    scopedRead.body?.potreros?.map(({ id, name }) => ({ id, name })),
    [{ id: paddock.id, name: paddock.name }],
    "La mutación rechazada no debe crear ni alterar potreros.",
  );

  await navigate(client, `${origin}/app/potreros`);
  await waitForBodyText(client, paddock.name);
  const mutationControls = await visibleEnabledControls(client, [
    "Nuevo fundo",
    "Crear primer fundo",
    "Dibujar",
  ]);
  assert.deepEqual(
    mutationControls,
    [],
    "La recarga con rol viewer no debe exponer controles de mutación habilitados.",
  );
}

async function assertDemoReadOnly(client, origin) {
  await navigate(client, `${origin}/demo?returnTo=%2Fapp%2Fpotreros`);
  await waitForBodyText(client, "Usuario Demo");
  assert.equal(
    await currentSpaceControl(client),
    "Espacio de trabajo: Demo pública. Cambiar de espacio",
    "La barra superior debe anunciar que la demo pública está activa.",
  );
  const mutationControls = await visibleEnabledControls(client, [
    "Nuevo fundo",
    "Crear primer fundo",
    "Dibujar",
  ]);
  assert.deepEqual(mutationControls, [], "La demo no debe exponer controles de mutación habilitados.");

  const response = await pageFetch(client, "/api/fundos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      id: `demo-write-${randomUUID()}`,
      name: "No persistir",
      location: "Demo",
      coordinates: [[-40.57, -73.14], [-40.57, -73.13], [-40.58, -73.13]],
      areaHectares: 1,
    }),
  });
  assert.equal(response.status, 403, "La API demo debe rechazar toda escritura.");
}

/* El selector de espacio es el único control del shell cuyo nombre depende de los
   datos, así que se lee del propio encabezado en vez de fijarlo en el recorrido. */
async function currentSpaceControl(client) {
  return await waitUntil(() => evaluate(client, `(() => {
    const chip = document.querySelector('header button[aria-haspopup="true"]');
    return chip?.getAttribute("aria-label") ?? null;
  })()`), { label: "El selector de espacio del encabezado" });
}

/* Es la primera interacción del recorrido y el módulo llega pintado desde el
   servidor: la barra recién responde cuando hidrata, y un clic que llegue antes
   se pierde sin dejar rastro. Abrir se reintenta hasta que el menú existe. */
async function openSpaceMenu(client, control) {
  const menuIsOpen = () => evaluate(client, `Boolean(document.querySelector('header [role="menu"]'))`);
  await waitUntil(async () => {
    if (await menuIsOpen()) return true;
    await clickControl(client, control);
    return await menuIsOpen();
  }, { label: "El menú de espacios de trabajo" });
}

async function runBrowserJourneys(client, origin, fixturePath, downloadPath, identity) {
  process.stdout.write("e2e: alta, espacio activo y cambio de espacio\n");
  await navigate(client, `${origin}/`);
  await clickControl(client, "Crear cuenta gratis");
  await waitForBodyText(client, "Tu campo, en una mirada");

  /* Entrar no pasa por el selector y el espacio activo no queda invisible: la
     barra lo anuncia en cada pantalla, que es lo que permite elegir por omisión
     sin que nadie escriba a ciegas en el espacio equivocado. El nombre se lee de
     la barra en vez de fijarlo aquí: qué espacio resuelve depende de las
     membresías de la identidad, y lo que se comprueba es que anuncie una. */
  const activeSpaceControl = await currentSpaceControl(client);
  assert.match(
    activeSpaceControl,
    /^Espacio de trabajo: .+\. Cambiar de espacio$/,
    "La barra superior debe anunciar el espacio activo.",
  );

  /* Y se cambia desde ahí, sin salir del módulo ni volver a una pantalla aparte. */
  await openSpaceMenu(client, activeSpaceControl);
  await clickControl(client, "Abrir demo pública");
  await openSpaceMenu(client, "Espacio de trabajo: Demo pública. Cambiar de espacio");
  await clickControl(client, "Volver a Mi cuenta");
  await waitForBodyText(client, "Tu campo, en una mirada");
  assert.equal(
    await currentSpaceControl(client),
    activeSpaceControl,
    "Volver de la demo debe devolver al mismo espacio de trabajo.",
  );

  /* El directorio sigue existiendo para gestionar y para volver desde un espacio
     revocado, aunque ya no sea la puerta de entrada. */
  await navigate(client, `${origin}/app/espacios?returnTo=%2Fapp`);
  await waitForBodyText(client, "¿En qué espacio quieres trabajar?");
  await clickControl(client, "Entrar a Mi FundoSmart");
  await waitForBodyText(client, "Tu campo, en una mirada");

  process.stdout.write("e2e: primer fundo y límite\n");
  await clickControl(client, "Potreros");
  await waitForBodyText(client, "Fundos y potreros");
  await clickControl(client, "Crear primer fundo");
  await fillLabeledInput(client, "Nombre", TEST_FIELD_NAME);
  await fillLabeledInput(client, "Sector o localidad", TEST_FIELD_LOCATION);
  await clickControl(client, "Dibujar límite");
  // Kept clear of the editor chrome: the toolbar floats over the top of the
  // canvas and the sidebar over its left third. assertCanvasPoint fails loudly
  // if either grows past these ratios again.
  await drawPolygon(client, [
    [0.55, 0.55],
    [0.85, 0.55],
    [0.85, 0.88],
    [0.55, 0.88],
  ], "Guardar límite del fundo");
  await clickControl(client, "Guardar límite del fundo");
  const field = await waitForPersonalData(client);

  process.stdout.write("e2e: primer potrero y dashboard\n");
  await clickControl(client, "Dibujar");
  // Inside the fundo boundary drawn above, and equally clear of the chrome.
  await drawPolygon(client, [
    [0.62, 0.62],
    [0.78, 0.62],
    [0.78, 0.80],
    [0.62, 0.80],
  ], "Guardar potrero");
  await clickControl(client, "Guardar potrero");
  await waitForBodyText(client, `Editar ${TEST_PADDOCK_NAME}`);
  await clickControl(client, "Cancelar");
  const paddock = await waitForPaddock(client, field.id);
  await clickControl(client, "Resumen");
  await waitForBodyText(client, TEST_FIELD_NAME);

  const { animal } = await runCooprinsemImportJourney(client, origin, field.id, fixturePath);
  await runOfflineCaptureJourney(client, origin, animal);
  await runPortableRecoveryJourney(client, origin, field.id, fixturePath, downloadPath);
  await runRoleChangeJourney(client, origin, field, paddock, identity);

  process.stdout.write("e2e: demo de solo lectura\n");
  await assertDemoReadOnly(client, origin);
}

async function captureFailure(client, error, context) {
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  let screenshotSaved = false;
  if (client) {
    try {
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
      });
      await writeFile(FAILURE_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
      screenshotSaved = true;
    } catch {
      screenshotSaved = false;
    }
  }
  let currentPath = null;
  if (client) {
    try {
      const currentUrl = await evaluate(client, "location.href");
      currentPath = new URL(currentUrl).pathname;
    } catch {
      currentPath = null;
    }
  }
  await writeFile(FAILURE_DIAGNOSTICS, `${JSON.stringify({
    format: "fundosmart.critical-journeys.failure.v1",
    failedAt: new Date().toISOString(),
    message: sanitizeDiagnostic(error instanceof Error ? error.message : error),
    currentPath,
    screenshotSaved,
    serverTail: sanitizeDiagnostic(context.server?.tail ?? ""),
    chromeTail: sanitizeDiagnostic(context.chrome?.tail ?? ""),
  }, null, 2)}\n`, "utf8");
}

async function runAnonymousApiCheck(statePath) {
  process.stdout.write("e2e: API anónima cerrada\n");
  const server = await startVite({ statePath, identity: null });
  try {
    const response = await fetch(`${server.origin}/api/fundos`, {
      headers: { Accept: "application/json" },
      redirect: "manual",
    });
    assert.equal(response.status, 401, "La API anónima debe responder 401.");
    const body = await response.json();
    assert.equal(body.error, "Debes iniciar sesión.");
  } finally {
    await stopProcess(server.child);
  }
}

export async function runCriticalJourneys() {
  const startedAt = Date.now();
  await mkdir(ARTIFACT_DIRECTORY, { recursive: true });
  await Promise.all([
    rm(FAILURE_SCREENSHOT, { force: true }),
    rm(FAILURE_DIAGNOSTICS, { force: true }),
  ]);
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "fundosmart-e2e-"));
  const statePath = path.join(temporaryRoot, "state");
  const profilePath = path.join(temporaryRoot, "chrome-profile");
  const downloadPath = path.join(temporaryRoot, "downloads");
  const fixturePath = path.join(temporaryRoot, TEST_IMPORT_FILENAME);
  const identity = {
    email: `e2e-${randomUUID()}@example.invalid`,
    name: "Usuario E2E",
  };
  const context = { chrome: null, client: null, server: null };

  try {
    await mkdir(statePath, { recursive: true });
    await writeSyntheticCooprinsemDbf(fixturePath);
    await applyMigrations(statePath);
    context.server = await startVite({ statePath, identity });
    context.chrome = await launchChrome(profilePath);
    context.client = await CdpClient.connect(context.chrome.target.webSocketDebuggerUrl);
    await context.client.send("Page.enable");
    await context.client.send("DOM.enable");
    await context.client.send("Runtime.enable");
    await context.client.send("Network.enable");
    await context.client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await runBrowserJourneys(
      context.client,
      context.server.origin,
      fixturePath,
      downloadPath,
      identity,
    );
    await stopProcess(context.server.child);
    context.server = null;
    await runAnonymousApiCheck(statePath);
    const durationSeconds = ((Date.now() - startedAt) / 1_000).toFixed(1);
    process.stdout.write(`e2e: recorridos críticos correctos (${durationSeconds} s)\n`);
  } catch (error) {
    await captureFailure(context.client, error, context);
    throw error;
  } finally {
    if (context.client) {
      try {
        await context.client.send("Browser.close", {}, 3_000);
      } catch {
        context.client.close();
      }
    }
    await Promise.all([
      stopProcess(context.chrome?.child),
      stopProcess(context.server?.child),
    ]);
    await removeTemporaryRoot(temporaryRoot);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  let timeoutHandle;
  const timeout = new Promise((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`El harness superó ${JOURNEY_TIMEOUT_MS} ms.`)),
      JOURNEY_TIMEOUT_MS,
    );
  });
  try {
    await Promise.race([runCriticalJourneys(), timeout]);
  } catch (error) {
    process.stderr.write(`e2e: ${sanitizeDiagnostic(error instanceof Error ? error.message : error)}\n`);
    process.exitCode = 1;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
