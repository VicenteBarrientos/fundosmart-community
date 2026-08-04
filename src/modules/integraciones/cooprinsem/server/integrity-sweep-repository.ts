import { getDb } from "@/db";
import {
  fields,
  importJobs,
  originalIntegrityIncidents,
  originalIntegritySweepStates,
} from "@/db/schema";
import { and, asc, desc, eq, gt, isNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  CooprinsemIntegrityIncidentType,
  CooprinsemIntegritySweepBatchResult,
  CooprinsemIntegritySweepDashboard,
  CooprinsemIntegritySweepTrigger,
} from "../domain/types";
import { sha256Hex } from "./backup-format.mjs";
import { readImportFile } from "./file-storage";
import {
  INTEGRITY_SWEEP_MAX_FILE_BYTES,
  selectIntegritySweepBatch,
  summarizeIntegritySweepResults,
} from "./integrity-sweep-rules.mjs";
import { assessDeepOriginalIntegrity } from "./original-integrity.mjs";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import {
  currentCooprinsemActorFieldGuard,
  hasCurrentCooprinsemActorFieldAccess,
  normalizeCooprinsemActorFieldAccess,
  type CooprinsemActorFieldAccess,
  type NormalizedCooprinsemActorFieldAccess,
} from "./current-actor-access";

const CANDIDATE_LOOKAHEAD = 32;
const LEASE_MILLISECONDS = 5 * 60 * 1000;
const RETRY_MILLISECONDS = 15 * 60 * 1000;
const CYCLE_MILLISECONDS = 7 * 24 * 60 * 60 * 1000;

type SweepCandidate = {
  importJobId: string;
  organizationId: string;
  fieldId: string;
  originalFilename: string;
  sourceTable: string;
  fileSizeBytes: number;
  sha256: string;
  objectKey: string;
  createdAt: string;
};

type CheckedOriginal = {
  candidate: SweepCandidate;
  status: "healthy" | CooprinsemIntegrityIncidentType;
  issues: string[];
  storedSizeBytes: number | null;
  calculatedSha256: string | null;
  readBytes: number;
};

export type IntegritySweepFieldAccess = CooprinsemActorFieldAccess;

export class IntegritySweepScopeError extends Error {
  readonly code = "INTEGRITY_SWEEP_SCOPE_CHANGED";

  constructor() {
    super("El alcance cambió durante la verificación; vuelve a iniciar el lote.");
    this.name = "IntegritySweepScopeError";
  }
}

type NormalizedSweepAccess = NormalizedCooprinsemActorFieldAccess | null;

export async function runDueOriginalIntegritySweep(input: {
  trigger: "scheduled";
  actor?: string;
}): Promise<CooprinsemIntegritySweepBatchResult> {
  const now = new Date().toISOString();
  const fieldCount = await ensureSweepStates(now, input.trigger);
  if (fieldCount === 0) return emptyBatchResult("no_fields");
  const [due] = await getDb()
    .select({ fieldId: originalIntegritySweepStates.fieldId })
    .from(originalIntegritySweepStates)
    .where(and(
      lte(originalIntegritySweepStates.nextRunAt, now),
      or(isNull(originalIntegritySweepStates.leaseToken), lt(originalIntegritySweepStates.leaseExpiresAt, now)),
    ))
    .orderBy(asc(originalIntegritySweepStates.nextRunAt), asc(originalIntegritySweepStates.fieldId))
    .limit(1);
  if (!due) return emptyBatchResult("not_due");
  return runOriginalIntegritySweepBatch({
    fieldId: due.fieldId,
    trigger: input.trigger,
    actor: input.actor ?? "system:integrity-scheduler",
    force: false,
  });
}

