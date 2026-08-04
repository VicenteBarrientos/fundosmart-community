import type {
  LivestockAnimal,
  LivestockAnimalStatus,
  LivestockAnimalWeighingWrite,
  LivestockLot,
  LivestockSex,
} from "@/src/core/domain/types";

export type AnimalSpreadsheetColumnKind =
  | "text"
  | "date"
  | "weight"
  | "weighing"
  | "clp"
  | "sex"
  | "status"
  | "lot";

export type AnimalSpreadsheetColumn = {
  key: string;
  label: string;
  kind: AnimalSpreadsheetColumnKind;
  align?: "left" | "right";
  /** Solo en las columnas de pesaje: el día que la columna representa, en ISO. */
  recordedAt?: string;
  width: string;
};

export type AnimalSpreadsheetContext = {
  /** Todo el rebaño, no solo lo visible: el DIIO es único por fundo aunque el filtro esconda al gemelo. */
  knownAnimals?: Pick<LivestockAnimal, "id" | "tag" | "lotId">[];
  lots: Pick<LivestockLot, "id" | "name" | "trackingMode" | "fieldId">[];
  sexLabels: Record<LivestockSex, string>;
  statusLabels: Record<LivestockAnimalStatus, string>;
  /** Los días que tienen columna de pesaje. El orden lo fija el dominio, no quien llama. */
  weighingDates?: string[];
  /** La historia de pesajes por animal, `{ animalId: { fecha: kilos } }`. */
  weighingsByAnimal?: Record<string, Record<string, number>>;
};

export type AnimalSpreadsheetOption = {
  value: string;
  label: string;
};

/** Texto por celda, tal como se tipeó. La planilla nunca guarda valores sin interpretar. */
export type AnimalSpreadsheetEdits = Record<string, Record<string, string>>;

export type AnimalSpreadsheetRow = {
  id: string;
  label: string;
  cells: Record<string, string>;
};

export type AnimalSpreadsheetFieldChange = {
  key: string;
  label: string;
  before: string;
  after: string;
};

export type AnimalSpreadsheetChange = {
  animalId: string;
  /** Verdadero cuando la fila la agregó la planilla y el repositorio todavía no la conoce. */
  created: boolean;
  tag: string;
  fields: AnimalSpreadsheetFieldChange[];
  /** El animal a guardar, con los pesajes que la planilla tocó y el peso vigente ya resuelto. */
  animal: LivestockAnimal & { weighings: LivestockAnimalWeighingWrite[] };
};

export type AnimalSpreadsheetError = {
  animalId: string;
  tag: string;
  key: string;
  label: string;
  text: string | null;
  message: string;
};

export type AnimalSpreadsheetWarning = {
  animalId: string;
  tag: string;
  key: string;
  message: string;
};

export type AnimalSpreadsheetPlan = {
  changes: AnimalSpreadsheetChange[];
  errors: AnimalSpreadsheetError[];
  warnings: AnimalSpreadsheetWarning[];
  changedRowCount: number;
  changedCellCount: number;
  createdRowCount: number;
  blocked: boolean;
};

export type ParsedCell<Value> = {
  value: Value | null;
  error: string | null;
};

/** Las columnas fijas. Las de pesaje las agrega `animalSpreadsheetColumns` según el contexto. */
export const ANIMAL_SPREADSHEET_COLUMNS: readonly AnimalSpreadsheetColumn[];

export function animalSpreadsheetColumns(
  context: AnimalSpreadsheetContext,
): readonly AnimalSpreadsheetColumn[];
export function weighingColumnKey(recordedAt: string): string;
export function weighingColumnDate(columnKey: string): string | null;
export function weighingDatesFromEdits(edits: AnimalSpreadsheetEdits): string[];

export function normalizeLookupText(text: unknown): string;
export function parseSpreadsheetNumber(text: unknown): ParsedCell<number>;
export function parseSpreadsheetDate(text: unknown): ParsedCell<string>;
export function formatSpreadsheetDate(value: string | null | undefined): string;
export function formatSpreadsheetNumber(
  value: number | null | undefined,
  maximumFractionDigits?: number,
): string;
export function spreadsheetColumnOptions(
  columnKey: string,
  context: AnimalSpreadsheetContext,
): AnimalSpreadsheetOption[];
export function formatAnimalCell(
  columnKey: string,
  animal: LivestockAnimal,
  context: AnimalSpreadsheetContext,
): string;
export function parseAnimalCell(
  columnKey: string,
  text: unknown,
  context: AnimalSpreadsheetContext,
): ParsedCell<string | number>;
export function createAnimalDraftRow(id: string, lotId?: string): LivestockAnimal;
export function isDraftAnimalRow(animal: Partial<LivestockAnimal> | null | undefined): boolean;
export function buildAnimalSpreadsheetRow(
  animal: LivestockAnimal,
  context: AnimalSpreadsheetContext,
): AnimalSpreadsheetRow;
export function planAnimalSpreadsheet(input: {
  animals: LivestockAnimal[];
  edits: AnimalSpreadsheetEdits;
  context: AnimalSpreadsheetContext;
}): AnimalSpreadsheetPlan;
export function pruneSpreadsheetDraft(
  edits: AnimalSpreadsheetEdits,
  savedAnimalIds: string[],
): AnimalSpreadsheetEdits;
export function compactSpreadsheetDraft(
  edits: AnimalSpreadsheetEdits,
  animals: LivestockAnimal[],
  context: AnimalSpreadsheetContext,
): AnimalSpreadsheetEdits;
