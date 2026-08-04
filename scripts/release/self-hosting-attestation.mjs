import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify, TextDecoder } from "node:util";

export const SELF_HOSTING_ATTESTATION_SCHEMA = "fundosmart:self-hosting-attestation:v2";

const ARTIFACT_DIGEST_DOMAIN = Buffer.from("fundosmart:self-hosting-artifact:v1\0", "utf8");
const MIGRATIONS_DIGEST_DOMAIN = Buffer.from("fundosmart:self-hosting-migrations:v1\0", "utf8");
const SHA256 = /^[0-9a-f]{64}$/u;
const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const ALLOWED_ENVIRONMENTS = new Set(["staging", "production"]);
const GIT_MANIFEST_MAX_BUFFER = 16 * 1024 * 1024;
const ALLOWED_GIT_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
]);
const activeSnapshots = new Map();
const execFileAsync = promisify(execFile);

export class SelfHostingAttestationError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SelfHostingAttestationError";
  }
}

export async function digestSelfHostingEnvironment({ envFile, envBytes } = {}) {
  return digestRegularFileOrBytes({
    filePath: envFile,
    bytes: envBytes,
    label: "self-hosting environment file",
    required: true,
  });
}

export async function digestSelfHostingSecrets({ secretsFile, secretsBytes } = {}) {
  return digestRegularFileOrBytes({
    filePath: secretsFile,
    bytes: secretsBytes,
    label: "self-hosting secrets file",
    required: true,
  });
}

export async function digestDistTree({ distPath } = {}) {
  const result = await digestDistTreeInternal(resolveRequiredPath(distPath, "dist path"));
  return Object.freeze({
    artifactSha256: result.artifactSha256,
    fileCount: result.fileCount,
  });
}

export async function verifyGitTrackedTree({
  gitCwd,
  treePath,
  gitRelativePath = "drizzle",
  releaseSha,
} = {}) {
  const repositoryPath = await resolveGitRepositoryRoot(gitCwd);
  const resolvedTreePath = resolveRequiredPath(treePath, "Git-tracked tree path");
  const canonicalGitRelativePath = normalizeRelativePath(
    gitRelativePath,
    "Git-tracked tree relative path",
  );
  const headBefore = await readGitCommit(repositoryPath, "HEAD");
  const canonicalReleaseSha = hasInput(releaseSha)
    ? normalizeReleaseSha(releaseSha)
    : headBefore;
  if (headBefore !== canonicalReleaseSha) {
    throw new SelfHostingAttestationError(
      "The Git-tracked tree must be verified against the currently checked-out release commit.",
    );
  }

  const objectFormat = await readGitObjectFormat(repositoryPath);
  const expectedFiles = await readGitTreeManifest({
    repositoryPath,
    releaseSha: canonicalReleaseSha,
    gitRelativePath: canonicalGitRelativePath,
    objectFormat,
  });
  if (expectedFiles.length === 0) {
    throw new SelfHostingAttestationError(
      `Git does not contain any regular files under ${canonicalGitRelativePath} at ${canonicalReleaseSha}.`,
    );
  }

  const before = await collectRegularTree(resolvedTreePath);
  requireExactGitTreeStructure(before, expectedFiles, canonicalGitRelativePath);

  const hash = createHash("sha256");
  hash.update(MIGRATIONS_DIGEST_DOMAIN);
  for (let index = 0; index < expectedFiles.length; index += 1) {
    const expected = expectedFiles[index];
    const actual = before.files[index];
    const bytes = await readStableRegularFile(actual.fullPath, `Git-tracked file ${actual.relativePath}`);
    const actualObjectId = gitBlobObjectId(bytes, objectFormat);
    if (actualObjectId !== expected.objectId) {
      throw new SelfHostingAttestationError(
        `The Git-tracked file ${actual.relativePath} does not match its blob at ${canonicalReleaseSha}.`,
      );
    }
    hashRegularBufferEntry(hash, actual.relativePath, bytes);
  }

  const [after, headAfter] = await Promise.all([
    collectRegularTree(resolvedTreePath),
    readGitCommit(repositoryPath, "HEAD"),
  ]);
  if (!sameTreeManifest(before, after)) {
    throw new SelfHostingAttestationError(
      `The Git-tracked tree ${canonicalGitRelativePath} changed while it was being verified.`,
    );
  }
  if (headAfter !== canonicalReleaseSha) {
    throw new SelfHostingAttestationError("Git HEAD changed while its tracked tree was being verified.");
  }

  return Object.freeze({
    releaseSha: canonicalReleaseSha,
    gitRelativePath: canonicalGitRelativePath,
    treeSha256: hash.digest("hex"),
    fileCount: expectedFiles.length,
  });
}

