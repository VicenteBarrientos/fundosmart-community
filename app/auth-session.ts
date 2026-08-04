import {
  OAUTH_STATE_COOKIE_NAMES,
  SESSION_COOKIE_NAMES,
  normalizeAuthEmail,
  randomToken,
  sha256Hex,
} from "./auth-core.mjs";
import type { GoogleIdentity } from "./google-oidc.mjs";
import type { LegalAcceptanceStatusRow } from "@/src/modules/legal/server/legal-acceptance-repository";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const OAUTH_ATTEMPT_MAX_AGE_SECONDS = 10 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,256}$/;

export type AppUser = {
  subject: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

export type OAuthAttempt = {
  nonce: string;
  codeVerifier: string;
  returnTo: string;
};

export async function findSessionUser(
  database: D1Database,
  rawToken: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<AppUser | null> {
  if (!rawToken || !TOKEN_PATTERN.test(rawToken)) return null;
  const tokenHash = await sha256Hex(rawToken);
  const row = await database.prepare(`
    SELECT
      identity.id AS subject,
      identity.email AS email,
      identity.display_name AS displayName
    FROM auth_sessions AS session
    INNER JOIN auth_identities AS identity ON identity.id = session.identity_id
    WHERE session.token_hash = ? AND session.expires_at > ?
    LIMIT 1
  `).bind(tokenHash, nowSeconds).first<{ subject: string; email: string; displayName: string }>();
  if (!row) return null;
  return {
    subject: row.subject,
    displayName: row.displayName || row.email,
    email: row.email,
    fullName: null,
  };
}

/* Toda página del producto resolvía identidad y aceptación legal en dos viajes
   encadenados: el segundo sólo podía salir cuando el primero devolvía el sujeto.
   Ambos cuelgan de la misma identidad, así que un LEFT JOIN los trae juntos.
   `token_hash` es clave primaria, de modo que la sesión sigue siendo una sola
   fila y el join únicamente repite sus columnas por aceptación registrada. */
export async function findSessionUserWithLegalAcceptances(
  database: D1Database,
  rawToken: string | null,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ user: AppUser; acceptances: LegalAcceptanceStatusRow[] } | null> {
  if (!rawToken || !TOKEN_PATTERN.test(rawToken)) return null;
  const tokenHash = await sha256Hex(rawToken);
  const rows = await database.prepare(`
    SELECT
      identity.id AS subject,
      identity.email AS email,
      identity.display_name AS displayName,
      acceptance.document_kind AS documentKind,
      acceptance.document_version AS documentVersion,
      acceptance.document_published_on AS documentPublishedOn,
      acceptance.document_content_sha256 AS documentContentSha256,
      acceptance.evidence_version AS evidenceVersion,
      acceptance.evidence_json AS evidenceJson,
      acceptance.request_id AS requestId,
      acceptance.accepted_at AS acceptedAt
    FROM auth_sessions AS session
    INNER JOIN auth_identities AS identity ON identity.id = session.identity_id
    LEFT JOIN legal_acceptances AS acceptance ON acceptance.identity_id = identity.id
    WHERE session.token_hash = ? AND session.expires_at > ?
    ORDER BY acceptance.accepted_at, acceptance.id
  `).bind(tokenHash, nowSeconds).all<
    { subject: string; email: string; displayName: string }
    & Partial<LegalAcceptanceStatusRow>
  >();
  const results = rows.results ?? [];
  const identity = results[0];
  if (!identity) return null;
  return {
    user: {
      subject: identity.subject,
      displayName: identity.displayName || identity.email,
      email: identity.email,
      fullName: null,
    },
    /* Sin aceptaciones el LEFT JOIN deja una fila con las columnas en NULL: es
       ausencia de evidencia, no una aceptación vacía. */
    acceptances: results.filter(
      (row): row is typeof row & LegalAcceptanceStatusRow => row.documentKind != null,
    ),
  };
}

export async function createAuthenticatedSession(
  database: D1Database,
  identity: GoogleIdentity,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<{ rawToken: string; expiresAt: number }> {
  const rawToken = randomToken();
  const tokenHash = await sha256Hex(rawToken);
  const expiresAt = nowSeconds + SESSION_MAX_AGE_SECONDS;
  const identityId = `${identity.provider}:${identity.providerSubject}`;
  const normalizedEmail = normalizeAuthEmail(identity.email);
  if (!normalizedEmail || normalizedEmail !== identity.normalizedEmail || identityId.length > 300) {
    throw new Error("The authenticated identity is not normalized.");
  }

  await database.batch([
    database.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").bind(nowSeconds),
    database.prepare(`
      INSERT INTO auth_identities (
        id, provider, provider_subject, email, normalized_email, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = CASE WHEN EXISTS (
          SELECT 1
          FROM account_closure_requests
          WHERE scope = 'account'
            AND target_id = excluded.id
            AND status = 'grace'
        ) THEN auth_identities.email ELSE excluded.email END,
        normalized_email = CASE WHEN EXISTS (
          SELECT 1
          FROM account_closure_requests
          WHERE scope = 'account'
            AND target_id = excluded.id
            AND status = 'grace'
        ) THEN auth_identities.normalized_email ELSE excluded.normalized_email END,
        display_name = excluded.display_name,
        updated_at = excluded.updated_at
    `).bind(
      identityId,
      identity.provider,
      identity.providerSubject,
      identity.email,
      normalizedEmail,
      identity.displayName,
      nowSeconds,
      nowSeconds,
    ),
    database.prepare(`
      INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(tokenHash, identityId, nowSeconds, expiresAt),
  ]);
  return { rawToken, expiresAt };
}

export async function revokeSessions(database: D1Database, rawTokens: readonly string[]): Promise<void> {
  const hashes = await Promise.all(
    [...new Set(rawTokens.filter((token) => TOKEN_PATTERN.test(token)))].map((token) => sha256Hex(token)),
  );
  if (hashes.length === 0) return;
  await database.batch(hashes.map((hash) =>
    database.prepare("DELETE FROM auth_sessions WHERE token_hash = ?").bind(hash)));
}

export async function storeOAuthAttempt(database: D1Database, input: {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  nowSeconds?: number;
}): Promise<void> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const stateHash = await sha256Hex(input.state);
  await database.batch([
    database.prepare("DELETE FROM auth_oauth_attempts WHERE expires_at <= ?").bind(nowSeconds),
    database.prepare(`
      INSERT INTO auth_oauth_attempts (
        state_hash, nonce, code_verifier, return_to, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      stateHash,
      input.nonce,
      input.codeVerifier,
      input.returnTo,
      nowSeconds,
      nowSeconds + OAUTH_ATTEMPT_MAX_AGE_SECONDS,
    ),
  ]);
}

export async function consumeOAuthAttempt(
  database: D1Database,
  state: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<OAuthAttempt | null> {
  const stateHash = await sha256Hex(state);
  return database.prepare(`
    DELETE FROM auth_oauth_attempts
    WHERE state_hash = ? AND expires_at > ?
    RETURNING nonce, code_verifier AS codeVerifier, return_to AS returnTo
  `).bind(stateHash, nowSeconds).first<OAuthAttempt>();
}

export function sessionCookie(rawToken: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:";
  const name = secure ? SESSION_COOKIE_NAMES[0] : SESSION_COOKIE_NAMES[1];
  return cookie(name, rawToken, SESSION_MAX_AGE_SECONDS, secure);
}

export function oauthStateCookie(state: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:";
  const name = secure ? OAUTH_STATE_COOKIE_NAMES[0] : OAUTH_STATE_COOKIE_NAMES[1];
  return cookie(name, state, OAUTH_ATTEMPT_MAX_AGE_SECONDS, secure);
}

export function clearSessionCookies(requestUrl: string): string[] {
  return SESSION_COOKIE_NAMES.map((name) => clearCookie(name, requestUrl));
}

export function clearOAuthStateCookies(requestUrl: string): string[] {
  return OAUTH_STATE_COOKIE_NAMES.map((name) => clearCookie(name, requestUrl));
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function clearCookie(name: string, requestUrl: string): string {
  const secure = name.startsWith("__Host-") || new URL(requestUrl).protocol === "https:";
  return cookie(name, "", 0, secure);
}
