export const IMPORT_SOURCE_SYSTEMS = [
  "cooprinsem",
  "cooprinsem_soil",
  "watts",
  "agronomic_advisor",
  "survet",
  "generic",
] as const;
export type ImportSourceSystem = (typeof IMPORT_SOURCE_SYSTEMS)[number];

export const IMPORT_FORMATS = ["dbf", "xlsx", "xls", "csv", "pdf"] as const;
export type ImportFormat = (typeof IMPORT_FORMATS)[number];

export const IMPORT_JOB_STATUSES = [
  "uploaded",
  "parsing",
  "preview_ready",
  "importing",
  "completed",
  "completed_with_errors",
  "failed",
  "cancelled",
] as const;
export type ImportJobStatus = (typeof IMPORT_JOB_STATUSES)[number];

export const IMPORT_ROW_STATUSES = [
  "pending",
  "valid",
  "warning",
  "error",
  "imported",
  "skipped",
] as const;
export type ImportRowStatus = (typeof IMPORT_ROW_STATUSES)[number];

export type ImportErrorSeverity = "warning" | "error";
export type ImportErrorStatus = "open" | "resolved" | "ignored";
export type ImportRecord = Record<string, unknown>;

export const IMPORT_PROFILE_KEYS = [
  "cooprinsem.soil_report.pdf.v1",
  "watts.visit_report.pdf.v1",
  "agronomic.visit_report.pdf.v1",
  "survet.milk_control.xlsx.v1",
  "generic.pasture_measurements.table.v1",
  "livestock.inventory.xlsx.v1",
] as const;
export type ImportProfileKey = (typeof IMPORT_PROFILE_KEYS)[number];

export type ImportColumnMapping = {
  externalPaddockKey: string;
  biomassKgDmHa: string;
  observedDate: string | null;
  areaHa: string | null;
  notes: string | null;
};

export type WattsVisitPaddock = {
  sequenceNumber: number;
  externalPaddockKey: string;
  plannedEntryDate: string;
  projectedBiomassKgDmHa: number;
  areaHa: number;
  dailyAreaHa: number;
  calculatedDays: number;
  adjustedDays: number;
  adjustedIntakeKgDmCowDay: number;
};

export type WattsVisitSnapshot = {
  kind: "watts_visit_report";
  schemaVersion: "fundosmart.watts.visit-report.v1";
  producer: {
    name: string;
    code: string;
  };
  visitDate: string;
  nextVisitDate: string | null;
  reportGeneratedLocal: string | null;
  herd: {
    massCows: number | null;
    milkingCows: number | null;
    averageLitersPerCowDay: number | null;
    bodyCondition: number | null;
  };
  grazing: {
    dayAvailabilityKgDmHa: number | null;
    nightAvailabilityKgDmHa: number | null;
    dayResidueKgDmHa: number | null;
    nightResidueKgDmHa: number | null;
    dayConsumptionKgDm: number | null;
    nightConsumptionKgDm: number | null;
    dayStripHa: number | null;
    nightStripHa: number | null;
    dayKgDmCowDay: number | null;
    nightKgDmCowDay: number | null;
    totalKgDmCowDay: number | null;
  };
  diet: {
    pastureParticipationPercent: number | null;
    pastureKgDmCowDay: number | null;
    reportedTotalPrice: number | null;
  };
  plan: {
    startDate: string;
    targetKgDmCowDay: number;
    growthRateKgDmHaDay: number;
    cowCount: number;
    residueKgDmHa: number;
    totalAreaHa: number;
    totalAdjustedDays: number;
    paddocks: WattsVisitPaddock[];
  };
  notes: string[];
  limitations: string[];
};

export type AgronomicVisitActionGroup = {
  sequenceNumber: number;
  heading: string;
  recommendationText: string;
  externalPaddockKeys: string[];
  reportedGroupAreaHa: number | null;
};

export type AgronomicVisitSnapshot = {
  kind: "agronomic_visit_report";
  schemaVersion: "fundosmart.agronomic.visit-report.v1";
  sourceLabel: "Asesoría agronómica";
  visitDate: string;
  sectionHeading: string;
  reportedIndicators: Array<{
    label: string;
    value: string;
  }>;
  actionGroups: AgronomicVisitActionGroup[];
  limitations: string[];
};

export type TabularImportDocument = {
  kind: "tabular_pasture_measurements";
  schemaVersion: "fundosmart.tabular-pasture-measurements.v1";
  headers: string[];
  sheetName: string | null;
  sourceRowCount: number;
  truncated: boolean;
};

export type SurvetMilkControlDocument = {
  kind: "survet_milk_control";
  schemaVersion: "fundosmart.survet.milk-control.v1";
  worksheetName: string;
  producerName: string | null;
  farmName: string | null;
  generatedAtLocal: string;
  controlDate: string;
  controlPeriod: string | null;
  previousRcsPeriodLabel: string | null;
  currentRcsPeriodLabel: string;
  sourceRowCount: number;
  sourceMilkUnit: "kg";
  rcsReportedUnit: "thousand_cells_per_ml";
  rcsCanonicalUnit: "cells_per_ml";
  rcsMultiplier: 1000;
  limitations: string[];
};

