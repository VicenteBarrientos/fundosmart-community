import type { AccessContext } from "@/src/modules/access/domain/types";

export const OFFLINE_SESSION_AUDIENCE = "fundosmart-offline-v1";
export const OFFLINE_SESSION_TTL_SECONDS = 6 * 60 * 60;

export type OfflineSessionClaims = {
  version: 1;
  audience: typeof OFFLINE_SESSION_AUDIENCE;
  sessionId: string;
  accountMode: "personal" | "demo";
  membershipId: string;
  organizationId: string;
  userSubject: string;
  role: AccessContext["role"];
  fieldIds: string[];
  issuedAt: string;
  expiresAt: string;
};

export type IssuedOfflineSession = OfflineSessionClaims & { token: string };

export async function issueOfflineSession(input: {
  actor: AccessContext;
  accountMode: "personal" | "demo";
  secret: string;
  now?: Date;
  ttlSeconds?: number;
}): Promise<IssuedOfflineSession> {
  const secret = requireOfflineSessionSecret(input.secret);
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? OFFLINE_SESSION_TTL_SECONDS;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > OFFLINE_SESSION_TTL_SECONDS) {
    throw new TypeError("La vigencia de la sesión offline no es válida.");
  }
  const claims: OfflineSessionClaims = {
    version: 1,
    audience: OFFLINE_SESSION_AUDIENCE,
    sessionId: crypto.randomUUID(),
    accountMode: input.accountMode,
    membershipId: boundedIdentifier(input.actor.membershipId, "membresía"),
    organizationId: boundedIdentifier(input.actor.organizationId, "organización"),
    userSubject: await hmacHex(secret, `subject:${input.actor.email.trim().toLocaleLowerCase("en-US")}`),
    role: input.actor.role,
    fieldIds: [...new Set(input.actor.fieldIds.map((fieldId) => boundedIdentifier(fieldId, "fundo")))].sort(),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
  };
  if (claims.fieldIds.length === 0) throw new TypeError("La sesión offline necesita al menos un fundo autorizado.");
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signature = base64UrlEncode(await hmacBytes(secret, encoded));
  return { ...claims, token: `${encoded}.${signature}` };
}

export async function verifyOfflineSession(input: {
  token: string;
  secret: string;
  actor?: AccessContext;
  now?: Date;
}): Promise<OfflineSessionClaims | null> {
  try {
    const secret = requireOfflineSessionSecret(input.secret);
    const [encoded, signature, extra] = input.token.split(".");
    if (!encoded || !signature || extra) return null;
    const expected = base64UrlEncode(await hmacBytes(secret, encoded));
    if (!constantTimeEqual(signature, expected)) return null;
    const claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded))) as OfflineSessionClaims;
    if (!isOfflineSessionClaims(claims, input.now ?? new Date())) return null;
    if (input.actor && (
      claims.membershipId !== input.actor.membershipId
      || claims.organizationId !== input.actor.organizationId
      || claims.role !== input.actor.role
      || claims.userSubject !== await hmacHex(secret, `subject:${input.actor.email.trim().toLocaleLowerCase("en-US")}`)
      || JSON.stringify(claims.fieldIds) !== JSON.stringify([...new Set(input.actor.fieldIds)].sort())
    )) return null;
    return claims;
  } catch {
    return null;
  }
}

export function requireOfflineSessionSecret(value: string): string {
  const secret = String(value ?? "").trim();
  if (new TextEncoder().encode(secret).byteLength < 32) {
    throw new TypeError("OFFLINE_SESSION_SECRET debe contener al menos 32 bytes.");
  }
  return secret;
}

function isOfflineSessionClaims(value: OfflineSessionClaims, now: Date): boolean {
  return Boolean(
    value
    && value.version === 1
    && value.audience === OFFLINE_SESSION_AUDIENCE
    && typeof value.sessionId === "string"
    && ["personal", "demo"].includes(value.accountMode)
    && typeof value.membershipId === "string"
    && typeof value.organizationId === "string"
    && /^[a-f0-9]{64}$/u.test(value.userSubject)
    && Array.isArray(value.fieldIds)
    && value.fieldIds.length > 0
    && Number.isFinite(Date.parse(value.issuedAt))
    && Number.isFinite(Date.parse(value.expiresAt))
    && Date.parse(value.issuedAt) <= now.getTime() + 60_000
    && Date.parse(value.expiresAt) > now.getTime()
    && Date.parse(value.expiresAt) - Date.parse(value.issuedAt) <= OFFLINE_SESSION_TTL_SECONDS * 1_000
  );
}

async function hmacHex(secret: string, value: string): Promise<string> {
  return [...await hmacBytes(secret, value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacBytes(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function boundedIdentifier(value: string, label: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized || normalized.length > 160) throw new TypeError(`La ${label} offline no es válida.`);
  return normalized;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}
