export const MEBIBYTE = 1024 * 1024;

// Client-first parsing limits. These are intentionally independent from the
// optional Worker route, whose generic mutation guard is much stricter.
export const MAX_CLIENT_COMPRESSED_FILE_BYTES = 25 * MEBIBYTE;
export const MAX_ARCHIVE_ENTRIES = 128;
export const MAX_ARCHIVE_ENTRY_BYTES = 40 * MEBIBYTE;
export const MAX_EXPANDED_ARCHIVE_BYTES = 80 * MEBIBYTE;
export const MAX_ARCHIVE_COMPRESSION_RATIO = 100;
export const MAX_ARCHIVE_PATH_BYTES = 240;

export const MAX_SOURCE_FEATURES = 500;
export const MAX_PREVIEW_FEATURES = 1_000;
export const MAX_RAW_VERTICES_PER_RING = 10_000;
export const MAX_RAW_VERTICES_TOTAL = 100_000;
export const MAX_PREVIEW_VERTICES_PER_RING = 2_000;
export const MAX_PREVIEW_VERTICES_TOTAL = 100_000;
export const SIMPLIFY_TOLERANCE_METERS = 1;

// Server fallback limits. The UI may call previewGisImport directly up to the
// client limits above; only the optional POST endpoint uses these caps.
export const MAX_WORKER_PREVIEW_REQUEST_BYTES = 2 * MEBIBYTE;
export const MAX_WORKER_PREVIEW_FILE_BYTES = 1_500_000;

export const GIS_PARSER_VERSION = "gis-preview-v1";

export function publicImportLimits() {
  return {
    maxCompressedFileBytes: MAX_CLIENT_COMPRESSED_FILE_BYTES,
    maxArchiveEntries: MAX_ARCHIVE_ENTRIES,
    maxExpandedArchiveBytes: MAX_EXPANDED_ARCHIVE_BYTES,
    maxSourceFeatures: MAX_SOURCE_FEATURES,
    maxPreviewFeatures: MAX_PREVIEW_FEATURES,
    maxRawVerticesPerRing: MAX_RAW_VERTICES_PER_RING,
    maxRawVerticesTotal: MAX_RAW_VERTICES_TOTAL,
    maxPreviewVerticesPerRing: MAX_PREVIEW_VERTICES_PER_RING,
    maxPreviewVerticesTotal: MAX_PREVIEW_VERTICES_TOTAL,
    simplifyToleranceMeters: SIMPLIFY_TOLERANCE_METERS,
  };
}
