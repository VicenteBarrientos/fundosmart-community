import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  createSelfHostingAttestation,
  writeSelfHostingAttestation,
} from "../scripts/release/self-hosting-attestation.mjs";
import {
  loadSelfHostingSmokeConfiguration,
  smokeRelease,
} from "../scripts/release/smoke.mjs";
import { healthResponse } from "../worker/observability.mjs";

const execFileAsync = promisify(execFile);
const baseUrl = "https://staging.farm.cl";
const expectedRelease = "a".repeat(40);

test("release smoke proves the deployed environment and full release identity", async () => {
  const result = await smokeRelease({
    baseUrl,
    expectedEnvironment: "staging",
    expectedRelease,
    attempts: 1,
    fetchImpl: fakeDeployment({ environment: "staging", release: expectedRelease }),
  });

  assert.equal(result.healthStatus, 200);
  assert.equal(result.origin, baseUrl);
});

test("release smoke distinguishes two full SHAs with the same 12-character prefix", async () => {
  const deployedRelease = `${"a".repeat(12)}${"b".repeat(28)}`;
  await assert.rejects(
    smokeRelease({
      baseUrl,
      expectedEnvironment: "staging",
      expectedRelease,
      attempts: 1,
      fetchImpl: fakeDeployment({ environment: "staging", release: deployedRelease }),
    }),
    new RegExp(`reported release ${deployedRelease} instead of ${expectedRelease}`, "u"),
  );
});

test("healthz publishes the exact full release SHA and deployment environment", async () => {
  const response = await healthResponse({
    FUNDOSMART_DEPLOY_ENVIRONMENT: "production",
    FUNDOSMART_RELEASE_SHA: "c".repeat(64),
    DB: {
      prepare: () => ({ first: async () => ({ ok: 1 }) }),
    },
  });
  assert.deepEqual(await response.json(), {
    status: "ok",
    environment: "production",
    release: "c".repeat(64),
  });
});

test("release smoke rejects non-origin targets and non-canonical numeric inputs", async () => {
  for (const invalidOrigin of [
    "http://staging.farm.cl",
    "https://staging.farm.cl:443",
    "https://staging.farm.cl:8443",
    "https://staging.farm.cl/app",
    "https://staging.farm.cl?",
    "https://staging.farm.cl?target=other",
    "https://staging.farm.cl#",
    "https://staging.farm.cl#other",
  ]) {
    await assert.rejects(
      smokeRelease({
        baseUrl: invalidOrigin,
        expectedEnvironment: "staging",
        expectedRelease,
        attempts: 1,
        fetchImpl: fakeDeployment({ environment: "staging", release: expectedRelease }),
      }),
      /exact public HTTPS origin/u,
      invalidOrigin,
    );
  }
  await assert.rejects(
    smokeRelease({
      baseUrl,
      expectedEnvironment: "staging",
      expectedRelease,
      attempts: 1.5,
      fetchImpl: fakeDeployment({ environment: "staging", release: expectedRelease }),
    }),
    /between 1 and 10/u,
  );
});

