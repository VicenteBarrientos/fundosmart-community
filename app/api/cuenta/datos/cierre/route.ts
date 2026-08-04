import {
  ACCOUNT_MODE_COOKIE,
  ACTIVE_ORGANIZATION_COOKIE,
} from "@/app/account-mode";
import { getAppUser } from "@/app/auth";
import {
  normalizeAuthEmail,
} from "@/app/auth-core.mjs";
import { clearSessionCookies } from "@/app/auth-session";
import {
  authorizeApiLegalAcceptance,
  reauthorizeLegalApi,
} from "@/app/legal-access";
import {
  isSameOriginMutation,
  readBoundedUrlEncodedForm,
} from "@/app/mutation-request.mjs";
import { AccountClosureError } from "@/src/modules/account-lifecycle/account-closure.mjs";
import {
  AccountClosurePersistenceError,
  requestAccountClosure,
  revokeAccountClosure,
} from "@/src/modules/account-lifecycle/server/account-closure-repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) {
    return privateJson({
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }
  const user = await getAppUser();
  if (!user) return privateJson({ error: "Debes iniciar sesión." }, 401);
  const legalResponse = await authorizeApiLegalAcceptance(user);
  if (legalResponse) return legalResponse;

  const formData = await readBoundedUrlEncodedForm(request);
  if (formData instanceof Response) return formData;
  const action = stringValue(formData.get("action"));
  const requestId = stringValue(formData.get("requestId"));
  if (!requestId || requestId.length > 160) {
    return privateJson({
      error: "La solicitud de cierre no es válida.",
      code: "INVALID_REQUEST_ID",
    }, 400);
  }

  try {
    if (action === "request") {
      return await requestClosure(request, user, formData, requestId);
    }
    if (action === "revoke") {
      return await revokeClosure(request, user, formData, requestId);
    }
    return privateJson({
      error: "La acción de cierre no es válida.",
      code: "INVALID_CLOSURE_ACTION",
    }, 400);
  } catch (cause) {
    if (cause instanceof Response) return cause;
    if (cause instanceof AccountClosurePersistenceError) {
      return privateJson({ error: cause.message, code: cause.code }, cause.status);
    }
    if (cause instanceof AccountClosureError) {
      return privateJson({ error: cause.message, code: cause.code }, 409);
    }
    throw cause;
  }
}

async function requestClosure(
  request: Request,
  user: NonNullable<Awaited<ReturnType<typeof getAppUser>>>,
  formData: URLSearchParams,
  requestId: string,
): Promise<Response> {
  const scope = stringValue(formData.get("scope"));
  if (scope !== "account" && scope !== "organization") {
    return privateJson({
      error: "El alcance del cierre no es válido.",
      code: "INVALID_CLOSURE_SCOPE",
    }, 400);
  }
  if (formData.get("understand") !== "on") {
    return privateJson({
      error: "Debes confirmar que comprendes la suspensión reversible.",
      code: "CLOSURE_CONFIRMATION_REQUIRED",
    }, 400);
  }
  const targetId = scope === "account"
    ? user.subject
    : stringValue(formData.get("targetId"));
  const suppliedConfirmation = stringValue(formData.get("confirmation"));
  if (
    scope === "account"
    && normalizeAuthEmail(suppliedConfirmation) !== normalizeAuthEmail(user.email)
  ) {
    return privateJson({
      error: "Escribe tu correo exacto para confirmar.",
      code: "CLOSURE_CONFIRMATION_MISMATCH",
    }, 400);
  }

  const closure = await requestAccountClosure(env.DB, {
    actor: user,
    scope,
    targetId,
    requestId,
    requestedAt: new Date().toISOString(),
    organizationConfirmation: scope === "organization"
      ? suppliedConfirmation
      : undefined,
    beforeCommit: () => requireCurrentClosureActor(user),
  });
  if (scope === "account") {
    return accountClosureRedirect(request.url);
  }
  const current = await reauthorizeLegalApi(user);
  if (current instanceof Response) return current;
  return redirectResponse(
    new URL(`/app/cuenta/datos?cierre=${encodeURIComponent(closure.id)}`, request.url),
  );
}

async function revokeClosure(
  request: Request,
  user: NonNullable<Awaited<ReturnType<typeof getAppUser>>>,
  formData: URLSearchParams,
  requestId: string,
): Promise<Response> {
  const closureRequestId = stringValue(formData.get("closureRequestId"));
  if (!closureRequestId || closureRequestId.length > 200) {
    return privateJson({
      error: "La solicitud de cierre no es válida.",
      code: "INVALID_CLOSURE_ID",
    }, 400);
  }
  await revokeAccountClosure(env.DB, {
    actor: user,
    closureRequestId,
    requestId,
    revokedAt: new Date().toISOString(),
    beforeCommit: () => requireCurrentClosureActor(user),
  });
  const current = await reauthorizeLegalApi(user);
  if (current instanceof Response) return current;
  return redirectResponse(new URL("/app/cuenta/datos?revocado=1", request.url));
}

async function requireCurrentClosureActor(
  user: NonNullable<Awaited<ReturnType<typeof getAppUser>>>,
): Promise<void> {
  const current = await reauthorizeLegalApi(user);
  if (current instanceof Response) throw current;
}

function accountClosureRedirect(requestUrl: string): Response {
  const location = new URL(
    "/cuenta?modo=personal&returnTo=%2Fapp%2Fcuenta%2Fdatos",
    requestUrl,
  );
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Location: location.toString(),
  });
  for (const cookie of clearSessionCookies(requestUrl)) {
    headers.append("Set-Cookie", cookie);
  }
  for (const name of [ACCOUNT_MODE_COOKIE, ACTIVE_ORGANIZATION_COOKIE]) {
    headers.append("Set-Cookie", clearAppCookie(name, requestUrl));
  }
  return new Response(null, { status: 303, headers });
}

function redirectResponse(location: URL): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store",
      Location: location.toString(),
    },
  });
}

function clearAppCookie(name: string, requestUrl: string): string {
  const secure = name.startsWith("__Host-")
    || new URL(requestUrl).protocol === "https:";
  return `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

function stringValue(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function privateJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
