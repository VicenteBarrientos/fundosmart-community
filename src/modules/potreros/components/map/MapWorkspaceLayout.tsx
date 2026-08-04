"use client";

import React, { useState, useCallback } from "react";
import { MapModeHeader, type MapInteractionMode } from "./MapModeHeader";
import { MapContextualInspector } from "./MapContextualInspector";
import type { Potrero } from "../../types";

export type MapWorkspaceLayoutProps = {
  children: React.ReactNode;
  selectedPaddock: Potrero | null;
  totalPaddocksCount: number;
  totalHectares: number;
  syncState?: "synced" | "saving" | "offline" | "error" | "stale";
  hasUnsavedChanges?: boolean;
  activeEditTitle?: string;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void;
  onRedo?: () => void;
  onSave?: () => void;
  onCancelEdit?: () => void;
  onCloseInspector?: () => void;
  onMoveLot?: (paddock: Potrero) => void;
  onRegisterManagement?: (paddock: Potrero) => void;
  onCreateTask?: (paddock: Potrero) => void;
  initialMode?: MapInteractionMode;
  onModeChange?: (mode: MapInteractionMode) => void;
  className?: string;
};

export function MapWorkspaceLayout({
  children,
  selectedPaddock,
  totalPaddocksCount,
  totalHectares,
  syncState = "synced",
  hasUnsavedChanges = false,
  activeEditTitle = "Editar límites de potrero",
  canUndo = false,
  canRedo = false,
  onUndo,
  onRedo,
  onSave,
  onCancelEdit,
  onCloseInspector,
  onMoveLot,
  onRegisterManagement,
  onCreateTask,
  initialMode = "operar",
  onModeChange,
  className = "",
}: MapWorkspaceLayoutProps) {
  const [modeState, setModeState] = useState<MapInteractionMode>(initialMode);
  const [showInspector, setShowInspector] = useState(true);

  const handleModeChange = useCallback(
    (newMode: MapInteractionMode) => {
      setModeState(newMode);
      onModeChange?.(newMode);
    },
    [onModeChange],
  );

  const handleCloseInspector = useCallback(() => {
    setShowInspector(false);
    onCloseInspector?.();
  }, [onCloseInspector]);

  // Re-open inspector when a paddock is selected
  React.useEffect(() => {
    if (selectedPaddock) {
      setShowInspector(true);
    }
  }, [selectedPaddock]);

  return (
    <div
      className={`relative flex flex-col w-full h-[calc(100vh-4rem)] min-h-[500px] overflow-hidden bg-slate-950 font-sans ${className}`}
      data-testid="map-workspace-layout"
      data-mode={modeState}
    >
      {/* Top Bar: Mode Header */}
      <MapModeHeader
        mode={modeState}
        onModeChange={handleModeChange}
        syncState={syncState}
        hasUnsavedChanges={hasUnsavedChanges}
        activeEditTitle={activeEditTitle}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={onUndo}
        onRedo={onRedo}
        onSave={onSave}
        onCancelEdit={onCancelEdit}
      />

      {/* Main Container: Fullscreen Map Viewport */}
      <main className="relative flex-1 w-full h-full overflow-hidden">
        {children}

        {/* Floating Contextual Inspector (Desktop Sidebar / Mobile Bottom Sheet) */}
        {showInspector && (
          <MapContextualInspector
            selectedPaddock={selectedPaddock}
            totalPaddocksCount={totalPaddocksCount}
            totalHectares={totalHectares}
            onClose={handleCloseInspector}
            onMoveLot={onMoveLot}
            onRegisterManagement={onRegisterManagement}
            onCreateTask={onCreateTask}
          />
        )}
      </main>
    </div>
  );
}
