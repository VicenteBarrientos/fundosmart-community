"use client";

import { CloudOff, Fence, LoaderCircle, MapPin, Pencil, Route, Trash2 } from "lucide-react";
import { useMemo } from "react";
import type {
  FieldLandmark,
  FieldLandmarkGeometryType,
  FieldLandmarkKind,
} from "../domain/field-landmarks";
import type { Coordinate, Potrero } from "../types";
import { landmarkBelongsToPaddock } from "../utils/paddock-landmarks";

export type FieldLandmarkLoadState = "idle" | "loading" | "loaded" | "stale" | "offline" | "error";

export type FieldLandmarkEditorDraft = Readonly<{
  id: string;
  geometryType: FieldLandmarkGeometryType;
  geometry: Coordinate[];
  expectedVersion: number | null;
  operationId: string;
}>;

export const FIELD_LANDMARK_KIND_LABELS: Record<FieldLandmarkKind, string> = {
  bebedero: "Bebedero",
  porton: "Portón",
  sala_ordena: "Sala de ordeña",
  bodega: "Bodega",
  manga: "Manga",
  cerco_electrico: "Cerco eléctrico",
  callejon: "Callejón",
  linea_agua: "Línea de agua",
  otro: "Otro",
};

type FieldLandmarksPanelProps = {
  landmarks: readonly FieldLandmark[];
  paddocks: readonly Potrero[];
  loadState: FieldLandmarkLoadState;
  canMutate: boolean;
  draft: FieldLandmarkEditorDraft | null;
  busy: boolean;
  error: string | null;
  onStart: (geometryType: FieldLandmarkGeometryType) => void;
  onEdit: (landmark: FieldLandmark) => void;
  onCancel: () => void;
  onArchive: (landmark: FieldLandmark) => Promise<void>;
};

