import { env } from "cloudflare:workers";
import { resolveAuthOrigin } from "./auth-core.mjs";

type AuthEnvironment = {
  AUTH_ORIGIN?: string;
  FUNDOSMART_DEPLOY_ENVIRONMENT?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export type GoogleAuthConfig = {
  clientId: string;
  clientSecret: string;
  origin: string;
  redirectUri: string;
};

export function getGoogleAuthConfig(request: Request): GoogleAuthConfig {
  const authEnv = env as unknown as AuthEnvironment;
  const clientId = authEnv.GOOGLE_CLIENT_ID?.trim() ?? "";
  const clientSecret = authEnv.GOOGLE_CLIENT_SECRET?.trim() ?? "";
  if (!clientId || !clientSecret) throw new Error("Google authentication is not configured.");

  const origin = resolveAuthOrigin({
    requestUrl: request.url,
    configuredOrigin: authEnv.AUTH_ORIGIN,
    environment: authEnv.FUNDOSMART_DEPLOY_ENVIRONMENT,
  });
  return {
    clientId,
    clientSecret,
    origin,
    redirectUri: `${origin}/auth/google/callback`,
  };
}
