import type {
  DiioDevice,
  DiioTransitionCommand,
  LivestockEstablishment,
  OfficialDocumentProjection,
  StagedDiioImportRow,
  TraceabilityImportConflict,
  TraceabilityInventoryEntry,
  TraceabilityValidationIssue,
} from "./types";

export type TraceabilityValidation = {
  valid: boolean;
  errors: TraceabilityValidationIssue[];
  warnings: TraceabilityValidationIssue[];
};

export const TRACEABILITY_DOCUMENT_SCHEMA_VERSION: "fundosmart.traceability.document.v1";
export const DIIO_DEVICE_TYPES: readonly ["double_ear_tag", "ear_button", "ruminal_bolus"];
export const DIIO_STATUSES: readonly ["available", "assigned", "lost", "replaced", "retired"];
export const ESTABLISHMENT_TYPES: readonly ["dairy", "beef", "mixed", "other"];
export const ESTABLISHMENT_STATUSES: readonly ["active", "inactive"];
export const SAG_DRAFT_LABEL: "BORRADOR DECLARABLE SAG - NO DECLARADO";
export const SAG_DRAFT_STATUS: "draft_not_declared";
export const SAG_DEA_FORM_VERSION: "2025-03-05";
export const SAG_FMA_FORM_VERSION: "2024-08-08";
export const SAG_MAX_FMA_DIIO: 45;

export function normalizeDiio(value: unknown): string;
export function isValidDiio(value: unknown): boolean;
export function normalizeRup(value: unknown): string;
export function stableStringify(value: unknown): string;

export function normalizeEstablishmentIdentity(input: Partial<{
  id: string;
  organizationId: string;
  fieldId: string;
  rup: string;
  type: string;
  status: string;
  dataMode: string;
}> | null | undefined): { validation: TraceabilityValidation; establishment: LivestockEstablishment | null };

export function validateDiioDevice(value: Partial<DiioDevice> | null | undefined): TraceabilityValidation;

export function decideDiioTransition(input: {
  current: DiioDevice;
  replacement?: DiioDevice | null;
  activeAssignments?: DiioDevice[];
  command: DiioTransitionCommand;
}): {
  validation: TraceabilityValidation;
  replay: boolean;
  updates: readonly DiioDevice[];
  event: Readonly<Record<string, unknown>> | null;
};

export function normalizeTraceabilityInventory(input: {
  organizationId: string;
  fieldId: string;
  entries: Array<Partial<TraceabilityInventoryEntry> & Record<string, unknown>>;
}): { validation: TraceabilityValidation; entries: readonly TraceabilityInventoryEntry[] };

export function reconcileDiioInventory(input: {
  organizationId: string;
  fieldId: string;
  entries: Array<Partial<TraceabilityInventoryEntry> & Record<string, unknown>>;
  devices: DiioDevice[];
}): {
  validation: TraceabilityValidation;
  findings: ReadonlyArray<{
    code: string;
    animalId: string | null;
    officialNumber: string | null;
    deviceIds: string[];
  }>;
};

export function buildFmaDocumentProjections(input: Record<string, unknown>): {
  validation: TraceabilityValidation;
  projections: ReadonlyArray<OfficialDocumentProjection>;
};

export function buildDeaDocumentProjection(input: Record<string, unknown>): {
  validation: TraceabilityValidation;
  projection: OfficialDocumentProjection | null;
};

export function stageDiioImport(input: {
  organizationId: string;
  fieldId: string;
  rup: string;
  sourceKind: "sipec_file" | "cliex_dbf" | "manual_template";
  rows: Array<Record<string, unknown>>;
  existingDevices?: DiioDevice[];
}): Readonly<{
  validation: TraceabilityValidation;
  accepted: StagedDiioImportRow[];
  unchanged: StagedDiioImportRow[];
  conflicts: TraceabilityImportConflict[];
  rowIssues: Array<TraceabilityValidationIssue & { rowNumber: number }>;
  summary: { total: number; accepted: number; unchanged: number; conflicts: number; invalidRows: number };
  canonicalStage: string;
}>;
