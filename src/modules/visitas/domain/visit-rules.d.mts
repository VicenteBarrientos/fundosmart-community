import type {
  CreateWorkVisitInput,
  VisitItemOutcomeInput,
  VisitItemTargetKind,
  WorkVisit,
} from "./types";

export class VisitRuleError extends Error {
  code: string;
  details: unknown;
  constructor(message: string, code: string, details?: unknown);
}

export function validateWorkVisitInput(input: CreateWorkVisitInput): void;
export function validateClinicalGuardrail(text: string | null | undefined): void;

export type TargetCollision = {
  targetKind: VisitItemTargetKind;
  targetId: string;
  targetLabel: string;
  activeVisitId: string;
  activeVisitTitle: string;
  activeVisitDate: string;
};

export function detectItemTargetCollisions(
  activeVisits: WorkVisit[],
  newItems: CreateWorkVisitInput["items"],
): TargetCollision[];

export type OriginCommitOperation = {
  itemId: string;
  targetKind: VisitItemTargetKind;
  targetId: string;
  originEntity: string;
  payload: Record<string, unknown>;
};

export function buildOriginCommitOperations(
  visit: WorkVisit,
  outcomes: Array<VisitItemOutcomeInput | VisitItem>,
): OriginCommitOperation[];
