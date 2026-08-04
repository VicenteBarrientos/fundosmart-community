import { getDb } from "@/db";
import { fields, restoreConfirmationTokens } from "@/db/schema";
import { and, eq, gt, sql } from "drizzle-orm";
import { normalizeAccessEmail } from "@/src/modules/access/domain/access-rules.mjs";
import type { AccessContext } from "@/src/modules/access/domain/types";
import {
  buildRestoreActorAccess,
  buildRestoreConfirmationBinding,
  restoreConfirmationTokenSha256,
  validateRestoreConfirmation,
  type RestoreActorAccess,
  type RestoreConfirmationBinding,
  type RestoreConfirmationValidation,
} from "./restore-confirmation-rules.mjs";

const CONFIRMATION_TTL_MS = 15 * 60 * 1000;

type ConfirmationStatus = "active" | "consumed" | "expired" | "revoked";
export type RestoreFieldAccess = Pick<AccessContext, "membershipId" | "email" | "fieldIds">;

const CURRENT_RESTORE_DATA_ACTOR_GUARD = `
      AND current_field.is_demo = 0
      AND EXISTS (
        SELECT 1 FROM organization_memberships AS current_actor
        WHERE current_actor.id = ?
          AND current_actor.organization_id = current_field.organization_id
          AND current_actor.normalized_email = ?
          AND current_actor.status = 'active'
          AND current_actor.role IN ('owner', 'admin')
      )`;

export class RestoreConfirmationScopeError extends Error {
  readonly code = "RESTORE_SCOPE_CHANGED";

  constructor() {
    super("El alcance de restauración cambió durante la confirmación.");
    this.name = "RestoreConfirmationScopeError";
  }
}

export type RestoreConfirmationReceipt = {
  token: string;
  expiresAt: string;
  snapshotSha256: string;
  planSha256: string;
  writeEnabled: false;
};

