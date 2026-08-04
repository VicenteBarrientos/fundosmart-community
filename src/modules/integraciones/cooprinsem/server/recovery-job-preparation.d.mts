import type { PreparedRecoverySpec } from "./recovery-job-rules.mjs";

export type RecoveryPreparationStatement = {
  name: string;
  sql: string;
  params: Array<string | number | null>;
};

export type ExistingPreparedRecoveryJob = Record<string, unknown>;
export type ExistingPreparedRecoveryObject = Record<string, unknown>;
export type RecoveryPreparationActorAccess = {
  membershipId: string;
  email: string;
};

export function buildRecoveryPreparationStatements(
  spec: PreparedRecoverySpec,
  tokenSha256: string,
  authorizedFieldIds: string[],
  currentActorAccess: RecoveryPreparationActorAccess,
): RecoveryPreparationStatement[];

export function recoveryPreparationMatches(
  existingJob: ExistingPreparedRecoveryJob | null,
  existingObjects: ExistingPreparedRecoveryObject[],
  spec: PreparedRecoverySpec,
): boolean;
