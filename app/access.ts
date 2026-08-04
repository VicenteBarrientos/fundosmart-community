import { ACTIVE_ORGANIZATION_COOKIE, resolveAccountUser } from "@/app/account-mode";
import { getAppUserWithLegalStatus, type AppUser } from "@/app/auth";
import type { LegalAcceptanceStatus } from "@/src/modules/legal/legal-acceptance.mjs";
import {
  authorizeApiLegalAcceptance,
  requirePageLegalAcceptance,
} from "@/app/legal-access";
import type { AccessCapability, AccessContext } from "@/src/modules/access/domain/types";
import { AccessDeniedError, authorizeUser } from "@/src/modules/access/server/access-repository";
import { resolveResourceFieldId, type FieldScopedResource } from "@/src/modules/access/server/resource-scope";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

/* Identidad y aceptación legal llegan juntas. `resolveAccountUser` puede
   sustituir al usuario por la identidad demo; en ese caso el veredicto leído no
   le corresponde y hay que resolverlo aparte —lo que para `demo` no consulta,
   porque está exenta—. */
async function resolveGateIdentity(): Promise<
  { user: AppUser; legalStatus: LegalAcceptanceStatus | null } | null
> {
  const session = await getAppUserWithLegalStatus();
  const user = await resolveAccountUser(session?.user ?? null);
  if (!user) return null;
  return {
    user,
    legalStatus: user.subject === session?.user.subject ? session.legalStatus : null,
  };
}

export async function requirePageAccess(
  returnTo: string,
  capability: AccessCapability = "view",
  fieldId?: string,
): Promise<AccessContext> {
  const gate = await resolveGateIdentity();
  if (!gate) redirect(`/cuenta?modo=personal&returnTo=${encodeURIComponent(returnTo)}`);
  const { user } = gate;
  await requirePageLegalAcceptance(user, returnTo, gate.legalStatus);
  try {
    return await authorizeUser(
      user,
      capability,
      fieldId,
      async () => (await cookies()).get(ACTIVE_ORGANIZATION_COOKIE)?.value,
    );
  } catch (cause) {
    /* Entrar ya no pasa por el selector: sólo llega aquí quien trae una cookie
       hacia un espacio que perdió. El motivo viaja en la URL para que la página
       lo diga en vez de aparecer sin explicación. */
    if (cause instanceof AccessDeniedError && cause.code === "MEMBERSHIP_AMBIGUOUS") {
      redirect(`/app/espacios?error=unavailable&returnTo=${encodeURIComponent(returnTo)}`);
    }
    if (cause instanceof AccessDeniedError) redirect(`/app/sin-acceso?code=${encodeURIComponent(cause.code)}`);
    throw cause;
  }
}

export async function reauthorizePageAccess(
  expected: AccessContext,
  returnTo: string,
  capability: AccessCapability = "view",
  fieldId?: string,
): Promise<AccessContext> {
  const current = await requirePageAccess(returnTo, capability, fieldId);
  if (
    current.membershipId !== expected.membershipId
    || current.organizationId !== expected.organizationId
    || current.email !== expected.email
  ) {
    redirect("/app/sin-acceso?code=ACCESS_CONTEXT_CHANGED");
  }
  return current;
}

type PageSnapshotAccessRequirement = {
  capability?: AccessCapability;
  fieldIds: readonly string[];
};

export async function reauthorizePageSnapshotAccess(
  expected: AccessContext,
  returnTo: string,
  requirement: PageSnapshotAccessRequirement,
): Promise<AccessContext> {
  const current = await reauthorizePageAccess(
    expected,
    returnTo,
    requirement.capability ?? "view",
  );
  const currentFieldIds = new Set(current.fieldIds);
  if (requirement.fieldIds.some((fieldId) => !currentFieldIds.has(fieldId))) {
    redirect("/app/sin-acceso?code=ACCESS_SCOPE_CHANGED");
  }
  return current;
}

export async function authorizeApiAccess(
  capability: AccessCapability = "view",
  fieldId?: string,
  organizationId?: string,
): Promise<AccessContext | Response> {
  const gate = await resolveGateIdentity();
  if (!gate) return Response.json({ error: "Debes iniciar sesión." }, { status: 401 });
  const { user } = gate;
  const legalResponse = await authorizeApiLegalAcceptance(user, gate.legalStatus);
  if (legalResponse) return legalResponse;
  try {
    return await authorizeUser(
      user,
      capability,
      fieldId,
      async () => organizationId
        ?? (await cookies()).get(ACTIVE_ORGANIZATION_COOKIE)?.value,
    );
  } catch (cause) {
    if (cause instanceof AccessDeniedError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 403 });
    }
    throw cause;
  }
}

export function isAccessResponse(value: AccessContext | Response): value is Response {
  return value instanceof Response;
}

export async function reauthorizeApiAccess(
  expected: AccessContext,
  capability: AccessCapability = "view",
  fieldId?: string,
  organizationId?: string,
): Promise<AccessContext | Response> {
  const current = await authorizeApiAccess(
    capability,
    fieldId,
    organizationId,
  );
  if (isAccessResponse(current)) return current;
  if (
    current.membershipId !== expected.membershipId
    || current.organizationId !== expected.organizationId
    || current.email !== expected.email
  ) {
    return Response.json({
      error: "Tu membresía cambió durante la operación. Actualiza la página e inténtalo nuevamente.",
      code: "ACCESS_CONTEXT_CHANGED",
    }, { status: 409 });
  }
  return current;
}

type ApiSnapshotAccessRequirement = {
  capability?: AccessCapability;
  fieldIds: readonly string[];
  organizationId?: string;
};

export async function reauthorizeApiSnapshotAccess(
  expected: AccessContext,
  requirement: ApiSnapshotAccessRequirement,
): Promise<AccessContext | Response> {
  const current = await reauthorizeApiAccess(
    expected,
    requirement.capability ?? "view",
    undefined,
    requirement.organizationId,
  );
  if (isAccessResponse(current)) return current;
  const currentFieldIds = new Set(current.fieldIds);
  if (requirement.fieldIds.some((fieldId) => !currentFieldIds.has(fieldId))) {
    return Response.json({
      error: "Tu alcance de fundos cambió durante la operación. Actualiza la página e inténtalo nuevamente.",
      code: "ACCESS_SCOPE_CHANGED",
    }, { status: 409 });
  }
  return current;
}

export function requireContextField(context: AccessContext, fieldId: string | null | undefined): Response | null {
  if (!fieldId || !context.fieldIds.includes(fieldId)) {
    return Response.json({ error: "El recurso no existe o no está disponible para tu membresía." }, { status: 404 });
  }
  return null;
}

export async function requireResourceField(
  context: AccessContext,
  resource: FieldScopedResource,
  id: string,
): Promise<Response | null> {
  return requireContextField(context, await resolveResourceFieldId(resource, id));
}
