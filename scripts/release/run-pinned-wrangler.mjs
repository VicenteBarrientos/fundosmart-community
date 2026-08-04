import { spawn } from "node:child_process";
import { chmod, link, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDistSnapshot,
  removeDistSnapshot,
  verifySelfHostingAttestation,
} from "./self-hosting-attestation.mjs";
import {
  SELF_HOSTING_BUILD_VARIABLE_KEYS,
  readGitStatus,
  readHeadSha,
  validateBuiltWorkerConfig,
  validateSelfHostingEnvironment,
  validateSelfHostingEnvironmentSelection,
} from "./self-hosting-preflight.mjs";
import { readStrictDotEnvFile } from "./self-hosting-env-files.mjs";
import {
  createSelfHostingToolingEnvironment,
  installSelfHostingTooling,
  removeSelfHostingTooling,
  verifySelfHostingTooling,
} from "./self-hosting-gate-runner.mjs";
import { validateSelfHostingWranglerCommand } from "./self-hosting-wrangler-command.mjs";

const DEFAULT_DIST_PATH = "dist";
const DEFAULT_CONFIG_PATH = "dist/server/wrangler.json";
const ACCOUNT_ID = /^[0-9a-f]{32}$/iu;
const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const WRANGLER_AUTO_CONFIG = /^wrangler(?:\.(?:toml|json|jsonc))?$/iu;

