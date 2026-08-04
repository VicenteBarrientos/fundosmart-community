import { getDb } from "@/db";
import { syncMutations } from "@/db/schema";
import type { AccessContext } from "@/src/modules/access/domain/types";
import type {
  DomainEventRecord,
  SyncJsonValue,
  SyncMutationInput,
  SyncMutationResult,
} from "../domain/types";
import {
  decideSyncMutation,
  stableStringify,
  validateSyncBatch,
  validateSyncMutation,
} from "../domain/sync-rules.mjs";
import { applyOfflineFieldCapture } from "@/src/modules/offline/server/field-capture-repository";
import { applyGeographicSyncMutation } from "@/src/modules/potreros/server/geographic-sync-projection";
import { isGeographicSyncEntity } from "@/src/modules/potreros/sync/geographic-sync-rules.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import { eq } from "drizzle-orm";
import {
  hasCurrentSyncWriteAccess,
  SyncWriteAccessRevokedError,
  syncWriteAccessCondition,
} from "./sync-write-access";

type StoredMutation = typeof syncMutations.$inferSelect;

export async function pushSyncMutations(
  actor: AccessContext,
  values: unknown,
): Promise<{ results: SyncMutationResult[] }> {
  const batchError = validateSyncBatch(values);
  if (batchError) throw new SyncRequestError(batchError);
  const results: SyncMutationResult[] = [];
  for (const [index, value] of (values as unknown[]).entries()) {
    const mutation = parseMutation(value);
    if (typeof mutation === "string") {
      results.push(rejectedResult(readUntrustedId(value, index), mutation));
      continue;
    }
    results.push(await applyMutation(actor, mutation));
  }
  return { results };
}

export async function pullSyncEvents(input: {
  actor: AccessContext;
  cursor: number;
  fieldId?: string;
  limit: number;
}): Promise<{ events: DomainEventRecord[]; nextCursor: number }> {
  const requestedFieldId = input.fieldId ?? null;
  const result = await getDb().$client.prepare(`
    WITH current_member AS (
      SELECT membership.id, membership.organization_id,
        CASE WHEN membership.normalized_email = ? THEN 'viewer' ELSE membership.role END AS role
      FROM organization_memberships AS membership
      WHERE membership.id = ?
        AND membership.organization_id = ?
        AND membership.normalized_email = ?
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin', 'manager', 'operator', 'viewer')
      LIMIT 1
    ),
    authorized_fields AS (
      SELECT field.id
      FROM fields AS field
      JOIN current_member
        ON current_member.organization_id = field.organization_id
      LEFT JOIN membership_field_access AS current_scope
        ON current_scope.membership_id = current_member.id
       AND current_scope.field_id = field.id
      WHERE current_member.role IN ('owner', 'admin')
         OR current_scope.field_id IS NOT NULL
    ),
    selected_events AS (
      SELECT event.sequence, event.id, event.organization_id AS organizationId,
        event.field_id AS fieldId, event.type, event.entity, event.entity_id AS entityId,
        event.payload, event.source_mutation_id AS sourceMutationId, event.occurred_at AS occurredAt
      FROM domain_events AS event
      JOIN authorized_fields AS authorized_field ON authorized_field.id = event.field_id
      WHERE event.organization_id = ?
        AND event.sequence > ?
        AND (? IS NULL OR event.field_id = ?)
      ORDER BY event.sequence ASC
      LIMIT ?
    )
    SELECT 0 AS authorizationMarker, sequence, id, organizationId, fieldId, type, entity,
      entityId, payload, sourceMutationId, occurredAt
    FROM selected_events
    UNION ALL
    SELECT 1 AS authorizationMarker, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    WHERE EXISTS (SELECT 1 FROM current_member)
      AND EXISTS (
        SELECT 1 FROM authorized_fields
        WHERE ? IS NULL OR id = ?
      )
    ORDER BY authorizationMarker ASC, sequence ASC
  `).bind(
    DEMO_EMAIL,
    input.actor.membershipId,
    input.actor.organizationId,
    input.actor.email.trim().toLowerCase(),
    input.actor.organizationId,
    input.cursor,
    requestedFieldId,
    requestedFieldId,
    input.limit,
    requestedFieldId,
    requestedFieldId,
  ).all<PullEventQueryRow>();
  const authorized = result.results.some((row) => Number(row.authorizationMarker) === 1);
  if (!authorized) {
    throw new SyncRequestError("La membresía o el acceso al fundo cambió antes de completar la sincronización.", 403);
  }
  const rows = result.results
    .filter((row) => Number(row.authorizationMarker) === 0)
    .map(toDomainEventRecord);
  return {
    events: rows,
    nextCursor: rows.at(-1)?.sequence ?? input.cursor,
  };
}

