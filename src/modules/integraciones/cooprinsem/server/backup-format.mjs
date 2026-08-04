export const FUNDOSMART_BACKUP_FORMAT = "fundosmart.portable-backup.v1";

export function canonicalJson(value) {
  return JSON.stringify(sortValue(value)) ?? "null";
}

export async function sha256Hex(value) {
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : ArrayBuffer.isView(value)
      ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new TextEncoder().encode(typeof value === "string" ? value : canonicalJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function safeDownloadFilename(value, fallback = "fundosmart-backup.json") {
  const normalized = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-+\./g, ".")
    .replace(/^[.-]+|[.-]+$/g, "");
  return normalized || fallback;
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sortValue(value[key])]),
    );
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}
