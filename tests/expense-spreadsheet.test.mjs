import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPENSE_SPREADSHEET_COLUMNS,
  buildExpenseSpreadsheetRow,
  compactExpenseDraft,
  createExpenseDraftRow,
  expenseColumnOptions,
  formatExpenseCell,
  parseExpenseCell,
  planExpenseSpreadsheet,
  pruneExpenseDraft,
} from "../src/modules/ganado/domain/expense-spreadsheet.mjs";

const CONTEXT = {
  categoryLabels: {
    alimento: "Alimento",
    compra_animales: "Compra de animales",
    combustible: "Combustible",
    flete: "Flete",
    sanidad: "Sanidad",
    otro: "Otro",
  },
  fundos: [{ id: "fundo-1", name: "Fundo Norte" }],
  lots: [{ id: "lot-engorda", name: "Engorda" }],
  partners: [{ id: "socio-1", name: "Socio Uno" }],
  paymentSourceLabels: { society: "Organización", partner: "Socio", unassigned: "Origen pendiente" },
};

function expense(overrides = {}) {
  return {
    id: "gasto-1",
    fieldId: "fundo-1",
    date: "2026-07-01",
    description: "Fardos de avena",
    category: "alimento",
    amountClp: 450000,
    paymentSource: "society",
    paidById: null,
    lotId: null,
    createdAt: "2026-07-01T12:00:00.000Z",
    ...overrides,
  };
}

test("cada celda del egreso se puede volver a leer desde su propio texto", () => {
  const source = expense();
  const row = buildExpenseSpreadsheetRow(source, CONTEXT);
  for (const column of EXPENSE_SPREADSHEET_COLUMNS) {
    const text = row.cells[column.key];
    if (text === "") continue;
    const parsed = parseExpenseCell(column.key, text, CONTEXT);
    assert.equal(parsed.error, null, `${column.key} no se pudo re-interpretar`);
    assert.equal(
      formatExpenseCell(column.key, { ...source, [column.key]: parsed.value }, CONTEXT),
      text,
      `${column.key} no sobrevive la ida y vuelta`,
    );
  }
});

test("lee un monto pegado desde Excel con puntos de miles", () => {
  assert.equal(parseExpenseCell("amountClp", "1.250.000", CONTEXT).value, 1250000);
  assert.equal(parseExpenseCell("amountClp", "$ 450.000", CONTEXT).value, 450000);
  assert.match(parseExpenseCell("amountClp", "1250,50", CONTEXT).error, /pesos enteros/);
  assert.match(parseExpenseCell("amountClp", "0", CONTEXT).error, /mayor que cero/);
  assert.match(parseExpenseCell("amountClp", "", CONTEXT).error, /Indica el monto/);
});

test("acepta una categoría escrita sin acentos ni mayúsculas", () => {
  assert.equal(parseExpenseCell("category", "sanidad", CONTEXT).value, "sanidad");
  assert.equal(parseExpenseCell("category", "COMPRA DE ANIMALES", CONTEXT).value, "compra_animales");
  assert.match(parseExpenseCell("category", "veterinario", CONTEXT).error, /Opciones/);
});

test("fundo, lote y socio pueden quedar vacíos; categoría y origen del pago no", () => {
  assert.deepEqual(parseExpenseCell("fieldId", "", CONTEXT), { value: null, error: null });
  assert.deepEqual(parseExpenseCell("lotId", "", CONTEXT), { value: null, error: null });
  assert.deepEqual(parseExpenseCell("paidById", "", CONTEXT), { value: null, error: null });
  assert.match(parseExpenseCell("category", "", CONTEXT).error, /Indica/);
  assert.match(parseExpenseCell("paymentSource", "", CONTEXT).error, /Indica/);
});

test("la descripción no puede quedar vacía", () => {
  assert.match(parseExpenseCell("description", "  ", CONTEXT).error, /Describe el egreso/);
});

test("planifica solo las celdas que realmente cambian", () => {
  const plan = planExpenseSpreadsheet({
    expenses: [expense()],
    edits: { "gasto-1": { amountClp: "480.000", description: "Fardos de avena" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.changedCellCount, 1);
  assert.deepEqual(plan.changes[0].fields.map((field) => field.key), ["amountClp"]);
  assert.equal(plan.changes[0].expense.amountClp, 480000);
  assert.equal(plan.changes[0].created, false);
});

test("un pago de socio sin socio se detiene antes de llegar al repositorio", () => {
  const plan = planExpenseSpreadsheet({
    expenses: [expense()],
    edits: { "gasto-1": { paymentSource: "Socio" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.equal(plan.errors[0].key, "paidById");
});

test("un socio en un egreso que no pagó un socio también se detiene", () => {
  const plan = planExpenseSpreadsheet({
    expenses: [expense()],
    edits: { "gasto-1": { paidById: "Socio Uno" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.match(plan.errors[0].message, /cambia Pagó/);
});

test("una fila agregada y nunca llenada se ignora sola", () => {
  const plan = planExpenseSpreadsheet({
    expenses: [expense(), createExpenseDraftRow("nuevo-1", "fundo-1")],
    edits: {},
    context: CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.createdRowCount, 0);
});

test("una fila agregada y llenada se planifica como egreso nuevo", () => {
  const plan = planExpenseSpreadsheet({
    expenses: [createExpenseDraftRow("nuevo-1", "fundo-1")],
    edits: { "nuevo-1": { description: "Vacunas", amountClp: "120.000", category: "Sanidad", date: "17/07/2026" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.createdRowCount, 1);
  assert.equal(plan.changes[0].created, true);
  assert.equal(plan.changes[0].expense.amountClp, 120000);
  assert.equal(plan.changes[0].expense.category, "sanidad");
  assert.equal(plan.changes[0].expense.date, "2026-07-17");
  assert.equal(plan.changes[0].expense.fieldId, "fundo-1");
});

test("una fila nueva a medio llenar exige descripción y monto", () => {
  const plan = planExpenseSpreadsheet({
    expenses: [createExpenseDraftRow("nuevo-1", "fundo-1")],
    edits: { "nuevo-1": { category: "Sanidad" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.deepEqual(
    plan.errors.map((error) => error.key).sort(),
    ["amountClp", "description"],
  );
});

test("el borrador se poda con lo que ya se guardó y suelta lo que volvió a coincidir", () => {
  assert.deepEqual(
    pruneExpenseDraft({ "gasto-1": { description: "x" }, "gasto-2": { description: "y" } }, ["gasto-1"]),
    { "gasto-2": { description: "y" } },
  );
  assert.deepEqual(
    compactExpenseDraft({ "gasto-1": { description: "Fardos de avena", category: "Sanidad" } }, [expense()], CONTEXT),
    { "gasto-1": { category: "Sanidad" } },
  );
});

test("las opciones de cada columna salen del contexto", () => {
  assert.deepEqual(expenseColumnOptions("partner", CONTEXT), []);
  assert.deepEqual(expenseColumnOptions("paidById", CONTEXT), [{ value: "socio-1", label: "Socio Uno" }]);
  assert.deepEqual(expenseColumnOptions("fieldId", CONTEXT), [{ value: "fundo-1", label: "Fundo Norte" }]);
});
