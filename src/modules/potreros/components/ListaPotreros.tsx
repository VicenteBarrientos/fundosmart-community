"use client";

import { Archive, ArrowUpRight, CheckSquare2, Filter, GitMerge, MapPin, MoreHorizontal, Search, Sprout } from "lucide-react";
import { useMemo, useState } from "react";
import { SortableDataSelect, SortableGridHeader } from "@/src/ui/SortableGridHeader";
import {
  nextSortState,
  stableSortData,
  type SortColumn,
  type SortState,
} from "@/src/ui/sortable-data";
import type { Potrero } from "../types";
import type { PaddockRotationEntry, PaddockRotationSnapshot } from "../domain/cells-rotation";
import { paddockAreaMetrics } from "../utils/paddock-metrics";

type ListaPotrerosProps = {
  archivedPotreros: Potrero[];
  canMutate: boolean;
  onMerge: () => void;
  onSelect: (id: string | null) => void;
  onSelectionModeChange: (enabled: boolean) => void;
  onShowArchivedChange: (showArchived: boolean) => void;
  onToggleSelection: (id: string) => void;
  potreros: Potrero[];
  selectedId: string | null;
  selectedIds: string[];
  selectionMode: boolean;
  showArchived: boolean;
  structuralOperationsEnabled: boolean;
  rotationSnapshot: PaddockRotationSnapshot | null;
};

const statusStyles: Record<Potrero["status"], string> = {
  Disponible: "bg-band text-accent",
  "En pastoreo": "bg-surface-alt text-accent",
  "En descanso": "bg-band text-warn-ink",
};

type PaddockSortColumn = "activity" | "grossArea" | "name" | "status" | "usableArea";

const PADDOCK_SORT_COLUMNS: Record<PaddockSortColumn, SortColumn<Potrero>> = {
  name: { kind: "text", value: (potrero) => `${potrero.name} ${potrero.sector}` },
  activity: { kind: "text", value: (potrero) => potrero.lastActivity },
  grossArea: { kind: "number", value: (potrero) => paddockAreaMetrics(potrero).grossAreaHectares },
  usableArea: { kind: "number", value: (potrero) => paddockAreaMetrics(potrero).effectiveGrazeableAreaHectares },
  status: { kind: "text", value: (potrero) => potrero.status },
};

const PADDOCK_SORT_OPTIONS = [
  { column: "name", label: "Potrero" },
  { column: "activity", label: "Última actividad" },
  { column: "grossArea", label: "Superficie total" },
  { column: "usableArea", label: "Superficie útil" },
  { column: "status", label: "Estado" },
] as const satisfies readonly { column: PaddockSortColumn; label: string }[];

