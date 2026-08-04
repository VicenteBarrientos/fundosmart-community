"use client";

import React from "react";
import {
  CheckCircle2,
  CloudOff,
  Edit3,
  Eye,
  Loader2,
  MapPin,
  Redo2,
  RotateCcw,
  Save,
  Undo2,
  X,
} from "lucide-react";

export type MapInteractionMode = "operar" | "editar";

export type MapModeHeaderProps = {
  mode: MapInteractionMode;
  onModeChange: (newMode: MapInteractionMode) => void;
  syncState?: "synced" | "saving" | "offline" | "error" | "stale";
  hasUnsavedChanges?: boolean;
  activeEditTitle?: string;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  onCancelEdit?: () => void;
  className?: string;
};

export function MapModeHeader({
  mode,
  onModeChange,
  syncState = "synced",
  hasUnsavedChanges = false,
  activeEditTitle = "Editar límites de potrero",
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSave,
  onCancelEdit,
  className = "",
}: MapModeHeaderProps) {
  return (
    <header
      className={`bg-slate-900/90 backdrop-blur-md text-white border-b border-slate-800 px-4 py-2.5 flex items-center justify-between gap-3 shadow-lg z-20 ${className}`}
      aria-label="Barra de modo del mapa"
    >
      {/* Left: Mode Switcher & Title */}
      <div className="flex items-center gap-3">
        <div className="inline-flex p-1 bg-slate-800 rounded-lg border border-slate-700/60 text-xs font-medium">
          <button
            type="button"
            onClick={() => onModeChange("operar")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
              mode === "operar"
                ? "bg-emerald-600 text-white font-semibold shadow"
                : "text-slate-300 hover:text-white hover:bg-slate-700/50"
            }`}
            aria-pressed={mode === "operar"}
          >
            <Eye className="w-3.5 h-3.5" />
            <span>Operar</span>
          </button>
          <button
            type="button"
            onClick={() => onModeChange("editar")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md transition-colors ${
              mode === "editar"
                ? "bg-amber-600 text-white font-semibold shadow"
                : "text-slate-300 hover:text-white hover:bg-slate-700/50"
            }`}
            aria-pressed={mode === "editar"}
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Editar Mapa</span>
          </button>
        </div>

        {mode === "editar" && (
          <div className="hidden sm:flex items-center gap-2 pl-2 border-l border-slate-700">
            <MapPin className="w-4 h-4 text-amber-400" />
            <span className="text-sm font-medium text-amber-200">
              {activeEditTitle}
            </span>
          </div>
        )}
      </div>

      {/* Center/Right: Sync and Edit Actions */}
      <div className="flex items-center gap-2">
        {/* Sync / Draft Badge */}
        <div
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${
            syncState === "saving"
              ? "bg-blue-500/10 text-blue-300 border-blue-500/30"
              : syncState === "offline"
              ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
              : syncState === "error"
              ? "bg-rose-500/10 text-rose-300 border-rose-500/30"
              : hasUnsavedChanges
              ? "bg-amber-500/10 text-amber-300 border-amber-500/30"
              : "bg-emerald-500/10 text-emerald-300 border-emerald-500/30"
          }`}
          aria-live="polite"
        >
          {syncState === "saving" ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>Guardando...</span>
            </>
          ) : syncState === "offline" ? (
            <>
              <CloudOff className="w-3.5 h-3.5" />
              <span>Modo Offline</span>
            </>
          ) : hasUnsavedChanges ? (
            <>
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Borrador local</span>
            </>
          ) : (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              <span>Guardado</span>
            </>
          )}
        </div>

        {/* Editing Controls */}
        {mode === "editar" && (
          <div className="flex items-center gap-1.5 border-l border-slate-700 pl-2">
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              className="p-1.5 text-slate-300 hover:text-white disabled:opacity-40 disabled:hover:text-slate-300 rounded hover:bg-slate-800 transition-colors"
              title="Deshacer (Ctrl+Z)"
              aria-label="Deshacer"
            >
              <Undo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onRedo}
              disabled={!canRedo}
              className="p-1.5 text-slate-300 hover:text-white disabled:opacity-40 disabled:hover:text-slate-300 rounded hover:bg-slate-800 transition-colors"
              title="Rehacer (Ctrl+Y)"
              aria-label="Rehacer"
            >
              <Redo2 className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={!hasUnsavedChanges || syncState === "saving"}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs px-3 py-1.5 rounded-md shadow disabled:opacity-50 disabled:hover:bg-emerald-600 transition-colors"
              aria-label="Guardar cambios de edición"
            >
              <Save className="w-3.5 h-3.5" />
              <span>Guardar</span>
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              className="p-1.5 text-slate-400 hover:text-slate-200 rounded hover:bg-slate-800 transition-colors"
              title="Salir de la edición"
              aria-label="Cancelar edición"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
