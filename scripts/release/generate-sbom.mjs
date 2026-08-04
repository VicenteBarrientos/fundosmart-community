import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_NPM_VERSION,
  normalizeSbom,
  serializeSbom,
} from "./sbom-policy.mjs";

const execFile = promisify(execFileCallback);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const manifestPath = path.join(repositoryRoot, "package.json");
const lockfilePath = path.join(repositoryRoot, "package-lock.json");
const sbomPath = path.join(repositoryRoot, "sbom.cdx.json");

export async function generateSbom() {
  const [manifestSource, lockfileSource] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(lockfilePath, "utf8"),
  ]);
  const manifest = parseJson(manifestSource, "package.json");
  const lockfile = parseJson(lockfileSource, "package-lock.json");
  const npmExecPath = await resolveExactNpmExecPath();
  const rawSbom = await runNativeNpmSbom(npmExecPath);
  const localComponentHashes = await hashLocalComponents(lockfile);
  const lockfileSha256 = createHash("sha256").update(lockfileSource, "utf8").digest("hex");
  const normalized = normalizeSbom({
    rawSbom,
    manifest,
    lockfile,
    lockfileSha256,
    localComponentHashes,
  });
  return serializeSbom(normalized);
}

export async function hashLocalComponentDirectory(relativeDirectory) {
  assertSafeRelativePath(relativeDirectory, "local component path");
  const absoluteDirectory = resolveWithinRepository(relativeDirectory);
  const rootMetadata = await lstat(absoluteDirectory);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error(`Local component must be a regular directory: ${relativeDirectory}`);
  }

  const files = [];
  await collectRegularFiles(absoluteDirectory, "", files);
  if (files.length === 0) {
    throw new Error(`Local component directory is empty: ${relativeDirectory}`);
  }

  const hash = createHash("sha256");
  hash.update("fundosmart-local-component-v1\0", "utf8");
  for (const relativeFile of files.sort(compareOrdinal)) {
    const bytes = await readFile(path.join(absoluteDirectory, ...relativeFile.split("/")));
    hash.update(relativeFile, "utf8");
    hash.update("\0", "utf8");
    hash.update(String(bytes.length), "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

async function main() {
  const [mode, ...extraArguments] = process.argv.slice(2);
  if (!(["--check", "--write"].includes(mode)) || extraArguments.length > 0) {
    throw new Error("Usage: node scripts/release/generate-sbom.mjs (--check|--write)");
  }

  const generated = await generateSbom();
  if (mode === "--check") {
    const checkedIn = await readFile(sbomPath, "utf8");
    if (checkedIn !== generated) {
      throw new Error(
        `sbom.cdx.json is stale: checked-in sha256=${sha256(checkedIn)} generated sha256=${sha256(generated)}. Run npm run sbom:generate with npm ${EXPECTED_NPM_VERSION}.`,
      );
    }
  } else {
    await writeFileAtomically(sbomPath, generated);
  }

  const sbom = JSON.parse(generated);
  const edgeCount = sbom.dependencies.reduce((total, dependency) => total + dependency.dependsOn.length, 0);
  process.stdout.write(
    `SBOM ${mode === "--check" ? "verified" : "generated"}: sha256=${sha256(generated)} components=${sbom.components.length} edges=${edgeCount}\n`,
  );
}

async function resolveExactNpmExecPath() {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !path.isAbsolute(npmExecPath)) {
    throw new Error(`Run this command through npm ${EXPECTED_NPM_VERSION}; npm_execpath is missing or relative`);
  }
  const metadata = await lstat(npmExecPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`npm_execpath must be a regular file: ${npmExecPath}`);
  }
  const npmPackagePath = path.resolve(path.dirname(npmExecPath), "..", "package.json");
  const npmPackage = parseJson(await readFile(npmPackagePath, "utf8"), npmPackagePath);
  if (npmPackage.name !== "npm" || npmPackage.version !== EXPECTED_NPM_VERSION) {
    throw new Error(`SBOM generation requires npm ${EXPECTED_NPM_VERSION}, received ${npmPackage.name}@${npmPackage.version}`);
  }
  return npmExecPath;
}

async function runNativeNpmSbom(npmExecPath) {
  const environment = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.toLowerCase().startsWith("npm_config_")) {
      environment[name] = value;
    }
  }
  Object.assign(environment, {
    NO_UPDATE_NOTIFIER: "1",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_OFFLINE: "true",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  });

  let stdout;
  try {
    ({ stdout } = await execFile(
      process.execPath,
      [
        npmExecPath,
        "sbom",
        "--package-lock-only",
        "--sbom-format=cyclonedx",
        "--sbom-type=application",
        "--offline",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: environment,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
      },
    ));
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(`npm ${EXPECTED_NPM_VERSION} failed to generate the lockfile SBOM${stderr ? `: ${stderr}` : ""}`);
  }
  return parseJson(stdout, "npm sbom output");
}

async function hashLocalComponents(lockfile) {
  const hashes = new Map();
  for (const [packagePath, metadata] of Object.entries(lockfile.packages ?? {})) {
    if (packagePath === "" || metadata.link === true || packagePath.startsWith("node_modules/")) {
      continue;
    }
    hashes.set(packagePath, await hashLocalComponentDirectory(packagePath));
  }
  return hashes;
}

async function collectRegularFiles(absoluteDirectory, relativeDirectory, output) {
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  entries.sort((left, right) => compareOrdinal(left.name, right.name));
  for (const entry of entries) {
    if (entry.name.includes("\0") || entry.name === "." || entry.name === "..") {
      throw new Error(`Unsafe local component entry: ${entry.name}`);
    }
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
    const absolutePath = path.join(absoluteDirectory, entry.name);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Local component must not contain symbolic links: ${relativePath}`);
    }
    if (metadata.isDirectory()) {
      await collectRegularFiles(absolutePath, relativePath, output);
    } else if (metadata.isFile()) {
      output.push(relativePath);
    } else {
      throw new Error(`Local component contains a non-regular entry: ${relativePath}`);
    }
  }
}

async function writeFileAtomically(targetPath, contents) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, targetPath);
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function resolveWithinRepository(relativePath) {
  const resolved = path.resolve(repositoryRoot, ...relativePath.split("/"));
  const rootWithSeparator = `${path.resolve(repositoryRoot)}${path.sep}`;
  const comparableResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const comparableRoot = process.platform === "win32" ? rootWithSeparator.toLowerCase() : rootWithSeparator;
  if (!comparableResolved.startsWith(comparableRoot)) {
    throw new Error(`Path escapes the repository: ${relativePath}`);
  }
  return resolved;
}

function assertSafeRelativePath(relativePath, label) {
  if (typeof relativePath !== "string" || relativePath === "" || relativePath.includes("\\") || path.posix.isAbsolute(relativePath)) {
    throw new Error(`Invalid ${label}: ${relativePath}`);
  }
  if (relativePath.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`Non-canonical ${label}: ${relativePath}`);
  }
}

function parseJson(source, label) {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
const modulePath = path.resolve(fileURLToPath(import.meta.url));
const isMain = process.platform === "win32"
  ? invokedPath.toLowerCase() === modulePath.toLowerCase()
  : invokedPath === modulePath;

if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
