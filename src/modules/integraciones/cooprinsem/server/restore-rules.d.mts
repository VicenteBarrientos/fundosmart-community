export type PortableBackupRow = Record<string, unknown>;
export type PortableRestoreOriginalInventoryItem = {
  importJobId: string;
  fileSizeBytes: number;
  sha256: string;
};
export const SECTION_KEY_FIELDS: Readonly<Record<string, string>>;
export type ValidatedPortableBackup = {
  manifest: {
    format: "fundosmart.portable-backup.v1";
    generatedAt: string;
    generatedBy: string;
    scope: { type: "field" | "import"; id: string; name: string; organizationId: string; organizationName: string; fieldId: string; fieldName: string };
    recordCounts: Record<string, number>;
    sectionSha256: Record<string, string>;
    originalFiles: Array<PortableRestoreOriginalInventoryItem & Record<string, unknown>>;
    excluded?: unknown[];
  };
  data: Record<string, PortableBackupRow[]>;
};
export type PortableRestorePlan = {
  format: "fundosmart.portable-backup.v1";
  scope: ValidatedPortableBackup["manifest"]["scope"];
  generatedAt: string;
  assessment: "ready" | "conflicts" | "no_changes";
  writeEnabled: false;
  totals: { sectionCount: number; rowCount: number; insertableRowCount: number; unchangedRowCount: number; conflictRowCount: number; referenceIssueCount: number; originalFileCount: number };
  sections: Array<{ section: string; rowCount: number; insertableRowCount: number; unchangedRowCount: number; conflictRowCount: number; status: "unsupported" | "conflict" | "insertable" | "unchanged" }>;
  conflicts: Array<{ section: string; key: string; reason: string }>;
  blockers: string[];
  warnings: string[];
};
export class PortableBackupValidationError extends Error {
  code: "PORTABLE_BACKUP_INVALID";
  issues: string[];
  constructor(issues: string[]);
}
export function validatePortableBackup(value: unknown): Promise<ValidatedPortableBackup>;
export function buildPortableRestorePlan(backup: ValidatedPortableBackup, currentData: Record<string, PortableBackupRow[]>): PortableRestorePlan;
export function portableRestoreOriginalInventory(backup: ValidatedPortableBackup): PortableRestoreOriginalInventoryItem[];
