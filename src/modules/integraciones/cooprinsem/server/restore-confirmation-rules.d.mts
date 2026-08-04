import type { PortableRestorePlan } from "./restore-rules.mjs";

export type RestoreConfirmationBinding = {
  actorEmail: string;
  organizationId: string;
  fieldId: string;
  backupSha256: string;
  snapshotSha256: string;
  planSha256: string;
};
export type RestoreConfirmationRecord = RestoreConfirmationBinding & {
  status: "active" | "consumed" | "expired" | "revoked";
  expiresAt: string;
};
export type RestoreConfirmationValidation = {
  valid: boolean;
  code: "valid" | "not_found" | "consumed" | "inactive" | "expired" | "stale_binding";
};
export type RestoreActorAccess = {
  membershipId: string;
  email: string;
  fieldIds: string[];
};
export function restorePlanSha256(plan: PortableRestorePlan): Promise<string>;
export function restoreSnapshotData(data: Record<string, unknown>): Record<string, unknown>;
export function restoreSnapshotSha256(data: Record<string, unknown>): Promise<string>;
export function buildRestoreConfirmationBinding(input: RestoreConfirmationBinding): RestoreConfirmationBinding;
export function buildRestoreActorAccess(
  input: Partial<RestoreActorAccess>,
  expectedActorEmail: string,
): RestoreActorAccess | null;
export function restoreConfirmationTokenSha256(token: string, membershipId: string): Promise<string>;
export function validateRestoreConfirmation(record: RestoreConfirmationRecord | null, expected: RestoreConfirmationBinding, now?: string): RestoreConfirmationValidation;
export function isRestorePlanConfirmable(plan: PortableRestorePlan): boolean;
