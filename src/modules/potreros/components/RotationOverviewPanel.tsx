"use client";

import { CheckCircle2, CloudOff, LoaderCircle, Settings2, X } from "lucide-react";
import { useCallback, useRef, useState, type FormEvent } from "react";
import { HelpTip } from "@/src/ui/Hint";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import type { PaddockRotationSettingsUpdateRequest, PaddockRotationSnapshot } from "../domain/cells-rotation";

export type RotationLoadState = "idle" | "loading" | "loaded" | "stale" | "offline" | "error";

type RotationOverviewPanelProps = {
  canMutate: boolean;
  loadState: RotationLoadState;
  networkOnline: boolean;
  onSaveSettings: (request: PaddockRotationSettingsUpdateRequest) => Promise<void>;
  snapshot: PaddockRotationSnapshot | null;
};

export function RotationOverviewPanel({
  canMutate,
  loadState,
  networkOnline,
  onSaveSettings,
  snapshot,
}: RotationOverviewPanelProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [recentDays, setRecentDays] = useState("");
  const [longRestDays, setLongRestDays] = useState("");
  const [operationId, setOperationId] = useState<string | null>(null);
  const [operationFieldId, setOperationFieldId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const closeSettings = useCallback(() => setDialogOpen(false), []);
  useDialogA11y(dialogRef, closeSettings, dialogOpen && !saving);
  const recent = Number(recentDays);
  const longRest = Number(longRestDays);
  const valid = Number.isInteger(recent) && recent >= 0 && Number.isInteger(longRest) && recent < longRest;

  function openSettings() {
    if (!snapshot) return;
    setRecentDays(String(snapshot.settings.recentDays));
    setLongRestDays(String(snapshot.settings.longRestDays));
    setOperationId((current) => operationFieldId === snapshot.fieldId ? current ?? crypto.randomUUID() : crypto.randomUUID());
    setOperationFieldId(snapshot.fieldId);
    setError(null);
    setDialogOpen(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!snapshot || !operationId || !valid || !networkOnline || !canMutate) return;
    setSaving(true);
    setError(null);
    try {
      await onSaveSettings({
        fieldId: snapshot.fieldId,
        operationId,
        recentDays: recent,
        longRestDays: longRest,
        expectedVersion: snapshot.settings.version,
      });
      setDialogOpen(false);
      setOperationId(null);
      setOperationFieldId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible guardar los umbrales.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section aria-live="polite" className="mt-3 flex flex-col gap-3 rounded-2xl border border-line-steel bg-surface-alt px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-accent text-ink">
            {loadState === "loading" ? <LoaderCircle className="animate-spin" size={18} /> : loadState === "offline" || loadState === "stale" ? <CloudOff size={18} /> : <CheckCircle2 size={18} />}
          </span>
          <div className="min-w-0">
            <p className="flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.14em] text-accent">
              Rotación sugerida
              <HelpTip help="praderaRotacion" label="la rotación sugerida" />
            </p>
            <p className="mt-1 text-sm font-black text-ink">
              {snapshot?.banner ?? (loadState === "loading" ? "Calculando descanso por potrero…" : "Sin datos de rotación disponibles")}
            </p>
            <p className="mt-1 text-[12px] font-semibold text-ink-muted">
              {loadState === "stale" || loadState === "offline"
                ? "Mostrando el último cálculo guardado; se actualizará al recuperar conexión."
                : loadState === "error"
                  ? "No fue posible actualizar el cálculo."
                  : snapshot
                    ? `Reciente < ${snapshot.settings.recentDays} días · descanso largo > ${snapshot.settings.longRestDays} días`
                    : "La recomendación usa pastoreos y lotes activos, sin estados manuales."}
            </p>
          </div>
        </div>
        <button
          className="flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-4 text-[12px] font-black text-ink disabled:cursor-not-allowed disabled:opacity-45"
          data-hint={
            !canMutate
              ? "Vista de solo lectura."
              : !networkOnline
                ? "Requiere conexión."
                : "Define cuántos días cuentan como descanso corto y cuántos como descanso largo. Con eso se decide qué potrero recomendar."
          }
          disabled={!snapshot || !canMutate || !networkOnline}
          onClick={openSettings}
          type="button"
        >
          <Settings2 size={16} /> Configurar umbrales
        </button>
      </section>

      {dialogOpen && snapshot && (
        <div className="fixed inset-0 z-[1000] grid place-items-center bg-chrome/55 p-4" role="presentation">
          <section aria-labelledby="rotation-settings-title" aria-modal="true" className="w-full max-w-md rounded-[22px] bg-white p-5 shadow-2xl" ref={dialogRef} role="dialog" tabIndex={-1}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">Reglas del fundo</p>
                <h2 className="mt-1 text-xl font-black" id="rotation-settings-title">Umbrales de rotación</h2>
              </div>
              <button aria-label="Cerrar configuración" className="grid size-11 place-items-center rounded-xl hover:bg-surface-alt" onClick={closeSettings} type="button"><X size={18} /></button>
            </div>
            <form className="mt-5 space-y-4" onSubmit={submit}>
              <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                Descanso reciente (días)
                <input className="input-base min-h-11" inputMode="numeric" min="0" onChange={(event) => setRecentDays(event.target.value)} required type="number" value={recentDays} />
              </label>
              <label className="grid gap-1.5 text-[12px] font-black uppercase tracking-wide text-ink-muted">
                Descanso largo (días)
                <input className="input-base min-h-11" inputMode="numeric" min="1" onChange={(event) => setLongRestDays(event.target.value)} required type="number" value={longRestDays} />
              </label>
              {!valid && <p className="text-xs font-bold text-red-700" role="alert">“Reciente” debe ser un entero no negativo y estrictamente menor que “descanso largo”.</p>}
              {!networkOnline && <p className="text-xs font-bold text-amber-800">Este cambio requiere conexión.</p>}
              {error && <p className="text-xs font-bold text-red-700" role="alert">{error}</p>}
              <div className="flex justify-end gap-2">
                <button className="min-h-11 rounded-xl px-4 text-xs font-black text-ink-muted hover:bg-surface-alt" onClick={closeSettings} type="button">Cancelar</button>
                <button className="flex min-h-11 items-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white disabled:opacity-40" disabled={!valid || saving || !networkOnline} type="submit">
                  {saving && <LoaderCircle className="animate-spin" size={15} />} Guardar
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
