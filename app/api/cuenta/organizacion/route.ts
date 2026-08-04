import {
  ACCOUNT_MODE_COOKIE,
  ACTIVE_ORGANIZATION_COOKIE,
  safeProductReturnPath,
} from "@/app/account-mode";
import { getAppUser } from "@/app/auth";
import {
  authorizeApiLegalAcceptance,
  reauthorizeLegalApi,
} from "@/app/legal-access";
import {
  isSameOriginMutation,
  readBoundedUrlEncodedForm,
} from "@/app/mutation-request.mjs";
import {
  AccessDeniedError,
  canSelectOrganization,
  listAccessibleOrganizations,
} from "@/src/modules/access/server/access-repository";

/* El shell pide este listado sólo cuando alguien abre el selector, no en cada
   render: el espacio activo ya viaja en el `AccessContext` de la página, así que
   el menú es el único que paga esta consulta y sólo cuando se usa. */
export async function GET() {
  const user = await getAppUser();
  if (!user) {
    return privateJson({ error: "Debes iniciar sesión." }, 401);
  }
  const legalResponse = await authorizeApiLegalAcceptance(user);
  if (legalResponse) return legalResponse;
  try {
    return privateJson({ organizations: await listAccessibleOrganizations(user) }, 200);
  } catch (cause) {
    if (cause instanceof AccessDeniedError) {
      return privateJson({ error: cause.message, code: cause.code }, 403);
    }
    throw cause;
  }
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) {
    return privateJson({
      error: "La solicitud debe provenir de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }
  const url = new URL(request.url);
  const user = await getAppUser();
  if (!user) {
    return privateJson({ error: "Debes iniciar sesión." }, 401);
  }
  const legalResponse = await authorizeApiLegalAcceptance(user);
  if (legalResponse) return legalResponse;

  const formData = await readBoundedUrlEncodedForm(request);
  if (formData instanceof Response) return formData;
  const organizationId = String(formData.get("organizationId") ?? "").trim();
  const returnTo = safeProductReturnPath(String(formData.get("returnTo") ?? ""));
  const current = await reauthorizeLegalApi(user);
  if (current instanceof Response) return current;

  let selectable = false;
  try {
    selectable = Boolean(
      organizationId
      && organizationId.length <= 100
      && await canSelectOrganization(current, organizationId)
    );
  } catch (cause) {
    if (
      cause instanceof AccessDeniedError
      && cause.code === "ACCOUNT_CLOSURE_ACTIVE"
    ) {
      return Response.json(
        {
          code: cause.code,
          error: "La cuenta tiene una solicitud de cierre vigente.",
          recovery: "/app/cuenta/datos",
        },
        {
          status: 423,
          headers: {
            "Cache-Control": "private, no-store",
            "X-Content-Type-Options": "nosniff",
          },
        },
      );
    }
    throw cause;
  }
  if (!selectable) {
    return new Response(null, {
      status: 303,
      headers: {
        "Cache-Control": "private, no-store",
        Location: new URL(`/app/espacios?error=unavailable&returnTo=${encodeURIComponent(returnTo)}`, url).toString(),
        "X-Content-Type-Options": "nosniff",
      },
    });
  }

  const secure = url.protocol === "https:" ? "; Secure" : "";
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    Location: new URL(returnTo, url).toString(),
    "X-Content-Type-Options": "nosniff",
  });
  headers.append("Set-Cookie", `${ACTIVE_ORGANIZATION_COOKIE}=${encodeURIComponent(organizationId)}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax${secure}`);
  headers.append("Set-Cookie", `${ACCOUNT_MODE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure}`);
  return new Response(null, { status: 303, headers });
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
