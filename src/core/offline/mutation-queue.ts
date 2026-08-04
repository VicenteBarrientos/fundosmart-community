import {
  buildSyncPullPath,
  buildSyncPushBatches,
  classifyOfflineResponse,
  classifySyncPushResult,
  createOfflineMutationId,
  nextOfflineRetryAt,
  normalizeOfflinePartition,
  offlinePartitionKey,
  selectReadyOfflineMutations,
  type OfflineMutationStatus,
  type OfflinePartition,
} from "@/src/modules/offline/domain/offline-rules.mjs";
import type { SyncMutationInput } from "@/src/modules/sync/domain/types";

export type OfflineMutationTransport = "legacy" | "sync-v1";

export type OfflineMutationInput = {
  id: string;
  scope: string;
  partition: OfflinePartition;
  transport?: OfflineMutationTransport;
  url: string;
  method: "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body: string | null;
  label: string;
};

export type OfflineMutation = Omit<OfflineMutationInput, "id" | "transport"> & {
  id: string;
  mutationId: string;
  transport: OfflineMutationTransport;
  createdAt: string;
  updatedAt: string;
  attempts: number;
  status: OfflineMutationStatus;
  nextAttemptAt: string | null;
  statusReason: string | null;
  appliedAt: string | null;
};

export type OfflineMutationSummary = Record<OfflineMutationStatus, number>;

export type OfflineReadModel<T> = {
  partition: OfflinePartition;
  name: string;
  value: T;
  cursor: number;
  storedAt: string;
};

export type OfflineSession = {
  version: 1;
  audience: "fundosmart-offline-v1";
  sessionId: string;
  token: string;
  accountMode: "personal" | "demo";
  membershipId: string;
  organizationId: string;
  userSubject: string;
  role: string;
  fieldIds: string[];
  issuedAt: string;
  expiresAt: string;
};

export type OfflineAttachmentStatus = "pending" | "uploading" | "error" | "applied";

export type OfflineAttachment = {
  id: string;
  attachmentId: string;
  scope: string;
  partition: OfflinePartition;
  entityId: string;
  filename: string;
  contentType: string;
  size: number;
  blob: Blob | null;
  status: OfflineAttachmentStatus;
  attempts: number;
  statusReason: string | null;
  objectKey: string | null;
  sha256: string | null;
  createdAt: string;
  updatedAt: string;
};

type MutationAttempt = {
  response?: Response;
  status: OfflineMutationStatus;
  retryable: boolean;
};

const DB_NAME = "fundosmart-offline";
const MUTATION_STORE = "mutations";
const READ_MODEL_STORE = "readModels";
const CURSOR_STORE = "cursors";
const SESSION_STORE = "sessions";
const ATTACHMENT_STORE = "attachments";
const DB_VERSION = 3;
const MAX_OFFLINE_ATTACHMENT_BYTES = 1_500_000;

export function offlinePartitionFromScope(scope: string, fieldId: string): OfflinePartition {
  const scopeParts = parseOfflineScope(scope);
  const membershipId = scopeParts[0];
  const fieldIds = scopeParts.slice(2);
  if (!fieldIds.includes(fieldId)) throw new Error("El fundo no pertenece al alcance offline activo.");
  const accountMode = membershipId.includes("-demo") || fieldId === "fundo-el-ejemplo" ? "demo" : "personal";
  // membershipId is the opaque server-issued association between one subject and one organization.
  // Using separate namespaces keeps both dimensions explicit without persisting an email or Access token.
  return normalizeOfflinePartition({
    accountMode,
    organizationId: `organization-by-membership:${membershipId}`,
    userSubject: `membership-subject:${membershipId}`,
    fieldId,
  });
}

