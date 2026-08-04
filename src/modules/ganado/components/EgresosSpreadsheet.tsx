"use client";

import {
  LIVESTOCK_EXPENSE_CATEGORY_LABELS,
  LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS,
  type Fundo,
  type LivestockExpense,
  type LivestockLot,
  type LivestockPartner,
} from "@/src/core/domain/types";
import {
  SpreadsheetGrid,
  spreadsheetCellKey,
  type SpreadsheetGridColumn,
  type SpreadsheetGridEdit,
  type SpreadsheetGridRow,
} from "@/src/ui/SpreadsheetGrid";
import { Check, CircleAlert, LoaderCircle, Plus, Redo2, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ExpenseSpreadsheetContext,
  ExpenseSpreadsheetEdits,
} from "../domain/expense-spreadsheet.d.mts";
import {
  EXPENSE_SPREADSHEET_COLUMNS,
  buildExpenseSpreadsheetRow,
  compactExpenseDraft,
  createExpenseDraftRow,
  expenseColumnOptions,
  planExpenseSpreadsheet,
  pruneExpenseDraft,
} from "../domain/expense-spreadsheet.mjs";

const DRAFT_STORAGE_KEY = "fundosmart.planilla.ganado.egresos.v1";
const MAX_HISTORY = 100;

export type ExpenseSpreadsheetCommit = (expenses: LivestockExpense[]) => Promise<{ savedIds: string[] }>;

type DraftAddition = {
  fieldId: string;
  id: string;
};

type EgresosSpreadsheetProps = {
  defaultFieldId: string;
  expenses: LivestockExpense[];
  fundos: Fundo[];
  lots: LivestockLot[];
  onClose: () => void;
  onCommit: ExpenseSpreadsheetCommit;
  partners: LivestockPartner[];
};

function readDraft(): { additions: DraftAddition[]; edits: ExpenseSpreadsheetEdits } | null {
  try {
    const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as { additions?: DraftAddition[]; edits?: ExpenseSpreadsheetEdits };
    if (!parsed?.edits || typeof parsed.edits !== "object") return null;
    const additions = Array.isArray(parsed.additions)
      ? parsed.additions.filter((entry): entry is DraftAddition =>
        Boolean(entry) && typeof entry.id === "string" && typeof entry.fieldId === "string")
      : [];
    return { additions, edits: parsed.edits };
  } catch {
    return null;
  }
}

function writeDraft(edits: ExpenseSpreadsheetEdits, additions: DraftAddition[]): void {
  try {
    if (Object.keys(edits).length === 0 && additions.length === 0) {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ additions, edits }));
  } catch {
    // Sin almacenamiento local la planilla sigue funcionando; solo se pierde el borrador.
  }
}

