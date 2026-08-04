"use client";

import React, { useState } from "react";
import { Eye, EyeOff, Layers, Activity, ShieldAlert, Sprout, TrendingUp } from "lucide-react";

export type OperationalOverlayKind = "resting-days" | "biomass" | "stocking-load" | "ndvi" | "risks";

export type OverlayState = Readonly<{
  kind: OperationalOverlayKind;
  label: string;
  visible: boolean;
  opacity: number;
  unit: string;
}>;

export type MapOverlaysManagerProps = {
  overlays: readonly OverlayState[];
  onToggleOverlay: (kind: OperationalOverlayKind, visible: boolean) => void;
  onOpacityChange?: (kind: OperationalOverlayKind, opacity: number) => void;
  className?: string;
};

export function MapOverlaysManager({
  overlays,
  onToggleOverlay,
  onOpacityChange,
  className = "",
}: MapOverlaysManagerProps) {
  void onOpacityChange;
  const [isOpen, setIsOpen] = useState(false);

  const getOverlayIcon = (kind: OperationalOverlayKind) => {
    switch (kind) {
      case "resting-days":
        return <Activity className="w-4 h-4 text-emerald-400" />;
      case "biomass":
        return <Sprout className="w-4 h-4 text-amber-400" />;
      case "stocking-load":
        return <TrendingUp className="w-4 h-4 text-blue-400" />;
      case "ndvi":
        return <Layers className="w-4 h-4 text-purple-400" />;
      case "risks":
        return <ShieldAlert className="w-4 h-4 text-rose-400" />;
    }
  };

  return (
    <div className={`relative z-20 ${className}`}>
      {/* Toggle Button */}
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md hover:bg-slate-800 text-slate-100 border border-slate-700/80 px-3 py-1.5 rounded-lg text-xs font-semibold shadow-lg transition-colors"
        aria-expanded={isOpen}
        aria-label="Gestor de capas operacionales"
      >
        <Layers className="w-3.5 h-3.5 text-emerald-400" />
        <span>Capas y Filtros</span>
      </button>

      {/* Popover Panel */}
      {isOpen && (
        <div className="absolute top-10 right-0 w-64 bg-slate-900/95 backdrop-blur-md border border-slate-800 rounded-xl p-3 shadow-2xl text-xs text-slate-100 space-y-3">
          <div className="flex items-center justify-between border-b border-slate-800 pb-2">
            <span className="font-bold text-slate-200">Capas Operacionales</span>
            <span className="text-[10px] text-slate-400">{overlays.filter((o) => o.visible).length} activas</span>
          </div>

          <div className="space-y-2">
            {overlays.map((overlay) => (
              <div
                key={overlay.kind}
                className="flex items-center justify-between bg-slate-950/60 p-2 rounded-lg border border-slate-800/60"
              >
                <div className="flex items-center gap-2">
                  {getOverlayIcon(overlay.kind)}
                  <span className="font-medium text-slate-200">{overlay.label}</span>
                </div>

                <button
                  type="button"
                  onClick={() => onToggleOverlay(overlay.kind, !overlay.visible)}
                  className={`p-1 rounded transition-colors ${
                    overlay.visible ? "text-emerald-400 hover:text-emerald-300" : "text-slate-500 hover:text-slate-300"
                  }`}
                  aria-label={`Alternar capa ${overlay.label}`}
                >
                  {overlay.visible ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
