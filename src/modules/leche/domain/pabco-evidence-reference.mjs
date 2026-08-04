const DURABLE_EVIDENCE_ID =
  /^pabco-evidence-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isDownloadablePabcoEvidenceReference(value) {
  if (typeof value !== "string") return false;
  if (DURABLE_EVIDENCE_ID.test(value)) return true;
  const segments = value.split("/");
  return segments[0] === "pabco"
    && segments.length > 1
    && segments.slice(1).every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}