export function EgresosSpreadsheet({
  defaultFieldId,
  expenses,
  fundos,
  lots,
  onClose,
  onCommit,
  partners,
}: EgresosSpreadsheetProps) {
  const context = useMemo<ExpenseSpreadsheetContext>(() => ({
    categoryLabels: LIVESTOCK_EXPENSE_CATEGORY_LABELS,
    fundos: fundos.map(({ id, name }) => ({ id, name })),
    lots: lots.map(({ id, name }) => ({ id, name })),
    partners: partners.map(({ id, name }) => ({ id, name })),
    paymentSourceLabels: LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS,
  }), [fundos, lots, partners]);

  const [initialDraft] = useState(() => {
    const draft = readDraft();
    const additions = draft?.additions ?? [];
    const addedIds = new Set(additions.map((entry) => entry.id));
    const ofAdditions = Object.fromEntries(
      Object.entries(draft?.edits ?? {}).filter(([expenseId]) => addedIds.has(expenseId)),
    );
    const ofExisting = draft ? compactExpenseDraft(draft.edits, expenses, context) : {};
    return { additions, edits: { ...ofExisting, ...ofAdditions } };
  });

  const [edits, setEdits] = useState<ExpenseSpreadsheetEdits>(initialDraft.edits);
  const [additions, setAdditions] = useState<DraftAddition[]>(initialDraft.additions);
  const [history, setHistory] = useState<ExpenseSpreadsheetEdits[]>([]);
  const [future, setFuture] = useState<ExpenseSpreadsheetEdits[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const draftExpenses = useMemo(
    () => additions.map((entry) => createExpenseDraftRow(entry.id, entry.fieldId)),
    [additions],
  );
  const spreadsheetExpenses = useMemo(() => [...expenses, ...draftExpenses], [draftExpenses, expenses]);
  const addedIds = useMemo(() => new Set(additions.map((entry) => entry.id)), [additions]);

  useEffect(() => {
    writeDraft(edits, additions);
  }, [additions, edits]);

  const compactAgainstSaved = useCallback((candidate: ExpenseSpreadsheetEdits) => {
    const ofAdditions = Object.fromEntries(
      Object.entries(candidate).filter(([expenseId]) => addedIds.has(expenseId)),
    );
    return { ...compactExpenseDraft(candidate, expenses, context), ...ofAdditions };
  }, [addedIds, context, expenses]);

  const applyEdits = useCallback((incoming: SpreadsheetGridEdit[]) => {
    if (incoming.length === 0) return;
    setHistory((stack) => [...stack, edits].slice(-MAX_HISTORY));
    setFuture([]);
    const next: ExpenseSpreadsheetEdits = { ...edits };
    for (const edit of incoming) {
      next[edit.rowId] = { ...(next[edit.rowId] ?? {}), [edit.key]: edit.value };
    }
    setEdits(compactAgainstSaved(next));
    setFailure(null);
  }, [compactAgainstSaved, edits]);

  const undo = useCallback(() => {
    setHistory((stack) => {
      if (stack.length === 0) return stack;
      setFuture((forward) => [edits, ...forward].slice(0, MAX_HISTORY));
      setEdits(stack[stack.length - 1]);
      return stack.slice(0, -1);
    });
  }, [edits]);

  const redo = useCallback(() => {
    setFuture((stack) => {
      if (stack.length === 0) return stack;
      setHistory((back) => [...back, edits].slice(-MAX_HISTORY));
      setEdits(stack[0]);
      return stack.slice(1);
    });
  }, [edits]);

  const addRows = useCallback((count: number) => {
    setAdditions((current) => [
      ...current,
      ...Array.from({ length: count }, () => ({ fieldId: defaultFieldId, id: crypto.randomUUID() })),
    ]);
    setFailure(null);
    setNotice(count === 1
      ? "Fila agregada al final. Necesita descripción y monto para poder confirmarse."
      : `${count} filas agregadas al final. Cada una necesita descripción y monto.`);
  }, [defaultFieldId]);

  const removeRow = useCallback((rowId: string) => {
    setAdditions((current) => current.filter((entry) => entry.id !== rowId));
    setEdits((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    setFailure(null);
  }, []);

  const columns = useMemo<SpreadsheetGridColumn[]>(
    () => EXPENSE_SPREADSHEET_COLUMNS.map((column) => ({
      align: column.align,
      key: column.key,
      label: column.label,
      options: column.kind === "text" || column.kind === "date" || column.kind === "clp"
        ? undefined
        : expenseColumnOptions(column.key, context),
      width: column.width,
    })),
    [context],
  );

  const rows = useMemo<SpreadsheetGridRow[]>(() => spreadsheetExpenses.map((expense) => {
    const baseline = buildExpenseSpreadsheetRow(expense, context);
    const edited = edits[expense.id];
    const added = addedIds.has(expense.id);
    return {
      badge: added ? "nuevo" : undefined,
      cells: edited ? { ...baseline.cells, ...edited } : baseline.cells,
      id: expense.id,
      label: added ? "Egreso nuevo" : expense.description,
      removable: added,
    };
  }), [addedIds, context, edits, spreadsheetExpenses]);

  const plan = useMemo(
    () => planExpenseSpreadsheet({ expenses: spreadsheetExpenses, edits, context }),
    [context, edits, spreadsheetExpenses],
  );

  const cellErrors = useMemo(() => {
    const map: Record<string, string> = {};
    for (const error of plan.errors) map[spreadsheetCellKey(error.expenseId, error.key)] = error.message;
    return map;
  }, [plan.errors]);

  const changedCells = useMemo(() => {
    const set = new Set<string>();
    for (const change of plan.changes) {
      for (const field of change.fields) set.add(spreadsheetCellKey(change.expenseId, field.key));
    }
    return set;
  }, [plan.changes]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const dirty = plan.changedCellCount > 0 || plan.errors.length > 0 || additions.length > 0;

  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) { event.preventDefault(); }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function confirm() {
    setSaving(true);
    setFailure(null);
    try {
      const createdAt = new Date().toISOString();
      const result = await onCommit(plan.changes.map((change) =>
        (change.created ? { ...change.expense, createdAt } : change.expense)));
      const saved = new Set(result.savedIds);
      setEdits((current) => pruneExpenseDraft(current, result.savedIds));
      setAdditions((current) => current.filter((entry) => !saved.has(entry.id)));
      setHistory([]);
      setFuture([]);
      setReviewing(false);
      setNotice(`Planilla confirmada: ${result.savedIds.length} ${result.savedIds.length === 1 ? "egreso guardado" : "egresos guardados"}.`);
    } catch (cause) {
      const savedIds = cause instanceof Error && "savedIds" in cause ? (cause as { savedIds: string[] }).savedIds : [];
      if (savedIds.length > 0) {
        const saved = new Set(savedIds);
        setEdits((current) => pruneExpenseDraft(current, savedIds));
        setAdditions((current) => current.filter((entry) => !saved.has(entry.id)));
      }
      setFailure(
        cause instanceof Error
          ? savedIds.length > 0
            ? `${cause.message} Se guardaron ${savedIds.length} ${savedIds.length === 1 ? "egreso" : "egresos"} antes de detenerse; el resto sigue en la planilla para reintentar.`
            : cause.message
          : "No fue posible confirmar la planilla.",
      );
      setReviewing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mt-4 rounded-[20px] border-2 border-accent bg-white p-4">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Modo planilla</p>
          <h3 className="mt-0.5 text-sm font-black text-ink">
            Editando {expenses.length} {expenses.length === 1 ? "egreso" : "egresos"}
          </h3>
          <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
            Flechas para moverte · Enter edita y baja · Ctrl+V pega desde Excel · Ctrl+D rellena hacia abajo · Ctrl+Z deshace
          </p>
        </div>
        <button
          className="flex h-10 items-center gap-2 rounded-xl border border-line-steel px-3 text-xs font-black text-ink-muted"
          onClick={() => {
            if (dirty && !window.confirm("Tienes cambios sin confirmar. Se guardan como borrador y los recuperas al volver. ¿Salir de la planilla?")) return;
            onClose();
          }}
          type="button"
        >
          <X size={15} /> Salir de la planilla
        </button>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
          disabled={history.length === 0}
          onClick={undo}
          type="button"
        >
          <Undo2 size={14} /> Deshacer
        </button>
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
          disabled={future.length === 0}
          onClick={redo}
          type="button"
        >
          <Redo2 size={14} /> Rehacer
        </button>
        <span className="flex items-center">
          <button
            className="flex h-9 items-center gap-1.5 rounded-l-lg border border-line-steel px-2.5 text-[12px] font-black text-ink disabled:opacity-40"
            disabled={saving}
            onClick={() => addRows(1)}
            type="button"
          >
            <Plus size={14} /> Agregar fila
          </button>
          <button
            className="-ml-px flex h-9 items-center rounded-r-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
            disabled={saving}
            onClick={() => addRows(10)}
            type="button"
          >
            +10
          </button>
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] font-bold text-ink-subtle">
            {plan.changedCellCount > 0
              ? `${plan.changedCellCount} ${plan.changedCellCount === 1 ? "celda cambiada" : "celdas cambiadas"}`
              : "Sin cambios"}
          </span>
          <button
            className="flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-40"
            disabled={plan.changedRowCount === 0 || plan.blocked || saving}
            onClick={() => setReviewing(true)}
            type="button"
          >
            <Check size={15} /> Revisar {plan.changedRowCount > 0 ? `${plan.changedRowCount} ` : ""}
            {plan.changedRowCount === 1 ? "cambio" : "cambios"}
          </button>
        </div>
      </div>

      {notice && <p className="mt-3 rounded-xl bg-surface-alt px-3 py-2 text-[12px] font-bold text-ink-muted">{notice}</p>}
      {failure && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-[12px] font-bold text-red-700">
          <CircleAlert className="mt-0.5 shrink-0" size={14} /> {failure}
        </p>
      )}

      {plan.errors.length > 0 && (
        <div className="mt-3 rounded-xl border border-red-100 bg-red-50 px-3 py-2">
          <p className="flex items-center gap-2 text-[12px] font-black text-red-700">
            <CircleAlert size={14} /> {plan.errors.length} {plan.errors.length === 1 ? "celda no se entiende" : "celdas no se entienden"}. Nada se confirma hasta arreglarlas.
          </p>
          <ul className="mt-1.5 space-y-1">
            {plan.errors.slice(0, 8).map((error) => (
              <li className="text-[12px] font-semibold text-red-700" key={`${error.expenseId}-${error.key}`}>
                <span className="font-black">{error.description || "Egreso nuevo"} · {error.label}:</span>{" "}
                {error.text ? `"${error.text}" — ` : ""}{error.message}
              </li>
            ))}
            {plan.errors.length > 8 && <li className="text-[12px] font-bold text-red-700">y {plan.errors.length - 8} más.</li>}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <SpreadsheetGrid
          ariaLabel="Planilla de egresos del rebaño"
          canRedo={future.length > 0}
          canUndo={history.length > 0}
          cellErrors={cellErrors}
          changedCells={changedCells}
          columns={columns}
          onEdit={applyEdits}
          onNotice={setNotice}
          onRedo={redo}
          onRemoveRow={removeRow}
          onUndo={undo}
          rows={rows}
        />
      </div>

      <p className="mt-2 text-[12px] font-semibold text-ink-subtle">
        Pegar no crea filas: agrégalas antes con Agregar fila. Borrar un egreso se sigue haciendo desde la lista, mirándolo.
      </p>

      {reviewing && (
        <div aria-labelledby="planilla-egresos-revision" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6" role="dialog">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-[20px] bg-white sm:rounded-[20px]">
            <header className="border-b border-line-steel px-5 py-4">
              <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Antes de confirmar</p>
              <h3 className="mt-0.5 text-sm font-black text-ink" id="planilla-egresos-revision">
                {plan.changedRowCount} {plan.changedRowCount === 1 ? "egreso cambia" : "egresos cambian"} · {plan.changedCellCount} {plan.changedCellCount === 1 ? "celda" : "celdas"}
                {plan.createdRowCount > 0 && ` · ${plan.createdRowCount} ${plan.createdRowCount === 1 ? "nuevo" : "nuevos"}`}
              </h3>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
              <ul className="space-y-2">
                {plan.changes.map((change) => (
                  <li className={`rounded-xl border px-3 py-2 ${change.created ? "border-accent bg-band/40" : "border-line-steel"}`} key={change.expenseId}>
                    <p className="text-xs font-black text-ink">
                      {change.description}
                      {change.created && <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-white">Egreso nuevo</span>}
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {change.fields.map((field) => (
                        <li className="text-[12px] font-semibold text-ink-muted" key={field.key}>
                          {field.label}:{" "}
                          <span className="text-ink-subtle line-through">{field.before || "vacío"}</span>{" "}
                          <span aria-hidden="true">→</span>{" "}
                          <span className="font-black text-ink">{field.after || "vacío"}</span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </div>
            <footer className="flex flex-wrap items-center gap-2 border-t border-line-steel px-5 py-4">
              <p className="min-w-0 flex-1 text-[12px] font-semibold text-ink-subtle">
                Cada egreso queda con su registro en la auditoría de plata.
              </p>
              <button
                className="flex h-11 items-center gap-2 rounded-xl border border-line-steel px-4 text-xs font-black text-ink-muted"
                disabled={saving}
                onClick={() => setReviewing(false)}
                type="button"
              >
                Volver a la planilla
              </button>
              <button
                className="flex h-11 items-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-60"
                disabled={saving}
                onClick={confirm}
                type="button"
              >
                {saving ? <><LoaderCircle className="animate-spin" size={15} /> Guardando</> : <><Check size={15} /> Confirmar cambios</>}
              </button>
            </footer>
          </div>
        </div>
      )}
    </section>
  );
}
