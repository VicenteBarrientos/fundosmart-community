import { createHash } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { gzipSync } from "node:zlib";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PUBLIC_RELEASE_CONTRACT = Object.freeze({
  schema: "fundosmart.public-release/v1",
  repository: "VicenteBarrientos/fundosmart-community",
  ref: "refs/heads/main",
  version: "0.2.0",
  tag: "v0.2.0",
  confirmation: "publish v0.2.0",
  packageName: "fundosmart-community",
  packageManager: "npm@10.9.3",
  outputRelativePath: "work/public-release",
  legacy: Object.freeze({
    tag: "v0.1.0",
    tagObjectSha: "4c919d577f76b98de8732a9ce6597ca08b294659",
    commitSha: "939c400e56fd7ca6838784fe7d4ca7d939f96262",
    releaseId: 364821011,
    assetName: "sbom.cdx.json",
    assetSize: 678652,
    assetDigest: "sha256:30d88796747c7c3f2c8256338ed5435b03d1f39448608868a4938e5449ade358",
  }),
});

const FULL_SHA = /^[0-9a-f]{40}$/u;
const CYCLONEDX_SERIAL = /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REGULAR_GIT_MODES = new Set(["100644", "100755"]);
const RELEASE_FILE_NAMES = Object.freeze({
  archive: "fundosmart-community-v0.2.0.tar.gz",
  sbom: "fundosmart-community-v0.2.0.cdx.json",
  checksums: "SHA256SUMS",
  notes: "release-notes.md",
  manifest: "release-manifest.json",
});
const ALLOWED_BUNDLE_FILES = Object.freeze(Object.values(RELEASE_FILE_NAMES).sort());

export class PublicReleaseContractError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PublicReleaseContractError";
  }
}

export function validateWorkflowIdentity({
  repository,
  ref,
  eventSha,
  releaseSha,
  version,
  confirmation,
}) {
  const normalizedSha = normalizeSha(releaseSha, "release SHA");
  if (repository !== PUBLIC_RELEASE_CONTRACT.repository) {
    throw new PublicReleaseContractError("The public release workflow may run only in the canonical community repository.");
  }
  if (ref !== PUBLIC_RELEASE_CONTRACT.ref) {
    throw new PublicReleaseContractError("The public release workflow may be dispatched only from refs/heads/main.");
  }
  if (normalizeSha(eventSha, "workflow event SHA") !== normalizedSha) {
    throw new PublicReleaseContractError("The confirmed release SHA must equal the workflow event SHA.");
  }
  if (version !== PUBLIC_RELEASE_CONTRACT.version) {
    throw new PublicReleaseContractError(`This workflow is locked to version ${PUBLIC_RELEASE_CONTRACT.version}.`);
  }
  if (confirmation !== PUBLIC_RELEASE_CONTRACT.confirmation) {
    throw new PublicReleaseContractError(`Confirmation must be exactly ${PUBLIC_RELEASE_CONTRACT.confirmation}.`);
  }

  return Object.freeze({
    repository,
    ref,
    releaseSha: normalizedSha,
    version,
    tag: PUBLIC_RELEASE_CONTRACT.tag,
    files: RELEASE_FILE_NAMES,
  });
}

