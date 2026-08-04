import { getDb } from "@/db";
import { env } from "cloudflare:workers";

export type PabcoEvidenceAccess = {
  organizationId: string;
  fieldId: string;
  actor: string;
};

export type PendingPabcoEvidence = PabcoEvidenceAccess & {
  id: string;
  objectKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  compensationAttempts: number;
  createdAt: string;
};

export type PabcoEvidenceReference = {
  id: string;
  objectKey: string;
  organizationId: string;
  fieldId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string | null;
  etag: string;
  legacy: boolean;
};

type StoredObjectIdentity = {
  size: number;
  httpEtag?: string;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
};

type D1Binding = string | number | null;

export class PabcoEvidenceScopeError extends Error {
  readonly code = "FIELD_SCOPE_CONFLICT";

  constructor() {
    super("Tu acceso al fundo cambió durante la carga. Actualiza la página e inténtalo nuevamente.");
    this.name = "PabcoEvidenceScopeError";
  }
}

export class PabcoEvidenceCompensationError extends Error {
  readonly code = "PABCO_EVIDENCE_COMPENSATION_FAILED";
  readonly uploadCause: unknown;

  constructor(options: { cause: unknown; uploadCause?: unknown }) {
    super("No fue posible revertir de forma verificable el documento PABCO rechazado.", {
      cause: options.cause,
    });
    this.name = "PabcoEvidenceCompensationError";
    this.uploadCause = options.uploadCause;
  }
}

export async function createPendingPabcoEvidence(
  input: PabcoEvidenceAccess & {
    filename: string;
    contentType: string;
    sizeBytes: number;
    sha256: string;
    createdAt: string;
  },
): Promise<PendingPabcoEvidence> {
  const id = `pabco-evidence-${crypto.randomUUID()}`;
  const objectKey = `pabco-evidence/${id}`;
  const actor = normalizeEmail(input.actor);
  const pending: PendingPabcoEvidence = {
    ...input,
    actor,
    id,
    objectKey,
    filename: input.filename.slice(0, 200),
    compensationAttempts: 0,
  };
  const client = getDb().$client;
  const accessSql = currentEvidenceAccessSql(true);
  const accessBindings = [actor, input.fieldId, input.organizationId];
  try {
    const [insertResult] = await client.batch([
      client.prepare(`
        INSERT INTO pabco_evidence_documents (
          id, object_key, organization_id, field_id, filename, content_type,
          size_bytes, sha256, etag, status, requested_by,
          compensation_attempts, last_error, next_retry_at, stored_at,
          created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?, 0, NULL, NULL, NULL, ?, ?
        WHERE ${accessSql}
          AND NOT EXISTS (
            SELECT 1 FROM pabco_evidence_documents WHERE id = ? OR object_key = ?
          )
      `).bind(
        pending.id,
        pending.objectKey,
        pending.organizationId,
        pending.fieldId,
        pending.filename,
        pending.contentType,
        pending.sizeBytes,
        pending.sha256,
        actor,
        pending.createdAt,
        pending.createdAt,
        ...accessBindings,
        pending.id,
        pending.objectKey,
      ),
      client.prepare(`
        SELECT CASE WHEN (
          changes() = 1
          AND EXISTS (
            SELECT 1 FROM pabco_evidence_documents
            WHERE id = ?
              AND object_key = ?
              AND organization_id = ?
              AND field_id = ?
              AND filename = ?
              AND content_type = ?
              AND size_bytes = ?
              AND sha256 = ?
              AND etag IS NULL
              AND status = 'pending'
              AND requested_by = ?
              AND compensation_attempts = 0
              AND last_error IS NULL
              AND next_retry_at IS NULL
              AND stored_at IS NULL
              AND created_at = ?
              AND updated_at = ?
          )
          AND ${accessSql}
        ) THEN 1 ELSE json_extract('fundosmart_pabco_evidence_scope_conflict', '$') END
          AS pabco_evidence_postcondition
      `).bind(
        pending.id,
        pending.objectKey,
        pending.organizationId,
        pending.fieldId,
        pending.filename,
        pending.contentType,
        pending.sizeBytes,
        pending.sha256,
        actor,
        pending.createdAt,
        pending.createdAt,
        ...accessBindings,
      ),
    ]);
    if (insertResult.meta.changes !== 1) throw new PabcoEvidenceScopeError();
    return pending;
  } catch (cause) {
    if (isPostconditionFailure(cause)) throw new PabcoEvidenceScopeError();
    throw cause;
  }
}

