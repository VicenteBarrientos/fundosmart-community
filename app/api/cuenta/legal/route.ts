import { getAppUser } from "@/app/auth";
import { sha256Hex } from "@/app/auth-core.mjs";
import {
  reauthorizeLegalApi,
  safeLegalReturnPath,
} from "@/app/legal-access";
import {
  isSameOriginMutation,
  readBoundedUrlEncodedForm,
} from "@/app/mutation-request.mjs";
import {
  LegalAcceptanceError,
  evaluateLegalAcceptance,
} from "@/src/modules/legal/legal-acceptance.mjs";
import {
  LegalAcceptancePersistenceError,
  getLegalAcceptanceStatus,
  isLegalAcceptanceExemptSubject,
  listLegalAcceptanceReceipts,
  recordCurrentLegalAcceptance,
} from "@/src/modules/legal/server/legal-acceptance-repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const user = await getAppUser();
  if (!user) return privateJson({ error: "Debes iniciar sesión." }, 401);
  const receipts = await listLegalAcceptanceReceipts(env.DB, user.subject);
  const status = isLegalAcceptanceExemptSubject(user.subject)
    ? await getLegalAcceptanceStatus(env.DB, user.subject)
    : evaluateLegalAcceptance(receipts);
  const generatedAt = new Date().toISOString();
  const current = await reauthorizeLegalApi(user, {
    requireCurrentAcceptance: false,
  });
  if (current instanceof Response) return current;

  const payload = {
    format: "fundosmart.legal-acceptances.v1",
    generatedAt,
    identityId: current.subject,
    current: status,
    receipts,
  };
  const download = new URL(request.url).searchParams.get("download") === "1";
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  });
  if (download) {
    headers.set(
      "Content-Disposition",
      `attachment; filename="fundosmart-aceptaciones-${generatedAt.slice(0, 10)}.json"`,
    );
  }
  return new Response(JSON.stringify(payload), { status: 200, headers });
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson({
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }
  const user = await getAppUser();
  if (!user) return privateJson({ error: "Debes iniciar sesión." }, 401);
  const formData = await readBoundedUrlEncodedForm(request);
  if (formData instanceof Response) return formData;
  const returnTo = safeLegalReturnPath(stringValue(formData.get("returnTo")));
  const confirmed = formData.get("acceptTerms") === "on"
    && formData.get("acknowledgePrivacy") === "on";
  const userAgent = request.headers.get("user-agent") ?? "";
  const userAgentSha256 = userAgent ? await sha256Hex(userAgent) : null;

  try {
    await recordCurrentLegalAcceptance(env.DB, {
      identityId: user.subject,
      requestId: stringValue(formData.get("requestId")),
      acceptedAt: new Date().toISOString(),
      acceptedVersions: {
        privacy: stringValue(formData.get("privacyVersion")),
        terms: stringValue(formData.get("termsVersion")),
      },
      confirmed: confirmed as true,
      userAgentSha256,
      beforeCommit: async () => {
        const current = await reauthorizeLegalApi(user, {
          requireCurrentAcceptance: false,
        });
        if (current instanceof Response) throw current;
      },
    });
  } catch (cause) {
    if (cause instanceof Response) return cause;
    if (cause instanceof LegalAcceptanceError) {
      return privateJson(
        {
          error: cause.message,
          code: cause.code,
        },
        cause.code === "STALE_LEGAL_VERSION" ? 409 : 400,
      );
    }
    if (cause instanceof LegalAcceptancePersistenceError) {
      return privateJson({ error: cause.message, code: cause.code }, 409);
    }
    throw cause;
  }

  const current = await reauthorizeLegalApi(user);
  if (current instanceof Response) return current;
  return new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "private, no-store",
      Location: new URL(returnTo, request.url).toString(),
    },
  });
}

function stringValue(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function privateJson(payload: unknown, status: number): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
