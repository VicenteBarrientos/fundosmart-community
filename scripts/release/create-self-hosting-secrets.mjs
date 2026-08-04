import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const DEFAULT_OUTPUT = ".wrangler/community.production.secrets.env";
const SAFE_OUTPUT_NAME = /^[a-z0-9][a-z0-9._-]*\.secrets\.env$/iu;
const ALLOWED_GIT_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
]);
const execFileAsync = promisify(execFile);

export async function createSelfHostingSecrets({
  cwd = process.cwd(),
  outputPath = DEFAULT_OUTPUT,
  randomBytesImpl = randomBytes,
} = {}) {
  const repositoryPath = await resolveRepositoryRoot(cwd);
  await requireRealDirectory(repositoryPath, "Git repository root");
  const wranglerPath = path.join(repositoryPath, ".wrangler");
  const resolvedPath = path.resolve(cwd, outputPath);
  if (!sameResolvedPath(path.dirname(resolvedPath), wranglerPath)
    || !SAFE_OUTPUT_NAME.test(path.basename(resolvedPath))) {
    throw new Error("The secrets output must be a direct *.secrets.env file inside this repository's .wrangler directory.");
  }

  await createOrValidateWranglerDirectory(wranglerPath);
  await requireIgnoredUntrackedPath(repositoryPath, resolvedPath);
  await requireMissingOutput(resolvedPath);

  const secret = () => {
    const bytes = randomBytesImpl(32);
    if ((!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) || bytes.byteLength !== 32) {
      throw new Error("The secure random source must return exactly 32 random bytes per secret.");
    }
    return Buffer.from(bytes).toString("base64url");
  };
  const generated = {
    OFFLINE_SESSION_SECRET: secret(),
    ASSISTANT_CONFIRMATION_SECRET: secret(),
    AI_KEYS_ENCRYPTION_SECRET: secret(),
  };
  if (new Set(Object.values(generated)).size !== 3) {
    throw new Error("The secure random source returned duplicate secrets.");
  }

  const contents = [
    "# Generated locally. Complete the four installation-specific placeholders below.",
    "# This regular file is inside the repository's Git-ignored .wrangler directory.",
    "# Never paste it into issues, logs or screenshots.",
    "AUTH_ORIGIN=https://replace.invalid",
    "GOOGLE_CLIENT_ID=replace.apps.googleusercontent.com",
    "GOOGLE_CLIENT_SECRET=replace-with-google-client-secret",
    "FUNDOSMART_OWNER_EMAIL=owner@replace.invalid",
    `OFFLINE_SESSION_SECRET=${generated.OFFLINE_SESSION_SECRET}`,
    `ASSISTANT_CONFIRMATION_SECRET=${generated.ASSISTANT_CONFIRMATION_SECRET}`,
    `AI_KEYS_ENCRYPTION_SECRET=${generated.AI_KEYS_ENCRYPTION_SECRET}`,
    "# Optional Copernicus credentials must be configured as a non-empty pair:",
    "# CDSE_CLIENT_ID=issued-client-id",
    "# CDSE_CLIENT_SECRET=issued-client-secret",
    "",
  ].join("\n");

  const handle = await open(
    resolvedPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  let createdStats;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.chmod(0o600);
    createdStats = await handle.stat({ bigint: true });
    if (!createdStats.isFile()) throw new Error("The secrets output is not a regular file.");
    const outputStats = await lstat(resolvedPath, { bigint: true });
    if (outputStats.isSymbolicLink() || !outputStats.isFile() || !sameStableStats(createdStats, outputStats)) {
      throw new Error("The secrets output changed before it could be verified as a regular file.");
    }
    await requireIgnoredUntrackedPath(repositoryPath, resolvedPath);
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (createdStats) await unlinkIfSameFile(resolvedPath, createdStats);
    throw error;
  }
  await handle.close();
  return { outputPath: resolvedPath };
}

async function resolveRepositoryRoot(cwd) {
  try {
    const { stdout } = await runGit(path.resolve(cwd), ["rev-parse", "--show-toplevel"]);
    const repositoryPath = path.resolve(stdout.trim());
    if (!repositoryPath) throw new Error("empty Git repository root");
    return repositoryPath;
  } catch (error) {
    throw new Error("Self-hosting secrets must be created from a Git repository checkout.", { cause: error });
  }
}