export function ListaPotreros({
  archivedPotreros,
  canMutate,
  onMerge,
  onSelect,
  onSelectionModeChange,
  onShowArchivedChange,
  onToggleSelection,
  potreros,
  selectedId,
  selectedIds,
  selectionMode,
  showArchived,
  structuralOperationsEnabled,
  rotationSnapshot,
}: ListaPotrerosProps) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<SortState<PaddockSortColumn> | null>(null);
  const inventory = showArchived ? archivedPotreros : potreros;
  const rotationByPaddock = useMemo(
    () => new Map((rotationSnapshot?.paddocks ?? []).map((entry) => [entry.paddockId, entry])),
    [rotationSnapshot],
  );
  const visible = useMemo(() => {
    const filtered = inventory.filter((potrero) => `${potrero.name} ${potrero.sector}`.toLowerCase().includes(query.toLowerCase()));
    if (sort) return stableSortData(filtered, sort, PADDOCK_SORT_COLUMNS);
    if (showArchived || !rotationSnapshot) return filtered;
    return filtered.sort((first, second) => {
      const firstRank = rotationByPaddock.get(first.id)?.rank ?? Number.MAX_SAFE_INTEGER;
      const secondRank = rotationByPaddock.get(second.id)?.rank ?? Number.MAX_SAFE_INTEGER;
      return firstRank - secondRank || first.name.localeCompare(second.name, "es-CL", { numeric: true });
    });
  }, [inventory, query, rotationByPaddock, rotationSnapshot, showArchived, sort]);
  const handleSort = (column: PaddockSortColumn) => {
    setSort((current) => nextSortState(current, column));
  };

  return (
    <section className="overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_8px_35px_rgba(35,50,42,0.05)]">
      <div className="flex flex-col gap-4 border-b border-line-steel px-5 py-5 xl:flex-row xl:items-center xl:justify-between">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.16em] text-accent">Inventario territorial</p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.035em]">{showArchived ? "Potreros archivados" : "Tus potreros"}</h2>
          {selectionMode && !showArchived && <p className="mt-1 text-[12px] font-bold text-ink-muted">Marca dos o más potreros colindantes para fusionarlos.</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl border border-line-steel bg-surface-alt px-3 sm:w-56">
            <Search className="text-ink-subtle" size={15} />
            <input
              aria-label="Buscar potreros"
              className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-ink-subtle"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Buscar potrero..."
              value={query}
            />
          </label>
          <SortableDataSelect
            className="w-full sm:w-56 md:hidden"
            defaultLabel="Orden recomendado"
            label="Ordenar potreros"
            onChange={setSort}
            options={PADDOCK_SORT_OPTIONS}
            sort={sort}
          />
          <button
            aria-pressed={showArchived}
            className={`flex h-11 items-center gap-2 rounded-xl border px-3 text-[12px] font-black ${showArchived ? "border-amber-300 bg-amber-50 text-amber-900" : "border-line-steel text-ink-muted hover:bg-surface-alt"}`}
            onClick={() => {
              onShowArchivedChange(!showArchived);
              if (!showArchived) onSelectionModeChange(false);
            }}
            type="button"
          >
            <Archive size={14} /> {showArchived ? "Ver vigentes" : "Ver archivados"}
          </button>
          {!showArchived && canMutate && (
            <button
              aria-pressed={selectionMode}
              className={`flex h-11 items-center gap-2 rounded-xl border px-3 text-[12px] font-black ${selectionMode ? "border-accent bg-band text-ink" : "border-line-steel text-ink-muted hover:bg-surface-alt"}`}
              onClick={() => onSelectionModeChange(!selectionMode)}
              type="button"
            >
              <CheckSquare2 size={14} /> {selectionMode ? "Cancelar selección" : "Seleccionar para fusionar"}
            </button>
          )}
          {selectionMode && !showArchived && (
            <button
              className="flex h-11 items-center gap-2 rounded-xl bg-ink px-3 text-[12px] font-black text-white disabled:cursor-not-allowed disabled:opacity-40"
              disabled={selectedIds.length < 2 || !structuralOperationsEnabled}
              onClick={onMerge}
              type="button"
            >
              <GitMerge size={14} /> Fusionar {selectedIds.length > 0 ? `(${selectedIds.length})` : ""}
            </button>
          )}
          <button aria-label="Filtrar potreros" className="grid size-11 place-items-center rounded-xl border border-line-steel text-ink-muted hover:bg-surface-alt" type="button">
            <Filter size={15} />
          </button>
        </div>
      </div>

      <div className={`hidden gap-4 border-b border-line-steel bg-surface-alt px-5 py-3 text-[12px] font-black uppercase tracking-[0.13em] text-ink-subtle md:grid ${selectionMode && !showArchived ? "grid-cols-[32px_1.3fr_.9fr_.6fr_.6fr_.8fr_40px]" : "grid-cols-[1.3fr_.9fr_.6fr_.6fr_.8fr_40px]"}`}>
        {selectionMode && !showArchived && <span>Elegir</span>}
        {PADDOCK_SORT_OPTIONS.map((option) => (
          <SortableGridHeader
            column={option.column}
            key={option.column}
            label={option.label}
            onSort={handleSort}
            sort={sort}
          />
        ))}
        <span />
      </div>

      <div className="divide-y divide-line-steel">
        {visible.map((potrero) => {
          const selected = selectedId === potrero.id;
          const selectedForMerge = selectedIds.includes(potrero.id);
          const metrics = paddockAreaMetrics(potrero);
          const rotation = rotationByPaddock.get(potrero.id);
          return (
            <div className={`flex items-stretch transition hover:bg-surface-alt ${selected || selectedForMerge ? "bg-surface-alt" : ""}`} key={potrero.id}>
              {selectionMode && !showArchived && (
                <label className="grid w-14 shrink-0 place-items-center border-r border-line-steel">
                  <input
                    aria-label={`Seleccionar ${potrero.name} para fusionar`}
                    checked={selectedForMerge}
                    className="size-4 accent-accent"
                    onChange={() => onToggleSelection(potrero.id)}
                    type="checkbox"
                  />
                </label>
              )}
              <button
                aria-current={selected ? "true" : undefined}
                className="grid min-w-0 flex-1 gap-3 px-5 py-4 text-left md:grid-cols-[1.3fr_.9fr_.6fr_.6fr_.8fr_40px] md:items-center md:gap-4"
                onClick={() => onSelect(selected ? null : potrero.id)}
                type="button"
              >
                <span className="flex items-center gap-3">
                  <span className={`grid size-10 shrink-0 place-items-center rounded-xl ${selected || selectedForMerge ? "bg-accent text-ink" : showArchived ? "bg-amber-100 text-amber-800" : "bg-surface-alt text-accent"}`}>
                    {showArchived ? <Archive size={18} /> : <Sprout size={18} />}
                  </span>
                  <span>
                    <span className="block text-sm font-black text-ink">{potrero.name}</span>
                    <span className="mt-1 flex items-center gap-1 text-[12px] text-ink-subtle"><MapPin size={10} /> {potrero.sector}</span>
                    {metrics.geometry.holes.length > 0 && <span className="mt-1 block text-[12px] font-black text-amber-800">{metrics.geometry.holes.length} exclusión{metrics.geometry.holes.length === 1 ? "" : "es"} · F1 bloqueada</span>}
                  </span>
                </span>
                <span className="text-[12px] font-medium text-ink-muted">{potrero.lastActivity}</span>
                <span className="text-sm font-black text-ink"><span className="mr-1 text-[12px] uppercase text-ink-subtle md:hidden">Total:</span>{metrics.grossAreaHectares.toLocaleString("es-CL")} <span className="text-[12px] font-bold text-ink-subtle">ha</span></span>
                <span className="text-sm font-black text-accent"><span className="mr-1 text-[12px] uppercase text-ink-subtle md:hidden">Útil:</span>{metrics.effectiveGrazeableAreaHectares.toLocaleString("es-CL")} <span className="text-[12px] font-bold text-ink-subtle">ha</span></span>
                <span>
                  {showArchived
                    ? <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-black text-amber-900">Archivado</span>
                    : (
                      <span className="flex flex-wrap gap-1.5">
                        <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black ${statusStyles[potrero.status]}`}>{potrero.status}</span>
                        {rotation && <RotationBadge entry={rotation} />}
                      </span>
                    )}
                </span>
                <span className="hidden size-9 place-items-center justify-self-end rounded-xl text-ink-subtle hover:bg-white md:grid"><MoreHorizontal size={17} /></span>
              </button>
            </div>
          );
        })}

        {visible.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-5 py-12 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-surface-alt text-accent">{showArchived ? <Archive size={20} /> : inventory.length === 0 ? <Sprout size={20} /> : <Search size={20} />}</span>
            <p className="text-sm font-black">{showArchived ? "No hay potreros archivados" : inventory.length === 0 ? "Aún no has registrado potreros" : "No encontramos ese potrero"}</p>
            <p className="text-xs text-ink-subtle">{showArchived ? "Las operaciones estructurales conservarán aquí los potreros anteriores." : inventory.length === 0 ? "Dibuja el primero en el mapa y completa sus datos." : "Prueba con otro nombre o sector."}</p>
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-line-steel bg-surface-alt px-5 py-3">
        <p className="text-[12px] font-semibold text-ink-subtle">{visible.length} de {inventory.length} potreros {showArchived ? "archivados" : "vigentes"}</p>
        <button className="flex items-center gap-1.5 text-[12px] font-black text-accent" type="button">Exportar inventario <ArrowUpRight size={13} /></button>
      </div>
    </section>
  );
}

function RotationBadge({ entry }: { entry: PaddockRotationEntry }) {
  const noHistory = entry.dataQuality === "no_history" || entry.dataQuality === "invalid_history";
  const kind = noHistory ? "no_history" : entry.classification;
  const labels = {
    occupied: "Ocupado",
    recent: "Reciente",
    ready: "Listo",
    long_rest: "Descanso largo",
    no_history: "Sin historial",
  } as const;
  const styles = {
    occupied: "bg-red-100 text-red-800",
    recent: "bg-amber-100 text-amber-900",
    ready: "bg-lime-100 text-lime-900",
    long_rest: "bg-emerald-100 text-emerald-900",
    no_history: "border border-dashed border-slate-400 bg-slate-100 text-slate-700",
  } as const;
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black ${styles[kind]}`} title={entry.restDays === null ? undefined : `${entry.restDays} días de descanso`}>
      {labels[kind]}{entry.restDays === null || kind === "occupied" ? "" : ` · ${entry.restDays} d`}
    </span>
  );
}