export type SoilAnalysisRangeAssessment = "below" | "within" | "above";

export type SoilAnalysisReportResult = {
  sequenceNumber: number;
  analyteCode: string;
  analyteName: string;
  unit: string;
  value: number;
  idealMin: number;
  idealMax: number;
  idealRangeText: string;
  reportedClassification: string | null;
  rangeAssessment: SoilAnalysisRangeAssessment;
  methodKey: string | null;
  methodLabel: string | null;
};

export type CooprinsemSoilReportDocument = {
  kind: "cooprinsem_soil_report";
  schemaVersion: "fundosmart.cooprinsem.soil-report.v1";
  provider: {
    key: "cooprinsem";
    laboratoryName: "Laboratorio Análisis de Suelo y Forraje";
  };
  sampleId: string;
  folio: string;
  receivedDate: string;
  reportDate: string;
  analysisType: "ANÁLISIS BÁSICO SUELO";
  sampledBy: string | null;
  reportedSamplingDepthCm: number | null;
  idealRangeReferenceDepthCm: number | null;
  analyticalMethodsText: string;
  results: SoilAnalysisReportResult[];
  accreditationClaim: {
    presentInDocument: boolean;
    verificationStatus: "reported_unverified";
  };
  documentaryVerification: {
    signatureStatus: "not_checked";
    qrStatus: "not_checked";
    use: "technical_result_only";
    originalRequired: true;
  };
  limitations: string[];
};

export type ImportDocumentSnapshot =
  | CooprinsemSoilReportDocument
  | WattsVisitSnapshot
  | AgronomicVisitSnapshot
  | SurvetMilkControlDocument
  | TabularImportDocument;

export type ImportCenterIssue = {
  fieldName: string | null;
  ruleCode: string;
  severity: ImportErrorSeverity;
  message: string;
  sourceValue: unknown;
};

export type ImportCenterPreviewRow = {
  id: string;
  recordNumber: number;
  rawRecord: ImportRecord;
  normalizedRecord: ImportRecord | null;
  status: ImportRowStatus;
  issues: ImportCenterIssue[];
};

export type ImportCenterSummary = {
  rowCount: number;
  validRowCount: number;
  warningRowCount: number;
  errorRowCount: number;
  skippedRowCount: number;
  fileIssueCount: number;
};

export type ImportCenterPreview = {
  id: string;
  fieldId: string;
  fieldName: string;
  sourceSystem: ImportSourceSystem;
  sourceFormat: ImportFormat;
  profileKey: ImportProfileKey;
  profileVersion: string;
  originalFilename: string;
  effectiveAt: string | null;
  status: ImportJobStatus;
  createdAt: string;
  confirmedAt: string | null;
  revision: string;
  reused: boolean;
  mapping: ImportColumnMapping | null;
  soilLink: {
    paddockId: string;
    paddockName: string;
  } | null;
  document: ImportDocumentSnapshot;
  summary: ImportCenterSummary;
  rows: ImportCenterPreviewRow[];
};

export type ImportPaddockReconciliation = {
  importRowId: string;
  paddockId: string;
};

export type ImportCenterHistoryItem = {
  id: string;
  fieldId: string;
  fieldName: string;
  sourceSystem: string;
  sourceFormat: string;
  profileKey: string | null;
  originalFilename: string;
  status: ImportJobStatus;
  effectiveAt: string | null;
  createdAt: string;
  confirmedAt: string | null;
  failureMessage: string | null;
  rowCount: number;
  warningRowCount: number;
  errorRowCount: number;
};

export type ImportCenterDashboard = {
  imports: ImportCenterHistoryItem[];
  totals: {
    importCount: number;
    confirmedCount: number;
    pendingReviewCount: number;
    errorCount: number;
  };
};

export type ImportConfirmationOutcome =
  | "inserted"
  | "updated"
  | "unchanged"
  | "conflict"
  | "rejected";

export type ImportConfirmationRowOutcome = {
  recordNumber: number;
  outcome: ImportConfirmationOutcome;
};

export type ImportConfirmationReceipt = {
  receiptVersion: "fundosmart.import-confirmation-receipt.v1";
  importJobId: string;
  targetEntity:
    | "field_visit"
    | "livestock_milk_control_batch"
    | "soil_analysis_report"
    | "livestock_inventory_batch";
  targetId: string;
  visitId: string | null;
  status: "completed" | "completed_with_errors";
  rowCount: number;
  insertedRowCount: number;
  updatedRowCount: number;
  unchangedRowCount: number;
  conflictRowCount: number;
  rejectedRowCount: number;
  rowOutcomes: ImportConfirmationRowOutcome[];
  importedRowCount: number;
  skippedRowCount: number;
  confirmedAt: string;
  reused: boolean;
};
