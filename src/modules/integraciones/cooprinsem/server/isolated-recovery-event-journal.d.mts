import type {
  FundoSmartRecoveryEventType,
  FundoSmartRecoveryJobStatus,
  FundoSmartRecoveryObjectStatus,
} from "../domain/types";

type IsolatedSqlite = {
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
export type RecoveryJournalEvent = {
  recoveryJobId: string;
  sequenceNumber: number;
  eventType: FundoSmartRecoveryEventType;
  jobStatus: FundoSmartRecoveryJobStatus;
  jobAttemptCount: number;
  importJobId: string | null;
  objectStatus: FundoSmartRecoveryObjectStatus | null;
  failureCode: string | null;
  copiedObjectCount: number;
  compensatedObjectCount: number;
  appliedRowCount: number;
  verifiedRowCount: number;
  evidenceVersion: 1 | 2;
  preRestoreBackupSha256: string | null;
  postRestoreSha256: string | null;
  occurredAt: string;
  previousEventSha256: string | null;
  eventSha256: string;
};
export type RecoveryJournalEventInput = Omit<
  RecoveryJournalEvent,
  "eventSha256" | "evidenceVersion" | "preRestoreBackupSha256" | "postRestoreSha256"
> & { guard: IsolatedGuard };
export const RECOVERY_EVENT_TYPES: readonly FundoSmartRecoveryEventType[];
export function appendIsolatedRecoveryEvent(database: IsolatedSqlite, input: RecoveryJournalEventInput): {
  changed: boolean;
  reason: "committed" | "already_committed" | "sequence_conflict" | "not_found";
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};
export function readIsolatedRecoveryEvents(database: IsolatedSqlite, input: {
  recoveryJobId: string;
  guard: IsolatedGuard;
}): RecoveryJournalEvent[];
export function verifyIsolatedRecoveryEventChain(database: IsolatedSqlite, input: {
  recoveryJobId: string;
  guard: IsolatedGuard;
}): {
  valid: boolean;
  reason: "verified" | "empty_chain" | "invalid_sequence" | "hash_mismatch";
  eventCount: number;
  headSha256?: string;
  invalidSequenceNumber?: number;
  terminal: boolean;
};
