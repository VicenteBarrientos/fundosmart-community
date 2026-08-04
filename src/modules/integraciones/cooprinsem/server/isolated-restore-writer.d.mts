import type { PortableRestorePlan, ValidatedPortableBackup, PortableBackupRow } from "./restore-rules.mjs";

type IsolatedSqlite = {
  exec(sql: string): void;
  prepare(sql: string): { all(...values: unknown[]): Array<{ name?: unknown }>; run(...values: unknown[]): unknown };
};
export function applyInsertOnlyRestoreSimulation(database: IsolatedSqlite, input: {
  backup: ValidatedPortableBackup;
  currentData: Record<string, PortableBackupRow[]>;
  plan: PortableRestorePlan;
  guard: { target: "isolated_sqlite_memory"; productWritesEnabled: false };
}): { insertedRowCount: number; sections: Array<{ section: string; insertedRowCount: number }>; productWritesEnabled: false };
export const RESTORE_SECTION_TABLES: Readonly<Record<string, string>>;
export function applyInsertOnlyRestoreRows(database: IsolatedSqlite, input: {
  backup: ValidatedPortableBackup;
  currentData: Record<string, PortableBackupRow[]>;
  plan: PortableRestorePlan;
  guard: { target: "isolated_sqlite_memory"; productWritesEnabled: false };
}): { insertedRowCount: number; sections: Array<{ section: string; insertedRowCount: number }>; productWritesEnabled: false };
export function quoteRestoreIdentifier(value: string): string;
export function restoreSqliteValue(value: unknown): unknown;