export class SyncRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SyncRequestError";
    this.status = status;
  }
}

type PullEventQueryRow = {
  authorizationMarker: number;
  sequence: number | null;
  id: string | null;
  organizationId: string | null;
  fieldId: string | null;
  type: string | null;
  entity: string | null;
  entityId: string | null;
  payload: string | null;
  sourceMutationId: string | null;
  occurredAt: string | null;
};

function toDomainEventRecord(row: PullEventQueryRow): DomainEventRecord {
  if (row.sequence === null || row.id === null || row.organizationId === null || row.fieldId === null
    || row.type === null || row.entity === null || row.entityId === null || row.payload === null
    || row.occurredAt === null) {
    throw new SyncRequestError("No fue posible leer los eventos sincronizados.", 503);
  }
  return {
    sequence: Number(row.sequence),
    id: row.id,
    organizationId: row.organizationId,
    fieldId: row.fieldId,
    type: row.type,
    entity: row.entity,
    entityId: row.entityId,
    payload: JSON.parse(row.payload) as Record<string, SyncJsonValue>,
    sourceMutationId: row.sourceMutationId,
    occurredAt: row.occurredAt,
  };
}

async function applyMutation(actor: AccessContext, mutation: SyncMutationInput): Promise<SyncMutationResult> {
  if (!await hasCurrentSyncWriteAccess(actor, mutation.fieldId)) {
    return accessRevokedResult(mutation.id);
  }
  let existing = await findMutation(mutation.id);
  if (existing && (existing.organizationId !== actor.organizationId || existing.actor !== actor.email)) {
    return rejectedResult(mutation.id, "El ULID ya pertenece a otra mutación.");
  }
  const latestVersion = await findLatestVersion(actor.organizationId, mutation);
  let decision = decideSyncMutation({
    mutation,
    existing,
    latestVersion,
    allowedFieldIds: actor.fieldIds,
  });
  if (decision.action === "reject") return rejectedResult(mutation.id, decision.reason);
  if (decision.action === "replay") return storedResult(existing!, true);

  if (!existing) {
    await reserveMutation(actor, mutation);
    existing = await findMutation(mutation.id);
    if (!existing) return accessRevokedResult(mutation.id);
    if (existing && (existing.organizationId !== actor.organizationId || existing.actor !== actor.email)) {
      return rejectedResult(mutation.id, "El ULID ya pertenece a otra mutación.");
    }
    decision = decideSyncMutation({ mutation, existing, latestVersion, allowedFieldIds: actor.fieldIds });
    if (decision.action === "reject") return rejectedResult(mutation.id, decision.reason);
    if (decision.action === "replay") return storedResult(existing!, true);
  }

  try {
    if (decision.action === "conflict") {
      return finalizeConflict(actor, mutation, decision.reason, latestVersion);
    }

    if (isGeographicSyncEntity(mutation.entity)) {
      const projection = await applyGeographicSyncMutation(actor, mutation);
      if (projection.action === "conflict") {
        return finalizeConflict(actor, mutation, projection.reason, projection.serverVersion);
      }
      return finalizeApplied(actor, mutation, projection);
    }

    const projection = await applyOfflineFieldCapture(actor, mutation);
    if (projection.action === "conflict") {
      return finalizeConflict(actor, mutation, projection.reason, latestVersion);
    }

    return finalizeApplied(actor, mutation);
  } catch (cause) {
    if (cause instanceof SyncWriteAccessRevokedError) return accessRevokedResult(mutation.id);
    throw cause;
  }
}

