import { env } from "cloudflare:workers";
import { getGoogleAuthConfig } from "@/app/auth-config";
import { pkceChallenge, randomToken, safeRelativeReturnPath } from "@/app/auth-core.mjs";
import { oauthStateCookie, storeOAuthAttempt } from "@/app/auth-session";
import { googleAuthorizationUrl } from "@/app/google-oidc.mjs";

export async function GET(request: Request) {
  try {
    const config = getGoogleAuthConfig(request);
    const url = new URL(request.url);
    const returnTo = safeRelativeReturnPath(url.searchParams.get("returnTo"), "/app");
    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    const codeChallenge = await pkceChallenge(codeVerifier);

    await storeOAuthAttempt(env.DB, { state, nonce, codeVerifier, returnTo });
    const location = googleAuthorizationUrl({
      clientId: config.clientId,
      redirectUri: config.redirectUri,
      state,
      nonce,
      codeChallenge,
    });

    return new Response(null, {
      status: 303,
      headers: {
        "Cache-Control": "no-store",
        Location: location,
        "Referrer-Policy": "no-referrer",
        "Set-Cookie": oauthStateCookie(state, request.url),
      },
    });
  } catch {
    return authError("unavailable");
  }
}

function authError(code: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      Location: `/auth/error?code=${encodeURIComponent(code)}`,
    },
  });
}
