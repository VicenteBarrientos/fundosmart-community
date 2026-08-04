"use client";

import React, { useMemo } from "react";
import { MapWorkspaceLayout } from "./MapWorkspaceLayout";
import type { Potrero } from "../../types";

export type PotrerosMapContainerProps = {
  children: React.ReactNode;
  selectedPaddock: Potrero | null;
  paddocks: readonly Potrero[];
  networkOnline?: boolean;
  isSaving?: boolean;
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
  className?: string;
};

export function PotrerosMapContainer({
  children,
  selectedPaddock,
  paddocks,
  networkOnline = true,
  isSaving = false,
  hasUnsavedChanges = false,
  activeEditTitle,
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
  className = "",
}: PotrerosMapContainerProps) {
  const totalHectares = useMemo(() => {
    return paddocks.reduce((sum, p) => sum + (p.areaHectares || 0), 0);
  }, [paddocks]);

  const syncState = isSaving
    ? "saving"
    : !networkOnline
    ? "offline"
    : "synced";

  return (
    <MapWorkspaceLayout
      selectedPaddock={selectedPaddock}
      totalPaddocksCount={paddocks.length}
      totalHectares={totalHectares}
      syncState={syncState}
      hasUnsavedChanges={hasUnsavedChanges}
      activeEditTitle={activeEditTitle}
      canUndo={canUndo}
      canRedo={canRedo}
      onUndo={onUndo}
      onRedo={onRedo}
      onSave={onSave}
      onCancelEdit={onCancelEdit}
      onCloseInspector={onCloseInspector}
      onMoveLot={onMoveLot}
      onRegisterManagement={onRegisterManagement}
      onCreateTask={onCreateTask}
      className={className}
    >
      {children}
    </MapWorkspaceLayout>
  );
}
