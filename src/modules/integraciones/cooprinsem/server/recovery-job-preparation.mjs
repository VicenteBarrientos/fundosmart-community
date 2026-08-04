const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function buildRecoveryPreparationStatements(
  spec,
  tokenSha256,
  authorizedFieldIds = [spec?.job?.fieldId],
  currentActorAccess = null,
) {
  validatePreparedSpec(spec);
  if (!SHA256_PATTERN.test(String(tokenSha256 ?? ""))) throw new Error("La preparacion requiere la huella del token.");
  const { job, objects } = spec;
  const fieldIds = [...new Set(authorizedFieldIds.map((fieldId) => String(fieldId ?? "").trim()).filter(Boolean))].sort();
  if (!fieldIds.includes(job.fieldId)) throw new Error("La preparacion requiere el fundo autorizado.");
  const accessJson = JSON.stringify(fieldIds);
  // Los ensayos aislados historicos pueden omitir el actor; el caller TypeScript productivo lo exige.
  const currentActor = normalizedCurrentRestoreDataActor(currentActorAccess, job);
  const currentActorGuard = currentActor ? `
              AND current_field.is_demo = 0
              AND EXISTS (
                SELECT 1 FROM organization_memberships AS current_actor
                WHERE current_actor.id = ?
                  AND current_actor.organization_id = current_field.organization_id
                  AND current_actor.normalized_email = ?
                  AND current_actor.status = 'active'
                  AND current_actor.role IN ('owner', 'admin')
              )` : "";
  const currentActorParams = currentActor ? [currentActor.membershipId, currentActor.email] : [];
  const binding = [job.actorEmail, job.organizationId, job.fieldId, job.backupSha256, job.snapshotSha256, job.planSha256];
  const statements = [
    {
      name: "consume_confirmation",
      sql: `
        UPDATE restore_confirmation_tokens
        SET status = 'consumed', consumed_at = ?, updated_at = ?
        WHERE id = ? AND token_sha256 = ? AND status = 'active' AND expires_at > ?
          AND actor_email = ? AND organization_id = ? AND field_id = ?
          AND backup_sha256 = ? AND snapshot_sha256 = ? AND plan_sha256 = ?
          AND EXISTS (
            SELECT 1 FROM fields AS current_field
            WHERE current_field.id = restore_confirmation_tokens.field_id
              AND current_field.organization_id = restore_confirmation_tokens.organization_id
              AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
              ${currentActorGuard}
          )
      `,
      params: [job.preparedAt, job.preparedAt, job.confirmationTokenId, tokenSha256, job.preparedAt, ...binding, accessJson, ...currentActorParams],
    },
    {
      name: "insert_job",
      sql: `
        INSERT INTO restore_recovery_jobs (
          id, organization_id, field_id, confirmation_token_id, actor_email,
          backup_sha256, snapshot_sha256, plan_sha256, status, execution_enabled,
          expected_row_count, prepared_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'prepared', 0, ?, ?, ?, ?
        FROM restore_confirmation_tokens confirmation
        INNER JOIN fields current_field
          ON current_field.id = confirmation.field_id
          AND current_field.organization_id = confirmation.organization_id
        WHERE confirmation.id = ? AND confirmation.token_sha256 = ?
          AND confirmation.status = 'consumed' AND confirmation.consumed_at = ?
          AND confirmation.actor_email = ? AND confirmation.organization_id = ? AND confirmation.field_id = ?
          AND confirmation.backup_sha256 = ? AND confirmation.snapshot_sha256 = ? AND confirmation.plan_sha256 = ?
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ${currentActorGuard}
      `,
      params: [
        job.id, job.organizationId, job.fieldId, job.confirmationTokenId, job.actorEmail,
        job.backupSha256, job.snapshotSha256, job.planSha256, job.expectedRowCount,
        job.preparedAt, job.createdAt, job.updatedAt,
        job.confirmationTokenId, tokenSha256, job.preparedAt, ...binding, accessJson, ...currentActorParams,
      ],
    },
    ...objects.map((object) => ({
      name: `insert_object:${object.sequenceNumber}`,
      sql: `
        INSERT INTO restore_recovery_objects (
          id, recovery_job_id, import_job_id, sequence_number, sha256, size_bytes,
          status, was_preexisting, attempt_count, created_at, updated_at
        )
        SELECT ?, job.id, ?, ?, ?, ?, 'pending', 0, 0, ?, ?
        FROM restore_recovery_jobs job
        INNER JOIN fields current_field
          ON current_field.id = job.field_id
          AND current_field.organization_id = job.organization_id
        WHERE job.id = ? AND job.confirmation_token_id = ?
          AND job.status = 'prepared' AND job.execution_enabled = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ${currentActorGuard}
      `,
      params: [
        object.id, object.importJobId, object.sequenceNumber, object.sha256, object.sizeBytes,
        object.createdAt, object.updatedAt, job.id, job.confirmationTokenId, accessJson, ...currentActorParams,
      ],
    })),
    {
      name: "insert_audit",
      sql: `
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          before, after, occurred_at
        )
        SELECT ?, job.organization_id, job.field_id, ?,
          'backup.restore.recovery_prepared', 'restore_recovery_job', job.id,
          NULL, ?, ?
        FROM restore_recovery_jobs job
        INNER JOIN fields current_field
          ON current_field.id = job.field_id
          AND current_field.organization_id = job.organization_id
        WHERE job.id = ? AND job.confirmation_token_id = ?
          AND job.status = 'prepared' AND job.execution_enabled = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ${currentActorGuard}
      `,
      params: [
        `recovery-prepared:${job.id}`,
        job.actorEmail,
        JSON.stringify({
          backupSha256: job.backupSha256,
          snapshotSha256: job.snapshotSha256,
          planSha256: job.planSha256,
          expectedRowCount: job.expectedRowCount,
          originalFileCount: objects.length,
          status: "prepared",
          executionEnabled: false,
        }),
        job.preparedAt,
        job.id,
        job.confirmationTokenId,
        accessJson,
        ...currentActorParams,
      ],
    },
  ];
  return statements;
}