async function reserveMutation(actor: AccessContext, mutation: SyncMutationInput): Promise<void> {
  const access = syncWriteAccessCondition(actor, mutation.fieldId);
  await getDb().$client.prepare(`
    INSERT INTO sync_mutations (
      id, organization_id, field_id, actor, entity, entity_id, op,
      payload, client_ts, expected_version, status
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending'
    WHERE ${access.sql}
    ON CONFLICT(id) DO NOTHING
  `).bind(
    mutation.id,
    actor.organizationId,
    mutation.fieldId,
    actor.email,
    mutation.entity,
    mutation.entityId,
    mutation.op,
    stableStringify(mutation.payload),
    mutation.clientTs,
    mutation.expectedVersion ?? null,
    ...access.bindings,
  ).run();
}

async function findMutation(id: string): Promise<StoredMutation | null> {
  const [row] = await getDb().select().from(syncMutations).where(eq(syncMutations.id, id)).limit(1);
  return row ?? null;
}

async function findLatestVersion(organizationId: string, mutation: SyncMutationInput): Promise<string | null> {
  if (mutation.entity !== "field_note") return null;
  const row = await getDb().$client.prepare(`
    SELECT source_mutation_id AS "sourceMutationId"
    FROM domain_events
    WHERE organization_id = ? AND field_id = ? AND entity = ? AND entity_id = ?
    ORDER BY sequence DESC
    LIMIT 1
  `).bind(organizationId, mutation.fieldId, mutation.entity, mutation.entityId)
    .first<{ sourceMutationId: string | null }>();
  return row?.sourceMutationId ?? null;
}

