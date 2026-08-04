"use client";

import React, { useState } from "react";
import { Download, FileCode, FileText, Printer, X } from "lucide-react";
import type { Fundo, Potrero } from "../../types";

export type ExportFormat = "geojson" | "kml" | "print-a4";

export type MapExportDialogProps = {
  isOpen: boolean;
  fundo: Fundo | null;
  paddocks: readonly Potrero[];
  onClose: () => void;
  onExport: (format: ExportFormat, selectedPaddockIds: string[]) => void;
  className?: string;
};

export function MapExportDialog({
  isOpen,
  fundo,
  paddocks,
  onClose,
  onExport,
  className = "",
}: MapExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("geojson");
  const [selectedPaddockIds, setSelectedPaddockIds] = useState<string[]>(
    paddocks.map((p) => p.id),
  );

  if (!isOpen || !fundo) return null;

  const toggleSelectAll = () => {
    if (selectedPaddockIds.length === paddocks.length) {
      setSelectedPaddockIds([]);
    } else {
      setSelectedPaddockIds(paddocks.map((p) => p.id));
    }
  };

  const toggleSelectPaddock = (id: string) => {
    if (selectedPaddockIds.includes(id)) {
      setSelectedPaddockIds(selectedPaddockIds.filter((pId) => pId !== id));
    } else {
      setSelectedPaddockIds([...selectedPaddockIds, id]);
    }
  };

  const handleConfirmExport = () => {
    onExport(format, selectedPaddockIds);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[2300] grid place-items-center bg-slate-950/75 backdrop-blur-sm p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-dialog-title"
    >
      <div
        className={`w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-100 ${className}`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4 bg-slate-950/50">
          <div className="flex items-center gap-2">
            <Download className="w-5 h-5 text-emerald-400" />
            <div>
              <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">
                Exportar Datos Geográficos
              </span>
              <h3 id="export-dialog-title" className="text-base font-bold text-white">
                {fundo.name}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800"
            aria-label="Cerrar diálogo de exportación"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4 text-xs">
          {/* Format Selector */}
          <div>
            <span className="block text-slate-300 font-semibold mb-2">Formato de Exportación</span>
            <div className="grid grid-cols-3 gap-2">
              <button
                type="button"
                onClick={() => setFormat("geojson")}
                className={`p-3 rounded-xl border text-left flex flex-col items-center justify-center gap-1.5 transition-all ${
                  format === "geojson"
                    ? "bg-emerald-950/40 border-emerald-500 text-white font-bold"
                    : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                }`}
              >
                <FileCode className="w-5 h-5 text-emerald-400" />
                <span>GeoJSON</span>
              </button>

              <button
                type="button"
                onClick={() => setFormat("kml")}
                className={`p-3 rounded-xl border text-left flex flex-col items-center justify-center gap-1.5 transition-all ${
                  format === "kml"
                    ? "bg-emerald-950/40 border-emerald-500 text-white font-bold"
                    : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                }`}
              >
                <FileText className="w-5 h-5 text-blue-400" />
                <span>KML</span>
              </button>

              <button
                type="button"
                onClick={() => setFormat("print-a4")}
                className={`p-3 rounded-xl border text-left flex flex-col items-center justify-center gap-1.5 transition-all ${
                  format === "print-a4"
                    ? "bg-emerald-950/40 border-emerald-500 text-white font-bold"
                    : "bg-slate-950/60 border-slate-800 text-slate-400 hover:border-slate-700"
                }`}
              >
                <Printer className="w-5 h-5 text-amber-400" />
                <span>Plano A4</span>
              </button>
            </div>
          </div>

          {/* Paddock Selection */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-300">
                Potreros a exportar ({selectedPaddockIds.length}/{paddocks.length})
              </span>
              <button
                type="button"
                onClick={toggleSelectAll}
                className="text-emerald-400 hover:underline text-[11px]"
              >
                {selectedPaddockIds.length === paddocks.length ? "Desmarcar todos" : "Marcar todos"}
              </button>
            </div>

            <div className="max-h-40 overflow-y-auto space-y-1 bg-slate-950/60 p-2 rounded-xl border border-slate-800">
              {paddocks.map((paddock) => {
                const isSelected = selectedPaddockIds.includes(paddock.id);
                return (
                  <button
                    type="button"
                    key={paddock.id}
                    onClick={() => toggleSelectPaddock(paddock.id)}
                    className={`w-full flex items-center justify-between p-2 rounded-lg text-left transition-colors ${
                      isSelected ? "bg-slate-800 text-white" : "text-slate-400 hover:bg-slate-800/50"
                    }`}
                  >
                    <span>{paddock.name}</span>
                    <span className="text-[11px] font-mono text-slate-400">
                      {(paddock.areaHectares || 0).toFixed(1)} ha
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-800 px-5 py-3 bg-slate-950/50">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-slate-400 hover:text-white text-xs"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={handleConfirmExport}
            disabled={selectedPaddockIds.length === 0}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium text-xs px-4 py-2 rounded-lg shadow transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>Descargar {format.toUpperCase()}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
