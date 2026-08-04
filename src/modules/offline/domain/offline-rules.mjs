export const OFFLINE_MUTATION_STATUSES = ["pending", "syncing", "conflict", "error", "applied"];
export const MAX_OFFLINE_SYNC_BATCH_SIZE = 50;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const MIN_RETRY_DELAY_MS = 2 * 1000;

export function normalizeOfflinePartition(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("La partición offline no es válida.");
  }
  const accountMode = String(value.accountMode ?? "").trim();
  const organizationId = String(value.organizationId ?? "").trim();
  const userSubject = String(value.userSubject ?? "").trim();
  const fieldId = String(value.fieldId ?? "").trim();
  if (!["personal", "demo"].includes(accountMode)) throw new TypeError("El modo de cuenta offline no es válido.");
  if (!organizationId || !userSubject || !fieldId) {
    throw new TypeError("La organización, el usuario y el fundo son obligatorios para operar offline.");
  }
  return { accountMode, organizationId, userSubject, fieldId };
}

export function createOfflineMutationId(nowMs = Date.now(), randomBytes) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || nowMs > 281_474_976_710_655) {
    throw new TypeError("La fecha del identificador offline no es válida.");
  }
  const random = randomBytes ?? crypto.getRandomValues(new Uint8Array(10));
  if (!(random instanceof Uint8Array) || random.byteLength !== 10) {
    throw new TypeError("El identificador offline necesita 80 bits aleatorios.");
  }
  let timestamp = nowMs;
  let encodedTime = "";
  for (let index = 0; index < 10; index += 1) {
    encodedTime = CROCKFORD[timestamp % 32] + encodedTime;
    timestamp = Math.floor(timestamp / 32);
  }
  let bits = 0;
  let buffer = 0;
  let encodedRandom = "";
  for (const byte of random) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encodedRandom += CROCKFORD[(buffer >>> bits) & 31];
      buffer &= (1 << bits) - 1;
    }
  }
  return `${encodedTime}${encodedRandom}`;
}

export function offlinePartitionKey(value) {
  const partition = normalizeOfflinePartition(value);
  return [partition.accountMode, partition.organizationId, partition.userSubject, partition.fieldId]
    .map((part) => encodeURIComponent(part))
    .join("|");
}

export function sameOfflinePartition(left, right) {
  return offlinePartitionKey(left) === offlinePartitionKey(right);
}

export function selectReadyOfflineMutations(entries, partition, nowIso) {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new TypeError("La fecha de sincronización no es válida.");
  return entries
    .filter((entry) => sameOfflinePartition(entry.partition, partition))
    .filter((entry) => entry.status === "pending" || (
      entry.status === "error"
      && typeof entry.nextAttemptAt === "string"
      && Date.parse(entry.nextAttemptAt) <= now
    ))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.mutationId.localeCompare(right.mutationId));
}

export function classifyOfflineResponse({ status, attempts, nowIso, exactReplay = false }) {
  if (status >= 200 && status < 300) return { status: "applied", nextAttemptAt: null, reason: null };
  if (status === 409 && exactReplay) return { status: "applied", nextAttemptAt: null, reason: null };
  if (status === 409) return { status: "conflict", nextAttemptAt: null, reason: "El servidor informó un conflicto que requiere revisión." };
  if (status === 401 || status === 403) {
    return { status: "error", nextAttemptAt: null, reason: "La sesión debe revalidarse antes de sincronizar." };
  }
  if (status === 428) {
    return {
      status: "error",
      nextAttemptAt: nextOfflineRetryAt(attempts, nowIso),
      reason: "Debes revisar la versión legal vigente; la captura sigue guardada y se reintentará después.",
    };
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return {
      status: "error",
      nextAttemptAt: nextOfflineRetryAt(attempts, nowIso),
      reason: "El servidor no pudo aplicar la captura; se reintentará con espera incremental.",
    };
  }
  return { status: "error", nextAttemptAt: null, reason: "La captura fue rechazada y necesita corrección manual." };
}

export function classifySyncPushResult(mutationIds, results) {
  if (!Array.isArray(mutationIds) || mutationIds.length === 0 || new Set(mutationIds).size !== mutationIds.length) {
    return { status: "error", nextAttemptAt: null, reason: "El lote local de sincronización no es válido." };
  }
  if (!Array.isArray(results) || results.length !== mutationIds.length) {
    return { status: "error", nextAttemptAt: null, reason: "El servidor devolvió un resultado de sincronización incompleto." };
  }
  const expected = new Set(mutationIds);
  const seen = new Set();
  for (const result of results) {
    if (!result || typeof result !== "object" || !expected.has(result.id) || seen.has(result.id)) {
      return { status: "error", nextAttemptAt: null, reason: "El servidor devolvió identidades de sincronización inesperadas." };
    }
    seen.add(result.id);
  }
  const unresolved = results.filter((result) => result.status !== "applied");
  if (unresolved.length > 0) {
    const reason = unresolved.find((result) => typeof result.conflictReason === "string" && result.conflictReason.trim())?.conflictReason;
    return { status: "conflict", nextAttemptAt: null, reason: reason?.trim() || "Una mutación del lote requiere revisión." };
  }
  return { status: "applied", nextAttemptAt: null, reason: null };
}

export function nextOfflineRetryAt(attempts, nowIso) {
  const now = Date.parse(nowIso);
  if (!Number.isFinite(now)) throw new TypeError("La fecha de reintento no es válida.");
  const safeAttempts = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  const delay = Math.min(MAX_RETRY_DELAY_MS, MIN_RETRY_DELAY_MS * (2 ** Math.min(safeAttempts - 1, 10)));
  return new Date(now + delay).toISOString();
}

export function buildSyncPushBatches(mutations) {
  if (!Array.isArray(mutations) || mutations.length === 0) throw new TypeError("Agrega mutaciones para sincronizar.");
  const batches = [];
  for (let index = 0; index < mutations.length; index += MAX_OFFLINE_SYNC_BATCH_SIZE) {
    batches.push({ mutations: mutations.slice(index, index + MAX_OFFLINE_SYNC_BATCH_SIZE) });
  }
  return batches;
}

export function buildSyncPullPath(partitionValue, cursor, limit = 50) {
  const partition = normalizeOfflinePartition(partitionValue);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new TypeError("El cursor offline no es válido.");
  const boundedLimit = Number.isSafeInteger(limit) && limit >= 1 && limit <= 100 ? limit : 50;
  const query = new URLSearchParams({
    cursor: String(cursor),
    fieldId: partition.fieldId,
    limit: String(boundedLimit),
  });
  return `/api/sync?${query.toString()}`;
}