export async function createSelfHostingAttestation({
  releaseSha,
  environment,
  envFile,
  envBytes,
  secretsFile,
  secretsBytes,
  distPath,
  configRelativePath = "server/wrangler.json",
  migrationsPath,
  gitCwd,
  migrationsRelativePath = "drizzle",
} = {}) {
  const canonicalReleaseSha = normalizeReleaseSha(releaseSha);
  const canonicalEnvironment = normalizeEnvironment(environment);
  const canonicalConfigRelativePath = normalizeRelativePath(configRelativePath, "Worker config relative path");
  const canonicalMigrationsRelativePath = normalizeRelativePath(
    migrationsRelativePath,
    "Git migrations relative path",
  );
  const resolvedDistPath = resolveRequiredPath(distPath, "dist path");

  const hasSecrets = hasInput(secretsFile) || hasInput(secretsBytes);
  const [artifact, envSha256, secretsSha256, migrations] = await Promise.all([
    digestDistTreeInternal(resolvedDistPath),
    digestSelfHostingEnvironment({ envFile, envBytes }),
    !hasSecrets
      ? undefined
      : digestSelfHostingSecrets({ secretsFile, secretsBytes }),
    verifyGitTrackedTree({
      gitCwd,
      treePath: migrationsPath,
      gitRelativePath: canonicalMigrationsRelativePath,
      releaseSha: canonicalReleaseSha,
    }),
  ]);

  if (!artifact.filePaths.has(canonicalConfigRelativePath)) {
    throw new SelfHostingAttestationError(
      `The attested dist tree does not contain the regular Worker config file ${canonicalConfigRelativePath}.`,
    );
  }

  return canonicalizeAttestation({
    schema: SELF_HOSTING_ATTESTATION_SCHEMA,
    releaseSha: canonicalReleaseSha,
    environment: canonicalEnvironment,
    envSha256,
    ...(secretsSha256 ? { secretsSha256 } : {}),
    artifactSha256: artifact.artifactSha256,
    fileCount: artifact.fileCount,
    configRelativePath: canonicalConfigRelativePath,
    migrationsSha256: migrations.treeSha256,
    migrationsFileCount: migrations.fileCount,
    migrationsRelativePath: migrations.gitRelativePath,
  });
}

export function serializeSelfHostingAttestation(attestation) {
  return `${JSON.stringify(canonicalizeAttestation(attestation), null, 2)}\n`;
}

