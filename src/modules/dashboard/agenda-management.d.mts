import type {
  TodayAgendaItem,
  TodayAgendaSource,
  TodayAgendaUrgency,
} from "./today-agenda.mjs";

export const AGENDA_TASK_ACTIONS: readonly [
  "complete",
  "postpone",
  "dismiss",
  "reopen",
  "assign",
];
export type AgendaTaskAction = (typeof AGENDA_TASK_ACTIONS)[number];

export const AGENDA_TASK_STATUSES: readonly [
  "open",
  "completed",
  "postponed",
  "dismissed",
];
export type AgendaTaskStatus = (typeof AGENDA_TASK_STATUSES)[number];
export type AgendaTaskSource = TodayAgendaSource;
export type AgendaViewStatus = "pending" | "postponed" | "closed";

export type AgendaAssignee = {
  id: string;
  displayName: string;
  role: "owner" | "admin" | "manager" | "operator" | "viewer";
  fieldIds: string[];
};

export type AgendaTaskState = {
  id: string;
  organizationId: string;
  fieldId: string;
  itemKey: string;
  signalRevision: string;
  source: AgendaTaskSource;
  status: AgendaTaskStatus;
  assigneeMembershipId: string | null;
  assigneeName: string | null;
  scheduledFor: string | null;
  resolutionReason: string | null;
  version: number;
  lastOperationId: string;
  createdAt: string;
  updatedAt: string;
};

export type AgendaManagementSnapshot = {
  states: AgendaTaskState[];
  assignees: AgendaAssignee[];
  currentMembershipId: string;
};

export type ManagedTodayAgendaItem = TodayAgendaItem & {
  agendaView: AgendaViewStatus;
  originalUrgency: TodayAgendaUrgency;
  taskState: AgendaTaskState | null;
};

export type AgendaTaskMutation = {
  action: AgendaTaskAction;
  operationId: string;
  fieldId: string;
  itemKey: string;
  signalRevision: string;
  source: AgendaTaskSource;
  expectedVersion: number | null;
  reason: string | null;
  scheduledFor: string | null;
  assigneeMembershipId: string | null;
};

export class AgendaRequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status?: number, code?: string);
}

export function validateAgendaTaskMutation(value: unknown): AgendaTaskMutation;
export function applyAgendaTaskStates(
  items?: TodayAgendaItem[],
  states?: AgendaTaskState[],
  referenceDate?: string,
): ManagedTodayAgendaItem[];
