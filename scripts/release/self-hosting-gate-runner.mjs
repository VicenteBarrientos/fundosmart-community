import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  SELF_HOSTING_BUILD_VARIABLE_KEYS,
  readGitStatus,
  readHeadSha,
} from "./self-hosting-preflight.mjs";
import {
  createSelfHostingGateWorkspace,
  removeSelfHostingGateWorkspace,
} from "./self-hosting-gate-workspace.mjs";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const PINNED_NPM_PACKAGE_MANAGER = "npm@10.9.3";
const PINNED_NPM_VERSION = "10.9.3";
const SUPPORTED_NODE_RANGE = ">=22.13.0";
const MINIMUM_NODE_VERSION = Object.freeze([22, 13, 0]);
const TOOLING_INSTALL_ARGUMENTS = Object.freeze([
  "ci",
  "--ignore-scripts",
  "--no-audit",
  "--fund=false",
]);
const CLOUDFLARE_AUTHENTICATION_KEYS = Object.freeze([
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_API_KEY",
  "CLOUDFLARE_EMAIL",
  "CLOUDFLARE_COMPLIANCE_REGION",
]);
const HOST_ENVIRONMENT_KEYS = Object.freeze([
  "FORCE_COLOR",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "PATHEXT",
  "TERM",
]);
const GATE_COMMANDS = Object.freeze([
  TOOLING_INSTALL_ARGUMENTS,
  Object.freeze(["run", "lint"]),
  Object.freeze(["run", "typecheck"]),
  Object.freeze(["run", "build"]),
  Object.freeze(["run", "test:built"]),
  Object.freeze(["run", "deploy:check:built"]),
  Object.freeze(["audit"]),
]);
const activeTooling = new WeakMap();

export class SelfHostingGateRunnerError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SelfHostingGateRunnerError";
  }
}

export async function resolveTrustedNpmCli({
  cwd = process.cwd(),
  nodeExecutable = process.execPath,
  nodeVersion = process.versions.node,
  candidateNpmRoots,
} = {}) {
  const workspacePath = await resolveExactDirectory(cwd, "npm project workspace");
  await validatePinnedProjectToolchain({ workspacePath, nodeVersion });
  const resolvedNodeExecutable = await resolveRegularFile(nodeExecutable, "active Node executable");
  const nodeDirectory = path.dirname(resolvedNodeExecutable);
  const prefixPath = path.resolve(nodeDirectory, "..");
  const candidates = candidateNpmRoots ?? (process.platform === "win32"
    ? [path.join(nodeDirectory, "node_modules", "npm")]
    : [
        path.join(prefixPath, "lib", "node_modules", "npm"),
        path.join(prefixPath, "share", "nodejs", "npm"),
      ]);
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new SelfHostingGateRunnerError("At least one trusted npm package candidate is required.");
  }

  let npmRoot;
  for (const candidate of candidates) {
    try {
      const [rootStats, rootRealPath, cliStats] = await Promise.all([
        lstat(candidate),
        realpath(candidate),
        lstat(path.join(candidate, "bin", "npm-cli.js")),
      ]);
      if (rootStats.isDirectory()
        && !rootStats.isSymbolicLink()
        && sameResolvedPath(path.resolve(candidate), rootRealPath)
        && cliStats.isFile()
        && !cliStats.isSymbolicLink()) {
        npmRoot = candidate;
        break;
      }
    } catch {
      // Only locations derived from the active Node installation are candidates.
    }
  }
  if (!npmRoot) {
    throw new SelfHostingGateRunnerError(
      "Could not locate npm inside the active Node installation.",
    );
  }

  const packagePath = path.join(npmRoot, "package.json");
  const cliPath = path.join(npmRoot, "bin", "npm-cli.js");
  const [resolvedNpmRoot, resolvedPackagePath, resolvedCliPath, packageStats, cliStats] = await Promise.all([
    realpath(npmRoot),
    realpath(packagePath),
    realpath(cliPath),
    lstat(packagePath),
    lstat(cliPath),
  ]);
  if (packageStats.isSymbolicLink() || !packageStats.isFile()
    || cliStats.isSymbolicLink() || !cliStats.isFile()) {
    throw new SelfHostingGateRunnerError(
      "The npm package metadata and CLI bundled with the active Node installation must be regular files.",
    );
  }
  for (const candidate of [resolvedPackagePath, resolvedCliPath]) {
    if (!isStrictChildPath(resolvedNpmRoot, candidate)) {
      throw new SelfHostingGateRunnerError(
        "The npm CLI does not resolve inside the active Node installation's npm package.",
      );
    }
  }

  let npmPackage;
  try {
    npmPackage = JSON.parse(await readFile(resolvedPackagePath, "utf8"));
  } catch (error) {
    throw new SelfHostingGateRunnerError("Could not read the trusted npm package metadata.", {
      cause: error,
    });
  }
  if (npmPackage?.name !== "npm" || npmPackage?.bin?.npm !== "bin/npm-cli.js") {
    throw new SelfHostingGateRunnerError(
      "The active Node installation does not contain a recognizable npm CLI package.",
    );
  }
  if (npmPackage.version !== PINNED_NPM_VERSION) {
    throw new SelfHostingGateRunnerError(
      `The active Node installation must bundle npm ${PINNED_NPM_VERSION}; found ${String(npmPackage.version ?? "unknown")}.`,
    );
  }
  return resolvedCliPath;
}

export async function installSelfHostingTooling({
  cwd = process.cwd(),
  releaseSha,
  hostEnvironment = process.env,
  nodeExecutable = process.execPath,
  createWorkspace = createSelfHostingGateWorkspace,
  removeWorkspace = removeSelfHostingGateWorkspace,
  resolveNpmCli = resolveTrustedNpmCli,
  spawnProcess = spawnTrustedProcess,
} = {}) {
  for (const [label, dependency] of Object.entries({
    createWorkspace,
    removeWorkspace,
    resolveNpmCli,
    spawnProcess,
  })) {
    if (typeof dependency !== "function") {
      throw new SelfHostingGateRunnerError(`The tooling ${label} dependency must be a function.`);
    }
  }
  const sourcePath = await resolveExactDirectory(cwd, "self-hosting tooling source checkout");
  const canonicalReleaseSha = normalizeReleaseSha(releaseSha);
  const resolvedNodeExecutable = await resolveRegularFile(nodeExecutable, "active Node executable");
  let workspace;
  let runtime;
  let operationError;
  try {
    workspace = await createWorkspace({ cwd: sourcePath, releaseSha: canonicalReleaseSha });
    const workspacePath = await requireCreatedWorkspace({
      workspace,
      sourcePath,
      releaseSha: canonicalReleaseSha,
    });
    const npmCli = await resolveNpmCli({
      cwd: workspacePath,
      nodeExecutable: resolvedNodeExecutable,
    });
    const resolvedNpmCli = await resolveRegularFile(npmCli, "trusted npm CLI");
    runtime = await createIsolatedRuntime(workspacePath);
    const installationEnvironment = await createGateEnvironment({
      workspacePath,
      runtime,
      variables: {},
      hostEnvironment,
      nodeExecutable: resolvedNodeExecutable,
    });
    try {
      await executeTrustedNpm({
        cwd: workspacePath,
        nodeExecutable: resolvedNodeExecutable,
        npmCli: resolvedNpmCli,
        argumentsList: [...TOOLING_INSTALL_ARGUMENTS],
        environment: installationEnvironment,
        spawnProcess,
      });
    } catch (error) {
      throw new SelfHostingGateRunnerError(
        `Self-hosting tooling installation failed: npm ${TOOLING_INSTALL_ARGUMENTS.join(" ")}.`,
        { cause: error },
      );
    }
    const wrangler = await resolvePinnedWrangler(workspacePath);
    const tooling = Object.freeze({
      workspace,
      runtime,
      nodeExecutable: resolvedNodeExecutable,
      npmCli: resolvedNpmCli,
      wranglerCli: wrangler.cliPath,
      releaseSha: canonicalReleaseSha,
    });
    activeTooling.set(tooling, {
      tooling,
      removeWorkspace,
      fingerprint: wrangler.fingerprint,
      runtimeRemoved: false,
      workspaceRemoved: false,
    });
    return tooling;
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors = await cleanupUnregisteredTooling({ workspace, runtime, removeWorkspace });
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Self-hosting tooling installation failed and secure cleanup did not complete.",
    );
  }
  throw operationError;
}

