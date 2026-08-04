import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseEnv } from "node:util";

import {
  createSelfHostingAttestation,
  writeSelfHostingAttestation,
} from "../scripts/release/self-hosting-attestation.mjs";
import { runPinnedWrangler as runPinnedWranglerImplementation } from "../scripts/release/run-pinned-wrangler.mjs";

const versionId = "123e4567-e89b-42d3-a456-426614174000";

function runPinnedWrangler(options) {
  return runPinnedWranglerImplementation({
    ...createTestToolingDependencies(),
    ...options,
  });
}

test("post-build commands use a verified disposable config and environment snapshot", async () => {
  const fixture = await createFixture();
  let invocation;
  try {
    await runPinnedWrangler({
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      wranglerArguments: ["d1", "info", "DB"],
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      runWrangler: async (details) => {
        invocation = details;
        const configPath = optionValue(details.argumentsList, "--config");
        const environmentPath = optionValue(details.argumentsList, "--env-file");
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), fixture.config);
        assert.deepEqual(parseEnv(await readFile(environmentPath, "utf8")), fixture.variables);
        assert.notEqual(configPath, fixture.configPath);
        assert.notEqual(environmentPath, fixture.envFile);
      },
    });

    assert.deepEqual(invocation.argumentsList.slice(0, 3), ["d1", "info", "DB"]);
    await assert.rejects(lstat(optionValue(invocation.argumentsList, "--config")), { code: "ENOENT" });
    await assert.rejects(lstat(optionValue(invocation.argumentsList, "--env-file")), { code: "ENOENT" });
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("bootstrap commands use an explicit account-bound config despite hostile source and runtime ancestors", async () => {
  const fixture = await createFixture();
  const fakeOriginalCli = path.join(
    fixture.rootPath,
    "node_modules",
    "wrangler",
    "bin",
    "wrangler.js",
  );
  const hostileToml = path.join(fixture.rootPath, "wrangler.toml");
  const hostileJsonc = path.join(fixture.rootPath, "wrangler.jsonc");
  let hostileRuntimeConfig;
  let invocation;
  try {
    await mkdir(path.dirname(fakeOriginalCli), { recursive: true });
    await Promise.all([
      writeFile(fakeOriginalCli, "throw new Error('ignored checkout Wrangler executed');\n"),
      writeFile(hostileToml, `account_id = "${"f".repeat(32)}"\n`),
      writeFile(hostileJsonc, `{ "account_id": "${"e".repeat(32)}" }\n`),
    ]);
    await runPinnedWrangler({
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      wranglerArguments: ["whoami"],
      hostEnvironment: {
        CLOUDFLARE_API_TOKEN: "token",
        WRANGLER_CONFIG: hostileToml,
        CF_API_TOKEN: "legacy-token",
        CF_ACCOUNT_ID: "f".repeat(32),
        NODE_OPTIONS: "--import=attacker.mjs",
        NODE_PATH: "attacker-modules",
        npm_execpath: "attacker-npm.js",
      },
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      beforeWranglerSpawn: async ({ contextPath, invocationConfigPath, tooling }) => {
        hostileRuntimeConfig = path.join(tooling.runtime.rootPath, "wrangler.toml");
        assert.equal(isInside(tooling.runtime.rootPath, contextPath), true);
        assert.equal(isInside(contextPath, invocationConfigPath), true);
        await writeFile(hostileRuntimeConfig, `account_id = "${"d".repeat(32)}"\n`);
      },
      runWrangler: async (details) => {
        invocation = details;
        assert.notEqual(details.cwd, fixture.rootPath);
        assert.deepEqual((await readdir(details.cwd)).sort(), ["deployment-config.json", "deployment.env"]);
        assert.deepEqual(details.argumentsList.slice(0, 1), ["whoami"]);
        assert.deepEqual(details.argumentsList.slice(-2), ["--env-file", path.join(details.cwd, "deployment.env")]);
        assert.equal(details.nodeExecutable, process.execPath);
        const configPath = optionValue(details.argumentsList, "--config");
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
          account_id: fixture.variables.CLOUDFLARE_ACCOUNT_ID,
          name: fixture.variables.FUNDOSMART_WORKER_NAME,
        });
        assert.equal(isInside(details.cwd, configPath), true);
        assert.equal(
          details.argumentsList.some(
            (value) => value === hostileToml || value === hostileJsonc || value === hostileRuntimeConfig,
          ),
          false,
        );
        assert.notEqual(details.wranglerCli, fakeOriginalCli);
        assert.equal(details.wranglerCli.startsWith(details.toolingWorkspacePath), true);
        assert.equal(details.environment.CLOUDFLARE_ACCOUNT_ID, fixture.variables.CLOUDFLARE_ACCOUNT_ID);
        assert.equal(details.environment.WRANGLER_CONFIG, undefined);
        assert.equal(details.environment.CF_API_TOKEN, undefined);
        assert.equal(details.environment.CF_ACCOUNT_ID, undefined);
        assert.equal(details.environment.NODE_OPTIONS, undefined);
        assert.equal(details.environment.NODE_PATH, undefined);
        assert.equal(details.environment.npm_execpath, undefined);
      },
    });
    await assert.rejects(lstat(invocation.cwd), { code: "ENOENT" });
    await assert.rejects(lstat(path.dirname(invocation.toolingWorkspacePath)), { code: "ENOENT" });
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("D1 and R2 bootstrap commands receive the exact private account-bound config", async (t) => {
  const cases = [
    ["D1 create", (fixture) => [
      "d1",
      "create",
      fixture.variables.FUNDOSMART_D1_DATABASE_NAME,
      "--location",
      "wnam",
    ]],
    ["R2 create", (fixture) => [
      "r2",
      "bucket",
      "create",
      fixture.variables.FUNDOSMART_R2_BUCKET_NAME,
      "--location",
      "wnam",
    ]],
  ];
  for (const [label, createArguments] of cases) {
    await t.test(label, async () => {
      const fixture = await createFixture();
      try {
        await runPinnedWrangler({
          cwd: fixture.rootPath,
          expectedEnvironment: "production",
          envFile: fixture.envFile,
          confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
          wranglerArguments: createArguments(fixture),
          expectedHeadSha: fixture.releaseSha,
          gitStatus: "",
          runWrangler: async ({ argumentsList, cwd }) => {
            const configPath = optionValue(argumentsList, "--config");
            assert.equal(isInside(cwd, configPath), true);
            assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), {
              account_id: fixture.variables.CLOUDFLARE_ACCOUNT_ID,
              name: fixture.variables.FUNDOSMART_WORKER_NAME,
            });
          },
        });
      } finally {
        await rm(fixture.containerPath, { recursive: true, force: true });
      }
    });
  }
});

