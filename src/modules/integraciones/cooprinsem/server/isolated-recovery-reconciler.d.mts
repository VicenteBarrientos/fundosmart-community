type IsolatedSqlite = {
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type PublicValue = string | number | boolean | null;
type ReconciliationIssue = {
  code: string;
  scope: "journal" | "job" | "object" | "inventory";
  importJobId: string | null;
  expected: PublicValue;
  actual: PublicValue;
};
type PublicJob = {
  jobId?: string;
  status: string;
  executionEnabled?: boolean;
  attemptCount: number;
  leaseActive: boolean;
  objectCursorImportJobId: string | null;
  copiedObjectCount: number;
  compensationCursorImportJobId: string | null;
  compensatedObjectCount: number;
  appliedRowCount: number;
  verifiedRowCount: number;
  expectedRowCount?: number;
  evidenceVersion?: 1 | 2;
  preRestoreBackupSha256?: string | null;
  postRestoreSha256?: string | null;
  failureCode: string | null;
  completedAt: string | null;
  updatedAt: string;
};
type PublicObject = {
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
  updatedAt: string;
};

export function reconcileIsolatedRecoveryState(database: IsolatedSqlite, input: {
  recoveryJobId: string;
  guard: IsolatedGuard;
}): {
  recoveryJobId: string;
  consistent: boolean;
  reason: "reconciled" | "not_found" | "invalid_chain" | "state_divergence";
  chain: {
    valid: boolean;
    reason: "verified" | "empty_chain" | "invalid_sequence" | "hash_mismatch";
    eventCount: number;
    headSha256?: string;
    invalidSequenceNumber?: number;
    terminal: boolean;
  };
  expectedJob: PublicJob | null;
  actualJob: PublicJob | null;
  objects: PublicObject[];
  inventory: {
    objectCount: number;
    createdObjectCount: number;
    preexistingObjectCount: number;
    statusCounts: Record<string, number>;
  };
  issues: ReconciliationIssue[];
  readOnly: true;
  productWritesEnabled: false;
};