async function runGit(cwd, argumentsList) {
  return execFileAsync("git", [
    "--no-replace-objects",
    "-c",
    "core.fsmonitor=false",
    ...argumentsList,
  ], {
    cwd: path.resolve(cwd),
    encoding: "utf8",
    env: createSanitizedGitEnvironment(),
    windowsHide: true,
  });
}

async function createOrValidateWranglerDirectory(wranglerPath) {
  try {
    await mkdir(wranglerPath, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error("Could not create the repository .wrangler directory.", { cause: error });
    }
  }
  await requireRealDirectory(wranglerPath, "repository .wrangler directory");
  await chmod(wranglerPath, 0o700);
}

async function requireRealDirectory(directoryPath, label) {
  let stats;
  let canonicalPath;
  try {
    [stats, canonicalPath] = await Promise.all([
      lstat(directoryPath, { bigint: true }),
      realpath(directoryPath),
    ]);
  } catch (error) {
    throw new Error(`Could not verify the ${label}.`, { cause: error });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()
    || !sameResolvedPath(path.resolve(directoryPath), path.resolve(canonicalPath))) {
    throw new Error(`The ${label} must be a real directory, not a link or special entry.`);
  }
}

async function requireIgnoredUntrackedPath(repositoryPath, filePath) {
  const relativePath = path.relative(repositoryPath, filePath).replaceAll(path.sep, "/");
  if (!relativePath || relativePath.startsWith("../") || path.isAbsolute(relativePath)) {
    throw new Error("The secrets output must remain inside the current Git repository.");
  }
  const tracked = await gitCommandSucceeds(repositoryPath, ["ls-files", "--error-unmatch", "--", relativePath]);
  if (tracked) throw new Error("The secrets output path is tracked by Git and cannot receive private values.");
  const ignored = await gitCommandSucceeds(repositoryPath, ["check-ignore", "--quiet", "--no-index", "--", relativePath]);
  if (!ignored) throw new Error("The secrets output path is not guaranteed to be ignored by Git.");
}

async function gitCommandSucceeds(cwd, argumentsList) {
  try {
    await runGit(cwd, argumentsList);
    return true;
  } catch (error) {
    if (error?.code === 1) return false;
    throw new Error("Could not verify the Git protection for the secrets output.", { cause: error });
  }
}

function createSanitizedGitEnvironment(environment = process.env) {
  const sanitized = {};
  const entries = Object.entries(environment);
  for (const expectedKey of ALLOWED_GIT_ENVIRONMENT_KEYS) {
    const matches = entries.filter(([key]) => key.toUpperCase() === expectedKey);
    if (matches.length > 1 && matches.some(([, value]) => value !== matches[0][1])) {
      throw new Error(`Host environment contains conflicting values for ${expectedKey}.`);
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

async function requireMissingOutput(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error("Could not verify that the secrets output does not exist.", { cause: error });
  }
  throw new Error("Refusing to overwrite an existing secrets output entry.");
}

async function unlinkIfSameFile(filePath, expectedStats) {
  try {
    const actualStats = await lstat(filePath, { bigint: true });
    if (!actualStats.isSymbolicLink() && actualStats.isFile() && sameStableStats(expectedStats, actualStats)) {
      await unlink(filePath);
    }
  } catch {
    // Fail closed without removing a path that may have been replaced concurrently.
  }
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

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function parseArguments(args) {
  if (args.length === 0) return { outputPath: DEFAULT_OUTPUT };
  if (args.length === 2 && args[0] === "--output" && args[1]) return { outputPath: args[1] };
  throw new Error("Usage: node scripts/release/create-self-hosting-secrets.mjs [--output <.wrangler/*.secrets.env>]");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  createSelfHostingSecrets(parseArguments(process.argv.slice(2)))
    .then(({ outputPath }) => {
      process.stdout.write(`Created self-hosting secrets file at ${path.relative(process.cwd(), outputPath)}.\n`);
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
