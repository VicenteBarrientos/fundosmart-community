type IsolatedSqlite = {
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
export type IsolatedRecoveryObjectState = {
  status: string;
  destinationObjectKey: string | null;
  wasPreexisting: boolean;
  attemptCount: number;
  lastErrorCode: string | null;
  copiedAt: string | null;
  verifiedAt: string | null;
  compensatedAt: string | null;
};
export type IsolatedRecoveryObject = IsolatedRecoveryObjectState & {
  recoveryJobId: string;
  importJobId: string;
  sequenceNumber: number;
  sha256: string;
  sizeBytes: number;
  updatedAt: string;
};
export function readIsolatedRecoveryObject(database: IsolatedSqlite, input: {
  jobId: string;
  importJobId: string;
  guard: IsolatedGuard;
}): IsolatedRecoveryObject | null;
export function commitIsolatedRecoveryObjectState(database: IsolatedSqlite, input: {
  jobId: string;
  importJobId: string;
  leaseToken: string;
  expectedJobAttemptCount: number;
  now: string;
  expected: IsolatedRecoveryObjectState;
  next: IsolatedRecoveryObjectState;
  guard: IsolatedGuard;
}): {
  changed: boolean;
  reason: "committed" | "lease_lost" | "stale_object" | "not_found";
  object: {
    importJobId: string;
    sequenceNumber: number;
    status: string;
    attemptCount: number;
    wasPreexisting: boolean;
    hasDestinationObjectKey: boolean;
    lastErrorCode: string | null;
    copiedAt: string | null;
    verifiedAt: string | null;
    compensatedAt: string | null;
  } | null;
  productWritesEnabled: false;
};
