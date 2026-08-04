import { getDb } from "@/db";
import { organizationFeatureFlags } from "@/db/schema";
import type {
  AccessContext,
  FeatureKey,
  OrganizationFeatureFlag,
  OrganizationFieldScope,
} from "../domain/types";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

export async function isFeatureEnabled(
  scope: OrganizationFieldScope,
  feature: FeatureKey,
  fieldId: string,
): Promise<boolean> {
  if (!scope.fieldIds.includes(fieldId)) return false;
  const rows = await getDb()
    .select({ fieldId: organizationFeatureFlags.fieldId, enabled: organizationFeatureFlags.enabled })
    .from(organizationFeatureFlags)
    .where(and(
      eq(organizationFeatureFlags.organizationId, scope.organizationId),
      eq(organizationFeatureFlags.feature, feature),
      or(isNull(organizationFeatureFlags.fieldId), eq(organizationFeatureFlags.fieldId, fieldId)),
    ));
  const fieldOverride = rows.find((row) => row.fieldId === fieldId);
  return fieldOverride?.enabled ?? rows.find((row) => row.fieldId === null)?.enabled ?? false;
}

export async function listOrganizationFeatureFlags(actor: AccessContext): Promise<OrganizationFeatureFlag[]> {
  const rows = await getDb()
    .select()
    .from(organizationFeatureFlags)
    .where(and(
      eq(organizationFeatureFlags.organizationId, actor.organizationId),
      or(isNull(organizationFeatureFlags.fieldId), inArray(organizationFeatureFlags.fieldId, actor.fieldIds)),
    ))
    .orderBy(asc(organizationFeatureFlags.feature), asc(organizationFeatureFlags.fieldId));
  await assertCurrentFeatureFlagAuthority(actor, null);
  return rows;
}

export class FeatureFlagAccessError extends Error {
  readonly code = "FEATURE_FLAG_ACCESS_CHANGED";

  constructor(options?: { cause?: unknown }) {
    super("Tu autorización para administrar funcionalidades cambió. Actualiza la página e inténtalo nuevamente.", options);
    this.name = "FeatureFlagAccessError";
  }
}

export async function setOrganizationFeatureFlag(input: {
  actor: AccessContext;
  feature: FeatureKey;
  fieldId: string | null;
  enabled: boolean;
}): Promise<OrganizationFeatureFlag[]> {
  if (input.fieldId && !input.actor.fieldIds.includes(input.fieldId)) {
    throw new Error("FIELD_SCOPE_CONFLICT");
  }
  const now = new Date().toISOString();
  const id = featureFlagId(input.actor.organizationId, input.fieldId, input.feature);
  const client = getDb().$client;
  const auditId = crypto.randomUUID();
  const action = input.enabled ? "feature.enabled" : "feature.disabled";
  const after = JSON.stringify({ feature: input.feature, fieldId: input.fieldId, enabled: input.enabled });
  const authority = currentFeatureFlagAuthority(input.actor, input.fieldId);
  try {
    await client.batch([
      client.prepare(`
        INSERT INTO audit_log
          (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
        SELECT ?, ?, ?, ?, ?, 'organization_feature_flag', ?,
          (
            SELECT json_object(
              'feature', existing.feature,
              'fieldId', existing.field_id,
              'enabled', json(CASE WHEN existing.enabled = 1 THEN 'true' ELSE 'false' END)
            )
            FROM organization_feature_flags AS existing
            WHERE existing.id = ?
          ),
          ?, ?
        WHERE ${authority.sql}
      `).bind(
        auditId,
        input.actor.organizationId,
        input.fieldId,
        input.actor.email,
        action,
        id,
        id,
        after,
        now,
        ...authority.bindings,
      ),
      client.prepare(`
      INSERT INTO organization_feature_flags
        (id, organization_id, field_id, feature, enabled, created_by, updated_by, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM audit_log AS authorization_receipt
        WHERE authorization_receipt.id = ?
          AND authorization_receipt.organization_id = ?
          AND authorization_receipt.entity_type = 'organization_feature_flag'
          AND authorization_receipt.entity_id = ?
      )
        AND ${authority.sql}
      ON CONFLICT(id) DO UPDATE SET
        enabled = excluded.enabled,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `).bind(
      id,
      input.actor.organizationId,
      input.fieldId,
      input.feature,
      input.enabled ? 1 : 0,
      input.actor.email,
      input.actor.email,
      now,
      now,
      auditId,
      input.actor.organizationId,
      id,
      ...authority.bindings,
      ),
      client.prepare(`
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM organization_feature_flags AS committed_flag
          WHERE committed_flag.id = ?
            AND committed_flag.organization_id = ?
            AND committed_flag.field_id IS ?
            AND committed_flag.feature = ?
            AND committed_flag.enabled = ?
            AND committed_flag.updated_by = ?
            AND committed_flag.updated_at = ?
        ) AND EXISTS (
          SELECT 1 FROM audit_log AS committed_audit
          WHERE committed_audit.id = ?
            AND committed_audit.organization_id = ?
            AND committed_audit.field_id IS ?
            AND committed_audit.actor = ?
            AND committed_audit.action = ?
            AND committed_audit.entity_type = 'organization_feature_flag'
            AND committed_audit.entity_id = ?
            AND committed_audit.after = ?
            AND committed_audit.occurred_at = ?
        ) AND ${authority.sql}
          THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
      `).bind(
        id,
        input.actor.organizationId,
        input.fieldId,
        input.feature,
        input.enabled ? 1 : 0,
        input.actor.email,
        now,
        auditId,
        input.actor.organizationId,
        input.fieldId,
        input.actor.email,
        action,
        id,
        after,
        now,
        ...authority.bindings,
      ),
    ]);
  } catch (cause) {
    if (!(await hasCurrentFeatureFlagAuthority(input.actor, input.fieldId))) {
      throw new FeatureFlagAccessError({ cause });
    }
    throw cause;
  }
  return listOrganizationFeatureFlags(input.actor);
}

export function featureFlagId(organizationId: string, fieldId: string | null, feature: FeatureKey): string {
  return `feature:${organizationId}:${fieldId ?? "*"}:${feature}`;
}

type D1Binding = string | number | null;

function currentFeatureFlagAuthority(
  actor: AccessContext,
  fieldId: string | null,
): { sql: string; bindings: D1Binding[] } {
  return {
    sql: `EXISTS (
      SELECT 1 FROM organization_memberships AS current_actor
      WHERE current_actor.id = ?
        AND current_actor.organization_id = ?
        AND current_actor.normalized_email = lower(trim(?))
        AND current_actor.status = 'active'
        AND current_actor.role IN ('owner', 'admin')
    ) AND (
      ? IS NULL OR EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ?
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
      )
    )`,
    bindings: [
      actor.membershipId,
      actor.organizationId,
      actor.email,
      fieldId,
      fieldId,
      actor.organizationId,
    ],
  };
}

async function hasCurrentFeatureFlagAuthority(actor: AccessContext, fieldId: string | null): Promise<boolean> {
  const authority = currentFeatureFlagAuthority(actor, fieldId);
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN ${authority.sql} THEN 1 ELSE 0 END AS authorized
  `).bind(...authority.bindings).first<{ authorized: number }>();
  return Number(row?.authorized) === 1;
}

async function assertCurrentFeatureFlagAuthority(actor: AccessContext, fieldId: string | null): Promise<void> {
  if (!(await hasCurrentFeatureFlagAuthority(actor, fieldId))) throw new FeatureFlagAccessError();
}