async function finalizeApplied(
  actor: AccessContext,
  mutation: SyncMutationInput,
  projection?: { eventPayload: Record<string, SyncJsonValue>; eventType: string; serverVersion: string },
): Promise<SyncMutationResult> {
  const client = getDb().$client;
  const now = new Date().toISOString();
  const eventId = `event:${mutation.id}`;
  const version = projection?.serverVersion ?? mutation.id;
  const payload = stableStringify(projection?.eventPayload ?? mutation.payload);
  const access = syncWriteAccessCondition(actor, mutation.fieldId);
  const pending = `EXISTS (
    SELECT 1 FROM sync_mutations AS pending_mutation
    WHERE pending_mutation.id = ?
      AND pending_mutation.organization_id = ?
      AND pending_mutation.field_id = ?
      AND pending_mutation.actor = ?
      AND pending_mutation.status = 'pending'
  )`;
  const pendingBindings = [mutation.id, actor.organizationId, mutation.fieldId, actor.email];
  const results = await client.batch([
    client.prepare(`
      INSERT INTO domain_events
        (id, organization_id, field_id, type, entity, entity_id, payload, source_mutation_id, actor, occurred_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE ${pending} AND ${access.sql}
    `).bind(
      eventId,
      actor.organizationId,
      mutation.fieldId,
      projection?.eventType ?? `${mutation.entity}.${mutation.op === "update" ? "updated" : "created"}`,
      mutation.entity,
      mutation.entityId,
      payload,
      mutation.id,
      actor.email,
      now,
      ...pendingBindings,
      ...access.bindings,
    ),
    client.prepare(`
      INSERT INTO audit_log
        (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
      SELECT ?, ?, ?, ?, 'sync.mutation.applied', ?, ?, NULL, ?, ?
      WHERE ${pending} AND ${access.sql}
    `).bind(
      `audit:${mutation.id}`,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      mutation.entity,
      mutation.entityId,
      stableStringify({ mutationId: mutation.id, eventId, version }),
      now,
      ...pendingBindings,
      ...access.bindings,
    ),
    client.prepare(`
      UPDATE sync_mutations
      SET status = 'applied', applied_at = ?, conflict_reason = NULL, event_id = ?, server_version = ?
      WHERE id = ? AND organization_id = ? AND field_id = ? AND actor = ? AND status = 'pending'
        AND ${access.sql}
    `).bind(
      now,
      eventId,
      version,
      mutation.id,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      ...access.bindings,
    ),
    client.prepare(`
      SELECT CASE
        WHEN NOT (${access.sql}) THEN 0
        WHEN EXISTS (
          SELECT 1 FROM sync_mutations AS completed_mutation
          WHERE completed_mutation.id = ?
            AND completed_mutation.organization_id = ?
            AND completed_mutation.field_id = ?
            AND completed_mutation.actor = ?
            AND completed_mutation.status = 'applied'
            AND completed_mutation.event_id = ?
            AND completed_mutation.server_version = ?
        ) AND EXISTS (
          SELECT 1 FROM domain_events AS completed_event
          WHERE completed_event.id = ?
            AND completed_event.organization_id = ?
            AND completed_event.field_id = ?
            AND completed_event.source_mutation_id = ?
            AND completed_event.actor = ?
        ) AND EXISTS (
          SELECT 1 FROM audit_log AS completed_audit
          WHERE completed_audit.id = ?
            AND completed_audit.organization_id = ?
            AND completed_audit.field_id = ?
            AND completed_audit.actor = ?
            AND completed_audit.action = 'sync.mutation.applied'
        ) THEN 1
        WHEN EXISTS (
          SELECT 1 FROM sync_mutations AS terminal_mutation
          WHERE terminal_mutation.id = ?
            AND terminal_mutation.organization_id = ?
            AND terminal_mutation.field_id = ?
            AND terminal_mutation.actor = ?
            AND terminal_mutation.status <> 'pending'
        ) THEN 2
        ELSE abs(-9223372036854775807 - 1)
      END AS complete
    `).bind(
      ...access.bindings,
      mutation.id,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      eventId,
      version,
      eventId,
      actor.organizationId,
      mutation.fieldId,
      mutation.id,
      actor.email,
      `audit:${mutation.id}`,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      mutation.id,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
    ),
  ]);
  const completion = Number((results[3]?.results[0] as { complete?: number } | undefined)?.complete);
  if (completion === 0) {
    return accessRevokedResult(mutation.id);
  }
  if (completion === 2 || results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
    const stored = await findMutation(mutation.id);
    return stored && stored.status !== "pending"
      ? storedResult(stored, true)
      : rejectedResult(mutation.id, "La mutacion cambio antes de confirmar su resultado.");
  }
  return { id: mutation.id, status: "applied", replay: false, eventId, serverVersion: version, conflictReason: null };
}