export async function verifySelfHostingTooling(tooling) {
  const state = requireActiveTooling(tooling);
  const workspacePath = await requireCreatedWorkspace({
    workspace: tooling.workspace,
    sourcePath: tooling.workspace.repositoryPath,
    releaseSha: tooling.releaseSha,
  });
  if (String(readHeadSha({ cwd: workspacePath })).toLowerCase() !== tooling.releaseSha) {
    throw new SelfHostingGateRunnerError("The tooling workspace Git HEAD changed before Wrangler could run.");
  }
  const status = readGitStatus({ cwd: workspacePath });
  if (typeof status !== "string" || status.trim()) {
    throw new SelfHostingGateRunnerError("The exact tooling workspace source changed before Wrangler could run.");
  }
  await validateToolingRuntime(tooling, workspacePath);
  const wrangler = await resolvePinnedWrangler(workspacePath);
  if (!sameResolvedPath(wrangler.cliPath, tooling.wranglerCli)
    || wrangler.fingerprint !== state.fingerprint) {
    throw new SelfHostingGateRunnerError("The pinned Wrangler installation changed before it could run.");
  }
  return true;
}

export async function createSelfHostingToolingEnvironment({
  tooling,
  hostEnvironment = process.env,
  accountId,
} = {}) {
  requireActiveTooling(tooling);
  await validateToolingRuntime(tooling, tooling.workspace.workspacePath);
  const environment = {
    ...await createGateEnvironment({
      workspacePath: tooling.workspace.workspacePath,
      runtime: tooling.runtime,
      variables: {},
      hostEnvironment,
      nodeExecutable: tooling.nodeExecutable,
      includeWorkspaceBin: false,
    }),
  };
  for (const key of CLOUDFLARE_AUTHENTICATION_KEYS) {
    const value = readCaseInsensitiveEnvironmentValue(hostEnvironment, key);
    if (value !== undefined) environment[key] = requireEnvironmentValue(value, key);
  }
  const token = String(environment.CLOUDFLARE_API_TOKEN ?? "").trim();
  const apiKey = String(environment.CLOUDFLARE_API_KEY ?? "").trim();
  const email = String(environment.CLOUDFLARE_EMAIL ?? "").trim();
  if (token && (apiKey || email)) {
    throw new SelfHostingGateRunnerError(
      "Use either CLOUDFLARE_API_TOKEN or the complete Global API Key pair, never both.",
    );
  }
  if (Boolean(apiKey) !== Boolean(email)) {
    throw new SelfHostingGateRunnerError(
      "CLOUDFLARE_API_KEY and CLOUDFLARE_EMAIL must be supplied together.",
    );
  }
  environment.CLOUDFLARE_ACCOUNT_ID = requireEnvironmentValue(accountId, "CLOUDFLARE_ACCOUNT_ID");
  environment.WRANGLER_LOG_SANITIZE = "true";
  return Object.freeze(environment);
}

