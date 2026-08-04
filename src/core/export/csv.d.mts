export type CsvCell = string | number | boolean | null | undefined;

export function serializeCsv(headers: CsvCell[], rows: CsvCell[][]): string;

export function downloadCsv(filename: string, headers: CsvCell[], rows: CsvCell[][]): void;

export function downloadCsvText(filename: string, csv: string): void;
