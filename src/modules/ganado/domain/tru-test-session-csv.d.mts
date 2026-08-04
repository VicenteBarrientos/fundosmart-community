export type TruTestCsvIssue = {
  code: string;
  level: "error" | "warning";
  rowNumber: number | null;
  message: string;
};

export type TruTestCsvIdentifier = {
  kind: "VID" | "EID";
  header: string;
  value: string;
};

export type TruTestCsvRow = {
  rowNumber: number;
  identifiers: TruTestCsvIdentifier[];
  weightKg: number;
  recordedAt: string | null;
};

export type TruTestSessionCsvResult = {
  delimiter: "," | ";" | "\t";
  headerRowNumber: number;
  dataRowCount: number;
  detectedColumns: {
    identifiers: string[];
    weight: string;
    date: string | null;
  };
  dates: string[];
  rows: TruTestCsvRow[];
  issues: TruTestCsvIssue[];
};

export type TruTestAnimalReference = {
  id: string;
  tag: string;
};

export type TruTestReconciliationMatch = {
  animalId: string;
  animalTag: string;
  rowNumber: number;
  weightKg: number;
  recordedAt: string | null;
};

export type TruTestReconciliationResult = {
  matches: TruTestReconciliationMatch[];
  issues: TruTestCsvIssue[];
};

export const MAX_TRU_TEST_CSV_BYTES: number;
export const MAX_TRU_TEST_CSV_ROWS: number;

export class TruTestCsvError extends Error {
  code: string;
  constructor(code: string, message: string);
}

export function parseTruTestSessionCsv(input: string): TruTestSessionCsvResult;
export function reconcileTruTestRows(
  rows: TruTestCsvRow[],
  animals: TruTestAnimalReference[],
): TruTestReconciliationResult;
