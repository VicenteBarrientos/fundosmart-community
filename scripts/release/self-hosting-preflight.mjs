import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readStrictDotEnvFile } from "./self-hosting-env-files.mjs";

const DEFAULT_ENV_FILE = ".env.production.local";
const DEFAULT_SECRETS_FILE = ".wrangler/community.production.secrets.env";
const DEFAULT_BUILT_CONFIG = "dist/server/wrangler.json";
const PLACEHOLDER = /(?:replace|placeholder|change[-_ ]?me|example\.(?:com|org|net)|\.invalid|<[^>]+>)/iu;
const SAFE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const ALLOWED_GIT_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "TEMP",
  "TMP",
]);

export const SELF_HOSTING_BUILD_VARIABLE_KEYS = Object.freeze([
  "NEXT_PUBLIC_APP_URL",
  "FUNDOSMART_BASE_URL",
  "FUNDOSMART_APP_BASE_URL",
  "FUNDOSMART_DEPLOY_ENVIRONMENT",
  "FUNDOSMART_RELEASE_SHA",
  "FUNDOSMART_WORKER_NAME",
  "FUNDOSMART_D1_DATABASE_NAME",
  "FUNDOSMART_D1_DATABASE_ID",
  "FUNDOSMART_R2_BUCKET_NAME",
  "FUNDOSMART_DATA_JURISDICTION",
  "CLOUDFLARE_ACCOUNT_ID",
  "FUNDOSMART_ENABLE_AI",
  "FUNDOSMART_ENABLE_REMOTE_AI",
  "FUNDOSMART_ENABLE_ANALYTICS",
  "FUNDOSMART_METRICS_DATASET",
  "FUNDOSMART_MAP_USAGE_DATASET",
  "FUNDOSMART_EMAIL_FROM",
  "FUNDOSMART_INBOX_DOMAIN",
  "NEXT_PUBLIC_ARCGIS_BASEMAP_KEY",
  "FUNDOSMART_SMOKE_ATTEMPTS",
]);

export const SELF_HOSTING_SECRET_KEYS = Object.freeze([
  "AUTH_ORIGIN",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "FUNDOSMART_OWNER_EMAIL",
  "OFFLINE_SESSION_SECRET",
  "ASSISTANT_CONFIRMATION_SECRET",
  "AI_KEYS_ENCRYPTION_SECRET",
  "CDSE_CLIENT_ID",
  "CDSE_CLIENT_SECRET",
]);

const PRIVATE_VALUE_KEYS = new Set([
  "GOOGLE_CLIENT_SECRET",
  "OFFLINE_SESSION_SECRET",
  "ASSISTANT_CONFIRMATION_SECRET",
  "AI_KEYS_ENCRYPTION_SECRET",
  "CDSE_CLIENT_SECRET",
]);

export class SelfHostingPreflightError extends Error {
  constructor(issues) {
    super(`Self-hosting preflight failed:\n- ${issues.join("\n- ")}`);
    this.name = "SelfHostingPreflightError";
    this.issues = issues;
  }
}

export async function loadSelfHostingConfiguration({
  envFile = DEFAULT_ENV_FILE,
  secretsFile = DEFAULT_SECRETS_FILE,
} = {}) {
  const environmentPath = path.resolve(envFile);
  const secretsPath = path.resolve(secretsFile);
  const [variables, secrets] = await Promise.all([
    readEnvironmentFile(environmentPath, "deployment environment"),
    readEnvironmentFile(secretsPath, "secrets file"),
  ]);
  return { variables, secrets, environmentPath, secretsPath };
}

export function validateSelfHostingEnvironmentSelection({
  expectedEnvironment,
  variables,
  envFile,
  secretsFile,
} = {}) {
  const issues = [];
  const environment = normalized(expectedEnvironment);
  if (!new Set(["staging", "production"]).has(environment)) {
    issues.push("The wrapper requires an explicit staging or production environment selection.");
  }
  if (normalized(variables?.FUNDOSMART_DEPLOY_ENVIRONMENT) !== environment) {
    issues.push("The explicit environment selection does not match FUNDOSMART_DEPLOY_ENVIRONMENT.");
  }
  validateEnvironmentFileName(envFile, environment, "deployment environment file", issues);
  if (secretsFile) validateEnvironmentFileName(secretsFile, environment, "secrets file", issues);
  if (issues.length > 0) throw new SelfHostingPreflightError(issues);
  return environment;
}

