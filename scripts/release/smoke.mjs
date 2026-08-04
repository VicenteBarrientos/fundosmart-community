import { isIP } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { verifySelfHostingAttestation } from "./self-hosting-attestation.mjs";
import { readStrictDotEnvFile } from "./self-hosting-env-files.mjs";
import {
  readGitStatus,
  readHeadSha,
  validateSelfHostingEnvironmentSelection,
} from "./self-hosting-preflight.mjs";

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_ENVIRONMENTS = new Set(["staging", "production"]);
const RELEASE_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const RESERVED_HOSTNAME = /(?:^localhost$|\.localhost$|\.(?:local|test|invalid|example|workers\.dev)$)/u;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function responseText(response, label) {
  const text = await response.text();
  assert(response.ok, `${label} returned ${response.status}.`);
  return text;
}

async function smokeAttempt({ baseUrl, expectedEnvironment, expectedRelease, fetchImpl, timeoutMs }) {
  const request = (pathname, init = {}) => fetchImpl(new URL(pathname, baseUrl), {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  });

  const landing = await request("/");
  const landingHtml = await responseText(landing, "Landing page");
  assert(landingHtml.includes("FundoSmart"), "Landing page does not contain the FundoSmart marker.");

  const health = await request("/healthz");
  assert(health.status === 200, `Health endpoint returned ${health.status} instead of 200.`);
  const healthPayload = await health.json();
  assert(
    healthPayload && typeof healthPayload === "object" && !Array.isArray(healthPayload),
    "Health endpoint did not return a JSON object.",
  );
  assert(healthPayload.status === "ok", "Health endpoint did not report an operational database.");
  assert(
    healthPayload.environment === expectedEnvironment,
    `Health endpoint reported ${healthPayload.environment ?? "no environment"} instead of ${expectedEnvironment}.`,
  );
  assert(
    healthPayload.release === expectedRelease,
    `Health endpoint reported release ${healthPayload.release ?? "unknown"} instead of ${expectedRelease}.`,
  );

  const googleAuth = await request("/auth/google?returnTo=%2Fapp");
  assert(googleAuth.status === 303, `Google auth start returned ${googleAuth.status} instead of 303.`);
  const googleLocation = googleAuth.headers.get("location");
  const googleCookie = googleAuth.headers.get("set-cookie") ?? "";
  assert(googleLocation, "Google auth start did not provide a Location header.");
  const googleDestination = new URL(googleLocation, baseUrl);
  assert(
    googleDestination.origin === "https://accounts.google.com"
      && googleDestination.pathname === "/o/oauth2/v2/auth",
    "Google auth start did not reach the official authorization endpoint.",
  );
  assert(
    googleDestination.searchParams.get("redirect_uri") === `${baseUrl.origin}/auth/google/callback`,
    "Google auth start used a callback outside the release origin.",
  );
  assert(googleDestination.searchParams.get("client_id"), "Google auth start omitted its client ID.");
  assert(googleDestination.searchParams.get("scope") === "openid email", "Google auth start used an unexpected scope.");
  for (const marker of [
    "fundosmart_oauth_state=",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ]) {
    assert(googleCookie.toLowerCase().includes(marker.toLowerCase()), `Google auth cookie is missing ${marker}.`);
  }

  const anonymousApi = await request("/api/fundos");
  assert(anonymousApi.status === 401, `Anonymous API returned ${anonymousApi.status} instead of 401.`);
  const anonymousPayload = await anonymousApi.json();
  assert(!("fundos" in anonymousPayload), "Anonymous API exposed field data.");

  const demo = await request("/demo?returnTo=%2Fapp");
  assert(demo.status === 303, `Demo entry returned ${demo.status} instead of 303.`);
  const location = demo.headers.get("location");
  const setCookie = demo.headers.get("set-cookie") ?? "";
  assert(location, "Demo entry did not provide a Location header.");
  const destination = new URL(location, baseUrl);
  assert(destination.origin === baseUrl.origin && destination.pathname === "/app", "Demo redirect left the release origin or product path.");
  for (const marker of [
    "fundosmart_account_mode=demo",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ]) {
    assert(setCookie.toLowerCase().includes(marker.toLowerCase()), `Demo cookie is missing ${marker}.`);
  }
  const cookie = setCookie.split(";", 1)[0];

  const product = await request("/app", { headers: { cookie } });
  const productHtml = await responseText(product, "Demo product");
  assert(productHtml.includes("Fundo El Ejemplo"), "Demo product did not render the isolated example field.");

  const demoApi = await request("/api/fundos", { headers: { cookie } });
  assert(demoApi.status === 200, `Demo API returned ${demoApi.status} instead of 200.`);
  const demoPayload = await demoApi.json();
  assert(Array.isArray(demoPayload.fundos), "Demo API did not return the field collection.");
  assert(
    demoPayload.fundos.length === 1 && demoPayload.fundos[0]?.id === "fundo-el-ejemplo",
    "Demo API returned data outside the isolated example field.",
  );

  const demoNdvi = await request("/api/potreros/ndvi?fundoId=fundo-el-ejemplo", {
    method: "GET",
    headers: { cookie },
  });
  assert(demoNdvi.status === 200, `Demo NDVI API returned ${demoNdvi.status} instead of 200.`);
  const cacheControl = demoNdvi.headers.get("cache-control")?.toLowerCase() ?? "";
  assert(
    cacheControl.includes("private") && cacheControl.includes("no-store"),
    "Demo NDVI API did not return private, no-store cache controls.",
  );
  const demoNdviPayload = await demoNdvi.json();
  assert(
    demoNdviPayload && typeof demoNdviPayload === "object" && !Array.isArray(demoNdviPayload),
    "Demo NDVI API did not return an object.",
  );
  const ndvi = demoNdviPayload.ndvi;
  assert(ndvi && typeof ndvi === "object" && !Array.isArray(ndvi), "Demo NDVI API omitted its listing.");
  assert(ndvi.fieldId === "fundo-el-ejemplo", "Demo NDVI API returned a different field scope.");
  assert(Array.isArray(ndvi.values), "Demo NDVI API did not return the value collection.");

  return {
    landingStatus: landing.status,
    healthStatus: health.status,
    googleAuthStatus: googleAuth.status,
    anonymousApiStatus: anonymousApi.status,
    demoStatus: demo.status,
    productStatus: product.status,
    demoApiStatus: demoApi.status,
    demoNdviStatus: demoNdvi.status,
  };
}

