export const ORIGINAL_INTEGRITY_STATUSES = Object.freeze([
  "healthy",
  "missing",
  "size_mismatch",
  "sha_mismatch",
  "metadata_mismatch",
]);

export function assessOriginalIntegrity(expected, stored) {
  if (!stored) {
    return { status: "missing", issues: ["El objeto no existe en R2."] };
  }
  const issues = [];
  const sizeMismatch = stored.size !== expected.fileSizeBytes;
  if (sizeMismatch) issues.push(`Tamaño R2 ${stored.size}; D1 ${expected.fileSizeBytes}.`);
  const metadata = stored.customMetadata ?? {};
  const shaMismatch = metadata.sha256 !== expected.sha256;
  if (shaMismatch) issues.push("El SHA-256 de metadatos R2 no coincide con D1.");
  const metadataIssues = [
    ["organizationId", expected.organizationId],
    ["fieldId", expected.fieldId],
    ["sourceTable", expected.sourceTable],
  ].filter(([key, value]) => metadata[key] !== value);
  if (metadataIssues.length > 0) {
    issues.push(`Metadatos fuera de alcance: ${metadataIssues.map(([key]) => key).join(", ")}.`);
  }
  const status = sizeMismatch
    ? "size_mismatch"
    : shaMismatch
      ? "sha_mismatch"
      : metadataIssues.length > 0
        ? "metadata_mismatch"
        : "healthy";
  return { status, issues };
}

export function assessDeepOriginalIntegrity(expected, stored, calculatedSha256) {
  const inventory = assessOriginalIntegrity(expected, stored);
  if (!stored) return inventory;
  const issues = [...inventory.issues];
  const contentMismatch = calculatedSha256 !== null && calculatedSha256 !== expected.sha256;
  if (contentMismatch) issues.push("El SHA-256 recalculado desde los bytes no coincide con D1.");
  const status = inventory.status === "size_mismatch"
    ? "size_mismatch"
    : contentMismatch
      ? "content_mismatch"
      : inventory.status === "healthy"
        ? "healthy"
        : "metadata_mismatch";
  return { status, issues };
}
