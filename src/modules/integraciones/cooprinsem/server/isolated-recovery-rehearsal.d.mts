import type { PortableRestorePlan, ValidatedPortableBackup, PortableBackupRow } from "./restore-rules.mjs";
import type { RestoreConfirmationBinding } from "./restore-confirmation-rules.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...values: unknown[]): Array<Record<string, unknown>>;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): { changes: number | bigint };
  };
};
type IsolatedObjectStore = {
  get(key: string): Promise<unknown> | unknown;
  put(key: string, bytes: Uint8Array, metadata: Record<string, string>): Promise<void> | void;
  delete(key: string): Promise<void> | void;
};
export function runIsolatedRecoveryRehearsal(database: IsolatedSqlite, input: {
  backup: ValidatedPortableBackup;
  backupPayload: string | ArrayBuffer | ArrayBufferView;
  currentData: Record<string, PortableBackupRow[]>;
  plan: PortableRestorePlan;
  confirmation: { token: string; binding: RestoreConfirmationBinding; now: string };
  originalFiles: Map<string, ArrayBuffer | ArrayBufferView> | Record<string, ArrayBuffer | ArrayBufferView>;
  objectStore: IsolatedObjectStore;
  guard: { target: "isolated_sqlite_memory"; productWritesEnabled: false };
}): Promise<{
  format: "fundosmart.recovery-rehearsal.v1";
  productWritesEnabled: false;
  tokenConsumed: true;
  insertedRowCount: number;
  verifiedRowCount: number;
  verifiedSectionCount: number;
  postRestoreSha256: string;
  originalFileCount: number;
  originalBytes: number;
  foreignKeyIssueCount: 0;
  preRestoreBackup: { format: string; payload: string; sha256: string; rowCounts: Record<string, number> };
  sections: Array<{ section: string; rowCount: number; sha256: string }>;
}>;
