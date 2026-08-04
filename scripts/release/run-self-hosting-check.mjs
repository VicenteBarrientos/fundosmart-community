import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDistSnapshot,
  createSelfHostingAttestation,
  digestDistTree,
  removeDistSnapshot,
  writeSelfHostingAttestation,
} from "./self-hosting-attestation.mjs";
import {
  resolveTrustedNpmCli,
  runSelfHostingGate,
} from "./self-hosting-gate-runner.mjs";
import {
  createSelfHostingGateWorkspace,
  publishGateDist,
  removeSelfHostingGateWorkspace,
} from "./self-hosting-gate-workspace.mjs";
import {
  SELF_HOSTING_BUILD_VARIABLE_KEYS,
  readGitStatus,
  readHeadSha,
  validateBuiltWorkerConfig,
  validateSelfHostingEnvironment,
  validateSelfHostingEnvironmentSelection,
} from "./self-hosting-preflight.mjs";
import { readStrictDotEnvFile } from "./self-hosting-env-files.mjs";

const DEFAULT_DIST_PATH = "dist";
const DEFAULT_BUILT_CONFIG = "dist/server/wrangler.json";

export { resolveTrustedNpmCli };

export async function runSelfHostingCheck({
  cwd = process.cwd(),
  expectedEnvironment,
  envFile,
  secretsFile,
  distPath = DEFAULT_DIST_PATH,
  builtConfig = DEFAULT_BUILT_CONFIG,
  attestationFile,
  expectedHeadSha,
  gitStatus,
  readCurrentHeadSha,
  readCurrentGitStatus,
  hostEnvironment = process.env,
  runGate = runSelfHostingGate,
  createGateWorkspace = createSelfHostingGateWorkspace,
  removeGateWorkspace = removeSelfHostingGateWorkspace,
  publishDist = publishGateDist,
} = {}) {
  const selectedEnvironment = String(expectedEnvironment ?? "").trim().toLowerCase();
  if (typeof envFile !== "string" || !envFile.trim() || typeof secretsFile !== "string" || !secretsFile.trim()) {
    throw new Error("Self-hosting checks require explicit environment and secrets files.");
  }
  const environmentPath = path.resolve(cwd, envFile);
  const secretsPath = path.resolve(cwd, secretsFile);
  const resolvedDistPath = path.resolve(cwd, distPath);
  const expectedDistPath = path.resolve(cwd, DEFAULT_DIST_PATH);
  const configPath = path.resolve(cwd, builtConfig);
  const expectedConfigPath = path.resolve(cwd, DEFAULT_BUILT_CONFIG);
  if (resolvedDistPath !== expectedDistPath || configPath !== expectedConfigPath) {
    throw new Error("Self-hosting checks must attest the canonical dist tree and dist/server/wrangler.json.");
  }
  const attestationPath = path.resolve(
    cwd,
    attestationFile ?? path.join(".wrangler", "self-hosting", `${selectedEnvironment}.attestation.json`),
  );
  const getHeadSha = readCurrentHeadSha
    ?? (expectedHeadSha === undefined ? () => readHeadSha({ cwd }) : () => expectedHeadSha);
  const getGitStatus = readCurrentGitStatus
    ?? (gitStatus === undefined ? () => readGitStatus({ cwd }) : () => gitStatus);

  const loadedEnvironment = await readStrictDotEnvFile(environmentPath, {
    label: "deployment environment file",
  });
  const initialEnvironmentBytes = loadedEnvironment.bytes;
  const variables = loadedEnvironment.values;
  validateSelfHostingEnvironmentSelection({
    expectedEnvironment: selectedEnvironment,
    variables,
    envFile: environmentPath,
    secretsFile: secretsPath,
  });
  const checkoutSha = await getHeadSha();
  const checkoutStatus = await getGitStatus();
  validateInitialGateSource({ variables, checkoutSha, checkoutStatus });

  let workspace;
  let snapshot;
  let attestation;
  let initialSecretsBytes;
  let operationError;
  try {
    workspace = await createGateWorkspace({ cwd, releaseSha: checkoutSha });
    await runGate({
      cwd: workspace.workspacePath,
      variables,
      hostEnvironment,
    });
    await requireUnchangedEnvironmentAndSource({
      environmentPath,
      initialEnvironmentBytes,
      checkoutSha,
      getHeadSha,
      getGitStatus,
    });

    const loadedSecrets = await readStrictDotEnvFile(secretsPath, {
      label: "self-hosting secrets file",
    });
    initialSecretsBytes = loadedSecrets.bytes;
    const secrets = loadedSecrets.values;
    validateSelfHostingEnvironment({
      variables,
      secrets,
      expectedHeadSha: checkoutSha,
      gitStatus: checkoutStatus,
      processEnvironment: hostEnvironment,
    });

    const gateDistPath = path.join(workspace.workspacePath, DEFAULT_DIST_PATH);
    snapshot = await createDistSnapshot({
      distPath: gateDistPath,
      temporaryParent: workspace.rootPath,
    });
    const snapshotConfigPath = path.join(snapshot.distPath, "server", "wrangler.json");
    const config = JSON.parse(await readFile(snapshotConfigPath, "utf8"));
    validateBuiltWorkerConfig({ config, variables, secrets });
    attestation = await createSelfHostingAttestation({
      releaseSha: checkoutSha,
      environment: selectedEnvironment,
      envBytes: initialEnvironmentBytes,
      secretsBytes: initialSecretsBytes,
      distPath: snapshot.distPath,
      configRelativePath: "server/wrangler.json",
      migrationsPath: path.join(workspace.workspacePath, "drizzle"),
      gitCwd: workspace.workspacePath,
      migrationsRelativePath: "drizzle",
    });
    await requireUnchangedInputs({
      environmentPath,
      secretsPath,
      initialEnvironmentBytes,
      initialSecretsBytes,
      checkoutSha,
      getHeadSha,
      getGitStatus,
    });

    const published = await publishDist({ cwd, sourceDistPath: gateDistPath });
    if (!sameResolvedPath(published?.distPath, resolvedDistPath)
      || published?.artifactSha256 !== attestation.artifactSha256
      || published?.fileCount !== attestation.fileCount
      || published?.rollbackRetained) {
      throw new Error("The published canonical dist tree does not match the attested gate artifact.");
    }
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = [];
  if (snapshot) {
    try {
      await removeDistSnapshot(snapshot);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (workspace) {
    try {
      await removeGateWorkspace(workspace);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "The self-hosting gate failed and its isolated workspace did not clean up completely.",
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "The self-hosting gate passed but its isolated workspace did not clean up completely.",
    );
  }
  if (operationError) throw operationError;

  await requireUnchangedInputs({
    environmentPath,
    secretsPath,
    initialEnvironmentBytes,
    initialSecretsBytes,
    checkoutSha,
    getHeadSha,
    getGitStatus,
  });
  const publishedDigest = await digestDistTree({ distPath: resolvedDistPath });
  if (publishedDigest.artifactSha256 !== attestation.artifactSha256
    || publishedDigest.fileCount !== attestation.fileCount) {
    throw new Error("The canonical dist tree changed after the isolated artifact was published.");
  }
  await requireUnchangedInputs({
    environmentPath,
    secretsPath,
    initialEnvironmentBytes,
    initialSecretsBytes,
    checkoutSha,
    getHeadSha,
    getGitStatus,
  });
  await writeSelfHostingAttestation({ attestation, outputPath: attestationPath });

  process.stdout.write(
    `Self-hosting gate passed for ${selectedEnvironment}; artifact attestation written to ${path.relative(cwd, attestationPath)}.\n`,
  );
  return true;
}

function validateInitialGateSource({ variables, checkoutSha, checkoutStatus }) {
  const allowedKeys = new Set(SELF_HOSTING_BUILD_VARIABLE_KEYS);
  const unexpectedKeys = Object.keys(variables).filter((key) => !allowedKeys.has(key));
  const releaseSha = String(variables.FUNDOSMART_RELEASE_SHA ?? "").trim().toLowerCase();
  const actualSha = String(checkoutSha ?? "").trim().toLowerCase();
  if (unexpectedKeys.length > 0) {
    throw new Error(`The deployment environment contains unsupported keys: ${unexpectedKeys.join(", ")}.`);
  }
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(actualSha) || releaseSha !== actualSha) {
    throw new Error("The deployment release SHA must match the exact checked-out Git commit before the gate starts.");
  }
  if (typeof checkoutStatus !== "string" || checkoutStatus.trim()) {
    throw new Error("The Git index and working tree must be clean before the isolated gate starts.");
  }
}

async function requireUnchangedInputs({
  environmentPath,
  secretsPath,
  initialEnvironmentBytes,
  initialSecretsBytes,
  checkoutSha,
  getHeadSha,
  getGitStatus,
}) {
  const [environment, secrets] = await Promise.all([
    readStrictDotEnvFile(environmentPath, { label: "deployment environment file" }),
    readStrictDotEnvFile(secretsPath, { label: "self-hosting secrets file" }),
  ]);
  if (!environment.bytes.equals(initialEnvironmentBytes) || !secrets.bytes.equals(initialSecretsBytes)) {
    throw new Error("The selected environment or secrets file changed while the self-hosting gate was running.");
  }
  await requireUnchangedSource({ checkoutSha, getHeadSha, getGitStatus });
}

async function requireUnchangedEnvironmentAndSource({
  environmentPath,
  initialEnvironmentBytes,
  checkoutSha,
  getHeadSha,
  getGitStatus,
}) {
  const environment = await readStrictDotEnvFile(environmentPath, {
    label: "deployment environment file",
  });
  if (!environment.bytes.equals(initialEnvironmentBytes)) {
    throw new Error("The selected environment file changed while the self-hosting gate was running.");
  }
  await requireUnchangedSource({ checkoutSha, getHeadSha, getGitStatus });
}

async function requireUnchangedSource({ checkoutSha, getHeadSha, getGitStatus }) {
  const [headSha, status] = await Promise.all([
    Promise.resolve().then(() => getHeadSha()),
    Promise.resolve().then(() => getGitStatus()),
  ]);
  if (String(headSha ?? "").trim().toLowerCase() !== String(checkoutSha).trim().toLowerCase()) {
    throw new Error("Git HEAD changed while the self-hosting gate was running.");
  }
  if (typeof status !== "string" || status.trim()) {
    throw new Error("Git index or working tree changed while the self-hosting gate was running.");
  }
}

function sameResolvedPath(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = new Map([
      ["--environment", "expectedEnvironment"],
      ["--env-file", "envFile"],
      ["--secrets-file", "secretsFile"],
    ]).get(args[index]);
    if (!key || !args[index + 1] || Object.hasOwn(options, key)) {
      throw new Error(`Unknown, duplicate or incomplete argument: ${args[index]}`);
    }
    options[key] = args[index + 1];
    index += 1;
  }
  for (const key of ["expectedEnvironment", "envFile", "secretsFile"]) {
    if (!Object.hasOwn(options, key)) {
      throw new Error("Usage: self-host:check -- --environment <staging|production> --env-file <path> --secrets-file <path>");
    }
  }
  return options;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve()
    .then(() => runSelfHostingCheck(parseArguments(process.argv.slice(2))))
    .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
