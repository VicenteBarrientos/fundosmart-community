import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildEvidence,
  discoverRecoveryTestFiles,
  EVIDENCE_FORMAT,
  EXPECTED_TEST_FILE_COUNT,
  findWorkerBoundaryViolations,
  parseTapSummary,
  waitForWorkerArtifact,
} from "../scripts/recovery/verify-isolated.mjs";

const root = path.resolve(import.meta.dirname, "..");

test("el gate descubre exactamente las suites aisladas sin incluirse a sí mismo", () => {
  const testFiles = discoverRecoveryTestFiles(root);
  assert.equal(testFiles.length, EXPECTED_TEST_FILE_COUNT);
  assert.deepEqual(testFiles, [...testFiles].sort());
  assert.ok(testFiles.every((file) => /^tests\/cooprinsem-recovery-.*\.test\.mjs$/.test(file)));
  assert.ok(!testFiles.includes("tests/isolated-recovery-gate.test.mjs"));
});

test("la evidencia es agregada, determinista y declara cero escrituras remotas", () => {
  const testFiles = Array.from({ length: EXPECTED_TEST_FILE_COUNT }, (_, index) => `tests/cooprinsem-recovery-${index}.test.mjs`);
  const evidence = buildEvidence({
    testFiles,
    summary: { tests: 116, pass: 116, fail: 0 },
    boundaryViolations: [],
  });
  assert.deepEqual(evidence, {
    format: EVIDENCE_FORMAT,
    target: "isolated_sqlite_memory",
    productWritesEnabled: false,
    remoteWrites: false,
    testFileCount: EXPECTED_TEST_FILE_COUNT,
    testCount: 116,
    passedTestCount: 116,
    failedTestCount: 0,
    processorOrchestrationVerified: true,
    snapshotCompensationVerified: true,
    snapshotHashEvidenceVerified: true,
    ephemeralEnvironmentVerified: true,
    orphanReaperVerified: true,
    keyringRotationVerified: true,
    localLedgerVerified: true,
    localIntentReconciliationVerified: true,
    workerBoundaryVerified: true,
  });
  assert.doesNotMatch(JSON.stringify(evidence), /\.dbf|objectKey|lease|token|email/i);
});

test("el gate rechaza resumen incompleto y marcadores aislados en el Worker", () => {
  assert.deepEqual(parseTapSummary("# tests 17\n# pass 17\n# fail 0\n"), { tests: 17, pass: 17, fail: 0 });
  assert.throws(() => parseTapSummary("# tests 17\n# pass 17\n"), /total fail/);
  assert.deepEqual(findWorkerBoundaryViolations("const target = 'isolated_sqlite_memory'"), ["isolated_sqlite_memory"]);
  assert.deepEqual(findWorkerBoundaryViolations("const format = 'fundosmart.isolated-recovery-processor.v1'"), ["fundosmart.isolated-recovery-processor.v1"]);
  assert.deepEqual(findWorkerBoundaryViolations("coordinateIsolatedRecoveryPhaseFailureEvent()"), ["coordinateIsolatedRecoveryPhaseFailureEvent"]);
  assert.deepEqual(findWorkerBoundaryViolations("recordIsolatedRecoverySnapshotRestored()"), ["recordIsolatedRecoverySnapshotRestored"]);
  assert.deepEqual(findWorkerBoundaryViolations("runInIsolatedRecoveryEphemeralEnvironment()"), ["runInIsolatedRecoveryEphemeralEnvironment"]);
  assert.deepEqual(findWorkerBoundaryViolations("sweepIsolatedRecoveryOrphanWorkspaces()"), ["sweepIsolatedRecoveryOrphanWorkspaces"]);
  assert.deepEqual(findWorkerBoundaryViolations("rotateIsolatedRecoveryWorkspaceKeyring()"), ["rotateIsolatedRecoveryWorkspaceKeyring"]);
  assert.deepEqual(findWorkerBoundaryViolations("fundosmart.isolated-recovery-workspace-keyring.v1"), ["fundosmart.isolated-recovery-workspace-keyring.v1"]);
  assert.deepEqual(findWorkerBoundaryViolations("appendIsolatedRecoverySweepResult()"), ["appendIsolatedRecoverySweepResult"]);
  assert.deepEqual(findWorkerBoundaryViolations("appendIsolatedRecoverySweepIntent()"), ["appendIsolatedRecoverySweepIntent"]);
  assert.deepEqual(findWorkerBoundaryViolations("fundosmart.isolated-recovery-local-ledger-intent.v1"), ["fundosmart.isolated-recovery-local-ledger-intent.v1"]);
  assert.deepEqual(findWorkerBoundaryViolations("fundosmart.isolated-recovery-local-ledger.v1"), ["fundosmart.isolated-recovery-local-ledger.v1"]);
  assert.throws(() => buildEvidence({
    testFiles: Array(EXPECTED_TEST_FILE_COUNT).fill("test.mjs"),
    summary: { tests: 17, pass: 16, fail: 1 },
    boundaryViolations: [],
  }), /no está completa/);
});

test("el gate espera de forma acotada la materialización tardía del artefacto", () => {
  let checks = 0;
  const successfulSleeps = [];
  assert.equal(waitForWorkerArtifact("dist/server/index.js", {
    timeoutMs: 100,
    pollIntervalMs: 25,
    exists: () => {
      checks += 1;
      return checks === 3;
    },
    sleep: (milliseconds) => successfulSleeps.push(milliseconds),
  }), true);
  assert.equal(checks, 3);
  assert.deepEqual(successfulSleeps, [25, 25]);

  const exhaustedSleeps = [];
  assert.equal(waitForWorkerArtifact("dist/server/index.js", {
    timeoutMs: 100,
    pollIntervalMs: 25,
    exists: () => false,
    sleep: (milliseconds) => exhaustedSleeps.push(milliseconds),
  }), false);
  assert.deepEqual(exhaustedSleeps, [25, 25, 25, 25]);
  assert.throws(() => waitForWorkerArtifact("dist/server/index.js", { timeoutMs: -1 }), /tiempos enteros válidos/);
});

test("los comandos son locales, construyen el artefacto y no duplican el gate canónico", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const source = await readFile(path.join(root, "scripts", "recovery", "verify-isolated.mjs"), "utf8");
  assert.equal(packageJson.scripts["recovery:check"], "npm run build && npm run recovery:check:built");
  assert.equal(packageJson.scripts["recovery:check:built"], "node scripts/recovery/verify-isolated.mjs");
  assert.doesNotMatch(packageJson.scripts.check, /recovery:check/);
  assert.doesNotMatch(source, /--remote|wrangler|\br2\b|\bd1\b|deploy|fetch\s*\(/i);
});
