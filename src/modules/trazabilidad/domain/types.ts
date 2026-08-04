export const TRACEABILITY_DATA_MODES = ["real", "demo"] as const;
export type TraceabilityDataMode = (typeof TRACEABILITY_DATA_MODES)[number];

export const ESTABLISHMENT_TYPES = ["dairy", "beef", "mixed", "other"] as const;
export type EstablishmentType = (typeof ESTABLISHMENT_TYPES)[number];

export const ESTABLISHMENT_STATUSES = ["active", "inactive"] as const;
export type EstablishmentStatus = (typeof ESTABLISHMENT_STATUSES)[number];

export type LivestockEstablishment = {
  id: string;
  organizationId: string;
  fieldId: string;
  officialRup: string | null;
  displayRup: string;
  type: EstablishmentType;
  status: EstablishmentStatus;
  dataMode: TraceabilityDataMode;
  isOfficialIdentity: boolean;
  georef: TraceabilityEstablishmentGeoref | null;
};

export type TraceabilityCoordinate = [number, number];

export type TraceabilityStoredPolygon =
  | TraceabilityCoordinate[]
  | { outer: TraceabilityCoordinate[]; holes: TraceabilityCoordinate[][] };

export type TraceabilityEstablishmentGeoref = {
  schemaVersion: "fundosmart.traceability.establishment-georef.v1";
  source: "authorized_field_and_active_paddocks";
  fieldId: string;
  fieldBoundary: TraceabilityCoordinate[] | null;
  activePaddocks: Array<{
    id: string;
    geometry: TraceabilityStoredPolygon;
  }>;
};

export const DIIO_DEVICE_TYPES = ["double_ear_tag", "ear_button", "ruminal_bolus"] as const;
export type DiioDeviceType = (typeof DIIO_DEVICE_TYPES)[number];

export const DIIO_STATUSES = ["available", "assigned", "lost", "replaced", "retired"] as const;
export type DiioStatus = (typeof DIIO_STATUSES)[number];

export type DiioDevice = {
  id: string;
  organizationId: string;
  fieldId: string;
  officialNumber: string;
  deviceType: DiioDeviceType;
  rfidId: string | null;
  animalId: string | null;
  status: DiioStatus;
  assignedAt: string | null;
  endedAt: string | null;
  replacesDeviceId: string | null;
  replacedByDeviceId: string | null;
  lastTransitionKey: string | null;
  version: number;
};

export type DiioTransitionAction = "assign" | "report_lost" | "replace" | "retire";

export type TraceabilityMovementStatus = "draft" | "issued" | "annulled";
export type TraceabilityDeclarationStatus = "draft" | "declared" | "annulled";
export type TraceabilityDocumentStorageStatus = "pending" | "stored" | "compensation_pending";
export type TraceabilityImportSourceKind = "sipec_file" | "cliex_dbf" | "manual_template";
export type TraceabilityImportStageStatus = "staged" | "committed" | "expired";

export type TraceabilityImportCommitReceipt = {
  schemaVersion: "fundosmart.traceability.import-commit-receipt.v1";
  stageId: string;
  status: "committed";
  accepted: number;
  committedAt: string;
  requestHash: string;
  idempotencyKeyHash: string;
};

export type DiioTransitionCommand = {
  action: DiioTransitionAction;
  idempotencyKey: string;
  occurredAt: string;
  actorId: string;
  animalId?: string;
};

export type TraceabilityInventoryEntry = {
  id: string;
  organizationId: string;
  fieldId: string;
  trackingMode: "individual" | "summary";
  animalId: string | null;
  diio: string | null;
  speciesCode: string;
  categoryCode: string;
  quantity: number;
  status: "active" | "inactive";
  locationRup: string | null;
};

export type TraceabilityValidationIssue = {
  severity: "error" | "warning";
  code: string;
  field: string;
  message: string;
};

export type OfficialDocumentMetadata = {
  schemaVersion: "fundosmart.traceability.document.v1";
  documentId: string;
  kind: "FMA" | "DEA";
  revision: number;
  generatedAt: string;
  formVersion: string;
  state: "draft" | "issued";
  folio?: string;
  dataMode: TraceabilityDataMode;
  fakeData: boolean;
  officiallySubmittable: false;
  supersedesDocumentId: string | null;
  immutableAfterIssue: readonly ["documentId", "revision", "folio", "sha256", "objectKey"];
};

export type OfficialDocumentProjection<TContent = Record<string, unknown>> = {
  metadata: OfficialDocumentMetadata;
  content: TContent;
  sha256Input: string;
};

export type TraceabilityImportConflict = {
  code: string;
  rowNumbers: number[];
  officialNumber: string | null;
  animalExternalId: string | null;
  existingDeviceId: string | null;
  message: string;
};

export type StagedDiioImportRow = {
  rowNumber: number;
  sourceRecordId: string;
  organizationId: string;
  fieldId: string;
  rup: string;
  officialNumber: string;
  animalExternalId: string;
  deviceType: DiioDeviceType;
  rfidId: string | null;
};
