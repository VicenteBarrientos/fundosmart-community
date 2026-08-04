import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { generateKeyPair, SignJWT } from "jose";
import {
  normalizeAuthEmail,
  pkceChallenge,
  randomToken,
  resolveAuthOrigin,
  safeRelativeReturnPath,
  sha256Hex,
  timingSafeEqual,
} from "../app/auth-core.mjs";
import {
  exchangeGoogleAuthorizationCode,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from "../app/google-oidc.mjs";

const NOW_SECONDS = 1_800_000_000;

test("auth tokens, PKCE, and return paths use restrictive primitives", async () => {
  const state = randomToken();
  const second = randomToken();
  assert.match(state, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(state, second);
  assert.match(await sha256Hex(state), /^[a-f0-9]{64}$/);
  assert.match(await pkceChallenge(randomToken(48)), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await timingSafeEqual(state, state), true);
  assert.equal(await timingSafeEqual(state, second), false);

  assert.equal(safeRelativeReturnPath("/app/potreros?x=1", "/app"), "/app/potreros?x=1");
  for (const unsafe of ["https://evil.example/", "//evil.example/", "/auth/google", "not-relative", null]) {
    assert.equal(safeRelativeReturnPath(unsafe, "/app"), "/app");
  }
  assert.equal(normalizeAuthEmail("  PERSONA@Example.COM "), "persona@example.com");
});

test("authentication origins require explicit production configuration and fail closed elsewhere", () => {
  assert.throws(() => resolveAuthOrigin({
    requestUrl: "https://attacker.example/auth/google",
    environment: "production",
  }), /AUTH_ORIGIN is required/);
  assert.equal(resolveAuthOrigin({
    requestUrl: "https://community.example/auth/google",
    configuredOrigin: "https://community.example",
    environment: "production",
  }), "https://community.example");
  assert.equal(resolveAuthOrigin({
    requestUrl: "https://fundosmart-staging.owner.workers.dev/auth/google",
    environment: "staging",
  }), "https://fundosmart-staging.owner.workers.dev");
  assert.equal(resolveAuthOrigin({
    requestUrl: "http://localhost:3000/auth/google",
  }), "http://localhost:3000");
  assert.throws(() => resolveAuthOrigin({
    requestUrl: "https://attacker.example/auth/google",
    environment: "staging",
  }), /approved workers\.dev host/);
  assert.throws(() => resolveAuthOrigin({
    requestUrl: "http://community.example/auth/google",
    configuredOrigin: "http://community.example",
    environment: "production",
  }), /HTTPS/);
  assert.throws(() => resolveAuthOrigin({
    requestUrl: "https://community.example/auth/google",
    configuredOrigin: "https://community.example/path",
    environment: "production",
  }), /must not include/);
});

test("Google authorization requests only identity and email with state, nonce, and PKCE", () => {
  const authorization = new URL(googleAuthorizationUrl({
    clientId: "client-id.apps.googleusercontent.com",
    redirectUri: "https://community.example/auth/google/callback",
    state: "state-value",
    nonce: "nonce-value",
    codeChallenge: "challenge-value",
  }));
  assert.equal(authorization.origin, "https://accounts.google.com");
  assert.equal(authorization.searchParams.get("scope"), "openid email");
  assert.equal(authorization.searchParams.has("profile"), false);
  assert.equal(authorization.searchParams.get("state"), "state-value");
  assert.equal(authorization.searchParams.get("nonce"), "nonce-value");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(authorization.searchParams.has("access_type"), false);
});

test("the code exchange uses PKCE and returns only the ID token", async () => {
  let request;
  const idToken = await exchangeGoogleAuthorizationCode({
    code: "authorization-code",
    clientId: "google-client-id",
    clientSecret: "google-client-secret",
    redirectUri: "https://community.example/auth/google/callback",
    codeVerifier: "pkce-verifier",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return Response.json({
        access_token: "must-not-be-persisted",
        id_token: "signed-id-token",
        refresh_token: "must-not-be-persisted",
      });
    },
  });
  assert.equal(idToken, "signed-id-token");
  assert.equal(request.url, "https://oauth2.googleapis.com/token");
  const body = request.options.body;
  assert.equal(body.get("code_verifier"), "pkce-verifier");
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("redirect_uri"), "https://community.example/auth/google/callback");
});