export async function validateReleaseMetadata({ cwd, identity }) {
  const root = path.resolve(cwd);
  const [packageBytes, lockBytes, sbomBytes, releaseNotes] = await Promise.all([
    readFile(path.join(root, "package.json")),
    readFile(path.join(root, "package-lock.json")),
    readFile(path.join(root, "sbom.cdx.json")),
    readFile(path.join(root, "docs", "releases", `${identity.tag}.md`), "utf8"),
  ]);
  const packageMetadata = parseJson(packageBytes, "package.json");
  const lock = parseJson(lockBytes, "package-lock.json");
  const sbom = parseJson(sbomBytes, "sbom.cdx.json");

  if (packageMetadata.name !== PUBLIC_RELEASE_CONTRACT.packageName
    || packageMetadata.version !== identity.version
    || packageMetadata.private !== true
    || packageMetadata.packageManager !== PUBLIC_RELEASE_CONTRACT.packageManager) {
    throw new PublicReleaseContractError("package.json does not match the exact public release identity and toolchain.");
  }
  if (lock.lockfileVersion !== 3
    || lock.version !== identity.version
    || lock.packages?.[""]?.name !== PUBLIC_RELEASE_CONTRACT.packageName
    || lock.packages?.[""]?.version !== identity.version) {
    throw new PublicReleaseContractError("package-lock.json does not match the exact public release identity.");
  }
  validateSbom(sbom, identity);
  if (!releaseNotes.trim() || !releaseNotes.includes(identity.tag)) {
    throw new PublicReleaseContractError(`docs/releases/${identity.tag}.md must contain reviewed release notes for ${identity.tag}.`);
  }

  return Object.freeze({
    packageMetadata,
    lock,
    sbom,
    sbomBytes,
    releaseNotes: normalizeTextFile(releaseNotes),
  });
}

export function validateLegacyReleaseSnapshot({ tagRef, annotatedTag, release }) {
  const expected = PUBLIC_RELEASE_CONTRACT.legacy;
  if (tagRef?.ref !== `refs/tags/${expected.tag}`
    || tagRef?.object?.type !== "tag"
    || tagRef?.object?.sha !== expected.tagObjectSha) {
    throw new PublicReleaseContractError("The legacy v0.1.0 tag reference no longer matches its recorded fingerprint.");
  }
  if (annotatedTag?.sha !== expected.tagObjectSha
    || annotatedTag?.object?.type !== "commit"
    || annotatedTag?.object?.sha !== expected.commitSha) {
    throw new PublicReleaseContractError("The legacy v0.1.0 annotated tag no longer peels to its recorded commit.");
  }
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (release?.id !== expected.releaseId
    || release?.tag_name !== expected.tag
    || release?.draft !== false
    || release?.prerelease !== false
    || assets.length !== 1
    || assets[0]?.name !== expected.assetName
    || assets[0]?.size !== expected.assetSize
    || assets[0]?.digest !== expected.assetDigest) {
    throw new PublicReleaseContractError("The legacy v0.1.0 release or its SBOM asset no longer matches its recorded fingerprint.");
  }
  return true;
}

export async function validateGitReleaseSource({ cwd, identity, requireCanonicalRemote = true }) {
  const root = path.resolve(cwd);
  const head = runGit(root, ["rev-parse", "HEAD"]).trim();
  if (head !== identity.releaseSha) {
    throw new PublicReleaseContractError("Git HEAD does not equal the confirmed public release SHA.");
  }
  const status = runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.trim()) {
    throw new PublicReleaseContractError("The public release checkout must have a clean index and working tree.");
  }
  const legacyTagObject = runGit(root, ["rev-parse", `refs/tags/${PUBLIC_RELEASE_CONTRACT.legacy.tag}`]).trim();
  const legacyCommit = runGit(root, ["rev-parse", `refs/tags/${PUBLIC_RELEASE_CONTRACT.legacy.tag}^{commit}`]).trim();
  if (legacyTagObject !== PUBLIC_RELEASE_CONTRACT.legacy.tagObjectSha
    || legacyCommit !== PUBLIC_RELEASE_CONTRACT.legacy.commitSha) {
    throw new PublicReleaseContractError("The local v0.1.0 tag fingerprint changed.");
  }

  if (requireCanonicalRemote) {
    const remoteUrl = runGit(root, ["remote", "get-url", "origin"]).trim();
    if (!isCanonicalRemote(remoteUrl)) {
      throw new PublicReleaseContractError("Git origin is not the canonical FundoSmart Community repository.");
    }
    const remoteMain = runGit(root, ["rev-parse", "refs/remotes/origin/main"]).trim();
    if (remoteMain !== identity.releaseSha) {
      throw new PublicReleaseContractError("The confirmed release SHA is not the exact fetched origin/main.");
    }
  }

  const tree = runGitBuffer(root, ["ls-tree", "-r", "-z", identity.releaseSha]);
  const entries = tree.toString("utf8").split("\0").filter(Boolean).map(parseTreeEntry);
  if (entries.length === 0) {
    throw new PublicReleaseContractError("The public release tree is empty.");
  }
  for (const entry of entries) {
    if (entry.type !== "blob" || !REGULAR_GIT_MODES.has(entry.mode)) {
      throw new PublicReleaseContractError(`The public release tree contains unsupported Git mode ${entry.mode} at ${entry.name}.`);
    }
    if (path.posix.basename(entry.name) === ".gitattributes") {
      const attributes = runGitBuffer(root, ["show", `${identity.releaseSha}:${entry.name}`]).toString("utf8");
      if (/\bexport-(?:ignore|subst)\b/u.test(attributes)) {
        throw new PublicReleaseContractError(`Git archive-altering attributes are not allowed in ${entry.name}.`);
      }
    }
  }

  return Object.freeze({ head, fileCount: entries.length });
}

