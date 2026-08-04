import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, rm, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv, promisify } from "node:util";

import { createLocalVars } from "../scripts/development/create-local-vars.mjs";
import { digestDistTree } from "../scripts/release/self-hosting-attestation.mjs";
import { runSelfHostingCheck } from "../scripts/release/run-self-hosting-check.mjs";
import { runPinnedWrangler } from "../scripts/release/run-pinned-wrangler.mjs";
import {
  SelfHostingPreflightError,
  validateBuiltWorkerConfig,
  validateSelfHostingEnvironment,
  validateSelfHostingEnvironmentSelection,
} from "../scripts/release/self-hosting-preflight.mjs";

const releaseSha = "a".repeat(40);
const execFileAsync = promisify(execFile);

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
    FUNDOSMART_DATA_JURISDICTION: "",
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
  const dataJurisdiction = variables.FUNDOSMART_DATA_JURISDICTION?.trim();
  const analyticsEnabled = variables.FUNDOSMART_ENABLE_ANALYTICS === "true";
  const aiEnabled = variables.FUNDOSMART_ENABLE_AI === "true";
  const emailSender = variables.FUNDOSMART_EMAIL_FROM?.trim();
  const inboxDomain = variables.FUNDOSMART_INBOX_DOMAIN?.trim();
  return {
    topLevelName: variables.FUNDOSMART_WORKER_NAME,
    dev: {
      ip: "127.0.0.1",
      local_protocol: "http",
      upstream_protocol: "http",
      enable_containers: true,
      generate_types: false,
    },
    name: variables.FUNDOSMART_WORKER_NAME,
    compatibility_date: "2026-07-18",
    compatibility_flags: ["nodejs_compat"],
    vars: {
      FUNDOSMART_DEPLOY_ENVIRONMENT: variables.FUNDOSMART_DEPLOY_ENVIRONMENT,
      FUNDOSMART_RELEASE_SHA: variables.FUNDOSMART_RELEASE_SHA,
      FUNDOSMART_APP_BASE_URL: variables.FUNDOSMART_APP_BASE_URL,
      ...(emailSender ? { FUNDOSMART_EMAIL_FROM: emailSender } : {}),
      ...(inboxDomain ? { FUNDOSMART_INBOX_DOMAIN: inboxDomain } : {}),
    },
    durable_objects: { bindings: [] },
    kv_namespaces: [],
    queues: { producers: [], consumers: [] },
    r2_buckets: [{
      binding: "FILES",
      bucket_name: variables.FUNDOSMART_R2_BUCKET_NAME,
      ...(dataJurisdiction ? { jurisdiction: dataJurisdiction } : {}),
    }],
    d1_databases: [{
      binding: "DB",
      database_name: variables.FUNDOSMART_D1_DATABASE_NAME,
      database_id: variables.FUNDOSMART_D1_DATABASE_ID,
      migrations_dir: "../../drizzle",
    }],
    vectorize: [],
    ai_search_namespaces: [],
    ai_search: [],
    agent_memory: [],
    hyperdrive: [],
    workflows: [],
    secrets_store_secrets: [],
    artifacts: [],
    services: [],
    analytics_engine_datasets: analyticsEnabled
      ? [
          { binding: "METRICS", dataset: variables.FUNDOSMART_METRICS_DATASET },
          { binding: "MAP_USAGE", dataset: variables.FUNDOSMART_MAP_USAGE_DATASET },
        ]
      : [],
    images: { binding: "IMAGES" },
    ...(aiEnabled ? { ai: { binding: "AI" } } : {}),
    unsafe_hello_world: [],
    flagship: [],
    ratelimits: [],
    worker_loaders: [],
    main: "index.js",
    jsx_factory: "React.createElement",
    jsx_fragment: "React.Fragment",
    migrations: [],
    exports: {},
    triggers: { crons: ["17 */6 * * *"] },
    rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
    build: { watch_dir: "./src" },
    no_bundle: true,
    dispatch_namespaces: [],
    logfwdr: { bindings: [] },
    assets: { binding: "ASSETS", directory: "../client" },
    observability: {
      enabled: true,
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
      traces: { enabled: true, head_sampling_rate: 0.05 },
    },
    python_modules: { exclude: ["**/*.pyc"] },
    define: {},
    cloudchamber: {},
    send_email: emailSender
      ? [{ name: "EMAIL", allowed_sender_addresses: [emailSender] }]
      : [],
    mtls_certificates: [],
    pipelines: [],
    vpc_services: [],
    vpc_networks: [],
    account_id: variables.CLOUDFLARE_ACCOUNT_ID,
    workers_dev: false,
    preview_urls: false,
    routes: [{ pattern: "community.farm.cl", custom_domain: true }],
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

test("binds the optional data jurisdiction exactly to the R2 binding", () => {
  for (const jurisdiction of ["", "eu", "fedramp"]) {
    const variables = validVariables({ FUNDOSMART_DATA_JURISDICTION: jurisdiction });
    const config = validBuiltConfig(variables);
    assert.equal(validateSelfHostingEnvironment({
      variables,
      secrets: validSecrets(),
      expectedHeadSha: releaseSha,
      gitStatus: "",
      processEnvironment: {},
    }).environment, "production");
    assert.equal(validateBuiltWorkerConfig({ config, variables, secrets: validSecrets() }), true);
    assert.equal(config.r2_buckets[0].jurisdiction, jurisdiction || undefined);
  }

  assert.throws(
    () => validateSelfHostingEnvironment({
      variables: validVariables({ FUNDOSMART_DATA_JURISDICTION: "wnam" }),
      secrets: validSecrets(),
      expectedHeadSha: releaseSha,
      gitStatus: "",
      processEnvironment: {},
    }),
    /DATA_JURISDICTION must be empty, eu or fedramp/u,
  );

  const defaultVariables = validVariables();
  const unexpectedJurisdiction = validBuiltConfig(defaultVariables);
  unexpectedJurisdiction.r2_buckets[0].jurisdiction = "eu";
  assert.throws(
    () => validateBuiltWorkerConfig({
      config: unexpectedJurisdiction,
      variables: defaultVariables,
      secrets: validSecrets(),
    }),
    /installation-owned R2 bucket/u,
  );

  const euVariables = validVariables({ FUNDOSMART_DATA_JURISDICTION: "eu" });
  const missingJurisdiction = validBuiltConfig(euVariables);
  delete missingJurisdiction.r2_buckets[0].jurisdiction;
  assert.throws(
    () => validateBuiltWorkerConfig({
      config: missingJurisdiction,
      variables: euVariables,
      secrets: validSecrets(),
    }),
    /installation-owned R2 bucket/u,
  );
});

test("rejects every extra remote binding and capability family", () => {
  const unexpectedCapabilities = [
    ["KV", (config) => config.kv_namespaces.push({ binding: "KV", id: "1".repeat(32) })],
    ["Durable Objects", (config) => config.durable_objects.bindings.push({ name: "DO", class_name: "Object" })],
    ["Queues", (config) => config.queues.producers.push({ binding: "QUEUE", queue: "queue" })],
    ["Vectorize", (config) => config.vectorize.push({ binding: "VECTOR", index_name: "index" })],
    ["AI Search", (config) => config.ai_search.push({ binding: "SEARCH", index_name: "index" })],
    ["Agent Memory", (config) => config.agent_memory.push({ binding: "MEMORY", id: "memory" })],
    ["Hyperdrive", (config) => config.hyperdrive.push({ binding: "HYPERDRIVE", id: "1".repeat(32) })],
    ["Workflows", (config) => config.workflows.push({ binding: "WORKFLOW", name: "workflow" })],
    ["Secrets Store", (config) => config.secrets_store_secrets.push({ binding: "STORE", store_id: "store", secret_name: "secret" })],
    ["Artifacts", (config) => config.artifacts.push({ binding: "ARTIFACTS" })],
    ["Services", (config) => config.services.push({ binding: "SERVICE", service: "other-worker" })],
    ["unsafe hello world", (config) => config.unsafe_hello_world.push({ binding: "UNSAFE" })],
    ["Flagship", (config) => config.flagship.push({ binding: "FLAG" })],
    ["Rate limits", (config) => config.ratelimits.push({ name: "LIMIT", namespace_id: "1" })],
    ["Worker loaders", (config) => config.worker_loaders.push({ binding: "LOADER" })],
    ["Dispatch namespaces", (config) => config.dispatch_namespaces.push({ binding: "DISPATCH", namespace: "namespace" })],
    ["Logfwdr", (config) => config.logfwdr.bindings.push({ name: "LOG", destination: "log" })],
    ["mTLS", (config) => config.mtls_certificates.push({ binding: "CERT", certificate_id: "certificate" })],
    ["Pipelines", (config) => config.pipelines.push({ binding: "PIPELINE", pipeline: "pipeline" })],
    ["VPC services", (config) => config.vpc_services.push({ binding: "VPC", service_id: "service" })],
    ["VPC networks", (config) => config.vpc_networks.push({ binding: "NETWORK", network_id: "network" })],
    ["Browser", (config) => { config.browser = { binding: "BROWSER" }; }],
    ["Version metadata", (config) => { config.version_metadata = { binding: "VERSION" }; }],
    ["unsafe metadata", (config) => { config.unsafe = { bindings: [{ name: "UNSAFE", type: "unsafe" }] }; }],
    ["Tail consumers", (config) => { config.tail_consumers = [{ service: "tail" }]; }],
    ["Streaming tail consumers", (config) => { config.streaming_tail_consumers = [{ service: "tail" }]; }],
    ["Containers", (config) => { config.containers = [{ class_name: "Container", image: "image" }]; }],
    ["Placement", (config) => { config.placement = { mode: "smart" }; }],
  ];

  for (const [label, mutate] of unexpectedCapabilities) {
    const config = validBuiltConfig();
    mutate(config);
    assert.throws(
      () => validateBuiltWorkerConfig({ config, variables: validVariables(), secrets: validSecrets() }),
      /canonical remote Vite output/u,
      label,
    );
  }
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

  const unsafeAssets = validBuiltConfig(variables);
  unsafeAssets.assets.run_worker_first = true;
  assert.throws(
    () => validateBuiltWorkerConfig({ config: unsafeAssets, variables, secrets: validSecrets() }),
    /ASSETS binding/u,
  );
});

test("optional Copernicus credentials are either omitted or a complete non-empty pair", () => {
  assert.equal(validateSelfHostingEnvironment({
    variables: validVariables(),
    secrets: validSecrets({
      CDSE_CLIENT_ID: "copernicus-client-issued-to-farm",
      CDSE_CLIENT_SECRET: "copernicus-secret-issued-to-farm",
    }),
    expectedHeadSha: releaseSha,
    gitStatus: "",
    processEnvironment: {},
  }).environment, "production");

  for (const invalidPair of [
    { CDSE_CLIENT_ID: "", CDSE_CLIENT_SECRET: "" },
    { CDSE_CLIENT_ID: "copernicus-client-issued-to-farm", CDSE_CLIENT_SECRET: "" },
    { CDSE_CLIENT_ID: "", CDSE_CLIENT_SECRET: "copernicus-secret-issued-to-farm" },
    { CDSE_CLIENT_ID: "copernicus-client-issued-to-farm" },
    { CDSE_CLIENT_SECRET: "copernicus-secret-issued-to-farm" },
  ]) {
    assert.throws(
      () => validateSelfHostingEnvironment({
        variables: validVariables(),
        secrets: validSecrets(invalidPair),
        expectedHeadSha: releaseSha,
        gitStatus: "",
        processEnvironment: {},
      }),
      /must both be omitted or both contain non-empty values/u,
    );
  }
});

test("binds explicit environment selection to both operational filenames", () => {
  assert.equal(validateSelfHostingEnvironmentSelection({
    expectedEnvironment: "production",
    variables: validVariables(),
    envFile: ".env.production.local",
    secretsFile: ".wrangler/community.production.secrets.env",
  }), "production");
  assert.throws(
    () => validateSelfHostingEnvironmentSelection({
      expectedEnvironment: "production",
      variables: validVariables(),
      envFile: ".env.staging.local",
      secretsFile: ".wrangler/community.production.secrets.env",
    }),
    /selected production environment/u,
  );
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

test("the isolated self-hosting gate receives build variables before the secrets file is read", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-self-host-gate-"));
  const envFile = path.join(directory, ".env.production.local");
  const secretsFile = path.join(directory, ".wrangler", "community.production.secrets.env");
  const builtConfig = path.join(directory, "dist", "server", "wrangler.json");
  const secrets = validSecrets();
  try {
    await Promise.all([
      mkdir(path.dirname(secretsFile), { recursive: true }),
      mkdir(path.dirname(builtConfig), { recursive: true }),
      mkdir(path.join(directory, "dist", "client"), { recursive: true }),
      mkdir(path.join(directory, "drizzle"), { recursive: true }),
    ]);
    await writeFile(
      path.join(directory, "drizzle", "0000_test.sql"),
      "CREATE TABLE test (id INTEGER PRIMARY KEY);\n",
    );
    const fixtureReleaseSha = await initializeGitFixture(directory);
    const variables = validVariables({ FUNDOSMART_RELEASE_SHA: fixtureReleaseSha });
    await Promise.all([
      writeFile(envFile, toDotEnv(variables)),
      writeFile(secretsFile, "not dotenv yet\n"),
      writeFile(builtConfig, JSON.stringify(validBuiltConfig(variables))),
      writeFile(path.join(directory, "dist", "server", "index.js"), "export default {};\n"),
      writeFile(path.join(directory, "dist", "client", "asset.txt"), "asset\n"),
    ]);
    let gateInvocation;
    const isolatedWorkspace = async () => ({ rootPath: directory, workspacePath: directory });
    const removeIsolatedWorkspace = async () => true;
    const publishFixtureDist = async () => ({
      distPath: path.join(directory, "dist"),
      ...await digestDistTree({ distPath: path.join(directory, "dist") }),
    });
    assert.equal(await runSelfHostingCheck({
      cwd: directory,
      expectedEnvironment: "production",
      envFile,
      secretsFile,
      expectedHeadSha: fixtureReleaseSha,
      gitStatus: "",
      hostEnvironment: {
        Path: process.env.Path ?? process.env.PATH,
        NODE_OPTIONS: "--import=data:text/javascript,process.exit(0)",
        google_client_secret: "must-not-reach-the-gate",
      },
      createGateWorkspace: isolatedWorkspace,
      removeGateWorkspace: removeIsolatedWorkspace,
      publishDist: publishFixtureDist,
      runGate: async (invocation) => {
        gateInvocation = invocation;
        await writeFile(secretsFile, toDotEnv(secrets));
      },
    }), true);
    assert.equal(gateInvocation.cwd, directory);
    assert.equal(gateInvocation.variables.FUNDOSMART_D1_DATABASE_ID, variables.FUNDOSMART_D1_DATABASE_ID);
    assert.equal(gateInvocation.variables.GOOGLE_CLIENT_SECRET, undefined);
    assert.equal(gateInvocation.variables.OFFLINE_SESSION_SECRET, undefined);
    await assert.rejects(
      runSelfHostingCheck({
        cwd: directory,
        expectedEnvironment: "production",
        envFile,
        secretsFile,
        expectedHeadSha: fixtureReleaseSha,
        gitStatus: "",
        hostEnvironment: {},
        createGateWorkspace: isolatedWorkspace,
        removeGateWorkspace: removeIsolatedWorkspace,
        publishDist: publishFixtureDist,
        runGate: async () => writeFile(envFile, `${toDotEnv(variables)}# changed during gate\n`),
      }),
      /environment(?: or secrets)? file changed/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("pins bootstrap Wrangler to the selected account and sanitized environment", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-pinned-wrangler-"));
  const envFile = path.join(directory, ".env.staging.local");
  const variables = validVariables({ FUNDOSMART_DEPLOY_ENVIRONMENT: "staging" });
  try {
    await writeFile(envFile, toDotEnv(variables));
    let invocation;
    const activeTooling = new WeakSet();
    await runPinnedWrangler({
      cwd: directory,
      expectedEnvironment: "staging",
      envFile,
      wranglerArguments: ["whoami"],
      hostEnvironment: {
        CLOUDFLARE_ACCOUNT_ID: "f".repeat(32),
        CLOUDFLARE_API_BASE_URL: "https://attacker.invalid/client/v4",
        CLOUDFLARE_API_TOKEN: "authentication-token-is-preserved",
        Node_Options: "--import=malicious.mjs",
      },
      expectedHeadSha: releaseSha,
      gitStatus: "",
      installTooling: async ({ cwd, releaseSha: toolingReleaseSha }) => {
        const rootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-preflight-tooling-"));
        const workspacePath = path.join(rootPath, "checkout");
        const runtimeRootPath = path.join(rootPath, "runtime");
        const tempPath = path.join(runtimeRootPath, "temp");
        await Promise.all([
          mkdir(workspacePath, { recursive: true }),
          mkdir(tempPath, { recursive: true }),
        ]);
        const tooling = Object.freeze({
          workspace: Object.freeze({
            rootPath,
            workspacePath,
            repositoryPath: cwd,
            releaseSha: toolingReleaseSha,
          }),
          runtime: Object.freeze({ rootPath: runtimeRootPath, tempPath }),
          nodeExecutable: process.execPath,
          wranglerCli: path.join(workspacePath, "pinned-wrangler.mjs"),
          releaseSha: toolingReleaseSha,
        });
        activeTooling.add(tooling);
        return tooling;
      },
      removeTooling: async (tooling) => {
        assert.equal(activeTooling.has(tooling), true);
        await rm(tooling.workspace.rootPath, { recursive: true, force: true });
        activeTooling.delete(tooling);
      },
      createToolingEnvironment: async ({ tooling, hostEnvironment, accountId }) => {
        assert.equal(activeTooling.has(tooling), true);
        return Object.freeze({
          PATH: hostEnvironment.PATH ?? hostEnvironment.Path ?? "",
          CI: "true",
          HOME: tooling.runtime.rootPath,
          TEMP: tooling.runtime.tempPath,
          TMP: tooling.runtime.tempPath,
          CLOUDFLARE_ACCOUNT_ID: accountId,
          CLOUDFLARE_API_TOKEN: hostEnvironment.CLOUDFLARE_API_TOKEN,
          WRANGLER_LOG_SANITIZE: "true",
        });
      },
      verifyTooling: async (tooling) => {
        assert.equal(activeTooling.has(tooling), true);
        return true;
      },
      runWrangler: async (details) => {
        invocation = details;
      },
    });
    assert.equal(invocation.environment.CLOUDFLARE_ACCOUNT_ID, variables.CLOUDFLARE_ACCOUNT_ID);
    assert.equal(invocation.environment.CI, "true");
    assert.equal(invocation.environment.NODE_OPTIONS, undefined);
    assert.equal(invocation.environment.CLOUDFLARE_API_BASE_URL, undefined);
    assert.equal(invocation.environment.CLOUDFLARE_API_TOKEN, "authentication-token-is-preserved");
    assert.equal(invocation.environment.WRANGLER_LOG_SANITIZE, "true");
    assert.equal(invocation.argumentsList.at(-2), "--env-file");
    assert.equal(path.basename(invocation.argumentsList.at(-1)), "deployment.env");
    assert.notEqual(invocation.argumentsList.at(-1), envFile);
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
    "--environment staging",
    "d1 migrations apply DB --remote",
    "deploy --strict",
    ".wrangler/self-hosting/staging.attestation.json",
    "npm run self-host:smoke",
    "rollback PREVIOUS_VERSION_ID",
    "d1 time-travel restore DB",
  ]) {
    assert.match(guide, new RegExp(command.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.match(guide, /CLOUDFLARE_API_TOKEN/u);
  assert.match(guide, /Edit Cloudflare Workers[\s\S]+`D1: Edit`/u);
  assert.match(guide, /api\/reference\/permissions/u);
  assert.match(guide, /no lee el perfil OAuth/u);
  assert.match(guide, /Remove-Item Env:CLOUDFLARE_API_TOKEN[\s\S]+unset CLOUDFLARE_API_TOKEN/u);
  assert.doesNotMatch(guide, /npx wrangler login/u);
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

async function initializeGitFixture(cwd) {
  await runGit(cwd, ["init", "--quiet"]);
  await runGit(cwd, ["config", "user.name", "FundoSmart tests"]);
  await runGit(cwd, ["config", "user.email", "tests@fundosmart.invalid"]);
  await runGit(cwd, ["config", "commit.gpgsign", "false"]);
  await runGit(cwd, ["add", "--", "drizzle/0000_test.sql"]);
  await runGit(cwd, ["commit", "--quiet", "-m", "fixture"]);
  return (await runGit(cwd, ["rev-parse", "HEAD"])).trim();
}

async function runGit(cwd, argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}
