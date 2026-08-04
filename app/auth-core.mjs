const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const RESERVED_AUTH_PREFIX = "/auth";

export const SESSION_COOKIE_NAMES = Object.freeze([
  "__Host-fundosmart_session",
  "fundosmart_session",
]);

export const OAUTH_STATE_COOKIE_NAMES = Object.freeze([
  "__Host-fundosmart_oauth_state",
  "fundosmart_oauth_state",
]);

export function randomToken(byteLength = 32) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 128) {
    throw new TypeError("Token length is outside the supported range.");
  }
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

export function readCookie(cookieHeader, names) {
  if (!cookieHeader) return null;
  const acceptedNames = new Set(names);
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!acceptedNames.has(name)) continue;
    const value = part.slice(separator + 1).trim();
    if (value) return value;
  }
  return null;
}

export async function timingSafeEqual(left, right) {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

export function normalizeAuthEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function safeRelativeReturnPath(value, fallback = "/") {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) return fallback;

  let url;
  try {
    url = new URL(value, "https://fundosmart.local");
  } catch {
    return fallback;
  }
  if (url.origin !== "https://fundosmart.local") return fallback;
  if (url.pathname === RESERVED_AUTH_PREFIX || url.pathname.startsWith(`${RESERVED_AUTH_PREFIX}/`)) {
    return fallback;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function resolveAuthOrigin({ requestUrl, configuredOrigin, environment }) {
  const configured = typeof configuredOrigin === "string" ? configuredOrigin.trim() : "";
  if (configured) return validateConfiguredOrigin(configured, environment);
  if (environment === "production") {
    throw new Error("AUTH_ORIGIN is required in production.");
  }

  const requestOrigin = new URL(requestUrl);
  if (environment === "staging") {
    if (requestOrigin.protocol !== "https:" || !requestOrigin.hostname.endsWith(".workers.dev")) {
      throw new Error("The staging authentication origin is not an approved workers.dev host.");
    }
    return requestOrigin.origin;
  }
  if (!LOCAL_HOSTS.has(requestOrigin.hostname) || !new Set(["http:", "https:"]).has(requestOrigin.protocol)) {
    throw new Error("Local authentication is only available on a loopback host.");
  }
  return requestOrigin.origin;
}

function validateConfiguredOrigin(value, environment) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("AUTH_ORIGIN must be an absolute URL origin.");
  }
  if (url.origin !== value.replace(/\/$/, "") || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("AUTH_ORIGIN must not include a path, query, or fragment.");
  }
  if (url.protocol !== "https:" && !(environment !== "production" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error("AUTH_ORIGIN must use HTTPS outside local development.");
  }
  return url.origin;
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
