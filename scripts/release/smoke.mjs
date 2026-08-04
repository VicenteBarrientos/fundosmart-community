import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function responseText(response, label) {
  const text = await response.text();
  assert(response.ok, `${label} returned ${response.status}.`);
  return text;
}

async function smokeAttempt({ baseUrl, fetchImpl, timeoutMs }) {
  const request = (pathname, init = {}) => fetchImpl(new URL(pathname, baseUrl), {
    redirect: "manual",
    signal: AbortSignal.timeout(timeoutMs),
    ...init,
  });

  const landing = await request("/");
  const landingHtml = await responseText(landing, "Landing page");
  assert(landingHtml.includes("FundoSmart"), "Landing page does not contain the FundoSmart marker.");

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
  fetchImpl = fetch,
  attempts = DEFAULT_ATTEMPTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = (milliseconds) => new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds)),
} = {}) {
  const normalizedBaseUrl = new URL(String(baseUrl ?? ""));
  assert(normalizedBaseUrl.protocol === "https:", "Release smoke tests require an HTTPS base URL.");
  assert(Number.isInteger(attempts) && attempts > 0 && attempts <= 10, "Smoke attempts must be between 1 and 10.");

  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const result = await smokeAttempt({ baseUrl: normalizedBaseUrl, fetchImpl, timeoutMs });
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

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const attempts = Number.parseInt(process.env.FUNDOSMART_SMOKE_ATTEMPTS ?? String(DEFAULT_ATTEMPTS), 10);
  smokeRelease({ baseUrl: process.env.FUNDOSMART_BASE_URL, attempts }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