export async function completePabcoEvidence(
  pending: PendingPabcoEvidence,
  etag: string,
  storedAt: string,
): Promise<void> {
  const client = getDb().$client;
  const auditId = crypto.randomUUID();
  const actor = normalizeEmail(pending.actor);
  const after = JSON.stringify({
    documentId: pending.id,
    filename: pending.filename,
    contentType: pending.contentType,
    size: pending.sizeBytes,
    sha256: pending.sha256,
    etag,
  });
  const accessSql = currentEvidenceAccessSql(true);
  const accessBindings = [actor, pending.fieldId, pending.organizationId];
  const storedRowSql = storedEvidenceSnapshotSql();
  const storedRowBindings = storedEvidenceSnapshotBindings(pending, etag, storedAt);
  try {
    const [updateResult, auditResult] = await client.batch([
      client.prepare(`
        UPDATE pabco_evidence_documents
        SET etag = ?, status = 'stored', stored_at = ?, updated_at = ?,
            last_error = NULL, next_retry_at = NULL
        WHERE id = ?
          AND object_key = ?
          AND organization_id = ?
          AND field_id = ?
          AND filename = ?
          AND content_type = ?
          AND size_bytes = ?
          AND sha256 = ?
          AND requested_by = ?
          AND compensation_attempts = ?
          AND status = 'pending'
          AND etag IS NULL
          AND stored_at IS NULL
          AND ${accessSql}
      `).bind(
        etag,
        storedAt,
        storedAt,
        pending.id,
        pending.objectKey,
        pending.organizationId,
        pending.fieldId,
        pending.filename,
        pending.contentType,
        pending.sizeBytes,
        pending.sha256,
        actor,
        pending.compensationAttempts,
        ...accessBindings,
      ),
      client.prepare(`
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          before, after, source_record_id, occurred_at
        )
        SELECT ?, ?, ?, ?, 'pabco.evidence.uploaded',
          'pabco_evidence_document', ?, NULL, ?, NULL, ?
        WHERE EXISTS (
          SELECT 1 FROM pabco_evidence_documents WHERE ${storedRowSql}
        ) AND ${accessSql}
      `).bind(
        auditId,
        pending.organizationId,
        pending.fieldId,
        actor,
        pending.id,
        after,
        storedAt,
        ...storedRowBindings,
        ...accessBindings,
      ),
      client.prepare(`
        SELECT CASE WHEN (
          changes() = 1
          AND EXISTS (
            SELECT 1 FROM pabco_evidence_documents WHERE ${storedRowSql}
          )
          AND EXISTS (
            SELECT 1 FROM audit_log
            WHERE id = ?
              AND organization_id = ?
              AND field_id = ?
              AND actor = ?
              AND action = 'pabco.evidence.uploaded'
              AND entity_type = 'pabco_evidence_document'
              AND entity_id = ?
              AND before IS NULL
              AND after IS ?
              AND source_record_id IS NULL
              AND occurred_at = ?
          )
          AND ${accessSql}
        ) THEN 1 ELSE json_extract('fundosmart_pabco_evidence_scope_conflict', '$') END
          AS pabco_evidence_postcondition
      `).bind(
        ...storedRowBindings,
        auditId,
        pending.organizationId,
        pending.fieldId,
        actor,
        pending.id,
        after,
        storedAt,
        ...accessBindings,
      ),
    ]);
    if (updateResult.meta.changes !== 1 || auditResult.meta.changes !== 1) {
      throw new PabcoEvidenceScopeError();
    }
  } catch (cause) {
    if (isPostconditionFailure(cause)) throw new PabcoEvidenceScopeError();
    throw cause;
  }
}