export function validateSelfHostingEnvironment({
  variables,
  secrets,
  expectedHeadSha,
  gitStatus,
  processEnvironment = process.env,
} = {}) {
  const issues = [];
  const vars = variables ?? {};
  const privateValues = secrets ?? {};

  validateExactKeys(vars, SELF_HOSTING_BUILD_VARIABLE_KEYS, "deployment environment", issues);
  validateExactKeys(privateValues, SELF_HOSTING_SECRET_KEYS, "secrets file", issues);

  for (const key of [
    "NEXT_PUBLIC_APP_URL",
    "FUNDOSMART_BASE_URL",
    "FUNDOSMART_APP_BASE_URL",
    "FUNDOSMART_DEPLOY_ENVIRONMENT",
    "FUNDOSMART_RELEASE_SHA",
    "FUNDOSMART_WORKER_NAME",
    "FUNDOSMART_D1_DATABASE_NAME",
    "FUNDOSMART_D1_DATABASE_ID",
    "FUNDOSMART_R2_BUCKET_NAME",
    "CLOUDFLARE_ACCOUNT_ID",
    "FUNDOSMART_ENABLE_AI",
    "FUNDOSMART_ENABLE_REMOTE_AI",
    "FUNDOSMART_ENABLE_ANALYTICS",
  ]) {
    requireValue(vars, key, "deployment environment", issues);
  }
  for (const key of [
    "AUTH_ORIGIN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "FUNDOSMART_OWNER_EMAIL",
    "OFFLINE_SESSION_SECRET",
    "ASSISTANT_CONFIRMATION_SECRET",
    "AI_KEYS_ENCRYPTION_SECRET",
  ]) {
    requireValue(privateValues, key, "secrets file", issues);
  }

  const environment = normalized(vars.FUNDOSMART_DEPLOY_ENVIRONMENT);
  if (!new Set(["staging", "production"]).has(environment)) {
    issues.push("FUNDOSMART_DEPLOY_ENVIRONMENT must be staging or production.");
  }

  const origins = [
    ["NEXT_PUBLIC_APP_URL", vars.NEXT_PUBLIC_APP_URL],
    ["FUNDOSMART_BASE_URL", vars.FUNDOSMART_BASE_URL],
    ["FUNDOSMART_APP_BASE_URL", vars.FUNDOSMART_APP_BASE_URL],
    ["AUTH_ORIGIN", privateValues.AUTH_ORIGIN],
  ].map(([key, value]) => [key, parseHttpsOrigin(key, value, issues)]);
  const configuredOrigins = [...new Set(origins.map(([, origin]) => origin).filter(Boolean))];
  if (configuredOrigins.length > 1) {
    issues.push("NEXT_PUBLIC_APP_URL, FUNDOSMART_BASE_URL, FUNDOSMART_APP_BASE_URL and AUTH_ORIGIN must use the same origin.");
  }

  for (const key of [
    "FUNDOSMART_WORKER_NAME",
    "FUNDOSMART_D1_DATABASE_NAME",
    "FUNDOSMART_R2_BUCKET_NAME",
  ]) {
    const value = normalized(vars[key]);
    if (value && (!SAFE_NAME.test(value) || PLACEHOLDER.test(value) || /(?:^|[-_])local(?:$|[-_])/iu.test(value))) {
      issues.push(`${key} must be an installation-owned Cloudflare resource name, not a local or placeholder value.`);
    }
  }

  const databaseId = normalized(vars.FUNDOSMART_D1_DATABASE_ID);
  if (databaseId && (!UUID.test(databaseId) || /^0+-(?:0+-){3}0+$/u.test(databaseId))) {
    issues.push("FUNDOSMART_D1_DATABASE_ID must be the UUID returned by wrangler d1 create.");
  }

  const dataJurisdiction = normalized(vars.FUNDOSMART_DATA_JURISDICTION);
  if (!new Set(["", "eu", "fedramp"]).has(dataJurisdiction)) {
    issues.push("FUNDOSMART_DATA_JURISDICTION must be empty, eu or fedramp.");
  }

  const accountId = normalized(vars.CLOUDFLARE_ACCOUNT_ID);
  if (accountId && (!/^[0-9a-f]{32}$/iu.test(accountId) || /^0+$/u.test(accountId))) {
    issues.push("CLOUDFLARE_ACCOUNT_ID must be the 32-character account ID that owns every deployment resource.");
  }
  const inheritedAccountIds = environmentValues(processEnvironment, "CLOUDFLARE_ACCOUNT_ID");
  if (accountId && inheritedAccountIds.some((value) => value !== accountId)) {
    issues.push("The inherited CLOUDFLARE_ACCOUNT_ID conflicts with the deployment environment file.");
  }

  const releaseSha = normalized(vars.FUNDOSMART_RELEASE_SHA);
  if (releaseSha && !RELEASE_SHA.test(releaseSha)) {
    issues.push("FUNDOSMART_RELEASE_SHA must be a full 40- or 64-character Git commit SHA.");
  }
  if (!RELEASE_SHA.test(normalized(expectedHeadSha))) {
    issues.push("Git HEAD could not be resolved to a full commit SHA; build from a Git checkout.");
  } else if (releaseSha && releaseSha.toLowerCase() !== normalized(expectedHeadSha).toLowerCase()) {
    issues.push("FUNDOSMART_RELEASE_SHA does not match the checked-out Git commit.");
  }
  if (typeof gitStatus !== "string") {
    issues.push("Git index and working-tree cleanliness could not be verified.");
  } else if (gitStatus.trim()) {
    issues.push("Git index and working tree must be clean before building or running a remote command.");
  }

  for (const key of [
    "FUNDOSMART_ENABLE_AI",
    "FUNDOSMART_ENABLE_REMOTE_AI",
    "FUNDOSMART_ENABLE_ANALYTICS",
  ]) {
    validateBoolean(vars, key, issues);
  }
  if (normalized(vars.FUNDOSMART_ENABLE_REMOTE_AI) === "true") {
    issues.push("FUNDOSMART_ENABLE_REMOTE_AI is only for local development and must be false for a deployment build.");
  }
  if (normalized(vars.FUNDOSMART_ENABLE_ANALYTICS) === "true") {
    for (const key of ["FUNDOSMART_METRICS_DATASET", "FUNDOSMART_MAP_USAGE_DATASET"]) {
      const value = requireValue(vars, key, "deployment environment", issues);
      if (value && !/^[A-Za-z0-9_]+$/u.test(value)) {
        issues.push(`${key} may contain only letters, digits and underscores.`);
      }
    }
    if (normalized(vars.FUNDOSMART_METRICS_DATASET) === normalized(vars.FUNDOSMART_MAP_USAGE_DATASET)) {
      issues.push("FUNDOSMART_METRICS_DATASET and FUNDOSMART_MAP_USAGE_DATASET must be distinct.");
    }
  }

  for (const key of ["FUNDOSMART_EMAIL_FROM", "FUNDOSMART_OWNER_EMAIL"]) {
    const value = key === "FUNDOSMART_OWNER_EMAIL" ? privateValues[key] : vars[key];
    if (normalized(value) && !isEmail(value)) issues.push(`${key} must contain a valid email address.`);
    if (normalized(value) && (PLACEHOLDER.test(value) || !hasPublicEmailDomain(value))) {
      issues.push(`${key} must identify this installation and cannot use a placeholder or reserved example domain.`);
    }
  }

  const smokeAttempts = normalized(vars.FUNDOSMART_SMOKE_ATTEMPTS);
  if (smokeAttempts && (!/^\d+$/u.test(smokeAttempts) || Number(smokeAttempts) < 1 || Number(smokeAttempts) > 10)) {
    issues.push("FUNDOSMART_SMOKE_ATTEMPTS must be an integer between 1 and 10.");
  }

  const inboxDomain = normalized(vars.FUNDOSMART_INBOX_DOMAIN);
  if (inboxDomain && (!isHostname(inboxDomain) || !isPublicDeploymentHostname(inboxDomain))) {
    issues.push("FUNDOSMART_INBOX_DOMAIN must be a real hostname controlled by the installation.");
  }

  if (normalized(vars.NEXT_PUBLIC_ARCGIS_BASEMAP_KEY) && PLACEHOLDER.test(vars.NEXT_PUBLIC_ARCGIS_BASEMAP_KEY)) {
    issues.push("NEXT_PUBLIC_ARCGIS_BASEMAP_KEY must be omitted or replaced; it is browser-visible by design.");
  }

  for (const key of ["DEV_AUTH_EMAIL", "DEV_AUTH_NAME"]) {
    if (Object.hasOwn(privateValues, key) || Object.hasOwn(vars, key)) {
      issues.push(`${key} must not be present in staging or production configuration.`);
    }
  }
  for (const key of [
    "AUTH_ORIGIN",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "FUNDOSMART_OWNER_EMAIL",
    "OFFLINE_SESSION_SECRET",
    "ASSISTANT_CONFIRMATION_SECRET",
    "AI_KEYS_ENCRYPTION_SECRET",
    "CDSE_CLIENT_ID",
    "CDSE_CLIENT_SECRET",
  ]) {
    if (Object.hasOwn(vars, key)) issues.push(`${key} belongs in the secrets file, not the build environment file.`);
  }

  const googleClientId = normalized(privateValues.GOOGLE_CLIENT_ID);
  if (googleClientId && (!googleClientId.endsWith(".apps.googleusercontent.com") || PLACEHOLDER.test(googleClientId))) {
    issues.push("GOOGLE_CLIENT_ID must be the Web application client ID issued for this installation.");
  }
  validateNonPlaceholderSecret(privateValues, "GOOGLE_CLIENT_SECRET", issues);

  validateStrongSecret(privateValues, "OFFLINE_SESSION_SECRET", issues, { measure: "bytes" });
  validateStrongSecret(privateValues, "AI_KEYS_ENCRYPTION_SECRET", issues, { measure: "characters" });
  validateAssistantConfirmationSecret(privateValues.ASSISTANT_CONFIRMATION_SECRET, issues);
  const distinctSecrets = ["OFFLINE_SESSION_SECRET", "AI_KEYS_ENCRYPTION_SECRET", "ASSISTANT_CONFIRMATION_SECRET"]
    .map((key) => normalized(privateValues[key]))
    .filter(Boolean);
  if (new Set(distinctSecrets).size !== distinctSecrets.length) {
    issues.push("OFFLINE_SESSION_SECRET, ASSISTANT_CONFIRMATION_SECRET and AI_KEYS_ENCRYPTION_SECRET must be distinct values.");
  }

  const hasCdseClientKey = Object.hasOwn(privateValues, "CDSE_CLIENT_ID");
  const hasCdseSecretKey = Object.hasOwn(privateValues, "CDSE_CLIENT_SECRET");
  const cdseClient = normalized(privateValues.CDSE_CLIENT_ID);
  const cdseSecret = normalized(privateValues.CDSE_CLIENT_SECRET);
  const hasCompleteCdsePair = hasCdseClientKey && hasCdseSecretKey && cdseClient && cdseSecret;
  if ((hasCdseClientKey || hasCdseSecretKey) && !hasCompleteCdsePair) {
    issues.push("CDSE_CLIENT_ID and CDSE_CLIENT_SECRET must both be omitted or both contain non-empty values.");
  }
  if (hasCompleteCdsePair && PLACEHOLDER.test(cdseClient)) {
    issues.push("CDSE_CLIENT_ID must be the value issued for this installation, not a placeholder.");
  }
  if (hasCompleteCdsePair) validateNonPlaceholderSecret(privateValues, "CDSE_CLIENT_SECRET", issues);

  if (issues.length > 0) throw new SelfHostingPreflightError(issues);
  return {
    environment,
    origin: configuredOrigins[0],
    releaseSha,
  };
}