export async function prepareReleaseBundle({ cwd, identity, outputPath, requireCanonicalRemote = true }) {
  const root = path.resolve(cwd);
  const expectedOutput = path.join(root, ...PUBLIC_RELEASE_CONTRACT.outputRelativePath.split("/"));
  const output = path.resolve(outputPath ?? expectedOutput);
  if (!samePath(output, expectedOutput)) {
    throw new PublicReleaseContractError(`Release artifacts may be written only to ${PUBLIC_RELEASE_CONTRACT.outputRelativePath}.`);
  }
  const [metadata, gitSource] = await Promise.all([
    validateReleaseMetadata({ cwd: root, identity }),
    validateGitReleaseSource({ cwd: root, identity, requireCanonicalRemote }),
  ]);

  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const archivePath = path.join(output, RELEASE_FILE_NAMES.archive);
  const sbomPath = path.join(output, RELEASE_FILE_NAMES.sbom);
  const checksumsPath = path.join(output, RELEASE_FILE_NAMES.checksums);
  const notesPath = path.join(output, RELEASE_FILE_NAMES.notes);
  const manifestPath = path.join(output, RELEASE_FILE_NAMES.manifest);

  await createDeterministicSourceArchive({
    cwd: root,
    releaseSha: identity.releaseSha,
    destinationPath: archivePath,
    prefix: `${PUBLIC_RELEASE_CONTRACT.packageName}-${identity.tag}/`,
  });
  await copyFile(path.join(root, "sbom.cdx.json"), sbomPath);
  await writeFile(notesPath, metadata.releaseNotes, { flag: "wx", mode: 0o600 });

  const archiveDescriptor = await describeFile(archivePath);
  const sbomDescriptor = await describeFile(sbomPath);
  const checksumBytes = Buffer.from(
    `${archiveDescriptor.sha256}  ${RELEASE_FILE_NAMES.archive}\n${sbomDescriptor.sha256}  ${RELEASE_FILE_NAMES.sbom}\n`,
    "utf8",
  );
  await writeFile(checksumsPath, checksumBytes, { flag: "wx", mode: 0o600 });
  const checksumsDescriptor = await describeFile(checksumsPath);
  const notesDescriptor = await describeFile(notesPath);
  const manifest = {
    schema: PUBLIC_RELEASE_CONTRACT.schema,
    repository: identity.repository,
    version: identity.version,
    tag: identity.tag,
    releaseSha: identity.releaseSha,
    sourceFileCount: gitSource.fileCount,
    assets: {
      archive: { name: RELEASE_FILE_NAMES.archive, ...archiveDescriptor },
      sbom: { name: RELEASE_FILE_NAMES.sbom, ...sbomDescriptor },
      checksums: { name: RELEASE_FILE_NAMES.checksums, ...checksumsDescriptor },
    },
    releaseNotes: { name: RELEASE_FILE_NAMES.notes, ...notesDescriptor },
    legacyV010: PUBLIC_RELEASE_CONTRACT.legacy,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  await verifyReleaseBundle({ bundlePath: output, identity });
  return Object.freeze({ outputPath: output, manifest });
}

export async function createDeterministicSourceArchive({ cwd, releaseSha, destinationPath, prefix }) {
  const normalizedSha = normalizeSha(releaseSha, "source archive release SHA");
  if (typeof prefix !== "string"
    || !/^[a-z0-9][a-z0-9._-]*\/$/u.test(prefix)
    || prefix.includes("..")) {
    throw new PublicReleaseContractError("The source archive prefix must be one safe top-level directory.");
  }
  const repositoryPath = path.resolve(cwd);
  const resolvedDestination = path.resolve(destinationPath);
  const destinationParent = path.dirname(resolvedDestination);
  await mkdir(destinationParent, { recursive: true });
  const isolatedContainer = await mkdtemp(path.join(destinationParent, ".fundosmart-archive-git-"));
  const isolatedGitDirectory = path.join(isolatedContainer, "repository.git");
  const emptyTemplate = path.join(isolatedContainer, "empty-template");
  let archiveResult;
  try {
    await mkdir(emptyTemplate, { recursive: true });
    const objectFormat = runGit(repositoryPath, ["rev-parse", "--show-object-format"]).trim();
    if (!new Set(["sha1", "sha256"]).has(objectFormat)) {
      throw new PublicReleaseContractError("Git returned an unsupported repository object format.");
    }
    runGitBuffer(repositoryPath, [
      "init",
      "--bare",
      `--object-format=${objectFormat}`,
      `--template=${emptyTemplate}`,
      isolatedGitDirectory,
    ]);
    const objectDirectory = runGit(repositoryPath, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "objects",
    ]).trim();
    archiveResult = spawnSync(
      "git",
      [`--git-dir=${isolatedGitDirectory}`, "archive", "--format=tar", `--prefix=${prefix}`, normalizedSha],
      {
        cwd: repositoryPath,
        encoding: null,
        maxBuffer: 512 * 1024 * 1024,
        windowsHide: true,
        env: {
          ...sanitizedGitEnvironment(process.env),
          GIT_OBJECT_DIRECTORY: objectDirectory,
        },
      },
    );
  } finally {
    await rm(isolatedContainer, { recursive: true, force: true });
  }
  if (archiveResult.error || archiveResult.status !== 0 || !Buffer.isBuffer(archiveResult.stdout)) {
    throw new PublicReleaseContractError("Git could not create the exact public source archive.", {
      cause: archiveResult.error ?? new Error(String(archiveResult.stderr ?? "Git archive failed")),
    });
  }
  const compressedArchive = gzipSync(archiveResult.stdout, { level: 9, mtime: 0 });
  await writeFile(resolvedDestination, compressedArchive, { flag: "wx", mode: 0o600 });
  return describeFile(resolvedDestination);
}