export async function runPinnedWrangler({
  cwd = process.cwd(),
  expectedEnvironment,
  envFile,
  secretsFile,
  confirmStaging,
  confirmProduction,
  confirmDestructive,
  wranglerArguments = [],
  hostEnvironment = process.env,
  expectedHeadSha,
  gitStatus,
  readCurrentHeadSha,
  readCurrentGitStatus,
  runWrangler = spawnWrangler,
  installTooling = installSelfHostingTooling,
  removeTooling = removeSelfHostingTooling,
  createToolingEnvironment = createSelfHostingToolingEnvironment,
  verifyTooling = verifySelfHostingTooling,
  beforeWranglerSpawn,
} = {}) {
  for (const [label, dependency] of Object.entries({
    runWrangler,
    installTooling,
    removeTooling,
    createToolingEnvironment,
    verifyTooling,
  })) {
    if (typeof dependency !== "function") throw new Error(`${label} must be a function.`);
  }
  if (beforeWranglerSpawn !== undefined && typeof beforeWranglerSpawn !== "function") {
    throw new Error("beforeWranglerSpawn must be a function when provided.");
  }
  if (typeof envFile !== "string" || !envFile.trim()) {
    throw new Error("The pinned wrapper requires an explicit --env-file before --.");
  }
  const selectedEnvironment = String(expectedEnvironment ?? "").trim().toLowerCase();
  const environmentPath = path.resolve(cwd, envFile);
  const loadedEnvironment = await readStrictDotEnvFile(environmentPath, {
    label: "deployment environment file",
  });
  const initialEnvironmentBytes = loadedEnvironment.bytes;
  const canonicalEnvironmentBytes = loadedEnvironment.canonicalDotEnvBytes;
  const variables = loadedEnvironment.values;
  const unknownKeys = Object.keys(variables).filter((key) => !SELF_HOSTING_BUILD_VARIABLE_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported deployment environment key(s): ${unknownKeys.join(", ")}.`);
  }
  validateSelfHostingEnvironmentSelection({
    expectedEnvironment: selectedEnvironment,
    variables,
    envFile: environmentPath,
  });

  const accountId = String(variables.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (!ACCOUNT_ID.test(accountId) || /^0+$/u.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be the real 32-character owner account ID.");
  }
  const workerName = String(variables.FUNDOSMART_WORKER_NAME ?? "").trim();
  if (!workerName || workerName !== variables.FUNDOSMART_WORKER_NAME) {
    throw new Error("FUNDOSMART_WORKER_NAME must be an exact non-empty Worker name.");
  }
  const getHeadSha = readCurrentHeadSha
    ?? (expectedHeadSha === undefined ? () => readHeadSha({ cwd }) : () => expectedHeadSha);
  const getGitStatus = readCurrentGitStatus
    ?? (gitStatus === undefined ? () => readGitStatus({ cwd }) : () => gitStatus);
  const checkoutSha = getHeadSha();
  const checkoutStatus = getGitStatus();
  const releaseSha = String(variables.FUNDOSMART_RELEASE_SHA ?? "").trim();
  if (!RELEASE_SHA.test(String(checkoutSha ?? "")) || releaseSha.toLowerCase() !== checkoutSha.toLowerCase()) {
    throw new Error("FUNDOSMART_RELEASE_SHA must match a resolvable Git HEAD before running Wrangler.");
  }
  if (typeof checkoutStatus !== "string" || checkoutStatus.trim()) {
    throw new Error("Git index and working tree must be clean before running a remote Wrangler command.");
  }
  const command = validateSelfHostingWranglerCommand({ wranglerArguments, variables });
  validateConfirmations({
    command,
    selectedEnvironment,
    workerName,
    confirmStaging,
    confirmProduction,
    confirmDestructive,
  });
  const distPath = path.resolve(cwd, DEFAULT_DIST_PATH);
  const configPath = path.resolve(cwd, DEFAULT_CONFIG_PATH);
  const attestationPath = path.resolve(
    cwd,
    ".wrangler",
    "self-hosting",
    `${selectedEnvironment}.attestation.json`,
  );
  let initialSecretsBytes;
  let canonicalSecretsBytes;
  let secrets;
  let resolvedSecretsPath;
  if (!command.requiresSecrets && secretsFile !== undefined) {
    throw new Error("--secrets-file is accepted only for the allowlisted deploy command.");
  }
  let tooling;
  let snapshot;
  let migrationsSnapshot;
  let standaloneContextPath;
  let privateRuntimePath;
  let privateSecretsParentIdentity;
  let invocationSecretsPath;
  let backupExport;
  let operationError;
  try {
    tooling = await installTooling({
      cwd,
      releaseSha: checkoutSha,
      hostEnvironment,
    });
    if (command.requiresSecrets) {
      if (typeof secretsFile !== "string" || !secretsFile.trim()) {
        throw new Error("deploy requires an explicit wrapper-level --secrets-file before --.");
      }
      resolvedSecretsPath = path.resolve(cwd, secretsFile);
      await requireApprovedSecretsSource({ cwd, secretsPath: resolvedSecretsPath });
      const loadedSecrets = await readStrictDotEnvFile(resolvedSecretsPath, {
        label: "self-hosting secrets file",
      });
      initialSecretsBytes = loadedSecrets.bytes;
      canonicalSecretsBytes = loadedSecrets.canonicalJsonBytes;
      secrets = loadedSecrets.values;
      validateSelfHostingEnvironmentSelection({
        expectedEnvironment: selectedEnvironment,
        variables,
        envFile: environmentPath,
        secretsFile: resolvedSecretsPath,
      });
      validateSelfHostingEnvironment({
        variables,
        secrets,
        expectedHeadSha: checkoutSha,
        gitStatus: checkoutStatus,
        processEnvironment: hostEnvironment,
      });
    }

    if (command.requiresBuild) {
      await validateAttestedBuild({
        attestationPath,
        configPath,
        distPath,
        envBytes: initialEnvironmentBytes,
        secretsBytes: initialSecretsBytes,
        migrationsPath: path.resolve(cwd, "drizzle"),
        gitCwd: cwd,
        releaseSha: checkoutSha,
        selectedEnvironment,
        variables,
        secrets,
      });
    }
    const environment = await createToolingEnvironment({ tooling, hostEnvironment, accountId });
    if (command.requiresBuild) {
      snapshot = await createDistSnapshot({
        distPath,
        temporaryParent: tooling.runtime.tempPath,
      });
      if (isD1MigrationsCommand(command.normalizedArguments)) {
        migrationsSnapshot = await createDistSnapshot({
          distPath: path.resolve(cwd, "drizzle"),
          temporaryParent: tooling.runtime.tempPath,
        });
      }
      await validateAttestedBuild({
        attestationPath,
        configPath: path.join(snapshot.distPath, "server", "wrangler.json"),
        distPath: snapshot.distPath,
        envBytes: initialEnvironmentBytes,
        secretsBytes: initialSecretsBytes,
        migrationsPath: migrationsSnapshot?.distPath ?? path.resolve(cwd, "drizzle"),
        gitCwd: cwd,
        releaseSha: checkoutSha,
        selectedEnvironment,
        variables,
        secrets,
      });
    } else {
      standaloneContextPath = await mkdtemp(path.join(tooling.runtime.tempPath, "wrangler-context-"));
      await chmod(standaloneContextPath, 0o700);
    }
    const contextPath = snapshot?.rootPath ?? standaloneContextPath;
    let invocationConfigPath = snapshot
      ? path.join(snapshot.distPath, "server", "wrangler.json")
      : undefined;
    const invocationEnvironmentPath = path.join(contextPath, "deployment.env");
    if (command.requiresSecrets) {
      privateRuntimePath = await mkdtemp(path.join(tooling.runtime.tempPath, "wrangler-secrets-"));
      await chmod(privateRuntimePath, 0o700);
      privateSecretsParentIdentity = await capturePrivateSecretsParentIdentity({
        directoryPath: privateRuntimePath,
        expectedParentPath: tooling.runtime.tempPath,
      });
      invocationSecretsPath = path.join(privateRuntimePath, "secrets.json");
    }

    if (!command.requiresBuild) {
      invocationConfigPath = path.join(contextPath, "deployment-config.json");
      await writeFile(
        invocationConfigPath,
        createBootstrapWranglerConfigBytes({ accountId, workerName }),
        { flag: "wx", mode: 0o600 },
      );
    }

    if (isD1MigrationsCommand(command.normalizedArguments)) {
      const derivedConfig = JSON.parse(await readFile(invocationConfigPath, "utf8"));
      derivedConfig.d1_databases[0].migrations_dir = migrationsSnapshot.distPath;
      invocationConfigPath = path.join(contextPath, "deployment-config.json");
      await writeFile(invocationConfigPath, `${JSON.stringify(derivedConfig)}\n`, { flag: "wx", mode: 0o600 });
    }

    await writeFile(invocationEnvironmentPath, canonicalEnvironmentBytes, { flag: "wx", mode: 0o600 });
    if (command.requiresSecrets) {
      await writeFile(invocationSecretsPath, canonicalSecretsBytes, { flag: "wx", mode: 0o600 });
      await chmod(invocationSecretsPath, 0o600);
    }

    let argumentsList = [...command.normalizedArguments];
    backupExport = await prepareBackupExport({
      cwd,
      selectedEnvironment,
      argumentsList,
    });
    argumentsList = backupExport?.argumentsList ?? argumentsList;
    argumentsList.push("--config", invocationConfigPath);
    if (command.requiresSecrets) argumentsList.push("--secrets-file", invocationSecretsPath);
    argumentsList.push("--env-file", invocationEnvironmentPath);
    const expectedInvocationConfigBytes = invocationConfigPath
      ? await readFile(invocationConfigPath)
      : undefined;
    if (beforeWranglerSpawn) {
      await beforeWranglerSpawn({
        contextPath,
        invocationConfigPath,
        invocationEnvironmentPath,
        invocationSecretsPath,
        tooling,
      });
    }
    await requireUnchangedInputs({
      environmentPath,
      secretsPath: resolvedSecretsPath,
      initialEnvironmentBytes,
      initialSecretsBytes,
      checkoutSha,
      getHeadSha,
      getGitStatus,
    });
    await requireExactFileBytes(
      invocationEnvironmentPath,
      canonicalEnvironmentBytes,
      "private deployment environment snapshot",
    );
    if (command.requiresSecrets) {
      await requireExactFileBytes(
        invocationSecretsPath,
        canonicalSecretsBytes,
        "private deployment secrets snapshot",
      );
    }
    if (command.requiresBuild) {
      await validateAttestedBuild({
        attestationPath,
        configPath,
        distPath,
        envBytes: initialEnvironmentBytes,
        secretsBytes: initialSecretsBytes,
        migrationsPath: path.resolve(cwd, "drizzle"),
        gitCwd: cwd,
        releaseSha: checkoutSha,
        selectedEnvironment,
        variables,
        secrets,
      });
      await validateAttestedBuild({
        attestationPath,
        configPath: path.join(snapshot.distPath, "server", "wrangler.json"),
        distPath: snapshot.distPath,
        envBytes: initialEnvironmentBytes,
        secretsBytes: initialSecretsBytes,
        migrationsPath: migrationsSnapshot?.distPath ?? path.resolve(cwd, "drizzle"),
        gitCwd: cwd,
        releaseSha: checkoutSha,
        selectedEnvironment,
        variables,
        secrets,
      });
    }
    await verifyTooling(tooling);
    await requirePrivateInvocationContext({
      contextPath,
      sourcePath: cwd,
      toolingWorkspacePath: tooling.workspace.workspacePath,
      expectedEntries: [
        "deployment.env",
        ...(snapshot ? ["dist"] : ["deployment-config.json"]),
        ...(isD1MigrationsCommand(command.normalizedArguments) ? ["deployment-config.json"] : []),
      ],
    });
    await requireExactFileBytes(
      invocationConfigPath,
      expectedInvocationConfigBytes,
      "private Wrangler config snapshot",
    );
    await requireExactWranglerTarget({
      configPath: invocationConfigPath,
      expectedAccountId: accountId,
      expectedWorkerName: workerName,
    });
    if (command.requiresSecrets) {
      await requireUnchangedPrivateSecretsParent(privateSecretsParentIdentity);
    }
    await runWrangler({
      cwd: contextPath,
      environment,
      argumentsList,
      nodeExecutable: tooling.nodeExecutable,
      wranglerCli: tooling.wranglerCli,
      toolingWorkspacePath: tooling.workspace.workspacePath,
    });
    await backupExport?.publish();
  } catch (error) {
    operationError = error;
  }
  const cleanupErrors = await cleanupInvocationResources({
    invocationSecretsPath,
    privateRuntimePath,
    backupExport,
    migrationsSnapshot,
    snapshot,
    standaloneContextPath,
  });
  if (tooling) {
    try {
      await removeTooling(tooling);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError || cleanupErrors.length > 0) {
    const errors = [...(operationError ? [operationError] : []), ...cleanupErrors];
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Wrangler operation or secure cleanup failed.");
  }
}

function createBootstrapWranglerConfigBytes({ accountId, workerName }) {
  return Buffer.from(`${JSON.stringify({
    account_id: accountId,
    name: workerName,
  }, null, 2)}\n`, "utf8");
}

export async function createPinnedWranglerEnvironment(options = {}) {
  return createSelfHostingToolingEnvironment(options);
}

async function validateAttestedBuild({
  attestationPath,
  configPath,
  distPath,
  envBytes,
  secretsBytes,
  migrationsPath,
  gitCwd,
  releaseSha,
  selectedEnvironment,
  variables,
  secrets,
}) {
  const expectedConfigPath = path.join(distPath, "server", "wrangler.json");
  if (path.resolve(configPath) !== path.resolve(expectedConfigPath)) {
    throw new Error("The verified Worker config must be dist/server/wrangler.json inside the attested artifact.");
  }
  await verifySelfHostingAttestation({
    attestationPath,
    releaseSha,
    environment: selectedEnvironment,
    envBytes,
    ...(secretsBytes ? { secretsBytes } : {}),
    distPath,
    configRelativePath: "server/wrangler.json",
    migrationsPath,
    gitCwd,
    migrationsRelativePath: "drizzle",
  });
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateBuiltWorkerConfig({ config, variables, secrets });
}

function validateConfirmations({
  command,
  selectedEnvironment,
  workerName,
  confirmStaging,
  confirmProduction,
  confirmDestructive,
}) {
  const selectedConfirmation = selectedEnvironment === "staging" ? confirmStaging : confirmProduction;
  const oppositeConfirmation = selectedEnvironment === "staging" ? confirmProduction : confirmStaging;
  if (command.mutating) {
    if (selectedConfirmation !== workerName || oppositeConfirmation !== undefined) {
      throw new Error(
        `This write requires exactly --confirm-${selectedEnvironment} ${workerName} before --.`,
      );
    }
  } else if (confirmStaging !== undefined || confirmProduction !== undefined) {
    throw new Error("Write confirmation flags are not accepted for read-only commands.");
  }

  if (command.destructive) {
    const expectedTarget = destructiveConfirmationTarget(command.normalizedArguments);
    if (confirmDestructive !== expectedTarget) {
      throw new Error(`This destructive operation requires --confirm-destructive ${expectedTarget} before --.`);
    }
  } else if (confirmDestructive !== undefined) {
    throw new Error("--confirm-destructive is accepted only for a destructive allowlisted command.");
  }
}

function destructiveConfirmationTarget(argumentsList) {
  if (argumentsList[0] === "secret" && argumentsList[1] === "delete") {
    return `secret:${argumentsList[2]}`;
  }
  if (argumentsList[0] === "rollback") return `worker-version:${argumentsList[1]}`;
  if (argumentsList[0] === "d1" && argumentsList[1] === "time-travel" && argumentsList[2] === "restore") {
    return `d1-bookmark:${argumentsList[5]}`;
  }
  throw new Error("The destructive command has no canonical confirmation target.");
}

function isD1MigrationsCommand(argumentsList) {
  return argumentsList[0] === "d1" && argumentsList[1] === "migrations";
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
  const currentEnvironmentBytes = await readFile(environmentPath);
  if (!currentEnvironmentBytes.equals(initialEnvironmentBytes)) {
    throw new Error("The selected deployment environment changed before Wrangler could run.");
  }
  if (secretsPath) {
    const currentSecretsBytes = await readFile(secretsPath);
    if (!currentSecretsBytes.equals(initialSecretsBytes)) {
      throw new Error("The selected deployment secrets changed before Wrangler could run.");
    }
  }
  if (String(getHeadSha()).toLowerCase() !== String(checkoutSha).toLowerCase()) {
    throw new Error("Git HEAD changed before Wrangler could run.");
  }
  const status = getGitStatus();
  if (typeof status !== "string" || status.trim()) {
    throw new Error("Git index or working tree changed before Wrangler could run.");
  }
}

async function requireExactFileBytes(filePath, expectedBytes, label) {
  const stats = await lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`The ${label} must remain a regular file.`);
  }
  const bytes = await readFile(filePath);
  if (!bytes.equals(expectedBytes)) throw new Error(`The ${label} changed before Wrangler could run.`);
}

async function requireExactWranglerTarget({ configPath, expectedAccountId, expectedWorkerName }) {
  let config;
  try {
    config = JSON.parse(await readFile(configPath, "utf8"));
  } catch (error) {
    throw new Error("The private Wrangler config snapshot must remain valid JSON.", { cause: error });
  }
  if (config?.account_id !== expectedAccountId || config?.name !== expectedWorkerName) {
    throw new Error("The private Wrangler config snapshot must remain bound to the exact account and Worker.");
  }
}

async function capturePrivateSecretsParentIdentity({ directoryPath, expectedParentPath }) {
  const directoryIdentity = await readExactDirectoryIdentity(
    directoryPath,
    "private deployment secrets snapshot parent",
  );
  const containerIdentity = await readExactDirectoryIdentity(
    expectedParentPath,
    "private tooling temp directory",
  );
  if (!sameResolvedPath(path.dirname(directoryIdentity.realPath), containerIdentity.realPath)) {
    throw new Error("The private deployment secrets snapshot parent escaped the private tooling temp directory.");
  }
  return Object.freeze({ directoryIdentity, containerIdentity });
}

async function requireUnchangedPrivateSecretsParent(expectedIdentity) {
  if (!expectedIdentity?.directoryIdentity || !expectedIdentity?.containerIdentity) {
    throw new Error("The private deployment secrets snapshot parent identity is missing.");
  }
  const currentContainerIdentity = await readExactDirectoryIdentity(
    expectedIdentity.containerIdentity.resolvedPath,
    "private tooling temp directory",
  );
  const currentDirectoryIdentity = await readExactDirectoryIdentity(
    expectedIdentity.directoryIdentity.resolvedPath,
    "private deployment secrets snapshot parent",
  );
  if (!sameDirectoryIdentity(currentContainerIdentity, expectedIdentity.containerIdentity)
    || !sameDirectoryIdentity(currentDirectoryIdentity, expectedIdentity.directoryIdentity)
    || !sameResolvedPath(
      path.dirname(currentDirectoryIdentity.realPath),
      currentContainerIdentity.realPath,
    )) {
    throw new Error("The private deployment secrets snapshot parent changed identity before Wrangler could run.");
  }
}

async function readExactDirectoryIdentity(directoryPath, label) {
  const resolvedPath = path.resolve(directoryPath);
  let stats;
  let realPath;
  try {
    [stats, realPath] = await Promise.all([
      lstat(resolvedPath, { bigint: true }),
      realpath(resolvedPath),
    ]);
  } catch (error) {
    throw new Error(`The ${label} could not be revalidated.`, { cause: error });
  }
  if (stats.isSymbolicLink()
    || !stats.isDirectory()
    || !sameResolvedPath(resolvedPath, realPath)) {
    throw new Error(`The ${label} must remain an exact regular directory.`);
  }
  return Object.freeze({
    resolvedPath,
    realPath,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    birthtimeNanoseconds: stats.birthtimeNs.toString(),
  });
}

function sameDirectoryIdentity(left, right) {
  return sameResolvedPath(left.resolvedPath, right.resolvedPath)
    && sameResolvedPath(left.realPath, right.realPath)
    && left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNanoseconds === right.birthtimeNanoseconds;
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function requirePrivateInvocationContext({
  contextPath,
  sourcePath,
  toolingWorkspacePath,
  expectedEntries,
}) {
  const resolvedContextPath = await realpath(contextPath);
  const stats = await lstat(contextPath);
  if (stats.isSymbolicLink() || !stats.isDirectory() || resolvedContextPath !== path.resolve(contextPath)) {
    throw new Error("The Wrangler invocation context must remain an exact private directory.");
  }
  for (const forbiddenParent of [await realpath(sourcePath), await realpath(toolingWorkspacePath)]) {
    const relativePath = path.relative(forbiddenParent, resolvedContextPath);
    if (relativePath === ""
      || (!path.isAbsolute(relativePath)
        && relativePath !== ".."
        && !relativePath.startsWith(`..${path.sep}`))) {
      throw new Error("The Wrangler invocation context must stay outside source and tooling workspaces.");
    }
  }
  const actualEntries = (await readdir(resolvedContextPath)).sort();
  const approvedEntries = [...expectedEntries].sort();
  if (actualEntries.some((entry) => WRANGLER_AUTO_CONFIG.test(entry))) {
    throw new Error("The private invocation context contains an auto-discovered Wrangler config.");
  }
  if (actualEntries.length !== approvedEntries.length
    || actualEntries.some((entry, index) => entry !== approvedEntries[index])) {
    throw new Error("The private Wrangler invocation context contains an unexpected entry.");
  }
}

async function requireApprovedSecretsSource({ cwd, secretsPath }) {
  const repositoryPath = await realpath(cwd);
  const expectedSecretsParent = path.join(repositoryPath, ".wrangler");
  if (path.dirname(secretsPath) !== expectedSecretsParent) {
    throw new Error("The deployment secrets file must be stored directly inside the repository .wrangler directory.");
  }
  await requirePathWithoutSymlinks(repositoryPath, expectedSecretsParent, "self-hosting secrets directory");
}

async function prepareBackupExport({ cwd, selectedEnvironment, argumentsList }) {
  const args = argumentsList;
  if (args[0] !== "d1" || args[1] !== "export") return undefined;
  const output = args[args.indexOf("--output") + 1];
  if (path.isAbsolute(output) || /^\\\\|^\\\\[.?]\\/u.test(output)) {
    throw new Error("d1 export output must be relative to the exact sibling backup directory.");
  }
  const segments = output.split(/[\\/]+/u);
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment))) {
    throw new Error("d1 export output contains a reserved device path.");
  }
  const repositoryPath = await realpath(cwd);
  const allowedParent = path.dirname(repositoryPath);
  const backupRoot = path.join(allowedParent, "fundosmart-backups", selectedEnvironment);
  const outputPath = path.resolve(repositoryPath, output);
  if (path.dirname(outputPath) !== backupRoot || path.basename(outputPath) !== segments.at(-1)) {
    throw new Error(
      `d1 export output must be ../fundosmart-backups/${selectedEnvironment}/<new-file>.sql.`,
    );
  }
  await requirePathWithoutSymlinks(allowedParent, backupRoot, "d1 backup directory");
  const parentStats = await lstat(backupRoot);
  if (!parentStats.isDirectory() || parentStats.isSymbolicLink()) {
    throw new Error("The environment-specific D1 backup directory must be an existing regular directory.");
  }
  const realBackupRoot = await realpath(backupRoot);
  if (realBackupRoot !== backupRoot) {
    throw new Error("The environment-specific D1 backup directory must not traverse links or junctions.");
  }
  try {
    await lstat(outputPath);
    throw new Error("d1 export refuses to overwrite an existing backup file.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const temporaryDirectory = await mkdtemp(path.join(realBackupRoot, ".fundosmart-export-"));
  await chmod(temporaryDirectory, 0o700);
  const temporaryOutputPath = path.join(temporaryDirectory, "export.sql");
  const rewrittenArguments = [...args];
  rewrittenArguments[rewrittenArguments.indexOf("--output") + 1] = temporaryOutputPath;
  let published = false;
  return Object.freeze({
    argumentsList: rewrittenArguments,
    async publish() {
      const outputStats = await lstat(temporaryOutputPath);
      if (outputStats.isSymbolicLink() || !outputStats.isFile() || outputStats.size < 1) {
        throw new Error("Wrangler did not produce a non-empty regular D1 export file.");
      }
      await requirePathWithoutSymlinks(allowedParent, backupRoot, "d1 backup directory");
      try {
        await link(temporaryOutputPath, outputPath);
      } catch (error) {
        if (error?.code === "EEXIST") {
          throw new Error("d1 export refuses to overwrite an existing backup file.", { cause: error });
        }
        throw error;
      }
      published = true;
      await rm(temporaryOutputPath, { force: true });
      return outputPath;
    },
    async cleanup() {
      await rm(temporaryDirectory, { recursive: true, force: true });
    },
    get published() {
      return published;
    },
  });
}

async function cleanupInvocationResources({
  invocationSecretsPath,
  privateRuntimePath,
  backupExport,
  migrationsSnapshot,
  snapshot,
  standaloneContextPath,
}) {
  const errors = [];
  if (invocationSecretsPath) {
    try {
      await rm(invocationSecretsPath, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  const cleanups = [
    backupExport?.cleanup(),
    migrationsSnapshot ? removeDistSnapshot(migrationsSnapshot) : undefined,
    snapshot ? removeDistSnapshot(snapshot) : undefined,
    standaloneContextPath ? rm(standaloneContextPath, { recursive: true, force: true }) : undefined,
    privateRuntimePath ? rm(privateRuntimePath, { recursive: true, force: true }) : undefined,
  ].filter(Boolean);
  const results = await Promise.allSettled(cleanups);
  for (const result of results) {
    if (result.status === "rejected") errors.push(result.reason);
  }
  return errors;
}

async function requirePathWithoutSymlinks(rootPath, targetPath, label) {
  const relativePath = path.relative(rootPath, targetPath);
  if (path.isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error(`The ${label} must stay inside its approved root.`);
  }
  let currentPath = rootPath;
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    const stats = await lstat(currentPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`The ${label} must contain only regular directories, not links or junctions.`);
    }
  }
}

function spawnWrangler({ cwd, environment, argumentsList, nodeExecutable, wranglerCli }) {
  if (!path.isAbsolute(String(nodeExecutable ?? "")) || !path.isAbsolute(String(wranglerCli ?? ""))) {
    return Promise.reject(new Error("Pinned Node and Wrangler CLI paths are required."));
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(nodeExecutable, [wranglerCli, ...argumentsList], {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Wrangler failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

function parseArguments(args) {
  const separator = args.indexOf("--");
  if (separator < 0) {
    throw new Error("Usage: self-host:wrangler -- --environment <staging|production> --env-file <path> [confirmations] -- <allowlisted Wrangler command>");
  }
  const wrapperArguments = args.slice(0, separator);
  const wranglerArguments = args.slice(separator + 1);
  const options = {};
  for (let index = 0; index < wrapperArguments.length; index += 1) {
    const key = new Map([
      ["--environment", "expectedEnvironment"],
      ["--env-file", "envFile"],
      ["--secrets-file", "secretsFile"],
      ["--confirm-staging", "confirmStaging"],
      ["--confirm-production", "confirmProduction"],
      ["--confirm-destructive", "confirmDestructive"],
    ]).get(wrapperArguments[index]);
    if (!key || !wrapperArguments[index + 1] || Object.hasOwn(options, key)) {
      throw new Error(`Unknown, duplicate or incomplete wrapper argument: ${wrapperArguments[index]}`);
    }
    options[key] = wrapperArguments[index + 1];
    index += 1;
  }
  if (!options.expectedEnvironment || !options.envFile) {
    throw new Error("Both --environment and --env-file are required before the Wrangler command separator.");
  }
  return { ...options, wranglerArguments };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve()
    .then(() => runPinnedWrangler(parseArguments(process.argv.slice(2))))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