export function validateBuiltWorkerConfig({ config, variables, secrets } = {}) {
  const issues = [];
  const vars = variables ?? {};
  const privateValues = secrets ?? {};
  const workerConfig = config ?? {};

  if (workerConfig.account_id !== normalized(vars.CLOUDFLARE_ACCOUNT_ID)) {
    issues.push("Built Worker account_id does not match CLOUDFLARE_ACCOUNT_ID.");
  }
  if (workerConfig.name !== normalized(vars.FUNDOSMART_WORKER_NAME)) {
    issues.push("Built Worker name does not match FUNDOSMART_WORKER_NAME.");
  }
  const expectedWorkerVariables = Object.fromEntries([
    "FUNDOSMART_DEPLOY_ENVIRONMENT",
    "FUNDOSMART_RELEASE_SHA",
    "FUNDOSMART_APP_BASE_URL",
    "FUNDOSMART_EMAIL_FROM",
    "FUNDOSMART_INBOX_DOMAIN",
  ].map((key) => [key, normalized(vars[key])]).filter(([, value]) => value));
  if (!sameStringRecord(workerConfig.vars, expectedWorkerVariables)) {
    issues.push("Built Worker vars do not exactly match the approved public runtime variables.");
  }

  const databases = workerConfig.d1_databases ?? [];
  const expectedDatabaseBinding = {
    binding: "DB",
    database_name: normalized(vars.FUNDOSMART_D1_DATABASE_NAME),
    database_id: normalized(vars.FUNDOSMART_D1_DATABASE_ID),
    migrations_dir: "../../drizzle",
  };
  if (!sameJsonValue(databases, [expectedDatabaseBinding])) {
    issues.push("Built DB binding does not match the installation-owned D1 database.");
  }
  const buckets = workerConfig.r2_buckets ?? [];
  const dataJurisdiction = normalized(vars.FUNDOSMART_DATA_JURISDICTION);
  const expectedBucketBinding = {
    binding: "FILES",
    bucket_name: normalized(vars.FUNDOSMART_R2_BUCKET_NAME),
    ...(dataJurisdiction ? { jurisdiction: dataJurisdiction } : {}),
  };
  if (!sameJsonValue(buckets, [expectedBucketBinding])) {
    issues.push("Built FILES binding does not match the installation-owned R2 bucket.");
  }
  if (!sameJsonValue(workerConfig.images, { binding: "IMAGES" })) {
    issues.push("Built Worker IMAGES binding is not canonical.");
  }
  if (!sameStringRecord(workerConfig.assets, { binding: "ASSETS", directory: "../client" })) {
    issues.push("Built Worker ASSETS binding must target the verified ../client directory.");
  }
  if (workerConfig.topLevelName !== normalized(vars.FUNDOSMART_WORKER_NAME)) {
    issues.push("Built Worker top-level name does not match FUNDOSMART_WORKER_NAME.");
  }
  if (workerConfig.main !== "index.js" || workerConfig.no_bundle !== true) {
    issues.push("Built Worker entrypoint must be the verified unbundled index.js artifact.");
  }
  if (workerConfig.compatibility_date !== "2026-07-18"
    || !Array.isArray(workerConfig.compatibility_flags)
    || workerConfig.compatibility_flags.length !== 1
    || workerConfig.compatibility_flags[0] !== "nodejs_compat") {
    issues.push("Built Worker compatibility settings do not match the reviewed release configuration.");
  }
  if (workerConfig.workers_dev !== false || workerConfig.preview_urls !== false) {
    issues.push("Built Worker must disable workers.dev and preview URLs for a remote installation.");
  }
  const deploymentHostname = new URL(normalized(vars.FUNDOSMART_APP_BASE_URL)).hostname;
  const expectedRoutes = [{ pattern: deploymentHostname, custom_domain: true }];
  if (!sameJsonValue(workerConfig.routes, expectedRoutes)) {
    issues.push("Built Worker must contain exactly the installation custom domain route.");
  }
  const expectedObservability = {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
    traces: { enabled: true, head_sampling_rate: 0.05 },
  };
  if (!sameJsonValue(workerConfig.observability, expectedObservability)) {
    issues.push("Built Worker must retain the documented observability configuration.");
  }
  const expectedTriggers = { crons: ["17 */6 * * *"] };
  if (!sameJsonValue(workerConfig.triggers, expectedTriggers)) {
    issues.push("Built Worker must retain the scheduled maintenance trigger.");
  }

  const aiEnabled = normalized(vars.FUNDOSMART_ENABLE_AI) === "true";
  const expectedAiBinding = aiEnabled ? { binding: "AI" } : undefined;
  if (!sameJsonValue(workerConfig.ai, expectedAiBinding)) {
    issues.push("Built AI binding does not match FUNDOSMART_ENABLE_AI.");
  }
  const analyticsEnabled = normalized(vars.FUNDOSMART_ENABLE_ANALYTICS) === "true";
  const expectedAnalyticsBindings = analyticsEnabled
    ? [
        { binding: "METRICS", dataset: normalized(vars.FUNDOSMART_METRICS_DATASET) },
        { binding: "MAP_USAGE", dataset: normalized(vars.FUNDOSMART_MAP_USAGE_DATASET) },
      ]
    : [];
  if (!sameJsonValue(workerConfig.analytics_engine_datasets, expectedAnalyticsBindings)) {
    issues.push("Built Analytics Engine bindings do not exactly match the configured datasets.");
  }

  const emailEnabled = Boolean(normalized(vars.FUNDOSMART_EMAIL_FROM));
  const expectedSender = normalized(vars.FUNDOSMART_EMAIL_FROM);
  const expectedEmailBindings = emailEnabled
    ? [{ name: "EMAIL", allowed_sender_addresses: [expectedSender] }]
    : [];
  if (!sameJsonValue(workerConfig.send_email, expectedEmailBindings)) {
    issues.push("Built EMAIL binding does not match FUNDOSMART_EMAIL_FROM.");
  }

  const expectedManifest = expectedBuiltWorkerManifest({
    vars,
    expectedWorkerVariables,
    expectedDatabaseBinding,
    expectedBucketBinding,
    expectedRoutes,
    expectedObservability,
    expectedTriggers,
    expectedAiBinding,
    expectedAnalyticsBindings,
    expectedEmailBindings,
  });
  if (!sameJsonValue(workerConfig, expectedManifest)) {
    issues.push("Built Worker manifest does not exactly match the canonical remote Vite output.");
  }

  const serialized = JSON.stringify(workerConfig);
  for (const key of SELF_HOSTING_SECRET_KEYS) {
    const value = normalized(privateValues[key]);
    if (serialized.includes(key) || (PRIVATE_VALUE_KEYS.has(key) && value && serialized.includes(value))) {
      issues.push(`Built Worker configuration contains the name or value of private binding ${key}.`);
    }
  }
  if (/DEV_AUTH_(?:EMAIL|NAME)/u.test(serialized)) {
    issues.push("Built Worker configuration contains a development identity override.");
  }

  if (issues.length > 0) throw new SelfHostingPreflightError(issues);
  return true;
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const { variables, secrets } = await loadSelfHostingConfiguration(options);
  const expectedHeadSha = readHeadSha();
  const gitStatus = readGitStatus();
  const result = validateSelfHostingEnvironment({ variables, secrets, expectedHeadSha, gitStatus });

  if (options.built) {
    const configPath = path.resolve(options.builtConfig);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    validateBuiltWorkerConfig({ config, variables, secrets });
  }

  process.stdout.write(
    `Self-hosting preflight passed for ${result.environment} at ${result.origin}${options.built ? " with verified build output" : ""}.\n`,
  );
}

