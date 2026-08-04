type IsolatedSqlite = {
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
export type IsolatedRecoveryCheckpoint = {
  jobId: string;
  status: string;
  executionEnabled: boolean;
  attemptCount: number;
  leaseToken: string | null;
  leaseExpiresAt: string | null;
  objectCursorImportJobId: string | null;
  copiedObjectCount: number;
  compensationCursorImportJobId: string | null;
  compensatedObjectCount: number;
  appliedRowCount: number;
  verifiedRowCount: number;
  expectedRowCount: number;
  updatedAt: string;
  productWritesEnabled: false;
};
type LeaseInput = { jobId: string; leaseToken: string; now: string; ttlMs: number; guard: IsolatedGuard };
type LeaseResult = {
  operation: "claim" | "renew" | "release";
  changed: boolean;
  checkpoint: IsolatedRecoveryCheckpoint | null;
  productWritesEnabled: false;
};
export function claimIsolatedRecoveryLease(database: IsolatedSqlite, input: LeaseInput): LeaseResult;
export function renewIsolatedRecoveryLease(database: IsolatedSqlite, input: LeaseInput): LeaseResult;
export function releaseIsolatedRecoveryLease(database: IsolatedSqlite, input: Omit<LeaseInput, "ttlMs">): LeaseResult;
export function readIsolatedRecoveryCheckpoint(database: IsolatedSqlite, input: { jobId: string; guard: IsolatedGuard }): IsolatedRecoveryCheckpoint | null;
