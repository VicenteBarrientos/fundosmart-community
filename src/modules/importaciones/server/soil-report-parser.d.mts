import type {
  CooprinsemSoilReportDocument,
  ImportCenterIssue,
  ImportRecord,
  ImportRowStatus,
} from "../domain/types";

export class SoilReportParseError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export function parseCooprinsemSoilReportText(
  input: string | string[],
): CooprinsemSoilReportDocument;

export function soilReportPreviewRows(document: CooprinsemSoilReportDocument): Array<{
  recordNumber: number;
  rawRecord: ImportRecord;
  normalizedRecord: ImportRecord;
  status: ImportRowStatus;
  issues: ImportCenterIssue[];
}>;
