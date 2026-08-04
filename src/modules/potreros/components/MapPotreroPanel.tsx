"use client";

import {
  ChevronDown,
  ChevronUp,
  Droplets,
  Fence,
  MapPin,
  MapPinned,
  Pencil,
  PencilRuler,
  RotateCcw,
  Route,
  ScissorsLineDashed,
  Sprout,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { FieldLandmark, FieldLandmarkGeometryType } from "../domain/field-landmarks";
import type { PaddockStockingLoad, Potrero } from "../types";
import { calculatePerimeterMeters } from "../utils/geometry";
import { paddockAreaMetrics } from "../utils/paddock-metrics";
import { paddockLandmarks } from "../utils/paddock-landmarks";
import { FIELD_LANDMARK_KIND_LABELS } from "./FieldLandmarksPanel";
import type { UndoPreview } from "./HistorialPotrero";

export type MapPotreroPanelProps = {
  potreros: Potrero[];
  selectedPotrero: Potrero | null;
  onSelect: (id: string | null) => void;
  canMutate: boolean;
  structuralOperationsEnabled: boolean;
  networkOnline: boolean;
  stockingLoad?: PaddockStockingLoad;
  activeCellCount: number;
  landmarks: readonly FieldLandmark[];
  landmarkBusy: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onEditBoundary: () => void;
  onSubdivide: () => void;
  onDrawExclusion: () => void;
  onManageCells: () => void;
  onAddLandmark: (geometryType: FieldLandmarkGeometryType) => void;
  onEditLandmark: (landmark: FieldLandmark) => void;
  onArchiveLandmark: (landmark: FieldLandmark) => void;
  onUndo?: () => void;
  undoPreview?: UndoPreview | null;
};

/**
 * Single in-map dashboard section for the selected paddock. It stays collapsed so
 * the map keeps the whole workspace; expanding it always works on the paddock the
 * user last clicked on the map.
 */
export function MapPotreroPanel({
  potreros,
  selectedPotrero,
  onSelect,
  canMutate,
  structuralOperationsEnabled,
  networkOnline,
  stockingLoad,
  activeCellCount,
  landmarks,
  landmarkBusy,
  onEdit,
  onDelete,
  onEditBoundary,
  onSubdivide,
  onDrawExclusion,
  onManageCells,
  onAddLandmark,
  onEditLandmark,
  onArchiveLandmark,
  onUndo,
  undoPreview,
}: MapPotreroPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const metrics = useMemo(() => selectedPotrero ? paddockAreaMetrics(selectedPotrero) : null, [selectedPotrero]);
  const ownLandmarks = useMemo(() => paddockLandmarks(landmarks, selectedPotrero), [landmarks, selectedPotrero]);
  const hasExclusions = (metrics?.geometry.holes.length ?? 0) > 0;

  return (
    <div className="w-full text-white space-y-3">
      <div className="flex items-center justify-between border-b border-white/10 pb-3">
        <div className="flex items-center gap-2">
          <Sprout aria-hidden="true" className="text-accent" size={16} />
          <span className="text-[12px] font-black uppercase tracking-wider">Potrero seleccionado</span>
        </div>
        {selectedPotrero && (
          <div className="flex items-center gap-1">
            <button
              aria-controls="map-potrero-panel"
              aria-expanded={expanded}
              className="flex min-h-7 items-center gap-1 rounded bg-white/5 border border-white/10 px-2 text-[10px] font-bold uppercase tracking-wider text-white/70 hover:text-white transition"
              onClick={() => setExpanded((current) => !current)}
              type="button"
            >
              {expanded ? <ChevronUp aria-hidden="true" size={12} /> : <ChevronDown aria-hidden="true" size={12} />}
              <span>{expanded ? "Contraer" : selectedPotrero.name}</span>
            </button>
            <button
              aria-label="Quitar la selección del potrero"
              className="flex min-h-7 items-center gap-1 rounded bg-white/5 border border-white/10 px-2 text-[10px] font-bold uppercase tracking-wider text-white/70 hover:text-white transition"
              onClick={() => { setExpanded(false); onSelect(null); }}
              type="button"
            >
              <X aria-hidden="true" size={12} />
              <span>Limpiar</span>
            </button>
          </div>
        )}
      </div>

      {selectedPotrero ? (
        <div className="flex flex-col gap-3" hidden={!expanded} id="map-potrero-panel">
          <div className="flex items-center gap-2">
            <label className="flex-1 flex min-h-9 items-center gap-2 rounded bg-white/5 border border-white/10 px-3 text-[11px] font-bold uppercase tracking-wider text-white/75">
              <MapPinned aria-hidden="true" size={13} />
              <span className="sr-only">Elegir potrero</span>
              <select
                aria-label="Elegir potrero"
                className="flex-1 min-h-9 bg-transparent text-[11px] font-black text-white outline-none focus-visible:ring-1 focus-visible:ring-accent"
                onChange={(event) => onSelect(event.target.value || null)}
                value={selectedPotrero?.id ?? ""}
              >
                <option value="">Sin potrero</option>
                {potreros.map((potrero) => (
                  <option className="text-ink" key={potrero.id} value={potrero.id}>{potrero.name}</option>
                ))}
              </select>
            </label>
          </div>

          {metrics && (
            <div className="border border-white/10 rounded bg-white/5 divide-y divide-white/10 text-[11px]">
              <div className="grid grid-cols-2 p-2">
                <span className="font-bold text-white/40 uppercase tracking-wider">Superficie total</span>
                <span className="text-right font-mono font-bold text-white/90">{metrics.grossAreaHectares.toLocaleString("es-CL")} ha</span>
              </div>
              <div className="grid grid-cols-2 p-2">
                <span className="font-bold text-white/40 uppercase tracking-wider">Superficie útil</span>
                <span className="text-right font-mono font-bold text-white/90">
                  {metrics.effectiveGrazeableAreaHectares.toLocaleString("es-CL")} ha · {metrics.grazeablePercentage.toLocaleString("es-CL")}%
                </span>
              </div>
              <div aria-label="Perímetro" className="grid grid-cols-2 p-2">
                <span className="font-bold text-white/40 uppercase tracking-wider">Perímetro</span>
                <span className="text-right font-mono font-bold text-white/90">{formatDistance(calculatePerimeterMeters(selectedPotrero.coordinates))}</span>
              </div>
              <div className="grid grid-cols-2 p-2">
                <span className="font-bold text-white/40 uppercase tracking-wider">Animales</span>
                <span className="text-right font-mono font-bold text-white/90">{stockingLoad ? stockingLoad.animalCount.toLocaleString("es-CL") : "—"}</span>
              </div>
              <div className="grid grid-cols-2 p-2">
                <span className="font-bold text-white/40 uppercase tracking-wider">Carga animal</span>
                <span className="text-right font-mono font-bold text-white/90">
                  {stockingLoad?.animalsPerHectare === null || !stockingLoad
                    ? "—"
                    : `${stockingLoad.animalsPerHectare.toLocaleString("es-CL", { maximumFractionDigits: 2 })} anim/ha`}
                </span>
              </div>
            </div>
          )}

          <div className="space-y-2 border-t border-white/10 pt-3">
            <span className="block text-[10px] font-black uppercase tracking-widest text-white/40">Acciones del potrero</span>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                className="flex min-h-9 items-center justify-center gap-2 rounded bg-orange-600/20 border border-orange-500/30 text-orange-200 hover:bg-orange-600/30 text-[11px] font-bold uppercase tracking-wider transition"
                data-map-help="Divide el potrero en franjas de pastoreo y revisa su historial."
                onClick={onManageCells}
                type="button"
              >
                <MapPinned size={13} />
                <span>{canMutate ? activeCellCount > 0 ? `Franjas (${activeCellCount})` : "Crear franjas" : activeCellCount > 0 ? `Ver franjas (${activeCellCount})` : "Ver franjas"}</span>
              </button>
              {canMutate && (
                <>
                  <button
                    className="flex min-h-9 items-center justify-center gap-2 rounded bg-white/5 border border-white/10 text-white hover:bg-white/10 text-[11px] font-bold uppercase tracking-wider transition"
                    onClick={onEdit}
                    type="button"
                  >
                    <Pencil size={13} />
                    <span>Editar ficha</span>
                  </button>
                  <button
                    className="flex min-h-9 items-center justify-center gap-2 rounded bg-white/5 border border-white/10 text-white hover:bg-white/10 text-[11px] font-bold uppercase tracking-wider transition disabled:opacity-40"
                    disabled={hasExclusions || !structuralOperationsEnabled}
                    onClick={onEditBoundary}
                    type="button"
                  >
                    <PencilRuler size={13} />
                    <span>Editar bordes</span>
                  </button>
                  <button
                    className="flex min-h-9 items-center justify-center gap-2 rounded bg-sky-950 border border-sky-500/30 text-sky-200 hover:bg-sky-900/60 text-[11px] font-bold uppercase tracking-wider transition disabled:opacity-40"
                    disabled={!networkOnline}
                    onClick={onDrawExclusion}
                    type="button"
                  >
                    <Droplets size={13} />
                    <span>Dibujar exclusión</span>
                  </button>
                  <button
                    className="flex min-h-9 items-center justify-center gap-2 rounded bg-accent text-white hover:bg-accent-strong text-[11px] font-bold uppercase tracking-wider transition disabled:opacity-40 col-span-2"
                    disabled={!structuralOperationsEnabled || hasExclusions}
                    onClick={onSubdivide}
                    type="button"
                  >
                    <ScissorsLineDashed size={13} />
                    <span>Subdividir potrero</span>
                  </button>
                  {undoPreview?.canUndo && onUndo && (
                    <button
                      className="flex min-h-9 items-center justify-center gap-2 rounded bg-amber-600/20 border border-amber-500/30 text-amber-200 hover:bg-amber-600/30 text-[11px] font-bold uppercase tracking-wider transition disabled:opacity-40 col-span-2"
                      disabled={!structuralOperationsEnabled}
                      onClick={onUndo}
                      type="button"
                    >
                      <RotateCcw size={13} />
                      <span>Deshacer operación</span>
                    </button>
                  )}
                  <button
                    aria-label={`Eliminar ${selectedPotrero.name}`}
                    className="flex min-h-9 items-center justify-center gap-2 rounded bg-red-950/40 border border-red-500/20 text-red-200 hover:bg-red-900/40 text-[11px] font-bold uppercase tracking-wider transition col-span-2"
                    onClick={onDelete}
                    type="button"
                  >
                    <Trash2 size={13} />
                    <span>Eliminar potrero</span>
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="space-y-2 border-t border-white/10 pt-3">
            <span className="block text-[10px] font-black uppercase tracking-widest text-white/40">
              Hitos del potrero ({ownLandmarks.length})
            </span>
            {canMutate && (
              <div className="grid grid-cols-2 gap-1.5">
                <button
                  className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/10 hover:bg-white/15 px-3 text-[11px] font-bold uppercase tracking-wider text-white transition disabled:opacity-40"
                  disabled={landmarkBusy}
                  onClick={() => onAddLandmark("point")}
                  type="button"
                >
                  <MapPin size={12} />
                  <span>+ Punto</span>
                </button>
                <button
                  className="flex min-h-8 items-center justify-center gap-1.5 rounded bg-white/10 hover:bg-white/15 px-3 text-[11px] font-bold uppercase tracking-wider text-white transition disabled:opacity-40"
                  disabled={landmarkBusy}
                  onClick={() => onAddLandmark("line")}
                  type="button"
                >
                  <Route size={12} />
                  <span>+ Línea</span>
                </button>
              </div>
            )}
            <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
              {ownLandmarks.map((landmark) => (
                <div className="flex items-center justify-between rounded bg-white/5 p-1.5 text-[11px] border border-white/5" key={landmark.id}>
                  <div className="flex items-center gap-1.5 truncate">
                    {landmark.geometryType === "point"
                      ? <MapPin className="text-accent shrink-0" size={12} />
                      : landmark.kind === "cerco_electrico" ? <Fence className="text-hivis shrink-0" size={12} /> : <Route className="text-sky-300 shrink-0" size={12} />}
                    <span className="font-bold truncate text-white/90">{landmark.name}</span>
                    <span className="text-[10px] text-white/45">({FIELD_LANDMARK_KIND_LABELS[landmark.kind]})</span>
                  </div>
                  {canMutate && (
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        aria-label={`Editar ${landmark.name}`}
                        className="grid size-6 place-items-center rounded hover:bg-white/10 text-white/60 hover:text-white"
                        disabled={landmarkBusy}
                        onClick={() => onEditLandmark(landmark)}
                        type="button"
                      >
                        <Pencil size={11} />
                      </button>
                      <button
                        aria-label={`Archivar ${landmark.name}`}
                        className="grid size-6 place-items-center rounded hover:bg-red-900/40 text-red-300 hover:text-red-200"
                        disabled={landmarkBusy}
                        onClick={() => onArchiveLandmark(landmark)}
                        type="button"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
              {ownLandmarks.length === 0 && (
                <span className="block text-[11px] italic text-white/40 py-1">Sin hitos en este potrero todavía.</span>
              )}
            </div>
          </div>
        </div>
      ) : (
        <p className="px-1 py-2 text-[11px] font-bold text-white/50">
          Toca un potrero en el mapa o selecciónalo arriba para ver sus datos y acciones.
        </p>
      )}
    </div>
  );
}

function formatDistance(meters: number) {
  if (meters >= 1_000) return `${(meters / 1_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
  return `${meters.toLocaleString("es-CL", { maximumFractionDigits: 0 })} m`;
}
