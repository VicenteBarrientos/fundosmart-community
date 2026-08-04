export const AGENDA_TASK_ACTIONS = Object.freeze([
  "complete",
  "postpone",
  "dismiss",
  "reopen",
  "assign",
]);

export const AGENDA_TASK_STATUSES = Object.freeze([
  "open",
  "completed",
  "postponed",
  "dismissed",
]);

const SOURCES = new Set(["ganado", "leche", "costos", "potreros", "dashboard"]);
const ACTIONS = new Set(AGENDA_TASK_ACTIONS);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,239}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const REVISION = /^[0-9a-f]{16}$/u;
const URGENCY_RANK = Object.freeze({ urgent: 0, today: 1, soon: 2, review: 3 });

export class AgendaRequestError extends Error {
  constructor(message, status = 400, code = "AGENDA_INVALID") {
    super(message);
    this.name = "AgendaRequestError";
    this.status = status;
    this.code = code;
  }
}

export function validateAgendaTaskMutation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalid("La solicitud de agenda no es válida.", "AGENDA_BODY_INVALID");
  }
  const record = value;
  const action = cleanText(record.action);
  const operationId = cleanText(record.operationId).toLowerCase();
  const fieldId = cleanText(record.fieldId);
  const itemKey = cleanText(record.itemKey);
  const signalRevision = cleanText(record.signalRevision).toLowerCase();
  const source = cleanText(record.source);
  const expectedVersion = record.expectedVersion;

  if (!ACTIONS.has(action)) throw invalid("Selecciona una acción de agenda válida.", "AGENDA_ACTION_INVALID");
  if (!UUID.test(operationId)) throw invalid("La operación requiere una clave idempotente válida.", "AGENDA_OPERATION_INVALID");
  if (!IDENTIFIER.test(fieldId) || fieldId.length > 160) throw invalid("Selecciona un fundo válido.", "AGENDA_FIELD_INVALID");
  if (!IDENTIFIER.test(itemKey)) throw invalid("La señal de agenda no es válida.", "AGENDA_ITEM_INVALID");
  if (!REVISION.test(signalRevision)) throw invalid("La revisión de evidencia no es válida.", "AGENDA_REVISION_INVALID");
  if (!SOURCES.has(source) || !sourceMatchesItem(source, itemKey)) {
    throw invalid("La fuente de la señal no coincide con su identificador.", "AGENDA_SOURCE_INVALID");
  }
  if (expectedVersion !== null && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)) {
    throw invalid("Actualiza la agenda antes de guardar este cambio.", "AGENDA_VERSION_INVALID");
  }

  const reason = optionalText(record.reason);
  const scheduledFor = optionalDate(record.scheduledFor);
  const assigneeMembershipId = optionalIdentifier(record.assigneeMembershipId, 180);
  if (["complete", "postpone", "dismiss"].includes(action)) {
    if (!reason || reason.length < 3) {
      throw invalid("Describe brevemente el motivo de esta acción.", "AGENDA_REASON_REQUIRED");
    }
    if (reason.length > 500) throw invalid("El motivo puede tener hasta 500 caracteres.", "AGENDA_REASON_TOO_LONG");
  } else if (reason !== null) {
    throw invalid("Esta acción no acepta un motivo.", "AGENDA_REASON_UNEXPECTED");
  }
  if (action === "postpone") {
    if (!scheduledFor) throw invalid("Selecciona una fecha para posponer.", "AGENDA_DATE_REQUIRED");
  } else if (scheduledFor !== null) {
    throw invalid("Esta acción no acepta una fecha programada.", "AGENDA_DATE_UNEXPECTED");
  }
  if (action !== "assign" && assigneeMembershipId !== null) {
    throw invalid("Esta acción no acepta un responsable.", "AGENDA_ASSIGNEE_UNEXPECTED");
  }

  return {
    action,
    operationId,
    fieldId,
    itemKey,
    signalRevision,
    source,
    expectedVersion,
    reason,
    scheduledFor,
    assigneeMembershipId,
  };
}

export function applyAgendaTaskStates(items = [], states = [], referenceDate) {
  const today = isoDate(referenceDate) ?? new Date().toISOString().slice(0, 10);
  const bySignal = new Map();
  for (const state of states) {
    if (!state || typeof state !== "object") continue;
    const key = signalKey(state.itemKey, state.signalRevision);
    const current = bySignal.get(key);
    if (!current
      || Number(state.version) > Number(current.version)
      || (Number(state.version) === Number(current.version)
        && String(state.updatedAt).localeCompare(String(current.updatedAt)) > 0)) {
      bySignal.set(key, state);
    }
  }

  return items.map((item) => {
    const candidate = bySignal.get(signalKey(item.id, item.revision)) ?? null;
    const taskState = candidate?.fieldId === item.fieldId ? candidate : null;
    const originalUrgency = item.urgency;
    let urgency = originalUrgency;
    let agendaView = "pending";
    if (taskState?.status === "completed" || taskState?.status === "dismissed") {
      agendaView = "closed";
    } else if (taskState?.status === "postponed") {
      if (taskState.scheduledFor && taskState.scheduledFor > today) {
        agendaView = "postponed";
      } else if (URGENCY_RANK[urgency] > URGENCY_RANK.today) {
        urgency = "today";
      }
    }
    return { ...item, urgency, agendaView, originalUrgency, taskState };
  }).sort(compareManagedItems);
}

function compareManagedItems(left, right) {
  return URGENCY_RANK[left.urgency] - URGENCY_RANK[right.urgency]
    || String(left.evidenceDate ?? "9999-12-31").localeCompare(String(right.evidenceDate ?? "9999-12-31"))
    || left.sourceLabel.localeCompare(right.sourceLabel, "es")
    || left.id.localeCompare(right.id);
}

function sourceMatchesItem(source, itemKey) {
  if (itemKey.startsWith("operacion:")) return true;
  if (source === "ganado") return itemKey.startsWith("ganado:");
  if (source === "leche") return itemKey.startsWith("leche:");
  if (source === "potreros") return itemKey.startsWith("potreros:");
  return false;
}

function optionalIdentifier(value, maximum) {
  if (value === null || value === undefined || value === "") return null;
  const candidate = cleanText(value);
  if (!IDENTIFIER.test(candidate) || candidate.length > maximum) {
    throw invalid("El responsable seleccionado no es válido.", "AGENDA_ASSIGNEE_INVALID");
  }
  return candidate;
}

function optionalText(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw invalid("El motivo no es válido.", "AGENDA_REASON_INVALID");
  return value.trim().replace(/\s+/gu, " ");
}

function optionalDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const candidate = cleanText(value);
  if (!isoDate(candidate)) throw invalid("La fecha programada no es válida.", "AGENDA_DATE_INVALID");
  return candidate;
}

function isoDate(value) {
  const candidate = cleanText(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(candidate)) return null;
  const date = new Date(`${candidate}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function signalKey(itemKey, signalRevision) {
  return `${String(itemKey)}\u0000${String(signalRevision)}`;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function invalid(message, code) {
  return new AgendaRequestError(message, 400, code);
}
