import type { RecoveryJournalEvent } from "./isolated-recovery-event-journal.mjs";
import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type PhaseFailureCode = "schema_drift" | "snapshot_changed" | "plan_changed" | "foreign_key_violation" | "unknown_failure";
type PublicJob = {
  jobId: string;
  status: string;
  attemptCount: number;
  leaseActive: boolean;
  objectCursorImportJobId: string | null;
  copiedObjectCount: number;
  compensationCursorImportJobId: string | null;
  compensatedObjectCount: number;
  appliedRowCount: number;
  verifiedRowCount: number;
  expectedRowCount: number;
  updatedAt: string;
};

export function coordinateIsolatedRecoveryPhaseFailureEvent(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  now: string;
  failureCode: PhaseFailureCode;
  expectedJob: IsolatedRecoveryCheckpoint;
  expectedJournalHead: RecoveryJournalEvent;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: string;
  job: PublicJob | null;
  failureCode: string | null;
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};

export function recordIsolatedRecoverySnapshotRestored(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  now: string;
  failureCode: PhaseFailureCode;
  expectedJobAttemptCount: number;
  expectedJournalHead: RecoveryJournalEvent;
  expectedSha256: string;
  restoredSha256: string;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: string;
  job: PublicJob | null;
  snapshotRestored: boolean;
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};

export function isolatedRecoveryPhaseFailureRequiresSnapshot(database: IsolatedSqlite, input: {
  jobId: string;
  guard: IsolatedGuard;
}): boolean;
