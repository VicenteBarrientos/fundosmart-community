import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

import { createLocalVars } from "../scripts/development/create-local-vars.mjs";
import { createSelfHostingSecrets } from "../scripts/release/create-self-hosting-secrets.mjs";
import { runSelfHostingCheck } from "../scripts/release/run-self-hosting-check.mjs";
import { runPinnedWrangler } from "../scripts/release/run-pinned-wrangler.mjs";
import { loadSelfHostingSmokeConfiguration } from "../scripts/release/smoke.mjs";
import {
  SelfHostingPreflightError,
  validateBuiltWorkerConfig,
  validateSelfHostingEnvironment,
} from "../scripts/release/self-hosting-preflight.mjs";

const releaseSha = "a".repeat(40);

function validVariables(overrides = {}) {
  return {
    NEXT_PUBLIC_APP_URL: "https://community.farm.cl",
    FUNDOSMART_BASE_URL: "https://community.farm.cl",
    FUNDOSMART_APP_BASE_URL: "https://community.farm.cl",
    FUNDOSMART_DEPLOY_ENVIRONMENT: "production",
    FUNDOSMART_RELEASE_SHA: releaseSha,
    FUNDOSMART_WORKER_NAME: "fundosmart-community-farm",
    FUNDOSMART_D1_DATABASE_NAME: "fundosmart-community-farm",
    FUNDOSMART_D1_DATABASE_ID: "123e4567-e89b-42d3-a456-426614174000",
    FUNDOSMART_R2_BUCKET_NAME: "fundosmart-community-farm-files",
    CLOUDFLARE_ACCOUNT_ID: "1234567890abcdef1234567890abcdef",
    FUNDOSMART_ENABLE_AI: "false",
    FUNDOSMART_ENABLE_REMOTE_AI: "false",
    FUNDOSMART_ENABLE_ANALYTICS: "false",
    ...overrides,
  };
}

function validSecrets(overrides = {}) {
  return {
    AUTH_ORIGIN: "https://community.farm.cl",
    GOOGLE_CLIENT_ID: "123456-farm.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-client-secret-issued-for-farm",
    FUNDOSMART_OWNER_EMAIL: "owner@farm.cl",
    OFFLINE_SESSION_SECRET: "offline-session-secret-with-more-than-32-bytes",
    ASSISTANT_CONFIRMATION_SECRET: Buffer.alloc(32, 0x41).toString("base64url"),
    AI_KEYS_ENCRYPTION_SECRET: "ai-key-encryption-secret-with-more-than-32-characters",
    ...overrides,
  };
}

function validBuiltConfig(variables = validVariables()) {
  return {
    account_id: variables.CLOUDFLARE_ACCOUNT_ID,
    name: variables.FUNDOSMART_WORKER_NAME,
    vars: {
      FUNDOSMART_DEPLOY_ENVIRONMENT: variables.FUNDOSMART_DEPLOY_ENVIRONMENT,
      FUNDOSMART_RELEASE_SHA: variables.FUNDOSMART_RELEASE_SHA,
      FUNDOSMART_APP_BASE_URL: variables.FUNDOSMART_APP_BASE_URL,
    },
    d1_databases: [{
      binding: "DB",
      database_name: variables.FUNDOSMART_D1_DATABASE_NAME,
      database_id: variables.FUNDOSMART_D1_DATABASE_ID,
    }],
    r2_buckets: [{ binding: "FILES", bucket_name: variables.FUNDOSMART_R2_BUCKET_NAME }],
    images: { binding: "IMAGES" },
    assets: { binding: "ASSETS", directory: "../client" },
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "community.farm.cl", custom_domain: true }],
    observability: {
      enabled: true,
      logs: { enabled: true },
      traces: { enabled: true },
    },
    triggers: { crons: ["17 */6 * * *"] },
    analytics_engine_datasets: [],
    send_email: [],
  };
}

test("accepts an installation-owned production configuration and matching build", () => {
  const variables = validVariables();
  const secrets = validSecrets();
  const result = validateSelfHostingEnvironment({
    variables,
    secrets,
    expectedHeadSha: releaseSha,
    gitStatus: "",
    processEnvironment: {},
  });

  assert.deepEqual(result, {
    environment: "production",
    origin: "https://community.farm.cl",
    releaseSha,
  });
  assert.equal(validateBuiltWorkerConfig({ config: validBuiltConfig(variables), variables, secrets }), true);
});

test("fails closed for development defaults, divergent origins and a stale release SHA", () => {
  assert.throws(
    () => validateSelfHostingEnvironment({
      variables: validVariables({
        FUNDOSMART_DEPLOY_ENVIRONMENT: "development",
        FUNDOSMART_RELEASE_SHA: "b".repeat(40),
        FUNDOSMART_APP_BASE_URL: "https://other.farm.cl",
      }),
      secrets: validSecrets(),
      expectedHeadSha: releaseSha,
      gitStatus: "",
      processEnvironment: {},
    }),
    (error) => error instanceof SelfHostingPreflightError
      && /staging or production/u.test(error.message)
      && /same origin/u.test(error.message)
      && /checked-out Git commit/u.test(error.message),
  );
});

