import type { ImportCenterIssue, ImportRecord, ImportRowStatus } from "../domain/types";

export const LIVESTOCK_INVENTORY_PROFILE_KEY: "livestock.inventory.xlsx.v1";
export const LIVESTOCK_INVENTORY_MAX_ROWS: 800;

export class LivestockInventoryParseError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

/** Why an animal left the herd. A year is all the source states — never a date. */
export type LivestockInventoryExitKind = "sold_market" | "died" | "rustled";

export type LivestockInventoryExit = {
  kind: LivestockInventoryExitKind;
  year: number | null;
  rawText: string;
};

export type LivestockInventoryOffspring = {
  sex: "female" | "male";
  externalId: string | null;
};

export type LivestockInventoryRecord = {
  animalExternalId: string | null;
  birthDate: string | null;
  /** Present only when the shared column named a lot rather than an exit. */
  lotName: string | null;
  exit: LivestockInventoryExit | null;
  calvingDates: string[];
  dryOffDate: string | null;
  heatDate: string | null;
  winterHeatDate: string | null;
  pregnancyStatus: "pregnant" | "empty" | null;
  offspring: LivestockInventoryOffspring | null;
  /** Verbatim. Carries body condition, breed, udder notes and stray identifiers. */
  observations: string;
};

export type ParsedLivestockInventoryRow = {
  recordNumber: number;
  rowNumber: number;
  rawRecord: ImportRecord;
  normalizedRecord: LivestockInventoryRecord;
  status: ImportRowStatus;
  issues: ImportCenterIssue[];
};

export type LivestockInventoryColumnMap = {
  animalId: number;
  lot: number;
  calvingDates: number[];
  observations: number | null;
  offspring: number | null;
  dryOffDate: number | null;
  heatDate: number | null;
  winterHeatDate: number | null;
  palpation: number | null;
  birthDate: number | null;
};

export type LivestockInventoryDocument = {
  profileKey: typeof LIVESTOCK_INVENTORY_PROFILE_KEY;
  sheetName: string;
  sheetNames: string[];
  headerRowNumber: number;
  columnMap: LivestockInventoryColumnMap;
  date1904: boolean;
  truncated: boolean;
};

export type LivestockInventorySummary = {
  rowCount: number;
  validRowCount: number;
  warningRowCount: number;
  errorRowCount: number;
  skippedRowCount: number;
};

export function parseLivestockInventoryWorkbook(
  input: ArrayBuffer | ArrayBufferView,
  options?: { sheetName?: string | null },
): Promise<{
  document: LivestockInventoryDocument;
  rows: ParsedLivestockInventoryRow[];
  summary: LivestockInventorySummary;
}>;
