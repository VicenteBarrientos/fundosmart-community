const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const DISALLOWED_CLINICAL_TERMS = [
  /\bpenicilina\b/i,
  /\boxitetraciclina\b/i,
  /\bantibiótico\b/i,
  /\bantibiotico\b/i,
  /\bdosis\b/i,
  /\btratamiento de\b/i,
  /\breceta\b/i,
  /\bprescripción\b/i,
  /\bprescripcion\b/i,
];

export class VisitRuleError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = "VisitRuleError";
    this.code = code;
    this.details = details;
  }
}

export function validateWorkVisitInput(input) {
  if (!input || typeof input !== "object") {
    throw new VisitRuleError("La visita requiere un objeto válido.", "VISIT_INPUT_INVALID");
  }
  if (!input.fieldId || typeof input.fieldId !== "string" || !input.fieldId.trim()) {
    throw new VisitRuleError("La visita requiere un campo (fieldId) válido.", "VISIT_FIELD_REQUIRED");
  }
  if (!input.visitKind || (input.visitKind !== "veterinary" && input.visitKind !== "agronomic")) {
    throw new VisitRuleError("El tipo de visita debe ser 'veterinary' o 'agronomic'.", "VISIT_KIND_INVALID");
  }
  if (!input.visitDate || !DATE_REGEX.test(input.visitDate)) {
    throw new VisitRuleError("La fecha de visita debe tener el formato YYYY-MM-DD.", "VISIT_DATE_INVALID");
  }
  if (!input.professionalName || typeof input.professionalName !== "string" || !input.professionalName.trim()) {
    throw new VisitRuleError("La visita requiere el nombre del profesional a cargo.", "VISIT_PROFESSIONAL_REQUIRED");
  }
  if (!input.title || typeof input.title !== "string" || !input.title.trim()) {
    throw new VisitRuleError("La visita requiere un título descriptivo.", "VISIT_TITLE_REQUIRED");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw new VisitRuleError("La visita debe contener al menos un ítem de trabajo.", "VISIT_ITEMS_EMPTY");
  }

  input.items.forEach((item, index) => {
    if (!item.targetKind || (item.targetKind !== "animal" && item.targetKind !== "paddock")) {
      throw new VisitRuleError(`El ítem #${index + 1} tiene un tipo de destino inválido.`, "VISIT_ITEM_TARGET_INVALID");
    }
    if (!item.targetId || typeof item.targetId !== "string" || !item.targetId.trim()) {
      throw new VisitRuleError(`El ítem #${index + 1} requiere un identificador de destino.`, "VISIT_ITEM_TARGET_ID_REQUIRED");
    }
    if (!item.reason || typeof item.reason !== "string" || !item.reason.trim()) {
      throw new VisitRuleError(`El ítem #${index + 1} requiere un motivo de trabajo.`, "VISIT_ITEM_REASON_REQUIRED");
    }
  });
}

export function validateClinicalGuardrail(text) {
  if (!text || typeof text !== "string") return;
  for (const regex of DISALLOWED_CLINICAL_TERMS) {
    if (regex.test(text)) {
      throw new VisitRuleError(
        "El resultado registra observaciones y métricas, nunca diagnósticos clínicos, fármacos o dosis.",
        "CLINICAL_GUARDRAIL_VIOLATION",
      );
    }
  }
}

export function detectItemTargetCollisions(activeVisits, newItems) {
  const collisions = [];
  const activeTargets = new Map();

  for (const visit of activeVisits ?? []) {
    if (visit.status === "completed" || visit.status === "cancelled") continue;
    for (const item of visit.items ?? []) {
      const key = `${item.targetKind}:${item.targetId}`;
      activeTargets.set(key, { visitId: visit.id, visitTitle: visit.title, visitDate: visit.visitDate });
    }
  }

  for (const item of newItems ?? []) {
    const key = `${item.targetKind}:${item.targetId}`;
    if (activeTargets.has(key)) {
      const existing = activeTargets.get(key);
      collisions.push({
        targetKind: item.targetKind,
        targetId: item.targetId,
        targetLabel: item.targetLabel,
        activeVisitId: existing.visitId,
        activeVisitTitle: existing.visitTitle,
        activeVisitDate: existing.visitDate,
      });
    }
  }

  return collisions;
}

export function buildOriginCommitOperations(visit, outcomes) {
  const operations = [];
  const outcomeMap = new Map((outcomes ?? []).map((o) => [o.itemId ?? o.id, o]));

  for (const item of visit.items) {
    const outcome = outcomeMap.get(item.id);
    if (!outcome || outcome.status !== "completed") continue;

    const observationText = (outcome.observation ?? "").trim();
    validateClinicalGuardrail(observationText);

    if (item.targetKind === "animal") {
      operations.push({
        itemId: item.id,
        targetKind: "animal",
        targetId: item.targetId,
        originEntity: "livestock_reproductive_events",
        payload: {
          animalId: item.targetId,
          eventType: "observation",
          occurredAt: visit.visitDate,
          notes: observationText || item.reason,
          metadata: {
            visitId: visit.id,
            supportMetric: item.supportMetric ?? null,
            outcomeValue: outcome.outcomeValue ?? null,
          },
        },
      });
    } else if (item.targetKind === "paddock") {
      operations.push({
        itemId: item.id,
        targetKind: "paddock",
        targetId: item.targetId,
        originEntity: "field_visit_paddocks",
        payload: {
          paddockId: item.targetId,
          visitId: visit.id,
          observedAt: visit.visitDate,
          currentBiomassKgDmHa: typeof outcome.outcomeValue === "number" ? outcome.outcomeValue : null,
          notes: observationText || item.reason,
        },
      });
    }
  }

  return operations;
}
