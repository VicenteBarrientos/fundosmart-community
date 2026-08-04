import { getDb } from "@/db";
import { fields, restoreConfirmationTokens, restoreRecoveryJobs, restoreRecoveryObjects } from "@/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  buildRecoveryPreparationStatements,
  recoveryPreparationMatches,
} from "./recovery-job-preparation.mjs";
import { prepareRecoveryJobSpec, type PreparedRecoverySpec } from "./recovery-job-rules.mjs";
import {
  buildRestoreActorAccess,
  buildRestoreConfirmationBinding,
  restoreConfirmationTokenSha256,
  validateRestoreConfirmation,
  type RestoreActorAccess,
  type RestoreConfirmationBinding,
} from "./restore-confirmation-rules.mjs";
import type { RestoreFieldAccess } from "./restore-confirmation-repository";

type RecoveryOriginalInput = { importJobId: string; sha256: string; fileSizeBytes: number };

export type DurableRecoveryPreparationReceipt = {
  recoveryJobId: string;
  status: "prepared";
  preparedAt: string;
  expectedRowCount: number;
  originalFileCount: number;
  executionEnabled: false;
  idempotent: boolean;
};

export type RecoveryPreparationErrorCode =
  | "CONFIRMATION_NOT_FOUND"
  | "CONFIRMATION_INVALID"
  | "PREPARATION_CONFLICT"
  | "PREPARATION_FAILED";

export class RecoveryPreparationError extends Error {
  constructor(message: string, readonly code: RecoveryPreparationErrorCode) {
    super(message);
    this.name = "RecoveryPreparationError";
  }
}

export async function prepareDurableRecoveryJob(input: RestoreConfirmationBinding & {
  token: string;
  expectedRowCount: number;
  originalFiles: RecoveryOriginalInput[];
  now?: string;
} & RestoreFieldAccess): Promise<DurableRecoveryPreparationReceipt> {
  const binding = buildRestoreConfirmationBinding(input);
  const access = buildRestoreActorAccess(input, binding.actorEmail);
  if (!access?.fieldIds.includes(binding.fieldId)) throw preparationError("CONFIRMATION_NOT_FOUND");
  const now = input.now ?? new Date().toISOString();
  const tokenSha256 = await restoreConfirmationTokenSha256(input.token, access.membershipId);
  const db = getDb();
  const confirmation = await loadConfirmation(tokenSha256, binding, access);
  if (!confirmation) throw preparationError("CONFIRMATION_NOT_FOUND");

  const candidate = prepareRecoveryJobSpec({
    jobId: `restore-recovery-${crypto.randomUUID()}`,
    confirmationTokenId: confirmation.id,
    binding,
    originalFiles: input.originalFiles,
    expectedRowCount: input.expectedRowCount,
    now,
  });
  const existing = await loadPreparedRecovery(confirmation.id, binding, access);
  if (existing) return existingReceipt(existing, candidate, true);

  const validation = validateRestoreConfirmation(confirmation, binding, now);
  if (!validation.valid) throw preparationError("CONFIRMATION_INVALID");
  const statements = buildRecoveryPreparationStatements(candidate, tokenSha256, access.fieldIds, access);
  const client = db.$client;
  try {
    await client.batch(statements.map((statement) => client.prepare(statement.sql).bind(...statement.params)));
  } catch {
    const raced = await loadPreparedRecovery(confirmation.id, binding, access);
    if (raced) return existingReceipt(raced, candidate, true);
    if (!await loadConfirmation(tokenSha256, binding, access)) {
      throw preparationError("CONFIRMATION_INVALID");
    }
    throw preparationError("PREPARATION_FAILED");
  }
  const created = await loadPreparedRecovery(confirmation.id, binding, access);
  if (!created) throw preparationError("CONFIRMATION_INVALID");
  return existingReceipt(created, candidate, false);
}

async function loadConfirmation(
  tokenSha256: string,
  binding: RestoreConfirmationBinding,
  access: RestoreActorAccess,
) {
  const db = getDb();
  const [result] = await db.select({ confirmation: restoreConfirmationTokens })
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
  return result?.confirmation ?? null;
}

