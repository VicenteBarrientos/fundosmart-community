"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { parseClipboardMatrix, serializeClipboardMatrix } from "./spreadsheet-clipboard.mjs";

export type SpreadsheetGridOption = {
  label: string;
  value: string;
};

export type SpreadsheetGridColumn = {
  align?: "left" | "right";
  key: string;
  label: string;
  /** Cuando existe, la celda se edita eligiendo de la lista y guarda la etiqueta elegida. */
  options?: SpreadsheetGridOption[];
  readOnly?: boolean;
  width?: string;
};

export type SpreadsheetGridRow = {
  /** Marca corta en la cabecera de la fila, en lugar de su número. */
  badge?: string;
  cells: Record<string, string>;
  id: string;
  label: string;
  readOnly?: boolean;
  readOnlyReason?: string;
  /** Solo las filas que la planilla agregó se pueden sacar: borrar lo guardado se hace mirándolo. */
  removable?: boolean;
};

export type SpreadsheetGridEdit = {
  key: string;
  rowId: string;
  value: string;
};

type SpreadsheetGridProps = {
  ariaLabel: string;
  canRedo?: boolean;
  canUndo?: boolean;
  /** Mensaje por celda, indexado con `spreadsheetCellKey`. */
  cellErrors?: Record<string, string>;
  changedCells?: Set<string>;
  columns: SpreadsheetGridColumn[];
  maxHeight?: string;
  onEdit: (edits: SpreadsheetGridEdit[]) => void;
  onNotice?: (message: string) => void;
  onRedo?: () => void;
  onRemoveRow?: (rowId: string) => void;
  onUndo?: () => void;
  rows: SpreadsheetGridRow[];
};

type Position = { column: number; row: number };

export function spreadsheetCellKey(rowId: string, columnKey: string): string {
  return `${rowId}\u0000${columnKey}`;
}

const CELL_BASE = "relative border-b border-r border-line-steel px-2 py-1.5 text-xs font-semibold text-ink";

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, max));
}