function parseArguments(args) {
  const options = {
    envFile: DEFAULT_ENV_FILE,
    secretsFile: DEFAULT_SECRETS_FILE,
    builtConfig: DEFAULT_BUILT_CONFIG,
    built: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--built") {
      options.built = true;
      continue;
    }
    const key = new Map([
      ["--env-file", "envFile"],
      ["--secrets-file", "secretsFile"],
      ["--built-config", "builtConfig"],
    ]).get(argument);
    if (!key || !args[index + 1]) throw new Error(`Unknown or incomplete argument: ${argument}`);
    options[key] = args[index + 1];
    index += 1;
  }
  return options;
}

async function readEnvironmentFile(filePath, label) {
  try {
    const result = await readStrictDotEnvFile(filePath, { label });
    return result.values;
  } catch (error) {
    throw new Error(`Could not read the ${label} at ${path.relative(process.cwd(), filePath)}.`, { cause: error });
  }
}

export function readHeadSha({ cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", [
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "rev-parse",
      "--verify",
      "HEAD^{commit}",
    ], {
      cwd,
      encoding: "utf8",
      env: createSanitizedGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function readGitStatus({ cwd = process.cwd() } = {}) {
  try {
    return execFileSync("git", [
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ], {
      cwd,
      encoding: "utf8",
      env: createSanitizedGitEnvironment(),
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
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

function normalized(value) {
  return String(value ?? "").trim();
}

function requireValue(source, key, label, issues) {
  const value = normalized(source[key]);
  if (!value) issues.push(`${key} is required in the ${label}.`);
  return value;
}

function validateExactKeys(source, allowedKeys, label, issues) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) issues.push(`${key} is not an allowed key in the ${label}.`);
  }
}

function environmentValues(environment, expectedKey) {
  return Object.entries(environment ?? {})
    .filter(([key]) => key.toUpperCase() === expectedKey)
    .map(([, value]) => normalized(value))
    .filter(Boolean);
}

function sameStringRecord(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const actualEntries = Object.entries(actual).sort(([left], [right]) => left.localeCompare(right));
  const expectedEntries = Object.entries(expected).sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(actualEntries) === JSON.stringify(expectedEntries);
}

function expectedBuiltWorkerManifest({
  vars,
  expectedWorkerVariables,
  expectedDatabaseBinding,
  expectedBucketBinding,
  expectedRoutes,
  expectedObservability,
  expectedTriggers,
  expectedAiBinding,
  expectedAnalyticsBindings,
  expectedEmailBindings,
}) {
  const workerName = normalized(vars.FUNDOSMART_WORKER_NAME);
  return {
    topLevelName: workerName,
    dev: {
      ip: "127.0.0.1",
      local_protocol: "http",
      upstream_protocol: "http",
      enable_containers: true,
      generate_types: false,
    },
    name: workerName,
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    vars: expectedWorkerVariables,
    durable_objects: { bindings: [] },
    kv_namespaces: [],
    queues: { producers: [], consumers: [] },
    r2_buckets: [expectedBucketBinding],
    d1_databases: [expectedDatabaseBinding],
    vectorize: [],
    ai_search_namespaces: [],
    ai_search: [],
    agent_memory: [],
    hyperdrive: [],
    workflows: [],
    secrets_store_secrets: [],
    artifacts: [],
    services: [],
    analytics_engine_datasets: expectedAnalyticsBindings,
    images: { binding: "IMAGES" },
    ...(expectedAiBinding ? { ai: expectedAiBinding } : {}),
    unsafe_hello_world: [],
    flagship: [],
    ratelimits: [],
    worker_loaders: [],
    main: "index.js",
    jsx_factory: "React.createElement",
    jsx_fragment: "React.Fragment",
    migrations: [],
    exports: {},
    triggers: expectedTriggers,
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    build: { watch_dir: "./src" },
    no_bundle: true,
    dispatch_namespaces: [],
    logfwdr: { bindings: [] },
    assets: { binding: "ASSETS", directory: "../client" },
    observability: expectedObservability,
    python_modules: { exclude: ["**/*.pyc"] },
    define: {},
    cloudchamber: {},
    send_email: expectedEmailBindings,
    mtls_certificates: [],
    pipelines: [],
    vpc_services: [],
    vpc_networks: [],
    account_id: normalized(vars.CLOUDFLARE_ACCOUNT_ID),
    workers_dev: false,
    preview_urls: false,
    routes: expectedRoutes,
  };
}

function sameJsonValue(actual, expected) {
  if (Object.is(actual, expected)) return true;
  if (Array.isArray(actual) || Array.isArray(expected)) {
    return Array.isArray(actual)
      && Array.isArray(expected)
      && actual.length === expected.length
      && actual.every((value, index) => sameJsonValue(value, expected[index]));
  }
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object") return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]
      && sameJsonValue(actual[key], expected[key]));
}

function validateEnvironmentFileName(filePath, environment, label, issues) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    issues.push(`The ${label} path is required.`);
    return;
  }
  const baseName = path.basename(filePath).toLowerCase();
  const selected = new RegExp(`(?:^|[._-])${environment}(?:[._-]|$)`, "u");
  const oppositeEnvironment = environment === "staging" ? "production" : "staging";
  const opposite = new RegExp(`(?:^|[._-])${oppositeEnvironment}(?:[._-]|$)`, "u");
  if (!selected.test(baseName) || opposite.test(baseName)) {
    issues.push(`The ${label} name must identify only the selected ${environment} environment.`);
  }
}

