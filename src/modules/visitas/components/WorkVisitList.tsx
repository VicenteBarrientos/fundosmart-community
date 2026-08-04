import React from "react";
import type { WorkVisit } from "../domain/types";

export type WorkVisitListProps = {
  visits: WorkVisit[];
  onSelectVisit: (visitId: string) => void;
  onCreateVisit?: () => void;
};

export const WorkVisitList: React.FC<WorkVisitListProps> = ({
  visits,
  onSelectVisit,
  onCreateVisit,
}) => {
  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-emerald-900/30 pb-4">
        <div>
          <h2 className="text-xl font-bold text-emerald-100">Visitas de trabajo</h2>
          <p className="text-sm text-emerald-400/80">
            Planificación y registro de visitas veterinarias y agronómicas
          </p>
        </div>
        {onCreateVisit && (
          <button
            onClick={onCreateVisit}
            className="inline-flex items-center justify-center px-4 py-2 text-sm font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white transition-colors shadow-lg shadow-emerald-950/40"
          >
            + Preparar nueva visita
          </button>
        )}
      </div>

      {visits.length === 0 ? (
        <div className="p-8 text-center rounded-xl bg-emerald-950/30 border border-emerald-800/40 text-emerald-300">
          <p className="font-medium">No hay visitas programadas o registradas.</p>
          <p className="text-xs text-emerald-400/70 mt-1">
            Prepara una nueva visita seleccionando ítems de la agenda o del listado de rebaño.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visits.map((visit) => {
            const completedCount = visit.items.filter((i) => i.status === "completed").length;
            const totalItems = visit.items.length;
            const isCompleted = visit.status === "completed";

            return (
              <div
                key={visit.id}
                onClick={() => onSelectVisit(visit.id)}
                className="group cursor-pointer rounded-xl bg-emerald-950/40 hover:bg-emerald-900/30 border border-emerald-800/40 hover:border-emerald-600/50 p-5 transition-all shadow-md flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span
                      className={`text-xs font-semibold px-2.5 py-0.5 rounded-full border ${
                        visit.visitKind === "veterinary"
                          ? "bg-sky-950/60 border-sky-700/50 text-sky-300"
                          : "bg-amber-950/60 border-amber-700/50 text-amber-300"
                      }`}
                    >
                      {visit.visitKind === "veterinary" ? "Veterinaria" : "Agronómica"}
                    </span>
                    <span
                      className={`text-xs font-medium px-2 py-0.5 rounded ${
                        isCompleted
                          ? "bg-emerald-900/50 text-emerald-300"
                          : "bg-emerald-950/80 text-emerald-400"
                      }`}
                    >
                      {isCompleted ? "Completada" : visit.status === "in_progress" ? "En terreno" : "Planificada"}
                    </span>
                  </div>

                  <h3 className="text-base font-semibold text-emerald-100 group-hover:text-white transition-colors line-clamp-1">
                    {visit.title}
                  </h3>
                  <p className="text-xs text-emerald-400/80 mt-1">
                    {visit.professionalName} · {visit.visitDate}
                  </p>
                </div>

                <div className="mt-4 pt-3 border-t border-emerald-900/40 flex items-center justify-between text-xs text-emerald-400/90">
                  <span>
                    Ítems: <strong className="text-emerald-200">{completedCount}/{totalItems}</strong>
                  </span>
                  <span className="text-emerald-500 font-medium group-hover:translate-x-0.5 transition-transform">
                    Ver detalle →
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
