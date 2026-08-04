"use client";

import type { LivestockAnimal, LivestockLot } from "@/src/core/domain/types";
import { TableExplorer } from "@/src/ui/TableExplorer";
import {
  countOfflineMutations,
  flushOfflineAttachments,
  flushOfflineMutations,
  getActiveOfflineSession,
  getOfflineMutationSummary,
  getOfflineReadModel,
  listOfflineAttachments,
  listOfflineMutations,
  offlinePartitionFromSession,
  pullOfflineChanges,
  putOfflineReadModel,
  queueOfflineAttachment,
  readOfflineCursor,
  refreshOfflineSession,
  resolveOfflineConflict,
  sendOrQueueSyncMutations,
  type OfflineMutation,
  type OfflineMutationSummary,
  type OfflineSession,
} from "@/src/core/offline/mutation-queue";
import { createOfflineMutationId } from "@/src/modules/offline/domain/offline-rules.mjs";
import type { DomainEventRecord, SyncEntity, SyncJsonValue, SyncMutationInput } from "@/src/modules/sync/domain/types";
import { Camera, CloudOff, CloudUpload, FileSpreadsheet, MapPinned, Radio, RefreshCw, ShieldCheck, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { parseDeviceWeightText, type DeviceWeightRow } from "../lib/device-import";

type Props = { animals: LivestockAnimal[]; lots: LivestockLot[]; offlineScope: string; onSynced: () => Promise<void> };
type QuickMode = "health" | "estrus" | "movement";
type CaptureEvent = Pick<DomainEventRecord, "id" | "fieldId" | "entity" | "entityId" | "payload" | "occurredAt">;
type LivestockFieldReference = {
  version: 1;
  animals: Array<Pick<LivestockAnimal, "id" | "tag" | "sex" | "status" | "lotId">>;
  lots: Array<Pick<LivestockLot, "id" | "name" | "fieldId" | "trackingMode">>;
};

const EMPTY_SUMMARY: OfflineMutationSummary = { pending: 0, syncing: 0, conflict: 0, error: 0, applied: 0 };
const CAPTURE_ENTITIES = new Set<SyncEntity>(["livestock_weighing", "livestock_health", "livestock_estrus", "livestock_movement"]);

export function TerrenoSection({ animals, lots, offlineScope, onSynced }: Props) {
  const [online, setOnline] = useState(true);
  const [session, setSession] = useState<OfflineSession | null>(null);
  const [pending, setPending] = useState(0);
  const [syncSummary, setSyncSummary] = useState<OfflineMutationSummary>(EMPTY_SUMMARY);
  const [attachmentSummary, setAttachmentSummary] = useState({ pending: 0, errors: 0 });
  const [message, setMessage] = useState<string | null>(null);
  const [rows, setRows] = useState<DeviceWeightRow[]>([]);
  const [lotId, setLotId] = useState(lots.find((entry) => entry.trackingMode === "individual")?.id ?? "");
  const [recordedAt, setRecordedAt] = useState(today());
  const [quick, setQuick] = useState({ mode: "health" as QuickMode, animalId: "", date: today(), detail: "", product: "", destinationRup: "" });
  const [photo, setPhoto] = useState<File | null>(null);
  const [conflicts, setConflicts] = useState<OfflineMutation[]>([]);
  const [conflictDrafts, setConflictDrafts] = useState<Record<string, string>>({});
  const [recent, setRecent] = useState<CaptureEvent[]>([]);
  const individualLots = lots.filter((entry) => entry.trackingMode === "individual");
  const lotById = useMemo(() => new Map(lots.map((entry) => [entry.id, entry])), [lots]);
  const animalsByTag = useMemo(() => new Map(animals.map((entry) => [normalizeTag(entry.tag), entry])), [animals]);
  const matched = rows.map((row) => ({ ...row, animal: animalsByTag.get(normalizeTag(row.tag)) ?? null })).filter((entry) => entry.animal?.lotId === lotId);
  const unmatched = rows.length - matched.length;

  const updateLocalState = useCallback(async () => {
    setOnline(navigator.onLine);
    setPending(await countOfflineMutations(offlineScope));
    setSyncSummary(await getOfflineMutationSummary(offlineScope));
    const storedAttachments = await listOfflineAttachments(offlineScope);
    setAttachmentSummary({
      pending: storedAttachments.filter((entry) => entry.status !== "applied").length,
      errors: storedAttachments.filter((entry) => entry.status === "error").length,
    });
    const storedConflicts = (await listOfflineMutations(offlineScope)).filter((entry) => entry.status === "conflict");
    setConflicts(storedConflicts);
    setConflictDrafts((current) => Object.fromEntries(storedConflicts.map((entry) => [
      entry.id,
      current[entry.id] ?? JSON.stringify(readMutationPayload(entry), null, 2),
    ])));
  }, [offlineScope]);

  const refreshReadModels = useCallback(async (activeSession: OfflineSession) => {
    const collected: CaptureEvent[] = [];
    for (const fieldId of activeSession.fieldIds) {
      const partition = offlinePartitionFromSession(activeSession, fieldId);
      const cursor = await readOfflineCursor(partition, "domain-events");
      const result = await pullOfflineChanges<DomainEventRecord>({ scope: offlineScope, partition, cursor, limit: 100 });
      const stored = await getOfflineReadModel<CaptureEvent[]>(partition, "recent-field-captures");
      const added = result.events.filter((entry) => CAPTURE_ENTITIES.has(entry.entity as SyncEntity));
      const merged = [...added, ...(stored?.value ?? [])]
        .filter((entry, index, all) => all.findIndex((candidate) => candidate.id === entry.id) === index)
        .sort((left, right) => right.occurredAt.localeCompare(left.occurredAt))
        .slice(0, 50);
      await putOfflineReadModel(partition, "recent-field-captures", merged, result.nextCursor);
      collected.push(...merged);
    }
    setRecent(collected.sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 50));
  }, [offlineScope]);

  const seedCaptureReferences = useCallback(async (activeSession: OfflineSession) => {
    for (const fieldId of activeSession.fieldIds) {
      const fieldLots = lots.filter((lot) => lot.fieldId === fieldId);
      const lotIds = new Set(fieldLots.map(({ id }) => id));
      const reference: LivestockFieldReference = {
        version: 1,
        animals: animals
          .filter((animal) => lotIds.has(animal.lotId))
          .map(({ id, tag, sex, status, lotId }) => ({ id, tag, sex, status, lotId })),
        lots: fieldLots.map(({ id, name, fieldId: lotFieldId, trackingMode }) => ({ id, name, fieldId: lotFieldId, trackingMode })),
      };
      await putOfflineReadModel(
        offlinePartitionFromSession(activeSession, fieldId),
        "livestock-field-reference-v1",
        reference,
        0,
      );
    }
  }, [animals, lots]);

  const syncNow = useCallback(async () => {
    let activeSession = await getActiveOfflineSession(offlineScope);
    if (navigator.onLine) {
      try {
        activeSession = await refreshOfflineSession(offlineScope);
        setSession(activeSession);
        await seedCaptureReferences(activeSession);
      } catch {
        setMessage("Vuelve a autenticarte para enviar las capturas; los datos siguen guardados en el teléfono.");
        await updateLocalState();
        return;
      }
    }
    if (!activeSession) {
      setMessage("La sesión offline expiró. Conéctate y vuelve a abrir esta sección antes de registrar nuevas capturas.");
      return;
    }
    const mutations = await flushOfflineMutations(offlineScope);
    const attachments = await flushOfflineAttachments(offlineScope);
    if (navigator.onLine) await refreshReadModels(activeSession);
    await updateLocalState();
    if (mutations.sent || attachments.sent) {
      setMessage(`${mutations.sent} captura${mutations.sent === 1 ? "" : "s"} y ${attachments.sent} foto${attachments.sent === 1 ? "" : "s"} sincronizadas.`);
      await onSynced();
    } else if (mutations.conflicts) {
      setMessage(`${mutations.conflicts} captura${mutations.conflicts === 1 ? " requiere" : "s requieren"} revisión manual.`);
    } else if (!navigator.onLine) {
      setMessage("Sin señal: las capturas permanecen guardadas en este dispositivo.");
    } else {
      setMessage("Todo está sincronizado.");
    }
  }, [offlineScope, onSynced, refreshReadModels, seedCaptureReferences, updateLocalState]);

  useEffect(() => {
    let active = true;
    void (async () => {
      setOnline(navigator.onLine);
      let loaded = await getActiveOfflineSession(offlineScope);
      if (navigator.onLine) {
        try {
          loaded = await refreshOfflineSession(offlineScope);
        } catch {
          // A cached, still-valid session can continue protecting local capture.
        }
      }
      if (active) setSession(loaded);
      if (loaded) await seedCaptureReferences(loaded);
      await updateLocalState();
      if (loaded && navigator.onLine) await refreshReadModels(loaded).catch(() => undefined);
    })();
    const handleOnline = () => { void syncNow(); };
    const handleOffline = () => { void updateLocalState(); };
    const handleQueue = () => { void updateLocalState(); };
    const handleWorker = (event: MessageEvent) => { if (event.data?.type === "fundosmart:offline-sync-request") void syncNow(); };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("fundosmart:offline-queue", handleQueue);
    navigator.serviceWorker?.addEventListener("message", handleWorker);
    return () => {
      active = false;
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("fundosmart:offline-queue", handleQueue);
      navigator.serviceWorker?.removeEventListener("message", handleWorker);
    };
  }, [offlineScope, refreshReadModels, seedCaptureReferences, syncNow, updateLocalState]);

  async function sendCapture(input: {
    fieldId: string;
    entity: Extract<SyncEntity, `livestock_${string}`>;
    payload: Record<string, SyncJsonValue>;
    label: string;
    file?: File | null;
  }) {
    const activeSession = await getActiveOfflineSession(offlineScope);
    if (!activeSession) throw new Error("La sesión offline expiró. Conéctate antes de registrar otra captura.");
    const id = createOfflineMutationId();
    const attachmentId = input.file ? createOfflineMutationId() : null;
    const entityId = `${input.entity}:${id}`;
    const mutation: SyncMutationInput = {
      id,
      fieldId: input.fieldId,
      entity: input.entity,
      entityId,
      op: "append",
      payload: attachmentId ? { ...input.payload, attachmentId } : input.payload,
      clientTs: new Date().toISOString(),
      expectedVersion: null,
    };
    const [result] = await sendOrQueueSyncMutations({
      scope: offlineScope,
      partition: offlinePartitionFromSession(activeSession, input.fieldId),
      mutations: [mutation],
      label: input.label,
    });
    let attachmentError: string | null = null;
    if (input.file && attachmentId) {
      try {
        await queueOfflineAttachment({ scope: offlineScope, session: activeSession, fieldId: input.fieldId, attachmentId, entityId, file: input.file });
        if (navigator.onLine && !result?.queued && result.response?.ok) await flushOfflineAttachments(offlineScope);
      } catch (cause) {
        attachmentError = errorMessage(cause);
      }
    }
    await updateLocalState();
    if (result?.response && !result.response.ok) throw new Error(await apiError(result.response));
    setMessage(attachmentError
      ? `${input.label} quedó guardada, pero la foto no se pudo conservar: ${attachmentError}`
      : result?.queued ? `${input.label} guardada en el teléfono; se enviará al reconectar.` : `${input.label} registrada y auditada.`);
    if (!result?.queued) {
      await refreshReadModels(activeSession);
      await onSynced();
    }
  }

  async function saveWeights() {
    if (!matched.length) return setMessage("No hay lecturas que coincidan con animales del lote seleccionado.");
    const fieldId = lotById.get(lotId)?.fieldId;
    if (!fieldId) return setMessage("El lote no pertenece a un fundo disponible.");
    try {
      await sendCapture({
        fieldId,
        entity: "livestock_weighing",
        label: `Pesaje ${recordedAt}`,
        payload: {
          lotId,
          recordedAt,
          notes: "Importado desde lector EID/balanza",
          entries: matched.map((entry) => ({ animalId: entry.animal!.id, weightKg: entry.weightKg })),
        },
      });
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function saveQuick(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const animal = animals.find((entry) => entry.id === quick.animalId);
    const fieldId = lotById.get(animal?.lotId ?? "")?.fieldId;
    if (!animal || !fieldId) return setMessage("Selecciona un animal del fundo activo.");
    try {
      if (quick.mode === "health") {
        await sendCapture({
          fieldId,
          entity: "livestock_health",
          label: "Evento sanitario",
          file: photo,
          payload: {
            animalId: animal.id,
            eventType: "treatment",
            occurredAt: quick.date,
            status: "completed",
            condition: quick.detail,
            productName: quick.product,
            activeIngredient: null,
            doseAmount: null,
            doseUnit: null,
            route: null,
            withdrawalMilkUntil: null,
            withdrawalMeatUntil: null,
            professional: null,
            notes: "Captura offline en terreno",
          },
        });
      } else if (quick.mode === "estrus") {
        await sendCapture({
          fieldId,
          entity: "livestock_estrus",
          label: "Celo observado",
          file: photo,
          payload: { animalId: animal.id, occurredAt: quick.date, method: "observación visual", result: quick.detail || null, sireIdentifier: null, notes: "Captura offline en terreno" },
        });
      } else {
        await sendCapture({
          fieldId,
          entity: "livestock_movement",
          label: "Movimiento para FMA",
          file: photo,
          payload: { animalIds: [animal.id], occurredAt: quick.date, destinationRup: quick.destinationRup.trim().toUpperCase(), notes: quick.detail, state: "pending_fma" },
        });
      }
      setQuick({ ...quick, detail: "", product: "", destinationRup: "" });
      setPhoto(null);
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function resolveConflict(entry: OfflineMutation, action: "discard" | "retry") {
    try {
      const draft = action === "retry" ? JSON.parse(conflictDrafts[entry.id] ?? "null") as unknown : undefined;
      if (action === "retry" && (!draft || typeof draft !== "object" || Array.isArray(draft))) throw new Error("La corrección debe ser un objeto JSON válido.");
      await resolveOfflineConflict({ scope: offlineScope, id: entry.id, action, payload: draft as Record<string, unknown> | undefined });
      await updateLocalState();
      setMessage(action === "discard" ? "La captura conflictiva fue descartada solo en este dispositivo." : "Se creó una nueva mutación con la corrección indicada.");
    } catch (cause) {
      setMessage(errorMessage(cause));
    }
  }

  async function readFile(file: File | null) {
    if (!file) return;
    const parsed = parseDeviceWeightText(await file.text());
    setRows(parsed);
    setMessage(parsed.length ? `${parsed.length} filas leídas desde ${file.name}.` : "No encontré columnas DIIO/EID y peso válidas.");
  }

  return (
    <div className="space-y-5">
      <div className={`rounded-2xl border p-4 ${online ? "border-line-steel bg-surface-alt" : "border-amber-200 bg-amber-50"}`}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            {online ? <Radio className="text-accent" size={19} /> : <CloudOff className="text-amber-700" size={19} />}
            <div>
              <p className="text-xs font-black">{online ? "Con señal" : "Modo sin señal"}</p>
              <p className="text-[12px] text-ink-muted">{session ? `Sesión local válida hasta ${formatTime(session.expiresAt)}` : "Conéctate para renovar la sesión offline"}</p>
              <p className="text-[12px] text-ink-muted">Pendientes {syncSummary.pending} · Sincronizando {syncSummary.syncing} · Conflictos {syncSummary.conflict} · Errores {syncSummary.error} · Fotos {attachmentSummary.pending}</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="action-secondary" onClick={() => void syncNow()} type="button"><RefreshCw size={14} /> Sincronizar ahora</button>
          </div>
        </div>
        <p className="mt-3 flex items-start gap-2 text-[12px] font-semibold text-ink-muted"><MapPinned className="mt-0.5 shrink-0" size={13} />El mapa base requiere señal y no se descarga. Las capturas y fotos pendientes se conservan localmente aunque el mapa no esté disponible.</p>
        <p className="mt-3 flex items-start gap-2 text-[12px] font-semibold text-ink-muted"><ShieldCheck className="mt-0.5 shrink-0" size={13} />La sesión local no contiene correo, cookie ni JWT de Access. Al reconectar, el servidor vuelve a validar cuenta, organización, rol y fundo en cada captura.</p>
      </div>

      {message && <p className="rounded-xl bg-ink px-4 py-3 text-xs font-bold text-white">{message}</p>}

      <div className="grid gap-5 xl:grid-cols-[1.05fr_0.95fr]">
        <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5">
          <p className="eyebrow">EID y balanza</p>
          <h2 className="mt-1 text-lg font-black">Pesajes sin señal</h2>
          <p className="mt-1 text-xs text-ink-muted">Importa un CSV/TXT del lector. El registro se aplica una sola vez por animal y fecha.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="field-label">Lote<select className="input-base mt-1" onChange={(event) => setLotId(event.target.value)} value={lotId}>{individualLots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}</select></label>
            <label className="field-label">Fecha<input className="input-base mt-1" max={today()} onChange={(event) => setRecordedAt(event.target.value)} type="date" value={recordedAt} /></label>
          </div>
          <label className="mt-3 flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-alt px-4 py-4 text-xs font-black text-ink-muted"><FileSpreadsheet size={17} /> Seleccionar CSV/TXT<input accept=".csv,.txt,text/csv,text/plain" className="sr-only" onChange={(event) => void readFile(event.target.files?.[0] ?? null)} type="file" /></label>
          {rows.length > 0 && (
            <div className="mt-4">
              <div className="flex justify-between text-[12px] font-bold"><span>{matched.length} coincidencias</span><span className={unmatched ? "text-amber-700" : "text-accent"}>{unmatched} sin coincidencia/lote</span></div>
              <TableExplorer
                className="mt-2"
                defaultOpen={false}
                description="Revisa el DIIO, peso leído y validación antes de guardar la importación."
                filter={{ label: "Validación", allLabel: "Todas las validaciones", columnIndex: 2 }}
                id="ganado.terreno.import-preview"
                maxHeight="14rem"
                searchPlaceholder="Buscar DIIO, peso o validación..."
                title="Vista previa de pesajes"
              >
                <table className="w-full min-w-[520px] text-left text-[12px]">
                  <thead className="text-[12px] font-black uppercase tracking-wider text-ink-subtle">
                    <tr><th className="px-3 py-2">DIIO</th><th className="px-3 py-2">Peso</th><th className="px-3 py-2">Validación</th></tr>
                  </thead>
                  <tbody>{rows.map((row) => { const animal = animalsByTag.get(normalizeTag(row.tag)); const valid = animal?.lotId === lotId; return <tr className="border-b border-line-steel" key={`${row.line}:${row.tag}`}><td className="px-3 py-2 font-black">{row.tag}</td><td className="px-3 py-2">{row.weightKg.toLocaleString("es-CL")} kg</td><td className={`px-3 py-2 ${valid ? "text-accent" : "text-amber-700"}`}>{valid ? "Listo" : animal ? "Otro lote" : "No encontrado"}</td></tr>; })}</tbody>
                </table>
              </TableExplorer>
              <button className="mt-3 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white" onClick={() => void saveWeights()} type="button"><CloudUpload size={15} /> Guardar {matched.length} pesajes</button>
            </div>
          )}
        </section>

        <form className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5" onSubmit={(event) => void saveQuick(event)}>
          <p className="eyebrow">Captura rápida offline</p>
          <h2 className="mt-1 text-lg font-black">Sanidad, celo o movimiento</h2>
          <div className="mt-4 space-y-3">
            <label className="field-label">Tipo<select className="input-base mt-1" onChange={(event) => setQuick({ ...quick, mode: event.target.value as QuickMode })} value={quick.mode}><option value="health">Evento sanitario</option><option value="estrus">Celo observado</option><option value="movement">Movimiento para FMA</option></select></label>
            <label className="field-label">Animal<select className="input-base mt-1" onChange={(event) => setQuick({ ...quick, animalId: event.target.value })} required value={quick.animalId}><option value="">Selecciona DIIO</option>{animals.filter((entry) => entry.status === "active" && (quick.mode !== "estrus" || entry.sex === "female")).map((animal) => <option key={animal.id} value={animal.id}>{animal.tag}</option>)}</select></label>
            <label className="field-label">Fecha<input className="input-base mt-1" max={today()} onChange={(event) => setQuick({ ...quick, date: event.target.value })} required type="date" value={quick.date} /></label>
            {quick.mode === "health" && <label className="field-label">Producto<input className="input-base mt-1" onChange={(event) => setQuick({ ...quick, product: event.target.value })} required value={quick.product} /></label>}
            {quick.mode === "movement" && <label className="field-label">RUP destino<input className="input-base mt-1 uppercase" maxLength={32} onChange={(event) => setQuick({ ...quick, destinationRup: event.target.value })} required value={quick.destinationRup} /></label>}
            <label className="field-label">Detalle<textarea className="mt-1 min-h-20 w-full rounded-xl border border-line-steel bg-surface-alt p-3 text-xs" onChange={(event) => setQuick({ ...quick, detail: event.target.value })} required={quick.mode === "health"} value={quick.detail} /></label>
            <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-line-strong bg-surface-alt px-3 text-xs font-black text-ink-muted"><Camera size={15} /> {photo ? photo.name : "Foto opcional (máx. 1,5 MB)"}<input accept="image/jpeg,image/png,image/webp,image/heic" capture="environment" className="sr-only" onChange={(event) => setPhoto(event.target.files?.[0] ?? null)} type="file" /></label>
            <button className="flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ink text-xs font-black text-white disabled:opacity-50" disabled={!session} type="submit"><CloudUpload size={15} /> Guardar ahora o en cola</button>
          </div>
        </form>
      </div>

      {conflicts.length > 0 && <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:p-5"><div className="flex items-center gap-2"><TriangleAlert className="text-amber-700" size={18} /><div><p className="eyebrow">Bandeja de conflictos</p><h2 className="text-lg font-black">Revisa antes de continuar</h2></div></div><div className="mt-4 space-y-3">{conflicts.map((entry) => <article className="rounded-xl border border-amber-200 bg-white p-3" key={entry.id}><p className="text-xs font-black">{entry.label}</p><p className="mt-1 text-[12px] text-amber-800">{entry.statusReason}</p><label className="mt-3 block text-[12px] font-black">Carga corregible<textarea aria-label={`Carga de ${entry.label}`} className="mt-1 min-h-28 w-full rounded-lg border border-line-steel bg-surface-alt p-2 font-mono text-[12px]" onChange={(event) => setConflictDrafts({ ...conflictDrafts, [entry.id]: event.target.value })} value={conflictDrafts[entry.id] ?? ""} /></label><div className="mt-3 flex flex-wrap gap-2"><button className="action-secondary" onClick={() => void resolveConflict(entry, "retry")} type="button">Guardar corrección como nueva</button><button className="rounded-lg px-3 py-2 text-[12px] font-black text-red-700" onClick={() => void resolveConflict(entry, "discard")} type="button">Descartar en este dispositivo</button></div></article>)}</div></section>}

      {recent.length > 0 && <section className="rounded-2xl border border-line-steel bg-white p-4 shadow-sm sm:p-5"><p className="eyebrow">Read-model offline</p><h2 className="mt-1 text-lg font-black">Últimas capturas confirmadas</h2><div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">{recent.slice(0, 9).map((entry) => <div className="rounded-xl bg-surface-alt p-3" key={entry.id}><p className="text-xs font-black">{captureLabel(entry.entity)}</p><p className="mt-1 text-[12px] text-ink-muted">Fundo {entry.fieldId} · {formatDateTime(entry.occurredAt)}</p></div>)}</div></section>}

      <p className="text-[12px] text-ink-muted">{pending} captura{pending === 1 ? "" : "s"} local{pending === 1 ? "" : "es"}. Las fotos se suben después del dato y nunca bloquean su registro. Errores de foto: {attachmentSummary.errors}.</p>
    </div>
  );
}

function readMutationPayload(entry: OfflineMutation): Record<string, unknown> {
  try {
    const body = JSON.parse(entry.body ?? "null") as { mutations?: { payload?: unknown }[] };
    const payload = body.mutations?.[0]?.payload;
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function captureLabel(entity: string) {
  return ({ livestock_weighing: "Pesaje", livestock_health: "Evento sanitario", livestock_estrus: "Celo", livestock_movement: "Movimiento para FMA" } as Record<string, string>)[entity] ?? "Captura";
}

function normalizeTag(value: string) { return value.trim().normalize("NFKC").toLocaleUpperCase("es").replace(/\s/gu, ""); }
function today() { return new Date().toISOString().slice(0, 10); }
function formatTime(value: string) { return new Intl.DateTimeFormat("es-CL", { hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function formatDateTime(value: string) { return new Intl.DateTimeFormat("es-CL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)); }
function errorMessage(cause: unknown) { return cause instanceof Error ? cause.message : "No fue posible guardar la captura."; }
async function apiError(response: Response) { try { const body = await response.clone().json() as { error?: string }; return body.error ?? "La captura fue rechazada."; } catch { return "La captura fue rechazada."; } }