function parseHttpsOrigin(key, value, issues) {
  const raw = normalized(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash) {
      throw new Error("not an HTTPS origin");
    }
    if (!isPublicDeploymentHostname(url.hostname)) throw new Error("non-public hostname");
    return url.origin;
  } catch {
    issues.push(`${key} must be an exact HTTPS origin with no credentials, path, query or fragment.`);
    return undefined;
  }
}

function validateBoolean(source, key, issues) {
  const value = normalized(source[key]);
  if (value && value !== "true" && value !== "false") issues.push(`${key} must be true or false.`);
}

function validateNonPlaceholderSecret(source, key, issues) {
  const value = normalized(source[key]);
  if (value && (PLACEHOLDER.test(value) || value.length < 12)) {
    issues.push(`${key} must be replaced with the value issued for this installation.`);
  }
}

function validateStrongSecret(source, key, issues, { measure }) {
  const value = normalized(source[key]);
  if (!value) return;
  const size = measure === "characters" ? value.length : new TextEncoder().encode(value).byteLength;
  if (PLACEHOLDER.test(value) || size < 32) {
    issues.push(`${key} must be a unique random value of at least 32 ${measure} and cannot be a placeholder.`);
  }
}

function validateAssistantConfirmationSecret(value, issues) {
  const secret = normalized(value);
  if (!secret) return;
  let decoded;
  try {
    if (!/^[A-Za-z0-9_-]+$/u.test(secret) || PLACEHOLDER.test(secret)) throw new Error("invalid");
    decoded = Buffer.from(secret, "base64url");
    if (decoded.toString("base64url") !== secret) throw new Error("non-canonical");
  } catch {
    decoded = undefined;
  }
  if (decoded?.byteLength !== 32) {
    issues.push("ASSISTANT_CONFIRMATION_SECRET must be canonical Base64URL encoding exactly 32 random bytes.");
  }
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized(value));
}

function hasPublicEmailDomain(value) {
  const domain = normalized(value).split("@").at(-1);
  return isPublicDeploymentHostname(domain);
}

function isHostname(value) {
  try {
    const url = new URL(`https://${normalized(value)}`);
    return url.hostname === normalized(value).toLowerCase() && url.pathname === "/";
  } catch {
    return false;
  }
}

function isPublicDeploymentHostname(hostname) {
  const value = normalized(hostname).toLowerCase();
  if (!value || isIP(value)) return false;
  if (PLACEHOLDER.test(value) || value === "localhost" || value.endsWith(".localhost")) return false;
  if (/\.(?:local|test|invalid|example|workers\.dev)$/u.test(value)) return false;
  return value.includes(".");
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
