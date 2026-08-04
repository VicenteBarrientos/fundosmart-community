import type { SyncMutationInput, SyncMutationStatus } from "./types";

export const MAX_SYNC_BATCH_SIZE: number;
export const MAX_SYNC_PAYLOAD_BYTES: number;

export function validateSyncBatch(value: unknown): string | null;
export function validateSyncMutation(value: unknown): string | null;
export function stableStringify(value: unknown): string;
export function decideSyncMutation(input: {
  mutation: SyncMutationInput;
  existing: (SyncMutationInput & { status: SyncMutationStatus; conflictReason: string | null }) | null;
  latestVersion: string | null;
  allowedFieldIds: string[];
}):
  | { action: "apply"; reason: null }
  | { action: "replay"; reason: string | null }
  | { action: "reject" | "conflict"; reason: string };
