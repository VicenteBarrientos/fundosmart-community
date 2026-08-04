import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_AUTHORIZATION_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"), {
  cooldownDuration: 30_000,
  cacheMaxAge: 3_600_000,
  timeoutDuration: 10_000,
});
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export function googleAuthorizationUrl({ clientId, redirectUri, state, nonce, codeChallenge }) {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  url.searchParams.set("include_granted_scopes", "false");
  return url.toString();
}

export async function exchangeGoogleAuthorizationCode({
  code,
  clientId,
  clientSecret,
  redirectUri,
  codeVerifier,
  fetchImpl = fetch,
}) {
  const response = await fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: codeVerifier,
    }),
  });
  if (!response.ok) throw new Error("Google rejected the authorization code exchange.");

  const payload = await response.json();
  if (!payload || typeof payload.id_token !== "string" || !payload.id_token) {
    throw new Error("Google did not return an ID token.");
  }
  return payload.id_token;
}

export async function verifyGoogleIdToken(idToken, {
  clientId,
  nonce,
  key = GOOGLE_JWKS,
  currentDate,
} = {}) {
  const { payload } = await jwtVerify(idToken, key, {
    algorithms: ["RS256"],
    audience: clientId,
    issuer: GOOGLE_ISSUERS,
    clockTolerance: 60,
    currentDate,
  });

  if (payload.nonce !== nonce) throw new Error("The Google ID token nonce does not match.");
  if (
    (Array.isArray(payload.aud) && payload.azp !== clientId)
    || (payload.azp !== undefined && payload.azp !== clientId)
  ) {
    throw new Error("The Google ID token authorized party does not match.");
  }
  if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 255) {
    throw new Error("The Google ID token has no valid subject.");
  }
  if (typeof payload.email !== "string" || !payload.email.trim() || payload.email.length > 320) {
    throw new Error("The Google ID token has no valid email.");
  }
  if (payload.email_verified !== true) throw new Error("The Google account email is not verified.");

  const email = payload.email.trim();
  return {
    provider: "google",
    providerSubject: payload.sub,
    email,
    normalizedEmail: email.toLowerCase(),
    displayName: email,
  };
}