export function SpreadsheetGrid({
  ariaLabel,
  canRedo = false,
  canUndo = false,
  cellErrors,
  changedCells,
  columns,
  maxHeight = "30rem",
  onEdit,
  onNotice,
  onRedo,
  onRemoveRow,
  onUndo,
  rows,
}: SpreadsheetGridProps) {
  const gridId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLInputElement | HTMLSelectElement>(null);
  const [active, setActive] = useState<Position>({ column: 0, row: 0 });
  const [anchor, setAnchor] = useState<Position>({ column: 0, row: 0 });
  const [editing, setEditing] = useState<{ position: Position; value: string } | null>(null);
  const [fillToRow, setFillToRow] = useState<number | null>(null);
  const fillingRef = useRef(false);

  const lastRow = Math.max(0, rows.length - 1);
  const lastColumn = Math.max(0, columns.length - 1);

  const selection = useMemo(() => ({
    columnEnd: Math.max(active.column, anchor.column),
    columnStart: Math.min(active.column, anchor.column),
    rowEnd: Math.max(active.row, anchor.row),
    rowStart: Math.min(active.row, anchor.row),
  }), [active, anchor]);

  const isEditable = useCallback(
    (position: Position) => {
      const row = rows[position.row];
      const column = columns[position.column];
      return Boolean(row) && Boolean(column) && !row.readOnly && !column.readOnly;
    },
    [columns, rows],
  );

  const focusGrid = useCallback(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // Una fila puede desaparecer por un filtro o por un guardado: la selección no puede
  // quedar apuntando fuera de la planilla.
  useEffect(() => {
    setActive((current) => ({ column: clamp(current.column, lastColumn), row: clamp(current.row, lastRow) }));
    setAnchor((current) => ({ column: clamp(current.column, lastColumn), row: clamp(current.row, lastRow) }));
  }, [lastColumn, lastRow]);

  useEffect(() => {
    if (!editing) return;
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    if (editor instanceof HTMLInputElement) editor.setSelectionRange(editor.value.length, editor.value.length);
  }, [editing]);

  const moveTo = useCallback((position: Position, extend = false) => {
    const next = { column: clamp(position.column, lastColumn), row: clamp(position.row, lastRow) };
    setActive(next);
    if (!extend) setAnchor(next);
    const cell = document.getElementById(`${gridId}-cell-${next.row}-${next.column}`);
    cell?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [gridId, lastColumn, lastRow]);

  const commitEdit = useCallback((move: Position | null) => {
    setEditing((current) => {
      if (current) {
        const row = rows[current.position.row];
        const column = columns[current.position.column];
        if (row && column && current.value !== row.cells[column.key]) {
          onEdit([{ key: column.key, rowId: row.id, value: current.value }]);
        }
      }
      return null;
    });
    if (move) moveTo(move);
    focusGrid();
  }, [columns, focusGrid, moveTo, onEdit, rows]);

  const startEditing = useCallback((position: Position, initialValue?: string) => {
    if (!isEditable(position)) {
      const row = rows[position.row];
      if (row?.readOnly && row.readOnlyReason) onNotice?.(row.readOnlyReason);
      else if (columns[position.column]?.readOnly) onNotice?.("Esta columna se calcula sola: no se edita a mano.");
      return;
    }
    const current = rows[position.row].cells[columns[position.column].key] ?? "";
    setEditing({ position, value: initialValue ?? current });
  }, [columns, isEditable, onNotice, rows]);

  const applyToSelection = useCallback((valueFor: (position: Position) => string | null) => {
    const edits: SpreadsheetGridEdit[] = [];
    let blocked = 0;
    for (let row = selection.rowStart; row <= selection.rowEnd; row += 1) {
      for (let column = selection.columnStart; column <= selection.columnEnd; column += 1) {
        const position = { column, row };
        if (!isEditable(position)) { blocked += 1; continue; }
        const value = valueFor(position);
        if (value === null) continue;
        if (rows[row].cells[columns[column].key] === value) continue;
        edits.push({ key: columns[column].key, rowId: rows[row].id, value });
      }
    }
    if (edits.length > 0) onEdit(edits);
    if (blocked > 0 && edits.length === 0) onNotice?.("La selección solo tiene celdas que no se editan a mano.");
    return edits.length;
  }, [columns, isEditable, onEdit, onNotice, rows, selection]);

  const fillDown = useCallback(() => {
    if (selection.rowStart === selection.rowEnd) {
      // Un solo renglón seleccionado: Excel copia desde la celda de arriba.
      if (selection.rowStart === 0) { onNotice?.("No hay una fila arriba desde la cual rellenar."); return; }
      applyToSelection(({ column, row }) => rows[row - 1].cells[columns[column].key] ?? "");
      return;
    }
    applyToSelection(({ column, row }) =>
      (row === selection.rowStart ? null : rows[selection.rowStart].cells[columns[column].key] ?? ""));
  }, [applyToSelection, columns, onNotice, rows, selection]);

  const copySelection = useCallback((event: { clipboardData: DataTransfer | null; preventDefault: () => void }) => {
    if (!event.clipboardData) return;
    const matrix: string[][] = [];
    for (let row = selection.rowStart; row <= selection.rowEnd; row += 1) {
      const line: string[] = [];
      for (let column = selection.columnStart; column <= selection.columnEnd; column += 1) {
        line.push(rows[row]?.cells[columns[column].key] ?? "");
      }
      matrix.push(line);
    }
    event.clipboardData.setData("text/plain", serializeClipboardMatrix(matrix));
    event.preventDefault();
  }, [columns, rows, selection]);

  const pasteMatrix = useCallback((matrix: string[][]) => {
    if (matrix.length === 0) return;
    const edits: SpreadsheetGridEdit[] = [];
    let outsideRows = 0;
    let outsideColumns = 0;
    let readOnlySkipped = 0;

    for (let offsetRow = 0; offsetRow < matrix.length; offsetRow += 1) {
      const targetRow = selection.rowStart + offsetRow;
      if (targetRow > lastRow) { outsideRows += 1; continue; }
      for (let offsetColumn = 0; offsetColumn < matrix[offsetRow].length; offsetColumn += 1) {
        const targetColumn = selection.columnStart + offsetColumn;
        if (targetColumn > lastColumn) { outsideColumns += 1; continue; }
        const position = { column: targetColumn, row: targetRow };
        if (!isEditable(position)) { readOnlySkipped += 1; continue; }
        const value = matrix[offsetRow][offsetColumn].trim();
        if (rows[targetRow].cells[columns[targetColumn].key] === value) continue;
        edits.push({ key: columns[targetColumn].key, rowId: rows[targetRow].id, value });
      }
    }

    if (edits.length > 0) onEdit(edits);
    const dropped: string[] = [];
    if (outsideRows > 0) dropped.push(`${outsideRows} ${outsideRows === 1 ? "fila quedó" : "filas quedaron"} fuera de la planilla`);
    if (outsideColumns > 0) dropped.push(`${outsideColumns} ${outsideColumns === 1 ? "celda quedó" : "celdas quedaron"} fuera de las columnas`);
    if (readOnlySkipped > 0) dropped.push(`${readOnlySkipped} ${readOnlySkipped === 1 ? "celda no se edita" : "celdas no se editan"} a mano`);
    const applied = `${edits.length} ${edits.length === 1 ? "celda pegada" : "celdas pegadas"}`;
    onNotice?.(dropped.length > 0 ? `${applied}. Pegar nunca crea filas: ${dropped.join(", ")}.` : `${applied}.`);
  }, [columns, isEditable, lastColumn, lastRow, onEdit, onNotice, rows, selection]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (rows.length === 0 || columns.length === 0) return;
    const control = event.ctrlKey || event.metaKey;

    if (editing) {
      if (event.key === "Escape") { event.preventDefault(); setEditing(null); focusGrid(); return; }
      if (event.key === "Enter") {
        event.preventDefault();
        commitEdit({ column: active.column, row: active.row + (event.shiftKey ? -1 : 1) });
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        commitEdit({ column: active.column + (event.shiftKey ? -1 : 1), row: active.row });
        return;
      }
      return;
    }

    if (control && (event.key === "z" || event.key === "Z")) {
      event.preventDefault();
      if (event.shiftKey) { if (canRedo) onRedo?.(); } else if (canUndo) onUndo?.();
      return;
    }
    if (control && (event.key === "y" || event.key === "Y")) {
      event.preventDefault();
      if (canRedo) onRedo?.();
      return;
    }
    if (control && (event.key === "d" || event.key === "D")) { event.preventDefault(); fillDown(); return; }
    if (control && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      setAnchor({ column: 0, row: 0 });
      setActive({ column: lastColumn, row: lastRow });
      return;
    }

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        moveTo({ column: active.column, row: active.row - 1 }, event.shiftKey);
        return;
      case "ArrowDown":
        event.preventDefault();
        moveTo({ column: active.column, row: active.row + 1 }, event.shiftKey);
        return;
      case "ArrowLeft":
        event.preventDefault();
        moveTo({ column: active.column - 1, row: active.row }, event.shiftKey);
        return;
      case "ArrowRight":
        event.preventDefault();
        moveTo({ column: active.column + 1, row: active.row }, event.shiftKey);
        return;
      case "Home":
        event.preventDefault();
        moveTo({ column: 0, row: control ? 0 : active.row }, event.shiftKey);
        return;
      case "End":
        event.preventDefault();
        moveTo({ column: lastColumn, row: control ? lastRow : active.row }, event.shiftKey);
        return;
      case "PageUp":
        event.preventDefault();
        moveTo({ column: active.column, row: active.row - 10 }, event.shiftKey);
        return;
      case "PageDown":
        event.preventDefault();
        moveTo({ column: active.column, row: active.row + 10 }, event.shiftKey);
        return;
      case "Tab":
        event.preventDefault();
        moveTo({ column: active.column + (event.shiftKey ? -1 : 1), row: active.row });
        return;
      case "Enter":
      case "F2":
        event.preventDefault();
        startEditing(active);
        return;
      case "Delete":
      case "Backspace":
        event.preventDefault();
        applyToSelection(() => "");
        return;
      default:
        break;
    }

    if (!control && !event.altKey && event.key.length === 1) {
      event.preventDefault();
      startEditing(active, event.key);
    }
  }

  const handlePointerDownFill = useCallback((event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    fillingRef.current = true;
    setFillToRow(selection.rowEnd);
  }, [selection.rowEnd]);

  useEffect(() => {
    if (fillToRow === null) return;
    function finish() {
      if (!fillingRef.current) return;
      fillingRef.current = false;
      setFillToRow((target) => {
        if (target !== null && target > selection.rowEnd) {
          const from = selection.rowStart;
          const edits: SpreadsheetGridEdit[] = [];
          for (let row = selection.rowEnd + 1; row <= target; row += 1) {
            for (let column = selection.columnStart; column <= selection.columnEnd; column += 1) {
              if (!isEditable({ column, row })) continue;
              const value = rows[from].cells[columns[column].key] ?? "";
              if (rows[row].cells[columns[column].key] === value) continue;
              edits.push({ key: columns[column].key, rowId: rows[row].id, value });
            }
          }
          if (edits.length > 0) {
            onEdit(edits);
            setActive({ column: selection.columnEnd, row: target });
            setAnchor({ column: selection.columnStart, row: selection.rowStart });
          }
        }
        return null;
      });
    }
    window.addEventListener("pointerup", finish);
    return () => window.removeEventListener("pointerup", finish);
  }, [columns, fillToRow, isEditable, onEdit, rows, selection]);

  // Estables a propósito: son props de una fila memorizada, y una identidad nueva en cada
  // render volvería a dibujar la planilla entera con cada flecha del teclado.
  const selectCell = useCallback((row: number, column: number, extend: boolean) => {
    if (editing) commitEdit(null);
    setActive({ column, row });
    if (!extend) setAnchor({ column, row });
    focusGrid();
  }, [commitEdit, editing, focusGrid]);

  const beginEdit = useCallback((row: number, column: number) => {
    startEditing({ column, row });
  }, [startEditing]);

  const changeEditorValue = useCallback((row: number, column: number, value: string) => {
    setEditing({ position: { column, row }, value });
  }, []);

  const commitEditorValue = useCallback(() => { commitEdit(null); }, [commitEdit]);

  const extendFillTo = useCallback((row: number) => {
    if (fillingRef.current) setFillToRow((current) => Math.max(row, current ?? row));
  }, []);

  if (rows.length === 0 || columns.length === 0) return null;

  const fillPreviewEnd = fillToRow !== null ? Math.max(fillToRow, selection.rowEnd) : selection.rowEnd;

  return (
    <div
      aria-activedescendant={`${gridId}-cell-${active.row}-${active.column}`}
      aria-colcount={columns.length}
      aria-label={ariaLabel}
      aria-rowcount={rows.length + 1}
      className="overflow-auto rounded-2xl border border-line-steel bg-white outline-none focus-visible:ring-2 focus-visible:ring-accent"
      onCopy={copySelection}
      onCut={copySelection}
      onKeyDown={handleKeyDown}
      onPaste={(event) => {
        if (editing) return;
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text) return;
        event.preventDefault();
        pasteMatrix(parseClipboardMatrix(text));
      }}
      ref={containerRef}
      role="grid"
      style={{ maxHeight }}
      tabIndex={0}
    >
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-10 bg-surface-alt">
          <tr>
            <th className="sticky left-0 z-20 w-10 border-b border-r border-line-steel bg-surface-alt px-2 py-2 text-[11px] font-black uppercase tracking-[0.1em] text-ink-subtle" scope="col">
              <span className="sr-only">Número de fila</span>
              #
            </th>
            {columns.map((column) => (
              <th
                className={`border-b border-r border-line-steel bg-surface-alt px-2 py-2 text-[11px] font-black uppercase tracking-[0.1em] ${column.readOnly ? "text-ink-subtle/70" : "text-ink-subtle"} ${column.align === "right" ? "text-right" : "text-left"}`}
                key={column.key}
                scope="col"
                style={{ minWidth: column.width }}
                title={column.readOnly ? "Columna de referencia: no se edita a mano" : undefined}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => {
            const rowInSelection = rowIndex >= selection.rowStart && rowIndex <= selection.rowEnd;
            const rowInFillPreview = fillToRow !== null && rowIndex > selection.rowEnd && rowIndex <= fillPreviewEnd;
            return (
              <GridRow
                activeColumn={active.row === rowIndex ? active.column : null}
                cellErrors={cellErrors}
                changedCells={changedCells}
                columns={columns}
                editingColumn={editing?.position.row === rowIndex ? editing.position.column : null}
                editingValue={editing?.position.row === rowIndex ? editing.value : null}
                editorRef={editorRef}
                gridId={gridId}
                highlightEnd={rowInSelection || rowInFillPreview ? selection.columnEnd : null}
                highlightStart={rowInSelection || rowInFillPreview ? selection.columnStart : null}
                key={row.id}
                onCommitEditor={commitEditorValue}
                onEditorValue={changeEditorValue}
                onFillHandleDown={handlePointerDownFill}
                onPointerEnterRow={extendFillTo}
                onRemoveRow={onRemoveRow}
                onSelect={selectCell}
                onStartEdit={beginEdit}
                row={row}
                rowIndex={rowIndex}
                selected={rowInSelection}
              />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type GridRowProps = {
  activeColumn: number | null;
  cellErrors?: Record<string, string>;
  changedCells?: Set<string>;
  columns: SpreadsheetGridColumn[];
  editingColumn: number | null;
  editingValue: string | null;
  editorRef: RefObject<HTMLInputElement | HTMLSelectElement | null>;
  gridId: string;
  highlightEnd: number | null;
  highlightStart: number | null;
  onCommitEditor: () => void;
  onEditorValue: (row: number, column: number, value: string) => void;
  onFillHandleDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerEnterRow: (row: number) => void;
  onRemoveRow?: (rowId: string) => void;
  onSelect: (row: number, column: number, extend: boolean) => void;
  onStartEdit: (row: number, column: number) => void;
  row: SpreadsheetGridRow;
  rowIndex: number;
  selected: boolean;
};

/**
 * Una fila de la planilla, memorizada.
 *
 * Moverse con las flechas cambia la selección de dos filas, no de las quinientas que
 * pueden estar en pantalla: sin este corte, cada tecla redibuja la planilla entera y la
 * navegación deja de sentirse inmediata, que es justamente lo que se venía a resolver.
 */
const GridRow = memo(function GridRow({
  activeColumn,
  cellErrors,
  changedCells,
  columns,
  editingColumn,
  editingValue,
  editorRef,
  gridId,
  highlightEnd,
  highlightStart,
  onCommitEditor,
  onEditorValue,
  onFillHandleDown,
  onPointerEnterRow,
  onRemoveRow,
  onSelect,
  onStartEdit,
  row,
  rowIndex,
  selected,
}: GridRowProps) {
  return (
    <tr>
      <th
        className={`sticky left-0 z-[5] border-b border-r border-line-steel px-1 py-1.5 text-[11px] font-black tabular-nums ${row.readOnly ? "bg-surface-alt text-ink-subtle" : row.badge ? "bg-band text-accent" : "bg-white text-ink-subtle"}`}
        scope="row"
        title={row.readOnly ? row.readOnlyReason : row.label}
      >
        <span className="flex items-center gap-1">
          <span className="min-w-[1.25rem] text-center">{row.badge ?? rowIndex + 1}</span>
          {row.removable && onRemoveRow && (
            <button
              aria-label={`Quitar la fila nueva ${rowIndex + 1}`}
              className="grid size-4 shrink-0 place-items-center rounded text-ink-subtle transition hover:bg-red-50 hover:text-red-700"
              onClick={() => onRemoveRow(row.id)}
              tabIndex={-1}
              title="Quitar esta fila nueva"
              type="button"
            >
              ×
            </button>
          )}
        </span>
      </th>
      {columns.map((column, columnIndex) => {
        const cellKey = spreadsheetCellKey(row.id, column.key);
        const error = cellErrors?.[cellKey];
        const changed = changedCells?.has(cellKey);
        const isActive = activeColumn === columnIndex;
        const highlighted = highlightStart !== null && highlightEnd !== null
          && columnIndex >= highlightStart && columnIndex <= highlightEnd;
        const locked = row.readOnly || column.readOnly;
        const isEditingCell = editingColumn === columnIndex && editingValue !== null;
        const value = row.cells[column.key] ?? "";

        return (
          <td
            aria-readonly={locked || undefined}
            aria-selected={selected && highlighted}
            className={[
              CELL_BASE,
              column.align === "right" ? "text-right" : "text-left",
              locked ? "bg-surface-alt text-ink-subtle" : "",
              changed && !error ? "bg-band" : "",
              error ? "bg-red-50" : "",
              highlighted && !isActive ? "bg-accent/5" : "",
              isActive ? "z-[1] outline outline-2 -outline-offset-2 outline-accent" : "",
            ].filter(Boolean).join(" ")}
            id={`${gridId}-cell-${rowIndex}-${columnIndex}`}
            key={column.key}
            onDoubleClick={() => onStartEdit(rowIndex, columnIndex)}
            onPointerDown={(event) => onSelect(rowIndex, columnIndex, event.shiftKey)}
            onPointerEnter={() => onPointerEnterRow(rowIndex)}
            role="gridcell"
            style={{ minWidth: column.width }}
            title={error ?? (locked ? row.readOnlyReason ?? "Columna calculada" : undefined)}
          >
            {isEditingCell ? (
              column.options ? (
                <select
                  className="h-6 w-full rounded border border-accent bg-white px-1 text-xs font-semibold text-ink outline-none"
                  onBlur={onCommitEditor}
                  onChange={(event) => onEditorValue(rowIndex, columnIndex, event.target.value)}
                  ref={editorRef as RefObject<HTMLSelectElement>}
                  value={editingValue}
                >
                  <option value="">—</option>
                  {column.options.map((option) => (
                    <option key={option.value} value={option.label}>{option.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="h-6 w-full rounded border border-accent bg-white px-1 text-xs font-semibold text-ink outline-none"
                  onBlur={onCommitEditor}
                  onChange={(event) => onEditorValue(rowIndex, columnIndex, event.target.value)}
                  ref={editorRef as RefObject<HTMLInputElement>}
                  value={editingValue}
                />
              )
            ) : (
              <>
                <span className="block min-h-[1.25rem] truncate">{value || " "}</span>
                {error && <span className="absolute right-0 top-0 size-0 border-l-[6px] border-t-[6px] border-l-transparent border-t-red-500" />}
                {isActive && !locked && (
                  <button
                    aria-label="Rellenar hacia abajo arrastrando"
                    className="absolute -bottom-[3px] -right-[3px] size-[7px] cursor-crosshair rounded-[1px] bg-accent"
                    onPointerDown={onFillHandleDown}
                    tabIndex={-1}
                    type="button"
                  />
                )}
              </>
            )}
          </td>
        );
      })}
    </tr>
  );
});
