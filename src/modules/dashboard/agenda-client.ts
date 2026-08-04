"use client";

import type {
  AgendaManagementSnapshot,
  AgendaTaskMutation,
  AgendaTaskState,
} from "./agenda-management.mjs";

type AgendaApiPayload = {
  error?: unknown;
  code?: unknown;
  management?: unknown;
  state?: unknown;
  replay?: unknown;
};

export class AgendaClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "AgendaClientError";
  }
}

export async function fetchAgendaManagement(): Promise<AgendaManagementSnapshot> {
  const response = await fetch("/api/agenda", {
    cache: "no-store",
    credentials: "same-origin",
  });
  const payload = await readPayload(response);
  const management = payload?.management;
  if (!response.ok || !isManagementSnapshot(management)) {
    throw clientError(response, payload, "No fue posible actualizar la gestión de la agenda.");
  }
  return management;
}

export async function persistAgendaTaskMutation(
  mutation: AgendaTaskMutation,
): Promise<{ state: AgendaTaskState; replay: boolean }> {
  const response = await fetch("/api/agenda", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mutation),
  });
  const payload = await readPayload(response);
  const state = payload?.state;
  if (!response.ok || !isAgendaTaskState(state)) {
    throw clientError(response, payload, "No fue posible guardar la acción de agenda.");
  }
  return { state, replay: payload?.replay === true };
}

export async function persistAgendaTaskBatchMutation(
  mutations: AgendaTaskMutation[],
): Promise<Array<{ state: AgendaTaskState; replay: boolean }>> {
  const response = await fetch("/api/agenda", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batch: mutations }),
  });
  const payload = await readPayload(response);
  const results = (payload as { results?: unknown })?.results;
  if (!response.ok || !Array.isArray(results)) {
    throw clientError(response, payload, "No fue posible guardar las acciones de agenda en lote.");
  }
  return results.map((item) => ({
    state: (item as { state: AgendaTaskState }).state,
    replay: (item as { replay?: boolean }).replay === true,
  }));
}

async function readPayload(response: Response): Promise<AgendaApiPayload | null> {
  try {
    const payload: unknown = await response.json();
    return payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload as AgendaApiPayload
      : null;
  } catch {
    return null;
  }
}

function clientError(
  response: Response,
  payload: AgendaApiPayload | null,
  fallback: string,
): AgendaClientError {
  return new AgendaClientError(
    typeof payload?.error === "string" ? payload.error : fallback,
    response.status,
    typeof payload?.code === "string" ? payload.code : null,
  );
}

function isManagementSnapshot(value: unknown): value is AgendaManagementSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AgendaManagementSnapshot>;
  return Array.isArray(record.states)
    && Array.isArray(record.assignees)
    && typeof record.currentMembershipId === "string";
}

function isAgendaTaskState(value: unknown): value is AgendaTaskState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Partial<AgendaTaskState>;
  return typeof record.id === "string"
    && typeof record.fieldId === "string"
    && typeof record.itemKey === "string"
    && typeof record.signalRevision === "string"
    && typeof record.status === "string"
    && Number.isSafeInteger(record.version);
}
