import type {
  Fundo,
  LivestockExpense,
  LivestockExpenseCategory,
  LivestockExpensePaymentSource,
  LivestockLot,
  LivestockPartner,
} from "@/src/core/domain/types";
import type { ParsedSpreadsheetValue, SpreadsheetOption } from "./spreadsheet-values.d.mts";

export type ExpenseSpreadsheetColumnKind =
  | "text"
  | "date"
  | "clp"
  | "category"
  | "paymentSource"
  | "partner"
  | "field"
  | "lot";

export type ExpenseSpreadsheetColumn = {
  key: string;
  label: string;
  kind: ExpenseSpreadsheetColumnKind;
  align?: "left" | "right";
  width: string;
};

export type ExpenseSpreadsheetContext = {
  categoryLabels: Record<LivestockExpenseCategory, string>;
  fundos: Pick<Fundo, "id" | "name">[];
  lots: Pick<LivestockLot, "id" | "name">[];
  partners: Pick<LivestockPartner, "id" | "name">[];
  paymentSourceLabels: Record<LivestockExpensePaymentSource, string>;
};

export type ExpenseSpreadsheetEdits = Record<string, Record<string, string>>;

export type ExpenseSpreadsheetRow = {
  id: string;
  label: string;
  cells: Record<string, string>;
};

export type ExpenseSpreadsheetFieldChange = {
  key: string;
  label: string;
  before: string;
  after: string;
};

export type ExpenseSpreadsheetChange = {
  expenseId: string;
  created: boolean;
  description: string;
  fields: ExpenseSpreadsheetFieldChange[];
  expense: LivestockExpense;
};

export type ExpenseSpreadsheetError = {
  expenseId: string;
  description: string;
  key: string;
  label: string;
  text: string | null;
  message: string;
};

export type ExpenseSpreadsheetPlan = {
  changes: ExpenseSpreadsheetChange[];
  errors: ExpenseSpreadsheetError[];
  changedRowCount: number;
  changedCellCount: number;
  createdRowCount: number;
  blocked: boolean;
};

export const EXPENSE_SPREADSHEET_COLUMNS: readonly ExpenseSpreadsheetColumn[];

export function createExpenseDraftRow(id: string, fieldId?: string): LivestockExpense;
export function isDraftExpenseRow(expense: Partial<LivestockExpense> | null | undefined): boolean;
export function expenseColumnOptions(
  columnKey: string,
  context: ExpenseSpreadsheetContext,
): SpreadsheetOption[];
export function formatExpenseCell(
  columnKey: string,
  expense: LivestockExpense,
  context: ExpenseSpreadsheetContext,
): string;
export function parseExpenseCell(
  columnKey: string,
  text: unknown,
  context: ExpenseSpreadsheetContext,
): ParsedSpreadsheetValue<string | number>;
export function buildExpenseSpreadsheetRow(
  expense: LivestockExpense,
  context: ExpenseSpreadsheetContext,
): ExpenseSpreadsheetRow;
export function planExpenseSpreadsheet(input: {
  expenses: LivestockExpense[];
  edits: ExpenseSpreadsheetEdits;
  context: ExpenseSpreadsheetContext;
}): ExpenseSpreadsheetPlan;
export function pruneExpenseDraft(
  edits: ExpenseSpreadsheetEdits,
  savedExpenseIds: string[],
): ExpenseSpreadsheetEdits;
export function compactExpenseDraft(
  edits: ExpenseSpreadsheetEdits,
  expenses: LivestockExpense[],
  context: ExpenseSpreadsheetContext,
): ExpenseSpreadsheetEdits;
