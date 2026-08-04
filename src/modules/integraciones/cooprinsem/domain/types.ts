export const COOPRINSEM_SOURCE_SYSTEM = "cooprinsem" as const;

export const COOPRINSEM_IMPORT_FORMATS = ["dbf", "xlsx", "xls", "csv"] as const;
export type CooprinsemImportFormat = (typeof COOPRINSEM_IMPORT_FORMATS)[number];

export const COOPRINSEM_IMPORT_JOB_STATUSES = [
  "uploaded",
  "parsing",
  "preview_ready",
  "importing",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;
export type CooprinsemImportJobStatus = (typeof COOPRINSEM_IMPORT_JOB_STATUSES)[number];

export const COOPRINSEM_IMPORT_ROW_STATUSES = [
  "pending",
  "valid",
  "warning",
  "error",
  "imported",
  "skipped",
] as const;
export type CooprinsemImportRowStatus = (typeof COOPRINSEM_IMPORT_ROW_STATUSES)[number];

export const COOPRINSEM_IMPORT_ERROR_SEVERITIES = ["warning", "error"] as const;
export type CooprinsemImportErrorSeverity = (typeof COOPRINSEM_IMPORT_ERROR_SEVERITIES)[number];

export const COOPRINSEM_IMPORT_ERROR_STATUSES = ["open", "resolved", "ignored"] as const;
export type CooprinsemImportErrorStatus = (typeof COOPRINSEM_IMPORT_ERROR_STATUSES)[number];

export type ImportRecord = Record<string, unknown>;

export const COOPRINSEM_SOURCE_TABLE_NAMES = ["_Traspasos.DBF", "PreDetimp.dbf", "CalidadLeche.dbf"] as const;
export type CooprinsemSourceTable = (typeof COOPRINSEM_SOURCE_TABLE_NAMES)[number];

export type CooprinsemImportIssue = {
  id?: string;
  fieldName: string | null;
  ruleCode: string;
  severity: CooprinsemImportErrorSeverity;
  message: string;
  sourceValue: unknown;
  status?: CooprinsemImportErrorStatus;
  resolutionNotes?: string | null;
  resolvedBy?: string | null;
  resolvedAt?: string | null;
};

export type CooprinsemImportPreviewRow = {
  id: string;
  recordNumber: number;
  rawRecord: ImportRecord;
  normalizedRecord: ImportRecord | null;
  status: CooprinsemImportRowStatus;
  issues: CooprinsemImportIssue[];
};

export type CooprinsemImportSummary = {
  rowCount: number;
  validRowCount: number;
  warningRowCount: number;
  errorRowCount: number;
  skippedRowCount: number;
  fileIssueCount: number;
};

export type CooprinsemImportPreview = {
  id: string;
  fieldId: string;
  fieldName: string;
  sourceTable: CooprinsemSourceTable;
  originalFilename: string;
  sha256: string;
  mappingVersion: string;
  effectiveAt: string | null;
  status: CooprinsemImportJobStatus;
  createdAt: string;
  reused: boolean;
  summary: CooprinsemImportSummary;
  rows: CooprinsemImportPreviewRow[];
};

export type CooprinsemImportHistoryItem = {
  id: string;
  fieldId: string;
  fieldName: string;
  sourceTable: CooprinsemSourceTable;
  originalFilename: string;
  status: CooprinsemImportJobStatus;
  effectiveAt: string | null;
  createdAt: string;
  previewedAt: string | null;
  confirmedAt: string | null;
  failureMessage: string | null;
  openIssueCount: number;
  importedRowCount: number;
  summary: CooprinsemImportSummary;
};

export type CooprinsemProjectionIdentifier = {
  kind: "cooprinsem_numvaca" | "cooprinsem_numvaca_dv" | "cooprinsem_nombre" | "cooprinsem_nombre_nuevo" | "rp" | "barcode";
  value: string;
  normalizedValue: string;
  isPrimary: boolean;
};

export type CooprinsemProjectionRowAction =
  | "create_animal"
  | "link_animal"
  | "create_quality_sample"
  | "already_imported"
  | "already_imported_quality_sample"
  | "excluded"
  | "conflict";

export type CooprinsemMilkControlProjection = {
  action: "create" | "already_imported";
  controlDate: string;
  morningLiters: number | null;
  afternoonLiters: number | null;
  thirdMilkingLiters: number | null;
  totalLiters: number;
  fatPct: number | null;
  proteinPct: number | null;
  somaticCellCount: number | null;
};

export type CooprinsemMilkQualityProjection = {
  action: "create" | "already_imported";
  sampledAt: string;
  period: string;
  fatPercent: number | null;
  proteinPercent: number | null;
  totalSolidsPercent: number | null;
  somaticCellCount: number | null;
  somaticCellCountUnit: "cells_per_ml" | "thousand_cells_per_ml" | null;
  bacterialCount: number | null;
  bacterialCountUnit: "cfu_per_ml" | "thousand_cfu_per_ml" | null;
};

export type CooprinsemProjectionRow = {
  importRowId: string;
  recordNumber: number;
  action: CooprinsemProjectionRowAction;
  animalId: string | null;
  animalTag: string | null;
  lotId: string | null;
  lotName: string | null;
  sourceKey: string | null;
  groupCode: string | null;
  identifiers: CooprinsemProjectionIdentifier[];
  milkControl: CooprinsemMilkControlProjection | null;
  milkQualitySample: CooprinsemMilkQualityProjection | null;
  matchedBy: string[];
  issues: string[];
};

export type CooprinsemImportProjectionPlan = {
  importJobId: string;
  fieldId: string;
  fieldName: string;
  sourceTable: CooprinsemSourceTable;
  originalFilename: string;
  status: CooprinsemImportJobStatus;
  confirmedAt: string | null;
  ready: boolean;
  blockers: string[];
  historyAssessment: {
    format: "fundosmart.cooprinsem-history-assessment.v2";
    writeEnabled: false;
    eligibleRowCount: number;
    milkUnitContract: {
      requiredVersion: "cooprinsem-leche-litros.v1";
      confirmed: boolean;
      canonicalUnit: "liters" | null;
    };
    milkControlCandidateCount: number;
    milkControlReadyCount: number;
    milkControlBlockedCount: number;
    reproductiveServiceCandidateCount: number;
    reproductiveServiceReadyCount: number;
    reproductiveServiceBlockedCount: number;
    blockers: string[];
  };
  fieldIdentifier: { kind: "cooprinsem_predio"; value: string; normalizedValue: string; action: "create" | "existing" } | null;
  summary: {
    rowCount: number;
    createAnimalCount: number;
    linkAnimalCount: number;
    alreadyImportedCount: number;
    excludedRowCount: number;
    conflictRowCount: number;
    identifierWriteCount: number;
    projectableMilkControlCount: number;
    alreadyImportedMilkControlCount: number;
    projectableMilkQualitySampleCount: number;
    alreadyImportedMilkQualitySampleCount: number;
    unresolvedGroupCount: number;
  };
  rows: CooprinsemProjectionRow[];
  rowsTruncated: boolean;
};

export type CooprinsemImportConfirmation = {
  importJobId: string;
  status: "completed" | "completed_with_errors";
  createdAnimalCount: number;
  linkedAnimalCount: number;
  importedRowCount: number;
  excludedRowCount: number;
  identifierWriteCount: number;
  importedMilkControlCount: number;
  importedMilkQualitySampleCount: number;
  confirmedAt: string;
  reused: boolean;
};

export type CooprinsemGroupImpact = {
  stagedRowCount: number;
  pendingRowCount: number;
  importedRowCount: number;
  quarantineAnimalCount: number;
};

export type CooprinsemGroupMappingItem = {
  id: string;
  groupCode: string;
  normalizedGroupCode: string;
  lotId: string;
  lotName: string;
  validFrom: string | null;
  impact: CooprinsemGroupImpact;
};

export type CooprinsemGroupCandidate = {
  groupCode: string;
  normalizedGroupCode: string;
  impact: CooprinsemGroupImpact;
};

export type CooprinsemGroupMappingPlan = {
  fieldId: string;
  fieldName: string;
  action: "create" | "change" | "deactivate" | "noop";
  groupCode: string;
  normalizedGroupCode: string;
  currentMapping: CooprinsemGroupMappingItem | null;
  targetLot: { id: string; name: string } | null;
  impact: CooprinsemGroupImpact;
  ready: boolean;
  blockers: string[];
  confirmationToken: string;
};

export type CooprinsemQuarantineAnimal = {
  animalId: string;
  tag: string;
  importJobId: string;
  importRowId: string;
  sourceTable: string;
  sourceKey: string | null;
};

export type CooprinsemQuarantineReassignmentPlan = {
  fieldId: string;
  fieldName: string;
  groupCode: string;
  normalizedGroupCode: string;
  sourceLotId: string;
  sourceLotName: string;
  targetLotId: string | null;
  targetLotName: string | null;
  candidateCount: number;
  candidates: CooprinsemQuarantineAnimal[];
  rowsTruncated: boolean;
  ready: boolean;
  blockers: string[];
  confirmationToken: string;
};

export type CooprinsemGenealogyResolutionStatus = "ready" | "unmatched" | "conflict";

export type CooprinsemGenealogyResolutionRow = {
  offspringId: string;
  birthId: string;
  occurredAt: string;
  damAnimalId: string;
  damTag: string;
  temporaryIdentifier: string;
  sex: "female" | "male" | "unknown";
  status: CooprinsemGenealogyResolutionStatus;
  candidateAnimalId: string | null;
  candidateTag: string | null;
  matchedBy: string[];
  issues: string[];
};

export type CooprinsemGenealogyPlan = {
  fieldId: string;
  fieldName: string;
  ready: boolean;
  summary: {
    unresolvedCount: number;
    readyCount: number;
    unmatchedCount: number;
    conflictCount: number;
  };
  rows: CooprinsemGenealogyResolutionRow[];
  rowsTruncated: boolean;
  confirmationToken: string;
};

export type CooprinsemMilkUnitContractPlan = {
  format: "fundosmart.cooprinsem-milk-unit-contract-plan.v1";
  fieldId: string;
  fieldName: string;
  contractVersion: "cooprinsem-leche-litros.v1";
  canonicalUnit: "liters";
  sourceFields: string[];
  confirmed: boolean;
  contractId: string | null;
  confirmedAt: string | null;
  candidateCount: number;
  readyAfterConfirmationCount: number;
  blockedAfterConfirmationCount: number;
  confirmationPhrase: "LECHE*=LITROS";
  confirmationToken: string;
};

export type CooprinsemHistoryServicePlanRow = {
  animalId: string;
  animalTag: string;
  occurredAt: string | null;
  sireIdentifier: string | null;
  roles: string[];
  state: "ready" | "blocked";
  action: "create" | "reuse" | "blocked";
  sourceCount: number;
  blockers: string[];
};

export type CooprinsemHistoryServicePlan = {
  format: "fundosmart.cooprinsem-history-service-plan.v1";
  fieldId: string;
  fieldName: string;
  ready: boolean;
  summary: {
    candidateCount: number;
    readyCount: number;
    createCount: number;
    reuseCount: number;
    blockedCount: number;
    sourceLinkCount: number;
  };
  rows: CooprinsemHistoryServicePlanRow[];
  rowsTruncated: boolean;
  confirmationPhrase: "CONFIRMAR CUBIERTAS";
  confirmationToken: string;
};

export type CooprinsemHistoryConfiguration = {
  milkUnitContract: CooprinsemMilkUnitContractPlan;
  services: CooprinsemHistoryServicePlan;
};

export type CooprinsemConfigurationDashboard = {
  fieldId: string;
  fieldName: string;
  lots: Array<{
    id: string;
    name: string;
    animalCount: number;
    trackingMode: "summary" | "individual";
  }>;
  mappings: CooprinsemGroupMappingItem[];
  unconfiguredGroups: CooprinsemGroupCandidate[];
  quarantine: {
    lotId: string;
    lotName: string;
    animalCount: number;
  };
  genealogy: CooprinsemGenealogyPlan;
  history: CooprinsemHistoryConfiguration;
};

export type CooprinsemGroupMappingConfirmation = {
  action: "created" | "changed" | "deactivated" | "reused";
  mappingId: string | null;
  confirmedAt: string;
};

export type CooprinsemQuarantineReassignmentConfirmation = {
  movedAnimalCount: number;
  sourceLotId: string;
  targetLotId: string;
  confirmedAt: string;
};

export type CooprinsemGenealogyConfirmation = {
  linkedOffspringCount: number;
  confirmedAt: string;
};

export type CooprinsemMilkUnitContractConfirmation = {
  action: "created" | "reused";
  contractId: string;
  confirmedAt: string;
};

export type CooprinsemHistoryServiceConfirmation = {
  confirmedServiceCount: number;
  createdServiceCount: number;
  reusedServiceCount: number;
  sourceLinkCount: number;
  confirmedAt: string;
};

export type CooprinsemImportIssueItem = {
  id: string;
  importJobId: string;
  importRowId: string;
  recordNumber: number;
  fieldId: string;
  fieldName: string;
  sourceTable: CooprinsemSourceTable;
  originalFilename: string;
  rawRecord: ImportRecord;
  fieldNameSource: string | null;
  ruleCode: string;
  severity: CooprinsemImportErrorSeverity;
  message: string;
  sourceValue: unknown;
  status: CooprinsemImportErrorStatus;
  resolutionNotes: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  createdAt: string;
};

export type CooprinsemImportDashboard = {
  imports: CooprinsemImportHistoryItem[];
  issues: CooprinsemImportIssueItem[];
  totals: {
    importCount: number;
    rowCount: number;
    openIssueCount: number;
    resolvedIssueCount: number;
    ignoredIssueCount: number;
  };
};

export type FundoSmartPortableRestorePlan = {
  format: "fundosmart.portable-backup.v1";
  scope: {
    type: "field" | "import";
    id: string;
    name: string;
    organizationId: string;
    organizationName: string;
    fieldId: string;
    fieldName: string;
  };
  generatedAt: string;
  assessment: "ready" | "conflicts" | "no_changes";
  writeEnabled: false;
  totals: {
    sectionCount: number;
    rowCount: number;
    insertableRowCount: number;
    unchangedRowCount: number;
    conflictRowCount: number;
    referenceIssueCount: number;
    originalFileCount: number;
  };
  sections: Array<{
    section: string;
    rowCount: number;
    insertableRowCount: number;
    unchangedRowCount: number;
    conflictRowCount: number;
    status: "unsupported" | "conflict" | "insertable" | "unchanged";
  }>;
  conflicts: Array<{ section: string; key: string; reason: string }>;
  blockers: string[];
  warnings: string[];
};

export type FundoSmartRestoreConfirmation = {
  token: string;
  expiresAt: string;
  snapshotSha256: string;
  planSha256: string;
  requiredPhrase: string;
  writeEnabled: false;
};

export type FundoSmartRecoveryPreparationReceipt = {
  recoveryJobId: string;
  status: "prepared";
  preparedAt: string;
  expectedRowCount: number;
  originalFileCount: number;
  executionEnabled: false;
  idempotent: boolean;
};

export type FundoSmartRecoveryJobStatus = "prepared" | "copying" | "applying" | "verifying" | "succeeded" | "compensating" | "failed";
export type FundoSmartRecoveryObjectStatus = "pending" | "copied" | "verified" | "compensated" | "failed";
export type FundoSmartRecoveryEventType =
  | "prepared"
  | "lease_claimed"
  | "lease_renewed"
  | "lease_recovered"
  | "lease_released"
  | "checkpoint_advanced"
  | "object_copied"
  | "object_verified"
  | "object_failed"
  | "compensation_started"
  | "object_compensated"
  | "succeeded"
  | "failed";

export type CooprinsemOriginalIntegrityStatus = "healthy" | "missing" | "size_mismatch" | "sha_mismatch" | "metadata_mismatch";

export type CooprinsemOriginalIntegrityDashboard = {
  fieldId: string;
  fieldName: string;
  organizationId: string;
  checkedAt: string;
  truncated: boolean;
  limit: number;
  totals: { checkedCount: number; healthyCount: number; missingCount: number; mismatchCount: number };
  items: Array<{
    importJobId: string;
    originalFilename: string;
    sourceTable: string;
    expectedSizeBytes: number;
    storedSizeBytes: number | null;
    sha256: string;
    status: CooprinsemOriginalIntegrityStatus;
    issues: string[];
    importedAt: string;
    storedAt: string | null;
  }>;
};

export type CooprinsemOriginalDeepVerification = {
  importJobId: string;
  fieldId: string;
  originalFilename: string;
  checkedAt: string;
  status: "healthy" | "missing" | "size_mismatch" | "content_mismatch" | "metadata_mismatch";
  expectedSizeBytes: number;
  storedSizeBytes: number | null;
  expectedSha256: string;
  calculatedSha256: string | null;
  issues: string[];
};

export type CooprinsemIntegritySweepStatus = "pending" | "running" | "completed" | "completed_with_issues" | "failed";
export type CooprinsemIntegritySweepTrigger = "manual" | "scheduled" | "request_heartbeat";
export type CooprinsemIntegrityIncidentStatus = "open" | "resolved";
export type CooprinsemIntegrityIncidentType = "missing" | "size_mismatch" | "content_mismatch" | "metadata_mismatch" | "size_limit";

export type CooprinsemIntegritySweepDashboard = {
  fieldId: string;
  fieldName: string;
  state: null | {
    cycleId: string;
    status: CooprinsemIntegritySweepStatus;
    lastTrigger: CooprinsemIntegritySweepTrigger;
    checkedCount: number;
    healthyCount: number;
    missingCount: number;
    mismatchCount: number;
    readBytes: number;
    lastStartedAt: string | null;
    lastBatchAt: string | null;
    completedAt: string | null;
    nextRunAt: string;
    lastError: string | null;
  };
  openIncidents: Array<{
    id: string;
    importJobId: string;
    originalFilename: string;
    issueType: CooprinsemIntegrityIncidentType;
    summary: string;
    expectedSizeBytes: number;
    storedSizeBytes: number | null;
    firstDetectedAt: string;
    lastDetectedAt: string;
  }>;
};

export type CooprinsemIntegritySweepBatchResult = {
  outcome: "processed" | "busy" | "not_due" | "no_fields";
  fieldId: string | null;
  cycleId: string | null;
  processedCount: number;
  healthyCount: number;
  issueCount: number;
  readBytes: number;
  completed: boolean;
};

export type CooprinsemRetentionDashboard = {
  fieldId: string;
  fieldName: string;
  organizationId: string;
  evaluatedAt: string;
  status: "empty" | "retain_all";
  policy: {
    id: string;
    version: number;
    mode: "retain_only";
    deletionEnabled: false;
    approvedRetentionDays: null;
    lifecycleExpirationEnabled: false;
  };
  inventory: {
    oldestImportedAt: string | null;
    newestImportedAt: string | null;
  };
  totals: {
    originalCount: number;
    totalSizeBytes: number;
    retainCount: number;
    eligibleForDeletionCount: 0;
    openIntegrityIncidentCount: number;
  };
  gates: Array<{
    code: string;
    label: string;
    satisfied: boolean;
    detail: string;
  }>;
};
