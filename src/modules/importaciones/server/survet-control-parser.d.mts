import type {
  ImportCenterIssue,
  ImportRecord,
  ImportRowStatus,
  SurvetMilkControlDocument,
} from "../domain/types";

export const SURVET_MAX_ROWS: 200;

export class SurvetControlParseError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export type ParsedSurvetControlRow = {
  recordNumber: number;
  rawRecord: ImportRecord;
  normalizedRecord: ImportRecord;
  status: ImportRowStatus;
  issues: ImportCenterIssue[];
};

export function parseSurvetControlWorkbook(input: ArrayBuffer | ArrayBufferView): Promise<{
  document: SurvetMilkControlDocument;
  rows: ParsedSurvetControlRow[];
}>;
