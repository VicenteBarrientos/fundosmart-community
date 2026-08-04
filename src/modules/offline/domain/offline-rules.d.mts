export type OfflineAccountMode = "personal" | "demo";
export type OfflineMutationStatus = "pending" | "syncing" | "conflict" | "error" | "applied";

export type OfflinePartition = {
  accountMode: OfflineAccountMode;
  organizationId: string;
  userSubject: string;
  fieldId: string;
};

export type OfflineMutationState = {
  mutationId: string;
  partition: OfflinePartition;
  status: OfflineMutationStatus;
  createdAt: string;
  nextAttemptAt: string | null;
};

export type OfflineResponseDecision = {
  status: "applied" | "conflict" | "error";
  nextAttemptAt: string | null;
  reason: string | null;
};

export const OFFLINE_MUTATION_STATUSES: readonly OfflineMutationStatus[];
export const MAX_OFFLINE_SYNC_BATCH_SIZE: 50;
export function createOfflineMutationId(nowMs?: number, randomBytes?: Uint8Array): string;
export function normalizeOfflinePartition(value: unknown): OfflinePartition;
export function offlinePartitionKey(value: OfflinePartition): string;
export function sameOfflinePartition(left: OfflinePartition, right: OfflinePartition): boolean;
export function selectReadyOfflineMutations<T extends OfflineMutationState>(entries: T[], partition: OfflinePartition, nowIso: string): T[];
export function classifyOfflineResponse(input: { status: number; attempts: number; nowIso: string; exactReplay?: boolean }): OfflineResponseDecision;
export function classifySyncPushResult(
  mutationIds: string[],
  results: { id?: unknown; status?: unknown; conflictReason?: unknown }[],
): OfflineResponseDecision;
export function nextOfflineRetryAt(attempts: number, nowIso: string): string;
export function buildSyncPushBatches<T>(mutations: T[]): { mutations: T[] }[];
export function buildSyncPullPath(partition: OfflinePartition, cursor: number, limit?: number): string;
