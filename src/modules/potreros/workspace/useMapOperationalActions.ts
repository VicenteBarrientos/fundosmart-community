"use client";

import { useState, useCallback } from "react";
import type { Potrero, ActivityInput } from "../types";

export type OperationalActionKind = "idle" | "move-lot" | "register-management" | "create-task";

export type OperationalActionState = Readonly<{
  kind: OperationalActionKind;
  targetPaddock: Potrero | null;
  draftActivity: Partial<ActivityInput> | null;
}>;

export function createInitialOperationalState(): OperationalActionState {
  return Object.freeze({
    kind: "idle",
    targetPaddock: null,
    draftActivity: null,
  });
}

export type OperationalAction =
  | Readonly<{ type: "move-lot"; targetPaddock: Potrero }>
  | Readonly<{ type: "register-management"; targetPaddock: Potrero; dateISO?: string }>
  | Readonly<{ type: "create-task"; targetPaddock: Potrero; dateISO?: string }>
  | Readonly<{ type: "reset" }>;

export function reduceOperationalState(
  state: OperationalActionState,
  action: OperationalAction,
): OperationalActionState {
  if (action.type === "reset") {
    return createInitialOperationalState();
  }
  if (action.type === "move-lot") {
    return Object.freeze({
      kind: "move-lot",
      targetPaddock: action.targetPaddock,
      draftActivity: null,
    });
  }
  const dateISO = action.dateISO ?? new Date().toISOString().split("T")[0];
  if (action.type === "register-management") {
    return Object.freeze({
      kind: "register-management",
      targetPaddock: action.targetPaddock,
      draftActivity: Object.freeze({
        potreroId: action.targetPaddock.id,
        occurredAt: dateISO,
        type: "fertilization" as const,
        description: `Manejo registrado en potrero ${action.targetPaddock.name}`,
        costClp: null,
        quantity: null,
        unit: null,
      }),
    });
  }
  if (action.type === "create-task") {
    return Object.freeze({
      kind: "create-task",
      targetPaddock: action.targetPaddock,
      draftActivity: Object.freeze({
        potreroId: action.targetPaddock.id,
        occurredAt: dateISO,
        type: "grazing" as const,
        description: `Tarea pendiente en potrero ${action.targetPaddock.name}`,
        costClp: null,
        quantity: null,
        unit: null,
      }),
    });
  }
  return state;
}

export function useMapOperationalActions() {
  const [state, setState] = useState<OperationalActionState>(createInitialOperationalState());

  const startMoveLot = useCallback((paddock: Potrero) => {
    setState((prev) => reduceOperationalState(prev, { type: "move-lot", targetPaddock: paddock }));
  }, []);

  const startManagement = useCallback((paddock: Potrero) => {
    setState((prev) => reduceOperationalState(prev, { type: "register-management", targetPaddock: paddock }));
  }, []);

  const startCreateTask = useCallback((paddock: Potrero) => {
    setState((prev) => reduceOperationalState(prev, { type: "create-task", targetPaddock: paddock }));
  }, []);

  const resetOperationalState = useCallback(() => {
    setState(createInitialOperationalState());
  }, []);

  return {
    operationalState: state,
    startMoveLot,
    startManagement,
    startCreateTask,
    resetOperationalState,
  };
}
