import {
  createJourneyPseudonym,
  createRandomProductEventId,
} from "./product-events.mjs";

export const PRODUCT_JOURNEY_TTL_SECONDS = 24 * 60 * 60;
export const PRODUCT_JOURNEY_COOKIE_NAMES = Object.freeze([
  "__Host-fundosmart_product_journey",
  "fundosmart_product_journey",
]);

const TOKEN_VERSION = "v1";
const MAX_COOKIE_HEADER_LENGTH = 16_384;
const MAX_TOKEN_LENGTH = 1_024;
const JOURNEY_PSEUDONYM_PATTERN = /^journey:v1:[A-Za-z0-9_-]{22}$/u;
const EVENT_ID_PATTERN = /^pe_[a-f0-9]{32}$/u;
const SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const VARIANTS = new Set(["landing", "demo", "direct_product"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SIGNATURE_PURPOSE = "fundosmart-product-journey-cookie:v1";

export class ProductJourneyCookieError extends TypeError {
  constructor(code) {
    super(`Invalid product journey cookie (${code}).`);
    this.name = "ProductJourneyCookieError";
    this.code = code;
  }
}

export async function issueProductJourneyCookie({
  secret,
  requestUrl,
  variant,
  nowSeconds = Math.floor(Date.now() / 1_000),
  randomSource = globalThis.crypto,
} = {}) {
  const secure = cookieSecurity(requestUrl);
  const normalizedSecret = requireSecret(secret);
  const startedAtEpochSeconds = requireNow(nowSeconds);
  if (!VARIANTS.has(variant)) fail("variant");

  const journey = Object.freeze({
    version: "1",
    journeyPseudonym: createJourneyPseudonym(randomSource),
    signupStartedEventId: createRandomProductEventId(randomSource),
    startedAtEpochSeconds,
    variant,
  });
  const payload = encodePayload(journey);
  const signature = await signPayload(normalizedSecret, payload);
  const token = `${TOKEN_VERSION}.${payload}.${signature}`;
  if (token.length > MAX_TOKEN_LENGTH) fail("token_length");

  return {
    journey,
    setCookie: cookie(
      secure ? PRODUCT_JOURNEY_COOKIE_NAMES[0] : PRODUCT_JOURNEY_COOKIE_NAMES[1],
      token,
      PRODUCT_JOURNEY_TTL_SECONDS,
      secure,
    ),
  };
}

export async function readProductJourneyCookie({
  secret,
  cookieHeader,
  requestUrl,
  nowSeconds = Math.floor(Date.now() / 1_000),
} = {}) {
  try {
    const secure = cookieSecurity(requestUrl);
    const normalizedSecret = requireSecret(secret);
    const normalizedNow = requireNow(nowSeconds);
    const token = readCookie(
      cookieHeader,
      secure ? PRODUCT_JOURNEY_COOKIE_NAMES[0] : PRODUCT_JOURNEY_COOKIE_NAMES[1],
    );
    if (!token || token.length > MAX_TOKEN_LENGTH) return null;

    const [version, payload, signature, extra] = token.split(".");
    if (
      version !== TOKEN_VERSION
      || !payload
      || !signature
      || extra !== undefined
      || !SIGNATURE_PATTERN.test(signature)
    ) {
      return null;
    }

    const expected = await signPayload(normalizedSecret, payload);
    if (!constantTimeEqual(signature, expected)) return null;
    return parsePayload(payload, normalizedNow);
  } catch {
    return null;
  }
}

export function clearProductJourneyCookies(requestUrl) {
  cookieSecurity(requestUrl);
  return [
    cookie(PRODUCT_JOURNEY_COOKIE_NAMES[0], "", 0, true),
    cookie(PRODUCT_JOURNEY_COOKIE_NAMES[1], "", 0, false),
  ];
}

function encodePayload(journey) {
  return base64UrlEncode(
    new TextEncoder().encode(JSON.stringify([
      journey.version,
      journey.journeyPseudonym,
      journey.signupStartedEventId,
      journey.startedAtEpochSeconds,
      journey.variant,
    ])),
  );
}

function parsePayload(payload, nowSeconds) {
  const decoded = base64UrlDecode(payload);
  if (!decoded) return null;

  let values;
  try {
    values = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decoded));
  } catch {
    return null;
  }
  if (!Array.isArray(values) || values.length !== 5) return null;

  const [
    version,
    journeyPseudonym,
    signupStartedEventId,
    startedAtEpochSeconds,
    variant,
  ] = values;
  if (
    version !== "1"
    || typeof journeyPseudonym !== "string"
    || !JOURNEY_PSEUDONYM_PATTERN.test(journeyPseudonym)
    || typeof signupStartedEventId !== "string"
    || !EVENT_ID_PATTERN.test(signupStartedEventId)
    || !Number.isSafeInteger(startedAtEpochSeconds)
    || startedAtEpochSeconds <= 0
    || !VARIANTS.has(variant)
    || startedAtEpochSeconds > nowSeconds
    || nowSeconds - startedAtEpochSeconds >= PRODUCT_JOURNEY_TTL_SECONDS
  ) {
    return null;
  }

  return Object.freeze({
    version,
    journeyPseudonym,
    signupStartedEventId,
    startedAtEpochSeconds,
    variant,
  });
}

function readCookie(header, name) {
  if (
    typeof header !== "string"
    || header.length < 1
    || header.length > MAX_COOKIE_HEADER_LENGTH
  ) {
    return null;
  }
  let matched = false;
  let selected = null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    if (matched) return null;
    matched = true;
    const value = part.slice(separator + 1).trim();
    selected = value || null;
  }
  return selected;
}

function cookieSecurity(requestUrl) {
  let url;
  try {
    url = new URL(requestUrl);
  } catch {
    fail("request_url");
  }
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname)) return false;
  fail("request_url");
}

function cookie(name, value, maxAge, secure) {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function requireSecret(value) {
  if (typeof value !== "string" || new TextEncoder().encode(value).byteLength < 32) {
    fail("hmac_secret");
  }
  return value;
}

function requireNow(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail("clock");
  return value;
}

async function signPayload(secret, payload) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${SIGNATURE_PURPOSE}\u0000${payload}`),
  );
  return base64UrlEncode(new Uint8Array(signature));
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
  if (
    typeof value !== "string"
    || value.length < 1
    || value.length > MAX_TOKEN_LENGTH
    || !/^[A-Za-z0-9_-]+$/u.test(value)
    || value.length % 4 === 1
  ) {
    return null;
  }
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return base64UrlEncode(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function constantTimeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function fail(code) {
  throw new ProductJourneyCookieError(code);
}
