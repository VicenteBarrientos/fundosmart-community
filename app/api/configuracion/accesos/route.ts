import { authorizeApiAccess, isAccessResponse, reauthorizeApiSnapshotAccess } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  ORGANIZATION_MEMBERSHIP_ROLES,
  ORGANIZATION_MEMBERSHIP_STATUSES,
  type OrganizationMembershipRole,
  type OrganizationMembershipStatus,
} from "@/src/modules/access/domain/types";
import { getAccessDashboard, saveAccessMembership } from "@/src/modules/access/server/access-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await authorizeApiAccess("manage_members");
  if (isAccessResponse(access)) return access;
  const dashboard = await getAccessDashboard(access);
  const currentAccess = await reauthorizeApiSnapshotAccess(access, {
    capability: "manage_members",
    fieldIds: access.fieldIds,
  });
  if (isAccessResponse(currentAccess)) return currentAccess;
  return Response.json({ dashboard }, { headers: { "Cache-Control": "no-store" } });
}

export async function PUT(request: Request) {
  const access = await authorizeApiAccess("manage_members");
  if (isAccessResponse(access)) return access;
  const payload = await readJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;
  const email = stringValue(payload.email);
  const displayName = stringValue(payload.displayName);
  const role = stringValue(payload.role);
  const status = stringValue(payload.status);
  const fieldIds = Array.isArray(payload.fieldIds) ? payload.fieldIds.map(stringValue).filter(Boolean) : [];
  if (!ORGANIZATION_MEMBERSHIP_ROLES.includes(role as OrganizationMembershipRole)) {
    return Response.json({ error: "El rol seleccionado no es válido." }, { status: 400 });
  }
  if (!ORGANIZATION_MEMBERSHIP_STATUSES.includes(status as OrganizationMembershipStatus)) {
    return Response.json({ error: "El estado seleccionado no es válido." }, { status: 400 });
  }
  try {
    const dashboard = await saveAccessMembership({
      actor: access,
      email,
      displayName,
      role: role as OrganizationMembershipRole,
      status: status as OrganizationMembershipStatus,
      fieldIds,
    });
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "manage_members",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ dashboard });
  } catch (cause) {
    if (cause instanceof DomainRuleError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
    }
    return unexpectedApiFailure("access.membership.save", "No fue posible guardar la membresía.", cause);
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
