"use client";

import type { LivestockAnimal, LivestockLot, LivestockWeighing } from "@/src/core/domain/types";
import {
  SpreadsheetGrid,
  type SpreadsheetGridColumn,
  type SpreadsheetGridRow,
} from "@/src/ui/SpreadsheetGrid";
import { CalendarDays, Check, ChevronDown, LoaderCircle, Redo2, Scale, Sheet, Trash2, TrendingUp, Undo2, Weight } from "lucide-react";
import { useCallback, useMemo, useState, type FormEvent } from "react";
import type { WeighingSessionInput } from "../api/livestock-client";
import {
  formatSpreadsheetNumber,
  parseSpreadsheetNumber,
} from "../domain/animal-spreadsheet.mjs";
import { formatDate, formatInteger, formatKg, formatNumber, todayISO } from "../lib/format";
import { TruTestCsvImport } from "./TruTestCsvImport";
import { ErrorMessage, Field, Panel, SmallEmpty, StatCard } from "./ui";

type PesajesSectionProps = {
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  weighings: LivestockWeighing[];
  onSaveSession: (session: WeighingSessionInput) => Promise<void>;
  onDeleteWeighing: (id: string, snapshotToken: string) => Promise<void>;
};

type SessionGroup = {
  key: string;
  recordedAt: string;
  lotId: string;
  lotName: string;
  entries: { weighing: LivestockWeighing; tag: string }[];
  averageKg: number;
  dailyGainKg: number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export function PesajesSection({ animals, lots, weighings, onSaveSession, onDeleteWeighing }: PesajesSectionProps) {
  const [selectedLotId, setSelectedLotId] = useState("");
  const [recordedAt, setRecordedAt] = useState(todayISO());
  const [notes, setNotes] = useState("");
  const [weights, setWeights] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sheetMode, setSheetMode] = useState(false);
  const [history, setHistory] = useState<Record<string, string>[]>([]);
  const [future, setFuture] = useState<Record<string, string>[]>([]);

  const animalById = useMemo(() => new Map(animals.map((animal) => [animal.id, animal])), [animals]);
  const lotById = useMemo(() => new Map(lots.map((lot) => [lot.id, lot])), [lots]);
  const lotsWithAnimals = useMemo(() => {
    const counts = new Map<string, number>();
    for (const animal of animals) {
      if (animal.status !== "active") continue;
      counts.set(animal.lotId, (counts.get(animal.lotId) ?? 0) + 1);
    }
    return lots.filter((lot) => (counts.get(lot.id) ?? 0) > 0);
  }, [animals, lots]);

  const sessionAnimals = useMemo(
    () => animals
      .filter((animal) => animal.lotId === selectedLotId && animal.status === "active")
      .sort((a, b) => a.tag.localeCompare(b.tag, "es", { numeric: true })),
    [animals, selectedLotId],
  );

  const sessions = useMemo(() => buildSessions(weighings, animalById, lotById), [animalById, lotById, weighings]);
  const weighingByAnimalDate = useMemo(
    () => new Map(weighings.map((weighing) => [`${weighing.animalId}|${weighing.recordedAt}`, weighing])),
    [weighings],
  );

  const totalWeighings = weighings.length;
  const lastSession = sessions[0] ?? null;
  const gainSessions = sessions.filter((session) => session.dailyGainKg !== null);
  const averageGain = gainSessions.length
    ? gainSessions.reduce((sum, session) => sum + (session.dailyGainKg ?? 0), 0) / gainSessions.length
    : null;

  const enteredCount = sessionAnimals.filter((animal) => weights[animal.id]?.trim()).length;

  const sheetColumns = useMemo<SpreadsheetGridColumn[]>(() => [
    { key: "tag", label: "DIIO", readOnly: true, width: "9rem" },
    { key: "previous", label: "Último peso", readOnly: true, align: "right", width: "10rem" },
    { align: "right", key: "weight", label: "Peso (kg)", width: "8rem" },
  ], []);

  const sheetRows = useMemo<SpreadsheetGridRow[]>(() => sessionAnimals.map((animal) => ({
    cells: {
      previous: animal.latestWeightKg !== null
        ? `${formatSpreadsheetNumber(animal.latestWeightKg, 1)} · ${formatDate(animal.latestWeightDate)}`
        : "sin pesaje previo",
      tag: animal.tag,
      weight: weights[animal.id] ?? "",
    },
    id: animal.id,
    label: animal.tag,
  })), [sessionAnimals, weights]);

  // Cada celda mal escrita se marca sin sacar lo tipeado, igual que en la planilla de animales.
  const sheetErrors = useMemo(() => {
    const map: Record<string, string> = {};
    for (const animal of sessionAnimals) {
      const raw = weights[animal.id]?.trim();
      if (!raw) continue;
      const { value, error: invalid } = parseSpreadsheetNumber(raw);
      if (invalid) map[`${animal.id} weight`] = invalid;
      else if (value === null || value <= 0) map[`${animal.id} weight`] = "El peso debe ser mayor que cero.";
      else if (value > 2000) map[`${animal.id} weight`] = "Un peso sobre 2.000 kg parece un error de tipeo.";
    }
    return map;
  }, [sessionAnimals, weights]);

  const applySheetEdits = useCallback((edits: { key: string; rowId: string; value: string }[]) => {
    if (edits.length === 0) return;
    setWeights((current) => {
      setHistory((stack) => [...stack, current].slice(-100));
      setFuture([]);
      const next = { ...current };
      for (const edit of edits) {
        if (edit.key !== "weight") continue;
        next[edit.rowId] = edit.value;
      }
      return next;
    });
    setError(null);
  }, []);

  const undoSheet = useCallback(() => {
    setHistory((stack) => {
      if (stack.length === 0) return stack;
      setWeights((current) => {
        setFuture((forward) => [current, ...forward].slice(0, 100));
        return stack[stack.length - 1];
      });
      return stack.slice(0, -1);
    });
  }, []);

  const redoSheet = useCallback(() => {
    setFuture((stack) => {
      if (stack.length === 0) return stack;
      setWeights((current) => {
        setHistory((back) => [...back, current].slice(-100));
        return stack[0];
      });
      return stack.slice(1);
    });
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFeedback(null);
    if (!selectedLotId) {
      setError("Selecciona el lote que vas a pesar.");
      return;
    }
    const entries: WeighingSessionInput["entries"] = [];
    for (const animal of sessionAnimals) {
      const raw = weights[animal.id]?.trim();
      if (!raw) continue;
      // Mismo lector que la planilla: un peso pegado desde Excel se interpreta igual
      // escrito a mano que pegado, con la coma decimal chilena.
      const { value, error: invalid } = parseSpreadsheetNumber(raw);
      if (invalid || value === null || value <= 0) {
        setError(`El peso del animal ${animal.tag} no es válido.`);
        return;
      }
      if (value > 2000) {
        setError(`El peso del animal ${animal.tag} supera los 2.000 kg: parece un error de tipeo.`);
        return;
      }
      const current = weighingByAnimalDate.get(`${animal.id}|${recordedAt}`);
      if (current && !current.snapshotToken) {
        setError("Actualiza los pesajes antes de guardar.");
        return;
      }
      entries.push({
        animalId: animal.id,
        weightKg: Math.round(value * 10) / 10,
        snapshotToken: current?.snapshotToken ?? null,
      });
    }
    if (entries.length === 0) {
      setError("Ingresa al menos un peso para guardar la sesión.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSaveSession({ lotId: selectedLotId, recordedAt, notes: notes.trim(), entries });
      setWeights({});
      setNotes("");
      setFeedback(`Sesión guardada: ${entries.length} ${entries.length === 1 ? "animal pesado" : "animales pesados"}.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible registrar la sesión.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteWeighing(weighing: LivestockWeighing) {
    if (!weighing.snapshotToken) {
      setError("Actualiza los pesajes antes de eliminar.");
      return;
    }
    setDeletingId(weighing.id);
    setError(null);
    try {
      await onDeleteWeighing(weighing.id, weighing.snapshotToken);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "No fue posible eliminar el pesaje.");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div>
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard helpText="Total de pesos anotados. Cada pesaje es una foto del animal en una fecha; con dos fotos se calcula cuánto subió." icon={Scale} label="Pesajes registrados" tone="dark" value={formatInteger(totalWeighings)} detail={`${formatInteger(sessions.length)} ${sessions.length === 1 ? "sesión" : "sesiones"}`} />
        <StatCard helpText="Cuándo se pesó por última vez. Si pasó mucho tiempo, los pesos que ves ya no reflejan el estado actual." icon={CalendarDays} label="Última sesión" value={lastSession ? formatDate(lastSession.recordedAt) : "Sin sesiones"} detail={lastSession ? `${lastSession.lotName} · ${formatInteger(lastSession.entries.length)} animales` : "Registra la primera"} />
        <StatCard helpText="Peso promedio de los animales de la última sesión, para comparar contra el peso objetivo de la categoría." icon={Weight} label="Promedio última sesión" value={lastSession ? formatKg(lastSession.averageKg) : "—"} detail="Peso promedio de los animales pesados" />
        <StatCard help="analiticaGananciaDiaria" icon={TrendingUp} label="Ganancia diaria" tone="amber" value={averageGain !== null ? `${formatNumber(averageGain, 2)} kg/día` : "—"} detail="Promedio entre sesiones comparables" />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Panel title="Nueva sesión de pesaje" eyebrow="Registro" helpText="Anota de una vez los pesos de todo un lote en una fecha. Así los animales quedan comparables entre sí." icon={Scale}>
          <form className="mt-5" onSubmit={submit}>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Lote a pesar">
                <select
                  className="input-base"
                  onChange={(event) => {
                    setSelectedLotId(event.target.value);
                    setWeights({});
                    setError(null);
                    setFeedback(null);
                  }}
                  value={selectedLotId}
                >
                  <option value="">Selecciona un lote</option>
                  {lotsWithAnimals.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}
                </select>
              </Field>
              <Field label="Fecha de la sesión">
                <input className="input-base" onChange={(event) => setRecordedAt(event.target.value)} required type="date" value={recordedAt} />
              </Field>
            </div>

            <div className="mt-4">
              <Field label="Notas de la sesión">
                <input className="input-base" onChange={(event) => setNotes(event.target.value)} placeholder="Opcional. Ej. pesaje mensual" value={notes} />
              </Field>
            </div>

            <TruTestCsvImport
              animals={sessionAnimals}
              disabled={!selectedLotId || saving}
              key={selectedLotId || "sin-lote"}
              onApply={(proposal) => {
                setWeights((current) => ({ ...current, ...proposal.weights }));
                if (proposal.recordedAt) setRecordedAt(proposal.recordedAt);
                setNotes((current) => current.trim() || `Importado desde Tru-Test · ${proposal.fileName}`);
                setError(null);
                setFeedback(`Tru-Test: ${proposal.matchedCount} pesos precargados. Revísalos antes de guardar.`);
              }}
            />

            {selectedLotId && sessionAnimals.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  className={`flex h-9 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-black ${sheetMode ? "border-accent bg-band text-accent" : "border-line-steel text-ink"}`}
                  onClick={() => setSheetMode((current) => !current)}
                  type="button"
                >
                  <Sheet size={14} /> {sheetMode ? "Volver a la lista" : "Editar en planilla"}
                </button>
                {sheetMode && (
                  <>
                    <button
                      className="flex h-9 items-center gap-1.5 rounded-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
                      disabled={history.length === 0}
                      onClick={undoSheet}
                      type="button"
                    >
                      <Undo2 size={14} /> Deshacer
                    </button>
                    <button
                      className="flex h-9 items-center gap-1.5 rounded-lg border border-line-steel px-2.5 text-[12px] font-black text-ink-muted disabled:opacity-40"
                      disabled={future.length === 0}
                      onClick={redoSheet}
                      type="button"
                    >
                      <Redo2 size={14} /> Rehacer
                    </button>
                    <span className="text-[12px] font-semibold text-ink-subtle">
                      Ctrl+V pega la columna desde Excel · Ctrl+D la rellena hacia abajo
                    </span>
                  </>
                )}
              </div>
            )}

            {selectedLotId ? (
              sessionAnimals.length > 0 ? (
                sheetMode ? (
                  <div className="mt-3">
                    <SpreadsheetGrid
                      ariaLabel={`Planilla de pesaje del lote ${lotById.get(selectedLotId)?.name ?? ""}`}
                      canRedo={future.length > 0}
                      canUndo={history.length > 0}
                      cellErrors={sheetErrors}
                      columns={sheetColumns}
                      maxHeight="26rem"
                      onEdit={applySheetEdits}
                      onRedo={redoSheet}
                      onUndo={undoSheet}
                      rows={sheetRows}
                    />
                  </div>
                ) : (
                <div className="mt-4 max-h-[420px] overflow-y-auto rounded-2xl border border-line-steel">
                  {sessionAnimals.map((animal) => (
                    <div className="flex items-center gap-3 border-b border-line-steel px-4 py-2.5 last:border-b-0" key={animal.id}>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-black text-ink">{animal.tag}</p>
                        <p className="text-[12px] font-semibold text-ink-subtle">
                          {animal.latestWeightKg !== null ? `Último: ${formatKg(animal.latestWeightKg)} · ${formatDate(animal.latestWeightDate)}` : "Sin pesaje previo"}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <input
                          aria-label={`Peso de ${animal.tag} en kilos`}
                          className="input-base h-10 w-24 text-right"
                          inputMode="decimal"
                          min="0"
                          onChange={(event) => setWeights((current) => ({ ...current, [animal.id]: event.target.value }))}
                          placeholder="kg"
                          step="0.1"
                          type="number"
                          value={weights[animal.id] ?? ""}
                        />
                        <span className="text-[12px] font-black text-ink-subtle">kg</span>
                      </div>
                    </div>
                  ))}
                </div>
                )
              ) : (
                <SmallEmpty text="El lote no tiene animales activos registrados individualmente." />
              )
            ) : (
              <SmallEmpty text="Elige un lote para listar sus animales y anotar los kilos." />
            )}

            {error && <ErrorMessage text={error} />}
            {feedback && <p className="mt-3 rounded-xl bg-band px-3 py-2 text-xs font-bold text-accent">{feedback}</p>}

            <button className="mt-4 flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-accent text-xs font-black text-white disabled:opacity-60" disabled={saving || !selectedLotId} type="submit">
              {saving
                ? <><LoaderCircle className="animate-spin" size={15} /> Guardando sesión</>
                : <><Check size={15} /> Guardar sesión{enteredCount > 0 ? ` (${enteredCount} ${enteredCount === 1 ? "peso" : "pesos"})` : ""}</>}
            </button>
          </form>
        </Panel>

        <Panel title="Historial de sesiones" eyebrow="Evolución" helpText="Todas las sesiones anteriores, para seguir si el lote viene subiendo o se estancó." icon={CalendarDays}>
          {sessions.length > 0 ? (
            <div className="mt-5 space-y-3">
              {sessions.map((session) => {
                const expanded = expandedKey === session.key;
                return (
                  <article className="rounded-2xl border border-line-steel bg-surface-alt" key={session.key}>
                    <button
                      className="flex w-full items-center gap-3 px-4 py-3 text-left"
                      onClick={() => setExpandedKey(expanded ? null : session.key)}
                      type="button"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-xs font-black text-ink">{formatDate(session.recordedAt)} · {session.lotName}</p>
                        <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
                          {formatInteger(session.entries.length)} {session.entries.length === 1 ? "animal" : "animales"} · promedio {formatKg(session.averageKg)}
                          {session.dailyGainKg !== null && ` · ${session.dailyGainKg >= 0 ? "+" : ""}${formatNumber(session.dailyGainKg, 2)} kg/día`}
                        </p>
                      </div>
                      <ChevronDown className={`shrink-0 text-ink-subtle transition ${expanded ? "rotate-180" : ""}`} size={16} />
                    </button>
                    {expanded && (
                      <div className="border-t border-line-steel px-4 py-2">
                        {session.entries.map(({ weighing, tag }) => (
                          <div className="flex items-center gap-3 border-b border-line-steel py-2 last:border-b-0" key={weighing.id}>
                            <p className="min-w-0 flex-1 truncate text-xs font-bold text-ink">{tag}</p>
                            <p className="text-xs font-black text-ink">{formatKg(weighing.weightKg)}</p>
                            <button
                              aria-label={`Eliminar pesaje de ${tag}`}
                              className="grid size-8 place-items-center rounded-lg border border-red-100 text-red-700 disabled:opacity-50"
                              disabled={deletingId === weighing.id}
                              onClick={() => deleteWeighing(weighing)}
                              type="button"
                            >
                              {deletingId === weighing.id ? <LoaderCircle className="animate-spin" size={13} /> : <Trash2 size={13} />}
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <SmallEmpty text="Aún no hay pesajes. Registra la primera sesión para ver la evolución." />
          )}
        </Panel>
      </section>
    </div>
  );
}

function buildSessions(
  weighings: LivestockWeighing[],
  animalById: Map<string, LivestockAnimal>,
  lotById: Map<string, LivestockLot>,
): SessionGroup[] {
  const groups = new Map<string, { recordedAt: string; lotId: string; entries: { weighing: LivestockWeighing; tag: string }[] }>();
  for (const weighing of weighings) {
    const animal = animalById.get(weighing.animalId);
    if (!animal) continue;
    const historicalLotId = weighing.lotId ?? animal.lotId;
    const key = `${weighing.recordedAt}|${historicalLotId}`;
    const group = groups.get(key) ?? { recordedAt: weighing.recordedAt, lotId: historicalLotId, entries: [] };
    group.entries.push({ weighing, tag: animal.tag });
    groups.set(key, group);
  }

  const perAnimalHistory = new Map<string, LivestockWeighing[]>();
  for (const weighing of weighings) {
    const history = perAnimalHistory.get(weighing.animalId) ?? [];
    history.push(weighing);
    perAnimalHistory.set(weighing.animalId, history);
  }
  for (const history of perAnimalHistory.values()) {
    history.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  }

  return [...groups.entries()]
    .map(([key, group]) => {
      const averageKg = group.entries.reduce((sum, entry) => sum + entry.weighing.weightKg, 0) / group.entries.length;
      const gains: number[] = [];
      for (const entry of group.entries) {
        const history = perAnimalHistory.get(entry.weighing.animalId) ?? [];
        const index = history.findIndex((item) => item.id === entry.weighing.id);
        if (index <= 0) continue;
        const previous = history[index - 1];
        const days = (new Date(`${entry.weighing.recordedAt}T12:00:00`).getTime() - new Date(`${previous.recordedAt}T12:00:00`).getTime()) / DAY_MS;
        if (days <= 0) continue;
        gains.push((entry.weighing.weightKg - previous.weightKg) / days);
      }
      return {
        key,
        recordedAt: group.recordedAt,
        lotId: group.lotId,
        lotName: lotById.get(group.lotId)?.name ?? "Lote",
        entries: group.entries.sort((a, b) => a.tag.localeCompare(b.tag, "es", { numeric: true })),
        averageKg,
        dailyGainKg: gains.length ? gains.reduce((sum, gain) => sum + gain, 0) / gains.length : null,
      };
    })
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt) || a.lotName.localeCompare(b.lotName, "es"));
}