export async function verifyReleaseBundle({ bundlePath, identity }) {
  const root = path.resolve(bundlePath);
  const actualFiles = (await readdir(root)).sort();
  if (actualFiles.length !== ALLOWED_BUNDLE_FILES.length
    || !actualFiles.every((name, index) => name === ALLOWED_BUNDLE_FILES[index])) {
    throw new PublicReleaseContractError("The public release bundle does not contain exactly the allowed files.");
  }
  const manifest = parseJson(await readFile(path.join(root, RELEASE_FILE_NAMES.manifest)), RELEASE_FILE_NAMES.manifest);
  if (manifest.schema !== PUBLIC_RELEASE_CONTRACT.schema
    || manifest.repository !== identity.repository
    || manifest.version !== identity.version
    || manifest.tag !== identity.tag
    || manifest.releaseSha !== identity.releaseSha
    || !Number.isSafeInteger(manifest.sourceFileCount)
    || manifest.sourceFileCount < 1
    || JSON.stringify(manifest.legacyV010) !== JSON.stringify(PUBLIC_RELEASE_CONTRACT.legacy)) {
    throw new PublicReleaseContractError("The release manifest identity or legacy fingerprint is invalid.");
  }

  for (const key of ["archive", "sbom", "checksums"]) {
    const expectedName = RELEASE_FILE_NAMES[key];
    const descriptor = manifest.assets?.[key];
    if (descriptor?.name !== expectedName) {
      throw new PublicReleaseContractError(`The release manifest has an invalid ${key} asset name.`);
    }
    const actual = await describeFile(path.join(root, expectedName));
    if (descriptor.sha256 !== actual.sha256 || descriptor.size !== actual.size) {
      throw new PublicReleaseContractError(`The release ${key} asset does not match its manifest digest.`);
    }
  }
  const notesDescriptor = await describeFile(path.join(root, RELEASE_FILE_NAMES.notes));
  if (manifest.releaseNotes?.name !== RELEASE_FILE_NAMES.notes
    || manifest.releaseNotes?.sha256 !== notesDescriptor.sha256
    || manifest.releaseNotes?.size !== notesDescriptor.size) {
    throw new PublicReleaseContractError("The reviewed release notes do not match the release manifest.");
  }
  const expectedChecksums = `${manifest.assets.archive.sha256}  ${RELEASE_FILE_NAMES.archive}\n${manifest.assets.sbom.sha256}  ${RELEASE_FILE_NAMES.sbom}\n`;
  const actualChecksums = await readFile(path.join(root, RELEASE_FILE_NAMES.checksums), "utf8");
  if (actualChecksums !== expectedChecksums) {
    throw new PublicReleaseContractError("SHA256SUMS is not canonical for the public release assets.");
  }
  validateSbom(parseJson(await readFile(path.join(root, RELEASE_FILE_NAMES.sbom)), RELEASE_FILE_NAMES.sbom), identity);
  return Object.freeze(manifest);
}

