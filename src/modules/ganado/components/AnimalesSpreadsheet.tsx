"use client";

import {
  LIVESTOCK_ANIMAL_STATUS_LABELS,
  LIVESTOCK_SEX_LABELS,
  type LivestockAnimal,
  type LivestockLot,
  type LivestockWeighing,
} from "@/src/core/domain/types";
import {
  SpreadsheetGrid,
  spreadsheetCellKey,
  type SpreadsheetGridColumn,
  type SpreadsheetGridEdit,
  type SpreadsheetGridRow,
} from "@/src/ui/SpreadsheetGrid";
import {
  ArrowDownToLine,
  CalendarPlus,
  Check,
  CircleAlert,
  ClipboardPaste,
  Eye,
  EyeOff,
  LoaderCircle,
  Plus,
  Redo2,
  TriangleAlert,
  Undo2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  animalSpreadsheetColumns,
  buildAnimalSpreadsheetRow,
  compactSpreadsheetDraft,
  createAnimalDraftRow,
  planAnimalSpreadsheet,
  pruneSpreadsheetDraft,
  spreadsheetColumnOptions,
  weighingDatesFromEdits,
} from "../domain/animal-spreadsheet.mjs";
import type {
  AnimalSpreadsheetContext,
  AnimalSpreadsheetEdits,
} from "../domain/animal-spreadsheet.d.mts";
import { todayISO } from "../lib/format";

// v2: en v1 el peso era una sola columna. Un borrador de entonces apunta a columnas que ya
// no existen, y recuperarlo sería mostrar trabajo pendiente que nunca se va a poder guardar.
const DRAFT_STORAGE_KEY = "fundosmart.planilla.ganado.animales.v2";
const MAX_HISTORY = 100;

/**
 * Cuántas fechas de pesaje se muestran sin pedirlo.
 *
 * La historia crece para siempre —esa es la idea— pero una planilla con dos años de
 * pesajes mensuales son veinticuatro columnas antes de llegar al precio de compra. Se
 * abren las tres más recientes, que son contra las que se compara al cargar una nueva.
 */
const DEFAULT_WEIGHING_COLUMNS = 3;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type AnimalSpreadsheetCommit = (animals: LivestockAnimal[]) => Promise<{ savedIds: string[] }>;

type AnimalesSpreadsheetProps = {
  /** Todo el rebaño: el DIIO es único por fundo aunque el filtro esconda al gemelo. */
  allAnimals: LivestockAnimal[];
  animals: LivestockAnimal[];
  defaultLotId: string;
  lots: LivestockLot[];
  onClose: () => void;
  onCommit: AnimalSpreadsheetCommit;
  scopeLabel: string;
  weighings: LivestockWeighing[];
};

/** Una fila agregada se guarda como su identidad y su lote: las celdas viven en `edits`. */
type DraftAddition = {
  id: string;
  lotId: string;
};

type Draft = {
  additions: DraftAddition[];
  /** Días de pesaje que alguien abrió a mano y todavía no tienen ningún peso guardado. */
  weighingDates: string[];
  edits: AnimalSpreadsheetEdits;
  savedAt: string;
};

function readDraft(): Draft | null {
  try {
    const stored = window.localStorage.getItem(DRAFT_STORAGE_KEY);
    if (!stored) return null;
    const parsed = JSON.parse(stored) as Partial<Draft>;
    if (!parsed?.edits || typeof parsed.edits !== "object") return null;
    const additions = Array.isArray(parsed.additions)
      ? parsed.additions.filter((entry): entry is DraftAddition =>
        Boolean(entry) && typeof entry.id === "string" && typeof entry.lotId === "string")
      : [];
    const weighingDates = Array.isArray(parsed.weighingDates)
      ? parsed.weighingDates.filter((date): date is string => typeof date === "string" && ISO_DATE_PATTERN.test(date))
      : [];
    return {
      additions,
      weighingDates,
      edits: parsed.edits,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : "",
    };
  } catch {
    return null;
  }
}

