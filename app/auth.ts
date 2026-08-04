import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { env } from "cloudflare:workers";
import { SESSION_COOKIE_NAMES, normalizeAuthEmail, safeRelativeReturnPath } from "./auth-core.mjs";
import {
  findSessionUser,
  findSessionUserWithLegalAcceptances,
  type AppUser,
} from "./auth-session";
import { legalAcceptanceStatusFromRows } from "@/src/modules/legal/server/legal-acceptance-repository";
import type { LegalAcceptanceStatus } from "@/src/modules/legal/legal-acceptance.mjs";

type AuthenticationEnvironment = {
  DEV_AUTH_EMAIL?: string;
  DEV_AUTH_NAME?: string;
  FUNDOSMART_DEPLOY_ENVIRONMENT?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
};

export type { AppUser } from "./auth-session";

function developmentUser(): AppUser | null {
  const authEnv = env as unknown as AuthenticationEnvironment;
  const localDevelopment = !authEnv.FUNDOSMART_DEPLOY_ENVIRONMENT
    || authEnv.FUNDOSMART_DEPLOY_ENVIRONMENT === "development";
  const googleUnconfigured = !authEnv.GOOGLE_CLIENT_ID && !authEnv.GOOGLE_CLIENT_SECRET;
  const devEmail = normalizeAuthEmail(authEnv.DEV_AUTH_EMAIL);
  if (localDevelopment && googleUnconfigured && devEmail) {
    const fullName = authEnv.DEV_AUTH_NAME?.trim() || null;
    return {
      subject: `dev:${devEmail}`,
      displayName: fullName ?? devEmail,
      email: devEmail,
      fullName,
    };
  }
  return null;
}

export async function getAppUser(): Promise<AppUser | null> {
  const cookieStore = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const rawToken = cookieStore.get(name)?.value ?? null;
    const user = await findSessionUser(env.DB, rawToken);
    if (user) return user;
  }
  return developmentUser();
}

/* Igual que `getAppUser`, pero trae la aceptación legal en el mismo viaje. La
   usan las puertas del producto, que siempre necesitan ambas cosas; el resto de
   los llamadores conserva `getAppUser` y no paga la lectura de más. */
export async function getAppUserWithLegalStatus(): Promise<
  { user: AppUser; legalStatus: LegalAcceptanceStatus } | null
> {
  const cookieStore = await cookies();
  for (const name of SESSION_COOKIE_NAMES) {
    const rawToken = cookieStore.get(name)?.value ?? null;
    const resolved = await findSessionUserWithLegalAcceptances(env.DB, rawToken);
    if (resolved) {
      return {
        user: resolved.user,
        legalStatus: legalAcceptanceStatusFromRows(resolved.user.subject, resolved.acceptances),
      };
    }
  }
  const user = developmentUser();
  /* La identidad de desarrollo está exenta, así que su veredicto no consulta. */
  return user ? { user, legalStatus: legalAcceptanceStatusFromRows(user.subject, []) } : null;
}

export async function requireAppUser(returnTo: string): Promise<AppUser> {
  const user = await getAppUser();
  if (user) return user;
  redirect(googleSignInPath(returnTo));
}

export function googleSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo, "/app");
  return `/auth/google?returnTo=${encodeURIComponent(safeReturnTo)}`;
}