test("rejects development identities, placeholders and malformed confirmation keys", () => {
  assert.throws(
    () => validateSelfHostingEnvironment({
      variables: validVariables({ FUNDOSMART_D1_DATABASE_ID: "replace-with-id" }),
      secrets: validSecrets({
        DEV_AUTH_EMAIL: "developer@farm.cl",
        GOOGLE_CLIENT_SECRET: "replace-with-google-client-secret",
        FUNDOSMART_OWNER_EMAIL: "owner@example.com",
        ASSISTANT_CONFIRMATION_SECRET: "replace-with-at-least-32-random-characters",
      }),
      expectedHeadSha: releaseSha,
      gitStatus: "",
      processEnvironment: {},
    }),
    (error) => error instanceof SelfHostingPreflightError
      && /D1_DATABASE_ID/u.test(error.message)
      && /DEV_AUTH_EMAIL/u.test(error.message)
      && /GOOGLE_CLIENT_SECRET/u.test(error.message)
      && /exactly 32 random bytes/u.test(error.message),
  );
});

test("rejects reused secrets and build output wired to other resources", () => {
  const repeated = Buffer.alloc(32, 0x42).toString("base64url");
  assert.throws(
    () => validateSelfHostingEnvironment({
      variables: validVariables(),
      secrets: validSecrets({
        OFFLINE_SESSION_SECRET: repeated,
        ASSISTANT_CONFIRMATION_SECRET: repeated,
      }),
      expectedHeadSha: releaseSha,
      gitStatus: "",
      processEnvironment: {},
    }),
    /must be distinct values/u,
  );

  const variables = validVariables();
  const config = validBuiltConfig(variables);
  config.d1_databases[0].database_id = "223e4567-e89b-42d3-a456-426614174000";
  assert.throws(
    () => validateBuiltWorkerConfig({ config, variables, secrets: validSecrets() }),
    /installation-owned D1 database/u,
  );
});

test("generates three private independent secrets without printing or overwriting them", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-self-host-secrets-"));
  const outputPath = path.join(directory, "community.secrets.env");
  let call = 0;
  const randomBytesImpl = (length) => Buffer.alloc(length, ++call);
  try {
    await createSelfHostingSecrets({ outputPath, randomBytesImpl });
    const parsed = parseEnv(await readFile(outputPath, "utf8"));
    const generated = [
      parsed.OFFLINE_SESSION_SECRET,
      parsed.ASSISTANT_CONFIRMATION_SECRET,
      parsed.AI_KEYS_ENCRYPTION_SECRET,
    ];
    assert.equal(new Set(generated).size, 3);
    for (const value of generated) assert.equal(Buffer.from(value, "base64url").byteLength, 32);
    await assert.rejects(
      () => createSelfHostingSecrets({ outputPath, randomBytesImpl }),
      /EEXIST/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generates a ready local development identity with valid independent secrets", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-local-vars-"));
  const outputPath = path.join(directory, ".dev.vars");
  let call = 10;
  try {
    await createLocalVars({
      outputPath,
      randomBytesImpl: (length) => Buffer.alloc(length, ++call),
    });
    const parsed = parseEnv(await readFile(outputPath, "utf8"));
    assert.equal(parsed.AUTH_ORIGIN, "http://localhost:3000");
    assert.equal(parsed.DEV_AUTH_EMAIL, "developer@example.com");
    const secrets = [
      parsed.OFFLINE_SESSION_SECRET,
      parsed.ASSISTANT_CONFIRMATION_SECRET,
      parsed.AI_KEYS_ENCRYPTION_SECRET,
    ];
    assert.equal(new Set(secrets).size, 3);
    for (const value of secrets) assert.equal(Buffer.from(value, "base64url").byteLength, 32);
    await assert.rejects(() => createLocalVars({ outputPath }), /EEXIST/u);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when Git provenance is unavailable, dirty or the environment contains an unexpected key", () => {
  assert.throws(
    () => validateSelfHostingEnvironment({
      variables: validVariables({ NODE_OPTIONS: "--import=malicious.mjs" }),
      secrets: validSecrets(),
      expectedHeadSha: undefined,
      gitStatus: " M worker/index.ts",
      processEnvironment: {},
    }),
    (error) => error instanceof SelfHostingPreflightError
      && /NODE_OPTIONS is not an allowed key/u.test(error.message)
      && /Git HEAD could not be resolved/u.test(error.message)
      && /working tree must be clean/u.test(error.message),
  );
});

test("rejects private or stale Worker vars and enforces the email sender restriction", () => {
  const variables = validVariables({ FUNDOSMART_EMAIL_FROM: "notices@farm.cl" });
  const config = validBuiltConfig(variables);
  config.vars.FUNDOSMART_EMAIL_FROM = variables.FUNDOSMART_EMAIL_FROM;
  config.vars.FUNDOSMART_OWNER_EMAIL = "owner@farm.cl";
  config.send_email = [{ name: "EMAIL" }];
  assert.throws(
    () => validateBuiltWorkerConfig({ config, variables, secrets: validSecrets() }),
    (error) => error instanceof SelfHostingPreflightError
      && /vars do not exactly match/u.test(error.message)
      && /EMAIL binding/u.test(error.message)
      && /private binding FUNDOSMART_OWNER_EMAIL/u.test(error.message),
  );
});

