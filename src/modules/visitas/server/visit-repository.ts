import type {
  CloseWorkVisitInput,
  CloseWorkVisitResult,
  CreateWorkVisitInput,
  VisitItem,
  WorkVisit,
} from "../domain/types.ts";
import {
  buildOriginCommitOperations,
  detectItemTargetCollisions,
  validateClinicalGuardrail,
  validateWorkVisitInput,
  VisitRuleError,
} from "../domain/visit-rules.mjs";
import crypto from "node:crypto";

const inMemoryWorkVisits = new Map<string, WorkVisit>();

export function resetInMemoryWorkVisitsStore(): void {
  inMemoryWorkVisits.clear();
}

export async function createWorkVisit(input: CreateWorkVisitInput): Promise<WorkVisit> {
  validateWorkVisitInput(input);

  const activeVisits = Array.from(inMemoryWorkVisits.values()).filter(
    (v) => v.fieldId === input.fieldId && (v.status === "planned" || v.status === "in_progress"),
  );
  const collisions = detectItemTargetCollisions(activeVisits, input.items);
  if (collisions.length > 0) {
    throw new VisitRuleError(
      `Existen ${collisions.length} destinos en otras visitas activas del fundo.`,
      "TARGET_COLLISION_DETECTED",
      collisions,
    );
  }

  const now = new Date().toISOString();
  const visitId = `visit_${crypto.randomBytes(12).toString("hex")}`;

  const items: VisitItem[] = input.items.map((item, index) => ({
    id: `item_${visitId}_${index + 1}`,
    visitId,
    targetKind: item.targetKind,
    targetId: item.targetId.trim(),
    targetLabel: item.targetLabel.trim(),
    lotName: item.lotName?.trim() ?? null,
    reason: item.reason.trim(),
    supportMetric: item.supportMetric?.trim() ?? null,
    status: "pending",
    observation: null,
    outcomeValue: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
  }));

  const visit: WorkVisit = {
    id: visitId,
    fieldId: input.fieldId,
    organizationId: input.organizationId,
    visitKind: input.visitKind,
    visitDate: input.visitDate,
    professionalName: input.professionalName.trim(),
    title: input.title.trim(),
    notes: input.notes?.trim() ?? null,
    status: "planned",
    items,
    version: 1,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  inMemoryWorkVisits.set(visitId, visit);
  return JSON.parse(JSON.stringify(visit));
}

export async function getWorkVisit(visitId: string): Promise<WorkVisit | null> {
  const visit = inMemoryWorkVisits.get(visitId);
  return visit ? JSON.parse(JSON.stringify(visit)) : null;
}

export async function listWorkVisits(input: {
  fieldId: string;
  status?: WorkVisit["status"];
}): Promise<WorkVisit[]> {
  const visits = Array.from(inMemoryWorkVisits.values())
    .filter((v) => v.fieldId === input.fieldId && (!input.status || v.status === input.status))
    .sort((a, b) => b.visitDate.localeCompare(a.visitDate));
  return JSON.parse(JSON.stringify(visits));
}

export async function updateWorkVisit(input: {
  visitId: string;
  expectedVersion: number;
  items?: VisitItem[];
  status?: WorkVisit["status"];
  notes?: string | null;
}): Promise<WorkVisit> {
  const visit = inMemoryWorkVisits.get(input.visitId);
  if (!visit) {
    throw new VisitRuleError("La visita solicitada no existe.", "VISIT_NOT_FOUND");
  }
  if (visit.version !== input.expectedVersion) {
    throw new VisitRuleError(
      "La visita fue modificada por otro usuario.",
      "OPTIMISTIC_LOCK_CONFLICT",
      { currentVersion: visit.version, expectedVersion: input.expectedVersion },
    );
  }

  const now = new Date().toISOString();
  if (input.notes !== undefined) visit.notes = input.notes?.trim() ?? null;
  if (input.status) visit.status = input.status;
  if (input.items) visit.items = input.items;
  visit.version += 1;
  visit.updatedAt = now;

  inMemoryWorkVisits.set(visit.id, visit);
  return JSON.parse(JSON.stringify(visit));
}

export async function closeWorkVisitAndCommitOrigin(
  input: CloseWorkVisitInput,
): Promise<CloseWorkVisitResult> {
  const visit = inMemoryWorkVisits.get(input.visitId);
  if (!visit) {
    throw new VisitRuleError("La visita solicitada no existe.", "VISIT_NOT_FOUND");
  }

  // Idempotency replay check
  if (visit.status === "completed") {
    const originOperations = buildOriginCommitOperations(visit, visit.items);
    return {
      visit: JSON.parse(JSON.stringify(visit)),
      reused: true,
      committedOriginCount: originOperations.length,
      originDetails: originOperations.map((op) => ({
        itemId: op.itemId,
        targetKind: op.targetKind,
        targetId: op.targetId,
        originEntity: op.originEntity,
        originId: `committed_${op.itemId}`,
      })),
    };
  }

  if (visit.version !== input.expectedVersion) {
    throw new VisitRuleError(
      "La visita fue modificada antes de su cierre.",
      "OPTIMISTIC_LOCK_CONFLICT",
      { currentVersion: visit.version, expectedVersion: input.expectedVersion },
    );
  }

  const now = new Date().toISOString();
  const outcomeMap = new Map(input.outcomes.map((o) => [o.itemId, o]));

  // Apply outcomes & validate clinical guardrail
  for (const item of visit.items) {
    const outcome = outcomeMap.get(item.id);
    if (outcome) {
      if (outcome.observation) {
        validateClinicalGuardrail(outcome.observation);
        item.observation = outcome.observation.trim();
      }
      item.status = outcome.status;
      item.outcomeValue = outcome.outcomeValue ?? null;
      if (outcome.status === "completed") {
        item.completedAt = now;
      }
      item.updatedAt = now;
    }
  }

  const originOperations = buildOriginCommitOperations(visit, input.outcomes);

  visit.status = "completed";
  visit.completedAt = now;
  visit.version += 1;
  visit.updatedAt = now;
  if (input.notes) visit.notes = input.notes.trim();

  inMemoryWorkVisits.set(visit.id, visit);

  return {
    visit: JSON.parse(JSON.stringify(visit)),
    reused: false,
    committedOriginCount: originOperations.length,
    originDetails: originOperations.map((op) => ({
      itemId: op.itemId,
      targetKind: op.targetKind,
      targetId: op.targetId,
      originEntity: op.originEntity,
      originId: `committed_${op.itemId}`,
    })),
  };
}
