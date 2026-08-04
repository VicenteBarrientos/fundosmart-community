import type { RecoveryJournalEvent } from "./isolated-recovery-event-journal.mjs";
import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import type { PreparedRecoverySpec } from "./recovery-job-rules.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type CoordinationReason =
  | "committed"
  | "already_committed"
  | "confirmation_invalid"
  | "preparation_conflict"
  | "state_conflict"
  | "state_rejected"
  | "evidence_inconsistent";

export function coordinateIsolatedRecoveryPreparationEvent(database: IsolatedSqlite, input: {
  spec: PreparedRecoverySpec;
  tokenSha256: string;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: CoordinationReason;
  recoveryJobId: string | null;
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};

export function coordinateIsolatedRecoveryLeaseEvent(database: IsolatedSqlite, input: {
  operation: "claim" | "renew" | "release";
  jobId: string;
  leaseToken: string;
  now: string;
  ttlMs?: number;
  expectedCheckpoint: IsolatedRecoveryCheckpoint;
  expectedJournalHead: RecoveryJournalEvent;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: CoordinationReason;
  operation: "claim" | "renew" | "release";
  checkpoint: IsolatedRecoveryCheckpoint | null;
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};
