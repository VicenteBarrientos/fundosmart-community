import { safeProductReturnPath } from "@/app/account-mode";
import { getAppUser, type AppUser } from "@/app/auth";
import { normalizeAuthEmail } from "@/app/auth-core.mjs";
import {
  getLegalAcceptanceStatus,
} from "@/src/modules/legal/server/legal-acceptance-repository";
import type { LegalAcceptanceStatus } from "@/src/modules/legal/legal-acceptance.mjs";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";

export const LEGAL_ACCEPTANCE_PATH = "/app/cuenta/legal";

export function safeLegalReturnPath(value: string | null | undefined): string {
  const safe = safeProductReturnPath(value ?? null);
  const parsed = new URL(safe, "https://fundosmart.local");
  return parsed.pathname === LEGAL_ACCEPTANCE_PATH
      || parsed.pathname.startsWith(`${LEGAL_ACCEPTANCE_PATH}/`)
    ? "/app"
    : safe;
}

export function legalAcceptancePath(returnTo: string): string {
  const safeReturnTo = safeLegalReturnPath(returnTo);
  return `${LEGAL_ACCEPTANCE_PATH}?returnTo=${encodeURIComponent(safeReturnTo)}`;
}

/* `resolved` es el veredicto que la lectura de sesión ya trajo para esta misma
   identidad. Cuando falta —o cuando la identidad efectiva no es la de la sesión—
   se consulta como antes. */
export async function requirePageLegalAcceptance(
  user: AppUser,
  returnTo: string,
  resolved?: LegalAcceptanceStatus | null,
): Promise<void> {
  const status = resolved ?? await getLegalAcceptanceStatus(env.DB, user.subject);
  if (!status.complete) redirect(legalAcceptancePath(returnTo));
}

export async function authorizeApiLegalAcceptance(
  user: AppUser,
  resolved?: LegalAcceptanceStatus | null,
): Promise<Response | null> {
  const status = resolved ?? await getLegalAcceptanceStatus(env.DB, user.subject);
  if (status.complete) return null;
  return legalAcceptanceRequiredResponse();
}

export async function reauthorizeLegalIdentity(
  expected: Pick<AppUser, "subject" | "email">,
  options: { requireCurrentAcceptance?: boolean } = {},
): Promise<
  | Readonly<{ ok: true; user: AppUser }>
  | Readonly<{ ok: false; code: "IDENTITY_CHANGED" | "LEGAL_ACCEPTANCE_REQUIRED" }>
> {
  const requireCurrentAcceptance = options.requireCurrentAcceptance ?? true;
  if (requireCurrentAcceptance) {
    const status = await getLegalAcceptanceStatus(env.DB, expected.subject);
    if (!status.complete) {
      return Object.freeze({ ok: false, code: "LEGAL_ACCEPTANCE_REQUIRED" });
    }
  }
  const current = await getAppUser();
  if (
    !current
    || current.subject !== expected.subject
    || normalizeAuthEmail(current.email) !== normalizeAuthEmail(expected.email)
  ) {
    return Object.freeze({ ok: false, code: "IDENTITY_CHANGED" });
  }
  return Object.freeze({ ok: true, user: current });
}

export async function reauthorizeLegalPage(
  expected: Pick<AppUser, "subject" | "email">,
  returnTo: string,
  options: { requireCurrentAcceptance?: boolean } = {},
): Promise<AppUser> {
  const result = await reauthorizeLegalIdentity(expected, options);
  if (!result.ok) {
    if (result.code === "LEGAL_ACCEPTANCE_REQUIRED") {
      redirect(legalAcceptancePath(returnTo));
    }
    redirect(`/cuenta?modo=personal&returnTo=${encodeURIComponent(returnTo)}`);
  }
  return result.user;
}

export async function reauthorizeLegalApi(
  expected: Pick<AppUser, "subject" | "email">,
  options: { requireCurrentAcceptance?: boolean } = {},
): Promise<AppUser | Response> {
  const result = await reauthorizeLegalIdentity(expected, options);
  if (result.ok) return result.user;
  if (result.code === "LEGAL_ACCEPTANCE_REQUIRED") {
    return legalAcceptanceRequiredResponse();
  }
  return Response.json(
    {
      error: "La identidad autenticada cambió durante la operación.",
      code: "IDENTITY_CHANGED",
    },
    {
      status: 409,
      headers: privateHeaders(),
    },
  );
}

export function legalAcceptanceRequiredResponse(): Response {
  return Response.json(
    {
      error: "Debes revisar los términos y la política de privacidad vigentes.",
      code: "LEGAL_ACCEPTANCE_REQUIRED",
      acceptanceUrl: LEGAL_ACCEPTANCE_PATH,
    },
    {
      status: 428,
      headers: privateHeaders(),
    },
  );
}

function privateHeaders(): HeadersInit {
  return {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}
