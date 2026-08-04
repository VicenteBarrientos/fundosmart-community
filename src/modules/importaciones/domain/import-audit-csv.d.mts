import type { ImportCenterPreview } from "./types";

export type ImportValidationCsvCell = string | number;

export type ImportValidationCsv = {
  filename: string;
  headers: string[];
  rows: ImportValidationCsvCell[][];
};

export const IMPORT_VALIDATION_CSV_HEADERS: readonly string[];

export function buildImportValidationCsv(
  preview: ImportCenterPreview,
): ImportValidationCsv;