export async function smokeRelease({
  baseUrl,
  expectedEnvironment,
  expectedRelease,
  fetchImpl = fetch,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
} = {}) {
  const normalizedBaseUrl = parseExactPublicHttpsOrigin(baseUrl, "Release smoke target");
  assert(ALLOWED_ENVIRONMENTS.has(expectedEnvironment), "Release smoke tests require the selected deployment environment.");
  assert(
    typeof expectedRelease === "string" && RELEASE_SHA.test(expectedRelease),
    "Release smoke tests require the lowercase full release SHA.",
  );
  assert(Number.isSafeInteger(attempts) && attempts > 0 && attempts <= 10, "Smoke attempts must be between 1 and 10.");
  assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Smoke timeout must be a positive safe integer.");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await smokeAttempt({
        baseUrl: normalizedBaseUrl,
        expectedEnvironment,
        expectedRelease,
        fetchImpl,
        timeoutMs,
      });
      process.stdout.write(`Smoke test passed for ${normalizedBaseUrl.origin} on attempt ${attempt}.\n`);
      return { ...result, attempts: attempt, origin: normalizedBaseUrl.origin };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(Math.min(2 ** (attempt - 1) * 1_000, 8_000));
      }
    }
  }

  throw new Error(
    `Smoke test failed after ${attempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    { cause: lastError },
  );
}

export async function loadSelfHostingSmokeConfiguration({
  cwd = process.cwd(),
  expectedEnvironment,
  envFile,
  attestationFile,
  readCurrentHeadSha = () => readHeadSha({ cwd }),
  readCurrentGitStatus = () => readGitStatus({ cwd }),
} = {}) {
  const selectedEnvironment = String(expectedEnvironment ?? "").trim().toLowerCase();
  assert(
    ALLOWED_ENVIRONMENTS.has(selectedEnvironment),
    "Self-hosting smoke requires an explicit staging or production environment selection.",
  );
  const environmentPath = path.resolve(cwd, envFile ?? `.env.${selectedEnvironment}.local`);
  const canonicalAttestationPath = path.resolve(
    cwd,
    ".wrangler",
    "self-hosting",
    `${selectedEnvironment}.attestation.json`,
  );
  if (attestationFile !== undefined
    && !sameResolvedPath(path.resolve(cwd, attestationFile), canonicalAttestationPath)) {
    throw new Error("Self-hosting smoke only accepts the canonical attestation for the selected environment.");
  }

  const loadedEnvironment = await readStrictDotEnvFile(environmentPath, {
    label: "deployment environment file",
  });
  const variables = loadedEnvironment.values;
  requireLiteralSmokeValues(loadedEnvironment.bytes, variables);
  validateSelfHostingEnvironmentSelection({
    expectedEnvironment: selectedEnvironment,
    variables,
    envFile: environmentPath,
  });

  const origins = [
    ["NEXT_PUBLIC_APP_URL", variables.NEXT_PUBLIC_APP_URL],
    ["FUNDOSMART_APP_BASE_URL", variables.FUNDOSMART_APP_BASE_URL],
    ["FUNDOSMART_BASE_URL", variables.FUNDOSMART_BASE_URL],
  ].map(([key, value]) => parseExactPublicHttpsOrigin(value, key).origin);
  if (new Set(origins).size !== 1) {
    throw new Error("The smoke target must match every deployment origin in the selected environment file.");
  }

  const attempts = parseSmokeAttempts(variables.FUNDOSMART_SMOKE_ATTEMPTS);
  const releaseSha = String(variables.FUNDOSMART_RELEASE_SHA ?? "").trim();
  assert(RELEASE_SHA.test(releaseSha), "The smoke target must declare the lowercase full release SHA.");
  const [currentHeadSha, currentGitStatus] = await Promise.all([
    readCurrentHeadSha(),
    readCurrentGitStatus(),
  ]);
  assert(
    typeof currentHeadSha === "string" && currentHeadSha.trim().toLowerCase() === releaseSha,
    "The smoke target release SHA must match the exact current Git HEAD.",
  );
  assert(
    typeof currentGitStatus === "string" && currentGitStatus.trim() === "",
    "The Git index and working tree must be clean before verifying a deployment smoke target.",
  );

  await verifySelfHostingAttestation({
    attestationPath: canonicalAttestationPath,
    releaseSha,
    environment: selectedEnvironment,
    envBytes: loadedEnvironment.bytes,
    distPath: path.resolve(cwd, "dist"),
    configRelativePath: "server/wrangler.json",
    migrationsPath: path.resolve(cwd, "drizzle"),
    gitCwd: cwd,
    migrationsRelativePath: "drizzle",
  });

  return {
    baseUrl: origins[0],
    attempts,
    expectedEnvironment: selectedEnvironment,
    expectedRelease: releaseSha,
  };
}

function parseSmokeAttempts(value) {
  if (value === undefined) return DEFAULT_ATTEMPTS;
  const raw = String(value);
  if (!/^(?:[1-9]|10)$/u.test(raw)) {
    throw new Error("FUNDOSMART_SMOKE_ATTEMPTS must be a canonical integer between 1 and 10.");
  }
  const attempts = Number(raw);
  if (!Number.isSafeInteger(attempts)) {
    throw new Error("FUNDOSMART_SMOKE_ATTEMPTS must be a safe JSON integer.");
  }
  return attempts;
}

function requireLiteralSmokeValues(bytes, variables) {
  const requiredLiteralKeys = new Set([
    "NEXT_PUBLIC_APP_URL",
    "FUNDOSMART_APP_BASE_URL",
    "FUNDOSMART_BASE_URL",
    "FUNDOSMART_DEPLOY_ENVIRONMENT",
    "FUNDOSMART_RELEASE_SHA",
    ...(Object.hasOwn(variables, "FUNDOSMART_SMOKE_ATTEMPTS") ? ["FUNDOSMART_SMOKE_ATTEMPTS"] : []),
  ]);
  const source = Buffer.from(bytes).toString("utf8");
  for (const line of source.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = line.slice(0, separator);
    if (requiredLiteralKeys.has(key) && line.slice(separator + 1) !== variables[key]) {
      throw new Error(`${key} must use one literal dotenv value without quoting, comments or parser-dependent syntax.`);
    }
  }
}

function parseExactPublicHttpsOrigin(value, label) {
  const raw = String(value ?? "").trim();
  try {
    const url = new URL(raw);
    const hostname = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || url.pathname !== "/" || url.search || url.hash
      || (raw !== url.origin && raw !== `${url.origin}/`)
      || !hostname || isIP(hostname) || RESERVED_HOSTNAME.test(hostname) || !hostname.includes(".")) {
      throw new Error("not an exact public HTTPS origin");
    }
    return new URL(url.origin);
  } catch {
    throw new Error(`${label} must be an exact public HTTPS origin with no credentials, port, path, query or fragment.`);
  }
}

function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const key = new Map([
      ["--environment", "expectedEnvironment"],
      ["--env-file", "envFile"],
    ]).get(argument);
    const value = args[index + 1];
    if (!key || !value || Object.hasOwn(options, key)) {
      throw new Error("Usage: node scripts/release/smoke.mjs --environment <staging|production> [--env-file <path>]");
    }
    options[key] = value;
    index += 1;
  }
  if (!Object.hasOwn(options, "expectedEnvironment")) {
    throw new Error("Usage: node scripts/release/smoke.mjs --environment <staging|production> [--env-file <path>]");
  }
  return options;
}

function sameResolvedPath(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  Promise.resolve()
    .then(() => loadSelfHostingSmokeConfiguration(parseArguments(process.argv.slice(2))))
    .then((configuration) => smokeRelease(configuration))
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
