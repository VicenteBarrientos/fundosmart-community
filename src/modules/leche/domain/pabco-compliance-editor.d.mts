import type {
  PabcoComplianceItem,
  PabcoComplianceRequirement,
  PabcoComplianceStatus,
} from "../../../core/domain/types";

export type PabcoComplianceEditorState = {
  fieldId: string;
  requirement: PabcoComplianceRequirement;
  status: PabcoComplianceStatus;
  validFrom: string;
  validUntil: string;
  reminderAt: string;
  evidence: string;
  notes: string;
};

export function resolvePabcoComplianceEditor(
  items: ReadonlyArray<PabcoComplianceItem>,
  fieldId: string,
  requirement: PabcoComplianceRequirement,
  defaultValidFrom: string,
): PabcoComplianceEditorState;
