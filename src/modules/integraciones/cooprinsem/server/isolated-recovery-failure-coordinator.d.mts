import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import type { IsolatedRecoveryObjectState } from "./isolated-recovery-object-simulator.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type FailureResult = {
  changed: boolean;
  reason: "committed" | "already_committed" | "lease_lost" | "stale_checkpoint" | "stale_object" | "compensation_incomplete" | "snapshot_restore_incomplete" | "not_found";
  job: { status: string; failureCode: string | null; compensatedObjectCount: number; leaseActive: boolean; completedAt: string | null } | null;
  object: { importJobId: string; status: string; attemptCount: number; hasDestinationObjectKey: boolean; lastErrorCode: string | null } | null;
  productWritesEnabled: false;
};
export function failIsolatedRecoveryObjectAndBeginCompensation(database: IsolatedSqlite, input: {
  jobId: string;
  importJobId: string;
  leaseToken: string;
  now: string;
  failureCode: "original_missing" | "original_hash_mismatch" | "lease_lost" | "unknown_failure";
  expectedJob: IsolatedRecoveryCheckpoint;
  expectedObject: IsolatedRecoveryObjectState;
  guard: IsolatedGuard;
}): FailureResult;
export function failIsolatedRecoveryObjectAndBeginCompensationInOpenTransaction(
  database: IsolatedSqlite,
  input: Parameters<typeof failIsolatedRecoveryObjectAndBeginCompensation>[1],
): FailureResult;
export function finalizeIsolatedRecoveryFailure(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  expectedJobAttemptCount: number;
  now: string;
  guard: IsolatedGuard;
}): FailureResult;
export function finalizeIsolatedRecoveryFailureInOpenTransaction(
  database: IsolatedSqlite,
  input: Parameters<typeof finalizeIsolatedRecoveryFailure>[1],
): FailureResult;
