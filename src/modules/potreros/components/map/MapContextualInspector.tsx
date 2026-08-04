"use client";

import React, { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Layers,
  MapPin,
  MoveRight,
  PlusCircle,
  Sprout,
  X,
} from "lucide-react";
import type { Potrero } from "../../types";

export type MapContextualInspectorProps = {
  selectedPaddock: Potrero | null;
  totalPaddocksCount: number;
  totalHectares: number;
  onClose?: () => void;
  onMoveLot?: (paddock: Potrero) => void;
  onRegisterManagement?: (paddock: Potrero) => void;
  onCreateTask?: (paddock: Potrero) => void;
  className?: string;
};

export function MapContextualInspector({
  selectedPaddock,
  totalPaddocksCount,
  totalHectares,
  onClose,
  onMoveLot,
  onRegisterManagement,
  onCreateTask,
  className = "",
}: MapContextualInspectorProps) {
  const [isExpandedMobile, setIsExpandedMobile] = useState(false);

  return (
    <aside
      className={`fixed bottom-0 inset-x-0 sm:bottom-auto sm:inset-x-auto sm:top-20 sm:right-4 sm:w-80 md:w-96 bg-slate-900/95 backdrop-blur-md text-slate-100 border border-slate-800 rounded-t-xl sm:rounded-xl shadow-2xl z-30 transition-all duration-200 ${
        isExpandedMobile ? "h-[65vh] sm:h-auto" : "h-auto"
      } ${className}`}
      aria-label="Panel de inspección contextual de potrero"
    >
      {/* Mobile Handle & Toggle */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-800 sm:hidden">
        <button
          type="button"
          onClick={() => setIsExpandedMobile(!isExpandedMobile)}
          className="flex items-center gap-1.5 text-xs text-slate-400 font-medium hover:text-slate-200"
          aria-expanded={isExpandedMobile}
        >
          {isExpandedMobile ? (
            <>
              <ChevronDown className="w-4 h-4" />
              <span>Colapsar panel</span>
            </>
          ) : (
            <>
              <ChevronUp className="w-4 h-4" />
              <span>Expandir detalles</span>
            </>
          )}
        </button>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-200"
            aria-label="Cerrar panel de inspección"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Content Container */}
      <div className="p-4 space-y-4 max-h-[calc(65vh-40px)] sm:max-h-none overflow-y-auto">
        {selectedPaddock ? (
          <>
            {/* Header: Paddock Name and Close Button (Desktop) */}
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="flex items-center gap-1.5 text-emerald-400 text-xs font-semibold uppercase tracking-wider">
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Potrero Seleccionado</span>
                </div>
                <h3 className="text-lg font-bold text-white mt-0.5">
                  {selectedPaddock.name}
                </h3>
              </div>
              {onClose && (
                <button
                  type="button"
                  onClick={onClose}
                  className="hidden sm:block p-1 text-slate-400 hover:text-white rounded hover:bg-slate-800 transition-colors"
                  aria-label="Cerrar inspección"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Quick Metrics Grid */}
            <div className="grid grid-cols-2 gap-2 bg-slate-950/60 p-3 rounded-lg border border-slate-800/80 text-xs">
              <div>
                <span className="text-slate-400 block">Superficie útil</span>
                <span className="text-sm font-semibold text-slate-100">
                  {(selectedPaddock.areaHectares || 0).toFixed(2)} ha
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Lote actual</span>
                <span className="text-sm font-semibold text-emerald-300">
                  {selectedPaddock.status || "Sin asignar"}
                </span>
              </div>
            </div>

            {/* Operational Action Buttons (Max 3 primary actions) */}
            <div className="space-y-2 pt-1">
              <span className="text-xs font-medium text-slate-400 block">
                Acciones Operacionales
              </span>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <button
                  type="button"
                  onClick={() => onMoveLot?.(selectedPaddock)}
                  className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 px-2 rounded-md font-medium transition-colors border border-slate-700/50"
                >
                  <MoveRight className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Mover lote</span>
                </button>

                <button
                  type="button"
                  onClick={() => onRegisterManagement?.(selectedPaddock)}
                  className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 px-2 rounded-md font-medium transition-colors border border-slate-700/50"
                >
                  <Sprout className="w-3.5 h-3.5 text-amber-400" />
                  <span>Manejo</span>
                </button>

                <button
                  type="button"
                  onClick={() => onCreateTask?.(selectedPaddock)}
                  className="flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 py-2 px-2 rounded-md font-medium transition-colors border border-slate-700/50"
                >
                  <PlusCircle className="w-3.5 h-3.5 text-blue-400" />
                  <span>Crear tarea</span>
                </button>
              </div>
            </div>
          </>
        ) : (
          /* General Farm Overview when no paddock is selected */
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-slate-300 font-semibold text-sm">
                <Layers className="w-4 h-4 text-emerald-400" />
                <span>Resumen del Fundo</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 bg-slate-950/60 p-3 rounded-lg border border-slate-800 text-xs">
              <div>
                <span className="text-slate-400 block">Total Potreros</span>
                <span className="text-base font-bold text-white">
                  {totalPaddocksCount}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Superficie Total</span>
                <span className="text-base font-bold text-emerald-400">
                  {totalHectares.toFixed(1)} ha
                </span>
              </div>
            </div>

            <p className="text-xs text-slate-400">
              Selecciona un potrero en el mapa para ver sus detalles y ejecutar acciones operacionales.
            </p>
          </div>
        )}
      </div>
    </aside>
  );
}
