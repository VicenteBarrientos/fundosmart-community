import type { IsolatedCheckpointNext } from "./isolated-recovery-checkpoint-simulator.mjs";
import type { RecoveryJournalEvent } from "./isolated-recovery-event-journal.mjs";
import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };

export function coordinateIsolatedRecoveryCheckpointEvent(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  now: string;
  expectedCheckpoint: IsolatedRecoveryCheckpoint;
  expectedJournalHead: RecoveryJournalEvent;
  next: IsolatedCheckpointNext;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: "committed" | "already_committed" | "lease_lost" | "state_conflict" | "stale_checkpoint" | "not_found" | "evidence_inconsistent";
  checkpoint: IsolatedRecoveryCheckpoint | null;
  event: RecoveryJournalEvent | null;
  productWritesEnabled: false;
};
