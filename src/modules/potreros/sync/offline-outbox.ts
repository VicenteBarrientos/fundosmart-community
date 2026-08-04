import type { Activity, Potrero } from "../types";

export type OfflineMutationOperation = "create" | "update" | "delete";

export type PotreroOutboxOperation =
  | { op: "create" | "update"; entity: "potrero"; payload: Potrero; queuedAt: string }
  | { op: "delete"; entity: "potrero"; payload: { id: string; updatedAt: string }; queuedAt: string };

export type ActivityOutboxOperation =
  | { op: "create" | "update"; entity: "activity"; payload: Activity; queuedAt: string }
  | { op: "delete"; entity: "activity"; payload: { id: string; updatedAt: string }; queuedAt: string };

export type OfflineOutboxOperation = PotreroOutboxOperation | ActivityOutboxOperation;

export type OfflineOutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type OfflineMutationResult<T> =
  | { status: "applied"; value: T }
  | { status: "queued" };

export class OfflineNetworkError extends Error {
  readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "OfflineNetworkError";
    this.cause = cause;
  }
}

export function offlineOutboxStorageKey(scope: string) {
  return `fundosmart:${scope}:potreros-outbox-v1`;
}

export function createOfflineOutbox(storage: OfflineOutboxStorage, storageKey: string) {
  let drainPromise: Promise<number> | null = null;
  let inFlightToken: string | null = null;

  const list = () => readOutbox(storage, storageKey);

  const enqueue = (operation: OfflineOutboxOperation) => {
    const compacted = compactOutbox(list(), operation, inFlightToken);
    writeOutbox(storage, storageKey, compacted);
    return compacted;
  };

  const executeOrQueue = async <T>(
    operation: OfflineOutboxOperation,
    execute: () => Promise<T>,
  ): Promise<OfflineMutationResult<T>> => {
    try {
      return { status: "applied", value: await execute() };
    } catch (error) {
      if (!(error instanceof OfflineNetworkError)) throw error;
      enqueue(operation);
      return { status: "queued" };
    }
  };

  const drain = (replay: (operation: OfflineOutboxOperation) => Promise<unknown>) => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      let applied = 0;
      while (true) {
        const operation = list()[0];
        if (!operation) return applied;

        inFlightToken = operationToken(operation);
        await replay(operation);

        const current = list();
        const appliedIndex = current.findIndex((candidate) => operationToken(candidate) === inFlightToken);
        if (appliedIndex >= 0) {
          current.splice(appliedIndex, 1);
          writeOutbox(storage, storageKey, current);
        }
        applied += 1;
        inFlightToken = null;
      }
    })().finally(() => {
      inFlightToken = null;
      drainPromise = null;
    });
    return drainPromise;
  };

  const synchronize = async <T>(
    replay: (operation: OfflineOutboxOperation) => Promise<unknown>,
    fetchRemote: () => Promise<T>,
  ) => {
    await drain(replay);
    return fetchRemote();
  };

  return { drain, enqueue, executeOrQueue, list, storageKey, synchronize };
}

function readOutbox(storage: OfflineOutboxStorage, storageKey: string): OfflineOutboxOperation[] {
  const serialized = storage.getItem(storageKey);
  if (!serialized) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (!Array.isArray(parsed)) throw new Error("invalid outbox");
    const operations = parsed.filter(isOfflineOutboxOperation);
    if (operations.length !== parsed.length) writeOutbox(storage, storageKey, operations);
    return operations;
  } catch {
    storage.removeItem(storageKey);
    return [];
  }
}

function writeOutbox(
  storage: OfflineOutboxStorage,
  storageKey: string,
  operations: OfflineOutboxOperation[],
) {
  if (operations.length === 0) {
    storage.removeItem(storageKey);
    return;
  }
  storage.setItem(storageKey, JSON.stringify(operations));
}

function compactOutbox(
  operations: OfflineOutboxOperation[],
  incoming: OfflineOutboxOperation,
  protectedToken: string | null,
) {
  const previous = operations.at(-1);
  if (
    !previous
    || previous.entity !== incoming.entity
    || previous.payload.id !== incoming.payload.id
    || operationToken(previous) === protectedToken
  ) {
    return [...operations, incoming];
  }

  if (previous.op === "create" && incoming.op === "delete") return operations.slice(0, -1);
  if (previous.op === "delete" && incoming.op !== "delete") return [...operations, incoming];

  const replacement = {
    ...incoming,
    op: previous.op === "create" ? "create" : incoming.op,
    queuedAt: previous.queuedAt,
  } as OfflineOutboxOperation;
  return [...operations.slice(0, -1), replacement];
}

function isOfflineOutboxOperation(value: unknown): value is OfflineOutboxOperation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<OfflineOutboxOperation>;
  const hasBaseShape = (candidate.entity === "potrero" || candidate.entity === "activity")
    && (candidate.op === "create" || candidate.op === "update" || candidate.op === "delete")
    && typeof candidate.queuedAt === "string" && candidate.queuedAt.length > 0
    && !!candidate.payload
    && typeof candidate.payload === "object"
    && "id" in candidate.payload
    && typeof candidate.payload.id === "string";
  if (!hasBaseShape) return false;
  return candidate.op !== "delete"
    || ("updatedAt" in candidate.payload! && typeof candidate.payload.updatedAt === "string");
}

function operationToken(operation: OfflineOutboxOperation) {
  return JSON.stringify(operation);
}
