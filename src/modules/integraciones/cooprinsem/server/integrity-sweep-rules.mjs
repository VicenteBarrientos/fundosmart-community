export const INTEGRITY_SWEEP_MAX_FILES = 4;
export const INTEGRITY_SWEEP_MAX_BYTES = 24 * 1024 * 1024;
export const INTEGRITY_SWEEP_MAX_FILE_BYTES = 20 * 1024 * 1024;

export function selectIntegritySweepBatch(candidates, options = {}) {
  const maxFiles = options.maxFiles ?? INTEGRITY_SWEEP_MAX_FILES;
  const maxBytes = options.maxBytes ?? INTEGRITY_SWEEP_MAX_BYTES;
  const maxFileBytes = options.maxFileBytes ?? INTEGRITY_SWEEP_MAX_FILE_BYTES;
  const selected = [];
  let reservedBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxFiles) break;
    const readableBytes = candidate.fileSizeBytes <= maxFileBytes ? candidate.fileSizeBytes : 0;
    if (selected.length > 0 && readableBytes > 0 && reservedBytes + readableBytes > maxBytes) break;
    selected.push(candidate);
    reservedBytes += readableBytes;
  }
  return {
    selected,
    reservedBytes,
    hasMore: candidates.length > selected.length,
  };
}

export function summarizeIntegritySweepResults(results) {
  const healthyCount = results.filter((entry) => entry.status === "healthy").length;
  const missingCount = results.filter((entry) => entry.status === "missing").length;
  return {
    processedCount: results.length,
    healthyCount,
    missingCount,
    mismatchCount: results.length - healthyCount - missingCount,
    issueCount: results.length - healthyCount,
    readBytes: results.reduce((total, entry) => total + entry.readBytes, 0),
  };
}
