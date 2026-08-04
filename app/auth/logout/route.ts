import { env } from "cloudflare:workers";
import { ACCOUNT_MODE_COOKIE, ACTIVE_ORGANIZATION_COOKIE } from "@/app/account-mode";
import { SESSION_COOKIE_NAMES, readCookie } from "@/app/auth-core.mjs";
import {
  clearOAuthStateCookies,
  clearSessionCookies,
  revokeSessions,
} from "@/app/auth-session";

export async function POST(request: Request) {
  if (!isSameOriginPost(request)) {
    return Response.json({ error: "No aceptamos esta solicitud para salir." }, { status: 403 });
  }

  const cookieHeader = request.headers.get("cookie");
  const sessionTokens = SESSION_COOKIE_NAMES.flatMap((name) => {
    const token = readCookie(cookieHeader, [name]);
    return token ? [token] : [];
  });
  await revokeSessions(env.DB, sessionTokens);

  const headers = new Headers({
    "Cache-Control": "no-store",
    Location: "/",
  });
  for (const value of [...clearSessionCookies(request.url), ...clearOAuthStateCookies(request.url)]) {
    headers.append("Set-Cookie", value);
  }
  headers.append("Set-Cookie", clearAppCookie(ACCOUNT_MODE_COOKIE, request.url));
  headers.append("Set-Cookie", clearAppCookie(ACTIVE_ORGANIZATION_COOKIE, request.url));
  return new Response(null, { status: 303, headers });
}

function isSameOriginPost(request: Request): boolean {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === requestOrigin;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

function clearAppCookie(name: string, requestUrl: string): string {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`;
}