export function offlinePartitionFromSession(session: OfflineSession, fieldId: string): OfflinePartition {
  if (!session.fieldIds.includes(fieldId) || Date.parse(session.expiresAt) <= Date.now()) {
    throw new Error("La sesión offline expiró o no permite operar este fundo.");
  }
  return normalizeOfflinePartition({
    accountMode: session.accountMode,
    organizationId: session.organizationId,
    userSubject: session.userSubject,
    fieldId,
  });
}

export async function refreshOfflineSession(scope: string): Promise<OfflineSession> {
  const response = await fetch("/api/offline/session", {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error("No fue posible habilitar la captura sin señal.");
  const body = await response.json() as { session?: unknown };
  const session = parseOfflineSession(body.session, scope);
  await putStoreValue(SESSION_STORE, { id: sessionStorageKey(scope), scope, session });
  return session;
}

export async function getActiveOfflineSession(scope: string, nowMs = Date.now()): Promise<OfflineSession | null> {
  const session = await getStoredOfflineSession(scope);
  return session && Date.parse(session.expiresAt) > nowMs ? session : null;
}

async function getStoredOfflineSession(scope: string): Promise<OfflineSession | null> {
  const stored = await getStoreValue<{ scope: string; session: unknown }>(SESSION_STORE, sessionStorageKey(scope));
  if (!stored || stored.scope !== scope) return null;
  try {
    return parseOfflineSession(stored.session, scope);
  } catch {
    return null;
  }
}

export async function sendOrQueueMutation(input: OfflineMutationInput): Promise<{ queued: boolean; response?: Response }> {
  await assertScopeAllowsPartition(input.scope, input.partition);
  assertSafeMutationRequest(input.url, input.headers);
  const now = new Date().toISOString();
  const mutation: OfflineMutation = {
    ...input,
    id: mutationStorageKey(input.partition, input.id),
    mutationId: input.id,
    transport: input.transport ?? "legacy",
    partition: normalizeOfflinePartition(input.partition),
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    status: "pending",
    nextAttemptAt: null,
    statusReason: null,
    appliedAt: null,
  };
  await putMutation(mutation);
  notifyQueueChanged();
  if (!navigator.onLine) {
    await requestBackgroundSync();
    return { queued: true };
  }

  const attempt = await attemptMutation(mutation);
  notifyQueueChanged();
  if (attempt.status === "applied") return { queued: false, response: attempt.response };
  if (attempt.status === "conflict") return { queued: true, response: attempt.response };
  if (attempt.retryable) {
    await requestBackgroundSync();
    return { queued: true };
  }
  return { queued: true, response: attempt.response };
}

export async function sendOrQueueSyncMutations(input: {
  scope: string;
  partition: OfflinePartition;
  mutations: SyncMutationInput[];
  label: string;
}): Promise<{ queued: boolean; response?: Response }[]> {
  await assertScopeAllowsPartition(input.scope, input.partition);
  if (input.mutations.some((mutation) => mutation.fieldId !== input.partition.fieldId)) {
    throw new Error("Un lote push solo puede contener mutaciones del fundo particionado.");
  }
  const batches = buildSyncPushBatches(input.mutations);
  const results = [];
  for (const [index, batch] of batches.entries()) {
    const firstId = batch.mutations[0]!.id;
    const result = await sendOrQueueMutation({
      id: `sync:${firstId}:${index}`,
      scope: input.scope,
      partition: input.partition,
      transport: "sync-v1",
      url: "/api/sync",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(batch),
      label: input.label,
    });
    results.push(result);
    if (result.response && !result.response.ok) break;
  }
  return results;
}

export async function listOfflineMutations(scope: string): Promise<OfflineMutation[]> {
  parseOfflineScope(scope);
  const entries = await recoverInterruptedMutations(await getAllStoredMutations());
  const scoped: OfflineMutation[] = [];
  for (const entry of entries) {
    if (isPartitionedMutation(entry) && entry.scope === scope && await scopeAllowsPartition(scope, entry.partition)) scoped.push(entry);
  }
  return scoped.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function resolveOfflineConflict(input: {
  scope: string;
  id: string;
  action: "discard" | "retry";
  payload?: Record<string, unknown>;
}): Promise<void> {
  const stored = await getStoreValue<unknown>(MUTATION_STORE, input.id);
  if (!isPartitionedMutation(stored) || stored.scope !== input.scope || !await scopeAllowsPartition(input.scope, stored.partition) || stored.status !== "conflict") {
    throw new Error("El conflicto ya no está disponible para esta cuenta.");
  }
  const now = new Date().toISOString();
  if (input.action === "retry") {
    const parsed = JSON.parse(stored.body ?? "null") as { mutations?: SyncMutationInput[] };
    if (!Array.isArray(parsed.mutations) || parsed.mutations.length !== 1) throw new Error("Este lote no admite edición manual.");
    const original = parsed.mutations[0]!;
    await sendOrQueueSyncMutations({
      scope: input.scope,
      partition: stored.partition,
      label: `${stored.label} (corregida)`,
      mutations: [{
        ...original,
        id: createOfflineMutationId(),
        clientTs: now,
        payload: (input.payload ?? original.payload) as SyncMutationInput["payload"],
      }],
    });
  }
  await putMutation({
    ...stored,
    status: "applied",
    appliedAt: now,
    updatedAt: now,
    nextAttemptAt: null,
    statusReason: input.action === "discard" ? "Captura descartada manualmente en este dispositivo." : "Captura sustituida por una nueva mutación.",
  });
  notifyQueueChanged();
}

export async function queueOfflineAttachment(input: {
  scope: string;
  session: OfflineSession;
  fieldId: string;
  attachmentId: string;
  entityId: string;
  file: File;
}): Promise<void> {
  const partition = offlinePartitionFromSession(input.session, input.fieldId);
  assertScopeAllowsSession(input.scope, input.session);
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/u.test(input.attachmentId)) throw new Error("El identificador del adjunto no es válido.");
  if (!input.entityId.trim() || input.entityId.length > 160) throw new Error("La captura asociada al adjunto no es válida.");
  if (!new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]).has(input.file.type) || input.file.size < 1 || input.file.size > MAX_OFFLINE_ATTACHMENT_BYTES) {
    throw new Error("La fotografía debe ser JPEG, PNG, WebP o HEIC y no superar 1,5 MB.");
  }
  const now = new Date().toISOString();
  const attachment: OfflineAttachment = {
    id: attachmentStorageKey(partition, input.attachmentId),
    attachmentId: input.attachmentId,
    scope: input.scope,
    partition,
    entityId: input.entityId.trim(),
    filename: input.file.name.slice(0, 200),
    contentType: input.file.type,
    size: input.file.size,
    blob: input.file,
    status: "pending",
    attempts: 0,
    statusReason: null,
    objectKey: null,
    sha256: null,
    createdAt: now,
    updatedAt: now,
  };
  await putStoreValue(ATTACHMENT_STORE, attachment);
  notifyQueueChanged();
}