export async function issueRestoreConfirmation(
  input: RestoreConfirmationBinding & RestoreFieldAccess & { now?: string },
): Promise<RestoreConfirmationReceipt> {
  const binding = buildRestoreConfirmationBinding({ ...input, actorEmail: normalizeAccessEmail(input.actorEmail) });
  const access = buildRestoreActorAccess(input, binding.actorEmail);
  if (!access?.fieldIds.includes(binding.fieldId)) throw new RestoreConfirmationScopeError();
  const now = input.now ?? new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + CONFIRMATION_TTL_MS).toISOString();
  const token = secureToken();
  const tokenSha256 = await restoreConfirmationTokenSha256(token, access.membershipId);
  const id = `restore-confirmation-${crypto.randomUUID()}`;
  const auditId = crypto.randomUUID();
  const accessJson = JSON.stringify(access.fieldIds);
  const after = JSON.stringify({
    backupSha256: binding.backupSha256,
    snapshotSha256: binding.snapshotSha256,
    planSha256: binding.planSha256,
    expiresAt,
    writeEnabled: false,
  });
  const client = getDb().$client;
  const revoke = client.prepare(`
    UPDATE restore_confirmation_tokens
    SET status = 'revoked', updated_at = ?
    WHERE organization_id = ? AND field_id = ? AND actor_email = ? AND status = 'active'
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ? AND current_field.organization_id = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ${CURRENT_RESTORE_DATA_ACTOR_GUARD}
      )
  `).bind(
    now,
    binding.organizationId,
    binding.fieldId,
    binding.actorEmail,
    binding.fieldId,
    binding.organizationId,
    accessJson,
    access.membershipId,
    access.email,
  );
  const insertToken = client.prepare(`
    INSERT INTO restore_confirmation_tokens (
      id, organization_id, field_id, actor_email, token_sha256, backup_sha256,
      snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at
    )
    SELECT ?, current_field.organization_id, current_field.id, ?, ?, ?, ?, ?,
      'active', ?, ?, ?
    FROM fields AS current_field
    WHERE current_field.id = ? AND current_field.organization_id = ?
      AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ${CURRENT_RESTORE_DATA_ACTOR_GUARD}
  `).bind(
    id,
    binding.actorEmail,
    tokenSha256,
    binding.backupSha256,
    binding.snapshotSha256,
    binding.planSha256,
    expiresAt,
    now,
    now,
    binding.fieldId,
    binding.organizationId,
    accessJson,
    access.membershipId,
    access.email,
  );
  const insertAudit = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, confirmation.organization_id, confirmation.field_id, confirmation.actor_email,
      'backup.restore.confirmation_issued', 'restore_confirmation', confirmation.id,
      NULL, ?, NULL, ?
    FROM restore_confirmation_tokens AS confirmation
    INNER JOIN fields AS current_field
      ON current_field.id = confirmation.field_id
      AND current_field.organization_id = confirmation.organization_id
    WHERE confirmation.id = ? AND confirmation.token_sha256 = ?
      AND confirmation.backup_sha256 = ? AND confirmation.snapshot_sha256 = ?
      AND confirmation.plan_sha256 = ? AND confirmation.status = 'active'
      AND confirmation.expires_at = ? AND confirmation.created_at = ? AND confirmation.updated_at = ?
      AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      ${CURRENT_RESTORE_DATA_ACTOR_GUARD}
  `).bind(
    auditId,
    after,
    now,
    id,
    tokenSha256,
    binding.backupSha256,
    binding.snapshotSha256,
    binding.planSha256,
    expiresAt,
    now,
    now,
    accessJson,
    access.membershipId,
    access.email,
  );
  const assertComplete = client.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM restore_confirmation_tokens AS confirmation
        INNER JOIN fields AS current_field
          ON current_field.id = confirmation.field_id
          AND current_field.organization_id = confirmation.organization_id
        WHERE confirmation.id = ? AND confirmation.token_sha256 = ?
          AND confirmation.organization_id = ? AND confirmation.field_id = ?
          AND confirmation.actor_email = ? AND confirmation.status = 'active'
          AND confirmation.backup_sha256 = ? AND confirmation.snapshot_sha256 = ?
          AND confirmation.plan_sha256 = ? AND confirmation.expires_at = ?
          AND confirmation.created_at = ? AND confirmation.updated_at = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ${CURRENT_RESTORE_DATA_ACTOR_GUARD}
      )
      AND EXISTS (
        SELECT 1 FROM audit_log AS issued_audit
        WHERE issued_audit.id = ? AND issued_audit.organization_id = ?
          AND issued_audit.field_id = ? AND issued_audit.actor = ?
          AND issued_audit.action = 'backup.restore.confirmation_issued'
          AND issued_audit.entity_type = 'restore_confirmation' AND issued_audit.entity_id = ?
          AND issued_audit.before IS NULL AND issued_audit.after = ?
          AND issued_audit.source_record_id IS NULL AND issued_audit.occurred_at = ?
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    id,
    tokenSha256,
    binding.organizationId,
    binding.fieldId,
    binding.actorEmail,
    binding.backupSha256,
    binding.snapshotSha256,
    binding.planSha256,
    expiresAt,
    now,
    now,
    accessJson,
    access.membershipId,
    access.email,
    auditId,
    binding.organizationId,
    binding.fieldId,
    binding.actorEmail,
    id,
    after,
    now,
  );
  try {
    const results = await client.batch([revoke, insertToken, insertAudit, assertComplete]);
    if (results[1].meta.changes !== 1
      || results[2].meta.changes !== 1
      || (results[3].results[0] as { complete?: number } | undefined)?.complete !== 1) {
      throw new RestoreConfirmationScopeError();
    }
  } catch (cause) {
    if (cause instanceof RestoreConfirmationScopeError) throw cause;
    if (cause instanceof Error && /integer overflow/i.test(cause.message)) throw new RestoreConfirmationScopeError();
    throw cause;
  }
  return { token, expiresAt, snapshotSha256: binding.snapshotSha256, planSha256: binding.planSha256, writeEnabled: false };
}

export async function verifyRestoreConfirmation(
  input: RestoreConfirmationBinding & RestoreFieldAccess & { token: string; now?: string },
): Promise<RestoreConfirmationValidation> {
  const binding = buildRestoreConfirmationBinding({ ...input, actorEmail: normalizeAccessEmail(input.actorEmail) });
  const access = buildRestoreActorAccess(input, binding.actorEmail);
  if (!access?.fieldIds.includes(binding.fieldId)) return validateRestoreConfirmation(null, binding, input.now);
  const tokenSha256 = await restoreConfirmationTokenSha256(input.token, access.membershipId);
  const [record] = await getDb()
    .select({
      actorEmail: restoreConfirmationTokens.actorEmail,
      organizationId: restoreConfirmationTokens.organizationId,
      fieldId: restoreConfirmationTokens.fieldId,
      backupSha256: restoreConfirmationTokens.backupSha256,
      snapshotSha256: restoreConfirmationTokens.snapshotSha256,
      planSha256: restoreConfirmationTokens.planSha256,
      status: restoreConfirmationTokens.status,
      expiresAt: restoreConfirmationTokens.expiresAt,
    })
    .from(restoreConfirmationTokens)
    .innerJoin(fields, and(
      eq(fields.id, restoreConfirmationTokens.fieldId),
      eq(fields.organizationId, restoreConfirmationTokens.organizationId),
    ))
    .where(and(
      eq(restoreConfirmationTokens.tokenSha256, tokenSha256),
      eq(restoreConfirmationTokens.organizationId, binding.organizationId),
      eq(restoreConfirmationTokens.fieldId, binding.fieldId),
      eq(fields.isDemo, false),
      sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
      currentRestoreDataActorCondition(access),
    ))
    .limit(1);
  return validateRestoreConfirmation(record ?? null, binding, input.now);
}

export async function consumeRestoreConfirmation(
  input: RestoreConfirmationBinding & RestoreFieldAccess & { token: string; now?: string },
): Promise<boolean> {
  const validation = await verifyRestoreConfirmation(input);
  if (!validation.valid) return false;
  const binding = buildRestoreConfirmationBinding({ ...input, actorEmail: normalizeAccessEmail(input.actorEmail) });
  const access = buildRestoreActorAccess(input, binding.actorEmail);
  if (!access?.fieldIds.includes(binding.fieldId)) return false;
  const tokenSha256 = await restoreConfirmationTokenSha256(input.token, access.membershipId);
  const now = input.now ?? new Date().toISOString();
  const [consumed] = await getDb()
    .update(restoreConfirmationTokens)
    .set({ status: "consumed", consumedAt: now, updatedAt: now })
    .where(and(
      eq(restoreConfirmationTokens.tokenSha256, tokenSha256),
      eq(restoreConfirmationTokens.status, "active"),
      gt(restoreConfirmationTokens.expiresAt, now),
      eq(restoreConfirmationTokens.actorEmail, binding.actorEmail),
      eq(restoreConfirmationTokens.organizationId, binding.organizationId),
      eq(restoreConfirmationTokens.fieldId, binding.fieldId),
      eq(restoreConfirmationTokens.backupSha256, binding.backupSha256),
      eq(restoreConfirmationTokens.snapshotSha256, binding.snapshotSha256),
      eq(restoreConfirmationTokens.planSha256, binding.planSha256),
      sql`EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ${binding.fieldId}
          AND current_field.organization_id = ${binding.organizationId}
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))
          AND current_field.is_demo = 0
          AND EXISTS (
            SELECT 1 FROM organization_memberships AS current_actor
            WHERE current_actor.id = ${access.membershipId}
              AND current_actor.organization_id = current_field.organization_id
              AND current_actor.normalized_email = ${access.email}
              AND current_actor.status = 'active'
              AND current_actor.role IN ('owner', 'admin')
          )
      )`,
    ))
    .returning({ id: restoreConfirmationTokens.id });
  return Boolean(consumed);
}

function currentRestoreDataActorCondition(access: RestoreActorAccess) {
  return sql`EXISTS (
    SELECT 1 FROM organization_memberships AS current_actor
    WHERE current_actor.id = ${access.membershipId}
      AND current_actor.organization_id = ${fields.organizationId}
      AND current_actor.normalized_email = ${access.email}
      AND current_actor.status = 'active'
      AND current_actor.role IN ('owner', 'admin')
  )`;
}

function secureToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type { ConfirmationStatus };