export async function runOriginalIntegritySweepBatch(input: {
  fieldId: string;
  trigger: CooprinsemIntegritySweepTrigger;
  actor: string;
  force?: boolean;
  access?: IntegritySweepFieldAccess;
}): Promise<CooprinsemIntegritySweepBatchResult> {
  const now = new Date().toISOString();
  const access = normalizeSweepAccess(input.access);
  if (input.access && !access) throw new IntegritySweepScopeError();
  if (access && input.actor.trim().toLowerCase() !== access.actorEmail) throw new IntegritySweepScopeError();
  if (access && !access.fieldIds.includes(input.fieldId)) throw new IntegritySweepScopeError();
  const scope = await ensureSweepState(input.fieldId, now, input.trigger, access);
  if (!scope) {
    if (access) throw new IntegritySweepScopeError();
    return emptyBatchResult("no_fields");
  }
  const db = getDb();
  const current = scope.state;
  if (!input.force && current.nextRunAt > now) return { ...emptyBatchResult("not_due"), fieldId: input.fieldId, cycleId: current.cycleId };

  const restartCycle = ["completed", "completed_with_issues"].includes(current.status);
  const cycleId = restartCycle ? crypto.randomUUID() : current.cycleId;
  const leaseToken = crypto.randomUUID();
  const leaseExpiresAt = isoAfter(now, LEASE_MILLISECONDS);
  const leaseAvailable = sql`(${originalIntegritySweepStates.leaseToken} IS NULL OR ${originalIntegritySweepStates.leaseExpiresAt} < ${now})`;
  const fieldGuard = currentFieldGuard(input.fieldId, scope.organizationId, access);
  const claimBase = and(
    eq(originalIntegritySweepStates.fieldId, input.fieldId),
    eq(originalIntegritySweepStates.organizationId, scope.organizationId),
    leaseAvailable,
    fieldGuard,
  );
  const claimCondition = input.force
    ? claimBase
    : and(claimBase, lte(originalIntegritySweepStates.nextRunAt, now));
  const [claimed] = await db.update(originalIntegritySweepStates).set({
    cycleId,
    status: "running",
    lastTrigger: input.trigger,
    cursorCreatedAt: restartCycle ? null : current.cursorCreatedAt,
    cursorImportJobId: restartCycle ? null : current.cursorImportJobId,
    checkedCount: restartCycle ? 0 : current.checkedCount,
    healthyCount: restartCycle ? 0 : current.healthyCount,
    missingCount: restartCycle ? 0 : current.missingCount,
    mismatchCount: restartCycle ? 0 : current.mismatchCount,
    readBytes: restartCycle ? 0 : current.readBytes,
    leaseToken,
    leaseExpiresAt,
    lastStartedAt: restartCycle || !current.lastStartedAt ? now : current.lastStartedAt,
    completedAt: restartCycle ? null : current.completedAt,
    nextRunAt: now,
    lastError: null,
    updatedAt: now,
  }).where(claimCondition).returning();
  if (!claimed) {
    if (access && !await hasCurrentSweepScope(input.fieldId, scope.organizationId, access)) {
      throw new IntegritySweepScopeError();
    }
    return { ...emptyBatchResult("busy"), fieldId: input.fieldId, cycleId: current.cycleId };
  }

  try {
    const cursorCondition = claimed.cursorCreatedAt && claimed.cursorImportJobId
      ? or(
          gt(importJobs.createdAt, claimed.cursorCreatedAt),
          and(eq(importJobs.createdAt, claimed.cursorCreatedAt), gt(importJobs.id, claimed.cursorImportJobId)),
        )
      : undefined;
    const candidates = await db.select({
      importJobId: importJobs.id,
      organizationId: importJobs.organizationId,
      fieldId: importJobs.fieldId,
      originalFilename: importJobs.originalFilename,
      sourceTable: importJobs.sourceTable,
      fileSizeBytes: importJobs.fileSizeBytes,
      sha256: importJobs.sha256,
      objectKey: importJobs.objectKey,
      createdAt: importJobs.createdAt,
    }).from(importJobs)
      .where(and(
        eq(importJobs.fieldId, input.fieldId),
        eq(importJobs.organizationId, scope.organizationId),
        fieldGuard,
        cursorCondition,
      ))
      .orderBy(asc(importJobs.createdAt), asc(importJobs.id))
      .limit(CANDIDATE_LOOKAHEAD);
    const selection = selectIntegritySweepBatch(candidates);
    const results: CheckedOriginal[] = [];
    for (const candidate of selection.selected) results.push(await checkOriginal(candidate));
    const summary = summarizeIntegritySweepResults(results);
    const last = selection.selected.at(-1);
    const cumulativeMissing = claimed.missingCount + summary.missingCount;
    const cumulativeMismatch = claimed.mismatchCount + summary.mismatchCount;
    const completed = !selection.hasMore;
    const completedStatus = cumulativeMissing + cumulativeMismatch > 0 ? "completed_with_issues" : "completed";
    await finalizeSweepBatch({
      access,
      actor: input.actor,
      claimed,
      completed,
      completedStatus,
      fieldId: input.fieldId,
      last,
      now,
      organizationId: scope.organizationId,
      results,
      summary,
      trigger: input.trigger,
    });
    return {
      outcome: "processed",
      fieldId: input.fieldId,
      cycleId: claimed.cycleId,
      processedCount: summary.processedCount,
      healthyCount: summary.healthyCount,
      issueCount: summary.issueCount,
      readBytes: summary.readBytes,
      completed,
    };
  } catch (cause) {
    const scopeChanged = cause instanceof IntegritySweepScopeError || isSweepAssertionFailure(cause);
    const message = cause instanceof Error && cause.message.includes("almacenamiento privado")
      ? "El almacenamiento privado R2 no estuvo disponible durante el lote."
      : "No fue posible leer o verificar el siguiente original.";
    await db.update(originalIntegritySweepStates).set({
      status: scopeChanged ? "pending" : "failed",
      leaseToken: null,
      leaseExpiresAt: null,
      nextRunAt: scopeChanged ? now : isoAfter(now, RETRY_MILLISECONDS),
      lastError: scopeChanged ? null : message.slice(0, 1_000),
      updatedAt: now,
    }).where(and(
      eq(originalIntegritySweepStates.fieldId, input.fieldId),
      eq(originalIntegritySweepStates.organizationId, scope.organizationId),
      eq(originalIntegritySweepStates.cycleId, claimed.cycleId),
      eq(originalIntegritySweepStates.leaseToken, leaseToken),
    ));
    if (scopeChanged) throw new IntegritySweepScopeError();
    throw cause;
  }
}