export async function listOfflineAttachments(scope: string): Promise<OfflineAttachment[]> {
  parseOfflineScope(scope);
  const scoped: OfflineAttachment[] = [];
  for (const entry of await getAllStoreValues<OfflineAttachment>(ATTACHMENT_STORE)) {
    if (entry.scope !== scope || !await scopeAllowsPartition(scope, entry.partition)) continue;
    if (entry.status === "uploading" && Date.parse(entry.updatedAt) < Date.now() - 2 * 60 * 1_000) {
      const recovered: OfflineAttachment = {
        ...entry,
        status: "error",
        statusReason: "La carga se interrumpió y quedó lista para reintentar.",
        updatedAt: new Date().toISOString(),
      };
      await putStoreValue(ATTACHMENT_STORE, recovered);
      scoped.push(recovered);
    } else {
      scoped.push(entry);
    }
  }
  return scoped.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function flushOfflineAttachments(scope: string): Promise<{ sent: number; pending: number; errors: number }> {
  if (!navigator.onLine) {
    const entries = await listOfflineAttachments(scope);
    return { sent: 0, pending: entries.filter((entry) => entry.status !== "applied").length, errors: entries.filter((entry) => entry.status === "error").length };
  }
  const session = await getActiveOfflineSession(scope);
  if (!session) return { sent: 0, pending: (await listOfflineAttachments(scope)).filter((entry) => entry.status !== "applied").length, errors: 0 };
  let sent = 0;
  for (const attachment of (await listOfflineAttachments(scope)).filter((entry) => entry.status === "pending" || entry.status === "error")) {
    if (!attachment.blob || !session.fieldIds.includes(attachment.partition.fieldId)) continue;
    const linkedStatus = await linkedSyncMutationStatus(scope, attachment);
    if (linkedStatus !== "applied") {
      const blocked = {
        ...attachment,
        status: "error" as const,
        statusReason: linkedStatus === "conflict"
          ? "La captura asociada tiene un conflicto; resuélvelo antes de subir la fotografía."
          : linkedStatus === "error"
            ? "La captura asociada todavía no fue aplicada y debe reintentarse."
            : "La fotografía espera que su captura asociada quede aplicada.",
        updatedAt: new Date().toISOString(),
      };
      await putStoreValue(ATTACHMENT_STORE, blocked);
      continue;
    }
    const uploading = { ...attachment, status: "uploading" as const, attempts: attachment.attempts + 1, updatedAt: new Date().toISOString() };
    await putStoreValue(ATTACHMENT_STORE, uploading);
    try {
      const form = new FormData();
      form.set("fieldId", attachment.partition.fieldId);
      form.set("attachmentId", attachment.attachmentId);
      form.set("entityId", attachment.entityId);
      form.set("file", attachment.blob, attachment.filename);
      const response = await fetch("/api/offline/attachments", { method: "POST", body: form, credentials: "same-origin", headers: { "Idempotency-Key": attachment.attachmentId } });
      const body = await response.clone().json().catch(() => null) as { attachment?: { objectKey?: string; sha256?: string }; error?: string } | null;
      if (!response.ok || !body?.attachment?.objectKey || !body.attachment.sha256) {
        await putStoreValue(ATTACHMENT_STORE, { ...uploading, status: "error", statusReason: body?.error ?? "No fue posible subir la fotografía.", updatedAt: new Date().toISOString() });
        if (response.status === 401 || response.status === 403) break;
        continue;
      }
      sent += 1;
      await putStoreValue(ATTACHMENT_STORE, {
        ...uploading,
        blob: null,
        status: "applied",
        statusReason: null,
        objectKey: body.attachment.objectKey,
        sha256: body.attachment.sha256,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      await putStoreValue(ATTACHMENT_STORE, { ...uploading, status: "error", statusReason: "La red se interrumpió durante la carga de la fotografía.", updatedAt: new Date().toISOString() });
      break;
    }
  }
  const final = await listOfflineAttachments(scope);
  notifyQueueChanged();
  return { sent, pending: final.filter((entry) => entry.status !== "applied").length, errors: final.filter((entry) => entry.status === "error").length };
}

async function linkedSyncMutationStatus(
  scope: string,
  attachment: OfflineAttachment,
): Promise<OfflineMutationStatus | "missing"> {
  for (const entry of await getAllStoredMutations()) {
    if (
      !isPartitionedMutation(entry)
      || entry.scope !== scope
      || entry.transport !== "sync-v1"
      || offlinePartitionKey(entry.partition) !== offlinePartitionKey(attachment.partition)
    ) continue;
    try {
      const parsed = JSON.parse(entry.body ?? "null") as { mutations?: SyncMutationInput[] };
      const linked = parsed.mutations?.some((mutation) => mutation.entityId === attachment.entityId
        && mutation.payload?.attachmentId === attachment.attachmentId);
      if (linked) return entry.status;
    } catch {
      // Malformed queue entries never authorize a binary upload.
    }
  }
  return "missing";
}

export async function pullOfflineChanges<T>(input: {
  scope: string;
  partition: OfflinePartition;
  cursor: number;
  limit?: number;
}): Promise<{ events: T[]; nextCursor: number }> {
  await assertScopeAllowsPartition(input.scope, input.partition);
  if (!navigator.onLine) throw new Error("No hay conexión para descargar cambios.");
  const response = await fetch(buildSyncPullPath(input.partition, input.cursor, input.limit), {
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("No fue posible descargar los cambios offline.");
  const result = await response.json() as { events?: T[]; nextCursor?: number };
  if (!Array.isArray(result.events) || !Number.isSafeInteger(result.nextCursor) || result.nextCursor! < input.cursor) {
    throw new Error("El servidor devolvió un cursor offline no válido.");
  }
  await writeOfflineCursor(input.partition, "domain-events", result.nextCursor!);
  return { events: result.events, nextCursor: result.nextCursor! };
}

export async function flushOfflineMutations(scope: string): Promise<{
  sent: number;
  pending: number;
  conflicts: number;
  errors: number;
}> {
  if (!navigator.onLine) {
    const summary = await getOfflineMutationSummary(scope);
    return { sent: 0, pending: activeMutationCount(summary), conflicts: summary.conflict, errors: summary.error };
  }
  const stored = await recoverInterruptedMutations(await getAllStoredMutations());
  const scoped: OfflineMutation[] = [];
  for (const entry of stored) {
    if (isPartitionedMutation(entry) && entry.scope === scope && await scopeAllowsPartition(scope, entry.partition)) scoped.push(entry);
  }
  const partitions = uniquePartitions(scoped);
  const now = new Date().toISOString();
  const ready = partitions
    .flatMap((partition) => selectReadyOfflineMutations(scoped, partition, now))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId));
  let sent = 0;
  for (const mutation of ready) {
    const attempt = await attemptMutation(mutation);
    if (attempt.status === "applied") sent += 1;
    if (!attempt.response || attempt.response.status === 401 || attempt.response.status === 403) break;
  }
  const summary = await getOfflineMutationSummary(scope);
  notifyQueueChanged();
  return { sent, pending: activeMutationCount(summary), conflicts: summary.conflict, errors: summary.error };
}

export async function countOfflineMutations(scope: string): Promise<number> {
  return activeMutationCount(await getOfflineMutationSummary(scope));
}

export async function getOfflineMutationSummary(scope: string): Promise<OfflineMutationSummary> {
  parseOfflineScope(scope);
  const summary = emptySummary();
  for (const entry of await getAllStoredMutations()) {
    if (isPartitionedMutation(entry)) {
      if (entry.scope === scope && await scopeAllowsPartition(scope, entry.partition)) summary[entry.status] += 1;
      continue;
    }
    // V1 records are deliberately quarantined: they lack a trustworthy field partition.
    if (isLegacyMutation(entry) && entry.scope === scope) summary.conflict += 1;
  }
  return summary;
}

export async function putOfflineReadModel<T>(partitionValue: OfflinePartition, name: string, value: T, cursor: number): Promise<void> {
  const partition = normalizeOfflinePartition(partitionValue);
  if (!name.trim()) throw new Error("El read-model offline necesita un nombre.");
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error("El cursor del read-model no es válido.");
  const model: OfflineReadModel<T> & { id: string } = {
    id: readModelStorageKey(partition, name),
    partition,
    name,
    value,
    cursor,
    storedAt: new Date().toISOString(),
  };
  await putStoreValue(READ_MODEL_STORE, model);
}

export async function getOfflineReadModel<T>(partitionValue: OfflinePartition, name: string): Promise<OfflineReadModel<T> | null> {
  const partition = normalizeOfflinePartition(partitionValue);
  const stored = await getStoreValue<OfflineReadModel<T> & { id: string }>(READ_MODEL_STORE, readModelStorageKey(partition, name));
  if (!stored || offlinePartitionKey(stored.partition) !== offlinePartitionKey(partition)) return null;
  return { partition: stored.partition, name: stored.name, value: stored.value, cursor: stored.cursor, storedAt: stored.storedAt };
}

export async function writeOfflineCursor(partitionValue: OfflinePartition, stream: string, cursor: number): Promise<void> {
  const partition = normalizeOfflinePartition(partitionValue);
  if (!stream.trim() || !Number.isSafeInteger(cursor) || cursor < 0) throw new Error("El cursor offline no es válido.");
  await putStoreValue(CURSOR_STORE, {
    id: cursorStorageKey(partition, stream),
    partition,
    stream,
    cursor,
    storedAt: new Date().toISOString(),
  });
}

export async function readOfflineCursor(partitionValue: OfflinePartition, stream: string): Promise<number> {
  const partition = normalizeOfflinePartition(partitionValue);
  const stored = await getStoreValue<{ partition: OfflinePartition; cursor: number }>(CURSOR_STORE, cursorStorageKey(partition, stream));
  return stored && offlinePartitionKey(stored.partition) === offlinePartitionKey(partition) && Number.isSafeInteger(stored.cursor)
    ? stored.cursor
    : 0;
}

async function attemptMutation(mutation: OfflineMutation): Promise<MutationAttempt> {
  const startedAt = new Date().toISOString();
  const syncing = { ...mutation, status: "syncing" as const, attempts: mutation.attempts + 1, updatedAt: startedAt };
  await putMutation(syncing);
  try {
    const response = await fetch(syncing.url, {
      method: syncing.method,
      headers: { ...syncing.headers, "Idempotency-Key": syncing.mutationId },
      body: syncing.body,
      credentials: "same-origin",
    });
    // A 409 is never considered success here. Phase 0 proves exact replays in each 2xx result item.
    const decision = syncing.transport === "sync-v1" && response.ok
      ? await readSyncPushDecision(syncing, response)
      : classifyOfflineResponse({ status: response.status, attempts: syncing.attempts, nowIso: new Date().toISOString(), exactReplay: false });
    await putMutation({
      ...syncing,
      status: decision.status,
      nextAttemptAt: decision.nextAttemptAt,
      statusReason: decision.reason,
      appliedAt: decision.status === "applied" ? new Date().toISOString() : null,
      updatedAt: new Date().toISOString(),
    });
    return { response, status: decision.status, retryable: decision.status === "error" && decision.nextAttemptAt !== null };
  } catch {
    const failedAt = new Date().toISOString();
    await putMutation({
      ...syncing,
      status: "error",
      nextAttemptAt: nextOfflineRetryAt(syncing.attempts, failedAt),
      statusReason: "La red se interrumpió; la captura se conserva para reintentar.",
      updatedAt: failedAt,
    });
    return { status: "error", retryable: true };
  }
}

async function readSyncPushDecision(mutation: OfflineMutation, response: Response) {
  try {
    const request = JSON.parse(mutation.body ?? "null") as { mutations?: { id?: unknown }[] };
    const result = await response.clone().json() as { results?: { id?: unknown; status?: unknown; conflictReason?: unknown }[] };
    const mutationIds = Array.isArray(request.mutations)
      ? request.mutations.map((entry) => typeof entry.id === "string" ? entry.id : "")
      : [];
    return classifySyncPushResult(mutationIds, result.results ?? []);
  } catch {
    return { status: "error" as const, nextAttemptAt: null, reason: "El servidor devolvió una respuesta de sincronización no válida." };
  }
}

function parseOfflineScope(scope: string): [string, string, ...string[]] {
  const parts = scope.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) throw new Error("El alcance offline no contiene cuenta, rol y fundos.");
  return parts as [string, string, ...string[]];
}

async function assertScopeAllowsPartition(scope: string, partition: OfflinePartition): Promise<void> {
  if (!await scopeAllowsPartition(scope, partition)) throw new Error("La partición offline no coincide con la cuenta activa.");
}

async function scopeAllowsPartition(scope: string, partitionValue: OfflinePartition): Promise<boolean> {
  try {
    const partition = normalizeOfflinePartition(partitionValue);
    const scopeParts = parseOfflineScope(scope);
    const membershipId = scopeParts[0];
    const fieldIds = scopeParts.slice(2);
    const expectedMode = membershipId.includes("-demo") || partition.fieldId === "fundo-el-ejemplo" ? "demo" : "personal";
    const legacyMatch = partition.accountMode === expectedMode
      && partition.organizationId === `organization-by-membership:${membershipId}`
      && partition.userSubject === `membership-subject:${membershipId}`
      && fieldIds.includes(partition.fieldId);
    if (legacyMatch) return true;
    const session = await getStoredOfflineSession(scope);
    return Boolean(session
      && partition.accountMode === session.accountMode
      && partition.organizationId === session.organizationId
      && partition.userSubject === session.userSubject
      && session.fieldIds.includes(partition.fieldId));
  } catch {
    return false;
  }
}

function assertSafeMutationRequest(url: string, headers: Record<string, string>): void {
  if (!url.startsWith("/api/") || url.startsWith("//")) throw new Error("La cola offline solo envía a APIs del mismo origen.");
  const forbidden = Object.keys(headers).some((name) => ["authorization", "cookie"].includes(name.toLowerCase()));
  if (forbidden) throw new Error("La cola offline no almacena credenciales.");
}

function mutationStorageKey(partition: OfflinePartition, mutationId: string): string {
  return `mutation|${offlinePartitionKey(partition)}|${encodeURIComponent(mutationId)}`;
}

function readModelStorageKey(partition: OfflinePartition, name: string): string {
  return `read-model|${offlinePartitionKey(partition)}|${encodeURIComponent(name)}`;
}

function cursorStorageKey(partition: OfflinePartition, stream: string): string {
  return `cursor|${offlinePartitionKey(partition)}|${encodeURIComponent(stream)}`;
}

function sessionStorageKey(scope: string): string {
  return `session|${encodeURIComponent(scope)}`;
}

function attachmentStorageKey(partition: OfflinePartition, attachmentId: string): string {
  return `attachment|${offlinePartitionKey(partition)}|${attachmentId}`;
}

function parseOfflineSession(value: unknown, scope: string): OfflineSession {
  const parts = parseOfflineScope(scope);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La sesión offline no es válida.");
  const session = value as Partial<OfflineSession>;
  const fieldIds = Array.isArray(session.fieldIds) ? session.fieldIds.filter((entry): entry is string => typeof entry === "string" && Boolean(entry.trim())).sort() : [];
  if (
    session.version !== 1
    || session.audience !== "fundosmart-offline-v1"
    || typeof session.token !== "string"
    || session.token.split(".").length !== 2
    || typeof session.sessionId !== "string"
    || !["personal", "demo"].includes(String(session.accountMode))
    || session.membershipId !== parts[0]
    || session.role !== parts[1]
    || typeof session.organizationId !== "string"
    || !/^[a-f0-9]{64}$/u.test(String(session.userSubject))
    || JSON.stringify(fieldIds) !== JSON.stringify(parts.slice(2).sort())
    || !Number.isFinite(Date.parse(String(session.issuedAt)))
    || !Number.isFinite(Date.parse(String(session.expiresAt)))
  ) throw new Error("La sesión offline no coincide con la cuenta activa.");
  return { ...session, fieldIds } as OfflineSession;
}

function assertScopeAllowsSession(scope: string, session: OfflineSession): void {
  parseOfflineSession(session, scope);
}

function isPartitionedMutation(value: unknown): value is OfflineMutation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Partial<OfflineMutation>;
  return typeof entry.mutationId === "string"
    && typeof entry.scope === "string"
    && typeof entry.partition === "object"
    && ["pending", "syncing", "conflict", "error", "applied"].includes(String(entry.status));
}

function isLegacyMutation(value: unknown): value is { scope: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && typeof (value as { scope?: unknown }).scope === "string");
}

