import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  SELF_HOSTING_BUILD_VARIABLE_KEYS,
  loadSelfHostingConfiguration,
  readGitStatus,
  readHeadSha,
  validateBuiltWorkerConfig,
  validateSelfHostingEnvironment,
} from "./self-hosting-preflight.mjs";

const HOST_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CI",
  "COMSPEC",
  "FORCE_COLOR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "LANG",
  "LC_ALL",
  "LOCALAPPDATA",
  "NO_COLOR",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "SHELL",
  "SYSTEMROOT",
  "TEMP",
  "TERM",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
]);

export async function runSelfHostingCheck({
  cwd = process.cwd(),
  envFile = ".env.production.local",
  secretsFile = ".wrangler/community.production.secrets.env",
  builtConfig = "dist/server/wrangler.json",
  expectedHeadSha,
  gitStatus,
  hostEnvironment = process.env,
  runGate = runNpmCheck,
} = {}) {
  const environmentPath = path.resolve(cwd, envFile);
  const secretsPath = path.resolve(cwd, secretsFile);
  const { variables, secrets } = await loadSelfHostingConfiguration({
    envFile: environmentPath,
    secretsFile: secretsPath,
  });
  const checkoutSha = expectedHeadSha ?? readHeadSha({ cwd });
  const checkoutStatus = gitStatus ?? readGitStatus({ cwd });
  validateSelfHostingEnvironment({
    variables,
    secrets,
    expectedHeadSha: checkoutSha,
    gitStatus: checkoutStatus,
    processEnvironment: hostEnvironment,
  });

  const gateEnvironment = createGateEnvironment({ variables, hostEnvironment });
  await runGate({ cwd, environment: gateEnvironment });

  const configPath = path.resolve(cwd, builtConfig);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  validateBuiltWorkerConfig({ config, variables, secrets });
  process.stdout.write("Self-hosting gate and built Worker verification passed.\n");
  return true;
}

export function createGateEnvironment({ variables, hostEnvironment = process.env } = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(hostEnvironment ?? {})) {
    if (HOST_ENVIRONMENT_KEYS.has(key.toUpperCase())) environment[key] = value;
  }
  for (const key of SELF_HOSTING_BUILD_VARIABLE_KEYS) {
    if (Object.hasOwn(variables ?? {}, key)) environment[key] = variables[key];
  }
  environment.CI = "true";
  return environment;
}

function runNpmCheck({ cwd, environment }) {
  const npmCli = process.env.npm_execpath;
  const executable = npmCli ? process.execPath : "npm";
  const argumentsList = npmCli ? [npmCli, "run", "check"] : ["run", "check"];
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
      else rejectPromise(new Error(`npm run check failed${signal ? ` with signal ${signal}` : ` with exit code ${code}`}.`));
    });
  });
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = new Map([
      ["--env-file", "envFile"],
      ["--secrets-file", "secretsFile"],
      ["--built-config", "builtConfig"],
    ]).get(args[index]);
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete argument: ${args[index]}`);
    options[key] = args[index + 1];
    index += 1;
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
