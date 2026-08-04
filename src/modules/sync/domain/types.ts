export const SYNC_MUTATION_OPERATIONS = ["create", "update", "append"] as const;
export type SyncMutationOperation = (typeof SYNC_MUTATION_OPERATIONS)[number];

export const SYNC_MUTATION_STATUSES = ["pending", "applied", "conflict", "rejected"] as const;
export type SyncMutationStatus = (typeof SYNC_MUTATION_STATUSES)[number];

export const SYNC_ENTITIES = [
  "field_observation",
  "field_note",
  "livestock_weighing",
  "livestock_health",
  "livestock_estrus",
  "livestock_movement",
  "paddock_geometry",
  "field_landmark",
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

export type SyncJsonValue =
  | null
  | boolean
  | number
  | string
  | SyncJsonValue[]
  | { [key: string]: SyncJsonValue };

export type SyncMutationInput = {
  id: string;
  fieldId: string;
  entity: SyncEntity;
  entityId: string;
  op: SyncMutationOperation;
  payload: Record<string, SyncJsonValue>;
  clientTs: string;
  expectedVersion?: string | null;
};

export type SyncMutationResult = {
  id: string;
  status: Exclude<SyncMutationStatus, "pending">;
  replay: boolean;
  eventId: string | null;
  serverVersion: string | null;
  conflictReason: string | null;
};

export type DomainEventRecord = {
  sequence: number;
  id: string;
  organizationId: string;
  fieldId: string;
  type: string;
  entity: string;
  entityId: string;
  payload: Record<string, SyncJsonValue>;
  sourceMutationId: string | null;
  occurredAt: string;
};

export type ScheduledJobStatus = "active" | "paused";

export type ScheduledJobRecord = {
  id: string;
  organizationId: string | null;
  fieldId: string | null;
  type: string;
  payload: Record<string, SyncJsonValue>;
  status: ScheduledJobStatus;
  dueAt: string;
  intervalSeconds: number;
  attemptCount: number;
};
