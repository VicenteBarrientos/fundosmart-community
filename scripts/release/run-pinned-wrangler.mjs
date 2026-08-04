import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";

import {
  SELF_HOSTING_BUILD_VARIABLE_KEYS,
  readGitStatus,
  readHeadSha,
} from "./self-hosting-preflight.mjs";

const DEFAULT_ENV_FILE = ".env.production.local";
const ACCOUNT_ID = /^[0-9a-f]{32}$/iu;
const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

export async function runPinnedWrangler({
  cwd = process.cwd(),
  envFile = DEFAULT_ENV_FILE,
  wranglerArguments = [],
  hostEnvironment = process.env,
  expectedHeadSha = readHeadSha({ cwd }),
  gitStatus = readGitStatus({ cwd }),
  runWrangler = spawnWrangler,
} = {}) {
  if (wranglerArguments.length === 0) throw new Error("A Wrangler command is required after --.");
  if (wranglerArguments.includes("--env-file")) {
    throw new Error("Pass --env-file before --; the pinned wrapper supplies it to Wrangler.");
  }

  const environmentPath = path.resolve(cwd, envFile);
  const variables = parseEnv(await readFile(environmentPath, "utf8"));
  const unknownKeys = Object.keys(variables).filter((key) => !SELF_HOSTING_BUILD_VARIABLE_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    throw new Error(`Unsupported deployment environment key(s): ${unknownKeys.join(", ")}.`);
  }

  const accountId = String(variables.CLOUDFLARE_ACCOUNT_ID ?? "").trim();
  if (!ACCOUNT_ID.test(accountId) || /^0+$/u.test(accountId)) {
    throw new Error("CLOUDFLARE_ACCOUNT_ID must be the real 32-character owner account ID.");
  }
  const releaseSha = String(variables.FUNDOSMART_RELEASE_SHA ?? "").trim();
  if (!RELEASE_SHA.test(String(expectedHeadSha ?? "")) || releaseSha.toLowerCase() !== expectedHeadSha.toLowerCase()) {
    throw new Error("FUNDOSMART_RELEASE_SHA must match a resolvable Git HEAD before running Wrangler.");
  }
  if (typeof gitStatus !== "string" || gitStatus.trim()) {
    throw new Error("Git index and working tree must be clean before running a remote Wrangler command.");
  }
  if (!new Set(["staging", "production"]).has(String(variables.FUNDOSMART_DEPLOY_ENVIRONMENT ?? "").trim())) {
    throw new Error("FUNDOSMART_DEPLOY_ENVIRONMENT must be staging or production before running Wrangler.");
  }
  const expectedCreateName = wranglerArguments[0] === "d1" && wranglerArguments[1] === "create"
    ? variables.FUNDOSMART_D1_DATABASE_NAME
    : wranglerArguments[0] === "r2" && wranglerArguments[1] === "bucket" && wranglerArguments[2] === "create"
      ? variables.FUNDOSMART_R2_BUCKET_NAME
      : undefined;
  const suppliedCreateName = wranglerArguments[0] === "d1" ? wranglerArguments[2] : wranglerArguments[3];
  if (expectedCreateName && suppliedCreateName !== expectedCreateName) {
    throw new Error("The resource name in the create command must exactly match the selected environment file.");
  }

  const environment = createPinnedWranglerEnvironment({ hostEnvironment, accountId });
  await runWrangler({
    cwd,
    environment,
    argumentsList: [...wranglerArguments, "--env-file", environmentPath],
  });
}

export function createPinnedWranglerEnvironment({ hostEnvironment = process.env, accountId } = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(hostEnvironment ?? {})) {
    const upperKey = key.toUpperCase();
    if (upperKey === "CLOUDFLARE_ACCOUNT_ID" || upperKey === "NODE_OPTIONS" || upperKey === "NODE_PATH") continue;
    environment[key] = value;
  }
  environment.CLOUDFLARE_ACCOUNT_ID = accountId;
  environment.CI = "true";
  return environment;
}

function spawnWrangler({ cwd, environment, argumentsList }) {
  const require = createRequire(import.meta.url);
  const wranglerCli = require.resolve("wrangler");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [wranglerCli, ...argumentsList], {
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
    throw new Error("Usage: node scripts/release/run-pinned-wrangler.mjs [--env-file <path>] -- <wrangler command>");
  }
  const wrapperArguments = args.slice(0, separator);
  const wranglerArguments = args.slice(separator + 1);
  let envFile = DEFAULT_ENV_FILE;
  for (let index = 0; index < wrapperArguments.length; index += 1) {
    if (wrapperArguments[index] !== "--env-file" || !wrapperArguments[index + 1]) {
      throw new Error(`Unknown or incomplete argument: ${wrapperArguments[index]}`);
    }
    envFile = wrapperArguments[index + 1];
    index += 1;
  }
  return { envFile, wranglerArguments };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve()
    .then(() => runPinnedWrangler(parseArguments(process.argv.slice(2))))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
