import React, { useState } from "react";
import type { VisitItemOutcomeInput, WorkVisit } from "../domain/types";
import { validateClinicalGuardrail } from "../domain/visit-rules.mjs";

export type WorkVisitDetailProps = {
  visit: WorkVisit;
  onCloseVisit: (outcomes: VisitItemOutcomeInput[]) => Promise<void>;
  onBack: () => void;
};

export const WorkVisitDetail: React.FC<WorkVisitDetailProps> = ({
  visit,
  onCloseVisit,
  onBack,
}) => {
  const [outcomes, setOutcomes] = useState<Record<string, VisitItemOutcomeInput>>(() => {
    const map: Record<string, VisitItemOutcomeInput> = {};
    visit.items.forEach((item) => {
      map[item.id] = {
        itemId: item.id,
        status: item.status,
        observation: item.observation ?? "",
        outcomeValue: item.outcomeValue ?? "",
      };
    });
    return map;
  });

  const [clinicalError, setClinicalError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleObservationChange = (itemId: string, text: string) => {
    try {
      validateClinicalGuardrail(text);
      setClinicalError(null);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setClinicalError(err.message);
      }
    }

    setOutcomes((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        observation: text,
      },
    }));
  };

  const handleStatusChange = (itemId: string, status: VisitItemOutcomeInput["status"]) => {
    setOutcomes((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        status,
      },
    }));
  };

  const handleValueChange = (itemId: string, value: string) => {
    setOutcomes((prev) => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        outcomeValue: value,
      },
    }));
  };

  const handleSubmitClose = async () => {
    if (clinicalError) return;
    setIsSubmitting(true);
    try {
      const list = Object.values(outcomes);
      await onCloseVisit(list);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setClinicalError(err.message);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const isCompleted = visit.status === "completed";

  return (
    <div className="space-y-6 max-w-4xl mx-auto">
      {/* Header controls (hidden on print) */}
      <div className="flex items-center justify-between border-b border-emerald-900/40 pb-4 print:hidden">
        <button
          onClick={onBack}
          className="text-sm font-medium text-emerald-400 hover:text-emerald-200 transition-colors flex items-center gap-1"
        >
          ← Volver a la lista
        </button>
        <div className="flex items-center gap-3">
          <button
            onClick={() => window.print()}
            className="px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-900/60 hover:bg-emerald-800/80 text-emerald-200 border border-emerald-700/50 transition-colors"
          >
            🖨️ Imprimir hoja de terreno
          </button>
          {!isCompleted && (
            <button
              onClick={handleSubmitClose}
              disabled={isSubmitting || Boolean(clinicalError)}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white transition-colors shadow-md"
            >
              {isSubmitting ? "Cerrando..." : "Cerrar visita y registrar"}
            </button>
          )}
        </div>
      </div>

      {/* Clinical Guardrail Alert */}
      {clinicalError && (
        <div className="p-4 rounded-xl bg-rose-950/80 border border-rose-800 text-rose-200 text-sm print:hidden">
          <strong>Restricción clínica:</strong> {clinicalError}
        </div>
      )}

      {/* Printable Sheet Header */}
      <div className="p-6 rounded-xl bg-emerald-950/40 border border-emerald-800/40 print:border-black print:bg-white print:text-black space-y-4">
        <div className="flex flex-col sm:flex-row justify-between gap-2 border-b border-emerald-900/30 print:border-black pb-3">
          <div>
            <h1 className="text-xl font-bold text-emerald-100 print:text-black">{visit.title}</h1>
            <p className="text-xs text-emerald-400/90 print:text-gray-700 mt-1">
              Profesional: <strong>{visit.professionalName}</strong> · Fecha: <strong>{visit.visitDate}</strong>
            </p>
          </div>
          <div className="text-right">
            <span className="text-xs font-semibold px-2.5 py-1 rounded bg-emerald-900/60 text-emerald-200 border border-emerald-700/40 print:border-gray-400 print:text-black">
              {visit.visitKind === "veterinary" ? "Visita Veterinaria" : "Visita Agronómica"}
            </span>
          </div>
        </div>

        {visit.notes && (
          <p className="text-xs text-emerald-300/80 print:text-gray-800 italic">
            Nota: {visit.notes}
          </p>
        )}

        {/* Item Checklist */}
        <div className="space-y-4 pt-2">
          <h2 className="text-sm font-semibold text-emerald-200 print:text-black uppercase tracking-wider">
            Planilla de terreno ({visit.items.length} ítems)
          </h2>

          <div className="divide-y divide-emerald-900/40 print:divide-gray-300">
            {visit.items.map((item, index) => {
              const currentOutcome = outcomes[item.id] ?? {
                itemId: item.id,
                status: item.status,
                observation: "",
                outcomeValue: "",
              };

              return (
                <div key={item.id} className="py-4 space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-emerald-400/70 print:text-gray-600">
                          #{index + 1}
                        </span>
                        <strong className="text-sm text-emerald-100 print:text-black">
                          {item.targetLabel}
                        </strong>
                        {item.lotName && (
                          <span className="text-xs text-emerald-400/80 print:text-gray-600">
                            ({item.lotName})
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-emerald-300/90 print:text-gray-800 mt-0.5">
                        Motivo: {item.reason}
                      </p>
                      {item.supportMetric && (
                        <p className="text-xs text-emerald-400/70 print:text-gray-600">
                          Métrica soporte: {item.supportMetric}
                        </p>
                      )}
                    </div>

                    {/* Print-only checkbox square */}
                    <div className="hidden print:block border border-black w-6 h-6 rounded flex-shrink-0" />

                    {/* Screen controls */}
                    {!isCompleted && (
                      <div className="flex items-center gap-2 print:hidden">
                        <select
                          value={currentOutcome.status}
                          onChange={(e) =>
                            handleStatusChange(
                              item.id,
                              e.target.value as VisitItemOutcomeInput["status"]
                            )
                          }
                          className="text-xs bg-emerald-950 border border-emerald-700/60 text-emerald-200 rounded px-2 py-1"
                        >
                          <option value="pending">Pendiente</option>
                          <option value="completed">Realizado</option>
                          <option value="skipped">Omitido</option>
                        </select>
                      </div>
                    )}
                  </div>

                  {/* Outcome observation and value inputs */}
                  {!isCompleted ? (
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 print:hidden pt-1">
                      <div className="sm:col-span-2">
                        <input
                          type="text"
                          placeholder="Observaciones de terreno (ej. en celo, buena condición)"
                          value={currentOutcome.observation ?? ""}
                          onChange={(e) => handleObservationChange(item.id, e.target.value)}
                          className="w-full text-xs bg-emerald-950/80 border border-emerald-800 text-emerald-100 rounded px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
                        />
                      </div>
                      <div>
                        <input
                          type="text"
                          placeholder="Valor (ej. 1850 kg MS)"
                          value={currentOutcome.outcomeValue ?? ""}
                          onChange={(e) => handleValueChange(item.id, e.target.value)}
                          className="w-full text-xs bg-emerald-950/80 border border-emerald-800 text-emerald-100 rounded px-2.5 py-1.5 focus:border-emerald-500 focus:outline-none"
                        />
                      </div>
                    </div>
                  ) : (
                    (item.observation || item.outcomeValue) && (
                      <div className="text-xs text-emerald-300/90 print:text-gray-900 bg-emerald-950/50 print:bg-gray-100 p-2 rounded">
                        {item.observation && <span>Observación: {item.observation} </span>}
                        {item.outcomeValue && (
                          <span className="font-semibold">· Valor: {item.outcomeValue}</span>
                        )}
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};
