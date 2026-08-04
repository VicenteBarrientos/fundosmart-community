import type {
  CooprinsemImportIssue,
  CooprinsemImportRowStatus,
  CooprinsemImportSummary,
  CooprinsemSourceTable,
  ImportRecord,
} from "../domain/types";

export const COOPRINSEM_SOURCE_TABLES: {
  traspasos: { name: "_Traspasos.DBF"; requiresEffectiveDate: true; requiredFields: string[] };
  preDetImp: { name: "PreDetimp.dbf"; requiresEffectiveDate: false; requiredFields: string[] };
  laboratory: { name: "CalidadLeche.dbf"; requiresEffectiveDate: false; requiredFields: string[] };
};

export class DbfParseError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export type ParsedDbf = {
  version: number;
  recordCount: number;
  parsedRecordCount: number;
  headerLength: number;
  recordLength: number;
  fields: Array<{ name: string; type: string; length: number; decimals: number; offset: number }>;
  records: Array<{
    recordNumber: number;
    deleted: boolean;
    rawRecord: ImportRecord;
    normalizedRecord: ImportRecord;
    issues: CooprinsemImportIssue[];
  }>;
  fileIssues: CooprinsemImportIssue[];
};

export function parseDbf(input: ArrayBuffer | Uint8Array, options?: { maxRows?: number }): ParsedDbf;

export function buildCooprinsemPreview(
  parsed: ParsedDbf,
  options: { sourceTable: CooprinsemSourceTable; effectiveAt?: string | null },
): {
  sourceTable: CooprinsemSourceTable;
  effectiveAt: string | null;
  rows: Array<{
    recordNumber: number;
    rawRecord: ImportRecord;
    normalizedRecord: ImportRecord | null;
    status: CooprinsemImportRowStatus;
    issues: CooprinsemImportIssue[];
  }>;
  summary: CooprinsemImportSummary;
};
