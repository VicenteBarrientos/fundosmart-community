type IsolatedSqlite = {
  prepare(sql: string): {
    get(...values: unknown[]): Record<string, unknown> | undefined;
    all(...values: unknown[]): Record<string, unknown>[];
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedGuard = { target: "isolated_sqlite_memory"; productWritesEnabled: false };
type StoredObject = { bytes: Uint8Array; metadata: Record<string, string> };
export type IsolatedMemoryObjectStore = {
  kind: "isolated_memory";
  get(key: string): Promise<StoredObject | null>;
  put(key: string, bytes: ArrayBuffer | ArrayBufferView, metadata?: Record<string, string>): Promise<void>;
  delete(key: string): Promise<void>;
  keys(): string[];
};
export type IsolatedRecoveryProcessorStep = {
  format: "fundosmart.isolated-recovery-processor.v1";
  action: string;
  changed: boolean;
  reason: string;
  status: string | null;
  reconciliation: { consistent: boolean; reason: string; eventCount: number; issueCodes: string[] };
  productWritesEnabled: false;
  remoteWrites: false;
};

export const ISOLATED_RECOVERY_PROCESSOR_FORMAT: "fundosmart.isolated-recovery-processor.v1";
export function createIsolatedMemoryObjectStore(entries?: Array<{
  key: string;
  bytes: ArrayBuffer | ArrayBufferView;
  metadata?: Record<string, string>;
}>): IsolatedMemoryObjectStore;
export function runIsolatedRecoveryProcessorStep(database: IsolatedSqlite, input: {
  jobId: string;
  leaseToken: string;
  now: string;
  ttlMs?: number;
  batchSize?: number;
  guard: IsolatedGuard;
  objectStore: IsolatedMemoryObjectStore;
  originalFiles?: Map<string, ArrayBuffer | ArrayBufferView> | Record<string, ArrayBuffer | ArrayBufferView>;
  operations: {
    capturePreRestoreBackup?: (input: { jobId: string; guard: IsolatedGuard; objectStore: IsolatedMemoryObjectStore }) => Promise<{ objectKey: string; sha256: string }> | { objectKey: string; sha256: string };
    applyRows?: (input: { jobId: string; from: number; to: number; guard: IsolatedGuard }) => Promise<{ appliedThrough: number }> | { appliedThrough: number };
    verifyRows?: (input: { jobId: string; from: number; to: number; guard: IsolatedGuard }) => Promise<{ verifiedThrough: number; postRestoreSha256?: string }> | { verifiedThrough: number; postRestoreSha256?: string };
    restorePreRestoreBackup?: (input: {
      jobId: string;
      objectKey: string;
      sha256: string;
      guard: IsolatedGuard;
      objectStore: IsolatedMemoryObjectStore;
    }) => Promise<{ restoredSha256: string }> | { restoredSha256: string };
  };
}): Promise<IsolatedRecoveryProcessorStep>;