function normalizedCurrentRestoreDataActor(input, job) {
  if (input == null) return null;
  const membershipId = String(input.membershipId ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!membershipId || !email || email !== job.actorEmail) {
    throw new Error("La preparacion requiere la identidad persistida del actor.");
  }
  return { membershipId, email };
}

export function recoveryPreparationMatches(existingJob, existingObjects, spec) {
  if (!existingJob || !spec?.job || !Array.isArray(existingObjects) || !Array.isArray(spec.objects)) return false;
  const job = spec.job;
  const comparableJobFields = [
    "organizationId", "fieldId", "confirmationTokenId", "actorEmail",
    "backupSha256", "snapshotSha256", "planSha256", "expectedRowCount",
  ];
  if (comparableJobFields.some((key) => existingJob[key] !== job[key])) return false;
  if (existingJob.status !== "prepared" || Boolean(existingJob.executionEnabled)) return false;
  if (["attemptCount", "copiedObjectCount", "compensatedObjectCount", "appliedRowCount", "verifiedRowCount"].some((key) => Number(existingJob[key]) !== 0)) return false;
  if ([
    "leaseToken", "leaseExpiresAt", "objectCursorImportJobId", "compensationCursorImportJobId", "preRestoreBackupObjectKey",
    "preRestoreBackupSha256", "postRestoreSha256", "failureCode", "startedAt", "completedAt",
  ].some((key) => existingJob[key] != null)) return false;
  const ordered = [...existingObjects].sort((left, right) => Number(left.sequenceNumber) - Number(right.sequenceNumber));
  if (ordered.length !== spec.objects.length) return false;
  return ordered.every((existing, index) => {
    const expected = spec.objects[index];
    return existing.importJobId === expected.importJobId
      && Number(existing.sequenceNumber) === expected.sequenceNumber
      && existing.sha256 === expected.sha256
      && Number(existing.sizeBytes) === expected.sizeBytes
      && existing.status === "pending"
      && existing.destinationObjectKey == null
      && !Boolean(existing.wasPreexisting)
      && Number(existing.attemptCount) === 0
      && existing.lastErrorCode == null;
  });
}

function validatePreparedSpec(spec) {
  const job = spec?.job;
  if (!job || job.status !== "prepared" || job.executionEnabled !== false) throw new Error("El trabajo debe estar preparado y deshabilitado.");
  for (const key of ["backupSha256", "snapshotSha256", "planSha256"]) {
    if (!SHA256_PATTERN.test(String(job[key] ?? ""))) throw new Error(`El trabajo requiere ${key} valido.`);
  }
  if (!Array.isArray(spec.objects)) throw new Error("El inventario de originales es obligatorio.");
  for (const [index, object] of spec.objects.entries()) {
    if (object.sequenceNumber !== index || object.status !== "pending" || object.destinationObjectKey != null) {
      throw new Error("El inventario debe estar ordenado, pendiente y sin claves internas.");
    }
  }
}
