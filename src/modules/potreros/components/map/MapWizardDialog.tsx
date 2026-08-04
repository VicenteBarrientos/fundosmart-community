"use client";

import React, { useState } from "react";
import {
  Check,
  ChevronRight,
  ChevronLeft,
  Compass,
  FileSpreadsheet,
  Pencil,
  Sparkles,
  X,
} from "lucide-react";

export type MapWizardStep = "locate" | "boundary" | "first-paddock" | "review";

export type MapWizardData = {
  fundoName: string;
  sector: string;
  locationQuery: string;
  boundaryRoute: "import" | "draw" | "gps";
  paddockRoute: "draw" | "import" | "suggested";
  firstPaddockName: string;
};

export type MapWizardDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  onComplete: (data: MapWizardData) => void;
  className?: string;
};

export function MapWizardDialog({
  isOpen,
  onClose,
  onComplete,
  className = "",
}: MapWizardDialogProps) {
  const [step, setStep] = useState<MapWizardStep>("locate");
  const [formData, setFormData] = useState<MapWizardData>({
    fundoName: "",
    sector: "Central",
    locationQuery: "",
    boundaryRoute: "draw",
    paddockRoute: "draw",
    firstPaddockName: "Potrero 1",
  });
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const updateForm = (key: keyof MapWizardData, value: string) => {
    setFormData((prev) => ({ ...prev, [key]: value }));
  };

  const handleNext = () => {
    setError(null);
    if (step === "locate") {
      if (!formData.fundoName.trim()) {
        setError("Ingresa el nombre del fundo.");
        return;
      }
      setStep("boundary");
    } else if (step === "boundary") {
      setStep("first-paddock");
    } else if (step === "first-paddock") {
      if (!formData.firstPaddockName.trim()) {
        setError("Ingresa el nombre del primer potrero.");
        return;
      }
      setStep("review");
    } else if (step === "review") {
      onComplete(formData);
      onClose();
    }
  };

  const handleBack = () => {
    setError(null);
    if (step === "boundary") setStep("locate");
    if (step === "first-paddock") setStep("boundary");
    if (step === "review") setStep("first-paddock");
  };

  return (
    <div
      className="fixed inset-0 z-[2300] grid place-items-center bg-slate-950/75 backdrop-blur-sm p-4 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="wizard-title"
    >
      <div
        className={`w-full max-w-xl bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden text-slate-100 ${className}`}
      >
        {/* Wizard Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-950/50">
          <div className="flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-emerald-400" />
            <div>
              <span className="text-[11px] font-bold text-emerald-400 uppercase tracking-wider block">
                Asistente del Primer Mapa
              </span>
              <h3 id="wizard-title" className="text-lg font-bold text-white">
                {step === "locate" && "1. Ubicación y Nombre del Fundo"}
                {step === "boundary" && "2. Límite del Perímetro"}
                {step === "first-paddock" && "3. Definir Primer Potrero"}
                {step === "review" && "4. Confirmar y Guardar Mapa"}
              </h3>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800"
            aria-label="Cerrar asistente"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Step Indicator */}
        <div className="flex items-center justify-between px-6 py-3 bg-slate-950/80 border-b border-slate-800 text-xs font-medium text-slate-400">
          <span className={step === "locate" ? "text-emerald-400 font-bold" : ""}>1. Ubicar</span>
          <span>→</span>
          <span className={step === "boundary" ? "text-emerald-400 font-bold" : ""}>2. Perímetro</span>
          <span>→</span>
          <span className={step === "first-paddock" ? "text-emerald-400 font-bold" : ""}>3. Potrero</span>
          <span>→</span>
          <span className={step === "review" ? "text-emerald-400 font-bold" : ""}>4. Confirmar</span>
        </div>

        {/* Step Contents */}
        <div className="p-6 space-y-4">
          {step === "locate" && (
            <div className="space-y-4 text-xs">
              <div>
                <label htmlFor="fundo-name" className="block text-slate-300 font-semibold mb-1">
                  Nombre del Fundo *
                </label>
                <input
                  id="fundo-name"
                  type="text"
                  value={formData.fundoName}
                  onChange={(e) => updateForm("fundoName", e.target.value)}
                  placeholder="Ej. Fundo San Pedro"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <label htmlFor="fundo-sector" className="block text-slate-300 font-semibold mb-1">
                  Sector o Comuna
                </label>
                <input
                  id="fundo-sector"
                  type="text"
                  value={formData.sector}
                  onChange={(e) => updateForm("sector", e.target.value)}
                  placeholder="Ej. Osorno, Los Lagos"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          )}

          {step === "boundary" && (
            <div className="space-y-3 text-xs">
              <span className="block text-slate-300 font-semibold">
                ¿Cómo deseas definir el perímetro exterior del fundo?
              </span>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => updateForm("boundaryRoute", "draw")}
                  className={`p-3 rounded-xl border text-left flex flex-col justify-between gap-2 transition-all ${
                    formData.boundaryRoute === "draw"
                      ? "bg-emerald-950/40 border-emerald-500 text-white"
                      : "bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700"
                  }`}
                >
                  <Pencil className="w-5 h-5 text-emerald-400" />
                  <div>
                    <span className="font-bold block">Dibujar en mapa</span>
                    <span className="text-[11px] text-slate-400">Marcar vértices manualmente</span>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => updateForm("boundaryRoute", "import")}
                  className={`p-3 rounded-xl border text-left flex flex-col justify-between gap-2 transition-all ${
                    formData.boundaryRoute === "import"
                      ? "bg-emerald-950/40 border-emerald-500 text-white"
                      : "bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700"
                  }`}
                >
                  <FileSpreadsheet className="w-5 h-5 text-blue-400" />
                  <div>
                    <span className="font-bold block">Importar archivo</span>
                    <span className="text-[11px] text-slate-400">GeoJSON, KML o Shapefile</span>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => updateForm("boundaryRoute", "gps")}
                  className={`p-3 rounded-xl border text-left flex flex-col justify-between gap-2 transition-all ${
                    formData.boundaryRoute === "gps"
                      ? "bg-emerald-950/40 border-emerald-500 text-white"
                      : "bg-slate-950/60 border-slate-800 text-slate-300 hover:border-slate-700"
                  }`}
                >
                  <Compass className="w-5 h-5 text-amber-400" />
                  <div>
                    <span className="font-bold block">Recorrido GPS</span>
                    <span className="text-[11px] text-slate-400">Caminar en el terreno</span>
                  </div>
                </button>
              </div>
            </div>
          )}

          {step === "first-paddock" && (
            <div className="space-y-4 text-xs">
              <div>
                <label htmlFor="paddock-name" className="block text-slate-300 font-semibold mb-1">
                  Nombre del Primer Potrero *
                </label>
                <input
                  id="paddock-name"
                  type="text"
                  value={formData.firstPaddockName}
                  onChange={(e) => updateForm("firstPaddockName", e.target.value)}
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div>
                <span className="block text-slate-300 font-semibold mb-2">Método de creación</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => updateForm("paddockRoute", "draw")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      formData.paddockRoute === "draw"
                        ? "bg-emerald-950/40 border-emerald-500 text-white"
                        : "bg-slate-950/60 border-slate-800 text-slate-400"
                    }`}
                  >
                    <span className="font-bold block">Dibujo interactivo</span>
                    <span className="text-[11px] opacity-75">Dibujar potrero dentro del fundo</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => updateForm("paddockRoute", "suggested")}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      formData.paddockRoute === "suggested"
                        ? "bg-emerald-950/40 border-emerald-500 text-white"
                        : "bg-slate-950/60 border-slate-800 text-slate-400"
                    }`}
                  >
                    <span className="font-bold block">Parcelas sugeridas</span>
                    <span className="text-[11px] opacity-75">Detección asistida de cercos</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === "review" && (
            <div className="space-y-3 text-xs bg-slate-950/60 p-4 rounded-xl border border-slate-800">
              <h4 className="font-bold text-sm text-emerald-400 flex items-center gap-1.5">
                <Check className="w-4 h-4" />
                <span>Resumen del Primer Mapa</span>
              </h4>
              <div className="space-y-1.5 text-slate-300">
                <p><strong className="text-white">Fundo:</strong> {formData.fundoName} ({formData.sector})</p>
                <p><strong className="text-white">Método Perímetro:</strong> {formData.boundaryRoute}</p>
                <p><strong className="text-white">Primer Potrero:</strong> {formData.firstPaddockName}</p>
                <p><strong className="text-white">Método Potrero:</strong> {formData.paddockRoute}</p>
              </div>
            </div>
          )}

          {error && <p className="text-rose-400 text-xs font-medium">{error}</p>}
        </div>

        {/* Wizard Footer Navigation */}
        <div className="flex items-center justify-between border-t border-slate-800 px-6 py-4 bg-slate-950/50">
          <button
            type="button"
            onClick={handleBack}
            disabled={step === "locate"}
            className="flex items-center gap-1 text-slate-400 hover:text-white disabled:opacity-30 text-xs font-medium"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>Anterior</span>
          </button>

          <button
            type="button"
            onClick={handleNext}
            className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-4 py-2 rounded-lg shadow transition-colors"
          >
            <span>{step === "review" ? "Confirmar y Comenzar" : "Siguiente"}</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