export async function markPabcoEvidenceCompensationPending(
  pending: PendingPabcoEvidence,
  etag: string,
  now: string,
): Promise<void> {
  const nextRetryAt = new Date(Date.parse(now) + 15 * 60 * 1000).toISOString();
  const client = getDb().$client;
  await client.batch([
    client.prepare(`
      UPDATE pabco_evidence_documents
      SET etag = ?, status = 'compensation_pending',
          compensation_attempts = ?,
          last_error = 'FINALIZATION_REJECTED', next_retry_at = ?, updated_at = ?
      WHERE id = ?
        AND object_key = ?
        AND organization_id = ?
        AND field_id = ?
        AND size_bytes = ?
        AND sha256 = ?
        AND status = 'pending'
        AND etag IS NULL
        AND compensation_attempts = ?
    `).bind(
      etag,
      pending.compensationAttempts + 1,
      nextRetryAt,
      now,
      pending.id,
      pending.objectKey,
      pending.organizationId,
      pending.fieldId,
      pending.sizeBytes,
      pending.sha256,
      pending.compensationAttempts,
    ),
    client.prepare(`
      SELECT CASE WHEN (
        changes() = 1
        AND EXISTS (
          SELECT 1 FROM pabco_evidence_documents
          WHERE id = ? AND object_key = ? AND status = 'compensation_pending'
            AND etag = ? AND compensation_attempts = ?
            AND last_error = 'FINALIZATION_REJECTED'
            AND next_retry_at = ? AND updated_at = ?
        )
      ) THEN 1 ELSE json_extract('fundosmart_pabco_evidence_tracking_conflict', '$') END
        AS pabco_evidence_tracking_postcondition
    `).bind(
      pending.id,
      pending.objectKey,
      etag,
      pending.compensationAttempts + 1,
      nextRetryAt,
      now,
    ),
  ]);
}

export async function abandonPabcoEvidence(
  pending: PendingPabcoEvidence,
  etag: string | null,
): Promise<void> {
  const client = getDb().$client;
  await client.batch([
    client.prepare(`
      DELETE FROM pabco_evidence_documents
      WHERE id = ? AND object_key = ? AND organization_id = ? AND field_id = ?
        AND size_bytes = ? AND sha256 = ?
        AND (
          (status = 'pending' AND etag IS NULL AND ? IS NULL)
          OR (status = 'compensation_pending' AND etag = ?)
        )
    `).bind(
      pending.id,
      pending.objectKey,
      pending.organizationId,
      pending.fieldId,
      pending.sizeBytes,
      pending.sha256,
      etag,
      etag,
    ),
    client.prepare(`
      SELECT CASE WHEN (
        changes() = 1
        AND NOT EXISTS (
          SELECT 1 FROM pabco_evidence_documents WHERE id = ? OR object_key = ?
        )
      ) THEN 1 ELSE json_extract('fundosmart_pabco_evidence_cleanup_conflict', '$') END
        AS pabco_evidence_cleanup_postcondition
    `).bind(pending.id, pending.objectKey),
  ]);
}

export async function getPabcoEvidenceLifecycleState(
  pending: PendingPabcoEvidence,
  etag: string,
): Promise<"pending" | "stored" | "compensation_pending" | "missing" | "conflict"> {
  const actor = normalizeEmail(pending.actor);
  const state = await getDb().$client.prepare(`
    SELECT CASE
      WHEN document.status = 'stored'
        AND document.etag = ?
        AND EXISTS (
          SELECT 1 FROM audit_log AS uploaded
          WHERE uploaded.organization_id = document.organization_id
            AND uploaded.field_id = document.field_id
            AND uploaded.actor = document.requested_by
            AND uploaded.action = 'pabco.evidence.uploaded'
            AND uploaded.entity_type = 'pabco_evidence_document'
            AND uploaded.entity_id = document.id
            AND json_extract(uploaded.after, '$.etag') = document.etag
            AND json_extract(uploaded.after, '$.sha256') = document.sha256
            AND CAST(json_extract(uploaded.after, '$.size') AS INTEGER) = document.size_bytes
        ) THEN 'stored'
      WHEN document.status = 'pending' AND document.etag IS NULL THEN 'pending'
      WHEN document.status = 'compensation_pending' AND document.etag = ?
        THEN 'compensation_pending'
      ELSE 'conflict'
    END AS state
    FROM pabco_evidence_documents AS document
    WHERE document.id = ?
      AND document.object_key = ?
      AND document.organization_id = ?
      AND document.field_id = ?
      AND document.filename = ?
      AND document.content_type = ?
      AND document.size_bytes = ?
      AND document.sha256 = ?
      AND document.requested_by = ?
    LIMIT 1
  `).bind(
    etag,
    etag,
    pending.id,
    pending.objectKey,
    pending.organizationId,
    pending.fieldId,
    pending.filename,
    pending.contentType,
    pending.sizeBytes,
    pending.sha256,
    actor,
  ).first<string>("state");
  return state === "pending" || state === "stored" ||
      state === "compensation_pending" || state === "conflict"
    ? state
    : "missing";
}