function uniquePartitions(entries: OfflineMutation[]): OfflinePartition[] {
  return [...new Map(entries.map((entry) => [offlinePartitionKey(entry.partition), entry.partition])).values()];
}

async function recoverInterruptedMutations(entries: unknown[]): Promise<unknown[]> {
  const staleBefore = Date.now() - (2 * 60 * 1000);
  return Promise.all(entries.map(async (entry) => {
    if (!isPartitionedMutation(entry) || entry.status !== "syncing" || Date.parse(entry.updatedAt) > staleBefore) return entry;
    const recovered: OfflineMutation = entry.transport === "sync-v1"
      ? {
          ...entry,
          status: "error",
          nextAttemptAt: new Date().toISOString(),
          statusReason: "La sincronización se interrumpió; el push idempotente puede reintentarse.",
          updatedAt: new Date().toISOString(),
        }
      : {
          ...entry,
          status: "conflict",
          nextAttemptAt: null,
          statusReason: "La respuesta se perdió y el endpoint legado no puede probar un replay exacto.",
          updatedAt: new Date().toISOString(),
        };
    await putMutation(recovered);
    return recovered;
  }));
}

function emptySummary(): OfflineMutationSummary {
  return { pending: 0, syncing: 0, conflict: 0, error: 0, applied: 0 };
}