test("rejects a same-account staging manifest even when its artifact is freshly attested", async () => {
  const fixture = await createFixture();
  let calls = 0;
  try {
    fixture.config.topLevelName = "fundosmart-community-staging";
    fixture.config.name = "fundosmart-community-staging";
    fixture.config.d1_databases[0].database_name = "fundosmart-community-staging";
    fixture.config.r2_buckets[0].bucket_name = "fundosmart-community-staging-files";
    await writeFile(fixture.configPath, JSON.stringify(fixture.config));
    await attest(fixture);

    await assert.rejects(
      runPinnedWrangler({
        cwd: fixture.rootPath,
        expectedEnvironment: "production",
        envFile: fixture.envFile,
        wranglerArguments: ["versions", "list", "--json"],
        expectedHeadSha: fixture.releaseSha,
        gitStatus: "",
        runWrangler: async () => { calls += 1; },
      }),
      /Worker name does not match|top-level name does not match/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("deploy binds the checked secrets and complete artifact snapshot", async () => {
  const fixture = await createFixture();
  let invocation;
  try {
    await runPinnedWrangler({
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      secretsFile: fixture.secretsFile,
      confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
      wranglerArguments: ["deploy", "--strict", "--message", "release test"],
      hostEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      runWrangler: async (details) => {
        invocation = details;
        const configPath = optionValue(details.argumentsList, "--config");
        const environmentPath = optionValue(details.argumentsList, "--env-file");
        const secretsPath = optionValue(details.argumentsList, "--secrets-file");
        assert.equal(isInside(details.environment.TEMP, details.cwd), true);
        assert.equal(isInside(details.environment.TEMP, configPath), true);
        assert.equal(isInside(details.environment.TEMP, environmentPath), true);
        assert.equal(isInside(details.environment.TEMP, secretsPath), true);
        assert.equal(isInside(fixture.rootPath, secretsPath), false);
        assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), fixture.config);
        assert.deepEqual(parseEnv(await readFile(environmentPath, "utf8")), fixture.variables);
        assert.deepEqual(JSON.parse(await readFile(secretsPath, "utf8")), fixture.secrets);
        assert.equal(details.environment.CLOUDFLARE_API_TOKEN, "token");
      },
    });

    assert.deepEqual(invocation.argumentsList.slice(0, 4), ["deploy", "--strict", "--message", "release test"]);
    await assert.rejects(lstat(optionValue(invocation.argumentsList, "--config")), { code: "ENOENT" });
    await assert.rejects(lstat(optionValue(invocation.argumentsList, "--secrets-file")), { code: "ENOENT" });
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("tooling installation completes before the deploy secrets file is read", async () => {
  const fixture = await createFixture();
  const dependencies = createTestToolingDependencies();
  const baseInstallTooling = dependencies.installTooling;
  const baseCreateEnvironment = dependencies.createToolingEnvironment;
  const events = [];
  try {
    await rm(fixture.secretsFile);
    await runPinnedWranglerImplementation({
      ...dependencies,
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      secretsFile: fixture.secretsFile,
      confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
      wranglerArguments: ["deploy", "--strict", "--message", "install-before-secrets"],
      hostEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      installTooling: async (details) => {
        events.push("install");
        const tooling = await baseInstallTooling(details);
        await writeFile(fixture.secretsFile, toDotEnv(fixture.secrets));
        return tooling;
      },
      createToolingEnvironment: async (details) => {
        events.push("secrets-read");
        return baseCreateEnvironment(details);
      },
      runWrangler: async () => events.push("spawn"),
    });
    assert.deepEqual(events, ["install", "secrets-read", "spawn"]);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("parser-differential lines never reach a token-bearing Wrangler process", async () => {
  const fixture = await createFixture();
  let calls = 0;
  try {
    await writeFile(fixture.envFile, `${toDotEnv(fixture.variables)}CLOUDFLARE_API_BASE_URL: https://attacker.example/client/v4\n`);
    await assert.rejects(
      runPinnedWrangler({
        cwd: fixture.rootPath,
        expectedEnvironment: "production",
        envFile: fixture.envFile,
        wranglerArguments: ["whoami"],
        hostEnvironment: { CLOUDFLARE_API_TOKEN: "token-that-must-not-leak" },
        expectedHeadSha: fixture.releaseSha,
        gitStatus: "",
        runWrangler: async () => { calls += 1; },
      }),
      /KEY=value assignment/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("a failed deploy removes its canonical plaintext secrets snapshot", async () => {
  const fixture = await createFixture();
  let invocationSecretsPath;
  let toolingWorkspacePath;
  try {
    await assert.rejects(
      runPinnedWrangler({
        cwd: fixture.rootPath,
        expectedEnvironment: "production",
        envFile: fixture.envFile,
        secretsFile: fixture.secretsFile,
        confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
        wranglerArguments: ["deploy", "--strict", "--message", "failure cleanup test"],
        hostEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        expectedHeadSha: fixture.releaseSha,
        gitStatus: "",
        runWrangler: async ({ argumentsList, toolingWorkspacePath: invokedToolingWorkspacePath }) => {
          toolingWorkspacePath = invokedToolingWorkspacePath;
          invocationSecretsPath = optionValue(argumentsList, "--secrets-file");
          assert.deepEqual(JSON.parse(await readFile(invocationSecretsPath, "utf8")), fixture.secrets);
          throw new Error("simulated Wrangler failure");
        },
      }),
      /simulated Wrangler failure/u,
    );
    await assert.rejects(lstat(invocationSecretsPath), { code: "ENOENT" });
    await assert.rejects(lstat(path.dirname(invocationSecretsPath)), { code: "ENOENT" });
    await assert.rejects(lstat(path.dirname(toolingWorkspacePath)), { code: "ENOENT" });
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("writes and destructive operations require target-bound wrapper confirmations", async () => {
  const fixture = await createFixture();
  let calls = 0;
  try {
    const createOptions = {
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      wranglerArguments: ["d1", "create", fixture.variables.FUNDOSMART_D1_DATABASE_NAME, "--location", "wnam"],
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      runWrangler: async () => { calls += 1; },
    };
    await assert.rejects(runPinnedWrangler(createOptions), /--confirm-production/u);
    await runPinnedWrangler({
      ...createOptions,
      confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
    });

    const rollbackOptions = {
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
      wranglerArguments: ["rollback", versionId, "--message", "rollback test", "--yes"],
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      runWrangler: async () => { calls += 1; },
    };
    await assert.rejects(runPinnedWrangler(rollbackOptions), /--confirm-destructive/u);
    await runPinnedWrangler({
      ...rollbackOptions,
      confirmDestructive: `worker-version:${versionId}`,
    });
    assert.equal(calls, 2);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("migration writes use a disposable migration tree and the exact DB binding", async () => {
  const fixture = await createFixture();
  let invocationConfigPath;
  try {
    await runPinnedWrangler({
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
      wranglerArguments: ["d1", "migrations", "apply", "DB", "--remote"],
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      runWrangler: async ({ argumentsList, environment }) => {
        invocationConfigPath = optionValue(argumentsList, "--config");
        const config = JSON.parse(await readFile(invocationConfigPath, "utf8"));
        assert.notEqual(config.d1_databases[0].migrations_dir, path.join(fixture.rootPath, "drizzle"));
        assert.equal(isInside(environment.TEMP, config.d1_databases[0].migrations_dir), true);
        assert.equal((await lstat(config.d1_databases[0].migrations_dir)).isDirectory(), true);
        assert.equal(
          await readFile(path.join(config.d1_databases[0].migrations_dir, "0000_test.sql"), "utf8"),
          "SELECT 1;\n",
        );
      },
    });
    await assert.rejects(lstat(invocationConfigPath), { code: "ENOENT" });
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("database exports are limited to new files in a regular sibling backup directory", async () => {
  const fixture = await createFixture();
  const backupPath = path.join(fixture.containerPath, "fundosmart-backups", "production");
  const relativeOutput = "../fundosmart-backups/production/backup.sql";
  let calls = 0;
  try {
    await mkdir(backupPath, { recursive: true });
    const baseOptions = {
      cwd: fixture.rootPath,
      expectedEnvironment: "production",
      envFile: fixture.envFile,
      confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
      expectedHeadSha: fixture.releaseSha,
      gitStatus: "",
      runWrangler: async ({ argumentsList }) => {
        calls += 1;
        await writeFile(optionValue(argumentsList, "--output"), "-- D1 export\nSELECT 1;\n");
      },
    };
    await runPinnedWrangler({
      ...baseOptions,
      wranglerArguments: ["d1", "export", "DB", "--remote", "--output", relativeOutput],
    });
    assert.equal(await readFile(path.join(backupPath, "backup.sql"), "utf8"), "-- D1 export\nSELECT 1;\n");
    await assert.rejects(
      runPinnedWrangler({
        ...baseOptions,
        wranglerArguments: ["d1", "export", "DB", "--remote", "--output", "inside.sql"],
      }),
      /fundosmart-backups\/production/u,
    );
    await writeFile(path.join(backupPath, "existing.sql"), "existing\n");
    await assert.rejects(
      runPinnedWrangler({
        ...baseOptions,
        wranglerArguments: ["d1", "export", "DB", "--remote", "--output", "../fundosmart-backups/production/existing.sql"],
      }),
      /refuses to overwrite/u,
    );
    const racedOutputPath = path.join(backupPath, "raced.sql");
    await assert.rejects(
      runPinnedWrangler({
        ...baseOptions,
        wranglerArguments: ["d1", "export", "DB", "--remote", "--output", "../fundosmart-backups/production/raced.sql"],
        runWrangler: async ({ argumentsList }) => {
          calls += 1;
          await writeFile(optionValue(argumentsList, "--output"), "-- generated export\n");
          await writeFile(racedOutputPath, "concurrent writer wins\n", { flag: "wx" });
        },
      }),
      /refuses to overwrite/u,
    );
    assert.equal(await readFile(racedOutputPath, "utf8"), "concurrent writer wins\n");
    assert.equal(calls, 2);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("a provenance change after validation prevents the child process", async () => {
  const fixture = await createFixture();
  let headReads = 0;
  let calls = 0;
  try {
    await assert.rejects(
      runPinnedWrangler({
        cwd: fixture.rootPath,
        expectedEnvironment: "production",
        envFile: fixture.envFile,
        wranglerArguments: ["versions", "list", "--json"],
        readCurrentHeadSha: () => (++headReads === 1 ? fixture.releaseSha : "b".repeat(40)),
        readCurrentGitStatus: () => "",
        runWrangler: async () => { calls += 1; },
      }),
      /Git HEAD changed/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

test("mutating any private config, environment or secrets snapshot immediately before spawn blocks Wrangler", async (t) => {
  const mutations = [
    ["config", ({ invocationConfigPath }) => writeFile(invocationConfigPath, "{}\n")],
    ["environment", ({ invocationEnvironmentPath }) => writeFile(invocationEnvironmentPath, "CHANGED=true\n")],
    ["secrets", ({ invocationSecretsPath }) => writeFile(invocationSecretsPath, "{}\n")],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async () => {
      const fixture = await createFixture();
      let calls = 0;
      try {
        await assert.rejects(
          runPinnedWrangler({
            cwd: fixture.rootPath,
            expectedEnvironment: "production",
            envFile: fixture.envFile,
            secretsFile: fixture.secretsFile,
            confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
            wranglerArguments: ["deploy", "--strict", "--message", `mutate-${label}`],
            hostEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
            expectedHeadSha: fixture.releaseSha,
            gitStatus: "",
            beforeWranglerSpawn: mutate,
            runWrangler: async () => { calls += 1; },
          }),
          /changed before Wrangler|attestation|artifact/u,
        );
        assert.equal(calls, 0);
      } finally {
        await rm(fixture.containerPath, { recursive: true, force: true });
      }
    });
  }
});

test("replacing the private secrets parent with a byte-identical directory blocks Wrangler", async () => {
  const fixture = await createFixture();
  let calls = 0;
  try {
    await assert.rejects(
      runPinnedWrangler({
        cwd: fixture.rootPath,
        expectedEnvironment: "production",
        envFile: fixture.envFile,
        secretsFile: fixture.secretsFile,
        confirmProduction: fixture.variables.FUNDOSMART_WORKER_NAME,
        wranglerArguments: ["deploy", "--strict", "--message", "replace-secrets-parent"],
        hostEnvironment: { CLOUDFLARE_API_TOKEN: "token" },
        expectedHeadSha: fixture.releaseSha,
        gitStatus: "",
        beforeWranglerSpawn: async ({ invocationSecretsPath }) => {
          const originalBytes = await readFile(invocationSecretsPath);
          const originalParent = path.dirname(invocationSecretsPath);
          const displacedParent = `${originalParent}-displaced`;
          await rename(originalParent, displacedParent);
          await mkdir(originalParent);
          await writeFile(invocationSecretsPath, originalBytes, { flag: "wx", mode: 0o600 });
        },
        runWrangler: async () => { calls += 1; },
      }),
      /secrets snapshot parent changed identity/u,
    );
    assert.equal(calls, 0);
  } finally {
    await rm(fixture.containerPath, { recursive: true, force: true });
  }
});

async function createFixture() {
  const containerPath = await mkdtemp(path.join(tmpdir(), "fundosmart-wrapper-integration-"));
  const rootPath = path.join(containerPath, "repository");
  const envFile = path.join(rootPath, ".env.production.local");
  const secretsFile = path.join(rootPath, ".wrangler", "community.production.secrets.env");
  const distPath = path.join(rootPath, "dist");
  const configPath = path.join(distPath, "server", "wrangler.json");
  await Promise.all([
    mkdir(rootPath, { recursive: true }),
    mkdir(path.dirname(secretsFile), { recursive: true }),
    mkdir(path.dirname(configPath), { recursive: true }),
    mkdir(path.join(distPath, "client"), { recursive: true }),
    mkdir(path.join(rootPath, "drizzle"), { recursive: true }),
  ]);
  await writeFile(path.join(rootPath, "drizzle", "0000_test.sql"), "SELECT 1;\n");
  runGit(rootPath, ["init", "--initial-branch=main"]);
  runGit(rootPath, ["config", "core.autocrlf", "false"]);
  runGit(rootPath, ["add", "--", "drizzle"]);
  runGit(rootPath, [
    "-c", "user.name=FundoSmart tests",
    "-c", "user.email=tests@fundosmart.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "-m", "Fixture migrations",
  ]);
  const releaseSha = runGit(rootPath, ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const variables = validVariables(releaseSha);
  const secrets = validSecrets();
  const config = validBuiltConfig(variables);
  await Promise.all([
    writeFile(envFile, toDotEnv(variables)),
    writeFile(secretsFile, toDotEnv(secrets)),
    writeFile(configPath, JSON.stringify(config)),
    writeFile(path.join(distPath, "server", "index.js"), "export default {};\n"),
    writeFile(path.join(distPath, "client", "asset.txt"), "asset\n"),
  ]);
  const fixture = {
    containerPath,
    rootPath,
    envFile,
    secretsFile,
    distPath,
    configPath,
    variables,
    secrets,
    config,
    releaseSha,
  };
  await attest(fixture);
  return fixture;
}

async function attest(fixture) {
  const attestation = await createSelfHostingAttestation({
    releaseSha: fixture.releaseSha,
    environment: "production",
    envFile: fixture.envFile,
    secretsFile: fixture.secretsFile,
    distPath: fixture.distPath,
    migrationsPath: path.join(fixture.rootPath, "drizzle"),
    gitCwd: fixture.rootPath,
  });
  await writeSelfHostingAttestation({
    attestation,
    outputPath: path.join(fixture.rootPath, ".wrangler", "self-hosting", "production.attestation.json"),
  });
}

function validVariables(releaseSha) {
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
  };
}

function validSecrets() {
  return {
    AUTH_ORIGIN: "https://community.farm.cl",
    GOOGLE_CLIENT_ID: "123456-farm.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-client-secret-issued-for-farm",
    FUNDOSMART_OWNER_EMAIL: "owner@farm.cl",
    OFFLINE_SESSION_SECRET: "offline-session-secret-with-more-than-32-bytes",
    ASSISTANT_CONFIRMATION_SECRET: Buffer.alloc(32, 0x41).toString("base64url"),
    AI_KEYS_ENCRYPTION_SECRET: "ai-key-encryption-secret-with-more-than-32-characters",
  };
}

function validBuiltConfig(variables) {
  const dataJurisdiction = variables.FUNDOSMART_DATA_JURISDICTION?.trim();
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
    analytics_engine_datasets: [],
    images: { binding: "IMAGES" },
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
    send_email: [],
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

function createTestToolingDependencies() {
  const activeTooling = new WeakSet();
  return {
    async installTooling({ cwd, releaseSha }) {
      const rootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-wrapper-tooling-"));
      const workspacePath = path.join(rootPath, "checkout");
      const runtimeRootPath = path.join(rootPath, "runtime");
      const runtime = {
        rootPath: runtimeRootPath,
        homePath: path.join(runtimeRootPath, "home"),
        appDataPath: path.join(runtimeRootPath, "appdata"),
        localAppDataPath: path.join(runtimeRootPath, "local-appdata"),
        tempPath: path.join(runtimeRootPath, "temp"),
        cachePath: path.join(runtimeRootPath, "cache"),
        configPath: path.join(runtimeRootPath, "config"),
        dataPath: path.join(runtimeRootPath, "data"),
        npmCachePath: path.join(runtimeRootPath, "npm-cache"),
        prefixPath: path.join(runtimeRootPath, "npm-prefix"),
        logsPath: path.join(runtimeRootPath, "npm-logs"),
        userConfigPath: path.join(runtimeRootPath, "user.npmrc"),
        globalConfigPath: path.join(runtimeRootPath, "global.npmrc"),
      };
      const wranglerCli = path.join(workspacePath, "node_modules", "wrangler", "bin", "wrangler.js");
      await Promise.all([
        mkdir(path.dirname(wranglerCli), { recursive: true }),
        ...Object.entries(runtime)
          .filter(([key]) => key.endsWith("Path") && !key.endsWith("ConfigPath") && key !== "rootPath")
          .map(([, directoryPath]) => mkdir(directoryPath, { recursive: true })),
      ]);
      await Promise.all([
        writeFile(wranglerCli, "export const pinnedTestWrangler = true;\n"),
        writeFile(runtime.userConfigPath, "ignore-scripts=true\n"),
        writeFile(runtime.globalConfigPath, "\n"),
      ]);
      const tooling = Object.freeze({
        workspace: Object.freeze({
          rootPath,
          workspacePath,
          repositoryPath: cwd,
          releaseSha,
        }),
        runtime: Object.freeze(runtime),
        nodeExecutable: process.execPath,
        wranglerCli,
        releaseSha,
      });
      activeTooling.add(tooling);
      return tooling;
    },
    async removeTooling(tooling) {
      assert.equal(activeTooling.has(tooling), true);
      await rm(tooling.workspace.rootPath, { recursive: true, force: true });
      activeTooling.delete(tooling);
    },
    async createToolingEnvironment({ tooling, hostEnvironment, accountId }) {
      assert.equal(activeTooling.has(tooling), true);
      const environment = {
        PATH: [
          path.join(tooling.workspace.workspacePath, "node_modules", ".bin"),
          path.dirname(tooling.nodeExecutable),
          hostEnvironment?.PATH ?? hostEnvironment?.Path,
        ].filter(Boolean).join(path.delimiter),
        CI: "true",
        NODE: tooling.nodeExecutable,
        HOME: tooling.runtime.homePath,
        USERPROFILE: tooling.runtime.homePath,
        APPDATA: tooling.runtime.appDataPath,
        LOCALAPPDATA: tooling.runtime.localAppDataPath,
        TEMP: tooling.runtime.tempPath,
        TMP: tooling.runtime.tempPath,
        TMPDIR: tooling.runtime.tempPath,
        XDG_CACHE_HOME: tooling.runtime.cachePath,
        XDG_CONFIG_HOME: tooling.runtime.configPath,
        XDG_DATA_HOME: tooling.runtime.dataPath,
        NPM_CONFIG_CACHE: tooling.runtime.npmCachePath,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        WRANGLER_LOG_SANITIZE: "true",
      };
      for (const key of [
        "CLOUDFLARE_API_TOKEN",
        "CLOUDFLARE_API_KEY",
        "CLOUDFLARE_EMAIL",
        "CLOUDFLARE_COMPLIANCE_REGION",
      ]) {
        const entry = Object.entries(hostEnvironment ?? {}).find(
          ([candidate]) => candidate.toUpperCase() === key,
        );
        if (entry) environment[key] = entry[1];
      }
      return Object.freeze(environment);
    },
    async verifyTooling(tooling) {
      assert.equal(activeTooling.has(tooling), true);
      assert.equal((await lstat(tooling.wranglerCli)).isFile(), true);
    },
  };
}

function runGit(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding,
    stdio: options.encoding ? ["ignore", "pipe", "pipe"] : "ignore",
  });
}

function toDotEnv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function optionValue(argumentsList, option) {
  const index = argumentsList.indexOf(option);
  assert.notEqual(index, -1, `${option} is present`);
  return argumentsList[index + 1];
}

function isInside(parentPath, candidatePath) {
  const relativePath = path.relative(parentPath, candidatePath);
  return relativePath === ""
    || (!path.isAbsolute(relativePath)
      && relativePath !== ".."
      && !relativePath.startsWith(`..${path.sep}`));
}
