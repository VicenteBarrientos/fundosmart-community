import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PRODUCT_JOURNEY_COOKIE_NAMES,
  PRODUCT_JOURNEY_TTL_SECONDS,
  ProductJourneyCookieError,
  clearProductJourneyCookies,
  issueProductJourneyCookie,
  readProductJourneyCookie,
} from "../src/core/telemetry/product-journey-cookie.mjs";

const root = new URL("../", import.meta.url);
const runtimeUrl = new URL("src/core/telemetry/product-journey-cookie.mjs", root);
const secret = "product-journey-cookie-secret-v1-000000000000";
const alternateSecret = "product-journey-cookie-secret-v1-111111111111";
const nowSeconds = 1_785_283_200;
const secureUrl = "https://fundosmart.com/auth/google";
const localUrl = "http://localhost:3000/auth/google";
const signaturePurpose = "fundosmart-product-journey-cookie:v1";

function deterministicRandomSource(seed = 0) {
  let invocation = 0;
  return {
    getRandomValues(bytes) {
      const offset = seed + invocation * bytes.length;
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = (offset + index) % 256;
      }
      invocation += 1;
      return bytes;
    },
  };
}

function cookieValue(setCookie) {
  return setCookie.slice(setCookie.indexOf("=") + 1, setCookie.indexOf(";"));
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function base64UrlDecode(value) {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signToken(tokenSecret, values) {
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(values)));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(tokenSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${signaturePurpose}\u0000${payload}`),
  );
  return `v1.${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

function header(name, token) {
  return `unrelated=kept; ${name}=${token}; another=value`;
}

test("the secure codec preserves the original signup attempt for 24 hours", async () => {
  const issued = await issueProductJourneyCookie({
    secret,
    requestUrl: secureUrl,
    variant: "landing",
    nowSeconds,
    randomSource: deterministicRandomSource(),
  });
  const token = cookieValue(issued.setCookie);
  const [, encodedPayload, signature] = token.split(".");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));

  assert.equal(PRODUCT_JOURNEY_TTL_SECONDS, 86_400);
  assert.deepEqual(issued.journey, {
    version: "1",
    journeyPseudonym: "journey:v1:AAECAwQFBgcICQoLDA0ODw",
    signupStartedEventId: "pe_101112131415161718191a1b1c1d1e1f",
    startedAtEpochSeconds: nowSeconds,
    variant: "landing",
  });
  assert.deepEqual(payload, [
    "1",
    issued.journey.journeyPseudonym,
    issued.journey.signupStartedEventId,
    nowSeconds,
    "landing",
  ]);
  assert.match(signature, /^[A-Za-z0-9_-]{43}$/u);
  assert.ok(issued.setCookie.length < 4_096);
  assert.match(
    issued.setCookie,
    /^__Host-fundosmart_product_journey=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax; Secure$/u,
  );
  assert.doesNotMatch(issued.setCookie, /Domain=/u);

  const read = await readProductJourneyCookie({
    secret,
    cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], token),
    requestUrl: secureUrl,
    nowSeconds,
  });
  assert.deepEqual(read, issued.journey);
  assert.deepEqual(
    await readProductJourneyCookie({
      secret,
      cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], token),
      requestUrl: secureUrl,
      nowSeconds: nowSeconds + PRODUCT_JOURNEY_TTL_SECONDS - 1,
    }),
    issued.journey,
  );
  assert.equal(
    await readProductJourneyCookie({
      secret,
      cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], token),
      requestUrl: secureUrl,
      nowSeconds: nowSeconds + PRODUCT_JOURNEY_TTL_SECONDS,
    }),
    null,
  );

  const serialized = JSON.stringify({ payload, setCookie: issued.setCookie });
  for (const forbidden of [
    "@",
    "example.com",
    "organization-",
    "field-",
    "returnTo",
    "referrer",
    "https://",
    secret,
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden, "iu"));
  }
});