export function identityFromEnvironment(environment = process.env) {
  return validateWorkflowIdentity({
    repository: environment.GITHUB_REPOSITORY,
    ref: environment.GITHUB_REF,
    eventSha: environment.GITHUB_SHA,
    releaseSha: environment.RELEASE_SHA,
    version: environment.RELEASE_VERSION,
    confirmation: environment.RELEASE_CONFIRMATION,
  });
}

async function writeGitHubOutputs(outputPath, manifest) {
  if (!outputPath) return;
  const outputs = {
    archive_name: RELEASE_FILE_NAMES.archive,
    sbom_name: RELEASE_FILE_NAMES.sbom,
    checksums_name: RELEASE_FILE_NAMES.checksums,
    artifact_name: `public-release-${identity.tag}`,
    ...(manifest ? {
      archive_sha256: manifest.assets.archive.sha256,
      sbom_sha256: manifest.assets.sbom.sha256,
      checksums_sha256: manifest.assets.checksums.sha256,
    } : {}),
  };
  const serialized = Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join("");
  await appendFile(path.resolve(outputPath), serialized, { encoding: "utf8" });
}

function validateSbom(sbom, identity) {
  if (sbom.bomFormat !== "CycloneDX"
    || !CYCLONEDX_SERIAL.test(String(sbom.serialNumber ?? ""))
    || sbom.metadata?.component?.type !== "application"
    || sbom.metadata?.component?.name !== PUBLIC_RELEASE_CONTRACT.packageName
    || sbom.metadata?.component?.version !== identity.version
    || sbom.metadata?.component?.purl !== `pkg:npm/${PUBLIC_RELEASE_CONTRACT.packageName}@${identity.version}`
    || !Array.isArray(sbom.components)
    || sbom.components.length < 1) {
    throw new PublicReleaseContractError("The checked-in CycloneDX SBOM does not match the public release identity.");
  }
}

