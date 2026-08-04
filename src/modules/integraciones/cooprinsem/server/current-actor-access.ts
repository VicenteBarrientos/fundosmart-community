import { getDb } from "@/db";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";

export type CooprinsemActorFieldAccess = {
  actorEmail: string;
  fieldIds: string[];
  membershipId: string;
  organizationId: string;
};

export type NormalizedCooprinsemActorFieldAccess = CooprinsemActorFieldAccess;

export function normalizeCooprinsemActorFieldAccess(
  input: CooprinsemActorFieldAccess,
): NormalizedCooprinsemActorFieldAccess | null {
  const access = {
    actorEmail: input.actorEmail?.trim().toLowerCase() ?? "",
    fieldIds: [...new Set((input.fieldIds ?? []).map((fieldId) => fieldId.trim()).filter(Boolean))].sort(),
    membershipId: input.membershipId?.trim() ?? "",
    organizationId: input.organizationId?.trim() ?? "",
  };
  if (
    !access.actorEmail
    || access.actorEmail === DEMO_EMAIL
    || access.fieldIds.length === 0
    || !access.membershipId
    || !access.organizationId
  ) return null;
  return access;
}

export function currentCooprinsemActorFieldGuard(
  fieldAlias: string,
  access: NormalizedCooprinsemActorFieldAccess,
): { sql: string; bindings: Array<string> } {
  if (!/^[a-z][a-z0-9_]*$/i.test(fieldAlias)) throw new Error("Invalid SQL field alias.");
  return {
    sql: `
      ${fieldAlias}.organization_id = ?
      AND ${fieldAlias}.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      AND ${fieldAlias}.is_demo = 0
      AND EXISTS (
        SELECT 1 FROM organization_memberships AS current_actor
        WHERE current_actor.id = ?
          AND current_actor.organization_id = ${fieldAlias}.organization_id
          AND current_actor.normalized_email = ?
          AND current_actor.normalized_email <> ?
          AND current_actor.status = 'active'
          AND current_actor.role IN ('owner', 'admin', 'manager')
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = ${fieldAlias}.id
            )
          )
      )
    `,
    bindings: [
      access.organizationId,
      JSON.stringify(access.fieldIds),
      access.membershipId,
      access.actorEmail,
      DEMO_EMAIL,
    ],
  };
}

export async function hasCurrentCooprinsemActorFieldAccess(
  fieldId: string,
  input: CooprinsemActorFieldAccess,
): Promise<boolean> {
  const access = normalizeCooprinsemActorFieldAccess(input);
  if (!access || !access.fieldIds.includes(fieldId)) return false;
  const guard = currentCooprinsemActorFieldGuard("current_field", access);
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = ?
        AND ${guard.sql}
    ) THEN 1 ELSE 0 END AS authorized
  `).bind(fieldId, ...guard.bindings).first<{ authorized: number }>();
  return Number(row?.authorized) === 1;
}
