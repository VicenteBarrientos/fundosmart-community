import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";

type IsolatedSqlite = {
  prepare(sql: string): {
    all(...values: unknown[]): Array<Record<string, unknown>>;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
export type IsolatedCheckpointState = Pick<
  IsolatedRecoveryCheckpoint,
  "status" | "attemptCount" | "objectCursorImportJobId" | "copiedObjectCount" |
  "appliedRowCount" | "verifiedRowCount" | "expectedRowCount"
>;
export type IsolatedCheckpointNext = Omit<IsolatedCheckpointState, "attemptCount" | "expectedRowCount">;
export function commitIsolatedRecoveryCheckpoint(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  now: string;
  expected: IsolatedCheckpointState;
  next: IsolatedCheckpointNext;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: "committed" | "lease_lost" | "stale_checkpoint" | "not_found";
  checkpoint: IsolatedRecoveryCheckpoint | null;
  productWritesEnabled: false;
};
