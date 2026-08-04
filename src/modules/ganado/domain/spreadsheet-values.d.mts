export type SpreadsheetOption = {
  label: string;
  value: string;
};

export type ParsedSpreadsheetValue<Value> = {
  value: Value | null;
  error: string | null;
};

export function normalizeLookupText(text: unknown): string;
export function parseSpreadsheetNumber(text: unknown): ParsedSpreadsheetValue<number>;
export function parseSpreadsheetDate(text: unknown): ParsedSpreadsheetValue<string>;
export function parseSpreadsheetClp(text: unknown): ParsedSpreadsheetValue<number>;
export function formatSpreadsheetDate(value: string | null | undefined): string;
export function formatSpreadsheetNumber(
  value: number | null | undefined,
  maximumFractionDigits?: number,
): string;
export function matchSpreadsheetOption(
  options: readonly SpreadsheetOption[],
  text: unknown,
): SpreadsheetOption | null;