export async function removeSelfHostingTooling(tooling) {
  const state = requireActiveTooling(tooling);
  const errors = [];
  if (!state.runtimeRemoved) {
    try {
      await rm(tooling.runtime.rootPath, { recursive: true, force: true });
      state.runtimeRemoved = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (!state.workspaceRemoved) {
    try {
      await state.removeWorkspace(tooling.workspace);
      state.workspaceRemoved = true;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "The pinned self-hosting tooling could not be removed completely.");
  }
  activeTooling.delete(tooling);
  return true;
}

export async function runSelfHostingGate({
  cwd = process.cwd(),
  variables = {},
  hostEnvironment = process.env,
  nodeExecutable = process.execPath,
  resolveNpmCli = resolveTrustedNpmCli,
  spawnProcess = spawnTrustedProcess,
} = {}) {
  if (typeof resolveNpmCli !== "function" || typeof spawnProcess !== "function") {
    throw new SelfHostingGateRunnerError("The self-hosting gate runner dependencies must be functions.");
  }
  const workspacePath = await resolveExactDirectory(cwd, "self-hosting gate workspace");
  const resolvedNodeExecutable = await resolveRegularFile(nodeExecutable, "active Node executable");
  const npmCli = await resolveNpmCli({
    cwd: workspacePath,
    nodeExecutable: resolvedNodeExecutable,
  });
  if (typeof npmCli !== "string" || !path.isAbsolute(npmCli)) {
    throw new SelfHostingGateRunnerError("The trusted npm resolver returned an invalid CLI path.");
  }

  const runtime = await createIsolatedRuntime(workspacePath);
  let operationError;
  try {
    const environment = await createGateEnvironment({
      workspacePath,
      runtime,
      variables,
      hostEnvironment,
      nodeExecutable: resolvedNodeExecutable,
    });
    for (const argumentsList of GATE_COMMANDS) {
      try {
        await executeTrustedNpm({
          cwd: workspacePath,
          nodeExecutable: resolvedNodeExecutable,
          npmCli,
          argumentsList: [...argumentsList],
          environment,
          spawnProcess,
        });
      } catch (error) {
        throw new SelfHostingGateRunnerError(
          `Self-hosting gate command failed: npm ${argumentsList.join(" ")}.`,
          { cause: error },
        );
      }
    }
  } catch (error) {
    operationError = error;
  }

  let cleanupError;
  try {
    await rm(runtime.rootPath, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (operationError && cleanupError) {
    throw new AggregateError(
      [operationError, cleanupError],
      `The self-hosting gate failed and its isolated runtime remains at ${runtime.rootPath}.`,
    );
  }
  if (cleanupError) {
    throw new SelfHostingGateRunnerError(
      `The self-hosting gate passed but its isolated runtime could not be removed at ${runtime.rootPath}.`,
      { cause: cleanupError },
    );
  }
  if (operationError) throw operationError;

  return Object.freeze({ npmCli, commandCount: GATE_COMMANDS.length });
}

async function validatePinnedProjectToolchain({ workspacePath, nodeVersion }) {
  const packageFile = await readExactRegularFile(
    path.join(workspacePath, "package.json"),
    workspacePath,
    "project package metadata",
  );
  const packageMetadata = parseJson(packageFile.bytes, "project package metadata");
  if (packageMetadata.packageManager !== PINNED_NPM_PACKAGE_MANAGER) {
    throw new SelfHostingGateRunnerError(
      `package.json must pin packageManager exactly to ${PINNED_NPM_PACKAGE_MANAGER}.`,
    );
  }
  if (packageMetadata.engines?.node !== SUPPORTED_NODE_RANGE) {
    throw new SelfHostingGateRunnerError(
      `package.json must declare the supported Node range exactly as ${SUPPORTED_NODE_RANGE}.`,
    );
  }
  const parsedNodeVersion = parseExactVersion(nodeVersion, "active Node version");
  if (compareVersions(parsedNodeVersion, MINIMUM_NODE_VERSION) < 0) {
    throw new SelfHostingGateRunnerError(
      `Node ${nodeVersion} is unsupported; self-hosting requires ${SUPPORTED_NODE_RANGE}.`,
    );
  }
  return packageMetadata;
}

async function requireCreatedWorkspace({ workspace, sourcePath, releaseSha }) {
  if (!workspace || typeof workspace !== "object") {
    throw new SelfHostingGateRunnerError("The tooling workspace creator returned an invalid workspace.");
  }
  const workspacePath = await resolveExactDirectory(
    workspace.workspacePath,
    "exact self-hosting tooling workspace",
  );
  const repositoryPath = await resolveExactDirectory(
    workspace.repositoryPath,
    "self-hosting tooling repository",
  );
  const rootPath = await resolveExactDirectory(
    workspace.rootPath,
    "private self-hosting tooling root",
  );
  if (!sameResolvedPath(repositoryPath, sourcePath)
    || String(workspace.releaseSha ?? "").toLowerCase() !== releaseSha
    || !sameResolvedPath(path.dirname(workspacePath), rootPath)
    || isPathInside(repositoryPath, rootPath)
    || isPathInside(repositoryPath, workspacePath)) {
    throw new SelfHostingGateRunnerError(
      "The tooling workspace must be an exact release workspace outside the source checkout.",
    );
  }
  return workspacePath;
}

async function resolvePinnedWrangler(workspacePath) {
  const rootPackageFile = await readExactRegularFile(
    path.join(workspacePath, "package.json"),
    workspacePath,
    "exact release package metadata",
  );
  const lockFile = await readExactRegularFile(
    path.join(workspacePath, "package-lock.json"),
    workspacePath,
    "exact release lockfile",
  );
  const rootPackage = parseJson(rootPackageFile.bytes, "exact release package metadata");
  const lock = parseJson(lockFile.bytes, "exact release lockfile");
  const expectedVersion = rootPackage.devDependencies?.wrangler;
  if (typeof expectedVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(expectedVersion)) {
    throw new SelfHostingGateRunnerError("The exact release must pin Wrangler to one concrete version.");
  }
  if (lock.packages?.[""]?.devDependencies?.wrangler !== expectedVersion
    || lock.packages?.["node_modules/wrangler"]?.version !== expectedVersion) {
    throw new SelfHostingGateRunnerError(
      "The exact release lockfile does not pin the root Wrangler package consistently.",
    );
  }

  const wranglerRoot = path.join(workspacePath, "node_modules", "wrangler");
  const resolvedWranglerRoot = await resolveExactDirectory(wranglerRoot, "installed Wrangler package");
  if (!isStrictChildPath(workspacePath, resolvedWranglerRoot)) {
    throw new SelfHostingGateRunnerError("The installed Wrangler package escaped the exact tooling workspace.");
  }
  const installedPackageFile = await readExactRegularFile(
    path.join(resolvedWranglerRoot, "package.json"),
    resolvedWranglerRoot,
    "installed Wrangler package metadata",
  );
  const installedPackage = parseJson(installedPackageFile.bytes, "installed Wrangler package metadata");
  if (installedPackage.name !== "wrangler"
    || installedPackage.version !== expectedVersion
    || installedPackage.bin?.wrangler !== "./bin/wrangler.js"
    || installedPackage.main !== "wrangler-dist/cli.js") {
    throw new SelfHostingGateRunnerError(
      "The installed Wrangler package does not match the exact release pin and CLI layout.",
    );
  }
  const cliFile = await readExactRegularFile(
    path.join(resolvedWranglerRoot, "bin", "wrangler.js"),
    resolvedWranglerRoot,
    "pinned Wrangler CLI",
  );
  if (!isStrictChildPath(workspacePath, cliFile.resolvedPath)) {
    throw new SelfHostingGateRunnerError("The Wrangler CLI escaped the exact tooling workspace.");
  }
  const runtimeCliFile = await readExactRegularFile(
    path.join(resolvedWranglerRoot, "wrangler-dist", "cli.js"),
    resolvedWranglerRoot,
    "pinned Wrangler runtime CLI",
  );
  if (!isStrictChildPath(workspacePath, runtimeCliFile.resolvedPath)) {
    throw new SelfHostingGateRunnerError("The Wrangler runtime CLI escaped the exact tooling workspace.");
  }
  const nodeModulesRoot = await resolveExactDirectory(
    path.join(workspacePath, "node_modules"),
    "installed tooling dependency tree",
  );
  const fingerprintHash = createHash("sha256")
    .update("fundosmart-self-hosting-toolchain-v2\0", "utf8");
  appendFingerprintBytes(fingerprintHash, "release-package.json", rootPackageFile.bytes);
  appendFingerprintBytes(fingerprintHash, "release-package-lock.json", lockFile.bytes);
  await appendWranglerDependencyClosureFingerprint({
    fingerprint: fingerprintHash,
    workspacePath,
    nodeModulesRoot,
    lock,
  });
  const fingerprint = fingerprintHash.digest("hex");
  return Object.freeze({ cliPath: cliFile.resolvedPath, fingerprint });
}

async function appendWranglerDependencyClosureFingerprint({
  fingerprint,
  workspacePath,
  nodeModulesRoot,
  lock,
}) {
  const lockPackages = lock.packages;
  if (!lockPackages || typeof lockPackages !== "object" || Array.isArray(lockPackages)) {
    throw new SelfHostingGateRunnerError(
      "The exact release lockfile must expose npm package installation metadata.",
    );
  }
  validateUnambiguousLockPackagePaths(lockPackages);

  const rootLockPath = "node_modules/wrangler";
  const pending = [{ expectedName: "wrangler", lockPath: rootLockPath }];
  const packages = new Map();
  const edges = [];
  const omissions = [];
  while (pending.length > 0) {
    pending.sort((left, right) => compareManifestNames(
      `${left.lockPath}\0${left.expectedName}`,
      `${right.lockPath}\0${right.expectedName}`,
    ));
    const current = pending.shift();
    const existing = packages.get(current.lockPath);
    if (existing) {
      if (existing.packageName !== current.expectedName) {
        throw new SelfHostingGateRunnerError(
          `The lockfile resolves conflicting package identities at ${current.lockPath}.`,
        );
      }
      continue;
    }

    const lockMetadata = lockPackages[current.lockPath];
    if (!lockMetadata || typeof lockMetadata !== "object" || Array.isArray(lockMetadata)) {
      throw new SelfHostingGateRunnerError(
        `The lockfile is missing package metadata for ${current.lockPath}.`,
      );
    }
    const packageRoot = lockPackageAbsolutePath(workspacePath, current.lockPath);
    const resolvedPackageRoot = await resolveExactDirectory(
      packageRoot,
      `installed tooling package ${current.expectedName}`,
    );
    if (!isStrictChildPath(nodeModulesRoot, resolvedPackageRoot)) {
      throw new SelfHostingGateRunnerError(
        `The installed tooling package ${current.expectedName} escaped node_modules.`,
      );
    }
    const packageFile = await readExactRegularFile(
      path.join(resolvedPackageRoot, "package.json"),
      resolvedPackageRoot,
      `installed tooling package metadata for ${current.expectedName}`,
    );
    const packageMetadata = parseJson(
      packageFile.bytes,
      `installed tooling package metadata for ${current.expectedName}`,
    );
    if (packageMetadata.name !== current.expectedName
      || typeof lockMetadata.version !== "string"
      || packageMetadata.version !== lockMetadata.version) {
      throw new SelfHostingGateRunnerError(
        `The installed tooling package ${current.expectedName} does not match its lockfile identity.`,
      );
    }
    validateExactDependencyMetadata({
      packageMetadata,
      lockMetadata,
      packageLabel: `${current.expectedName} at ${current.lockPath}`,
    });
    const installedPackage = Object.freeze({
      lockPath: current.lockPath,
      packageName: current.expectedName,
      packageRoot: resolvedPackageRoot,
    });
    packages.set(current.lockPath, installedPackage);

    const declarations = collectDependencyDeclarations(packageMetadata, current.lockPath);
    for (const declaration of declarations) {
      const resolution = await resolveLockedDependency({
        workspacePath,
        lockPackages,
        parentLockPath: current.lockPath,
        dependencyName: declaration.name,
      });
      const edgeLabel = `${current.lockPath}\0${declaration.kind}\0${declaration.name}`;
      if (!resolution) {
        if (declaration.kind === "optionalPeer") {
          omissions.push(`${edgeLabel}\0not-installed`);
          continue;
        }
        throw new SelfHostingGateRunnerError(
          `The declared ${declaration.kind} ${declaration.name} from ${current.lockPath} is absent from the lockfile.`,
        );
      }

      if (!resolution.installed) {
        if (declaration.kind === "optionalPeer") {
          omissions.push(`${edgeLabel}\0${resolution.lockPaths.join(",")}\0not-installed`);
          continue;
        }
        if (declaration.kind === "optionalDependency"
          && resolution.lockCandidates.every(({ lockMetadata, lockPath }) => (
            !matchesCurrentPlatform(lockMetadata, lockPath)
          ))) {
          omissions.push(`${edgeLabel}\0${resolution.lockPaths.join(",")}\0platform-incompatible`);
          continue;
        }
        throw new SelfHostingGateRunnerError(
          `The declared ${declaration.kind} ${declaration.name} from ${current.lockPath} is not installed.`,
        );
      }
      const platformCompatible = matchesCurrentPlatform(resolution.lockMetadata, resolution.lockPath);
      if (!platformCompatible) {
        throw new SelfHostingGateRunnerError(
          `The installed ${declaration.kind} ${declaration.name} is incompatible with this platform.`,
        );
      }
      edges.push(`${edgeLabel}\0${resolution.lockPath}`);
      pending.push({ expectedName: declaration.name, lockPath: resolution.lockPath });
    }
  }

  for (const edge of edges.sort(compareManifestNames)) {
    appendFingerprintField(fingerprint, "dependency-edge", edge);
  }
  for (const omission of omissions.sort(compareManifestNames)) {
    appendFingerprintField(fingerprint, "dependency-omission", omission);
  }
  for (const installedPackage of [...packages.values()]
    .sort((left, right) => compareManifestNames(left.lockPath, right.lockPath))) {
    appendFingerprintField(fingerprint, "package", installedPackage.lockPath);
    appendFingerprintField(fingerprint, "package-name", installedPackage.packageName);
    await appendInstalledTreeFingerprint({
      fingerprint,
      allowedRoot: installedPackage.packageRoot,
      directoryPath: installedPackage.packageRoot,
      manifestPath: `package:${installedPackage.lockPath}`,
      activeDirectories: new Set(),
      skipDependencyDirectories: true,
    });
  }
}

function validateUnambiguousLockPackagePaths(lockPackages) {
  const seen = new Map();
  for (const lockPath of Object.keys(lockPackages)) {
    if (lockPath === "") continue;
    if (!lockPath.startsWith("node_modules/")) continue;
    if (typeof lockPath !== "string"
      || lockPath.includes("\\")
      || CONTROL_CHARACTERS.test(lockPath)
      || path.posix.normalize(lockPath) !== lockPath) {
      throw new SelfHostingGateRunnerError(`The lockfile contains an invalid package path: ${lockPath}.`);
    }
    const identity = process.platform === "win32" ? lockPath.toLowerCase() : lockPath;
    const duplicate = seen.get(identity);
    if (duplicate && duplicate !== lockPath) {
      throw new SelfHostingGateRunnerError(
        `The lockfile contains ambiguous package paths ${duplicate} and ${lockPath}.`,
      );
    }
    seen.set(identity, lockPath);
  }
}

function validateExactDependencyMetadata({ packageMetadata, lockMetadata, packageLabel }) {
  for (const key of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const installed = normalizeDependencyMap(packageMetadata[key], `${packageLabel} package.json ${key}`);
    const locked = normalizeDependencyMap(lockMetadata[key], `${packageLabel} lockfile ${key}`);
    if (installed.length !== locked.length
      || installed.some(([name, range], index) => name !== locked[index][0] || range !== locked[index][1])) {
      throw new SelfHostingGateRunnerError(
        `The installed tooling package ${packageLabel} has ${key} that differ from the lockfile.`,
      );
    }
  }
  const installedOptionalPeers = normalizeOptionalPeers(
    packageMetadata.peerDependenciesMeta,
    packageMetadata.peerDependencies,
    `${packageLabel} package.json peerDependenciesMeta`,
  );
  const lockedOptionalPeers = normalizeOptionalPeers(
    lockMetadata.peerDependenciesMeta,
    lockMetadata.peerDependencies,
    `${packageLabel} lockfile peerDependenciesMeta`,
  );
  if (installedOptionalPeers.length !== lockedOptionalPeers.length
    || installedOptionalPeers.some((name, index) => name !== lockedOptionalPeers[index])) {
    throw new SelfHostingGateRunnerError(
      `The installed tooling package ${packageLabel} has peer dependency metadata that differs from the lockfile.`,
    );
  }
}

function normalizeDependencyMap(value, label) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfHostingGateRunnerError(`The ${label} must be an object.`);
  }
  return Object.entries(value)
    .map(([name, range]) => {
      validateDependencyName(name, label);
      if (typeof range !== "string" || !range || CONTROL_CHARACTERS.test(range)) {
        throw new SelfHostingGateRunnerError(`The ${label} contains an invalid range for ${name}.`);
      }
      return [name, range];
    })
    .sort(([left], [right]) => compareManifestNames(left, right));
}

function normalizeOptionalPeers(value, peerDependencies, label) {
  if (value === undefined) return [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfHostingGateRunnerError(`The ${label} must be an object.`);
  }
  normalizeDependencyMap(peerDependencies, `${label} peers`);
  const optionalPeers = [];
  for (const [name, metadata] of Object.entries(value)) {
    validateDependencyName(name, label);
    if (!metadata
      || typeof metadata !== "object"
      || Array.isArray(metadata)
      || metadata.optional !== true
      || Object.keys(metadata).some((key) => key !== "optional")) {
      throw new SelfHostingGateRunnerError(`The ${label} contains invalid metadata for ${name}.`);
    }
    optionalPeers.push(name);
  }
  return optionalPeers.sort(compareManifestNames);
}

function collectDependencyDeclarations(packageMetadata, parentLockPath) {
  const declarations = new Map();
  const addDeclarations = (value, kind) => {
    for (const [name, range] of normalizeDependencyMap(value, `${parentLockPath} ${kind}`)) {
      const existing = declarations.get(name);
      if (existing && (existing.range !== range || existing.kind !== kind)) {
        throw new SelfHostingGateRunnerError(
          `The installed package ${parentLockPath} declares ambiguous dependency metadata for ${name}.`,
        );
      }
      declarations.set(name, { kind, name, range });
    }
  };
  addDeclarations(packageMetadata.dependencies, "dependency");
  addDeclarations(packageMetadata.optionalDependencies, "optionalDependency");
  const optionalPeers = new Set(normalizeOptionalPeers(
    packageMetadata.peerDependenciesMeta,
    packageMetadata.peerDependencies,
    `${parentLockPath} peerDependenciesMeta`,
  ));
  for (const [name, range] of normalizeDependencyMap(
    packageMetadata.peerDependencies,
    `${parentLockPath} peerDependencies`,
  )) {
    const kind = optionalPeers.has(name) ? "optionalPeer" : "peerDependency";
    const existing = declarations.get(name);
    if (existing && (existing.range !== range || existing.kind !== kind)) {
      throw new SelfHostingGateRunnerError(
        `The installed package ${parentLockPath} declares ambiguous dependency metadata for ${name}.`,
      );
    }
    declarations.set(name, { kind, name, range });
  }
  return [...declarations.values()].sort((left, right) => compareManifestNames(left.name, right.name));
}

async function resolveLockedDependency({
  workspacePath,
  lockPackages,
  parentLockPath,
  dependencyName,
}) {
  const dependencySegments = validateDependencyName(dependencyName, `${parentLockPath} dependency`);
  let searchPath = lockPackageAbsolutePath(workspacePath, parentLockPath);
  const seen = new Set();
  const lockCandidates = [];
  while (sameResolvedPath(searchPath, workspacePath) || isStrictChildPath(workspacePath, searchPath)) {
    const candidatePath = path.join(searchPath, "node_modules", ...dependencySegments);
    const lockPath = relativeManifestPath(workspacePath, candidatePath);
    if (!seen.has(lockPath)) {
      seen.add(lockPath);
      const installed = await isExactDirectory(candidatePath);
      if (Object.hasOwn(lockPackages, lockPath)) {
        const lockMetadata = lockPackages[lockPath];
        if (!lockMetadata || typeof lockMetadata !== "object" || Array.isArray(lockMetadata)) {
          throw new SelfHostingGateRunnerError(`The lockfile metadata for ${lockPath} is invalid.`);
        }
        lockCandidates.push({ lockMetadata, lockPath, packagePath: candidatePath });
        if (installed) {
          return {
            installed: true,
            lockCandidates,
            lockMetadata,
            lockPath,
            lockPaths: lockCandidates.map((candidate) => candidate.lockPath),
            packagePath: candidatePath,
          };
        }
      } else if (installed) {
        throw new SelfHostingGateRunnerError(
          `The installed dependency ${dependencyName} at ${lockPath} is absent from the lockfile.`,
        );
      }
    }
    if (sameResolvedPath(searchPath, workspacePath)) break;
    const parentPath = path.dirname(searchPath);
    if (sameResolvedPath(parentPath, searchPath)) break;
    searchPath = parentPath;
  }
  if (lockCandidates.length === 0) return undefined;
  return {
    installed: false,
    lockCandidates,
    lockPaths: lockCandidates.map((candidate) => candidate.lockPath),
  };
}

function validateDependencyName(name, label) {
  if (typeof name !== "string" || !name || CONTROL_CHARACTERS.test(name) || name.includes("\\")) {
    throw new SelfHostingGateRunnerError(`The ${label} contains an invalid dependency name.`);
  }
  const segments = name.split("/");
  const scoped = name.startsWith("@");
  if ((scoped && segments.length !== 2)
    || (!scoped && segments.length !== 1)
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new SelfHostingGateRunnerError(`The ${label} contains an invalid dependency name: ${name}.`);
  }
  return segments;
}

function lockPackageAbsolutePath(workspacePath, lockPath) {
  const absolutePath = path.resolve(workspacePath, ...lockPath.split("/"));
  if (!isStrictChildPath(workspacePath, absolutePath)
    || relativeManifestPath(workspacePath, absolutePath) !== lockPath) {
    throw new SelfHostingGateRunnerError(`The lockfile package path ${lockPath} escaped the workspace.`);
  }
  return absolutePath;
}

async function isExactDirectory(directoryPath) {
  let beforeStats;
  try {
    beforeStats = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  if (beforeStats.isSymbolicLink() || !beforeStats.isDirectory()) {
    throw new SelfHostingGateRunnerError(
      `The installed tooling dependency at ${directoryPath} is not an exact regular directory.`,
    );
  }
  let resolvedPath;
  let afterStats;
  try {
    resolvedPath = await realpath(directoryPath);
    afterStats = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    throw new SelfHostingGateRunnerError(
      `The installed tooling dependency at ${directoryPath} changed while it was resolved.`,
      { cause: error },
    );
  }
  if (afterStats.isSymbolicLink()
    || !afterStats.isDirectory()
    || !sameFileIdentity(beforeStats, afterStats)
    || !sameResolvedPath(directoryPath, resolvedPath)) {
    throw new SelfHostingGateRunnerError(
      `The installed tooling dependency at ${directoryPath} is not an exact regular directory.`,
    );
  }
  return true;
}

function matchesCurrentPlatform(lockMetadata, lockPath) {
  return matchesPlatformConstraint(lockMetadata.os, process.platform, `${lockPath} os`)
    && matchesPlatformConstraint(lockMetadata.cpu, process.arch, `${lockPath} cpu`);
}

function matchesPlatformConstraint(value, currentValue, label) {
  if (value === undefined) return true;
  if (!Array.isArray(value) || value.length === 0
    || value.some((entry) => typeof entry !== "string" || !entry || CONTROL_CHARACTERS.test(entry))) {
    throw new SelfHostingGateRunnerError(`The lockfile ${label} constraint is invalid.`);
  }
  const negative = new Set(value.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1)));
  const positive = value.filter((entry) => !entry.startsWith("!"));
  return !negative.has(currentValue) && (positive.length === 0 || positive.includes(currentValue));
}

async function appendInstalledTreeFingerprint({
  fingerprint,
  allowedRoot,
  directoryPath,
  manifestPath,
  activeDirectories,
  skipDependencyDirectories,
}) {
  const beforeStats = await lstat(directoryPath, { bigint: true });
  const beforeRealPath = await realpath(directoryPath);
  if (beforeStats.isSymbolicLink()
    || !beforeStats.isDirectory()
    || !sameResolvedPath(directoryPath, beforeRealPath)
    || (!sameResolvedPath(allowedRoot, beforeRealPath)
      && !isStrictChildPath(allowedRoot, beforeRealPath))) {
    throw new SelfHostingGateRunnerError(
      `The installed tooling directory ${manifestPath} is not an exact contained directory.`,
    );
  }
  const directoryIdentity = process.platform === "win32"
    ? beforeRealPath.toLowerCase()
    : beforeRealPath;
  if (activeDirectories.has(directoryIdentity)) {
    throw new SelfHostingGateRunnerError(
      `The installed tooling dependency tree contains a directory cycle at ${manifestPath}.`,
    );
  }
  activeDirectories.add(directoryIdentity);

  try {
    appendFingerprintField(fingerprint, "directory", manifestPath);
    appendFingerprintField(fingerprint, "mode", normalizedMode(beforeStats));
    const entryNames = await readStableDirectoryNames(directoryPath);
    for (const entryName of entryNames) {
      const entryPath = path.join(directoryPath, entryName);
      const entryStats = await lstat(entryPath, { bigint: true });
      const entryManifestPath = `${manifestPath}/${entryName}`;
      if (skipDependencyDirectories
        && sameResolvedPath(directoryPath, allowedRoot)
        && entryName === "node_modules") {
        if (entryStats.isSymbolicLink() || !entryStats.isDirectory()) {
          throw new SelfHostingGateRunnerError(
            `The dependency boundary ${entryManifestPath} must be an exact directory.`,
          );
        }
        appendFingerprintField(fingerprint, "dependency-boundary", entryManifestPath);
        appendFingerprintField(fingerprint, "mode", normalizedMode(entryStats));
        continue;
      }
      if (entryStats.isDirectory() && !entryStats.isSymbolicLink()) {
        await appendInstalledTreeFingerprint({
          fingerprint,
          allowedRoot,
          directoryPath: entryPath,
          manifestPath: entryManifestPath,
          activeDirectories,
          skipDependencyDirectories,
        });
        continue;
      }
      if (entryStats.isFile() && !entryStats.isSymbolicLink()) {
        await appendFingerprintFile({
          fingerprint,
          allowedRoot,
          filePath: entryPath,
          manifestPath: entryManifestPath,
        });
        continue;
      }
      if (entryStats.isSymbolicLink()) {
        throw new SelfHostingGateRunnerError(
          `The installed tooling package contains a link at ${entryManifestPath}.`,
        );
      }
      throw new SelfHostingGateRunnerError(
        `The installed tooling dependency tree contains an unsupported entry at ${entryManifestPath}.`,
      );
    }

    const [afterStats, afterRealPath, afterEntryNames] = await Promise.all([
      lstat(directoryPath, { bigint: true }),
      realpath(directoryPath),
      readStableDirectoryNames(directoryPath),
    ]);
    if (!sameFileIdentity(beforeStats, afterStats)
      || !sameResolvedPath(beforeRealPath, afterRealPath)
      || entryNames.length !== afterEntryNames.length
      || entryNames.some((entryName, index) => entryName !== afterEntryNames[index])) {
      throw new SelfHostingGateRunnerError(
        `The installed tooling directory ${manifestPath} changed while it was fingerprinted.`,
      );
    }
  } finally {
    activeDirectories.delete(directoryIdentity);
  }
}

async function appendFingerprintFile({ fingerprint, allowedRoot, filePath, manifestPath }) {
  let handle;
  try {
    const [pathStats, resolvedPath] = await Promise.all([
      lstat(filePath, { bigint: true }),
      realpath(filePath),
    ]);
    if (pathStats.isSymbolicLink()
      || !pathStats.isFile()
      || !isStrictChildPath(allowedRoot, resolvedPath)) {
      throw new Error("not an exact contained regular file");
    }
    handle = await open(resolvedPath, "r");
    const beforeStats = await handle.stat({ bigint: true });
    if (!beforeStats.isFile() || !sameFileIdentity(pathStats, beforeStats)) {
      throw new Error("changed before it was read");
    }
    appendFingerprintField(fingerprint, "file", manifestPath);
    appendFingerprintField(fingerprint, "mode", normalizedMode(beforeStats));
    appendFingerprintField(fingerprint, "size", String(beforeStats.size));
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0n;
    while (position < beforeStats.size) {
      const remaining = beforeStats.size - position;
      const requestedBytes = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const { bytesRead } = await handle.read(buffer, 0, requestedBytes, Number(position));
      if (bytesRead < 1) throw new Error("ended before its declared size");
      fingerprint.update(buffer.subarray(0, bytesRead));
      position += BigInt(bytesRead);
    }
    fingerprint.update("\0", "utf8");
    const [afterStats, finalPathStats, finalRealPath] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
      realpath(filePath),
    ]);
    if (!sameFileIdentity(beforeStats, afterStats)
      || !sameFileIdentity(beforeStats, finalPathStats)
      || !sameResolvedPath(resolvedPath, finalRealPath)) {
      throw new Error("changed while it was read");
    }
  } catch (error) {
    throw new SelfHostingGateRunnerError(
      `Could not fingerprint the installed tooling file ${manifestPath}.`,
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStableDirectoryNames(directoryPath) {
  const entries = await readdir(directoryPath);
  if (entries.some((entryName) => !entryName || entryName === "." || entryName === ".."
    || entryName.includes("\0") || entryName.includes("/") || entryName.includes("\\"))) {
    throw new SelfHostingGateRunnerError("The installed tooling tree contains an invalid directory entry.");
  }
  return entries.sort(compareManifestNames);
}

function appendFingerprintBytes(fingerprint, label, bytes) {
  appendFingerprintField(fingerprint, "blob", label);
  appendFingerprintField(fingerprint, "size", String(bytes.length));
  fingerprint.update(bytes);
  fingerprint.update("\0", "utf8");
}

function appendFingerprintField(fingerprint, type, value) {
  const bytes = Buffer.from(String(value), "utf8");
  fingerprint.update(`${type}\0${bytes.length}\0`, "utf8");
  fingerprint.update(bytes);
  fingerprint.update("\0", "utf8");
}

function relativeManifestPath(rootPath, targetPath) {
  const relativePath = path.relative(rootPath, targetPath);
  if (path.isAbsolute(relativePath)
    || relativePath === ".."
    || relativePath.startsWith(`..${path.sep}`)) {
    throw new SelfHostingGateRunnerError("An installed tooling manifest path escaped node_modules.");
  }
  return relativePath.split(path.sep).join("/");
}

function compareManifestNames(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function normalizedMode(stats) {
  const permissions = typeof stats.mode === "bigint"
    ? Number(stats.mode & 0o777n)
    : stats.mode & 0o777;
  return permissions.toString(8).padStart(3, "0");
}

async function validateToolingRuntime(tooling, workspacePath) {
  const runtimeRoot = await resolveExactDirectory(tooling.runtime?.rootPath, "private tooling runtime");
  if (isPathInside(workspacePath, runtimeRoot)) {
    throw new SelfHostingGateRunnerError("The private tooling runtime must stay outside the tooling workspace.");
  }
  for (const [key, value] of Object.entries(tooling.runtime)) {
    if (key === "rootPath") continue;
    if (key.endsWith("Path") && !key.endsWith("ConfigPath")) {
      const directoryPath = await resolveExactDirectory(value, `private tooling runtime ${key}`);
      if (!isStrictChildPath(runtimeRoot, directoryPath)) {
        throw new SelfHostingGateRunnerError("A private tooling runtime directory escaped its root.");
      }
    }
  }
  for (const key of ["userConfigPath", "globalConfigPath"]) {
    const configFile = await readExactRegularFile(tooling.runtime[key], runtimeRoot, `private tooling ${key}`);
    if (!isStrictChildPath(runtimeRoot, configFile.resolvedPath)) {
      throw new SelfHostingGateRunnerError("A private tooling npm configuration escaped its root.");
    }
  }
}

async function cleanupUnregisteredTooling({ workspace, runtime, removeWorkspace }) {
  const errors = [];
  if (runtime?.rootPath) {
    try {
      await rm(runtime.rootPath, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (workspace) {
    try {
      await removeWorkspace(workspace);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function requireActiveTooling(tooling) {
  const state = tooling && activeTooling.get(tooling);
  if (!state || state.tooling !== tooling) {
    throw new SelfHostingGateRunnerError("Refusing to use tooling that is not an active pinned installation.");
  }
  return state;
}

function normalizeReleaseSha(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!RELEASE_SHA.test(normalized)) {
    throw new SelfHostingGateRunnerError("A full hexadecimal release SHA is required for tooling installation.");
  }
  return normalized;
}

function parseExactVersion(value, label) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(String(value ?? ""));
  if (!match) throw new SelfHostingGateRunnerError(`The ${label} must be an exact semantic version.`);
  return match.slice(1).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function parseJson(bytes, label) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch (error) {
    throw new SelfHostingGateRunnerError(`Could not parse the ${label} as a JSON object.`, { cause: error });
  }
}

async function readExactRegularFile(filePath, parentPath, label) {
  const resolvedParentPath = await resolveExactDirectory(parentPath, `${label} parent`);
  let resolvedPath;
  let handle;
  try {
    const inputStats = await lstat(filePath);
    resolvedPath = await realpath(filePath);
    if (inputStats.isSymbolicLink() || !inputStats.isFile()
      || !isStrictChildPath(resolvedParentPath, resolvedPath)) {
      throw new Error("not an exact contained regular file");
    }
    handle = await open(resolvedPath, "r");
    const beforeStats = await handle.stat();
    const bytes = await handle.readFile();
    const afterStats = await handle.stat();
    if (!beforeStats.isFile()
      || beforeStats.size !== afterStats.size
      || beforeStats.mtimeMs !== afterStats.mtimeMs
      || beforeStats.ctimeMs !== afterStats.ctimeMs) {
      throw new Error("changed while it was read");
    }
    return Object.freeze({ resolvedPath, bytes });
  } catch (error) {
    throw new SelfHostingGateRunnerError(`Could not read the ${label} as an exact regular file.`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function createGateEnvironment({
  workspacePath,
  runtime,
  variables,
  hostEnvironment,
  nodeExecutable,
  includeWorkspaceBin = true,
}) {
  if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
    throw new SelfHostingGateRunnerError("Self-hosting build variables must be an object.");
  }
  if (!hostEnvironment || typeof hostEnvironment !== "object" || Array.isArray(hostEnvironment)) {
    throw new SelfHostingGateRunnerError("The host environment must be an object.");
  }

  const environment = {};
  for (const key of HOST_ENVIRONMENT_KEYS) {
    const value = readCaseInsensitiveEnvironmentValue(hostEnvironment, key);
    if (value !== undefined) environment[key] = requireEnvironmentValue(value, key);
  }

  const nodeDirectory = path.dirname(nodeExecutable);
  const localBinPath = path.join(workspacePath, "node_modules", ".bin");
  const hostPath = readCaseInsensitiveEnvironmentValue(hostEnvironment, "PATH") ?? "";
  let hostPathEntries = requireEnvironmentValue(hostPath, "PATH").split(path.delimiter);
  if (!includeWorkspaceBin) {
    const approvedEntries = [];
    for (const entry of hostPathEntries) {
      if (!entry || !await isNodeModulesBinPathEntry(entry)) approvedEntries.push(entry);
    }
    hostPathEntries = approvedEntries;
  }
  environment.PATH = joinUniquePathEntries([
    ...(includeWorkspaceBin ? [localBinPath] : []),
    nodeDirectory,
    ...hostPathEntries,
  ]);
  environment.CI = "true";
  environment.NODE = nodeExecutable;
  environment.HOME = runtime.homePath;
  environment.USERPROFILE = runtime.homePath;
  environment.APPDATA = runtime.appDataPath;
  environment.LOCALAPPDATA = runtime.localAppDataPath;
  environment.TEMP = runtime.tempPath;
  environment.TMP = runtime.tempPath;
  environment.TMPDIR = runtime.tempPath;
  environment.XDG_CACHE_HOME = runtime.cachePath;
  environment.XDG_CONFIG_HOME = runtime.configPath;
  environment.XDG_DATA_HOME = runtime.dataPath;
  environment.NPM_CONFIG_CACHE = runtime.npmCachePath;
  environment.NPM_CONFIG_PREFIX = runtime.prefixPath;
  environment.NPM_CONFIG_LOGS_DIR = runtime.logsPath;
  environment.NPM_CONFIG_USERCONFIG = runtime.userConfigPath;
  environment.NPM_CONFIG_GLOBALCONFIG = runtime.globalConfigPath;
  const trustedScriptShell = await resolveTrustedScriptShell();
  environment.NPM_CONFIG_SCRIPT_SHELL = trustedScriptShell;
  if (process.platform === "win32") {
    const systemRootPath = path.dirname(path.dirname(trustedScriptShell));
    environment.COMSPEC = trustedScriptShell;
    environment.SYSTEMROOT = systemRootPath;
    environment.WINDIR = systemRootPath;
  }
  environment.NPM_CONFIG_IGNORE_SCRIPTS = "true";
  environment.NPM_CONFIG_FUND = "false";
  environment.NPM_CONFIG_UPDATE_NOTIFIER = "false";
  environment.NPM_CONFIG_PROGRESS = "false";
  environment.NPM_CONFIG_COLOR = "false";
  environment.NPM_CONFIG_NODE_OPTIONS = "";

  for (const key of SELF_HOSTING_BUILD_VARIABLE_KEYS) {
    if (!Object.hasOwn(variables, key)) continue;
    environment[key] = requireEnvironmentValue(variables[key], key);
  }
  return Object.freeze(environment);
}

async function isNodeModulesBinPathEntry(entry) {
  const normalizedPath = path.resolve(entry);
  if (hasNodeModulesBinSuffix(normalizedPath)) return true;
  try {
    await lstat(normalizedPath);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new SelfHostingGateRunnerError(
      `Could not validate the Wrangler PATH entry ${normalizedPath}.`,
      { cause: error },
    );
  }
  let canonicalPath;
  try {
    canonicalPath = await realpath(normalizedPath);
  } catch (error) {
    throw new SelfHostingGateRunnerError(
      `The Wrangler PATH entry ${normalizedPath} changed while it was resolved.`,
      { cause: error },
    );
  }
  return hasNodeModulesBinSuffix(canonicalPath);
}

function hasNodeModulesBinSuffix(value) {
  const normalized = process.platform === "win32" || process.platform === "darwin"
    ? value.toLowerCase()
    : value;
  return path.basename(normalized) === ".bin"
    && path.basename(path.dirname(normalized)) === "node_modules";
}

async function createIsolatedRuntime(workspacePath) {
  const runtimeParentPath = await resolvePrivateRuntimeParent(workspacePath);
  const rootPath = await mkdtemp(path.join(runtimeParentPath, "fs-g-"));
  try {
    await chmod(rootPath, 0o700);
    const rootStats = await lstat(rootPath);
    const rootRealPath = await realpath(rootPath);
    if (rootStats.isSymbolicLink()
      || !rootStats.isDirectory()
      || !sameResolvedPath(rootPath, rootRealPath)
      || !sameResolvedPath(path.dirname(rootRealPath), runtimeParentPath)
      || isPathInside(workspacePath, rootRealPath)) {
      throw new SelfHostingGateRunnerError(
        "The isolated gate runtime must be a private sibling of the exact workspace.",
      );
    }
    const directoryNames = [
      "home",
      "appdata",
      "local-appdata",
      "temp",
      "cache",
      "config",
      "data",
      "npm-cache",
      "npm-prefix",
      "npm-logs",
    ];
    const directories = {};
    for (const name of directoryNames) {
      const directoryPath = path.join(rootPath, name);
      await mkdir(directoryPath, { mode: 0o700 });
      await chmod(directoryPath, 0o700);
      directories[name] = directoryPath;
    }
    const userConfigPath = path.join(rootPath, "user.npmrc");
    const globalConfigPath = path.join(rootPath, "global.npmrc");
    await Promise.all([
      writePrivateFile(userConfigPath, [
        "fund=false",
        "ignore-scripts=true",
        "update-notifier=false",
        "progress=false",
        "color=false",
        "",
      ].join("\n")),
      writePrivateFile(globalConfigPath, "\n"),
    ]);
    return Object.freeze({
      rootPath,
      homePath: directories.home,
      appDataPath: directories.appdata,
      localAppDataPath: directories["local-appdata"],
      tempPath: directories.temp,
      cachePath: directories.cache,
      configPath: directories.config,
      dataPath: directories.data,
      npmCachePath: directories["npm-cache"],
      prefixPath: directories["npm-prefix"],
      logsPath: directories["npm-logs"],
      userConfigPath,
      globalConfigPath,
    });
  } catch (error) {
    try {
      await rm(rootPath, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `Could not initialize or remove the isolated gate runtime at ${rootPath}.`,
      );
    }
    throw error;
  }
}

async function resolvePrivateRuntimeParent(workspacePath) {
  const resolvedWorkspacePath = await resolveExactDirectory(workspacePath, "exact runtime workspace");
  const parentPath = await resolveExactDirectory(
    path.dirname(resolvedWorkspacePath),
    "private runtime parent",
  );
  if (!sameResolvedPath(path.dirname(resolvedWorkspacePath), parentPath)
    || !isStrictChildPath(parentPath, resolvedWorkspacePath)) {
    throw new SelfHostingGateRunnerError(
      "The exact workspace must be a direct child of its private runtime parent.",
    );
  }
  return parentPath;
}

async function writePrivateFile(filePath, contents) {
  let handle;
  try {
    handle = await open(filePath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("not a regular file");
  } catch (error) {
    throw new SelfHostingGateRunnerError(`Could not create the private npm configuration ${filePath}.`, {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function resolveTrustedScriptShell() {
  if (process.platform !== "win32") {
    return resolveRegularFile("/bin/sh", "system script shell");
  }
  const systemRootPath = await resolveTrustedWindowsSystemRoot();
  const expectedShellPath = path.join(systemRootPath, "System32", "cmd.exe");
  const resolvedShellPath = await resolveRegularFile(expectedShellPath, "Windows system script shell");
  if (!sameResolvedPath(resolvedShellPath, await realpath(expectedShellPath))
    || path.basename(resolvedShellPath).toLowerCase() !== "cmd.exe"
    || !sameResolvedPath(path.dirname(resolvedShellPath), path.join(systemRootPath, "System32"))) {
    throw new SelfHostingGateRunnerError(
      "The Windows script shell must be the exact regular SystemRoot\\System32\\cmd.exe.",
    );
  }
  return resolvedShellPath;
}

async function resolveTrustedWindowsSystemRoot() {
  const configuredSystemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  return resolveExactDirectory(configuredSystemRoot, "Windows SystemRoot");
}

async function resolveRegularFile(value, label) {
  if (typeof value !== "string" || !value.trim() || !path.isAbsolute(value)) {
    throw new SelfHostingGateRunnerError(`The ${label} must be an absolute path.`);
  }
  let resolvedPath;
  let stats;
  try {
    resolvedPath = await realpath(value);
    stats = await lstat(resolvedPath);
  } catch (error) {
    throw new SelfHostingGateRunnerError(`Could not resolve the ${label}.`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SelfHostingGateRunnerError(`The ${label} must resolve to a regular file.`);
  }
  return resolvedPath;
}

async function resolveExactDirectory(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SelfHostingGateRunnerError(`A ${label} path is required.`);
  }
  const resolvedPath = path.resolve(value);
  let realPath;
  let stats;
  try {
    stats = await lstat(resolvedPath);
    realPath = await realpath(resolvedPath);
  } catch (error) {
    throw new SelfHostingGateRunnerError(`Could not resolve the ${label}.`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory() || !sameResolvedPath(resolvedPath, realPath)) {
    throw new SelfHostingGateRunnerError(`The ${label} must be an exact regular directory.`);
  }
  return realPath;
}

function readCaseInsensitiveEnvironmentValue(environment, expectedKey) {
  const entries = Object.entries(environment)
    .filter(([key]) => key.toUpperCase() === expectedKey)
    .map(([, value]) => value);
  if (entries.length === 0) return undefined;
  if (entries.some((value) => value !== entries[0])) {
    throw new SelfHostingGateRunnerError(
      `The host environment contains conflicting values for ${expectedKey}.`,
    );
  }
  return entries[0];
}

function requireEnvironmentValue(value, key) {
  if (typeof value !== "string" || CONTROL_CHARACTERS.test(value)) {
    throw new SelfHostingGateRunnerError(
      `The gate environment value for ${key} must be a control-free string.`,
    );
  }
  return value;
}

function joinUniquePathEntries(entries) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    if (!entry) continue;
    const canonical = process.platform === "win32" ? entry.toLowerCase() : entry;
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    result.push(entry);
  }
  return result.join(path.delimiter);
}

function isStrictChildPath(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return Boolean(relativePath)
    && !path.isAbsolute(relativePath)
    && relativePath !== ".."
    && !relativePath.startsWith(`..${path.sep}`);
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isPathInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`));
}

function executeTrustedNpm({
  cwd,
  nodeExecutable,
  npmCli,
  argumentsList,
  environment,
  spawnProcess,
}) {
  return spawnProcess({
    cwd,
    executable: nodeExecutable,
    argumentsList: [npmCli, ...argumentsList],
    environment,
  });
}

function spawnTrustedProcess({ cwd, executable, argumentsList, environment }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, argumentsList, {
      cwd,
      env: environment,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        rejectPromise(new Error(
          `Trusted npm failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`,
        ));
      }
    });
  });
}
