export type OriginalIntegrityStatus = "healthy" | "missing" | "size_mismatch" | "sha_mismatch" | "metadata_mismatch";
export const ORIGINAL_INTEGRITY_STATUSES: readonly OriginalIntegrityStatus[];
export function assessOriginalIntegrity(
  expected: { fileSizeBytes: number; sha256: string; organizationId: string; fieldId: string; sourceTable: string },
  stored: { size: number; customMetadata?: Record<string, string> } | null,
): { status: OriginalIntegrityStatus; issues: string[] };

export type DeepOriginalIntegrityStatus = "healthy" | "missing" | "size_mismatch" | "content_mismatch" | "metadata_mismatch";
export function assessDeepOriginalIntegrity(
  expected: { fileSizeBytes: number; sha256: string; organizationId: string; fieldId: string; sourceTable: string },
  stored: { size: number; customMetadata?: Record<string, string> } | null,
  calculatedSha256: string | null,
): { status: DeepOriginalIntegrityStatus; issues: string[] };