export async function writeSelfHostingAttestation({ attestation, outputPath } = {}) {
  const resolvedOutputPath = resolveRequiredPath(outputPath, "attestation output path");
  const contents = serializeSelfHostingAttestation(attestation);
  const parentPath = path.dirname(resolvedOutputPath);
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  await requireDirectory(parentPath, "attestation output directory");

  const temporaryPath = path.join(
    parentPath,
    `.${path.basename(resolvedOutputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    const temporaryStats = await handle.stat({ bigint: true });
    if (!temporaryStats.isFile()) {
      throw new SelfHostingAttestationError("The temporary self-hosting attestation is not a regular file.");
    }
    await requireUnchangedOpenFile(
      handle,
      temporaryPath,
      temporaryStats,
      "temporary self-hosting attestation",
    );
    await handle.close();
    handle = undefined;
    // The rename is deliberately the final fallible operation: once it succeeds,
    // callers must never observe a rejected write alongside a newly usable file.
    await rename(temporaryPath, resolvedOutputPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof SelfHostingAttestationError) throw error;
    throw new SelfHostingAttestationError("Could not atomically write the self-hosting attestation.", {
      cause: error,
    });
  }

  return Object.freeze({ outputPath: resolvedOutputPath });
}

export async function readSelfHostingAttestation({ attestationPath } = {}) {
  const resolvedPath = resolveRequiredPath(attestationPath, "attestation path");
  const bytes = await readStableRegularFile(resolvedPath, "self-hosting attestation");
  let contents;
  let parsed;
  try {
    contents = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new SelfHostingAttestationError("The self-hosting attestation is not valid UTF-8 JSON.", {
      cause: error,
    });
  }

  const attestation = canonicalizeAttestation(parsed);
  if (contents !== serializeSelfHostingAttestation(attestation)) {
    throw new SelfHostingAttestationError("The self-hosting attestation is not in canonical JSON form.");
  }
  return attestation;
}

export async function verifySelfHostingAttestation({
  attestation,
  attestationPath,
  releaseSha,
  environment,
  envFile,
  envBytes,
  secretsFile,
  secretsBytes,
  distPath,
  configRelativePath,
  migrationsPath,
  gitCwd,
  migrationsRelativePath,
} = {}) {
  if ((attestation === undefined) === (attestationPath === undefined)) {
    throw new SelfHostingAttestationError("Provide exactly one of attestation or attestationPath for verification.");
  }
  const approved = attestationPath === undefined
    ? canonicalizeAttestation(attestation)
    : await readSelfHostingAttestation({ attestationPath });
  const actual = await createSelfHostingAttestation({
    releaseSha,
    environment,
    envFile,
    envBytes,
    secretsFile,
    secretsBytes,
    distPath,
    configRelativePath: configRelativePath ?? approved.configRelativePath,
    migrationsPath,
    gitCwd,
    migrationsRelativePath: migrationsRelativePath ?? approved.migrationsRelativePath,
  });

  for (const key of Object.keys(actual)) {
    if (approved[key] !== actual[key]) {
      throw new SelfHostingAttestationError(`Self-hosting attestation field ${key} does not match the current input.`);
    }
  }
  const ignoredApprovedSecret = !hasInput(secretsFile)
    && !hasInput(secretsBytes)
    && Object.hasOwn(approved, "secretsSha256")
    && !Object.hasOwn(actual, "secretsSha256");
  if (Object.keys(approved).length !== Object.keys(actual).length + (ignoredApprovedSecret ? 1 : 0)) {
    throw new SelfHostingAttestationError("The self-hosting attestation does not exactly match the current input.");
  }
  return approved;
}

export async function createDistSnapshot({ distPath, temporaryParent = tmpdir() } = {}) {
  const sourcePath = resolveRequiredPath(distPath, "dist path");
  const parentPath = resolveRequiredPath(temporaryParent, "snapshot temporary parent");
  await mkdir(parentPath, { recursive: true, mode: 0o700 });
  await requireDirectory(parentPath, "snapshot temporary parent");

  const rootPath = await mkdtemp(path.join(parentPath, "fundosmart-dist-snapshot-"));
  const snapshotDistPath = path.join(rootPath, "dist");
  try {
    await chmod(rootPath, 0o700);
    await mkdir(snapshotDistPath, { mode: 0o700 });

    const beforeDigest = await digestDistTreeInternal(sourcePath);
    const sourceTree = await collectRegularTree(sourcePath);
    for (const directory of sourceTree.directories) {
      await mkdir(path.join(snapshotDistPath, ...directory.relativePath.split("/")), { mode: 0o700 });
    }
    for (const file of sourceTree.files) {
      const destinationPath = path.join(snapshotDistPath, ...file.relativePath.split("/"));
      await copyStableRegularFile(file.fullPath, destinationPath);
    }

    const [afterDigest, snapshotDigest, afterTree, snapshotTree] = await Promise.all([
      digestDistTreeInternal(sourcePath),
      digestDistTreeInternal(snapshotDistPath),
      collectRegularTree(sourcePath),
      collectRegularTree(snapshotDistPath),
    ]);
    if (!sameDigest(beforeDigest, afterDigest)
      || !sameDigest(beforeDigest, snapshotDigest)
      || !sameTreeStructure(sourceTree, afterTree)
      || !sameTreeStructure(sourceTree, snapshotTree)) {
      throw new SelfHostingAttestationError("The dist tree changed while its complete snapshot was being created.");
    }

    const snapshot = Object.freeze({
      rootPath,
      distPath: snapshotDistPath,
      artifactSha256: snapshotDigest.artifactSha256,
      fileCount: snapshotDigest.fileCount,
    });
    activeSnapshots.set(rootPath, snapshotDistPath);
    return snapshot;
  } catch (error) {
    await rm(rootPath, { recursive: true, force: true }).catch(() => undefined);
    if (error instanceof SelfHostingAttestationError) throw error;
    throw new SelfHostingAttestationError("Could not create a complete dist snapshot.", { cause: error });
  }
}

export async function removeDistSnapshot(snapshot) {
  const rootPath = snapshot?.rootPath;
  const distPath = snapshot?.distPath;
  if (typeof rootPath !== "string"
    || typeof distPath !== "string"
    || activeSnapshots.get(rootPath) !== distPath) {
    throw new SelfHostingAttestationError("Refusing to remove a path that is not an active dist snapshot.");
  }
  await rm(rootPath, { recursive: true, force: true });
  activeSnapshots.delete(rootPath);
  return true;
}

async function digestRegularFile(filePath, label) {
  const resolvedPath = resolveRequiredPath(filePath, label);
  const bytes = await readStableRegularFile(resolvedPath, label);
  return createHash("sha256").update(bytes).digest("hex");
}

async function digestRegularFileOrBytes({ filePath, bytes, label, required }) {
  const hasFilePath = hasInput(filePath);
  const hasBytes = hasInput(bytes);
  if (hasFilePath && hasBytes) {
    throw new SelfHostingAttestationError(`Provide ${label} by path or bytes, never both.`);
  }
  if (!hasFilePath && !hasBytes) {
    if (required) throw new SelfHostingAttestationError(`A ${label} is required.`);
    return undefined;
  }
  if (hasFilePath) return digestRegularFile(filePath, label);
  const stableBytes = copyInputBytes(bytes, label);
  return createHash("sha256").update(stableBytes).digest("hex");
}

function copyInputBytes(value, label) {
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) {
    throw new SelfHostingAttestationError(`The supplied ${label} bytes must be a Buffer or Uint8Array.`);
  }
  return Buffer.from(value);
}

function hasInput(value) {
  return value !== undefined && value !== null;
}

async function digestDistTreeInternal(rootPath) {
  const before = await collectRegularTree(rootPath);
  if (before.files.length === 0) {
    throw new SelfHostingAttestationError("The dist tree must contain at least one regular file.");
  }

  const hash = createHash("sha256");
  hash.update(ARTIFACT_DIGEST_DOMAIN);
  for (const file of before.files) {
    await hashRegularFileEntry(hash, file);
  }
  const artifactSha256 = hash.digest("hex");
  const after = await collectRegularTree(rootPath);
  if (!sameTreeManifest(before, after)) {
    throw new SelfHostingAttestationError("The dist tree changed while its artifact digest was being calculated.");
  }

  return {
    artifactSha256,
    fileCount: before.files.length,
    filePaths: new Set(before.files.map((entry) => entry.relativePath)),
  };
}

async function collectRegularTree(rootPath) {
  const rootStats = await requireDirectory(rootPath, "dist tree root");
  const directories = [];
  const files = [];
  const normalizedPaths = new Set();

  async function visit(directoryPath, segments) {
    const directoryBefore = await lstat(directoryPath, { bigint: true });
    requireEntryType(directoryBefore, "directory", displayPath(directoryPath));
    let entries = await readdir(directoryPath, { withFileTypes: true });
    entries = entries.sort((left, right) => compareUtf8(left.name, right.name));

    for (const entry of entries) {
      const segment = normalizeFilesystemSegment(entry.name);
      const relativePath = [...segments, segment].join("/");
      if (normalizedPaths.has(relativePath)) {
        throw new SelfHostingAttestationError(`The dist tree contains a normalized path collision at ${relativePath}.`);
      }
      normalizedPaths.add(relativePath);

      const fullPath = path.join(directoryPath, entry.name);
      const stats = await lstat(fullPath, { bigint: true });
      if (stats.isSymbolicLink()) {
        throw new SelfHostingAttestationError(`The dist tree contains a symbolic link at ${relativePath}.`);
      }
      if (stats.isDirectory()) {
        const directory = { fullPath, relativePath, stats };
        directories.push(directory);
        await visit(fullPath, [...segments, segment]);
      } else if (stats.isFile()) {
        files.push({ fullPath, relativePath, stats });
      } else {
        throw new SelfHostingAttestationError(`The dist tree contains a non-regular entry at ${relativePath}.`);
      }
    }

    const directoryAfter = await lstat(directoryPath, { bigint: true });
    requireEntryType(directoryAfter, "directory", displayPath(directoryPath));
    if (!sameStableStats(directoryBefore, directoryAfter)) {
      throw new SelfHostingAttestationError(`The directory ${displayPath(directoryPath)} changed during traversal.`);
    }
  }

  await visit(rootPath, []);
  directories.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  files.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return { rootPath, rootStats, directories, files };
}

async function hashRegularFileEntry(hash, entry) {
  const relativePathBytes = Buffer.from(entry.relativePath, "utf8");
  const handle = await openStableRegularFile(entry.fullPath, entry.stats, entry.relativePath);
  try {
    const openedStats = await handle.stat({ bigint: true });
    hash.update(uint64(relativePathBytes.length));
    hash.update(relativePathBytes);
    hash.update(uint64(openedStats.size));
    let bytesRead = 0n;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      hash.update(chunk);
      bytesRead += BigInt(chunk.byteLength);
    }
    if (bytesRead !== openedStats.size) {
      throw new SelfHostingAttestationError(`The regular file ${entry.relativePath} changed length while hashing.`);
    }
    await requireUnchangedOpenFile(handle, entry.fullPath, openedStats, entry.relativePath);
  } finally {
    await handle.close();
  }
}

async function readStableRegularFile(filePath, label) {
  const initialStats = await requireRegularFile(filePath, label);
  const handle = await openStableRegularFile(filePath, initialStats, label);
  try {
    const openedStats = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    if (BigInt(bytes.byteLength) !== openedStats.size) {
      throw new SelfHostingAttestationError(`The ${label} changed length while it was read.`);
    }
    await requireUnchangedOpenFile(handle, filePath, openedStats, label);
    return bytes;
  } finally {
    await handle.close();
  }
}

async function copyStableRegularFile(sourcePath, destinationPath) {
  const sourceStats = await requireRegularFile(sourcePath, "dist snapshot source file");
  const sourceHandle = await openStableRegularFile(sourcePath, sourceStats, displayPath(sourcePath));
  const sourceOpenedStats = await sourceHandle.stat({ bigint: true });
  const destinationHandle = await open(destinationPath, "wx", Number(sourceOpenedStats.mode & 0o777n));
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let totalBytes = 0n;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, null);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, null);
        written += result.bytesWritten;
      }
      totalBytes += BigInt(bytesRead);
    }
    if (totalBytes !== sourceOpenedStats.size) {
      throw new SelfHostingAttestationError(`The snapshot source ${displayPath(sourcePath)} changed length while copying.`);
    }
    await destinationHandle.sync();
    await destinationHandle.chmod(Number(sourceOpenedStats.mode & 0o777n));
    const destinationStats = await destinationHandle.stat({ bigint: true });
    if (destinationStats.size !== sourceOpenedStats.size || !destinationStats.isFile()) {
      throw new SelfHostingAttestationError(`The snapshot copy of ${displayPath(sourcePath)} is incomplete.`);
    }
    await requireUnchangedOpenFile(sourceHandle, sourcePath, sourceOpenedStats, displayPath(sourcePath));
  } finally {
    await Promise.allSettled([sourceHandle.close(), destinationHandle.close()]);
  }
}

async function openStableRegularFile(filePath, expectedStats, label) {
  let handle;
  try {
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat({ bigint: true });
    if (!openedStats.isFile() || !sameStableStats(expectedStats, openedStats)) {
      throw new SelfHostingAttestationError(`The ${label} changed before it could be opened safely.`);
    }
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error instanceof SelfHostingAttestationError) throw error;
    throw new SelfHostingAttestationError(`Could not safely open the regular file ${label}.`, { cause: error });
  }
}

async function requireUnchangedOpenFile(handle, filePath, openedStats, label) {
  const [afterOpenStats, afterPathStats] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(filePath, { bigint: true }),
  ]);
  if (!afterPathStats.isFile()
    || afterPathStats.isSymbolicLink()
    || !sameStableStats(openedStats, afterOpenStats)
    || !sameStableStats(openedStats, afterPathStats)) {
    throw new SelfHostingAttestationError(`The regular file ${label} changed while it was being read.`);
  }
}

async function requireRegularFile(filePath, label) {
  let stats;
  try {
    stats = await lstat(filePath, { bigint: true });
  } catch (error) {
    throw new SelfHostingAttestationError(`Could not inspect the ${label}.`, { cause: error });
  }
  requireEntryType(stats, "file", label);
  return stats;
}

async function requireDirectory(directoryPath, label) {
  let stats;
  try {
    stats = await lstat(directoryPath, { bigint: true });
  } catch (error) {
    throw new SelfHostingAttestationError(`Could not inspect the ${label}.`, { cause: error });
  }
  requireEntryType(stats, "directory", label);
  return stats;
}

function requireEntryType(stats, expectedType, label) {
  if (stats.isSymbolicLink()) {
    throw new SelfHostingAttestationError(`The ${label} must not be a symbolic link.`);
  }
  const matches = expectedType === "file" ? stats.isFile() : stats.isDirectory();
  if (!matches) {
    throw new SelfHostingAttestationError(`The ${label} must be a regular ${expectedType}.`);
  }
}

async function resolveGitRepositoryRoot(gitCwd) {
  const requestedPath = resolveRequiredPath(gitCwd, "Git checkout root");
  let requestedRealPath;
  let reportedRealPath;
  try {
    const reportedPath = await runGitText(requestedPath, ["rev-parse", "--show-toplevel"]);
    [requestedRealPath, reportedRealPath] = await Promise.all([
      realpath(requestedPath),
      realpath(path.resolve(reportedPath)),
    ]);
  } catch (error) {
    if (error instanceof SelfHostingAttestationError) throw error;
    throw new SelfHostingAttestationError("Could not resolve the exact Git checkout root.", { cause: error });
  }
  if (!sameResolvedPath(requestedRealPath, reportedRealPath)) {
    throw new SelfHostingAttestationError("gitCwd must identify the exact root of the Git checkout.");
  }
  return reportedRealPath;
}

async function readGitCommit(repositoryPath, revision) {
  const output = await runGitText(repositoryPath, ["rev-parse", "--verify", `${revision}^{commit}`]);
  return normalizeReleaseSha(output);
}

async function readGitObjectFormat(repositoryPath) {
  const objectFormat = await runGitText(repositoryPath, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") {
    throw new SelfHostingAttestationError(`Unsupported Git object format: ${objectFormat || "empty"}.`);
  }
  return objectFormat;
}

async function readGitTreeManifest({
  repositoryPath,
  releaseSha,
  gitRelativePath,
  objectFormat,
}) {
  const output = await runGitBuffer(repositoryPath, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    releaseSha,
    "--",
    gitRelativePath,
  ]);
  const records = splitNullTerminatedRecords(output, "Git tree manifest");
  const prefix = `${gitRelativePath}/`;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries = [];
  const normalizedPaths = new Set();

  for (const record of records) {
    const separator = record.indexOf(0x09);
    if (separator < 0) {
      throw new SelfHostingAttestationError("Git returned a malformed tree manifest entry.");
    }
    const header = record.subarray(0, separator).toString("ascii");
    const match = /^(\d{6}) ([a-z]+) ([0-9a-f]+)$/u.exec(header);
    if (!match) throw new SelfHostingAttestationError("Git returned a malformed tree manifest header.");
    const [, mode, type, objectId] = match;
    if (mode !== "100644" || type !== "blob") {
      throw new SelfHostingAttestationError(
        `The Git migrations tree may contain only non-executable regular files; found ${mode} ${type}.`,
      );
    }
    const expectedObjectIdLength = objectFormat === "sha1" ? 40 : 64;
    if (objectId.length !== expectedObjectIdLength) {
      throw new SelfHostingAttestationError("Git returned an object ID that does not match its repository format.");
    }

    let fullGitPath;
    try {
      fullGitPath = decoder.decode(record.subarray(separator + 1));
    } catch (error) {
      throw new SelfHostingAttestationError("The Git migrations tree contains a non-UTF-8 path.", {
        cause: error,
      });
    }
    if (!fullGitPath.startsWith(prefix)) {
      throw new SelfHostingAttestationError("Git returned a migrations entry outside the requested tree.");
    }
    const relativePath = fullGitPath.slice(prefix.length);
    const canonicalRelativePath = normalizeRelativePath(relativePath, "Git migrations entry path");
    if (relativePath !== canonicalRelativePath || normalizedPaths.has(canonicalRelativePath)) {
      throw new SelfHostingAttestationError(
        `The Git migrations tree contains a non-canonical or colliding path at ${relativePath}.`,
      );
    }
    normalizedPaths.add(canonicalRelativePath);
    entries.push({ relativePath: canonicalRelativePath, objectId });
  }

  entries.sort((left, right) => compareUtf8(left.relativePath, right.relativePath));
  return entries;
}

function requireExactGitTreeStructure(actualTree, expectedFiles, gitRelativePath) {
  const actualFiles = actualTree.files.map((entry) => entry.relativePath);
  const expectedFilePaths = expectedFiles.map((entry) => entry.relativePath);
  const expectedDirectories = expectedDirectoryPaths(expectedFilePaths);
  const actualDirectories = actualTree.directories.map((entry) => entry.relativePath);
  const fileDifference = describePathDifference(actualFiles, expectedFilePaths);
  const directoryDifference = describePathDifference(actualDirectories, expectedDirectories);
  if (fileDifference || directoryDifference) {
    const details = [fileDifference, directoryDifference].filter(Boolean).join("; ");
    throw new SelfHostingAttestationError(
      `The filesystem tree for ${gitRelativePath} does not exactly match Git (${details}).`,
    );
  }
}

function expectedDirectoryPaths(filePaths) {
  const directories = new Set();
  for (const filePath of filePaths) {
    const segments = filePath.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      directories.add(segments.slice(0, length).join("/"));
    }
  }
  return [...directories].sort(compareUtf8);
}

function describePathDifference(actualPaths, expectedPaths) {
  const actual = new Set(actualPaths);
  const expected = new Set(expectedPaths);
  const extra = actualPaths.filter((entry) => !expected.has(entry));
  const missing = expectedPaths.filter((entry) => !actual.has(entry));
  if (extra.length === 0 && missing.length === 0) return undefined;
  const descriptions = [];
  if (extra.length > 0) descriptions.push(`extra: ${summarizePaths(extra)}`);
  if (missing.length > 0) descriptions.push(`missing: ${summarizePaths(missing)}`);
  return descriptions.join(", ");
}

function summarizePaths(paths) {
  const visible = paths.slice(0, 5).join(", ");
  return paths.length > 5 ? `${visible}, and ${paths.length - 5} more` : visible;
}

function hashRegularBufferEntry(hash, relativePath, bytes) {
  const relativePathBytes = Buffer.from(relativePath, "utf8");
  hash.update(uint64(relativePathBytes.length));
  hash.update(relativePathBytes);
  hash.update(uint64(bytes.byteLength));
  hash.update(bytes);
}

function gitBlobObjectId(bytes, objectFormat) {
  const hash = createHash(objectFormat);
  hash.update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"));
  hash.update(bytes);
  return hash.digest("hex");
}

function splitNullTerminatedRecords(buffer, label) {
  if (buffer.length === 0) return [];
  if (buffer.at(-1) !== 0) {
    throw new SelfHostingAttestationError(`${label} is not NUL-terminated.`);
  }
  const records = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue;
    if (index === start) throw new SelfHostingAttestationError(`${label} contains an empty entry.`);
    records.push(buffer.subarray(start, index));
    start = index + 1;
  }
  return records;
}

async function runGitText(repositoryPath, argumentsList) {
  const output = await runGitBuffer(repositoryPath, argumentsList);
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(output);
  } catch (error) {
    throw new SelfHostingAttestationError("Git returned non-UTF-8 command output.", { cause: error });
  }
  return decoded.replace(/\r?\n$/u, "");
}

async function runGitBuffer(repositoryPath, argumentsList) {
  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "--no-replace-objects",
        "--literal-pathspecs",
        "-c",
        "core.fsmonitor=false",
        ...argumentsList,
      ],
      {
        cwd: repositoryPath,
        encoding: "buffer",
        env: createSanitizedGitEnvironment(),
        maxBuffer: GIT_MANIFEST_MAX_BUFFER,
        windowsHide: true,
      },
    );
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  } catch (error) {
    if (error instanceof SelfHostingAttestationError) throw error;
    throw new SelfHostingAttestationError("Could not inspect the release tree through Git.", { cause: error });
  }
}

function createSanitizedGitEnvironment(environment = process.env) {
  const sanitized = {};
  const entries = Object.entries(environment);
  for (const expectedKey of ALLOWED_GIT_ENVIRONMENT_KEYS) {
    const matches = entries.filter(([key]) => key.toUpperCase() === expectedKey);
    if (matches.length > 1 && matches.some(([, value]) => value !== matches[0][1])) {
      throw new SelfHostingAttestationError(
        `The host environment contains conflicting values for ${expectedKey}.`,
      );
    }
    if (typeof matches[0]?.[1] === "string") sanitized[expectedKey] = matches[0][1];
  }
  sanitized.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  sanitized.GIT_CONFIG_NOSYSTEM = "1";
  sanitized.GIT_ATTR_NOSYSTEM = "1";
  sanitized.GIT_NO_LAZY_FETCH = "1";
  sanitized.GIT_NO_REPLACE_OBJECTS = "1";
  sanitized.GIT_OPTIONAL_LOCKS = "0";
  sanitized.GIT_TERMINAL_PROMPT = "0";
  sanitized.LC_ALL = "C";
  return sanitized;
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function canonicalizeAttestation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SelfHostingAttestationError("The self-hosting attestation must be a JSON object.");
  }
  const requiredKeys = [
    "schema",
    "releaseSha",
    "environment",
    "envSha256",
    "artifactSha256",
    "fileCount",
    "configRelativePath",
    "migrationsSha256",
    "migrationsFileCount",
    "migrationsRelativePath",
  ];
  const allowedKeys = new Set([...requiredKeys, "secretsSha256"]);
  const keys = Object.keys(value);
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  const unexpected = keys.filter((key) => !allowedKeys.has(key));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new SelfHostingAttestationError("The self-hosting attestation fields do not exactly match its schema.");
  }
  if (value.schema !== SELF_HOSTING_ATTESTATION_SCHEMA) {
    throw new SelfHostingAttestationError("The self-hosting attestation schema is unsupported.");
  }
  if (typeof value.releaseSha !== "string" || !RELEASE_SHA.test(value.releaseSha)) {
    throw new SelfHostingAttestationError("The attested release SHA must be a lowercase full Git SHA.");
  }
  if (typeof value.environment !== "string" || !ALLOWED_ENVIRONMENTS.has(value.environment)) {
    throw new SelfHostingAttestationError("The attested environment must be staging or production.");
  }
  for (const key of [
    "envSha256",
    "artifactSha256",
    "migrationsSha256",
    ...(Object.hasOwn(value, "secretsSha256") ? ["secretsSha256"] : []),
  ]) {
    if (typeof value[key] !== "string" || !SHA256.test(value[key])) {
      throw new SelfHostingAttestationError(`The attested ${key} must be a lowercase SHA-256 digest.`);
    }
  }
  if (!Number.isSafeInteger(value.fileCount) || value.fileCount < 1) {
    throw new SelfHostingAttestationError("The attested fileCount must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(value.migrationsFileCount) || value.migrationsFileCount < 1) {
    throw new SelfHostingAttestationError("The attested migrationsFileCount must be a positive safe integer.");
  }
  const configRelativePath = normalizeRelativePath(value.configRelativePath, "attested Worker config relative path");
  if (configRelativePath !== value.configRelativePath) {
    throw new SelfHostingAttestationError("The attested Worker config relative path is not canonical.");
  }
  const migrationsRelativePath = normalizeRelativePath(
    value.migrationsRelativePath,
    "attested Git migrations relative path",
  );
  if (migrationsRelativePath !== value.migrationsRelativePath) {
    throw new SelfHostingAttestationError("The attested Git migrations relative path is not canonical.");
  }

  return Object.freeze({
    schema: SELF_HOSTING_ATTESTATION_SCHEMA,
    releaseSha: value.releaseSha,
    environment: value.environment,
    envSha256: value.envSha256,
    ...(Object.hasOwn(value, "secretsSha256") ? { secretsSha256: value.secretsSha256 } : {}),
    artifactSha256: value.artifactSha256,
    fileCount: value.fileCount,
    configRelativePath,
    migrationsSha256: value.migrationsSha256,
    migrationsFileCount: value.migrationsFileCount,
    migrationsRelativePath,
  });
}

function normalizeReleaseSha(value) {
  const releaseSha = String(value ?? "").trim().toLowerCase();
  if (!RELEASE_SHA.test(releaseSha)) {
    throw new SelfHostingAttestationError("releaseSha must be a full 40- or 64-character Git SHA.");
  }
  return releaseSha;
}

function normalizeEnvironment(value) {
  const environment = String(value ?? "").trim().toLowerCase();
  if (!ALLOWED_ENVIRONMENTS.has(environment)) {
    throw new SelfHostingAttestationError("environment must be staging or production.");
  }
  return environment;
}

function normalizeRelativePath(value, label) {
  if (typeof value !== "string" || !value || value.includes("\0")) {
    throw new SelfHostingAttestationError(`The ${label} must be a non-empty relative path.`);
  }
  if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new SelfHostingAttestationError(`The ${label} must not be absolute.`);
  }
  const portable = value.replaceAll("\\", "/");
  const segments = portable.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new SelfHostingAttestationError(`The ${label} must not contain empty, current or parent path segments.`);
  }
  const normalized = segments.map((segment) => segment.normalize("NFC")).join("/");
  return normalized;
}

function normalizeFilesystemSegment(value) {
  if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\\") || value.includes("\0")) {
    throw new SelfHostingAttestationError("The dist tree contains a non-portable path segment.");
  }
  const normalized = value.normalize("NFC");
  if (normalized !== value) {
    throw new SelfHostingAttestationError(`The dist tree path segment ${value} is not Unicode-normalized.`);
  }
  return normalized;
}

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SelfHostingAttestationError(`A ${label} is required.`);
  }
  return path.resolve(value);
}

function sameStableStats(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameTreeManifest(left, right) {
  const leftEntries = [...left.directories, ...left.files];
  const rightEntries = [...right.directories, ...right.files];
  return sameStableStats(left.rootStats, right.rootStats)
    && leftEntries.length === rightEntries.length
    && leftEntries.every((entry, index) => entry.relativePath === rightEntries[index].relativePath
      && entry.stats.isDirectory() === rightEntries[index].stats.isDirectory()
      && sameStableStats(entry.stats, rightEntries[index].stats));
}

function sameTreeStructure(left, right) {
  const describe = (tree) => [
    ...tree.directories.map((entry) => `d:${entry.relativePath}`),
    ...tree.files.map((entry) => `f:${entry.relativePath}`),
  ].sort(compareUtf8);
  const leftEntries = describe(left);
  const rightEntries = describe(right);
  return leftEntries.length === rightEntries.length
    && leftEntries.every((entry, index) => entry === rightEntries[index]);
}

function sameDigest(left, right) {
  return left.artifactSha256 === right.artifactSha256 && left.fileCount === right.fileCount;
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function uint64(value) {
  const number = typeof value === "bigint" ? value : BigInt(value);
  if (number < 0n || number > 0xffffffffffffffffn) {
    throw new SelfHostingAttestationError("Artifact metadata exceeds the supported unsigned 64-bit range.");
  }
  const buffer = Buffer.allocUnsafe(8);
  buffer.writeBigUInt64BE(number);
  return buffer;
}

function displayPath(value) {
  return path.relative(process.cwd(), value) || ".";
}