async function loadPreparedRecovery(
  confirmationTokenId: string,
  binding: RestoreConfirmationBinding,
  access: RestoreActorAccess,
) {
  const db = getDb();
  const [result] = await db.select({ job: restoreRecoveryJobs })
    .from(restoreRecoveryJobs)
    .innerJoin(restoreConfirmationTokens, and(
      eq(restoreConfirmationTokens.id, restoreRecoveryJobs.confirmationTokenId),
      eq(restoreConfirmationTokens.organizationId, restoreRecoveryJobs.organizationId),
      eq(restoreConfirmationTokens.fieldId, restoreRecoveryJobs.fieldId),
      eq(restoreConfirmationTokens.actorEmail, restoreRecoveryJobs.actorEmail),
      eq(restoreConfirmationTokens.backupSha256, restoreRecoveryJobs.backupSha256),
      eq(restoreConfirmationTokens.snapshotSha256, restoreRecoveryJobs.snapshotSha256),
      eq(restoreConfirmationTokens.planSha256, restoreRecoveryJobs.planSha256),
    ))
    .innerJoin(fields, and(
      eq(fields.id, restoreRecoveryJobs.fieldId),
      eq(fields.organizationId, restoreRecoveryJobs.organizationId),
    ))
    .where(and(
      eq(restoreRecoveryJobs.confirmationTokenId, confirmationTokenId),
      eq(restoreRecoveryJobs.organizationId, binding.organizationId),
      eq(restoreRecoveryJobs.fieldId, binding.fieldId),
      eq(restoreRecoveryJobs.actorEmail, binding.actorEmail),
      eq(restoreRecoveryJobs.backupSha256, binding.backupSha256),
      eq(restoreRecoveryJobs.snapshotSha256, binding.snapshotSha256),
      eq(restoreRecoveryJobs.planSha256, binding.planSha256),
      eq(fields.isDemo, false),
      sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
      currentRestoreDataActorCondition(access),
    ))
    .limit(1);
  const job = result?.job;
  if (!job) return null;
  const objects = await db.select().from(restoreRecoveryObjects)
    .where(eq(restoreRecoveryObjects.recoveryJobId, job.id))
    .orderBy(asc(restoreRecoveryObjects.sequenceNumber));
  if (!await hasCurrentRestoreDataAccess(binding, access)) return null;
  return { job, objects };
}

async function hasCurrentRestoreDataAccess(
  binding: RestoreConfirmationBinding,
  access: RestoreActorAccess,
): Promise<boolean> {
  const [current] = await getDb().select({ id: fields.id }).from(fields).where(and(
    eq(fields.id, binding.fieldId),
    eq(fields.organizationId, binding.organizationId),
    eq(fields.isDemo, false),
    sql`${fields.id} IN (SELECT CAST(value AS TEXT) FROM json_each(${JSON.stringify(access.fieldIds)}))`,
    currentRestoreDataActorCondition(access),
  )).limit(1);
  return Boolean(current);
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

function existingReceipt(
  existing: NonNullable<Awaited<ReturnType<typeof loadPreparedRecovery>>>,
  candidate: PreparedRecoverySpec,
  idempotent: boolean,
): DurableRecoveryPreparationReceipt {
  if (!recoveryPreparationMatches(existing.job, existing.objects, candidate)) {
    throw preparationError("PREPARATION_CONFLICT");
  }
  return {
    recoveryJobId: existing.job.id,
    status: "prepared",
    preparedAt: existing.job.preparedAt,
    expectedRowCount: existing.job.expectedRowCount,
    originalFileCount: existing.objects.length,
    executionEnabled: false,
    idempotent,
  };
}

function preparationError(code: RecoveryPreparationErrorCode): RecoveryPreparationError {
  const messages: Record<RecoveryPreparationErrorCode, string> = {
    CONFIRMATION_NOT_FOUND: "La confirmacion de recuperacion no existe.",
    CONFIRMATION_INVALID: "La confirmacion expiro, fue usada o ya no coincide con el plan.",
    PREPARATION_CONFLICT: "El trabajo existente no coincide con el inventario confirmado.",
    PREPARATION_FAILED: "No fue posible preparar el trabajo de recuperacion.",
  };
  return new RecoveryPreparationError(messages[code], code);
}