export async function getPabcoEvidenceReference(input: {
  id: string;
  membershipId: string;
  organizationId: string;
  actor: string;
}): Promise<PabcoEvidenceReference | null> {
  const actor = normalizeEmail(input.actor);
  const client = getDb().$client;
  const currentAccessSql = currentEvidenceAccessForRowSql("document", false);
  const current = await client.prepare(`
    SELECT
      document.id,
      document.object_key AS objectKey,
      document.organization_id AS organizationId,
      document.field_id AS fieldId,
      document.filename,
      document.content_type AS contentType,
      document.size_bytes AS sizeBytes,
      document.sha256,
      document.etag
    FROM pabco_evidence_documents AS document
    WHERE document.id = ?
      AND document.organization_id = ?
      AND document.status = 'stored'
      AND document.etag IS NOT NULL
      AND ${currentAccessSql}
    LIMIT 1
  `).bind(input.id, input.organizationId, input.membershipId, actor).first<Omit<PabcoEvidenceReference, "legacy">>();
  if (current) return { ...current, legacy: false };

  if (!input.id.startsWith("pabco/")) return null;
  const legacy = await client.prepare(`
    SELECT
      uploaded.entity_id AS id,
      uploaded.entity_id AS objectKey,
      uploaded.organization_id AS organizationId,
      uploaded.field_id AS fieldId,
      COALESCE(json_extract(uploaded.after, '$.filename'), 'evidencia') AS filename,
      COALESCE(json_extract(uploaded.after, '$.contentType'), 'application/octet-stream') AS contentType,
      CAST(json_extract(uploaded.after, '$.size') AS INTEGER) AS sizeBytes,
      NULL AS sha256,
      json_extract(uploaded.after, '$.etag') AS etag
    FROM audit_log AS uploaded
    WHERE uploaded.entity_id = ?
      AND uploaded.organization_id = ?
      AND uploaded.action = 'pabco.evidence.uploaded'
      AND uploaded.entity_type = 'pabco_evidence_document'
      AND uploaded.field_id IS NOT NULL
      AND json_type(uploaded.after, '$.size') IN ('integer', 'real')
      AND json_type(uploaded.after, '$.etag') = 'text'
      AND ${currentEvidenceAccessForRowSql("uploaded", false)}
    ORDER BY uploaded.occurred_at DESC
    LIMIT 1
  `).bind(input.id, input.organizationId, input.membershipId, actor).first<Omit<PabcoEvidenceReference, "legacy">>();
  return legacy ? { ...legacy, legacy: true } : null;
}

export function matchesPabcoEvidenceObject(
  reference: PabcoEvidenceReference,
  object: StoredObjectIdentity,
): boolean {
  if (
    object.size !== reference.sizeBytes ||
    object.httpEtag !== reference.etag ||
    object.customMetadata?.organizationId !== reference.organizationId ||
    object.customMetadata?.fieldId !== reference.fieldId
  ) {
    return false;
  }
  if (reference.legacy) return true;
  return (
    object.customMetadata?.documentId === reference.id &&
    object.customMetadata?.sha256 === reference.sha256 &&
    object.customMetadata?.sizeBytes === String(reference.sizeBytes) &&
    object.checksums?.sha256 !== undefined &&
    arrayBufferHex(object.checksums.sha256) === reference.sha256
  );
}

export async function compensatePabcoEvidenceObject(
  objectKey: string,
  uploadCause?: unknown,
): Promise<void> {
  try {
    if (!env.FILES) throw new Error("El almacenamiento privado no está disponible.");
    await env.FILES.delete(objectKey);
    if (await env.FILES.head(objectKey)) {
      throw new Error("El documento PABCO no pudo eliminarse de forma verificable.");
    }
  } catch (cause) {
    throw new PabcoEvidenceCompensationError({ cause, uploadCause });
  }
}