/** Field-wide inventory. Drawing, naming and saving happen in the map dashboard. */
export function FieldLandmarksPanel({
  landmarks,
  paddocks,
  loadState,
  canMutate,
  draft,
  busy,
  error,
  onStart,
  onEdit,
  onCancel,
  onArchive,
}: FieldLandmarksPanelProps) {
  const selected = draft ? landmarks.find(({ id }) => id === draft.id) ?? null : null;
  const paddockNamesByLandmark = useMemo(() => new Map(landmarks.map((landmark) => [
    landmark.id,
    paddocks.filter((paddock) => landmarkBelongsToPaddock(landmark, paddock)).map((paddock) => paddock.name),
  ])), [landmarks, paddocks]);
  const electricFenceStats = useMemo(() => {
    const fences = landmarks.filter(({ kind: landmarkKind, geometryType }) => landmarkKind === "cerco_electrico" && geometryType === "line");
    return { count: fences.length, meters: fences.reduce((sum, fence) => sum + fence.lengthMeters, 0) };
  }, [landmarks]);

  return (
    <section aria-labelledby="field-landmarks-title" className="mt-5 overflow-hidden rounded-[22px] border border-line-steel bg-white shadow-[0_10px_38px_rgba(35,50,42,0.05)]">
      <div className="flex flex-col gap-3 border-b border-line-steel px-5 py-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Infraestructura del fundo</p>
          <h2 className="mt-1 text-lg font-black tracking-[-0.035em]" id="field-landmarks-title">Hitos y cercos</h2>
          <p className="mt-1 text-[12px] font-semibold text-ink-subtle">
            {landmarks.length} activos · {electricFenceStats.count} cercos eléctricos · {formatDistance(electricFenceStats.meters)} totales
          </p>
        </div>
        {canMutate && (
          <div className="flex flex-wrap gap-2">
            <button className="flex min-h-11 items-center gap-2 rounded-xl border border-line-steel px-3 text-[12px] font-black text-ink disabled:opacity-40" disabled={busy} onClick={() => onStart("point")} type="button"><MapPin size={15} /> Nuevo punto</button>
            <button className="flex min-h-11 items-center gap-2 rounded-xl bg-ink px-3 text-[12px] font-black text-white disabled:opacity-40" disabled={busy} onClick={() => onStart("line")} type="button"><Route size={15} /> Nueva línea</button>
          </div>
        )}
      </div>

      {(loadState === "offline" || loadState === "stale") && (
        <p className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-3 text-[12px] font-bold text-amber-900" role="status"><CloudOff size={14} /> Hitos cargados desde la copia local; la capa permanece disponible sin conexión.</p>
      )}
      {loadState === "error" && landmarks.length === 0 && <p className="px-5 py-3 text-[12px] font-bold text-red-700" role="alert">No fue posible cargar los hitos.</p>}

      {draft && (
        <p className="flex flex-wrap items-center gap-2 border-b border-line-steel bg-surface-alt px-5 py-3 text-[12px] font-bold text-ink-muted" role="status">
          <Pencil size={14} />
          {selected ? `Editando «${selected.name}»` : draft.geometryType === "point" ? "Marcando un hito nuevo" : "Trazando una línea nueva"} en el mapa; completa el nombre y guarda desde el dashboard del mapa.
          <button className="min-h-11 rounded-xl border border-line-steel px-3 text-[12px] font-black text-ink" disabled={busy} onClick={onCancel} type="button">Cancelar</button>
        </p>
      )}
      {error && <p className="border-b border-red-200 bg-red-50 px-5 py-3 text-[12px] font-bold text-red-800" role="alert">{error}</p>}

      <div className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-3">
        {landmarks.map((landmark) => (
          <article className="flex min-h-20 items-center justify-between gap-3 rounded-2xl border border-line-steel bg-surface-alt p-3" key={landmark.id}>
            <div className="flex min-w-0 items-center gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-band text-accent">{landmark.geometryType === "point" ? <MapPin size={17} /> : landmark.kind === "cerco_electrico" ? <Fence size={17} /> : <Route size={17} />}</span>
              <div className="min-w-0">
                <p className="truncate text-xs font-black text-ink">{landmark.name}</p>
                <p className="mt-1 text-[12px] font-bold text-ink-subtle">{FIELD_LANDMARK_KIND_LABELS[landmark.kind]}{landmark.geometryType === "line" ? ` · ${formatDistance(landmark.lengthMeters)}` : ""}</p>
                <p className="mt-1 truncate text-[12px] font-semibold text-accent">{formatPaddockScope(paddockNamesByLandmark.get(landmark.id) ?? [])}</p>
              </div>
            </div>
            {canMutate && (
              <div className="flex shrink-0 gap-1">
                <button aria-label={`Editar ${landmark.name}`} className="grid size-11 place-items-center rounded-xl text-accent hover:bg-band disabled:opacity-35" disabled={busy} onClick={() => onEdit(landmark)} type="button"><Pencil size={14} /></button>
                <button aria-label={`Archivar ${landmark.name}`} className="grid size-11 place-items-center rounded-xl text-red-700 hover:bg-red-50 disabled:opacity-35" disabled={busy} onClick={() => { void onArchive(landmark); }} type="button"><Trash2 size={14} /></button>
              </div>
            )}
          </article>
        ))}
        {landmarks.length === 0 && loadState !== "loading" && <p className="col-span-full rounded-2xl border border-dashed border-line-steel p-5 text-center text-[12px] font-bold text-ink-subtle">Aún no hay hitos activos en este fundo.</p>}
        {loadState === "loading" && <p className="col-span-full flex items-center justify-center gap-2 p-5 text-[12px] font-bold text-ink-subtle"><LoaderCircle className="animate-spin" size={14} /> Cargando hitos…</p>}
      </div>
    </section>
  );
}

function formatDistance(meters: number) {
  if (meters >= 1_000) return `${(meters / 1_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
  return `${meters.toLocaleString("es-CL", { maximumFractionDigits: 0 })} m`;
}

function formatPaddockScope(names: readonly string[]) {
  if (names.length === 0) return "Fuera de los potreros dibujados";
  if (names.length <= 2) return `En ${names.join(" y ")}`;
  return `En ${names.slice(0, 2).join(", ")} y ${names.length - 2} potrero${names.length - 2 === 1 ? "" : "s"} más`;
}