test("Google ID tokens require the exact issuer, audience, nonce, subject, and verified email", async () => {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const currentDate = new Date(NOW_SECONDS * 1000);
  const valid = await signGoogleToken(privateKey);
  assert.deepEqual(await verifyGoogleIdToken(valid, {
    clientId: "fundosmart-client",
    nonce: "expected-nonce",
    key: publicKey,
    currentDate,
  }), {
    provider: "google",
    providerSubject: "google-subject-123",
    email: "Person@Example.com",
    normalizedEmail: "person@example.com",
    displayName: "Person@Example.com",
  });

  const invalidTokens = [
    await signGoogleToken(privateKey, { audience: "another-client" }),
    await signGoogleToken(privateKey, { issuer: "https://attacker.example" }),
    await signGoogleToken(privateKey, { nonce: "wrong-nonce" }),
    await signGoogleToken(privateKey, { emailVerified: false }),
    await signGoogleToken(privateKey, { authorizedParty: "another-client" }),
  ];
  for (const token of invalidTokens) {
    await assert.rejects(verifyGoogleIdToken(token, {
      clientId: "fundosmart-client",
      nonce: "expected-nonce",
      key: publicKey,
      currentDate,
    }));
  }
});

test("the auth migration stores only hashed session/state keys and enforces expiry", async () => {
  const migration = await readFile(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
  assert.match(migration, /CREATE TABLE `auth_identities`/);
  assert.match(migration, /CREATE TABLE `auth_sessions`/);
  assert.match(migration, /CREATE TABLE `auth_oauth_attempts`/);
  assert.match(migration, /`token_hash` text PRIMARY KEY/);
  assert.match(migration, /`state_hash` text PRIMARY KEY/);
  assert.doesNotMatch(migration, /access_token|refresh_token/);

  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(migration.replaceAll("--> statement-breakpoint", ""));
  database.prepare(`
    INSERT INTO auth_identities
      (id, provider, provider_subject, email, normalized_email, display_name, created_at, updated_at)
    VALUES (?, 'google', ?, ?, ?, ?, 100, 100)
  `).run("google:subject", "subject", "person@example.com", "person@example.com", "person@example.com");
  database.prepare(`
    INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at)
    VALUES (?, ?, 100, 200)
  `).run("a".repeat(64), "google:subject");
  assert.throws(() => database.prepare(`
    INSERT INTO auth_identities
      (id, provider, provider_subject, email, normalized_email, display_name, created_at, updated_at)
    VALUES (?, 'google', ?, ?, ?, ?, 100, 100)
  `).run(
    "google:replacement-subject",
    "replacement-subject",
    "person@example.com",
    "person@example.com",
    "person@example.com",
  ), /UNIQUE constraint failed: auth_identities\.normalized_email/);
  assert.throws(() => database.prepare(`
    INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at)
    VALUES (?, ?, 200, 100)
  `).run("b".repeat(64), "google:subject"), /auth_sessions_expiry_check/);
  database.prepare("DELETE FROM auth_identities WHERE id = ?").run("google:subject");
  assert.equal(database.prepare("SELECT count(*) AS count FROM auth_sessions").get().count, 0);
  database.close();
});

async function signGoogleToken(privateKey, {
  authorizedParty,
  audience = "fundosmart-client",
  emailVerified = true,
  issuer = "https://accounts.google.com",
  nonce = "expected-nonce",
} = {}) {
  return new SignJWT({
    email: "Person@Example.com",
    email_verified: emailVerified,
    nonce,
    ...(authorizedParty ? { azp: authorizedParty } : {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject("google-subject-123")
    .setIssuedAt(NOW_SECONDS)
    .setExpirationTime(NOW_SECONDS + 3600)
    .sign(privateKey);
}