export async function getOriginalIntegritySweepDashboard(
  input: IntegritySweepFieldAccess & { fieldId: string },
): Promise<CooprinsemIntegritySweepDashboard | null> {
  const access = normalizeSweepAccess(input);
  if (!access?.fieldIds.includes(input.fieldId)) return null;
  if (!await hasCurrentCooprinsemActorFieldAccess(input.fieldId, access)) return null;
  const db = getDb();
  const [scope] = await db.select({ fieldId: fields.id, fieldName: fields.name, organizationId: fields.organizationId })
    .from(fields).where(and(
      eq(fields.id, input.fieldId),
      eq(fields.organizationId, access.organizationId),
      sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
    )).limit(1);
  if (!scope) return null;
  const [state, incidents] = await Promise.all([
    db.select().from(originalIntegritySweepStates)
      .where(and(
        eq(originalIntegritySweepStates.fieldId, input.fieldId),
        eq(originalIntegritySweepStates.organizationId, access.organizationId),
      )).limit(1).then((rows) => rows[0] ?? null),
    db.select({
      id: originalIntegrityIncidents.id,
      importJobId: originalIntegrityIncidents.importJobId,
      originalFilename: importJobs.originalFilename,
      issueType: originalIntegrityIncidents.issueType,
      summary: originalIntegrityIncidents.summary,
      expectedSizeBytes: originalIntegrityIncidents.expectedSizeBytes,
      storedSizeBytes: originalIntegrityIncidents.storedSizeBytes,
      firstDetectedAt: originalIntegrityIncidents.firstDetectedAt,
      lastDetectedAt: originalIntegrityIncidents.lastDetectedAt,
    }).from(originalIntegrityIncidents)
      .innerJoin(importJobs, and(
        eq(importJobs.id, originalIntegrityIncidents.importJobId),
        eq(importJobs.organizationId, originalIntegrityIncidents.organizationId),
        eq(importJobs.fieldId, originalIntegrityIncidents.fieldId),
      ))
      .where(and(
        eq(originalIntegrityIncidents.organizationId, access.organizationId),
        eq(originalIntegrityIncidents.fieldId, input.fieldId),
        eq(originalIntegrityIncidents.status, "open"),
      ))
      .orderBy(desc(originalIntegrityIncidents.lastDetectedAt))
      .limit(50),
  ]);
  const [currentScope] = await db.select({ fieldId: fields.id, fieldName: fields.name, organizationId: fields.organizationId })
    .from(fields).where(and(
      eq(fields.id, scope.fieldId),
      eq(fields.organizationId, scope.organizationId),
      eq(fields.name, scope.fieldName),
      sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
    )).limit(1);
  if (!currentScope || !await hasCurrentCooprinsemActorFieldAccess(input.fieldId, access)) return null;
  return {
    fieldId: scope.fieldId,
    fieldName: scope.fieldName,
    state: state ? {
      cycleId: state.cycleId,
      status: state.status,
      lastTrigger: state.lastTrigger,
      checkedCount: state.checkedCount,
      healthyCount: state.healthyCount,
      missingCount: state.missingCount,
      mismatchCount: state.mismatchCount,
      readBytes: state.readBytes,
      lastStartedAt: state.lastStartedAt,
      lastBatchAt: state.lastBatchAt,
      completedAt: state.completedAt,
      nextRunAt: state.nextRunAt,
      lastError: state.lastError,
    } : null,
    openIncidents: incidents,
  };
}

