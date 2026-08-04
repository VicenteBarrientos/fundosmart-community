import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const EVIDENCE_FORMAT = "fundosmart.isolated-recovery-gate.v9";
export const ISOLATED_TARGET = "isolated_sqlite_memory";
export const EXPECTED_TEST_FILE_COUNT = 19;

const workerBoundaryMarkers = [
  "fundosmart.recovery-rehearsal.v1",
  "isolated_sqlite_memory",
  "isolated-recovery-reconciler",
  "fundosmart.isolated-recovery-processor.v1",
  "runIsolatedRecoveryRehearsal",
  "runIsolatedRecoveryProcessorStep",
  "coordinateIsolatedRecoveryPhaseFailureEvent",
  "recordIsolatedRecoverySnapshotRestored",
  "runInIsolatedRecoveryEphemeralEnvironment",
  "sweepIsolatedRecoveryOrphanWorkspaces",
  "rotateIsolatedRecoveryWorkspaceKeyring",
  "fundosmart.isolated-recovery-workspace-keyring.v1",
  "appendIsolatedRecoverySweepResult",
  "appendIsolatedRecoverySweepIntent",
  "fundosmart.isolated-recovery-local-ledger-intent.v1",
  "fundosmart.isolated-recovery-local-ledger.v1",
  "applyInsertOnlyRestoreRows",
];

export function repositoryRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

export function discoverRecoveryTestFiles(root = repositoryRoot()) {
  return readdirSync(path.join(root, "tests"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^cooprinsem-recovery-.*\.test\.mjs$/.test(entry.name))
    .map((entry) => path.posix.join("tests", entry.name))
    .sort();
}

export function parseTapSummary(output) {
  const readCount = (label) => {
    const match = output.match(new RegExp(`^# ${label} (\\d+)\\s*$`, "m"));
    if (!match) {
      throw new Error(`TAP no informó el total ${label}`);
    }
    return Number(match[1]);
  };

  return {
    tests: readCount("tests"),
    pass: readCount("pass"),
    fail: readCount("fail"),
  };
}

export function findWorkerBoundaryViolations(workerSource) {
  return workerBoundaryMarkers.filter((marker) => workerSource.includes(marker));
}

function sleepSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function waitForWorkerArtifact(workerPath, {
  timeoutMs = 5_000,
  pollIntervalMs = 50,
  exists = existsSync,
  sleep = sleepSynchronously,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || !Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError("La espera del artefacto requiere tiempos enteros válidos");
  }

  const attempts = Math.floor(timeoutMs / pollIntervalMs) + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (exists(workerPath)) return true;
    if (attempt < attempts - 1) sleep(pollIntervalMs);
  }
  return false;
}

export function buildEvidence({ testFiles, summary, boundaryViolations }) {
  if (testFiles.length !== EXPECTED_TEST_FILE_COUNT) {
    throw new Error(`Se esperaban ${EXPECTED_TEST_FILE_COUNT} suites de recuperación y se encontraron ${testFiles.length}`);
  }
  if (summary.tests < testFiles.length || summary.pass !== summary.tests || summary.fail !== 0) {
    throw new Error("La evidencia de pruebas aisladas no está completa");
  }
  if (boundaryViolations.length > 0) {
    throw new Error("El ejecutor o reconciliador aislado apareció en el Worker");
  }

  return {
    format: EVIDENCE_FORMAT,
    target: ISOLATED_TARGET,
    productWritesEnabled: false,
    remoteWrites: false,
    testFileCount: testFiles.length,
    testCount: summary.tests,
    passedTestCount: summary.pass,
    failedTestCount: summary.fail,
    processorOrchestrationVerified: true,
    snapshotCompensationVerified: true,
    snapshotHashEvidenceVerified: true,
    ephemeralEnvironmentVerified: true,
    orphanReaperVerified: true,
    keyringRotationVerified: true,
    localLedgerVerified: true,
    localIntentReconciliationVerified: true,
    workerBoundaryVerified: true,
  };
}

export function runIsolatedRecoveryGate(root = repositoryRoot()) {
  const workerPath = path.join(root, "dist", "server", "index.js");
  if (!waitForWorkerArtifact(workerPath)) {
    throw new Error("Falta dist/server/index.js; ejecute npm run recovery:check para construir primero");
  }

  const testFiles = discoverRecoveryTestFiles(root);
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    if (result.stdout) process.stderr.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`Las pruebas de recuperación aislada terminaron con código ${result.status}`);
  }

  const summary = parseTapSummary(result.stdout);
  const workerSource = readFileSync(workerPath, "utf8");
  return buildEvidence({
    testFiles,
    summary,
    boundaryViolations: findWorkerBoundaryViolations(workerSource),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    process.stdout.write(`${JSON.stringify(runIsolatedRecoveryGate())}\n`);
  } catch (error) {
    process.stderr.write(`recovery:check: ${error instanceof Error ? error.message : "fallo inesperado"}\n`);
    process.exitCode = 1;
  }
}