test("the self-hosting gate receives build variables but never receives the secrets file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-self-host-gate-"));
  const envFile = path.join(directory, "deployment.env");
  const secretsFile = path.join(directory, "secrets.env");
  const builtConfig = path.join(directory, "wrangler.json");
  const variables = validVariables();
  const secrets = validSecrets();
  try {
    await Promise.all([
      writeFile(envFile, toDotEnv(variables)),
      writeFile(secretsFile, toDotEnv(secrets)),
      writeFile(builtConfig, JSON.stringify(validBuiltConfig(variables))),
    ]);
    let gateEnvironment;
    assert.equal(await runSelfHostingCheck({
      cwd: directory,
      envFile,
      secretsFile,
      builtConfig,
      expectedHeadSha: releaseSha,
      gitStatus: "",
      hostEnvironment: {
        Path: process.env.Path ?? process.env.PATH,
        NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)",
        google_client_secret: "must-not-reach-the-gate",
      },
      runGate: async ({ environment }) => {
        gateEnvironment = environment;
      },
    }), true);
    assert.equal(gateEnvironment.FUNDOSMART_D1_DATABASE_ID, variables.FUNDOSMART_D1_DATABASE_ID);
    assert.equal(gateEnvironment.GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(gateEnvironment.OFFLINE_SESSION_SECRET, undefined);
    assert.equal(gateEnvironment.google_client_secret, undefined);
    assert.equal(gateEnvironment.NODE_OPTIONS, undefined);
    assert.equal(gateEnvironment.CI, "true");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pins Wrangler to the selected account and selected environment file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-pinned-wrangler-"));
  const envFile = path.join(directory, ".env.staging.local");
  const variables = validVariables({ FUNDOSMART_DEPLOY_ENVIRONMENT: "staging" });
  try {
    await writeFile(envFile, toDotEnv(variables));
    let invocation;
    await runPinnedWrangler({
      cwd: directory,
      envFile,
      wranglerArguments: ["d1", "info", "DB"],
      hostEnvironment: {
        CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
        Node_Options: "--import=malicious.mjs",
        CF_API_TOKEN: "authentication-token-is-preserved",
      },
      expectedHeadSha: releaseSha,
      gitStatus: "",
      runWrangler: async (details) => {
        invocation = details;
      },
    });
    assert.equal(invocation.environment.CLOUDFLARE_ACCOUNT_ID, variables.CLOUDFLARE_ACCOUNT_ID);
    assert.equal(invocation.environment.CI, "true");
    assert.equal(invocation.environment.Node_Options, undefined);
    assert.equal(invocation.environment.CF_API_TOKEN, "authentication-token-is-preserved");
    assert.deepEqual(invocation.argumentsList.slice(-2), ["--env-file", envFile]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads the smoke target only from the selected file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-smoke-target-"));
  const envFile = path.join(directory, ".env.staging.local");
  try {
    await writeFile(envFile, toDotEnv(validVariables({
      FUNDOSMART_DEPLOY_ENVIRONMENT: "staging",
      FUNDOSMART_SMOKE_ATTEMPTS: "3",
    })));
    assert.deepEqual(await loadSelfHostingSmokeConfiguration({ envFile }), {
      baseUrl: "https://community.farm.cl",
      attempts: 3,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the public documentation exposes the guarded Cloudflare lifecycle and external services", async () => {
  const root = new URL("../", import.meta.url);
  const [guide, services, readme, contributing, index] = await Promise.all([
    readFile(new URL("docs/operacion/autoalojamiento.md", root), "utf8"),
    readFile(new URL("docs/operacion/servicios-externos-y-configuracion.md", root), "utf8"),
    readFile(new URL("README.md", root), "utf8"),
    readFile(new URL("CONTRIBUTING.md", root), "utf8"),
    readFile(new URL("docs/index.md", root), "utf8"),
  ]);

  for (const command of [
    "npm run self-host:init-secrets",
    "npm run self-host:validate",
    "npm run self-host:check",
    "npm run self-host:wrangler",
    "d1 migrations apply DB --remote",
    "deploy -c dist/server/wrangler.json",
    "npm run self-host:smoke",
    "rollback PREVIOUS_VERSION_ID",
    "d1 time-travel restore DB",
  ]) {
    assert.match(guide, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(guide, /`npm run deploy` continúa bloqueado/u);
  assert.match(services, /OpenStreetMap Standard[\s\S]+Workers Observability[\s\S]+Copernicus/u);
  assert.match(services, /\$\{AUTH_ORIGIN\}\/auth\/google\/callback/u);
  assert.match(readme, /matriz de servicios externos/u);
  assert.match(contributing, /npm `10\.9\.3`/u);
  assert.match(index, /servicios-externos-y-configuracion\.md/u);
});

function toDotEnv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}
