export const INTEGRITY_SWEEP_MAX_FILES: 4;
export const INTEGRITY_SWEEP_MAX_BYTES: number;
export const INTEGRITY_SWEEP_MAX_FILE_BYTES: number;

export function selectIntegritySweepBatch<T extends { fileSizeBytes: number }>(
  candidates: T[],
  options?: { maxFiles?: number; maxBytes?: number; maxFileBytes?: number },
): { selected: T[]; reservedBytes: number; hasMore: boolean };

export function summarizeIntegritySweepResults(
  results: Array<{ status: string; readBytes: number }>,
): {
  processedCount: number;
  healthyCount: number;
  missingCount: number;
  mismatchCount: number;
  issueCount: number;
  readBytes: number;
};