test("local and secure cookie names cannot shadow each other", async () => {
  const secure = await issueProductJourneyCookie({
    secret,
    requestUrl: secureUrl,
    variant: "direct_product",
    nowSeconds,
    randomSource: deterministicRandomSource(32),
  });
  const local = await issueProductJourneyCookie({
    secret,
    requestUrl: localUrl,
    variant: "demo",
    nowSeconds,
    randomSource: deterministicRandomSource(96),
  });
  const secureToken = cookieValue(secure.setCookie);
  const localToken = cookieValue(local.setCookie);

  assert.match(
    local.setCookie,
    /^fundosmart_product_journey=v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=86400; HttpOnly; SameSite=Lax$/u,
  );
  assert.doesNotMatch(local.setCookie, /; Secure/u);

  assert.equal(
    await readProductJourneyCookie({
      secret,
      cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[1], localToken),
      requestUrl: secureUrl,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    await readProductJourneyCookie({
      secret,
      cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], secureToken),
      requestUrl: localUrl,
      nowSeconds,
    }),
    null,
  );

  const both = `${PRODUCT_JOURNEY_COOKIE_NAMES[1]}=${localToken}; ${PRODUCT_JOURNEY_COOKIE_NAMES[0]}=${secureToken}`;
  assert.deepEqual(
    await readProductJourneyCookie({
      secret,
      cookieHeader: both,
      requestUrl: secureUrl,
      nowSeconds,
    }),
    secure.journey,
  );
  assert.deepEqual(
    await readProductJourneyCookie({
      secret,
      cookieHeader: both,
      requestUrl: localUrl,
      nowSeconds,
    }),
    local.journey,
  );
});

test("tampering, alternate secrets and malformed tokens are silent no-ops", async () => {
  const issued = await issueProductJourneyCookie({
    secret,
    requestUrl: secureUrl,
    variant: "landing",
    nowSeconds,
    randomSource: deterministicRandomSource(),
  });
  const token = cookieValue(issued.setCookie);
  const [version, payload, signature] = token.split(".");
  const tamperedPayload = `${payload.slice(0, -1)}${payload.endsWith("A") ? "B" : "A"}`;
  const tamperedSignature = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
  const invalidTokens = [
    `${version}.${tamperedPayload}.${signature}`,
    `${version}.${payload}.${tamperedSignature}`,
    `v2.${payload}.${signature}`,
    `${version}.${payload}.${signature}.extra`,
    "v1.not+base64.signature",
    "v1..",
    "not-a-token",
  ];

  for (const invalidToken of invalidTokens) {
    assert.equal(
      await readProductJourneyCookie({
        secret,
        cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], invalidToken),
        requestUrl: secureUrl,
        nowSeconds,
      }),
      null,
    );
  }
  assert.equal(
    await readProductJourneyCookie({
      secret: alternateSecret,
      cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], token),
      requestUrl: secureUrl,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    await readProductJourneyCookie({
      secret: "short",
      cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], token),
      requestUrl: secureUrl,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    await readProductJourneyCookie({
      secret,
      cookieHeader: `${PRODUCT_JOURNEY_COOKIE_NAMES[0]}=${token}; ${PRODUCT_JOURNEY_COOKIE_NAMES[0]}=${token}`,
      requestUrl: secureUrl,
      nowSeconds,
    }),
    null,
  );
  assert.equal(
    await readProductJourneyCookie({
      secret,
      cookieHeader: "x".repeat(16_385),
      requestUrl: secureUrl,
      nowSeconds,
    }),
    null,
  );
});

