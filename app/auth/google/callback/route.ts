import { env } from "cloudflare:workers";
import { ACCOUNT_MODE_COOKIE, ACTIVE_ORGANIZATION_COOKIE } from "@/app/account-mode";
import { getGoogleAuthConfig } from "@/app/auth-config";
import {
  OAUTH_STATE_COOKIE_NAMES,
  readCookie,
  timingSafeEqual,
} from "@/app/auth-core.mjs";
import {
  clearOAuthStateCookies,
  consumeOAuthAttempt,
  createAuthenticatedSession,
  sessionCookie,
} from "@/app/auth-session";
import {
  exchangeGoogleAuthorizationCode,
  verifyGoogleIdToken,
} from "@/app/google-oidc.mjs";

const AUTHORIZATION_CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const cookieState = readCookie(request.headers.get("cookie"), OAUTH_STATE_COOKIE_NAMES) ?? "";

  try {
    if (!state || !cookieState || !await timingSafeEqual(state, cookieState)) {
      return authError(request, "invalid_request");
    }
    const attempt = await consumeOAuthAttempt(env.DB, state);
    if (!attempt) return authError(request, "expired");
    if (url.searchParams.has("error")) return authError(request, "denied");

    const code = url.searchParams.get("code") ?? "";
    if (!AUTHORIZATION_CODE_PATTERN.test(code)) return authError(request, "invalid_request");

    const config = getGoogleAuthConfig(request);
    const idToken = await exchangeGoogleAuthorizationCode({
      code,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      redirectUri: config.redirectUri,
      codeVerifier: attempt.codeVerifier,
    });
    const identity = await verifyGoogleIdToken(idToken, {
      clientId: config.clientId,
      nonce: attempt.nonce,
    });
    const session = await createAuthenticatedSession(env.DB, identity);

    const headers = new Headers({
      "Cache-Control": "no-store",
      Location: new URL(attempt.returnTo, config.origin).toString(),
      "Referrer-Policy": "no-referrer",
    });
    headers.append("Set-Cookie", sessionCookie(session.rawToken, request.url));
    appendCookieClears(headers, clearOAuthStateCookies(request.url));
    headers.append("Set-Cookie", clearAppCookie(ACCOUNT_MODE_COOKIE, request.url));
    headers.append("Set-Cookie", clearAppCookie(ACTIVE_ORGANIZATION_COOKIE, request.url));
    return new Response(null, { status: 303, headers });
  } catch {
    return authError(request, "failed");
  }
}

function authError(request: Request, code: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: `/auth/error?code=${encodeURIComponent(code)}`,
    "Referrer-Policy": "no-referrer",
  });
  appendCookieClears(headers, clearOAuthStateCookies(request.url));
  return new Response(null, { status: 303, headers });
}

function appendCookieClears(headers: Headers, values: readonly string[]): void {
  for (const value of values) headers.append("Set-Cookie", value);
}

function clearAppCookie(name: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}
