import type { IsolatedRecoveryCheckpoint } from "./isolated-recovery-lease-simulator.mjs";
import type { IsolatedRecoveryObjectState } from "./isolated-recovery-object-simulator.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...values: unknown[]): Array<Record<string, unknown>>;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
export function coordinateIsolatedRecoveryProgress(database: IsolatedSqlite, input: {
  operation: "verify" | "compensate";
  jobId: string;
  importJobId: string;
  leaseToken: string;
  now: string;
  expectedJob: IsolatedRecoveryCheckpoint;
  expectedObject: IsolatedRecoveryObjectState;
  transitionToApplying?: boolean;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: "committed" | "already_committed" | "lease_lost" | "stale_checkpoint" | "stale_object" | "not_found";
  job: {
    status: string;
    attemptCount: number;
    objectCursorImportJobId: string | null;
    copiedObjectCount: number;
    compensationCursorImportJobId: string | null;
    compensatedObjectCount: number;
  } | null;
  object: {
    importJobId: string;
    sequenceNumber: number;
    status: string;
    attemptCount: number;
    wasPreexisting: boolean;
    hasDestinationObjectKey: boolean;
  } | null;
  productWritesEnabled: false;
};
export function coordinateIsolatedRecoveryProgressInOpenTransaction(
  database: IsolatedSqlite,
  input: Parameters<typeof coordinateIsolatedRecoveryProgress>[1],
): ReturnType<typeof coordinateIsolatedRecoveryProgress>;
