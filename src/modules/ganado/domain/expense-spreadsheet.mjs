/**
 * Lógica pura de la planilla de egresos.
 *
 * Misma forma que la de animales —texto en las celdas, plan antes de escribir, errores
 * que apuntan a su celda— sobre la entidad donde de verdad se anota la plata. Los
 * lectores de valores son los compartidos: un monto pegado desde Excel se interpreta
 * igual acá que en un peso.
 */

import {
  formatSpreadsheetDate,
  formatSpreadsheetNumber,
  matchSpreadsheetOption,
  parseSpreadsheetClp,
  parseSpreadsheetDate,
} from "./spreadsheet-values.mjs";

export const EXPENSE_SPREADSHEET_COLUMNS = Object.freeze([
  Object.freeze({ key: "date", label: "Fecha", kind: "date", width: "8.5rem" }),
  Object.freeze({ key: "description", label: "Descripción", kind: "text", width: "16rem" }),
  Object.freeze({ key: "category", label: "Categoría", kind: "category", width: "11rem" }),
  Object.freeze({ key: "amountClp", label: "Monto", kind: "clp", align: "right", width: "10rem" }),
  Object.freeze({ key: "paymentSource", label: "Pagó", kind: "paymentSource", width: "11rem" }),
  Object.freeze({ key: "paidById", label: "Socio", kind: "partner", width: "11rem" }),
  Object.freeze({ key: "fieldId", label: "Fundo", kind: "field", width: "12rem" }),
  Object.freeze({ key: "lotId", label: "Lote", kind: "lot", width: "12rem" }),
]);

const COLUMN_BY_KEY = new Map(EXPENSE_SPREADSHEET_COLUMNS.map((column) => [column.key, column]));

/** Un egreso que la planilla agregó y el repositorio todavía no conoce. */
export function createExpenseDraftRow(id, fieldId = "") {
  return {
    id,
    fieldId: fieldId || null,
    date: null,
    description: "",
    category: "otro",
    amountClp: 0,
    paymentSource: "society",
    paidById: null,
    lotId: null,
    createdAt: "",
  };
}

export function isDraftExpenseRow(expense) {
  return !expense?.createdAt;
}

function optionsForColumn(column, context) {
  if (column.kind === "category") {
    return Object.entries(context.categoryLabels ?? {}).map(([value, label]) => ({ value, label }));
  }
  if (column.kind === "paymentSource") {
    return Object.entries(context.paymentSourceLabels ?? {}).map(([value, label]) => ({ value, label }));
  }
  if (column.kind === "partner") {
    return (context.partners ?? []).map((partner) => ({ value: partner.id, label: partner.name }));
  }
  if (column.kind === "field") {
    return (context.fundos ?? []).map((fundo) => ({ value: fundo.id, label: fundo.name }));
  }
  if (column.kind === "lot") {
    return (context.lots ?? []).map((lot) => ({ value: lot.id, label: lot.name }));
  }
  return [];
}

export function expenseColumnOptions(columnKey, context) {
  const column = COLUMN_BY_KEY.get(columnKey);
  return column ? optionsForColumn(column, context) : [];
}

/** Las columnas que pueden quedar vacías: un egreso no siempre tiene fundo, lote ni socio. */
const OPTIONAL_OPTION_COLUMNS = new Set(["paidById", "fieldId", "lotId"]);

export function formatExpenseCell(columnKey, expense, context) {
  const column = COLUMN_BY_KEY.get(columnKey);
  if (!column) return "";
  const value = expense[columnKey];

  if (column.kind === "date") return formatSpreadsheetDate(value);
  if (column.kind === "clp") return formatSpreadsheetNumber(value, 0);
  if (column.kind !== "text") {
    const option = optionsForColumn(column, context).find((entry) => entry.value === value);
    return option?.label ?? "";
  }
  return value === null || value === undefined ? "" : String(value);
}

export function parseExpenseCell(columnKey, text, context) {
  const column = COLUMN_BY_KEY.get(columnKey);
  if (!column) return { value: null, error: "Columna desconocida." };
  const raw = String(text ?? "").trim();

  if (column.kind === "date") return parseSpreadsheetDate(raw);

  if (column.kind === "clp") {
    const parsed = parseSpreadsheetClp(raw);
    if (parsed.error) return parsed;
    if (parsed.value === null) return { value: null, error: "Indica el monto del egreso." };
    if (parsed.value <= 0) return { value: null, error: "El monto debe ser mayor que cero." };
    return parsed;
  }

  if (column.kind === "text") {
    if (columnKey === "description" && raw === "") {
      return { value: null, error: "Describe el egreso: sin descripción nadie sabe qué se pagó." };
    }
    return { value: raw, error: null };
  }

  const options = optionsForColumn(column, context);
  if (raw === "") {
    if (OPTIONAL_OPTION_COLUMNS.has(columnKey)) return { value: null, error: null };
    return { value: null, error: `Indica ${column.label.toLowerCase()}.` };
  }
  const option = matchSpreadsheetOption(options, raw);
  if (!option) {
    const known = options.map((entry) => entry.label).join(", ");
    return {
      value: null,
      error: known ? `Valor no reconocido. Opciones: ${known}.` : `No hay opciones disponibles para ${column.label.toLowerCase()}.`,
    };
  }
  return { value: option.value, error: null };
}