test("smoke configuration is bound to strict dotenv, clean source and the canonical attestation", async () => {
  const fixture = await createSmokeFixture();
  try {
    assert.deepEqual(await loadSelfHostingSmokeConfiguration({
      cwd: fixture.rootPath,
      expectedEnvironment: "staging",
      envFile: fixture.envPath,
    }), {
      baseUrl,
      attempts: 3,
      expectedEnvironment: "staging",
      expectedRelease: fixture.releaseSha,
    });

    const alternativeAttestation = path.join(fixture.rootPath, ".wrangler", "alternative.attestation.json");
    await copyFile(fixture.attestationPath, alternativeAttestation);
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
        attestationFile: alternativeAttestation,
      }),
      /only accepts the canonical attestation/u,
    );

    await appendFile(fixture.envPath, "# byte mutation\n");
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
      }),
      /envSha256 does not match/u,
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("smoke configuration rejects parser differentials, duplicates and permissive integers", async () => {
  const fixture = await createSmokeFixture();
  try {
    const original = await readFile(fixture.envPath, "utf8");
    await appendFile(fixture.envPath, `FUNDOSMART_RELEASE_SHA=${fixture.releaseSha}\n`);
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
      }),
      /repeats key FUNDOSMART_RELEASE_SHA/u,
    );

    await writeFile(fixture.envPath, `export NEXT_PUBLIC_APP_URL=${baseUrl}\n${original}`);
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
      }),
      /must be a KEY=value assignment/u,
    );

    await rewriteEnvironmentAndAttestation(fixture, { FUNDOSMART_SMOKE_ATTEMPTS: "3trailing" });
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
      }),
      /canonical integer between 1 and 10/u,
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("smoke configuration rejects an environment filename or origin outside the selected contract", async () => {
  const fixture = await createSmokeFixture();
  try {
    const wrongName = path.join(fixture.rootPath, ".env.production.local");
    await copyFile(fixture.envPath, wrongName);
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: wrongName,
      }),
      /selected staging environment/u,
    );

    for (const invalidOrigin of [
      "https://staging.farm.cl:443",
      "https://staging.farm.cl:8443",
      "https://staging.farm.cl/app",
      "https://staging.farm.cl?",
      "https://staging.farm.cl?target=other",
      "https://staging.farm.cl#",
      "https://staging.farm.cl#other",
    ]) {
      await rewriteEnvironmentAndAttestation(fixture, {
        NEXT_PUBLIC_APP_URL: invalidOrigin,
        FUNDOSMART_APP_BASE_URL: invalidOrigin,
        FUNDOSMART_BASE_URL: invalidOrigin,
      });
      await assert.rejects(
        loadSelfHostingSmokeConfiguration({
          cwd: fixture.rootPath,
          expectedEnvironment: "staging",
          envFile: fixture.envPath,
        }),
        /(?:exact public HTTPS origin|literal dotenv value)/u,
        invalidOrigin,
      );
    }
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("smoke configuration rejects artifact and source mutations after attestation", async () => {
  const fixture = await createSmokeFixture();
  try {
    await appendFile(path.join(fixture.distPath, "client", "asset.txt"), "changed\n");
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
      }),
      /artifactSha256 does not match/u,
    );

    await rewriteEnvironmentAndAttestation(fixture);
    await appendFile(path.join(fixture.rootPath, "source.txt"), "dirty\n");
    await assert.rejects(
      loadSelfHostingSmokeConfiguration({
        cwd: fixture.rootPath,
        expectedEnvironment: "staging",
        envFile: fixture.envPath,
      }),
      /index and working tree must be clean/u,
    );
  } finally {
    await rm(fixture.rootPath, { recursive: true, force: true });
  }
});

test("smoke CLI requires an explicit environment selection", async () => {
  const scriptPath = fileURLToPath(new URL("../scripts/release/smoke.mjs", import.meta.url));
  await assert.rejects(
    execFileAsync(process.execPath, [scriptPath], {
      encoding: "utf8",
      windowsHide: true,
    }),
    (error) => error?.code === 1 && /--environment <staging\|production>/u.test(error.stderr),
  );
});