function parseTreeEntry(record) {
  const tab = record.indexOf("\t");
  const header = record.slice(0, tab).split(" ");
  const name = record.slice(tab + 1);
  if (tab < 1 || header.length !== 3 || !name || name.includes("\0") || path.posix.isAbsolute(name)) {
    throw new PublicReleaseContractError("Git returned a malformed source tree entry.");
  }
  return { mode: header[0], type: header[1], objectId: header[2], name };
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes));
  } catch (error) {
    throw new PublicReleaseContractError(`${label} is not valid JSON.`, { cause: error });
  }
}

function normalizeSha(value, label) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!FULL_SHA.test(normalized)) {
    throw new PublicReleaseContractError(`The ${label} must be a lowercase full 40-character Git SHA.`);
  }
  return normalized;
}

function normalizeTextFile(value) {
  return `${String(value).replaceAll("\r\n", "\n").trimEnd()}\n`;
}

async function describeFile(filePath) {
  const bytes = await readFile(filePath);
  const fileStats = await stat(filePath);
  if (!fileStats.isFile() || fileStats.size !== bytes.length) {
    throw new PublicReleaseContractError(`Release artifact ${path.basename(filePath)} is not a stable regular file.`);
  }
  return Object.freeze({ sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length });
}

function runGit(cwd, args) {
  return runGitBuffer(cwd, args).toString("utf8");
}

function runGitBuffer(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
    env: sanitizedGitEnvironment(process.env),
  });
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new PublicReleaseContractError(`Git command failed: git ${args.join(" ")}.`, {
      cause: result.error ?? new Error(Buffer.from(result.stderr ?? "").toString("utf8")),
    });
  }
  return result.stdout;
}

function sanitizedGitEnvironment(hostEnvironment) {
  const environment = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
    if (typeof hostEnvironment[key] === "string") environment[key] = hostEnvironment[key];
  }
  environment.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_ATTR_NOSYSTEM = "1";
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_OPTIONAL_LOCKS = "0";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.LC_ALL = "C";
  return environment;
}

function isCanonicalRemote(value) {
  return /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)(?:VicenteBarrientos\/fundosmart-community)(?:\.git)?$/u.test(value);
}

function samePath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

async function runCli() {
  const [command, ...argumentsList] = process.argv.slice(2);
  if (argumentsList.length !== 0 || !new Set(["preflight", "prepare", "verify-bundle"]).has(command)) {
    throw new PublicReleaseContractError("Usage: verify-public-release.mjs <preflight|prepare|verify-bundle>");
  }
  const cwd = process.cwd();
  const identity = identityFromEnvironment();
  const outputPath = path.join(cwd, ...PUBLIC_RELEASE_CONTRACT.outputRelativePath.split("/"));
  if (command === "preflight") {
    await Promise.all([
      validateReleaseMetadata({ cwd, identity }),
      validateGitReleaseSource({ cwd, identity }),
    ]);
    process.stdout.write(`Public release preflight passed for ${identity.tag} at ${identity.releaseSha}.\n`);
    return;
  }
  if (command === "prepare") {
    const prepared = await prepareReleaseBundle({ cwd, identity, outputPath });
    await writeGitHubOutputs(process.env.GITHUB_OUTPUT, prepared.manifest);
    process.stdout.write(`Deterministic public release bundle prepared at ${PUBLIC_RELEASE_CONTRACT.outputRelativePath}.\n`);
    return;
  }
  await verifyReleaseBundle({ bundlePath: outputPath, identity });
  process.stdout.write(`Public release bundle verified for ${identity.tag}.\n`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