export function buildExpenseSpreadsheetRow(expense, context) {
  const cells = {};
  for (const column of EXPENSE_SPREADSHEET_COLUMNS) {
    cells[column.key] = formatExpenseCell(column.key, expense, context);
  }
  return { id: expense.id, label: expense.description || "Egreso nuevo", cells };
}

/** Una fila agregada y nunca llenada es un renglón de sobra, no un egreso a medio anotar. */
function isEmptyDraftRow(next) {
  return !next.description
    && !next.date
    && next.amountClp === 0
    && next.category === "otro"
    && next.paymentSource === "society"
    && !next.paidById
    && !next.lotId;
}

function rowLevelErrors(expense, next) {
  const errors = [];
  const label = (key) => COLUMN_BY_KEY.get(key)?.label ?? key;

  const isDraft = isDraftExpenseRow(expense);
  if (isDraft && !next.description) {
    errors.push({ key: "description", label: label("description"), message: "Un egreso nuevo necesita su descripción." });
  }
  // Un solo mensaje por celda: si la fila es nueva, el que explica que falta el monto;
  // si ya existía, el que explica que el monto quedó en cero.
  if (!next.amountClp || next.amountClp <= 0) {
    errors.push({
      key: "amountClp",
      label: label("amountClp"),
      message: isDraft ? "Un egreso nuevo necesita su monto." : "El monto debe ser mayor que cero.",
    });
  }
  // El repositorio exige el socio cuando el pago lo adelantó alguien: sin él, el egreso se
  // rechaza al confirmar y nadie sabría cuál de las filas lo rompió.
  if (next.paymentSource === "partner" && !next.paidById) {
    errors.push({ key: "paidById", label: label("paidById"), message: "Indica qué socio adelantó el pago." });
  }
  if (next.paymentSource !== "partner" && next.paidById) {
    errors.push({ key: "paidById", label: label("paidById"), message: "Solo un egreso pagado por un socio lleva socio: cambia Pagó o vacía esta celda." });
  }
  return errors;
}

/**
 * Convierte la planilla editada en el plan exacto de lo que va a cambiar.
 *
 * Igual que en animales: nada se confirma mientras haya una celda que el sistema no
 * entiende, y cada error apunta a su celda.
 */
export function planExpenseSpreadsheet({ expenses, edits, context }) {
  const changes = [];
  const errors = [];
  const editedByExpense = edits ?? {};
  let changedCellCount = 0;
  let createdRowCount = 0;

  for (const expense of expenses) {
    const edited = editedByExpense[expense.id];
    const isDraft = isDraftExpenseRow(expense);
    if (!edited && !isDraft) continue;

    const next = { ...expense };
    const fields = [];
    let rowHasCellError = false;

    for (const column of EXPENSE_SPREADSHEET_COLUMNS) {
      if (!edited || !(column.key in edited)) continue;
      const text = edited[column.key];
      const before = formatExpenseCell(column.key, expense, context);
      if (text === before) continue;

      const parsed = parseExpenseCell(column.key, text, context);
      if (parsed.error) {
        errors.push({
          expenseId: expense.id,
          description: expense.description,
          key: column.key,
          label: column.label,
          text,
          message: parsed.error,
        });
        rowHasCellError = true;
        continue;
      }
      next[column.key] = parsed.value;
      fields.push({ key: column.key, label: column.label, before, after: formatExpenseCell(column.key, next, context) });
      changedCellCount += 1;
    }

    if (isDraft && isEmptyDraftRow(next)) continue;
    if (!isDraft && fields.length === 0 && !rowHasCellError) continue;

    for (const error of rowLevelErrors(expense, next)) {
      errors.push({ expenseId: expense.id, description: expense.description, text: null, ...error });
      rowHasCellError = true;
    }

    if (rowHasCellError) continue;
    if (!isDraft && fields.length === 0) continue;

    if (isDraft) createdRowCount += 1;
    changes.push({
      expenseId: expense.id,
      created: isDraft,
      description: next.description || expense.description,
      fields,
      expense: next,
    });
  }

  return {
    changes,
    errors,
    changedRowCount: changes.length,
    changedCellCount,
    createdRowCount,
    blocked: errors.length > 0,
  };
}

/** Deja en el borrador solo lo que sigue sin guardarse. */
export function pruneExpenseDraft(edits, savedExpenseIds) {
  const saved = new Set(savedExpenseIds ?? []);
  const remaining = {};
  for (const [expenseId, cells] of Object.entries(edits ?? {})) {
    if (saved.has(expenseId)) continue;
    remaining[expenseId] = cells;
  }
  return remaining;
}

/** Quita del borrador las celdas cuyo texto volvió a coincidir con lo guardado. */
export function compactExpenseDraft(edits, expenses, context) {
  const expenseById = new Map(expenses.map((expense) => [expense.id, expense]));
  const compacted = {};
  for (const [expenseId, cells] of Object.entries(edits ?? {})) {
    const expense = expenseById.get(expenseId);
    if (!expense) continue;
    const kept = {};
    for (const [key, text] of Object.entries(cells)) {
      if (text === formatExpenseCell(key, expense, context)) continue;
      kept[key] = text;
    }
    if (Object.keys(kept).length > 0) compacted[expenseId] = kept;
  }
  return compacted;
}