type ReconciliationRow = {
  id: string;
  objectKey: string;
  organizationId: string;
  fieldId: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  etag: string | null;
  status: "pending" | "compensation_pending";
  requestedBy: string;
  compensationAttempts: number;
  createdAt: string;
};

export async function runDuePabcoEvidenceReconciliation(options: {
  now?: string;
  limit?: number;
} = {}): Promise<{
  examined: number;
  stored: number;
  compensated: number;
  abandoned: number;
  failures: number;
}> {
  if (!env.FILES) throw new Error("El almacenamiento privado no está disponible.");
  const now = options.now ?? new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - 30 * 60 * 1000).toISOString();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));
  const candidates = await getDb().$client.prepare(`
    SELECT
      id,
      object_key AS objectKey,
      organization_id AS organizationId,
      field_id AS fieldId,
      filename,
      content_type AS contentType,
      size_bytes AS sizeBytes,
      sha256,
      etag,
      status,
      requested_by AS requestedBy,
      compensation_attempts AS compensationAttempts,
      created_at AS createdAt
    FROM pabco_evidence_documents
    WHERE (
      status = 'compensation_pending'
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ) OR (
      status = 'pending'
      AND created_at <= ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    )
    ORDER BY COALESCE(next_retry_at, created_at), created_at, id
    LIMIT ?
  `).bind(now, staleBefore, now, limit).all<ReconciliationRow>();
  const result = {
    examined: candidates.results.length,
    stored: 0,
    compensated: 0,
    abandoned: 0,
    failures: 0,
  };
  for (const row of candidates.results) {
    const pending = pendingFromReconciliationRow(row);
    try {
      const object = await env.FILES.head(row.objectKey);
      if (!object) {
        await abandonPabcoEvidence(pending, row.etag);
        result.abandoned += 1;
        continue;
      }
      const objectEtag = object.httpEtag;
      const expectedEtag = row.status === "compensation_pending"
        ? row.etag
        : objectEtag;
      const reference: PabcoEvidenceReference | null = expectedEtag
        ? reconciliationReference(row, expectedEtag)
        : null;
      if (!reference || !matchesPabcoEvidenceObject(reference, object)) {
        await recordPabcoEvidenceRetry(row, "STORAGE_IDENTITY_MISMATCH", now);
        result.failures += 1;
        continue;
      }
      if (row.status === "compensation_pending") {
        await compensatePabcoEvidenceObject(row.objectKey);
        await abandonPabcoEvidence(pending, row.etag);
        result.compensated += 1;
        continue;
      }
      try {
        await completePabcoEvidence(pending, objectEtag, now);
        result.stored += 1;
      } catch (cause) {
        if (!(cause instanceof PabcoEvidenceScopeError)) throw cause;
        await markPabcoEvidenceCompensationPending(pending, objectEtag, now);
        await compensatePabcoEvidenceObject(row.objectKey, cause);
        await abandonPabcoEvidence(pending, objectEtag);
        result.compensated += 1;
      }
    } catch {
      try {
        await recordPabcoEvidenceRetry(row, "RECONCILIATION_RETRY", now);
      } catch {
        // A concurrent request may have completed or removed this exact lifecycle row.
      }
      result.failures += 1;
    }
  }
  return result;
}

function pendingFromReconciliationRow(row: ReconciliationRow): PendingPabcoEvidence {
  return {
    id: row.id,
    objectKey: row.objectKey,
    organizationId: row.organizationId,
    fieldId: row.fieldId,
    actor: row.requestedBy,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    compensationAttempts: row.compensationAttempts,
    createdAt: row.createdAt,
  };
}

function reconciliationReference(
  row: ReconciliationRow,
  etag: string,
): PabcoEvidenceReference {
  return {
    id: row.id,
    objectKey: row.objectKey,
    organizationId: row.organizationId,
    fieldId: row.fieldId,
    filename: row.filename,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    etag,
    legacy: false,
  };
}

