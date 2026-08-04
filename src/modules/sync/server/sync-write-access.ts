import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";

type SqlBinding = string | number | null;

export type SyncWriteAccessCondition = {
  sql: string;
  bindings: SqlBinding[];
};

export class SyncWriteAccessRevokedError extends Error {
  constructor() {
    super("La membresia o el acceso al fundo cambio antes de confirmar la captura.");
    this.name = "SyncWriteAccessRevokedError";
  }
}

export function syncWriteAccessCondition(
  actor: AccessContext,
  fieldId: string,
): SyncWriteAccessCondition {
  return {
    sql: `EXISTS (
      SELECT 1
      FROM organization_memberships AS sync_access_membership
      INNER JOIN fields AS sync_access_field
        ON sync_access_field.id = ?
       AND sync_access_field.organization_id = sync_access_membership.organization_id
      WHERE sync_access_membership.id = ?
        AND sync_access_membership.organization_id = ?
        AND sync_access_membership.normalized_email = ?
        AND sync_access_membership.normalized_email <> ?
        AND sync_access_membership.status = 'active'
        AND sync_access_membership.role IN ('owner', 'admin', 'manager', 'operator')
        AND (
          sync_access_membership.role IN ('owner', 'admin')
          OR EXISTS (
            SELECT 1
            FROM membership_field_access AS sync_access_scope
            WHERE sync_access_scope.membership_id = sync_access_membership.id
              AND sync_access_scope.field_id = sync_access_field.id
          )
        )
    )`,
    bindings: [
      fieldId,
      actor.membershipId,
      actor.organizationId,
      actor.email.trim().toLowerCase(),
      DEMO_EMAIL,
    ],
  };
}

export async function hasCurrentSyncWriteAccess(
  actor: AccessContext,
  fieldId: string,
): Promise<boolean> {
  const condition = syncWriteAccessCondition(actor, fieldId);
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN ${condition.sql} THEN 1 ELSE 0 END AS authorized
  `).bind(...condition.bindings).first<{ authorized: number }>();
  return Number(row?.authorized) === 1;
}
