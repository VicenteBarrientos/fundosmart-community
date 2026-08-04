import { validateGeographicSyncMutation } from "../../potreros/sync/geographic-sync-rules.mjs";

const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SUPPORTED_ENTITIES = new Set([
  "field_observation",
  "field_note",
  "livestock_weighing",
  "livestock_health",
  "livestock_estrus",
  "livestock_movement",
  "paddock_geometry",
  "field_landmark",
]);
const APPEND_ENTITIES = new Set([
  "field_observation",
  "livestock_weighing",
  "livestock_health",
  "livestock_estrus",
  "livestock_movement",
]);
const FINANCIAL_ENTITY_PATTERN = /(?:finance|financial|cost|expense|payment|settlement)/iu;

export const MAX_SYNC_BATCH_SIZE = 50;
export const MAX_SYNC_PAYLOAD_BYTES = 64 * 1024;

export function validateSyncBatch(value) {
  if (!Array.isArray(value) || value.length === 0) return "Agrega al menos una mutación para sincronizar.";
  if (value.length > MAX_SYNC_BATCH_SIZE) return `La sincronización admite hasta ${MAX_SYNC_BATCH_SIZE} mutaciones por lote.`;
  return null;
}

export function validateSyncMutation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "La mutación no es válida.";
  if (!ULID_PATTERN.test(String(value.id ?? ""))) return "La mutación necesita un ULID válido.";
  if (!String(value.fieldId ?? "").trim()) return "La mutación necesita un fundo.";
  if (!String(value.entityId ?? "").trim()) return "La mutación necesita una entidad identificable.";
  if (FINANCIAL_ENTITY_PATTERN.test(String(value.entity ?? ""))) return "Las mutaciones financieras no se sincronizan desde el cliente.";
  if (!SUPPORTED_ENTITIES.has(value.entity)) return "El tipo de entidad todavía no admite sincronización.";
  if (!ISO_TIMESTAMP_PATTERN.test(String(value.clientTs ?? "")) || !Number.isFinite(Date.parse(value.clientTs))) {
    return "La mutación necesita una fecha UTC válida.";
  }
  if (!value.payload || typeof value.payload !== "object" || Array.isArray(value.payload)) return "La carga de la mutación no es válida.";
  if (new TextEncoder().encode(stableStringify(value.payload)).byteLength > MAX_SYNC_PAYLOAD_BYTES) {
    return "La carga de la mutación supera el máximo permitido.";
  }
  if (APPEND_ENTITIES.has(value.entity) && !["create", "append"].includes(value.op)) {
    return "La observación de terreno solo admite anexos.";
  }
  if (value.entity === "field_note" && !["create", "update"].includes(value.op)) {
    return "La nota de terreno solo admite creación o actualización.";
  }
  const captureError = validateLivestockCapture(value.entity, value.payload);
  if (captureError) return captureError;
  const geographicError = validateGeographicSyncMutation(value);
  if (geographicError) return geographicError;
  if (value.op === "update" && !String(value.expectedVersion ?? "").trim()) {
    return "La actualización necesita la versión que leyó el dispositivo.";
  }
  return null;
}

function validateLivestockCapture(entity, payload) {
  if (!String(entity).startsWith("livestock_")) return null;
  if (Object.prototype.hasOwnProperty.call(payload, "fieldId")) return "El alcance del fundo no se acepta dentro de la carga.";
  if (entity === "livestock_weighing") {
    if (!text(payload?.lotId, 160) || !isDate(payload?.recordedAt)) return "El pesaje necesita lote y fecha válidos.";
    if (!Array.isArray(payload?.entries) || payload.entries.length < 1 || payload.entries.length > 40) return "El pesaje admite entre 1 y 40 animales.";
    for (const entry of payload.entries) {
      if (!text(entry?.animalId, 160) || !Number.isFinite(entry?.weightKg) || entry.weightKg <= 0 || entry.weightKg > 2_000) return "Cada pesaje necesita animal y peso válido.";
    }
  }
  if (entity === "livestock_health") {
    if (!text(payload?.animalId, 160) || !isDate(payload?.occurredAt)) return "El evento sanitario necesita animal y fecha válidos.";
    if (!new Set(["observation", "diagnosis", "treatment", "vaccination", "withdrawal_clearance"]).has(payload?.eventType)) return "El tipo de evento sanitario no es válido.";
  }
  if (entity === "livestock_estrus") {
    if (!text(payload?.animalId, 160) || !isDate(payload?.occurredAt)) return "El celo necesita animal y fecha válidos.";
  }
  if (entity === "livestock_movement") {
    if (!isDate(payload?.occurredAt) || !text(payload?.destinationRup, 32)) return "El movimiento necesita fecha y RUP de destino.";
    if (!Array.isArray(payload?.animalIds) || payload.animalIds.length < 1 || payload.animalIds.length > 45 || payload.animalIds.some((id) => !text(id, 160))) return "El movimiento admite entre 1 y 45 animales.";
  }
  return null;
}

function text(value, maximum) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : "";
}

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? "")) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

export function decideSyncMutation({ mutation, existing, latestVersion, allowedFieldIds }) {
  const error = validateSyncMutation(mutation);
  if (error) return { action: "reject", reason: error };
  if (!allowedFieldIds.includes(mutation.fieldId)) {
    return { action: "reject", reason: "El fundo no está disponible para esta cuenta." };
  }
  if (existing) {
    if (!sameMutation(existing, mutation)) {
      return { action: "reject", reason: "El ULID ya pertenece a otra mutación." };
    }
    if (existing.status !== "pending") return { action: "replay", reason: existing.conflictReason ?? null };
  }
  if (mutation.entity === "field_note") {
    if (mutation.op === "create" && latestVersion) {
      return { action: "conflict", reason: "La nota ya existe en el servidor." };
    }
    if (mutation.op === "update" && mutation.expectedVersion !== latestVersion) {
      return { action: "conflict", reason: "La nota cambió desde la última sincronización." };
    }
  }
  return { action: "apply", reason: null };
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameMutation(existing, mutation) {
  return existing.fieldId === mutation.fieldId
    && existing.entity === mutation.entity
    && existing.entityId === mutation.entityId
    && existing.op === mutation.op
    && existing.clientTs === mutation.clientTs
    && (existing.expectedVersion ?? null) === (mutation.expectedVersion ?? null)
    && stableStringify(existing.payload) === stableStringify(mutation.payload);
}