async function createSmokeFixture() {
  const rootPath = await mkdtemp(path.join(tmpdir(), "fundosmart-smoke-fixture-"));
  const environment = "staging";
  const envPath = path.join(rootPath, `.env.${environment}.local`);
  const distPath = path.join(rootPath, "dist");
  const migrationsPath = path.join(rootPath, "drizzle");
  const attestationPath = path.join(
    rootPath,
    ".wrangler",
    "self-hosting",
    `${environment}.attestation.json`,
  );
  await Promise.all([
    mkdir(path.join(distPath, "server"), { recursive: true }),
    mkdir(path.join(distPath, "client"), { recursive: true }),
    mkdir(migrationsPath, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(rootPath, ".gitignore"), ".env*\n/.wrangler/\n/dist/\n"),
    writeFile(path.join(rootPath, "source.txt"), "reviewed source\n"),
    writeFile(path.join(migrationsPath, "0000_test.sql"), "CREATE TABLE test (id INTEGER PRIMARY KEY);\n"),
    writeFile(path.join(distPath, "server", "wrangler.json"), "{}\n"),
    writeFile(path.join(distPath, "client", "asset.txt"), "asset\n"),
  ]);
  await runGit(rootPath, ["init", "--quiet"]);
  await runGit(rootPath, ["config", "user.name", "FundoSmart tests"]);
  await runGit(rootPath, ["config", "user.email", "tests@fundosmart.invalid"]);
  await runGit(rootPath, ["config", "commit.gpgsign", "false"]);
  await runGit(rootPath, ["add", "--", ".gitignore", "source.txt", "drizzle/0000_test.sql"]);
  await runGit(rootPath, ["commit", "--quiet", "-m", "smoke fixture"]);
  const releaseSha = (await runGit(rootPath, ["rev-parse", "HEAD"])).trim();
  const fixture = {
    rootPath,
    environment,
    envPath,
    distPath,
    migrationsPath,
    attestationPath,
    releaseSha,
    variables: {
      NEXT_PUBLIC_APP_URL: baseUrl,
      FUNDOSMART_APP_BASE_URL: baseUrl,
      FUNDOSMART_BASE_URL: baseUrl,
      FUNDOSMART_DEPLOY_ENVIRONMENT: environment,
      FUNDOSMART_RELEASE_SHA: releaseSha,
      FUNDOSMART_SMOKE_ATTEMPTS: "3",
    },
  };
  await rewriteEnvironmentAndAttestation(fixture);
  return fixture;
}

async function rewriteEnvironmentAndAttestation(fixture, overrides = {}) {
  fixture.variables = { ...fixture.variables, ...overrides };
  await writeFile(fixture.envPath, toDotEnv(fixture.variables));
  const attestation = await createSelfHostingAttestation({
    releaseSha: fixture.releaseSha,
    environment: fixture.environment,
    envFile: fixture.envPath,
    secretsBytes: Buffer.from("private secrets are deliberately not needed by smoke\n"),
    distPath: fixture.distPath,
    configRelativePath: "server/wrangler.json",
    migrationsPath: fixture.migrationsPath,
    gitCwd: fixture.rootPath,
    migrationsRelativePath: "drizzle",
  });
  await writeSelfHostingAttestation({ attestation, outputPath: fixture.attestationPath });
}

async function runGit(cwd, argumentsList) {
  const { stdout } = await execFileAsync("git", argumentsList, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

function toDotEnv(values) {
  return `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")}\n`;
}

function fakeDeployment({ environment, release }) {
  return async (input, init = {}) => {
    const url = new URL(input);
    const cookie = new Headers(init.headers).get("cookie");
    if (url.pathname === "/") return new Response("<h1>FundoSmart</h1>");
    if (url.pathname === "/healthz") return Response.json({ status: "ok", environment, release });
    if (url.pathname === "/auth/google") {
      const destination = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      destination.searchParams.set("redirect_uri", `${baseUrl}/auth/google/callback`);
      destination.searchParams.set("client_id", "client.apps.googleusercontent.com");
      destination.searchParams.set("scope", "openid email");
      return new Response(null, {
        status: 303,
        headers: {
          location: destination.href,
          "set-cookie": "fundosmart_oauth_state=state; HttpOnly; Secure; SameSite=Lax",
        },
      });
    }
    if (url.pathname === "/demo") {
      return new Response(null, {
        status: 303,
        headers: {
          location: `${baseUrl}/app`,
          "set-cookie": "fundosmart_account_mode=demo; HttpOnly; Secure; SameSite=Lax",
        },
      });
    }
    if (url.pathname === "/app") return new Response("<h1>Fundo El Ejemplo</h1>");
    if (url.pathname === "/api/fundos" && !cookie) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }
    if (url.pathname === "/api/fundos") {
      return Response.json({ fundos: [{ id: "fundo-el-ejemplo" }] });
    }
    if (url.pathname === "/api/potreros/ndvi") {
      return Response.json(
        { ndvi: { fieldId: "fundo-el-ejemplo", values: [] } },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    throw new Error(`Unexpected smoke request: ${url.href}`);
  };
}