async function ensureSweepStates(now: string, trigger: CooprinsemIntegritySweepTrigger): Promise<number> {
  const db = getDb();
  const scopes = await db.select({ fieldId: fields.id, organizationId: fields.organizationId }).from(fields);
  for (const scope of scopes) {
    await db.insert(originalIntegritySweepStates).values({
      fieldId: scope.fieldId,
      organizationId: scope.organizationId,
      cycleId: crypto.randomUUID(),
      status: "pending",
      lastTrigger: trigger,
      nextRunAt: now,
      updatedAt: now,
    }).onConflictDoNothing();
  }
  return scopes.length;
}

async function ensureSweepState(
  fieldId: string,
  now: string,
  trigger: CooprinsemIntegritySweepTrigger,
  access: NormalizedSweepAccess,
) {
  const db = getDb();
  const actorGuard = access ? currentCooprinsemActorFieldGuard("current_field", access) : null;
  await db.$client.prepare(`
    INSERT INTO original_integrity_sweep_states (
      field_id, organization_id, cycle_id, status, last_trigger, next_run_at, updated_at
    )
    SELECT current_field.id, current_field.organization_id, ?, 'pending', ?, ?, ?
    FROM fields AS current_field
    WHERE current_field.id = ?
      ${actorGuard ? `AND ${actorGuard.sql}` : ""}
    ON CONFLICT(field_id) DO UPDATE SET
      organization_id = excluded.organization_id,
      cycle_id = excluded.cycle_id,
      status = 'pending',
      cursor_created_at = NULL,
      cursor_import_job_id = NULL,
      checked_count = 0,
      healthy_count = 0,
      missing_count = 0,
      mismatch_count = 0,
      read_bytes = 0,
      lease_token = NULL,
      lease_expires_at = NULL,
      last_trigger = excluded.last_trigger,
      last_started_at = NULL,
      last_batch_at = NULL,
      completed_at = NULL,
      next_run_at = excluded.next_run_at,
      last_error = NULL,
      updated_at = excluded.updated_at
    WHERE original_integrity_sweep_states.organization_id <> excluded.organization_id
      AND (
        original_integrity_sweep_states.lease_token IS NULL
        OR original_integrity_sweep_states.lease_expires_at < ?
      )
  `).bind(
    crypto.randomUUID(), trigger, now, now, fieldId,
    ...(actorGuard?.bindings ?? []),
    now,
  ).run();
  const [result] = await db.select({
    fieldId: fields.id,
    organizationId: fields.organizationId,
    state: originalIntegritySweepStates,
  }).from(fields).innerJoin(originalIntegritySweepStates, and(
    eq(originalIntegritySweepStates.fieldId, fields.id),
    eq(originalIntegritySweepStates.organizationId, fields.organizationId),
  )).where(and(
    eq(fields.id, fieldId),
    access ? currentFieldGuard(fieldId, access.organizationId, access) : undefined,
  )).limit(1);
  return result ?? null;
}

async function checkOriginal(candidate: SweepCandidate): Promise<CheckedOriginal> {
  if (candidate.fileSizeBytes > INTEGRITY_SWEEP_MAX_FILE_BYTES) {
    return {
      candidate,
      status: "size_limit",
      issues: ["El original supera 20 MB y requiere un verificador asíncrono de archivos grandes."],
      storedSizeBytes: null,
      calculatedSha256: null,
      readBytes: 0,
    };
  }
  const object = await readImportFile(candidate.objectKey);
  let calculatedSha256: string | null = null;
  let readBytes = 0;
  if (object && object.size === candidate.fileSizeBytes) {
    const bytes = await object.arrayBuffer();
    readBytes = bytes.byteLength;
    calculatedSha256 = await sha256Hex(bytes);
  }
  const assessment = assessDeepOriginalIntegrity(candidate, object ? {
    size: object.size,
    customMetadata: object.customMetadata,
  } : null, calculatedSha256);
  return {
    candidate,
    status: assessment.status,
    issues: assessment.issues,
    storedSizeBytes: object?.size ?? null,
    calculatedSha256,
    readBytes,
  };
}