async function recordPabcoEvidenceRetry(
  row: ReconciliationRow,
  errorCode: "STORAGE_IDENTITY_MISMATCH" | "RECONCILIATION_RETRY",
  now: string,
): Promise<void> {
  const client = getDb().$client;
  const attempts = row.compensationAttempts + 1;
  const retryMinutes = Math.min(360, 15 * 2 ** Math.min(5, attempts));
  const nextRetryAt = new Date(Date.parse(now) + retryMinutes * 60 * 1000).toISOString();
  await client.batch([
    client.prepare(`
      UPDATE pabco_evidence_documents
      SET compensation_attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ? AND object_key = ? AND status = ?
        AND etag IS ? AND compensation_attempts = ?
    `).bind(
      attempts,
      errorCode,
      nextRetryAt,
      now,
      row.id,
      row.objectKey,
      row.status,
      row.etag,
      row.compensationAttempts,
    ),
    client.prepare(`
      SELECT CASE WHEN (
        changes() = 1
        AND EXISTS (
          SELECT 1 FROM pabco_evidence_documents
          WHERE id = ? AND object_key = ? AND status = ? AND etag IS ?
            AND compensation_attempts = ? AND last_error = ?
            AND next_retry_at = ? AND updated_at = ?
        )
      ) THEN 1 ELSE json_extract('fundosmart_pabco_evidence_retry_conflict', '$') END
        AS pabco_evidence_retry_postcondition
    `).bind(
      row.id,
      row.objectKey,
      row.status,
      row.etag,
      attempts,
      errorCode,
      nextRetryAt,
      now,
    ),
  ]);
}

function storedEvidenceSnapshotSql(): string {
  return `
    id = ? AND object_key = ? AND organization_id = ? AND field_id = ?
    AND filename = ? AND content_type = ? AND size_bytes = ? AND sha256 = ?
    AND etag = ? AND status = 'stored' AND requested_by = ?
    AND compensation_attempts = ?
    AND stored_at = ? AND updated_at = ?
  `;
}

function storedEvidenceSnapshotBindings(
  pending: PendingPabcoEvidence,
  etag: string,
  storedAt: string,
): D1Binding[] {
  return [
    pending.id,
    pending.objectKey,
    pending.organizationId,
    pending.fieldId,
    pending.filename,
    pending.contentType,
    pending.sizeBytes,
    pending.sha256,
    etag,
    normalizeEmail(pending.actor),
    pending.compensationAttempts,
    storedAt,
    storedAt,
  ];
}

function currentEvidenceAccessSql(requireOperate: boolean): string {
  const scopedRoles = requireOperate
    ? "('manager', 'operator')"
    : "('manager', 'operator', 'viewer')";
  return `EXISTS (
    SELECT 1
    FROM fields AS current_field
    JOIN organization_memberships AS membership
      ON membership.organization_id = current_field.organization_id
     AND membership.normalized_email = ?
     AND membership.status = 'active'
    LEFT JOIN membership_field_access AS field_access
      ON field_access.membership_id = membership.id
     AND field_access.field_id = current_field.id
    WHERE current_field.id = ?
      AND current_field.organization_id = ?
      AND (
        membership.role IN ('owner', 'admin')
        OR (membership.role IN ${scopedRoles} AND field_access.field_id IS NOT NULL)
      )
  )`;
}

function currentEvidenceAccessForRowSql(alias: string, requireOperate: boolean): string {
  const scopedRoles = requireOperate
    ? "('manager', 'operator')"
    : "('manager', 'operator', 'viewer')";
  return `EXISTS (
    SELECT 1
    FROM fields AS current_field
    JOIN organization_memberships AS membership
      ON membership.id = ?
     AND membership.organization_id = current_field.organization_id
     AND membership.normalized_email = ?
     AND membership.status = 'active'
    LEFT JOIN membership_field_access AS field_access
      ON field_access.membership_id = membership.id
     AND field_access.field_id = current_field.id
    WHERE current_field.id = ${alias}.field_id
      AND current_field.organization_id = ${alias}.organization_id
      AND current_field.is_demo = 0
      AND (
        membership.role IN ('owner', 'admin')
        OR (membership.role IN ${scopedRoles} AND field_access.field_id IS NOT NULL)
      )
  )`;
}

function isPostconditionFailure(cause: unknown): boolean {
  return cause instanceof Error && cause.message.includes("malformed JSON");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function arrayBufferHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