test("even correctly signed free text, PII, future clocks and extra fields are rejected", async () => {
  const validPseudonym = "journey:v1:AAECAwQFBgcICQoLDA0ODw";
  const validEventId = "pe_101112131415161718191a1b1c1d1e1f";
  const invalidPayloads = [
    ["1", validPseudonym, validEventId, nowSeconds, "free_text"],
    ["1", "private@example.com", validEventId, nowSeconds, "landing"],
    ["1", validPseudonym, "real-user-id", nowSeconds, "landing"],
    ["1", validPseudonym, validEventId, nowSeconds + 1, "landing"],
    ["1", validPseudonym, validEventId, nowSeconds - PRODUCT_JOURNEY_TTL_SECONDS, "landing"],
    ["1", validPseudonym, validEventId, nowSeconds, "landing", "private@example.com"],
    ["2", validPseudonym, validEventId, nowSeconds, "landing"],
    ["1", validPseudonym, validEventId, nowSeconds + 0.5, "landing"],
    {
      version: "1",
      journeyPseudonym: validPseudonym,
      signupStartedEventId: validEventId,
      startedAtEpochSeconds: nowSeconds,
      variant: "landing",
    },
  ];

  for (const values of invalidPayloads) {
    const token = await signToken(secret, values);
    assert.equal(
      await readProductJourneyCookie({
        secret,
        cookieHeader: header(PRODUCT_JOURNEY_COOKIE_NAMES[0], token),
        requestUrl: secureUrl,
        nowSeconds,
      }),
      null,
    );
  }
});

test("issuer validation fails closed while the reader stays fail-soft", async () => {
  await assert.rejects(
    issueProductJourneyCookie({
      secret: "short",
      requestUrl: secureUrl,
      variant: "landing",
      nowSeconds,
    }),
    (error) => error instanceof ProductJourneyCookieError && error.code === "hmac_secret",
  );
  await assert.rejects(
    issueProductJourneyCookie({
      secret,
      requestUrl: secureUrl,
      variant: "private@example.com",
      nowSeconds,
    }),
    (error) => error instanceof ProductJourneyCookieError && error.code === "variant",
  );
  await assert.rejects(
    issueProductJourneyCookie({
      secret,
      requestUrl: "http://attacker.example/auth/google",
      variant: "landing",
      nowSeconds,
    }),
    (error) => error instanceof ProductJourneyCookieError && error.code === "request_url",
  );
  await assert.rejects(
    issueProductJourneyCookie({
      secret,
      requestUrl: secureUrl,
      variant: "landing",
      nowSeconds: 0,
    }),
    (error) => error instanceof ProductJourneyCookieError && error.code === "clock",
  );

  assert.equal(
    await readProductJourneyCookie({
      secret,
      cookieHeader: "anything=value",
      requestUrl: "http://attacker.example",
      nowSeconds,
    }),
    null,
  );
});

test("clear helpers expire both names without weakening the host cookie", () => {
  assert.deepEqual(clearProductJourneyCookies(secureUrl), [
    "__Host-fundosmart_product_journey=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    "fundosmart_product_journey=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
  ]);
  assert.deepEqual(clearProductJourneyCookies(localUrl), [
    "__Host-fundosmart_product_journey=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax; Secure",
    "fundosmart_product_journey=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
  ]);
  assert.throws(
    () => clearProductJourneyCookies("http://attacker.example"),
    (error) => error instanceof ProductJourneyCookieError && error.code === "request_url",
  );
});

test("FS03-B remains dark and is not an authentication or authorization primitive", async () => {
  const [runtime, googleStart, googleCallback, accessRepository] = await Promise.all([
    readFile(runtimeUrl, "utf8"),
    readFile(new URL("app/auth/google/route.ts", root), "utf8"),
    readFile(new URL("app/auth/google/callback/route.ts", root), "utf8"),
    readFile(new URL("src/modules/access/server/access-repository.ts", root), "utf8"),
  ]);

  assert.doesNotMatch(runtime, /cloudflare:workers|PRODUCT_EVENTS|FUNDOSMART_|\benv\.|\bDB\b/u);
  assert.doesNotMatch(runtime, /console\.|logger|email|organizationId|returnTo|referrer/iu);
  assert.match(runtime, /difference \|= left\.charCodeAt\(index\) \^ right\.charCodeAt\(index\)/u);
  for (const callsite of [googleStart, googleCallback, accessRepository]) {
    assert.doesNotMatch(callsite, /product-journey-cookie/u);
  }
});