function activeMutationCount(summary: OfflineMutationSummary): number {
  return summary.pending + summary.syncing + summary.conflict + summary.error;
}

async function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(MUTATION_STORE)) db.createObjectStore(MUTATION_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(READ_MODEL_STORE)) db.createObjectStore(READ_MODEL_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CURSOR_STORE)) db.createObjectStore(CURSOR_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SESSION_STORE)) db.createObjectStore(SESSION_STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(ATTACHMENT_STORE)) db.createObjectStore(ATTACHMENT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function putMutation(value: OfflineMutation): Promise<void> {
  await putStoreValue(MUTATION_STORE, value);
}

async function getAllStoredMutations(): Promise<unknown[]> {
  const db = await openDatabase();
  const value = await requestPromise<unknown[]>(db.transaction(MUTATION_STORE, "readonly").objectStore(MUTATION_STORE).getAll());
  db.close();
  return value;
}

async function putStoreValue(storeName: string, value: unknown): Promise<void> {
  const db = await openDatabase();
  await requestPromise(db.transaction(storeName, "readwrite").objectStore(storeName).put(value));
  db.close();
}

async function getStoreValue<T>(storeName: string, key: string): Promise<T | undefined> {
  const db = await openDatabase();
  const value = await requestPromise<T | undefined>(db.transaction(storeName, "readonly").objectStore(storeName).get(key));
  db.close();
  return value;
}

async function getAllStoreValues<T>(storeName: string): Promise<T[]> {
  const db = await openDatabase();
  const value = await requestPromise<T[]>(db.transaction(storeName, "readonly").objectStore(storeName).getAll());
  db.close();
  return value;
}

function requestPromise<T = void>(request: IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error);
  });
}

async function requestBackgroundSync(): Promise<void> {
  try {
    const registration = await navigator.serviceWorker.ready;
    const sync = (registration as ServiceWorkerRegistration & { sync?: { register(tag: string): Promise<void> } }).sync;
    await sync?.register("fundosmart-mutations");
  } catch {
    // The foreground online listener remains the safe fallback.
  }
}

function notifyQueueChanged(): void {
  window.dispatchEvent(new CustomEvent("fundosmart:offline-queue"));
}