async function finalizeConflict(
  actor: AccessContext,
  mutation: SyncMutationInput,
  reason: string,
  serverVersion: string | null,
): Promise<SyncMutationResult> {
  const client = getDb().$client;
  const now = new Date().toISOString();
  const access = syncWriteAccessCondition(actor, mutation.fieldId);
  const pending = `EXISTS (
    SELECT 1 FROM sync_mutations AS pending_mutation
    WHERE pending_mutation.id = ?
      AND pending_mutation.organization_id = ?
      AND pending_mutation.field_id = ?
      AND pending_mutation.actor = ?
      AND pending_mutation.status = 'pending'
  )`;
  const pendingBindings = [mutation.id, actor.organizationId, mutation.fieldId, actor.email];
  const results = await client.batch([
    client.prepare(`
      INSERT INTO audit_log
        (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
      SELECT ?, ?, ?, ?, 'sync.mutation.conflict', ?, ?, NULL, ?, ?
      WHERE ${pending} AND ${access.sql}
    `).bind(
      `audit:${mutation.id}`,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      mutation.entity,
      mutation.entityId,
      stableStringify({
        mutationId: mutation.id,
        clientTs: mutation.clientTs,
        expectedVersion: mutation.expectedVersion ?? null,
        serverVersion,
        reason,
      }),
      now,
      ...pendingBindings,
      ...access.bindings,
    ),
    client.prepare(`
      UPDATE sync_mutations
      SET status = 'conflict', applied_at = ?, conflict_reason = ?, server_version = ?
      WHERE id = ? AND organization_id = ? AND field_id = ? AND actor = ? AND status = 'pending'
        AND ${access.sql}
    `).bind(
      now,
      reason,
      serverVersion,
      mutation.id,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      ...access.bindings,
    ),
    client.prepare(`
      SELECT CASE
        WHEN NOT (${access.sql}) THEN 0
        WHEN EXISTS (
          SELECT 1 FROM sync_mutations AS completed_mutation
          WHERE completed_mutation.id = ?
            AND completed_mutation.organization_id = ?
            AND completed_mutation.field_id = ?
            AND completed_mutation.actor = ?
            AND completed_mutation.status = 'conflict'
            AND completed_mutation.conflict_reason = ?
            AND completed_mutation.server_version IS ?
        ) AND EXISTS (
          SELECT 1 FROM audit_log AS completed_audit
          WHERE completed_audit.id = ?
            AND completed_audit.organization_id = ?
            AND completed_audit.field_id = ?
            AND completed_audit.actor = ?
            AND completed_audit.action = 'sync.mutation.conflict'
        ) THEN 1
        WHEN EXISTS (
          SELECT 1 FROM sync_mutations AS terminal_mutation
          WHERE terminal_mutation.id = ?
            AND terminal_mutation.organization_id = ?
            AND terminal_mutation.field_id = ?
            AND terminal_mutation.actor = ?
            AND terminal_mutation.status <> 'pending'
        ) THEN 2
        ELSE abs(-9223372036854775807 - 1)
      END AS complete
    `).bind(
      ...access.bindings,
      mutation.id,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      reason,
      serverVersion,
      `audit:${mutation.id}`,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
      mutation.id,
      actor.organizationId,
      mutation.fieldId,
      actor.email,
    ),
  ]);
  const completion = Number((results[2]?.results[0] as { complete?: number } | undefined)?.complete);
  if (completion === 0) {
    return accessRevokedResult(mutation.id);
  }
  if (completion === 2 || results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
    const stored = await findMutation(mutation.id);
    return stored && stored.status !== "pending"
      ? storedResult(stored, true)
      : rejectedResult(mutation.id, "La mutacion cambio antes de confirmar el conflicto.");
  }
  return {
    id: mutation.id,
    status: "conflict",
    replay: false,
    eventId: null,
    serverVersion,
    conflictReason: reason,
  };
}

function storedResult(row: StoredMutation, replay: boolean): SyncMutationResult {
  return {
    id: row.id,
    status: row.status === "pending" ? "rejected" : row.status,
    replay,
    eventId: row.eventId,
    serverVersion: row.serverVersion,
    conflictReason: row.status === "pending" ? "La mutación quedó pendiente y se reintentará." : row.conflictReason,
  };
}

function rejectedResult(id: string, reason: string): SyncMutationResult {
  return { id, status: "rejected", replay: false, eventId: null, serverVersion: null, conflictReason: reason };
}

function accessRevokedResult(id: string): SyncMutationResult {
  return rejectedResult(id, "La membresia o el acceso al fundo cambio antes de confirmar la captura.");
}

function parseMutation(value: unknown): SyncMutationInput | string {
  const error = validateSyncMutation(value);
  if (error) return error;
  const candidate = value as {
    id: string;
    fieldId: string;
    entity: SyncMutationInput["entity"];
    entityId: string;
    op: SyncMutationInput["op"];
    payload: Record<string, SyncJsonValue>;
    clientTs: string;
    expectedVersion?: string | null;
  };
  return {
    id: candidate.id,
    fieldId: candidate.fieldId.trim(),
    entity: candidate.entity,
    entityId: candidate.entityId.trim(),
    op: candidate.op,
    payload: candidate.payload,
    clientTs: candidate.clientTs,
    expectedVersion: candidate.expectedVersion?.trim() || null,
  };
}

function readUntrustedId(value: unknown, index: number): string {
  if (value && typeof value === "object" && !Array.isArray(value) && "id" in value && typeof value.id === "string") {
    return value.id.slice(0, 64);
  }
  return `invalid:${index}`;
}
