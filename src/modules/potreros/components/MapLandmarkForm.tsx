"use client";

import { LoaderCircle, Save, Undo2, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import {
  FIELD_LANDMARK_KINDS,
  type FieldLandmark,
  type FieldLandmarkKind,
} from "../domain/field-landmarks";
import type { Coordinate } from "../types";
import { calculatePathLengthMeters } from "../utils/geometry";
import { FIELD_LANDMARK_KIND_LABELS, type FieldLandmarkEditorDraft } from "./FieldLandmarksPanel";

type MapLandmarkFormProps = {
  busy: boolean;
  draft: FieldLandmarkEditorDraft;
  error: string | null;
  networkOnline: boolean;
  paddockName: string | null;
  selected: FieldLandmark | null;
  onCancel: () => void;
  onGeometryChange: (geometry: Coordinate[]) => void;
  onSave: (values: Readonly<{ kind: FieldLandmarkKind; name: string; notes: string }>) => Promise<void>;
};

/**
 * The landmark editor lives inside the map dashboard so drawing, naming and
 * saving happen in the same place, including fullscreen where no page panel is
 * reachable.
 */
export function MapLandmarkForm({
  busy,
  draft,
  error,
  networkOnline,
  paddockName,
  selected,
  onCancel,
  onGeometryChange,
  onSave,
}: MapLandmarkFormProps) {
  const [kind, setKind] = useState<FieldLandmarkKind>(selected?.kind ?? (draft.geometryType === "line" ? "cerco_electrico" : "bebedero"));
  const [name, setName] = useState(selected?.name ?? "");
  const [notes, setNotes] = useState(selected?.notes ?? "");
  const geometryReady = draft.geometryType === "point" ? draft.geometry.length === 1 : draft.geometry.length >= 2;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!geometryReady || !name.trim()) return;
    await onSave({ kind, name: name.trim(), notes: notes.trim() });
  }

  return (
    <form className="w-full text-white" onSubmit={submit}>
      <div className="flex flex-wrap items-center gap-1.5 p-1">
        <span className="flex min-h-8 items-center gap-2 truncate rounded bg-orange-500/20 border border-orange-500/30 px-2.5 text-[10px] font-black uppercase text-orange-200">
          {selected ? "Editar hito" : draft.geometryType === "point" ? "Nuevo hito" : "Nueva línea"}
          {paddockName && <span className="truncate font-bold">· {paddockName}</span>}
        </span>
        <label className="flex min-h-8 items-center gap-2 rounded bg-white/5 border border-white/10 px-2 text-[10px] font-bold uppercase tracking-wider text-white/70">
          <span className="sr-only">Tipo de hito</span>
          <select
            aria-label="Tipo de hito"
            className="min-h-8 bg-transparent text-[10px] font-black text-white outline-none cursor-pointer focus-visible:ring-1 focus-visible:ring-accent"
            disabled={busy}
            onChange={(event) => setKind(event.target.value as FieldLandmarkKind)}
            value={kind}
          >
            {FIELD_LANDMARK_KINDS.map((value) => <option className="text-ink" key={value} value={value}>{FIELD_LANDMARK_KIND_LABELS[value]}</option>)}
          </select>
        </label>
        <input
          aria-label="Nombre del hito"
          className="min-h-8 w-40 rounded bg-white px-2.5 text-[11px] font-bold text-ink outline-none placeholder:text-ink-subtle focus-visible:ring-1 focus-visible:ring-accent"
          disabled={busy}
          maxLength={160}
          onChange={(event) => setName(event.target.value)}
          placeholder="Ej. Bebedero norte"
          required
          value={name}
        />
        <input
          aria-label="Notas del hito"
          className="min-h-8 w-36 rounded bg-white/10 px-2.5 text-[11px] font-bold text-white outline-none border border-white/10 placeholder:text-white/40 focus-visible:ring-1 focus-visible:ring-accent"
          disabled={busy}
          maxLength={2000}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Notas (opcional)"
          value={notes}
        />
        <button
          className="flex min-h-8 items-center gap-1.5 rounded bg-accent px-2.5 text-[10px] font-bold uppercase tracking-wider text-white disabled:opacity-40"
          data-map-help="Guarda el hito y lo deja visible en la capa del fundo."
          disabled={busy || !geometryReady || !name.trim()}
          type="submit"
        >
          {busy ? <LoaderCircle className="animate-spin" size={12} /> : <Save size={12} />} <span>Guardar hito</span>
        </button>
        <button
          aria-label="Quitar último punto del hito"
          className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-30"
          data-map-help="Quita el último punto del hito o cerco que estás trazando."
          disabled={busy || draft.geometry.length === 0}
          onClick={() => onGeometryChange(draft.geometry.slice(0, -1))}
          type="button"
        >
          <Undo2 size={12} /> <span>Quitar punto</span>
        </button>
        <button
          className="min-h-8 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white transition disabled:opacity-30"
          data-map-help="Borra todos los puntos del hito actual."
          disabled={busy || draft.geometry.length === 0}
          onClick={() => onGeometryChange([])}
          type="button"
        >
          Limpiar
        </button>
        <button
          aria-label="Cancelar dibujo de hito"
          className="flex min-h-8 items-center gap-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 px-2.5 text-[10px] font-bold uppercase tracking-wider text-white/70 transition"
          disabled={busy}
          onClick={onCancel}
          type="button"
        >
          <X size={12} /> <span>Cancelar</span>
        </button>
        <span className="px-2 text-[10px] font-bold text-white/60">
          {draft.geometryType === "point"
            ? geometryReady ? "Punto listo; marca otra ubicación para reemplazarlo." : "Marca el punto en el mapa."
            : draft.geometry.length < 2
              ? `Marca ${2 - draft.geometry.length} punto${draft.geometry.length === 1 ? "" : "s"} más en el mapa.`
              : `${draft.geometry.length} vértices · ${formatDistance(calculatePathLengthMeters(draft.geometry))}`}
        </span>
      </div>
      {error && <p className="border-t border-white/10 px-3 py-1.5 text-[10px] font-bold text-red-200" role="alert">{error}</p>}
      {!networkOnline && <p className="border-t border-white/10 px-3 py-1.5 text-[10px] font-bold text-amber-200" role="status">Sin señal: Guardar conservará el cambio en la cola segura de este dispositivo.</p>}
    </form>
  );
}

function formatDistance(meters: number) {
  if (meters >= 1_000) return `${(meters / 1_000).toLocaleString("es-CL", { maximumFractionDigits: 2 })} km`;
  return `${meters.toLocaleString("es-CL", { maximumFractionDigits: 0 })} m`;
}
