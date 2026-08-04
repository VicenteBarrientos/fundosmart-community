import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { parseEnv, TextDecoder } from "node:util";

const DISALLOWED_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/u;

export class SelfHostingEnvironmentFileError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "SelfHostingEnvironmentFileError";
  }
}

export async function readStrictDotEnvFile(filePath, { label = "environment file" } = {}) {
  const resolvedPath = resolveRequiredPath(filePath, label);
  const bytes = await readStableRegularFile(resolvedPath, label);
  const values = parseStrictDotEnvBytes(bytes, { label });
  return Object.freeze({
    path: resolvedPath,
    bytes,
    values,
    canonicalDotEnvBytes: serializeCanonicalDotEnv(values),
    canonicalJsonBytes: serializeCanonicalJson(values),
  });
}

export function parseStrictDotEnvBytes(input, { label = "environment file" } = {}) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? "");
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SelfHostingEnvironmentFileError(`The ${label} must be valid UTF-8.`, { cause: error });
  }
  if (source.startsWith("\uFEFF")) {
    throw new SelfHostingEnvironmentFileError(`The ${label} must not contain a byte-order mark.`);
  }
  if (DISALLOWED_CONTROL.test(source) || /\r(?!\n)/u.test(source)) {
    throw new SelfHostingEnvironmentFileError(`The ${label} contains unsupported control characters.`);
  }

  const declaredKeys = [];
  const seenKeys = new Set();
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line || line.startsWith("#")) continue;
    const match = ASSIGNMENT.exec(line);
    if (!match) {
      throw new SelfHostingEnvironmentFileError(
        `The ${label} line ${index + 1} must be a KEY=value assignment or a full-line comment.`,
      );
    }
    const key = match[1];
    if (seenKeys.has(key)) {
      throw new SelfHostingEnvironmentFileError(`The ${label} repeats key ${key}.`);
    }
    seenKeys.add(key);
    declaredKeys.push(key);
  }

  let values;
  try {
    values = parseEnv(source);
  } catch (error) {
    throw new SelfHostingEnvironmentFileError(`The ${label} contains invalid dotenv syntax.`, { cause: error });
  }
  const parsedKeys = Object.keys(values);
  if (parsedKeys.length !== declaredKeys.length
    || declaredKeys.some((key) => !Object.hasOwn(values, key))) {
    throw new SelfHostingEnvironmentFileError(
      `The ${label} contains syntax that is not interpreted as the declared KEY=value assignments.`,
    );
  }
  return Object.freeze({ ...values });
}

export function serializeCanonicalDotEnv(values) {
  const entries = canonicalEntries(values);
  const lines = entries.map(([key, value]) => {
    if (DISALLOWED_CONTROL.test(value) || /[\r\n']/u.test(value)) {
      throw new SelfHostingEnvironmentFileError(
        `The deployment value for ${key} cannot be represented in the canonical dotenv snapshot.`,
      );
    }
    return `${key}='${value}'`;
  });
  return Buffer.from(`${lines.join("\n")}\n`, "utf8");
}

export function serializeCanonicalJson(values) {
  const canonical = Object.fromEntries(canonicalEntries(values));
  return Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, "utf8");
}

async function readStableRegularFile(filePath, label) {
  let initialStats;
  let handle;
  try {
    initialStats = await lstat(filePath, { bigint: true });
    requireRegularFile(initialStats, label);
    handle = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = await handle.stat({ bigint: true });
    if (!sameStableStats(initialStats, openedStats)) {
      throw new SelfHostingEnvironmentFileError(`The ${label} changed before it could be opened safely.`);
    }
    const bytes = await handle.readFile();
    const [afterHandleStats, afterPathStats] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    requireRegularFile(afterPathStats, label);
    if (BigInt(bytes.byteLength) !== openedStats.size
      || !sameStableStats(openedStats, afterHandleStats)
      || !sameStableStats(openedStats, afterPathStats)) {
      throw new SelfHostingEnvironmentFileError(`The ${label} changed while it was being read.`);
    }
    return bytes;
  } catch (error) {
    if (error instanceof SelfHostingEnvironmentFileError) throw error;
    throw new SelfHostingEnvironmentFileError(`Could not safely read the ${label}.`, { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function canonicalEntries(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new SelfHostingEnvironmentFileError("Canonical environment values must be an object.");
  }
  return Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || typeof value !== "string") {
        throw new SelfHostingEnvironmentFileError("Canonical environment values must be string KEY=value pairs.");
      }
      return [key, value];
    })
    .sort(([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function requireRegularFile(stats, label) {
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new SelfHostingEnvironmentFileError(`The ${label} must be a regular file, not a link or special entry.`);
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

function resolveRequiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new SelfHostingEnvironmentFileError(`A ${label} path is required.`);
  }
  return path.resolve(value);
}