async function finalizeSweepBatch(input: {
  access: NormalizedSweepAccess;
  actor: string;
  claimed: typeof originalIntegritySweepStates.$inferSelect;
  completed: boolean;
  completedStatus: "completed" | "completed_with_issues";
  fieldId: string;
  last: SweepCandidate | undefined;
  now: string;
  organizationId: string;
  results: CheckedOriginal[];
  summary: ReturnType<typeof summarizeIntegritySweepResults>;
  trigger: CooprinsemIntegritySweepTrigger;
}): Promise<void> {
  const client = getDb().$client;
  const system = input.access ? 0 : 1;
  const actorGuard = input.access
    ? currentCooprinsemActorFieldGuard("current_field", input.access)
    : { sql: "0 = 1", bindings: [] };
  const candidateSnapshotJson = JSON.stringify(input.results.map(({ candidate }) => candidate));
  const resultSnapshot = input.results.map((result) => ({
    importJobId: result.candidate.importJobId,
    status: result.status,
    summary: result.issues.join(" ") || "El original requiere revisión.",
    expectedSizeBytes: result.candidate.fileSizeBytes,
    storedSizeBytes: result.storedSizeBytes,
    expectedSha256: result.candidate.sha256,
    calculatedSha256: result.calculatedSha256,
  }));
  const resultSnapshotJson = JSON.stringify(resultSnapshot);
  const auditId = `original-integrity-sweep:${input.claimed.cycleId}:${input.last?.importJobId ?? "empty"}`;
  const auditAfter = JSON.stringify({
    cycleId: input.claimed.cycleId,
    trigger: input.trigger,
    processedCount: input.summary.processedCount,
    healthyCount: input.summary.healthyCount,
    issueCount: input.summary.issueCount,
    readBytes: input.summary.readBytes,
    completed: input.completed,
    cursorImportJobId: input.last?.importJobId ?? input.claimed.cursorImportJobId,
  });
  const audit = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, sweep.organization_id, sweep.field_id, ?,
      'import.originals.sweep.batch', 'field', ?, NULL, ?, NULL, ?
    FROM original_integrity_sweep_states AS sweep
    INNER JOIN fields AS current_field
      ON current_field.id = sweep.field_id
      AND current_field.organization_id = sweep.organization_id
    WHERE sweep.field_id = ? AND sweep.organization_id = ?
      AND sweep.cycle_id = ? AND sweep.lease_token = ? AND sweep.status = 'running'
      AND (? = 1 OR (${actorGuard.sql}))
      AND NOT EXISTS (SELECT 1 FROM audit_log AS existing_audit WHERE existing_audit.id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS expected
        WHERE NOT EXISTS (
          SELECT 1 FROM import_jobs AS current_job
          WHERE current_job.id = CAST(json_extract(expected.value, '$.importJobId') AS TEXT)
            AND current_job.organization_id = sweep.organization_id
            AND current_job.field_id = sweep.field_id
            AND current_job.original_filename = CAST(json_extract(expected.value, '$.originalFilename') AS TEXT)
            AND current_job.source_table = CAST(json_extract(expected.value, '$.sourceTable') AS TEXT)
            AND current_job.file_size_bytes = CAST(json_extract(expected.value, '$.fileSizeBytes') AS INTEGER)
            AND current_job.sha256 = CAST(json_extract(expected.value, '$.sha256') AS TEXT)
            AND current_job.object_key = CAST(json_extract(expected.value, '$.objectKey') AS TEXT)
            AND current_job.created_at = CAST(json_extract(expected.value, '$.createdAt') AS TEXT)
        )
      )
  `).bind(
    auditId, input.actor, input.fieldId, auditAfter, input.now,
    input.fieldId, input.organizationId, input.claimed.cycleId, input.claimed.leaseToken,
    system, ...actorGuard.bindings,
    auditId, candidateSnapshotJson,
  );
  const incidentStatements = input.results.map((result) => guardedIncidentStatement(
    client,
    result,
    input.now,
    auditId,
    input.organizationId,
    input.fieldId,
  ));
  const finalStatus = input.completed ? input.completedStatus : "pending";
  const finalCursorCreatedAt = input.last?.createdAt ?? input.claimed.cursorCreatedAt;
  const finalCursorImportJobId = input.last?.importJobId ?? input.claimed.cursorImportJobId;
  const finalCheckedCount = input.claimed.checkedCount + input.summary.processedCount;
  const finalHealthyCount = input.claimed.healthyCount + input.summary.healthyCount;
  const finalMissingCount = input.claimed.missingCount + input.summary.missingCount;
  const finalMismatchCount = input.claimed.mismatchCount + input.summary.mismatchCount;
  const finalReadBytes = input.claimed.readBytes + input.summary.readBytes;
  const finalCompletedAt = input.completed ? input.now : null;
  const finalNextRunAt = input.completed ? isoAfter(input.now, CYCLE_MILLISECONDS) : input.now;
  const updateState = client.prepare(`
    UPDATE original_integrity_sweep_states
    SET status = ?, cursor_created_at = ?, cursor_import_job_id = ?,
      checked_count = ?, healthy_count = ?, missing_count = ?, mismatch_count = ?, read_bytes = ?,
      lease_token = NULL, lease_expires_at = NULL, last_batch_at = ?, completed_at = ?,
      next_run_at = ?, last_error = NULL, updated_at = ?
    WHERE field_id = ? AND organization_id = ? AND cycle_id = ?
      AND lease_token = ? AND status = 'running'
      AND EXISTS (
        SELECT 1 FROM audit_log AS guard_audit
        WHERE guard_audit.id = ? AND guard_audit.organization_id = ?
          AND guard_audit.field_id = ? AND guard_audit.actor = ?
          AND guard_audit.action = 'import.originals.sweep.batch'
          AND guard_audit.entity_type = 'field' AND guard_audit.entity_id = ?
          AND guard_audit.before IS NULL AND guard_audit.after = ?
          AND guard_audit.source_record_id IS NULL AND guard_audit.occurred_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = original_integrity_sweep_states.field_id
          AND current_field.organization_id = original_integrity_sweep_states.organization_id
          AND (? = 1 OR (${actorGuard.sql}))
      )
  `).bind(
    finalStatus, finalCursorCreatedAt, finalCursorImportJobId,
    finalCheckedCount, finalHealthyCount, finalMissingCount, finalMismatchCount, finalReadBytes,
    input.now, finalCompletedAt, finalNextRunAt, input.now,
    input.fieldId, input.organizationId, input.claimed.cycleId, input.claimed.leaseToken,
    auditId, input.organizationId, input.fieldId, input.actor, input.fieldId, auditAfter, input.now,
    system, ...actorGuard.bindings,
  );
  const assertion = guardedSweepAssertion({
    actorGuard,
    actor: input.actor,
    auditAfter,
    auditId,
    client,
    fieldId: input.fieldId,
    finalCheckedCount,
    finalCompletedAt,
    finalCursorCreatedAt,
    finalCursorImportJobId,
    finalHealthyCount,
    finalMismatchCount,
    finalMissingCount,
    finalNextRunAt,
    finalReadBytes,
    finalStatus,
    now: input.now,
    organizationId: input.organizationId,
    resultSnapshotJson,
    system,
    cycleId: input.claimed.cycleId,
  });
  try {
    const responses = await client.batch([audit, ...incidentStatements, updateState, assertion]);
    const finalResponse = responses.at(-1);
    if ((finalResponse?.results[0] as { complete?: number } | undefined)?.complete !== 1) {
      throw new IntegritySweepScopeError();
    }
  } catch (cause) {
    if (cause instanceof IntegritySweepScopeError) throw cause;
    if (isSweepAssertionFailure(cause)) throw new IntegritySweepScopeError();
    throw cause;
  }
}

function guardedIncidentStatement(
  client: ReturnType<typeof getDb>["$client"],
  result: CheckedOriginal,
  now: string,
  auditId: string,
  organizationId: string,
  fieldId: string,
) {
  if (result.status === "healthy") {
    return client.prepare(`
      UPDATE original_integrity_incidents
      SET status = 'resolved', resolved_at = ?, updated_at = ?
      WHERE import_job_id = ? AND organization_id = ? AND field_id = ? AND status = 'open'
        AND EXISTS (
          SELECT 1 FROM audit_log AS guard_audit
          WHERE guard_audit.id = ? AND guard_audit.organization_id = ? AND guard_audit.field_id = ?
        )
    `).bind(now, now, result.candidate.importJobId, organizationId, fieldId, auditId, organizationId, fieldId);
  }
  const summary = result.issues.join(" ") || "El original requiere revisión.";
  return client.prepare(`
    INSERT INTO original_integrity_incidents (
      id, organization_id, field_id, import_job_id, status, issue_type, summary,
      expected_size_bytes, stored_size_bytes, expected_sha256, calculated_sha256,
      first_detected_at, last_detected_at, resolved_at, updated_at
    )
    SELECT ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?
    FROM audit_log AS guard_audit
    WHERE guard_audit.id = ? AND guard_audit.organization_id = ? AND guard_audit.field_id = ?
    ON CONFLICT(import_job_id) DO UPDATE SET
      status = 'open', issue_type = excluded.issue_type, summary = excluded.summary,
      expected_size_bytes = excluded.expected_size_bytes,
      stored_size_bytes = excluded.stored_size_bytes,
      expected_sha256 = excluded.expected_sha256,
      calculated_sha256 = excluded.calculated_sha256,
      last_detected_at = excluded.last_detected_at,
      resolved_at = NULL,
      updated_at = excluded.updated_at
    WHERE original_integrity_incidents.organization_id = excluded.organization_id
      AND original_integrity_incidents.field_id = excluded.field_id
  `).bind(
    `original-integrity-incident:${result.candidate.importJobId}`,
    organizationId, fieldId, result.candidate.importJobId,
    result.status, summary, result.candidate.fileSizeBytes, result.storedSizeBytes,
    result.candidate.sha256, result.calculatedSha256, now, now, now,
    auditId, organizationId, fieldId,
  );
}

function guardedSweepAssertion(input: {
  actor: string;
  actorGuard: { sql: string; bindings: string[] };
  auditAfter: string;
  auditId: string;
  client: ReturnType<typeof getDb>["$client"];
  cycleId: string;
  fieldId: string;
  finalCheckedCount: number;
  finalCompletedAt: string | null;
  finalCursorCreatedAt: string | null;
  finalCursorImportJobId: string | null;
  finalHealthyCount: number;
  finalMismatchCount: number;
  finalMissingCount: number;
  finalNextRunAt: string;
  finalReadBytes: number;
  finalStatus: string;
  now: string;
  organizationId: string;
  resultSnapshotJson: string;
  system: number;
}) {
  return input.client.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM audit_log AS guard_audit
        WHERE guard_audit.id = ? AND guard_audit.organization_id = ?
          AND guard_audit.field_id = ? AND guard_audit.actor = ?
          AND guard_audit.action = 'import.originals.sweep.batch'
          AND guard_audit.entity_type = 'field' AND guard_audit.entity_id = ?
          AND guard_audit.before IS NULL AND guard_audit.after = ?
          AND guard_audit.source_record_id IS NULL AND guard_audit.occurred_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM original_integrity_sweep_states AS final_state
        INNER JOIN fields AS current_field
          ON current_field.id = final_state.field_id
          AND current_field.organization_id = final_state.organization_id
        WHERE final_state.field_id = ? AND final_state.organization_id = ?
          AND final_state.cycle_id = ? AND final_state.status = ?
          AND final_state.cursor_created_at IS ? AND final_state.cursor_import_job_id IS ?
          AND final_state.checked_count = ? AND final_state.healthy_count = ?
          AND final_state.missing_count = ? AND final_state.mismatch_count = ?
          AND final_state.read_bytes = ? AND final_state.lease_token IS NULL
          AND final_state.lease_expires_at IS NULL AND final_state.last_batch_at = ?
          AND final_state.completed_at IS ? AND final_state.next_run_at = ?
          AND final_state.last_error IS NULL AND final_state.updated_at = ?
          AND (? = 1 OR (${input.actorGuard.sql}))
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS expected
        WHERE (
          json_extract(expected.value, '$.status') = 'healthy'
          AND EXISTS (
            SELECT 1 FROM original_integrity_incidents AS open_incident
            WHERE open_incident.import_job_id = CAST(json_extract(expected.value, '$.importJobId') AS TEXT)
              AND open_incident.status = 'open'
          )
        ) OR (
          json_extract(expected.value, '$.status') <> 'healthy'
          AND NOT EXISTS (
            SELECT 1 FROM original_integrity_incidents AS current_incident
            WHERE current_incident.import_job_id = CAST(json_extract(expected.value, '$.importJobId') AS TEXT)
              AND current_incident.organization_id = ? AND current_incident.field_id = ?
              AND current_incident.status = 'open'
              AND current_incident.issue_type = CAST(json_extract(expected.value, '$.status') AS TEXT)
              AND current_incident.summary = CAST(json_extract(expected.value, '$.summary') AS TEXT)
              AND current_incident.expected_size_bytes = CAST(json_extract(expected.value, '$.expectedSizeBytes') AS INTEGER)
              AND current_incident.stored_size_bytes IS json_extract(expected.value, '$.storedSizeBytes')
              AND current_incident.expected_sha256 = CAST(json_extract(expected.value, '$.expectedSha256') AS TEXT)
              AND current_incident.calculated_sha256 IS json_extract(expected.value, '$.calculatedSha256')
              AND current_incident.last_detected_at = ? AND current_incident.resolved_at IS NULL
              AND current_incident.updated_at = ?
          )
        )
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.auditId, input.organizationId, input.fieldId, input.actor,
    input.fieldId, input.auditAfter, input.now,
    input.fieldId, input.organizationId, input.cycleId, input.finalStatus,
    input.finalCursorCreatedAt, input.finalCursorImportJobId,
    input.finalCheckedCount, input.finalHealthyCount, input.finalMissingCount,
    input.finalMismatchCount, input.finalReadBytes,
    input.now, input.finalCompletedAt, input.finalNextRunAt, input.now,
    input.system, ...input.actorGuard.bindings,
    input.resultSnapshotJson, input.organizationId, input.fieldId, input.now, input.now,
  );
}

function normalizeSweepAccess(access: IntegritySweepFieldAccess | undefined): NormalizedSweepAccess {
  if (!access) return null;
  return normalizeCooprinsemActorFieldAccess(access);
}

function currentFieldGuard(fieldId: string, organizationId: string, access: NormalizedSweepAccess) {
  const system = access ? 0 : 1;
  return sql`EXISTS (
    SELECT 1 FROM fields AS current_field
    WHERE current_field.id = ${fieldId}
      AND current_field.organization_id = ${organizationId}
      AND (${system} = 1 OR (
        current_field.organization_id = ${access?.organizationId ?? ""}
        AND current_field.id IN (
          SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access?.fieldIds ?? [])})
        )
        AND current_field.is_demo = 0
        AND EXISTS (
          SELECT 1 FROM organization_memberships AS current_actor
          WHERE current_actor.id = ${access?.membershipId ?? ""}
            AND current_actor.organization_id = current_field.organization_id
            AND current_actor.normalized_email = ${access?.actorEmail ?? ""}
            AND current_actor.normalized_email <> ${DEMO_EMAIL}
            AND current_actor.status = 'active'
            AND current_actor.role IN ('owner', 'admin', 'manager')
            AND (
              current_actor.role IN ('owner', 'admin')
              OR EXISTS (
                SELECT 1 FROM membership_field_access AS current_scope
                WHERE current_scope.membership_id = current_actor.id
                  AND current_scope.field_id = current_field.id
              )
            )
        )
      ))
  )`;
}

async function hasCurrentSweepScope(
  fieldId: string,
  organizationId: string,
  access: NormalizedSweepAccess,
): Promise<boolean> {
  if (access) return hasCurrentCooprinsemActorFieldAccess(fieldId, access);
  const [current] = await getDb().select({ fieldId: fields.id }).from(fields).where(and(
    eq(fields.id, fieldId),
    eq(fields.organizationId, organizationId),
  )).limit(1);
  return Boolean(current);
}

function isSweepAssertionFailure(cause: unknown): boolean {
  return cause instanceof Error && /integer overflow/i.test(cause.message);
}

function emptyBatchResult(outcome: CooprinsemIntegritySweepBatchResult["outcome"]): CooprinsemIntegritySweepBatchResult {
  return { outcome, fieldId: null, cycleId: null, processedCount: 0, healthyCount: 0, issueCount: 0, readBytes: 0, completed: false };
}

function isoAfter(value: string, milliseconds: number): string {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}
