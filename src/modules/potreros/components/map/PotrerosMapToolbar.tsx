"use client";

import React, { useState } from "react";
import { Download, Sparkles, Table } from "lucide-react";
import { MapExportDialog } from "./MapExportDialog";
import { MapWizardDialog, type MapWizardData } from "./MapWizardDialog";
import { MapOverlaysManager, type OperationalOverlayKind, type OverlayState } from "./MapOverlaysManager";
import { MapAccessibilityCoordinateEditor } from "./MapAccessibilityCoordinateEditor";
import type { Fundo, Potrero, Coordinate } from "../../types";

export type PotrerosMapToolbarProps = {
  fundo: Fundo | null;
  paddocks: readonly Potrero[];
  activeCoordinates?: Coordinate[];
  onCoordinatesChange?: (coords: Coordinate[]) => void;
  onExport?: (format: string, paddockIds: string[]) => void;
  onWizardComplete?: (data: MapWizardData) => void;
  className?: string;
};

export function PotrerosMapToolbar({
  fundo,
  paddocks,
  activeCoordinates = [],
  onCoordinatesChange,
  onExport,
  onWizardComplete,
  className = "",
}: PotrerosMapToolbarProps) {
  const [isWizardOpen, setIsWizardOpen] = useState(false);
  const [isExportOpen, setIsExportOpen] = useState(false);
  const [isA11yEditorOpen, setIsA11yEditorOpen] = useState(false);

  const [overlays, setOverlays] = useState<OverlayState[]>([
    { kind: "resting-days", label: "Días de descanso", visible: true, opacity: 1, unit: "días" },
    { kind: "biomass", label: "Biomasa y oferta", visible: true, opacity: 1, unit: "kg MS/ha" },
    { kind: "stocking-load", label: "Carga animal", visible: false, opacity: 1, unit: "UGB/ha" },
    { kind: "ndvi", label: "Índice NDVI satelital", visible: false, opacity: 0.8, unit: "NDVI" },
    { kind: "risks", label: "Alertas y riesgos", visible: true, opacity: 1, unit: "alertas" },
  ]);

  const handleToggleOverlay = (kind: OperationalOverlayKind, visible: boolean) => {
    setOverlays((current) =>
      current.map((o) => (o.kind === kind ? { ...o, visible } : o)),
    );
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 z-20 ${className}`}>
      {/* Guided Wizard Trigger */}
      <button
        type="button"
        onClick={() => setIsWizardOpen(true)}
        className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white border border-emerald-500/80 px-3 py-1.5 rounded-lg text-xs font-medium shadow-md transition-colors"
      >
        <Sparkles className="w-3.5 h-3.5" />
        <span>Asistente Mapa</span>
      </button>

      {/* Operational Overlays */}
      <MapOverlaysManager
        overlays={overlays}
        onToggleOverlay={handleToggleOverlay}
      />

      {/* Accessible Vertex Table Editor Toggle */}
      {onCoordinatesChange && (
        <button
          type="button"
          onClick={() => setIsA11yEditorOpen(!isA11yEditorOpen)}
          className="flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md hover:bg-slate-800 text-slate-100 border border-slate-700/80 px-3 py-1.5 rounded-lg text-xs font-medium shadow-md transition-colors"
          aria-expanded={isA11yEditorOpen}
        >
          <Table className="w-3.5 h-3.5 text-blue-400" />
          <span>Tabla de Vértices</span>
        </button>
      )}

      {/* Export Dialog Trigger */}
      <button
        type="button"
        onClick={() => setIsExportOpen(true)}
        className="flex items-center gap-1.5 bg-slate-900/90 backdrop-blur-md hover:bg-slate-800 text-slate-100 border border-slate-700/80 px-3 py-1.5 rounded-lg text-xs font-medium shadow-md transition-colors"
      >
        <Download className="w-3.5 h-3.5 text-amber-400" />
        <span>Exportar</span>
      </button>

      {/* Modals & Popovers */}
      <MapWizardDialog
        isOpen={isWizardOpen}
        onClose={() => setIsWizardOpen(false)}
        onComplete={(data) => {
          onWizardComplete?.(data);
          setIsWizardOpen(false);
        }}
      />

      <MapExportDialog
        isOpen={isExportOpen}
        fundo={fundo}
        paddocks={paddocks}
        onClose={() => setIsExportOpen(false)}
        onExport={(format, ids) => {
          onExport?.(format, ids);
          setIsExportOpen(false);
        }}
      />

      {isA11yEditorOpen && onCoordinatesChange && (
        <div className="w-full mt-2">
          <MapAccessibilityCoordinateEditor
            coordinates={activeCoordinates}
            onCoordinatesChange={onCoordinatesChange}
            paddockName={fundo?.name}
          />
        </div>
      )}
    </div>
  );
}
