import { canonicalJson, sha256Hex } from "./backup-format.mjs";
import { DEMO_EMAIL } from "../../../demo/data/demo-data.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const INTERNAL_RESTORE_AUDIT_ACTIONS = new Set([
  "backup.restore.previewed",
  "backup.restore.confirmation_issued",
  "backup.restore.recovery_prepared",
]);

export async function restorePlanSha256(plan) {
  return sha256Hex(canonicalJson({
    assessment: plan.assessment,
    blockers: plan.blockers,
    conflicts: plan.conflicts,
    format: plan.format,
    generatedAt: plan.generatedAt,
    scope: plan.scope,
    sections: plan.sections,
    totals: plan.totals,
    warnings: plan.warnings,
    writeEnabled: false,
  }));
}

export function restoreSnapshotData(data) {
  const source = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const auditLog = Array.isArray(source.auditLog)
    ? source.auditLog.filter((row) => !INTERNAL_RESTORE_AUDIT_ACTIONS.has(String(row?.action ?? "")))
    : source.auditLog;
  return auditLog === source.auditLog ? source : { ...source, auditLog };
}

export function restoreSnapshotSha256(data) {
  return sha256Hex(canonicalJson(restoreSnapshotData(data)));
}

export function buildRestoreConfirmationBinding(input) {
  const binding = {
    actorEmail: String(input.actorEmail ?? "").trim().toLowerCase(),
    organizationId: String(input.organizationId ?? ""),
    fieldId: String(input.fieldId ?? ""),
    backupSha256: String(input.backupSha256 ?? ""),
    snapshotSha256: String(input.snapshotSha256 ?? ""),
    planSha256: String(input.planSha256 ?? ""),
  };
  if (!binding.actorEmail || !binding.organizationId || !binding.fieldId) {
    throw new Error("La confirmacion requiere actor, organizacion y fundo.");
  }
  for (const key of ["backupSha256", "snapshotSha256", "planSha256"]) {
    if (!SHA256_PATTERN.test(binding[key])) throw new Error(`La confirmacion requiere un ${key} SHA-256 valido.`);
  }
  return binding;
}

export function buildRestoreActorAccess(input, expectedActorEmail) {
  const membershipId = String(input?.membershipId ?? "").trim();
  const email = String(input?.email ?? "").trim().toLowerCase();
  const actorEmail = String(expectedActorEmail ?? "").trim().toLowerCase();
  const fieldIds = [...new Set((Array.isArray(input?.fieldIds) ? input.fieldIds : [])
    .map((fieldId) => String(fieldId ?? "").trim())
    .filter(Boolean))].sort();
  if (!membershipId || !email || email === DEMO_EMAIL || email !== actorEmail || fieldIds.length === 0) return null;
  return { membershipId, email, fieldIds };
}

export function restoreConfirmationTokenSha256(token, membershipId) {
  const normalizedToken = String(token ?? "");
  const normalizedMembershipId = String(membershipId ?? "").trim();
  if (!normalizedToken || !normalizedMembershipId) {
    throw new Error("La confirmacion requiere token y membresia.");
  }
  return sha256Hex(canonicalJson({ membershipId: normalizedMembershipId, token: normalizedToken }));
}

export function validateRestoreConfirmation(record, expected, now = new Date().toISOString()) {
  if (!record) return { valid: false, code: "not_found" };
  if (record.status !== "active") return { valid: false, code: record.status === "consumed" ? "consumed" : "inactive" };
  if (record.expiresAt <= now) return { valid: false, code: "expired" };
  const binding = buildRestoreConfirmationBinding(expected);
  for (const key of ["actorEmail", "organizationId", "fieldId", "backupSha256", "snapshotSha256", "planSha256"]) {
    if (record[key] !== binding[key]) return { valid: false, code: "stale_binding" };
  }
  return { valid: true, code: "valid" };
}

export function isRestorePlanConfirmable(plan) {
  return plan?.assessment === "ready"
    && plan?.writeEnabled === false
    && Array.isArray(plan.blockers)
    && plan.blockers.length === 0
    && Number(plan?.totals?.insertableRowCount) > 0;
}
