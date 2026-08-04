import type { RecoveryJournalEvent } from "./isolated-recovery-event-journal.mjs";
import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import type { IsolatedRecoveryObject } from "./isolated-recovery-object-simulator.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type CommonInput = {
  jobId: string;
  importJobId: string;
  leaseToken: string;
  now: string;
  expectedJob: IsolatedRecoveryCheckpoint;
  expectedObject: IsolatedRecoveryObject;
  expectedJournalHead: RecoveryJournalEvent;
  guard: IsolatedGuard;
};
type CoordinationResult = {
  changed: boolean;
  reason: string;
  job: {
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
  } | null;
  object: {
    importJobId: string;
    sequenceNumber: number;
    status: string;
    attemptCount: number;
    wasPreexisting: boolean;
    hasDestinationObjectKey: boolean;
    lastErrorCode: string | null;
  } | null;
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};

export function coordinateIsolatedRecoveryObjectCopyEvent(database: IsolatedSqlite, input: CommonInput & {
  destinationObjectKey: string;
  wasPreexisting: boolean;
}): CoordinationResult;
export function coordinateIsolatedRecoveryObjectProgressEvent(database: IsolatedSqlite, input: CommonInput & {
  operation: "verify" | "compensate";
  transitionToApplying?: boolean;
}): CoordinationResult;
export function coordinateIsolatedRecoveryFailureStartEvents(database: IsolatedSqlite, input: CommonInput & {
  failureCode: "original_missing" | "original_hash_mismatch" | "lease_lost" | "unknown_failure";
}): Omit<CoordinationResult, "event"> & {
  failureCode: string | null;
  completedAt: string | null;
  events: RecoveryJournalEvent[];
};
export function coordinateIsolatedRecoveryFailedEvent(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  now: string;
  failureCode: "original_missing" | "original_hash_mismatch" | "schema_drift" | "snapshot_changed" | "plan_changed" | "foreign_key_violation" | "lease_lost" | "unknown_failure";
  expectedJob: IsolatedRecoveryCheckpoint;
  expectedJournalHead: RecoveryJournalEvent;
  guard: IsolatedGuard;
}): Omit<CoordinationResult, "event"> & {
  failureCode: string | null;
  completedAt: string | null;
  events: RecoveryJournalEvent[];
};