function writeDraft(
  edits: AnimalSpreadsheetEdits,
  additions: DraftAddition[],
  weighingDates: string[],
): void {
  try {
    if (Object.keys(edits).length === 0 && additions.length === 0 && weighingDates.length === 0) {
      window.localStorage.removeItem(DRAFT_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(
      DRAFT_STORAGE_KEY,
      JSON.stringify({ additions, edits, savedAt: new Date().toISOString(), weighingDates }),
    );
  } catch {
    // Sin almacenamiento local la planilla sigue funcionando; solo se pierde el borrador.
  }
}

export function AnimalesSpreadsheet({
  animals,
  allAnimals,
  defaultLotId,
  lots,
  onClose,
  onCommit,
  scopeLabel,
  weighings,
}: AnimalesSpreadsheetProps) {
  // La historia de pesajes indexada por animal y día: es lo que llena cada celda de peso.
  const weighingsByAnimal = useMemo(() => {
    const grouped: Record<string, Record<string, number>> = {};
    for (const weighing of weighings) {
      (grouped[weighing.animalId] ??= {})[weighing.recordedAt] = weighing.weightKg;
    }
    return grouped;
  }, [weighings]);

  // Solo los días de los animales que el filtro dejó a la vista: abrir la planilla de un
  // lote no debería traer las columnas de los días en que se pesó otro.
  const historyDates = useMemo(() => {
    const visible = new Set(animals.map((animal) => animal.id));
    const dates = new Set<string>();
    for (const weighing of weighings) {
      if (visible.has(weighing.animalId)) dates.add(weighing.recordedAt);
    }
    return [...dates].sort((a, b) => b.localeCompare(a));
  }, [animals, weighings]);

  /**
   * Todo lo que la planilla necesita salvo qué columnas de pesaje están abiertas.
   *
   * Esa parte depende de lo que el usuario haya agregado o editado, y hay trabajo —leer el
   * borrador, formatear una celda suelta— que ocurre antes de que eso exista. Una celda de
   * pesaje se sabe formatear por su clave, así que para eso alcanza con esto.
   */
  const baseContext = useMemo<AnimalSpreadsheetContext>(() => ({
    knownAnimals: allAnimals.map(({ id, lotId, tag }) => ({ id, lotId, tag })),
    lots: lots.map(({ fieldId, id, name, trackingMode }) => ({ fieldId, id, name, trackingMode })),
    sexLabels: LIVESTOCK_SEX_LABELS,
    statusLabels: LIVESTOCK_ANIMAL_STATUS_LABELS,
    weighingsByAnimal,
  }), [allAnimals, lots, weighingsByAnimal]);

  // El borrador se recupera al abrir la planilla y ya compactado: si alguien más guardó
  // ese mismo valor mientras la pestaña estaba cerrada, la celda deja de contar como
  // cambio y no reaparece como si fuera trabajo pendiente.
  const [initialDraft] = useState(() => {
    const draft = readDraft();
    const additions = draft?.additions ?? [];
    // Las celdas de una fila agregada no tienen contra qué compactarse: el animal todavía
    // no existe, así que se conservan tal cual y solo se compacta lo que edita lo guardado.
    const addedIds = new Set(additions.map((entry) => entry.id));
    const editsOfAdditions = Object.fromEntries(
      Object.entries(draft?.edits ?? {}).filter(([animalId]) => addedIds.has(animalId)),
    );
    const editsOfExisting = draft ? compactSpreadsheetDraft(draft.edits, animals, baseContext) : {};
    const recovered = { ...editsOfExisting, ...editsOfAdditions };
    const weighingDates = draft?.weighingDates ?? [];
    return {
      additions,
      edits: recovered,
      savedAt: Object.keys(recovered).length > 0 || additions.length > 0 ? draft?.savedAt ?? null : null,
      weighingDates,
    };
  });

  const [edits, setEdits] = useState<AnimalSpreadsheetEdits>(initialDraft.edits);
  const [additions, setAdditions] = useState<DraftAddition[]>(initialDraft.additions);
  const [addedDates, setAddedDates] = useState<string[]>(initialDraft.weighingDates);
  const [newWeighingDate, setNewWeighingDate] = useState(todayISO);
  const [showAllWeighings, setShowAllWeighings] = useState(false);
  const [recoveredAt] = useState<string | null>(initialDraft.savedAt);
  const [history, setHistory] = useState<AnimalSpreadsheetEdits[]>([]);
  const [future, setFuture] = useState<AnimalSpreadsheetEdits[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const editedWeighingDates = useMemo(() => weighingDatesFromEdits(edits), [edits]);
  const allWeighingDates = useMemo(
    () => [...new Set([...historyDates, ...addedDates, ...editedWeighingDates])]
      .sort((a, b) => b.localeCompare(a)),
    [addedDates, editedWeighingDates, historyDates],
  );

  /**
   * Las columnas de pesaje abiertas: las más recientes, más las que alguien abrió o tocó.
   *
   * Una fecha con algo escrito no puede esconderse. Si se pudiera, el plan tendría celdas
   * que ya no están en pantalla y la confirmación guardaría cosas que nadie ve.
   */
  const visibleWeighingDates = useMemo(() => {
    if (showAllWeighings) return allWeighingDates;
    const kept = new Set([
      ...allWeighingDates.slice(0, DEFAULT_WEIGHING_COLUMNS),
      ...addedDates,
      ...editedWeighingDates,
    ]);
    return allWeighingDates.filter((date) => kept.has(date));
  }, [addedDates, allWeighingDates, editedWeighingDates, showAllWeighings]);

  const hiddenWeighingCount = allWeighingDates.length - visibleWeighingDates.length;

  const context = useMemo<AnimalSpreadsheetContext>(
    () => ({ ...baseContext, weighingDates: visibleWeighingDates }),
    [baseContext, visibleWeighingDates],
  );

  const lotById = useMemo(() => new Map(lots.map((lot) => [lot.id, lot])), [lots]);

  // Las filas agregadas viven en la planilla hasta confirmarse, así que se numeran a
  // partir de su lote y se materializan como animales de borrador para el planificador.
  const draftAnimals = useMemo(
    () => additions.map((entry) => createAnimalDraftRow(entry.id, entry.lotId)),
    [additions],
  );
  const spreadsheetAnimals = useMemo(() => [...animals, ...draftAnimals], [animals, draftAnimals]);
  const addedIds = useMemo(() => new Set(additions.map((entry) => entry.id)), [additions]);

  useEffect(() => {
    writeDraft(edits, additions, addedDates);
  }, [addedDates, additions, edits]);

  const pushEdits = useCallback((next: AnimalSpreadsheetEdits) => {
    setHistory((current) => [...current, edits].slice(-MAX_HISTORY));
    setFuture([]);
    setEdits(next);
  }, [edits]);

  /** Compacta solo lo que edita animales guardados: una fila nueva no tiene contra qué compararse. */
  const compactAgainstSaved = useCallback((candidate: AnimalSpreadsheetEdits) => {
    const ofAdditions = Object.fromEntries(
      Object.entries(candidate).filter(([animalId]) => addedIds.has(animalId)),
    );
    return { ...compactSpreadsheetDraft(candidate, animals, context), ...ofAdditions };
  }, [addedIds, animals, context]);

  const applyEdits = useCallback((incoming: SpreadsheetGridEdit[]) => {
    if (incoming.length === 0) return;
    const next: AnimalSpreadsheetEdits = { ...edits };
    for (const edit of incoming) {
      next[edit.rowId] = { ...(next[edit.rowId] ?? {}), [edit.key]: edit.value };
    }
    pushEdits(compactAgainstSaved(next));
    setFailure(null);
  }, [compactAgainstSaved, edits, pushEdits]);

  const addRows = useCallback((count: number) => {
    const created = Array.from({ length: count }, () => ({ id: crypto.randomUUID(), lotId: defaultLotId }));
    setAdditions((current) => [...current, ...created]);
    setFailure(null);
    setNotice(count === 1
      ? "Fila agregada al final. Necesita DIIO y lote para poder confirmarse."
      : `${count} filas agregadas al final. Cada una necesita DIIO y lote para poder confirmarse.`);
  }, [defaultLotId]);

  /**
   * Abre la columna de un día de pesaje.
   *
   * No escribe nada: deja la columna lista para tipear o pegar. Si el día ya tiene columna
   * se dice y no se duplica, porque dos columnas del mismo día pelearían por la misma celda.
   */
  const addWeighingColumn = useCallback(() => {
    if (!ISO_DATE_PATTERN.test(newWeighingDate)) {
      setNotice("Elige la fecha del pesaje para abrir su columna.");
      return;
    }
    if (allWeighingDates.includes(newWeighingDate)) {
      setShowAllWeighings(true);
      setNotice(`El ${newWeighingDate.split("-").reverse().join("/")} ya tiene su columna en la planilla.`);
      return;
    }
    setAddedDates((current) => [...current, newWeighingDate]);
    setFailure(null);
    setNotice(`Columna del ${newWeighingDate.split("-").reverse().join("/")} abierta. Escribe o pega los kilos; nada se guarda hasta confirmar.`);
  }, [allWeighingDates, newWeighingDate]);

  const removeRow = useCallback((rowId: string) => {
    setAdditions((current) => current.filter((entry) => entry.id !== rowId));
    setEdits((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
    setFailure(null);
  }, []);

  const undo = useCallback(() => {
    setHistory((current) => {
      if (current.length === 0) return current;
      const previous = current[current.length - 1];
      setFuture((forward) => [edits, ...forward].slice(0, MAX_HISTORY));
      setEdits(previous);
      return current.slice(0, -1);
    });
  }, [edits]);

  const redo = useCallback(() => {
    setFuture((current) => {
      if (current.length === 0) return current;
      const [next, ...rest] = current;
      setHistory((back) => [...back, edits].slice(-MAX_HISTORY));
      setEdits(next);
      return rest;
    });
  }, [edits]);

  const discard = useCallback(() => {
    pushEdits({});
    setAdditions([]);
    setAddedDates([]);
    setReviewing(false);
    setFailure(null);
    setNotice("Se descartaron los cambios sin confirmar, incluidas las filas y las columnas de pesaje agregadas.");
  }, [pushEdits]);

  const columns = useMemo<SpreadsheetGridColumn[]>(
    () => animalSpreadsheetColumns(context).map((column) => ({
      align: column.align,
      key: column.key,
      label: column.label,
      options: column.kind === "sex" || column.kind === "status" || column.kind === "lot"
        ? spreadsheetColumnOptions(column.key, context)
        : undefined,
      width: column.width,
    })),
    [context],
  );

  const rows = useMemo<SpreadsheetGridRow[]>(() => spreadsheetAnimals.map((animal) => {
    const baseline = buildAnimalSpreadsheetRow(animal, context);
    const edited = edits[animal.id];
    const added = addedIds.has(animal.id);
    const lot = lotById.get(animal.lotId);
    const summaryLot = !added && Boolean(lot) && lot!.trackingMode !== "individual";
    return {
      badge: added ? "nuevo" : undefined,
      cells: edited ? { ...baseline.cells, ...edited } : baseline.cells,
      id: animal.id,
      label: added ? "Animal nuevo" : animal.tag,
      readOnly: summaryLot,
      readOnlyReason: summaryLot
        ? `El lote ${lot?.name ?? ""} está en modo resumen: activa la trazabilidad individual para editar este animal.`
        : undefined,
      removable: added,
    };
  }), [addedIds, context, edits, lotById, spreadsheetAnimals]);

  const plan = useMemo(
    () => planAnimalSpreadsheet({ animals: spreadsheetAnimals, edits, context }),
    [context, edits, spreadsheetAnimals],
  );

  const cellErrors = useMemo(() => {
    const map: Record<string, string> = {};
    for (const error of plan.errors) map[spreadsheetCellKey(error.animalId, error.key)] = error.message;
    return map;
  }, [plan.errors]);

  const changedCells = useMemo(() => {
    const set = new Set<string>();
    for (const change of plan.changes) {
      for (const field of change.fields) set.add(spreadsheetCellKey(change.animalId, field.key));
    }
    return set;
  }, [plan.changes]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Cerrar la pestaña con cambios sin confirmar no debería ser silencioso.
  useEffect(() => {
    if (plan.changedCellCount === 0 && plan.errors.length === 0) return;
    function warn(event: BeforeUnloadEvent) { event.preventDefault(); }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [plan.changedCellCount, plan.errors.length]);

  /**
   * Lo guardado deja de ser borrador: las filas que se escribieron salen de la planilla.
   *
   * Las columnas de pesaje que alcanzaron a guardarse tampoco siguen abiertas a mano: ya
   * son parte de la historia del animal y la planilla las va a mostrar por su cuenta.
   */
  const settle = useCallback((savedIds: string[]) => {
    if (savedIds.length === 0) return;
    const saved = new Set(savedIds);
    const writtenDates = new Set(
      plan.changes
        .filter((change) => saved.has(change.animalId))
        .flatMap((change) => change.animal.weighings.map((weighing) => weighing.recordedAt)),
    );
    setEdits((current) => pruneSpreadsheetDraft(current, savedIds));
    setAdditions((current) => current.filter((entry) => !saved.has(entry.id)));
    setAddedDates((current) => current.filter((date) => !writtenDates.has(date)));
  }, [plan.changes]);

  async function confirm() {
    setSaving(true);
    setFailure(null);
    try {
      // La fecha de alta se estampa acá, en el borde: el planificador es puro y no
      // tiene por qué saber qué hora es.
      const createdAt = new Date().toISOString();
      const result = await onCommit(plan.changes.map((change) =>
        (change.created ? { ...change.animal, createdAt } : change.animal)));
      settle(result.savedIds);
      setHistory([]);
      setFuture([]);
      setReviewing(false);
      const created = plan.createdRowCount;
      setNotice(created > 0
        ? `Planilla confirmada: ${result.savedIds.length} ${result.savedIds.length === 1 ? "animal guardado" : "animales guardados"}, ${created} ${created === 1 ? "nuevo" : "nuevos"}.`
        : `Planilla confirmada: ${result.savedIds.length} ${result.savedIds.length === 1 ? "animal guardado" : "animales guardados"}.`);
    } catch (cause) {
      const savedIds = cause instanceof Error && "savedIds" in cause ? (cause as { savedIds: string[] }).savedIds : [];
      settle(savedIds);
      setFailure(
        cause instanceof Error
          ? savedIds.length > 0
            ? `${cause.message} Se guardaron ${savedIds.length} ${savedIds.length === 1 ? "animal" : "animales"} antes de detenerse; el resto sigue en la planilla para reintentar.`
            : cause.message
          : "No fue posible confirmar la planilla.",
      );
      setReviewing(false);
    } finally {
      setSaving(false);
    }
  }

  const dirty = plan.changedCellCount > 0
    || plan.errors.length > 0
    || additions.length > 0
    || addedDates.length > 0;

  return (
    <section className="rounded-[20px] border-2 border-accent bg-white p-4 shadow-[0_8px_30px_rgba(35,50,42,0.08)]">
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Modo planilla</p>
          <h3 className="mt-0.5 text-sm font-black text-ink">Editando {scopeLabel}</h3>
          <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
            Flechas para moverte · Enter edita y baja · Tab avanza · Ctrl+V pega desde Excel · Ctrl+D rellena hacia abajo · Ctrl+Z deshace
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

      {recoveredAt && dirty && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-band px-3 py-2 text-[12px] font-bold text-accent">
          <ClipboardPaste className="mt-0.5 shrink-0" size={14} />
          Recuperamos el borrador que dejaste sin confirmar. Sigue siendo un borrador: nada de esto está guardado todavía.
        </p>
      )}

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
        <span className="flex h-9 items-center gap-1.5 rounded-lg bg-surface-alt px-2.5 text-[12px] font-bold text-ink-subtle">
          <ArrowDownToLine size={14} /> Ctrl+D rellena la selección hacia abajo
        </span>
        <span className="flex items-center">
          <button
            className="flex h-9 items-center gap-1.5 rounded-l-lg border border-line-steel px-2.5 text-[12px] font-black text-ink disabled:opacity-40"
            disabled={saving}
            onClick={() => addRows(1)}
            title="Agrega una fila al final para dar de alta un animal"
            type="button"
          >
            <Plus size={14} /> Agregar fila
          </button>
          <button
            className="-ml-px flex h-9 items-center rounded-r-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
            disabled={saving}
            onClick={() => addRows(10)}
            title="Agrega diez filas de una vez"
            type="button"
          >
            +10
          </button>
        </span>
        <span className="flex items-center">
          <input
            aria-label="Fecha del pesaje a agregar"
            className="h-9 rounded-l-lg border border-line-steel bg-surface-alt px-2 text-[12px] font-bold text-ink outline-none focus:border-accent"
            disabled={saving}
            onChange={(event) => setNewWeighingDate(event.target.value)}
            type="date"
            value={newWeighingDate}
          />
          <button
            className="-ml-px flex h-9 items-center gap-1.5 rounded-r-lg border border-line-steel px-2.5 text-[12px] font-black text-ink disabled:opacity-40"
            disabled={saving}
            onClick={addWeighingColumn}
            title="Abre la columna de un día de pesaje. Se pueden agregar todos los que hagan falta."
            type="button"
          >
            <CalendarPlus size={14} /> Agregar pesaje
          </button>
        </span>
        {(hiddenWeighingCount > 0 || showAllWeighings) && (
          <button
            className="flex h-9 items-center gap-1.5 rounded-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted"
            onClick={() => setShowAllWeighings((current) => !current)}
            type="button"
          >
            {showAllWeighings
              ? <><EyeOff size={14} /> Dejar los {DEFAULT_WEIGHING_COLUMNS} pesajes recientes</>
              : <><Eye size={14} /> Ver {hiddenWeighingCount} {hiddenWeighingCount === 1 ? "pesaje anterior" : "pesajes anteriores"}</>}
          </button>
        )}
        <button
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
          disabled={!dirty || saving}
          onClick={discard}
          type="button"
        >
          <X size={14} /> Descartar cambios
        </button>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[12px] font-bold text-ink-subtle">
            {plan.changedCellCount > 0
              ? `${plan.changedCellCount} ${plan.changedCellCount === 1 ? "celda cambiada" : "celdas cambiadas"} en ${plan.changedRowCount} ${plan.changedRowCount === 1 ? "animal" : "animales"}`
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
              <li className="text-[12px] font-semibold text-red-700" key={`${error.animalId}-${error.key}`}>
                <span className="font-black">{error.tag} · {error.label}:</span>{" "}
                {error.text !== null && error.text !== "" ? `"${error.text}" — ` : ""}{error.message}
              </li>
            ))}
            {plan.errors.length > 8 && (
              <li className="text-[12px] font-bold text-red-700">y {plan.errors.length - 8} más.</li>
            )}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <SpreadsheetGrid
          ariaLabel={`Planilla de animales. ${scopeLabel}.`}
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
        Pegar no crea filas: agrégalas antes con Agregar fila y después pega encima. Una fila nueva que quede en blanco se
        ignora sola. Cada columna con fecha es un pesaje: escribir kilos ahí lo registra ese día, vaciarla lo borra, y el
        peso vigente del animal pasa a ser el del día más reciente.
      </p>

      {reviewing && (
        <ReviewPanel
          onCancel={() => setReviewing(false)}
          onConfirm={confirm}
          plan={plan}
          saving={saving}
        />
      )}
    </section>
  );
}

type ReviewPanelProps = {
  onCancel: () => void;
  onConfirm: () => void;
  plan: ReturnType<typeof planAnimalSpreadsheet>;
  saving: boolean;
};

function ReviewPanel({ onCancel, onConfirm, plan, saving }: ReviewPanelProps) {
  return (
    <div aria-labelledby="planilla-revision" aria-modal="true" className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 p-0 sm:items-center sm:p-6" role="dialog">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-t-[20px] bg-white sm:rounded-[20px]">
        <header className="border-b border-line-steel px-5 py-4">
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Antes de confirmar</p>
          <h3 className="mt-0.5 text-sm font-black text-ink" id="planilla-revision">
            {plan.changedRowCount} {plan.changedRowCount === 1 ? "animal cambia" : "animales cambian"} · {plan.changedCellCount} {plan.changedCellCount === 1 ? "celda" : "celdas"}
            {plan.createdRowCount > 0 && ` · ${plan.createdRowCount} ${plan.createdRowCount === 1 ? "animal nuevo" : "animales nuevos"}`}
          </h3>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
          {plan.warnings.length > 0 && (
            <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2">
              <p className="flex items-center gap-2 text-[12px] font-black text-amber-800">
                <TriangleAlert size={14} /> Se guarda igual, pero conviene saberlo
              </p>
              <ul className="mt-1.5 space-y-1">
                {plan.warnings.map((warning) => (
                  <li className="text-[12px] font-semibold text-amber-900" key={`${warning.animalId}-${warning.key}-${warning.message}`}>
                    <span className="font-black">{warning.tag}:</span> {warning.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ul className="space-y-2">
            {plan.changes.map((change) => (
              <li className={`rounded-xl border px-3 py-2 ${change.created ? "border-accent bg-band/40" : "border-line-steel"}`} key={change.animalId}>
                <p className="text-xs font-black text-ink">
                  {change.tag}
                  {change.created && <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-black uppercase tracking-wide text-white">Animal nuevo</span>}
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
            Se guardan en orden. Si uno choca porque alguien más lo movió, se detiene ahí y te decimos cuáles alcanzaron a guardarse.
          </p>
          <button
            className="flex h-11 items-center gap-2 rounded-xl border border-line-steel px-4 text-xs font-black text-ink-muted"
            disabled={saving}
            onClick={onCancel}
            type="button"
          >
            Volver a la planilla
          </button>
          <button
            className="flex h-11 items-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white disabled:opacity-60"
            disabled={saving}
            onClick={onConfirm}
            type="button"
          >
            {saving ? <><LoaderCircle className="animate-spin" size={15} /> Guardando</> : <><Check size={15} /> Confirmar cambios</>}
          </button>
        </footer>
      </div>
    </div>
  );
}
