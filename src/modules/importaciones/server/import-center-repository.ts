import { getDb } from "@/db";
import {
  fieldVisits,
  fields,
  importErrors,
  importJobs,
  importJobSpecs,
  importRows,
  livestockAnimalIdentifiers,
  livestockAnimals,
  livestockLots,
  livestockMilkControls,
  paddocks,
  soilAnalysisReports,
  soilAnalysisResults,
} from "@/db/schema";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import {
  assertCurrentImportActorAccess,
  ImportAccessChangedError,
  type ImportActorAccess,
  type ImportFieldAccess,
  type StagedPreviewRow,
} from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import type {
  AgronomicVisitActionGroup,
  ImportCenterDashboard,
  ImportCenterIssue,
  ImportCenterPreview,
  ImportCenterSummary,
  ImportColumnMapping,
  ImportConfirmationReceipt,
  ImportConfirmationRowOutcome,
  ImportDocumentSnapshot,
  ImportPaddockReconciliation,
  ImportProfileKey,
  ImportRecord,
  SoilAnalysisRangeAssessment,
} from "../domain/types";
import {
  mapPastureRows,
  mappingSummary,
  PastureMappingError,
  validatePastureMapping,
} from "./pasture-mapping.mjs";
import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import crypto from "node:crypto";
import type {
  ParsedLivestockInventoryRow,
} from "./livestock-inventory-parser.mjs";
import {
  buildLivestockInventoryOperations,
  buildLivestockInventoryReceiptOutcomes,
  evaluateLivestockInventoryPlanReadiness,
  planLivestockInventoryImport,
} from "./livestock-inventory-plan.mjs";

const CENTER_SOURCES = ["cooprinsem_soil", "watts", "agronomic_advisor", "survet", "generic"] as const;
type CenterSource = (typeof CENTER_SOURCES)[number];

const PREVIEW_ROW_LIMIT = 200;
const BATCH_STATEMENT_LIMIT = 700;
const CONFIRMATION_PROFILE_CONTRACTS = {
  "cooprinsem.soil_report.pdf.v1": {
    mode: "insert_only",
    receiptTargetEntity: "soil_analysis_report",
    sourceSystem: "cooprinsem_soil",
    targetEntity: "soil_analysis_result",
  },
  "watts.visit_report.pdf.v1": {
    mode: "insert_only",
    receiptTargetEntity: "field_visit",
    sourceSystem: "watts",
    targetEntity: "field_visit_paddock",
  },
  "agronomic.visit_report.pdf.v1": {
    mode: "insert_only",
    receiptTargetEntity: "field_visit",
    sourceSystem: "agronomic_advisor",
    targetEntity: "field_visit_recommendation",
  },
  "survet.milk_control.xlsx.v1": {
    mode: "insert_only",
    receiptTargetEntity: "livestock_milk_control_batch",
    sourceSystem: "survet",
    targetEntity: "livestock_milk_control",
  },
  "generic.pasture_measurements.table.v1": {
    mode: "insert_only",
    receiptTargetEntity: "field_visit",
    sourceSystem: "generic",
    targetEntity: "field_visit_paddock",
  },
  "livestock.inventory.xlsx.v1": {
    mode: "insert_only",
    receiptTargetEntity: "livestock_inventory_batch",
    sourceSystem: "generic",
    targetEntity: "livestock_inventory",
  },
} as const satisfies Record<ImportProfileKey, {
  mode: "insert_only";
  receiptTargetEntity: ImportConfirmationReceipt["targetEntity"];
  sourceSystem: CenterSource;
  targetEntity: string;
}>;
type ImportConfirmationReceiptBase = Omit<
  ImportConfirmationReceipt,
  | "receiptVersion"
  | "rowCount"
  | "insertedRowCount"
  | "updatedRowCount"
  | "unchangedRowCount"
  | "conflictRowCount"
  | "rejectedRowCount"
  | "rowOutcomes"
>;

export class ImportCenterError extends Error {
  constructor(message: string, public code = "IMPORT_CENTER_INVALID") {
    super(message);
    this.name = "ImportCenterError";
  }
}

export async function saveImportJobSpec(input: {
  importJobId: string;
  organizationId: string;
  fieldId: string;
  fieldIds: string[];
  parsingStartedAt: string;
  sourceSystem: CenterSource;
  profileKey: ImportProfileKey;
  profileVersion: string;
  document: ImportDocumentSnapshot;
  effectiveAt: string;
  updatedBy: string;
}): Promise<void> {
  if (input.fieldIds.length === 0) throw new ImportCenterError("El fundo dejó de estar disponible.", "IMPORT_SCOPE_CHANGED");
  const client = getDb().$client;
  const fieldsJson = JSON.stringify(input.fieldIds);
  const documentJson = JSON.stringify(input.document);
  const now = new Date().toISOString();
  const insertSpec = client.prepare(`
    INSERT INTO import_job_specs (
      import_job_id, organization_id, field_id, profile_key, profile_version,
      mapping_json, document_json, updated_by, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM import_jobs AS current_job
      INNER JOIN fields AS current_field ON current_field.id = current_job.field_id
      WHERE current_job.id = ?
        AND current_job.organization_id = ?
        AND current_job.field_id = ?
        AND current_job.source_system = ?
        AND current_job.status = 'parsing'
        AND current_job.started_at = ?
        AND current_job.updated_at = ?
        AND current_field.organization_id = ?
        AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
    )
      AND NOT EXISTS (SELECT 1 FROM import_job_specs WHERE import_job_id = ?)
  `).bind(
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.profileKey,
    input.profileVersion,
    documentJson,
    input.updatedBy,
    now,
    now,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.sourceSystem,
    input.parsingStartedAt,
    input.parsingStartedAt,
    input.organizationId,
    fieldsJson,
    input.importJobId,
  );
  const setEffectiveDate = client.prepare(`
    UPDATE import_jobs
    SET effective_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = ?
      AND status = 'parsing'
      AND started_at = ?
      AND updated_at = ?
      AND EXISTS (
        SELECT 1 FROM import_job_specs AS saved_spec
        WHERE saved_spec.import_job_id = import_jobs.id
          AND saved_spec.profile_key = ?
          AND saved_spec.profile_version = ?
          AND saved_spec.document_json = ?
      )
  `).bind(
    input.effectiveAt,
    input.importJobId,
    input.organizationId,
    input.fieldId,
    input.sourceSystem,
    input.parsingStartedAt,
    input.parsingStartedAt,
    input.profileKey,
    input.profileVersion,
    documentJson,
  );
  const results = await client.batch([insertSpec, setEffectiveDate]);
  if (results[0].meta.changes !== 1 || results[1].meta.changes !== 1) {
    throw new ImportCenterError("No fue posible fijar el perfil del documento.", "IMPORT_PROFILE_STALE");
  }
}

export async function getImportCenterDashboard(access: ImportActorAccess): Promise<ImportCenterDashboard> {
  if (access.fieldIds.length === 0) return emptyDashboard();
  const scope = dashboardScope(access);
  const [jobs, totals] = await Promise.all([
    getDb()
      .select({
        id: importJobs.id,
        fieldId: importJobs.fieldId,
        fieldName: fields.name,
        sourceSystem: importJobs.sourceSystem,
        sourceFormat: importJobs.sourceFormat,
        profileKey: importJobSpecs.profileKey,
        originalFilename: importJobs.originalFilename,
        status: importJobs.status,
        effectiveAt: importJobs.effectiveAt,
        createdAt: importJobs.createdAt,
        confirmedAt: importJobs.confirmedAt,
        failureMessage: importJobs.failureMessage,
        rowCount: importJobs.rowCount,
        warningRowCount: importJobs.warningRowCount,
        errorRowCount: importJobs.errorRowCount,
      })
      .from(importJobs)
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .innerJoin(importJobSpecs, eq(importJobSpecs.importJobId, importJobs.id))
      .where(scope)
      .orderBy(desc(importJobs.createdAt))
      .limit(40),
    getDb()
      .select({
        importCount: count(importJobs.id),
        confirmedCount: sql<number>`SUM(CASE WHEN ${importJobs.status} IN ('completed', 'completed_with_errors') THEN 1 ELSE 0 END)`,
        pendingReviewCount: sql<number>`SUM(CASE WHEN ${importJobs.status} = 'preview_ready' THEN 1 ELSE 0 END)`,
        errorCount: sql<number>`SUM(CASE WHEN ${importJobs.status} = 'failed' OR ${importJobs.errorRowCount} > 0 THEN 1 ELSE 0 END)`,
      })
      .from(importJobs)
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .innerJoin(importJobSpecs, eq(importJobSpecs.importJobId, importJobs.id))
      .where(scope),
  ]);
  await assertCurrentImportActorAccess(access, jobs.map((job) => job.fieldId));
  const aggregate = totals[0];
  return {
    imports: jobs,
    totals: {
      importCount: Number(aggregate?.importCount ?? 0),
      confirmedCount: Number(aggregate?.confirmedCount ?? 0),
      pendingReviewCount: Number(aggregate?.pendingReviewCount ?? 0),
      errorCount: Number(aggregate?.errorCount ?? 0),
    },
  };
}

export async function getImportCenterPreview(
  id: string,
  access: ImportActorAccess,
  reused = false,
): Promise<ImportCenterPreview | null> {
  if (access.fieldIds.length === 0) return null;
  const scope = centerReadScope(access);
  const [job] = await getDb()
    .select({
      id: importJobs.id,
      fieldId: importJobs.fieldId,
      fieldName: fields.name,
      sourceSystem: importJobs.sourceSystem,
      sourceFormat: importJobs.sourceFormat,
      profileKey: importJobSpecs.profileKey,
      profileVersion: importJobSpecs.profileVersion,
      originalFilename: importJobs.originalFilename,
      effectiveAt: importJobs.effectiveAt,
      status: importJobs.status,
      createdAt: importJobs.createdAt,
      confirmedAt: importJobs.confirmedAt,
      revision: importJobs.updatedAt,
      mapping: importJobSpecs.mappingJson,
      document: importJobSpecs.documentJson,
      rowCount: importJobs.rowCount,
      validRowCount: importJobs.validRowCount,
      warningRowCount: importJobs.warningRowCount,
      errorRowCount: importJobs.errorRowCount,
      skippedRowCount: importJobs.skippedRowCount,
      fileIssueCount: importJobs.fileIssueCount,
    })
    .from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .innerJoin(importJobSpecs, eq(importJobSpecs.importJobId, importJobs.id))
    .where(and(eq(importJobs.id, id), scope))
    .limit(1);
  if (!job || !isCenterSource(job.sourceSystem)) return null;

  const rows = await getDb()
    .select({
      id: importRows.id,
      recordNumber: importRows.recordNumber,
      rawRecord: importRows.rawRecord,
      normalizedRecord: importRows.normalizedRecord,
      status: importRows.status,
    })
    .from(importRows)
    .innerJoin(importJobs, eq(importJobs.id, importRows.importJobId))
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(eq(importRows.importJobId, id), scope))
    .orderBy(asc(importRows.recordNumber))
    .limit(PREVIEW_ROW_LIMIT);
  const rowIds = rows.map((row) => row.id);
  const issues = rowIds.length === 0
    ? []
    : await getDb()
      .select({
        importRowId: importErrors.importRowId,
        fieldName: importErrors.fieldName,
        ruleCode: importErrors.ruleCode,
        severity: importErrors.severity,
        message: importErrors.message,
        sourceValue: importErrors.sourceValue,
      })
      .from(importErrors)
      .innerJoin(importRows, and(
        eq(importRows.id, importErrors.importRowId),
        eq(importRows.importJobId, importErrors.importJobId),
      ))
      .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId))
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .where(and(
        eq(importErrors.importJobId, id),
        inArray(importErrors.importRowId, rowIds),
        scope,
      ));
  const byRow = new Map<string, typeof issues>();
  for (const issue of issues) byRow.set(issue.importRowId, [...(byRow.get(issue.importRowId) ?? []), issue]);
  const [soilLink] = job.document.kind === "cooprinsem_soil_report"
    ? await getDb()
      .select({
        paddockId: soilAnalysisReports.paddockId,
        paddockName: paddocks.name,
      })
      .from(soilAnalysisReports)
      .innerJoin(paddocks, and(
        eq(paddocks.id, soilAnalysisReports.paddockId),
        eq(paddocks.fieldId, soilAnalysisReports.fieldId),
      ))
      .innerJoin(fields, eq(fields.id, soilAnalysisReports.fieldId))
      .where(and(
        eq(soilAnalysisReports.importJobId, id),
        eq(soilAnalysisReports.organizationId, access.organizationId),
        eq(fields.organizationId, access.organizationId),
        inArray(soilAnalysisReports.fieldId, access.fieldIds),
        inArray(fields.id, access.fieldIds),
      ))
      .limit(1)
    : [];

  await assertCurrentImportActorAccess(access, [job.fieldId]);
  return {
    id: job.id,
    fieldId: job.fieldId,
    fieldName: job.fieldName,
    sourceSystem: job.sourceSystem,
    sourceFormat: job.sourceFormat,
    profileKey: job.profileKey as ImportProfileKey,
    profileVersion: job.profileVersion,
    originalFilename: job.originalFilename,
    effectiveAt: job.effectiveAt,
    status: job.status,
    createdAt: job.createdAt,
    confirmedAt: job.confirmedAt,
    revision: job.revision,
    reused,
    mapping: job.mapping,
    soilLink: soilLink ?? null,
    document: job.document,
    summary: summaryFromJob(job),
    rows: rows.map((row) => ({
      ...row,
      issues: (byRow.get(row.id) ?? []).map((issue) => ({
        fieldName: issue.fieldName,
        ruleCode: issue.ruleCode,
        severity: issue.severity,
        message: issue.message,
        sourceValue: issue.sourceValue,
      })),
    })),
  };
}

export async function reconcileSurvetImportRows(input: {
  access: ImportActorAccess;
  fieldId: string;
  controlDate: string;
  rows: StagedPreviewRow[];
}): Promise<{ rows: StagedPreviewRow[]; summary: ImportCenterSummary }> {
  if (!input.access.fieldIds.includes(input.fieldId)) {
    throw new ImportCenterError("El fundo dejó de estar disponible.", "IMPORT_SCOPE_CHANGED");
  }
  const db = getDb();
  const [animals, identifiers, controls] = await Promise.all([
    db
      .select({
        id: livestockAnimals.id,
        tag: livestockAnimals.tag,
      })
      .from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, and(
        eq(fields.id, livestockLots.fieldId),
        eq(fields.organizationId, input.access.organizationId),
      ))
      .where(and(
        eq(livestockLots.fieldId, input.fieldId),
        eq(livestockAnimals.status, "active"),
      )),
    db
      .select({
        animalId: livestockAnimalIdentifiers.animalId,
        normalizedValue: livestockAnimalIdentifiers.normalizedValue,
        sourceSystem: livestockAnimalIdentifiers.sourceSystem,
        kind: livestockAnimalIdentifiers.kind,
      })
      .from(livestockAnimalIdentifiers)
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockAnimalIdentifiers.animalId))
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, and(
        eq(fields.id, livestockLots.fieldId),
        eq(fields.organizationId, input.access.organizationId),
      ))
      .where(and(
        eq(livestockAnimalIdentifiers.fieldId, input.fieldId),
        eq(livestockLots.fieldId, input.fieldId),
        eq(livestockAnimals.status, "active"),
        isNull(livestockAnimalIdentifiers.validTo),
      )),
    db
      .select({ animalId: livestockMilkControls.animalId })
      .from(livestockMilkControls)
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockMilkControls.animalId))
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, and(
        eq(fields.id, livestockLots.fieldId),
        eq(fields.organizationId, input.access.organizationId),
      ))
      .where(and(
        eq(livestockMilkControls.fieldId, input.fieldId),
        eq(livestockMilkControls.controlDate, input.controlDate),
        eq(livestockLots.fieldId, input.fieldId),
      )),
  ]);
  await assertCurrentImportActorAccess(input.access, [input.fieldId]);

  type Candidate = { animalId: string; tag: string; matchedBy: string[] };
  const animalsById = new Map(animals.map((animal) => [animal.id, animal]));
  const matches = new Map<string, Map<string, Candidate>>();
  const addMatch = (value: unknown, animalId: string, matchedBy: string) => {
    const normalized = normalizedIdentifier(value);
    const animal = animalsById.get(animalId);
    if (!normalized || !animal) return;
    const candidates = matches.get(normalized) ?? new Map<string, Candidate>();
    const current = candidates.get(animalId) ?? {
      animalId,
      tag: animal.tag,
      matchedBy: [],
    };
    current.matchedBy = [...new Set([...current.matchedBy, matchedBy])].sort();
    candidates.set(animalId, current);
    matches.set(normalized, candidates);
  };
  for (const animal of animals) addMatch(animal.tag, animal.id, "tag");
  for (const identifier of identifiers) {
    addMatch(
      identifier.normalizedValue,
      identifier.animalId,
      `identifier:${identifier.sourceSystem}:${identifier.kind}`,
    );
  }
  const occupiedAnimalIds = new Set(controls.map((control) => control.animalId));
  const reconciled = input.rows.map((sourceRow): StagedPreviewRow => {
    const row = {
      ...sourceRow,
      issues: [...sourceRow.issues],
      normalizedRecord: sourceRow.normalizedRecord
        ? { ...sourceRow.normalizedRecord }
        : null,
    };
    if (!row.normalizedRecord || row.issues.some((entry) => entry.severity === "error")) {
      row.status = "error";
      return row;
    }
    const externalAnimalId = normalizedIdentifier(row.normalizedRecord.externalAnimalId);
    const candidates = [...(matches.get(externalAnimalId)?.values() ?? [])];
    if (candidates.length === 0) {
      row.issues.push({
        fieldName: "externalAnimalId",
        ruleCode: "SURVET_DIIO_UNMATCHED",
        severity: "warning",
        message: `La fila ${row.recordNumber} no coincide con una vaca activa del fundo y se omitirá.`,
        sourceValue: row.normalizedRecord.externalAnimalId ?? null,
      });
      row.status = "skipped";
      return row;
    }
    if (candidates.length > 1) {
      row.issues.push({
        fieldName: "externalAnimalId",
        ruleCode: "SURVET_DIIO_AMBIGUOUS",
        severity: "error",
        message: `La fila ${row.recordNumber} coincide con más de una vaca. Corrige los identificadores antes de confirmar.`,
        sourceValue: row.normalizedRecord.externalAnimalId ?? null,
      });
      row.status = "error";
      return row;
    }
    const [candidate] = candidates;
    if (occupiedAnimalIds.has(candidate.animalId)) {
      row.issues.push({
        fieldName: "controlDate",
        ruleCode: "SURVET_CONTROL_ALREADY_EXISTS",
        severity: "error",
        message: `La vaca ${candidate.tag} ya tiene un control el ${input.controlDate}.`,
        sourceValue: input.controlDate,
      });
      row.status = "error";
      return row;
    }
    row.normalizedRecord = {
      ...row.normalizedRecord,
      externalAnimalId,
      animalId: candidate.animalId,
      animalTag: candidate.tag,
      matchedBy: candidate.matchedBy,
    };
    row.status = row.issues.some((entry) => entry.severity === "warning") ? "warning" : "valid";
    return row;
  });

  const rowsByAnimal = new Map<string, StagedPreviewRow[]>();
  for (const row of reconciled) {
    const animalId = text(row.normalizedRecord?.animalId);
    if (!animalId || row.status === "error" || row.status === "skipped") continue;
    rowsByAnimal.set(animalId, [...(rowsByAnimal.get(animalId) ?? []), row]);
  }
  for (const duplicates of rowsByAnimal.values()) {
    if (duplicates.length < 2) continue;
    for (const row of duplicates) {
      row.issues.push({
        fieldName: "externalAnimalId",
        ruleCode: "SURVET_ANIMAL_DUPLICATE",
        severity: "error",
        message: `La vaca ${text(row.normalizedRecord?.animalTag)} quedó asociada a más de una fila.`,
        sourceValue: row.normalizedRecord?.externalAnimalId ?? null,
      });
      row.status = "error";
    }
  }
  return { rows: reconciled, summary: summaryFromRows(reconciled) };
}

export async function remapGenericImport(input: {
  importJobId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  email: string;
  mapping: unknown;
}): Promise<ImportCenterPreview> {
  const access: ImportActorAccess = {
    membershipId: input.membershipId,
    organizationId: input.organizationId,
    fieldIds: input.fieldIds,
    email: input.email,
  };
  const preview = await getImportCenterPreview(input.importJobId, access);
  if (!preview || preview.sourceSystem !== "generic" || preview.profileKey !== "generic.pasture_measurements.table.v1") {
    throw new ImportCenterError("La importación tabular no existe o no está disponible.", "IMPORT_NOT_FOUND");
  }
  if (preview.status !== "preview_ready") {
    throw new ImportCenterError("Solo se puede cambiar el mapeo antes de confirmar.", "IMPORT_ALREADY_CONFIRMED");
  }
  if (preview.rows.length !== preview.summary.rowCount) {
    throw new ImportCenterError("La vista previa está truncada y no se puede confirmar.", "IMPORT_PREVIEW_TRUNCATED");
  }
  const document = preview.document;
  if (document.kind !== "tabular_pasture_measurements" || document.truncated) {
    throw new ImportCenterError("La planilla supera el límite seguro de filas.", "IMPORT_PREVIEW_TRUNCATED");
  }
  let mapping: ReturnType<typeof validatePastureMapping>;
  try {
    mapping = validatePastureMapping(document.headers, input.mapping);
  } catch (cause) {
    if (cause instanceof PastureMappingError) {
      throw new ImportCenterError(cause.message, cause.code);
    }
    throw cause;
  }
  const mapped = mapPastureRows(preview.rows, mapping, preview.effectiveAt);
  const summary = mappingSummary(mapped);
  await persistMappedRows({
    access,
    fieldId: preview.fieldId,
    importJobId: preview.id,
    mapping,
    rows: preview.rows.map((row, index) => ({ id: row.id, ...mapped[index] })),
    summary,
  });
  const next = await getImportCenterPreview(input.importJobId, access);
  if (!next) throw new ImportCenterError("El mapeo se guardó, pero la vista previa ya no está disponible.", "IMPORT_SCOPE_CHANGED");
  return next;
}

export async function reconcileAgronomicPaddocks(input: {
  importJobId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  email: string;
  mappings: unknown;
}): Promise<ImportCenterPreview> {
  const access: ImportActorAccess = {
    membershipId: input.membershipId,
    organizationId: input.organizationId,
    fieldIds: input.fieldIds,
    email: input.email,
  };
  const preview = await getImportCenterPreview(input.importJobId, access);
  if (
    !preview
    || preview.sourceSystem !== "agronomic_advisor"
    || preview.profileKey !== "agronomic.visit_report.pdf.v1"
    || preview.document.kind !== "agronomic_visit_report"
  ) {
    throw new ImportCenterError("El informe agronómico no existe o no está disponible.", "IMPORT_NOT_FOUND");
  }
  if (preview.status !== "preview_ready") {
    throw new ImportCenterError("Solo se pueden conciliar potreros antes de confirmar.", "IMPORT_ALREADY_CONFIRMED");
  }
  if (preview.rows.length !== preview.summary.rowCount || preview.rows.length === 0) {
    throw new ImportCenterError("La vista previa está incompleta y no se puede conciliar.", "IMPORT_PREVIEW_TRUNCATED");
  }

  const mappings = paddockReconciliations(input.mappings, preview.rows);
  const requestedPaddockIds = [...new Set(mappings.map((mapping) => mapping.paddockId))];
  const availablePaddocks = await getDb()
    .select({ id: paddocks.id })
    .from(paddocks)
    .innerJoin(fields, and(
      eq(fields.id, paddocks.fieldId),
      eq(fields.organizationId, access.organizationId),
    ))
    .where(and(
      eq(paddocks.fieldId, preview.fieldId),
      inArray(paddocks.id, requestedPaddockIds),
      isNull(paddocks.deletedAt),
      isNull(paddocks.archivedAt),
    ));
  await assertCurrentImportActorAccess(access, [preview.fieldId]);
  if (availablePaddocks.length !== requestedPaddockIds.length) {
    throw new ImportCenterError(
      "Uno de los potreros ya no está activo o no pertenece al fundo del informe.",
      "IMPORT_PADDOCK_INVALID",
    );
  }

  const mappingByRow = new Map(mappings.map((mapping) => [mapping.importRowId, mapping.paddockId]));
  const externalToPaddock = new Map<string, string>();
  const paddockToExternal = new Map<string, string>();
  const rows = preview.rows.map((row) => {
    const record = row.normalizedRecord;
    const externalPaddockKey = text(record?.externalPaddockKey);
    const paddockId = mappingByRow.get(row.id) ?? "";
    if (!record || text(record.actionKind) !== "agronomic_recommendation" || !externalPaddockKey || !paddockId) {
      throw new ImportCenterError(`La fila ${row.recordNumber} perdió su recomendación normalizada.`, "IMPORT_ROW_INVALID");
    }
    const existingPaddock = externalToPaddock.get(externalPaddockKey);
    if (existingPaddock && existingPaddock !== paddockId) {
      throw new ImportCenterError(
        `La etiqueta externa ${externalPaddockKey} debe apuntar siempre al mismo potrero.`,
        "IMPORT_PADDOCK_MAPPING_INCONSISTENT",
      );
    }
    const existingExternal = paddockToExternal.get(paddockId);
    if (existingExternal && existingExternal !== externalPaddockKey) {
      throw new ImportCenterError(
        `Las etiquetas externas ${existingExternal} y ${externalPaddockKey} no pueden apuntar al mismo potrero.`,
        "IMPORT_PADDOCK_MAPPING_AMBIGUOUS",
      );
    }
    externalToPaddock.set(externalPaddockKey, paddockId);
    paddockToExternal.set(paddockId, externalPaddockKey);
    return {
      id: row.id,
      normalizedRecord: { ...record, paddockId },
    };
  });

  await persistAgronomicPaddockReconciliation({
    access,
    fieldId: preview.fieldId,
    importJobId: preview.id,
    revision: preview.revision,
    rows,
  });
  const next = await getImportCenterPreview(preview.id, access);
  if (!next) {
    throw new ImportCenterError(
      "La conciliación se guardó, pero la vista previa ya no está disponible.",
      "IMPORT_SCOPE_CHANGED",
    );
  }
  return next;
}

export async function confirmImportVisit(input: {
  importJobId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  email: string;
  confirmation: string;
  paddockId?: string;
}): Promise<ImportConfirmationReceipt> {
  if (input.confirmation !== "CONFIRMAR IMPORTACIÓN") {
    throw new ImportCenterError("Escribe CONFIRMAR IMPORTACIÓN para confirmar los datos revisados.", "IMPORT_CONFIRMATION_MISMATCH");
  }
  const access: ImportActorAccess = {
    membershipId: input.membershipId,
    organizationId: input.organizationId,
    fieldIds: input.fieldIds,
    email: input.email,
  };
  const preview = await getImportCenterPreview(input.importJobId, access);
  if (!preview) throw new ImportCenterError("La importación no existe o no está disponible.", "IMPORT_NOT_FOUND");
  if (preview.status === "completed" || preview.status === "completed_with_errors") {
    const receipt = await readPostCommitConfirmationSafely(
      () => preview.profileKey === "cooprinsem.soil_report.pdf.v1"
        ? existingSoilConfirmation(preview, access)
        : preview.profileKey === "survet.milk_control.xlsx.v1"
          ? existingSurvetConfirmation(preview, access)
          : preview.profileKey === "livestock.inventory.xlsx.v1"
            ? existingLivestockInventoryConfirmation(preview, access)
            : existingConfirmation(preview, access),
    );
    if (!receipt) throw confirmationReceiptIntegrityError();
    return finalizeImportConfirmationReceipt({ access, preview, receipt });
  }
  if (preview.status !== "preview_ready") {
    throw new ImportCenterError("La importación todavía no está lista para confirmar.", "IMPORT_NOT_READY");
  }
  if (preview.summary.errorRowCount > 0 || preview.summary.fileIssueCount > 0) {
    throw new ImportCenterError("Corrige las filas con error antes de confirmar.", "IMPORT_HAS_ERRORS");
  }
  if (preview.rows.length !== preview.summary.rowCount || preview.rows.length === 0) {
    throw new ImportCenterError("La vista previa está incompleta y no se puede confirmar.", "IMPORT_PREVIEW_TRUNCATED");
  }
  if (preview.sourceSystem === "generic" && preview.profileKey !== "livestock.inventory.xlsx.v1" && !preview.mapping) {
    throw new ImportCenterError("Mapea las columnas antes de confirmar.", "IMPORT_MAPPING_REQUIRED");
  }
  if (preview.profileKey === "cooprinsem.soil_report.pdf.v1") {
    if (preview.document.kind !== "cooprinsem_soil_report") {
      throw new ImportCenterError(
        "El perfil de suelo perdió su documento normalizado.",
        "IMPORT_PROFILE_STALE",
      );
    }
    const paddockId = text(input.paddockId);
    if (!paddockId) {
      throw new ImportCenterError(
        "Selecciona el potrero al que corresponde la muestra.",
        "IMPORT_PADDOCK_REQUIRED",
      );
    }
    const rows = preview.rows.map(canonicalSoilRow);
    assertSoilRowsMatchDocument(rows, preview.document.results);
    const receipt = await persistSoilConfirmation({
      access,
      paddockId,
      preview,
      rows,
    });
    return finalizeImportConfirmationReceipt({ access, preview, receipt });
  }
  if (preview.profileKey === "survet.milk_control.xlsx.v1") {
    if (preview.document.kind !== "survet_milk_control") {
      throw new ImportCenterError("El perfil Survet perdió su documento normalizado.", "IMPORT_PROFILE_STALE");
    }
    const rows = preview.rows
      .filter((row) => row.status === "valid" || row.status === "warning")
      .map(canonicalSurvetRow);
    if (rows.length === 0) {
      throw new ImportCenterError("No hay vacas conciliadas para confirmar.", "IMPORT_ROWS_REQUIRED");
    }
    const receipt = await persistSurvetConfirmation({
      access,
      preview,
      rows,
    });
    return finalizeImportConfirmationReceipt({ access, preview, receipt });
  }
  if (preview.profileKey === "livestock.inventory.xlsx.v1") {
    const receipt = await persistLivestockInventoryConfirmation({
      access,
      preview,
    });
    return finalizeImportConfirmationReceipt({ access, preview, receipt });
  }
  if (preview.profileKey === "agronomic.visit_report.pdf.v1") {
    if (preview.document.kind !== "agronomic_visit_report") {
      throw new ImportCenterError(
        "El perfil agronómico perdió su documento normalizado.",
        "IMPORT_PROFILE_STALE",
      );
    }
    const rows = preview.rows.map(canonicalAgronomicRecommendationRow);
    assertAgronomicRowsMatchDocument(rows, preview.document.actionGroups);
    const receipt = await persistAgronomicConfirmation({
      access,
      preview,
      rows,
    });
    return finalizeImportConfirmationReceipt({ access, preview, receipt });
  }
  const visitDate = preview.document.kind === "watts_visit_report"
    ? preview.document.visitDate
    : preview.effectiveAt;
  if (!visitDate) throw new ImportCenterError("La importación necesita una fecha efectiva.", "IMPORT_DATE_REQUIRED");
  const canonicalRows = preview.rows.map((row) => canonicalVisitRow(row, visitDate));
  const receipt = await persistConfirmation({
    access,
    preview,
    rows: canonicalRows,
    visitDate,
  });
  return finalizeImportConfirmationReceipt({ access, preview, receipt });
}

async function finalizeImportConfirmationReceipt(input: {
  access: ImportActorAccess;
  preview: ImportCenterPreview;
  receipt: ImportConfirmationReceiptBase;
}): Promise<ImportConfirmationReceipt> {
  const profileContract = CONFIRMATION_PROFILE_CONTRACTS[input.preview.profileKey];
  if (
    !profileContract
    || input.receipt.importJobId !== input.preview.id
    || profileContract.mode !== "insert_only"
    || input.receipt.targetEntity !== profileContract.receiptTargetEntity
    || !input.receipt.targetId.trim()
    || (
      profileContract.receiptTargetEntity === "field_visit"
        ? input.receipt.visitId !== input.receipt.targetId
        : input.receipt.visitId !== null
    )
    || (
      profileContract.receiptTargetEntity === "livestock_milk_control_batch"
      && input.receipt.targetId !== input.receipt.importJobId
    )
  ) {
    throw confirmationReceiptIntegrityError();
  }

  const durableRows = await (async () => {
    try {
      return await getDb()
        .select({
          importRowId: importRows.id,
          recordNumber: importRows.recordNumber,
          rowStatus: importRows.status,
          jobRowCount: importJobs.rowCount,
          jobValidRowCount: importJobs.validRowCount,
          jobWarningRowCount: importJobs.warningRowCount,
          jobErrorRowCount: importJobs.errorRowCount,
          jobSkippedRowCount: importJobs.skippedRowCount,
          jobFileIssueCount: importJobs.fileIssueCount,
          jobStatus: importJobs.status,
          jobIsDryRun: importJobs.isDryRun,
          jobSourceSystem: importJobs.sourceSystem,
          jobConfirmedAt: importJobs.confirmedAt,
          jobCompletedAt: importJobs.completedAt,
          profileKey: importJobSpecs.profileKey,
          profileVersion: importJobSpecs.profileVersion,
        })
        .from(importRows)
        .innerJoin(importJobs, eq(importJobs.id, importRows.importJobId))
        .innerJoin(importJobSpecs, eq(importJobSpecs.importJobId, importJobs.id))
        .innerJoin(fields, eq(fields.id, importJobs.fieldId))
        .where(and(
          eq(importRows.importJobId, input.receipt.importJobId),
          eq(importJobs.id, input.receipt.importJobId),
          eq(importJobs.organizationId, input.access.organizationId),
          eq(importJobs.fieldId, input.preview.fieldId),
          eq(importJobSpecs.organizationId, input.access.organizationId),
          eq(importJobSpecs.fieldId, input.preview.fieldId),
          eq(fields.organizationId, input.access.organizationId),
          inArray(importJobs.fieldId, input.access.fieldIds),
          inArray(fields.id, input.access.fieldIds),
          eq(fields.isDemo, false),
        ))
        .orderBy(asc(importRows.recordNumber), asc(importRows.id));
    } catch {
      throw confirmationReceiptIntegrityError();
    }
  })();

  const first = durableRows[0];
  const durableRowCount = Number(first?.jobRowCount);
  const durableValidRowCount = Number(first?.jobValidRowCount);
  const durableWarningRowCount = Number(first?.jobWarningRowCount);
  const durableErrorRowCount = Number(first?.jobErrorRowCount);
  const durableSkippedRowCount = Number(first?.jobSkippedRowCount);
  const durableFileIssueCount = Number(first?.jobFileIssueCount);
  const durableMaterializableRowCount = durableValidRowCount + durableWarningRowCount;
  const expectedJobStatus = durableWarningRowCount > 0 || durableSkippedRowCount > 0
    ? "completed_with_errors"
    : "completed";
  if (
    !first
    || !Number.isSafeInteger(durableRowCount)
    || durableRowCount <= 0
    || durableRows.length !== durableRowCount
    || !Number.isSafeInteger(durableValidRowCount)
    || durableValidRowCount < 0
    || !Number.isSafeInteger(durableWarningRowCount)
    || durableWarningRowCount < 0
    || !Number.isSafeInteger(durableErrorRowCount)
    || durableErrorRowCount !== 0
    || !Number.isSafeInteger(durableSkippedRowCount)
    || durableSkippedRowCount < 0
    || !Number.isSafeInteger(durableFileIssueCount)
    || durableFileIssueCount !== 0
    || durableValidRowCount + durableWarningRowCount + durableSkippedRowCount !== durableRowCount
    || durableMaterializableRowCount <= 0
    || first.profileKey !== input.preview.profileKey
    || first.profileVersion !== input.preview.profileVersion
    || first.jobSourceSystem !== profileContract.sourceSystem
    || (first.jobStatus !== "completed" && first.jobStatus !== "completed_with_errors")
    || first.jobStatus !== expectedJobStatus
    || first.jobStatus !== input.receipt.status
    || first.jobIsDryRun !== false
    || !first.jobConfirmedAt
    || first.jobConfirmedAt !== input.receipt.confirmedAt
    || !first.jobCompletedAt
    || first.jobCompletedAt !== first.jobConfirmedAt
  ) {
    throw confirmationReceiptIntegrityError();
  }

  const durableSourceResult = await (async () => {
    try {
      return await getDb().$client.prepare(`
        SELECT
          saved_source.import_job_id AS sourceJobId,
          saved_source.import_row_id AS sourceRowId,
          saved_row.import_job_id AS rowJobId,
          saved_source.source_system AS sourceSystem,
          saved_source.source_table AS sourceTable,
          saved_source.target_entity AS targetEntity,
          CASE
            WHEN saved_source.target_entity = 'field_visit_paddock' THEN (
              SELECT COUNT(*) FROM field_visit_paddocks AS target_row
              WHERE target_row.id = saved_source.target_id
            )
            WHEN saved_source.target_entity = 'field_visit_recommendation' THEN (
              SELECT COUNT(*) FROM field_visit_recommendations AS target_row
              WHERE target_row.id = saved_source.target_id
            )
            WHEN saved_source.target_entity = 'livestock_milk_control' THEN (
              SELECT COUNT(*) FROM livestock_milk_controls AS target_row
              WHERE target_row.source_record_id = saved_source.id
            )
            WHEN saved_source.target_entity = 'soil_analysis_result' THEN (
              SELECT COUNT(*) FROM soil_analysis_results AS target_row
              WHERE target_row.id = saved_source.target_id
            )
            ELSE 0
          END AS linkedTargetCount,
          CASE
            WHEN saved_source.target_entity = 'field_visit_paddock' THEN (
              SELECT COUNT(*) FROM field_visit_paddocks AS target_row
              WHERE target_row.id = saved_source.target_id
                AND target_row.import_job_id = saved_source.import_job_id
                AND target_row.import_row_id = saved_source.import_row_id
                AND target_row.organization_id = ?2
                AND target_row.field_id = ?3
                AND target_row.visit_id = ?4
            )
            WHEN saved_source.target_entity = 'field_visit_recommendation' THEN (
              SELECT COUNT(*) FROM field_visit_recommendations AS target_row
              WHERE target_row.id = saved_source.target_id
                AND target_row.import_job_id = saved_source.import_job_id
                AND target_row.import_row_id = saved_source.import_row_id
                AND target_row.organization_id = ?2
                AND target_row.field_id = ?3
                AND target_row.visit_id = ?4
            )
            WHEN saved_source.target_entity = 'livestock_milk_control' THEN (
              SELECT COUNT(*)
              FROM livestock_milk_controls AS target_row
              INNER JOIN livestock_animals AS target_animal
                ON target_animal.id = target_row.animal_id
              INNER JOIN livestock_lots AS target_lot
                ON target_lot.id = target_animal.lot_id
              LEFT JOIN livestock_lactations AS target_lactation
                ON target_lactation.id = target_row.lactation_id
              WHERE target_row.id = saved_source.target_id
                AND target_row.source_record_id = saved_source.id
                AND target_row.field_id = ?3
                AND target_lot.field_id = target_row.field_id
                AND (
                  target_row.lactation_id IS NULL
                  OR (
                    target_lactation.id IS NOT NULL
                    AND target_lactation.animal_id = target_row.animal_id
                    AND target_lactation.field_id = target_row.field_id
                  )
                )
            )
            WHEN saved_source.target_entity = 'soil_analysis_result' THEN (
              SELECT COUNT(*) FROM soil_analysis_results AS target_row
              WHERE target_row.id = saved_source.target_id
                AND target_row.import_job_id = saved_source.import_job_id
                AND target_row.import_row_id = saved_source.import_row_id
                AND target_row.organization_id = ?2
                AND target_row.field_id = ?3
                AND target_row.report_id = ?4
            )
            ELSE 0
          END AS validTargetCount
        FROM source_records AS saved_source
        LEFT JOIN import_rows AS saved_row ON saved_row.id = saved_source.import_row_id
        WHERE saved_source.import_job_id = ?1 OR saved_row.import_job_id = ?1
        ORDER BY saved_source.id ASC
      `).bind(
        input.receipt.importJobId,
        input.access.organizationId,
        input.preview.fieldId,
        input.receipt.targetId,
      ).all<{
        sourceJobId: string;
        sourceRowId: string;
        rowJobId: string | null;
        sourceSystem: string;
        sourceTable: string;
        targetEntity: string;
        linkedTargetCount: number;
        validTargetCount: number;
      }>();
    } catch {
      throw confirmationReceiptIntegrityError();
    }
  })();

  const knownRowIds = new Set(durableRows.map((row) => row.importRowId));
  const sourceCountByRow = new Map<string, number>();
  for (const source of durableSourceResult.results) {
    if (
      source.sourceJobId !== input.receipt.importJobId
      || source.rowJobId !== input.receipt.importJobId
      || !knownRowIds.has(source.sourceRowId)
      || source.sourceSystem !== profileContract.sourceSystem
      || source.sourceTable !== input.preview.profileKey
      || source.targetEntity !== profileContract.targetEntity
      || Number(source.linkedTargetCount) !== 1
      || Number(source.validTargetCount) !== 1
    ) {
      throw confirmationReceiptIntegrityError();
    }
    const sourceCount = (sourceCountByRow.get(source.sourceRowId) ?? 0) + 1;
    if (sourceCount !== 1) {
      throw confirmationReceiptIntegrityError();
    }
    sourceCountByRow.set(source.sourceRowId, sourceCount);
  }

  const durableTargetResult = await (async () => {
    try {
      return await getDb().$client.prepare(`
        SELECT
          saved_row.id AS importRowId,
          CASE ?5
            WHEN 'field_visit_paddock' THEN (
              SELECT COUNT(*)
              FROM field_visit_paddocks AS target_row
              WHERE target_row.id = 'field-visit-paddock:' || saved_row.id
                OR (
                  target_row.import_job_id = ?1
                  AND target_row.import_row_id = saved_row.id
                )
            )
            WHEN 'field_visit_recommendation' THEN (
              SELECT COUNT(*)
              FROM field_visit_recommendations AS target_row
              WHERE target_row.id = 'field-visit-recommendation:' || saved_row.id
                OR (
                  target_row.import_job_id = ?1
                  AND target_row.import_row_id = saved_row.id
                )
            )
            WHEN 'livestock_milk_control' THEN (
              SELECT COUNT(*)
              FROM livestock_milk_controls AS target_row
              WHERE target_row.id = 'milk-control:survet:' || saved_row.id
            )
            WHEN 'soil_analysis_result' THEN (
              SELECT COUNT(*)
              FROM soil_analysis_results AS target_row
              WHERE target_row.id = 'soil-result:' || saved_row.id
                OR (
                  target_row.import_job_id = ?1
                  AND target_row.import_row_id = saved_row.id
                )
            )
            ELSE 0
          END AS directTargetCount,
          CASE ?5
            WHEN 'field_visit_paddock' THEN (
              SELECT COUNT(*)
              FROM field_visit_paddocks AS target_row
              WHERE target_row.visit_id = ?4
            )
            WHEN 'field_visit_recommendation' THEN (
              SELECT COUNT(*)
              FROM field_visit_recommendations AS target_row
              WHERE target_row.visit_id = ?4
            )
            WHEN 'livestock_milk_control' THEN (
              SELECT COUNT(*)
              FROM livestock_milk_controls AS target_row
              WHERE target_row.id IN (
                SELECT 'milk-control:survet:' || batch_row.id
                FROM import_rows AS batch_row
                WHERE batch_row.import_job_id = ?1
              )
              OR target_row.source_record_id IN (
                SELECT batch_source.id
                FROM source_records AS batch_source
                WHERE batch_source.import_job_id = ?1
              )
            )
            WHEN 'soil_analysis_result' THEN (
              SELECT COUNT(*)
              FROM soil_analysis_results AS target_row
              WHERE target_row.report_id = ?4
            )
            ELSE 0
          END AS parentTargetCount
        FROM import_rows AS saved_row
        WHERE saved_row.import_job_id = ?1
        ORDER BY saved_row.record_number ASC, saved_row.id ASC
      `).bind(
        input.receipt.importJobId,
        input.access.organizationId,
        input.preview.fieldId,
        input.receipt.targetId,
        profileContract.targetEntity,
      ).all<{
        importRowId: string;
        directTargetCount: number;
        parentTargetCount: number;
      }>();
    } catch {
      throw confirmationReceiptIntegrityError();
    }
  })();

  const targetCountByRow = new Map<string, number>();
  let parentTargetCount: number | null = null;
  for (const target of durableTargetResult.results) {
    const directTargetCount = Number(target.directTargetCount);
    const currentParentTargetCount = Number(target.parentTargetCount);
    if (
      !knownRowIds.has(target.importRowId)
      || targetCountByRow.has(target.importRowId)
      || !Number.isSafeInteger(directTargetCount)
      || directTargetCount < 0
      || !Number.isSafeInteger(currentParentTargetCount)
      || currentParentTargetCount < 0
      || (parentTargetCount !== null && parentTargetCount !== currentParentTargetCount)
    ) {
      throw confirmationReceiptIntegrityError();
    }
    targetCountByRow.set(target.importRowId, directTargetCount);
    parentTargetCount = currentParentTargetCount;
  }

  const seenRowIds = new Set<string>();
  const seenRecordNumbers = new Set<number>();
  const rowOutcomes: ImportConfirmationRowOutcome[] = durableRows.map((row) => {
    const recordNumber = Number(row.recordNumber);
    const sourceRecordCount = sourceCountByRow.get(row.importRowId) ?? 0;
    const directTargetCount = targetCountByRow.get(row.importRowId);
    if (
      row.jobRowCount !== first.jobRowCount
      || row.jobValidRowCount !== first.jobValidRowCount
      || row.jobWarningRowCount !== first.jobWarningRowCount
      || row.jobErrorRowCount !== first.jobErrorRowCount
      || row.jobSkippedRowCount !== first.jobSkippedRowCount
      || row.jobFileIssueCount !== first.jobFileIssueCount
      || row.jobStatus !== first.jobStatus
      || row.jobIsDryRun !== first.jobIsDryRun
      || row.jobSourceSystem !== first.jobSourceSystem
      || row.jobConfirmedAt !== first.jobConfirmedAt
      || row.jobCompletedAt !== first.jobCompletedAt
      || row.profileKey !== first.profileKey
      || row.profileVersion !== first.profileVersion
      || !row.importRowId
      || !Number.isSafeInteger(recordNumber)
      || recordNumber <= 0
      || seenRowIds.has(row.importRowId)
      || seenRecordNumbers.has(recordNumber)
    ) {
      throw confirmationReceiptIntegrityError();
    }
    seenRowIds.add(row.importRowId);
    seenRecordNumbers.add(recordNumber);

    if (
      row.rowStatus === "imported"
      && (
        profileContract.receiptTargetEntity === "livestock_inventory_batch"
        || (sourceRecordCount === 1 && directTargetCount === 1)
      )
    ) {
      return { recordNumber, outcome: "inserted" };
    }
    if (
      row.rowStatus === "skipped"
      && sourceRecordCount === 0
      && (
        profileContract.receiptTargetEntity === "livestock_inventory_batch"
        || directTargetCount === 0
      )
    ) {
      return { recordNumber, outcome: "rejected" };
    }
    throw confirmationReceiptIntegrityError();
  });

  const insertedRowCount = rowOutcomes.filter((row) => row.outcome === "inserted").length;
  const rejectedRowCount = rowOutcomes.filter((row) => row.outcome === "rejected").length;
  if (
    insertedRowCount <= 0
    || insertedRowCount + rejectedRowCount !== durableRowCount
    || insertedRowCount !== durableValidRowCount + durableWarningRowCount
    || rejectedRowCount !== durableSkippedRowCount
    || (
      profileContract.receiptTargetEntity !== "livestock_inventory_batch"
      && (
        sourceCountByRow.size !== insertedRowCount
        || targetCountByRow.size !== durableRowCount
        || parentTargetCount !== insertedRowCount
      )
    )
    || input.receipt.importedRowCount !== insertedRowCount
    || input.receipt.skippedRowCount !== rejectedRowCount
  ) {
    throw confirmationReceiptIntegrityError();
  }

  try {
    await assertCurrentImportActorAccess(input.access, [input.preview.fieldId]);
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) throw cause;
    throw confirmationReceiptIntegrityError();
  }
  return {
    ...input.receipt,
    receiptVersion: "fundosmart.import-confirmation-receipt.v1",
    status: first.jobStatus,
    rowCount: durableRowCount,
    insertedRowCount,
    updatedRowCount: 0,
    unchangedRowCount: 0,
    conflictRowCount: 0,
    rejectedRowCount,
    rowOutcomes,
    importedRowCount: insertedRowCount,
    skippedRowCount: rejectedRowCount,
    confirmedAt: first.jobConfirmedAt,
  };
}

export function confirmationReceiptIntegrityError(): ImportCenterError {
  return new ImportCenterError(
    "La importación está confirmada, pero su recibo durable no se pudo verificar. No repitas la carga.",
    "IMPORT_RECEIPT_INCONSISTENT",
  );
}

async function readPostCommitConfirmationSafely<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) throw cause;
    throw confirmationReceiptIntegrityError();
  }
}

async function persistAgronomicPaddockReconciliation(input: {
  access: ImportActorAccess;
  importJobId: string;
  fieldId: string;
  revision: string;
  rows: Array<{
    id: string;
    normalizedRecord: ImportRecord;
  }>;
}) {
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const fieldIds = JSON.stringify(input.access.fieldIds);
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET status = 'parsing', updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'agronomic_advisor'
      AND status = 'preview_ready'
      AND updated_at = ?
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM source_records WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (SELECT 1 FROM field_visits WHERE import_job_id = import_jobs.id)
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = ?
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(?))
         AND current_actor.normalized_email <> ?
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
  `).bind(
    token,
    input.importJobId,
    input.access.organizationId,
    input.fieldId,
    input.revision,
    input.access.membershipId,
    input.access.email,
    DEMO_EMAIL,
    input.access.organizationId,
    fieldIds,
  ), client.prepare(`
    DELETE FROM import_errors
    WHERE import_job_id = ?
      AND EXISTS (
        SELECT 1 FROM import_jobs
        WHERE import_jobs.id = import_errors.import_job_id
          AND import_jobs.status = 'parsing'
          AND import_jobs.updated_at = ?
      )
  `).bind(input.importJobId, token)];

  for (const row of input.rows) {
    const paddockId = text(row.normalizedRecord.paddockId);
    statements.push(client.prepare(`
      UPDATE import_rows
      SET normalized_record = ?, status = 'valid', warning_count = 0,
          error_count = 0, updated_at = ?
      WHERE id = ?
        AND import_job_id = ?
        AND status IN ('valid', 'warning')
        AND json_extract(normalized_record, '$.actionKind') = 'agronomic_recommendation'
        AND EXISTS (
          SELECT 1
          FROM potreros AS current_paddock
          INNER JOIN fields AS current_field
            ON current_field.id = current_paddock.field_id
           AND current_field.organization_id = ?
          WHERE current_paddock.id = ?
            AND current_paddock.field_id = ?
            AND current_paddock.deleted_at IS NULL
            AND current_paddock.archived_at IS NULL
        )
        AND EXISTS (
          SELECT 1 FROM import_jobs
          WHERE import_jobs.id = import_rows.import_job_id
            AND import_jobs.status = 'parsing'
            AND import_jobs.updated_at = ?
        )
    `).bind(
      JSON.stringify(row.normalizedRecord),
      now,
      row.id,
      input.importJobId,
      input.access.organizationId,
      paddockId,
      input.fieldId,
      token,
    ));
  }

  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = 'preview_ready', row_count = ?, valid_row_count = ?,
        warning_row_count = 0, error_row_count = 0, skipped_row_count = 0,
        file_issue_count = 0, previewed_at = ?, failure_message = NULL,
        updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'agronomic_advisor'
      AND status = 'parsing'
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id) = ?
      AND (SELECT COUNT(*) FROM import_rows
           WHERE import_job_id = import_jobs.id
             AND status = 'valid'
             AND json_extract(normalized_record, '$.paddockId') IS NOT NULL
             AND updated_at = ?) = ?
      AND (SELECT COUNT(*) FROM import_errors WHERE import_job_id = import_jobs.id) = 0
  `).bind(
    input.rows.length,
    input.rows.length,
    now,
    now,
    input.importJobId,
    input.access.organizationId,
    input.fieldId,
    token,
    input.rows.length,
    now,
    input.rows.length,
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM import_jobs
      WHERE id = ?
        AND organization_id = ?
        AND field_id = ?
        AND source_system = 'agronomic_advisor'
        AND status = 'preview_ready'
        AND updated_at = ?
        AND row_count = ?
        AND valid_row_count = ?
        AND warning_row_count = 0
        AND error_row_count = 0
    ) THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.importJobId,
    input.access.organizationId,
    input.fieldId,
    now,
    input.rows.length,
    input.rows.length,
  ));
  if (statements.length > BATCH_STATEMENT_LIMIT) {
    throw new ImportCenterError(
      "El informe genera demasiadas conciliaciones para una operación segura.",
      "IMPORT_MAPPING_LIMIT",
    );
  }
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const completed = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (completed?.complete !== 1) {
      throw new ImportCenterError(
        "La importación cambió mientras se guardaba la conciliación. Vuelve a abrirla.",
        "IMPORT_PLAN_STALE",
      );
    }
  } catch (cause) {
    if (cause instanceof ImportCenterError) throw cause;
    throw new ImportCenterError(
      "La importación cambió mientras se guardaba la conciliación. Vuelve a abrirla.",
      "IMPORT_PLAN_STALE",
    );
  }
  await assertCurrentImportActorAccess(input.access, [input.fieldId]);
}

async function persistMappedRows(input: {
  access: ImportActorAccess;
  importJobId: string;
  fieldId: string;
  mapping: ImportColumnMapping;
  rows: Array<ReturnType<typeof mapPastureRows>[number] & { id: string }>;
  summary: ImportCenterSummary;
}) {
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  const fieldIds = JSON.stringify(input.access.fieldIds);
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET status = 'parsing', updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'generic'
      AND status = 'preview_ready'
      AND confirmed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM source_records WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (SELECT 1 FROM field_visits WHERE import_job_id = import_jobs.id)
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = ?
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(?))
         AND current_actor.normalized_email <> ?
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
  `).bind(
    token,
    input.importJobId,
    input.access.organizationId,
    input.fieldId,
    input.access.membershipId,
    input.access.email,
    DEMO_EMAIL,
    input.access.organizationId,
    fieldIds,
  ), client.prepare(`
    DELETE FROM import_errors
    WHERE import_job_id = ?
      AND EXISTS (
        SELECT 1 FROM import_jobs
        WHERE import_jobs.id = import_errors.import_job_id
          AND import_jobs.status = 'parsing'
          AND import_jobs.updated_at = ?
      )
  `).bind(input.importJobId, token)];

  for (const row of input.rows) {
    statements.push(client.prepare(`
      UPDATE import_rows
      SET normalized_record = ?, status = ?, warning_count = ?, error_count = ?, updated_at = ?
      WHERE id = ?
        AND import_job_id = ?
        AND EXISTS (
          SELECT 1 FROM import_jobs
          WHERE import_jobs.id = import_rows.import_job_id
            AND import_jobs.status = 'parsing'
            AND import_jobs.updated_at = ?
        )
    `).bind(
      JSON.stringify(row.normalizedRecord),
      row.status,
      row.warningCount,
      row.errorCount,
      now,
      row.id,
      input.importJobId,
      token,
    ));
    row.issues.forEach((issue: ImportCenterIssue, issueIndex: number) => {
      statements.push(client.prepare(`
        INSERT INTO import_errors (
          id, import_job_id, import_row_id, field_name, rule_code, severity,
          message, source_value, status, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM import_rows AS saved_row
          INNER JOIN import_jobs AS saved_job ON saved_job.id = saved_row.import_job_id
          WHERE saved_row.id = ?
            AND saved_row.import_job_id = ?
            AND saved_job.status = 'parsing'
            AND saved_job.updated_at = ?
        )
      `).bind(
        `mapping:${input.importJobId}:${row.id}:${issueIndex}`,
        input.importJobId,
        row.id,
        issue.fieldName,
        issue.ruleCode,
        issue.severity,
        issue.message,
        issue.sourceValue === null ? null : JSON.stringify(issue.sourceValue),
        now,
        now,
        row.id,
        input.importJobId,
        token,
      ));
    });
  }

  statements.push(client.prepare(`
    UPDATE import_job_specs
    SET mapping_json = ?, updated_by = ?, updated_at = ?
    WHERE import_job_id = ?
      AND profile_key = 'generic.pasture_measurements.table.v1'
      AND EXISTS (
        SELECT 1 FROM import_jobs
        WHERE import_jobs.id = import_job_specs.import_job_id
          AND import_jobs.status = 'parsing'
          AND import_jobs.updated_at = ?
      )
  `).bind(JSON.stringify(input.mapping), input.access.email, now, input.importJobId, token));
  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = 'preview_ready', row_count = ?, valid_row_count = ?, warning_row_count = ?,
        error_row_count = ?, skipped_row_count = ?, file_issue_count = 0,
        previewed_at = ?, failure_message = NULL, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'generic'
      AND status = 'parsing'
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id) = ?
      AND (SELECT COUNT(*) FROM import_errors WHERE import_job_id = import_jobs.id) = ?
  `).bind(
    input.summary.rowCount,
    input.summary.validRowCount,
    input.summary.warningRowCount,
    input.summary.errorRowCount,
    input.summary.skippedRowCount,
    now,
    now,
    input.importJobId,
    input.access.organizationId,
    input.fieldId,
    token,
    input.summary.rowCount,
    input.rows.reduce((total, row) => total + row.issues.length, 0),
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM import_jobs AS saved_job
      INNER JOIN import_job_specs AS saved_spec ON saved_spec.import_job_id = saved_job.id
      WHERE saved_job.id = ?
        AND saved_job.organization_id = ?
        AND saved_job.field_id = ?
        AND saved_job.status = 'preview_ready'
        AND saved_job.updated_at = ?
        AND saved_job.row_count = ?
        AND saved_job.valid_row_count = ?
        AND saved_job.warning_row_count = ?
        AND saved_job.error_row_count = ?
        AND saved_spec.mapping_json = ?
    ) THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.importJobId,
    input.access.organizationId,
    input.fieldId,
    now,
    input.summary.rowCount,
    input.summary.validRowCount,
    input.summary.warningRowCount,
    input.summary.errorRowCount,
    JSON.stringify(input.mapping),
  ));
  if (statements.length > BATCH_STATEMENT_LIMIT) {
    throw new ImportCenterError("La planilla genera demasiadas validaciones para una operación segura.", "IMPORT_MAPPING_LIMIT");
  }
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const completed = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (completed?.complete !== 1) throw new ImportCenterError("La importación cambió mientras se guardaba el mapeo.", "IMPORT_PLAN_STALE");
  } catch (cause) {
    if (cause instanceof ImportCenterError) throw cause;
    throw new ImportCenterError("La importación cambió mientras se guardaba el mapeo.", "IMPORT_PLAN_STALE");
  }
}

async function persistSoilConfirmation(input: {
  access: ImportActorAccess;
  paddockId: string;
  preview: ImportCenterPreview;
  rows: CanonicalSoilRow[];
}): Promise<ImportConfirmationReceiptBase> {
  if (input.preview.document.kind !== "cooprinsem_soil_report") {
    throw new ImportCenterError("El documento de suelo cambió durante la confirmación.", "IMPORT_PROFILE_STALE");
  }
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const reportId = `soil-report:${input.preview.id}`;
  const auditId = `audit:import-soil-report:${input.preview.id}`;
  const fieldIds = JSON.stringify(input.access.fieldIds);
  const document = input.preview.document;
  const finalStatus = input.preview.summary.warningRowCount > 0
    ? "completed_with_errors"
    : "completed";
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET status = 'importing', updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'cooprinsem_soil'
      AND status = 'preview_ready'
      AND updated_at = ?
      AND error_row_count = 0
      AND file_issue_count = 0
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM soil_analysis_reports
        WHERE import_job_id = import_jobs.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM source_records
        WHERE import_job_id = import_jobs.id
      )
      AND (SELECT COUNT(*) FROM import_rows AS ready_row
           WHERE ready_row.import_job_id = import_jobs.id
             AND ready_row.status IN ('valid', 'warning')) = ?
      AND EXISTS (
        SELECT 1 FROM import_job_specs AS current_spec
        WHERE current_spec.import_job_id = import_jobs.id
          AND current_spec.profile_key = 'cooprinsem.soil_report.pdf.v1'
          AND current_spec.profile_version = ?
          AND json_extract(current_spec.document_json, '$.kind') = 'cooprinsem_soil_report'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM soil_analysis_reports AS existing_report
        INNER JOIN import_job_specs AS current_spec
          ON current_spec.import_job_id = import_jobs.id
        WHERE existing_report.organization_id = import_jobs.organization_id
          AND existing_report.field_id = import_jobs.field_id
          AND existing_report.provider_key = 'cooprinsem'
          AND existing_report.folio = json_extract(current_spec.document_json, '$.folio')
      )
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN potreros AS current_paddock
          ON current_paddock.field_id = current_field.id
         AND current_paddock.id = ?
         AND current_paddock.deleted_at IS NULL
         AND current_paddock.archived_at IS NULL
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = ?
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(?))
         AND current_actor.normalized_email <> ?
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
  `).bind(
    token,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    input.preview.revision,
    input.rows.length,
    input.preview.profileVersion,
    input.paddockId,
    input.access.membershipId,
    input.access.email,
    DEMO_EMAIL,
    input.access.organizationId,
    fieldIds,
  ), client.prepare(`
    INSERT INTO soil_analysis_reports (
      id, organization_id, field_id, paddock_id, import_job_id,
      provider_key, profile_key, profile_version, folio, sample_id,
      received_date, report_date, analysis_type, sampled_by,
      reported_sampling_depth_cm, ideal_range_reference_depth_cm,
      analytical_methods_text, accreditation_claim_status,
      signature_status, qr_status, documentary_use, snapshot_json,
      confirmed_by, confirmed_at, created_at
    )
    SELECT ?, current_job.organization_id, current_job.field_id, ?, current_job.id,
           'cooprinsem', current_spec.profile_key, current_spec.profile_version,
           json_extract(current_spec.document_json, '$.folio'),
           json_extract(current_spec.document_json, '$.sampleId'),
           json_extract(current_spec.document_json, '$.receivedDate'),
           json_extract(current_spec.document_json, '$.reportDate'),
           json_extract(current_spec.document_json, '$.analysisType'),
           json_extract(current_spec.document_json, '$.sampledBy'),
           json_extract(current_spec.document_json, '$.reportedSamplingDepthCm'),
           json_extract(current_spec.document_json, '$.idealRangeReferenceDepthCm'),
           json_extract(current_spec.document_json, '$.analyticalMethodsText'),
           CASE
             WHEN json_extract(current_spec.document_json, '$.accreditationClaim.presentInDocument') = 1
             THEN 'reported_unverified'
             ELSE 'not_reported'
           END,
           json_extract(current_spec.document_json, '$.documentaryVerification.signatureStatus'),
           json_extract(current_spec.document_json, '$.documentaryVerification.qrStatus'),
           json_extract(current_spec.document_json, '$.documentaryVerification.use'),
           current_spec.document_json, ?, ?, ?
    FROM import_jobs AS current_job
    INNER JOIN import_job_specs AS current_spec
      ON current_spec.import_job_id = current_job.id
    INNER JOIN potreros AS current_paddock
      ON current_paddock.field_id = current_job.field_id
     AND current_paddock.id = ?
     AND current_paddock.deleted_at IS NULL
     AND current_paddock.archived_at IS NULL
    WHERE current_job.id = ?
      AND current_job.organization_id = ?
      AND current_job.field_id = ?
      AND current_job.status = 'importing'
      AND current_job.updated_at = ?
      AND current_spec.profile_key = 'cooprinsem.soil_report.pdf.v1'
      AND current_spec.profile_version = ?
      AND json_extract(current_spec.document_json, '$.kind') = 'cooprinsem_soil_report'
  `).bind(
    reportId,
    input.paddockId,
    input.access.email,
    now,
    now,
    input.paddockId,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.preview.profileVersion,
  )];

  for (const row of input.rows) {
    const resultId = `soil-result:${row.importRowId}`;
    const sourceId = `source:soil-result:${row.importRowId}`;
    statements.push(client.prepare(`
      INSERT INTO soil_analysis_results (
        id, organization_id, field_id, report_id, import_job_id, import_row_id,
        sequence_number, analyte_code, analyte_name, unit, value,
        ideal_min, ideal_max, ideal_range_text, reported_classification,
        range_assessment, method_key, method_label, snapshot_json, created_at
      )
      SELECT ?, current_report.organization_id, current_report.field_id,
             current_report.id, current_row.import_job_id, current_row.id,
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      FROM import_rows AS current_row
      INNER JOIN import_jobs AS current_job
        ON current_job.id = current_row.import_job_id
      INNER JOIN soil_analysis_reports AS current_report
        ON current_report.import_job_id = current_job.id
      WHERE current_row.id = ?
        AND current_row.import_job_id = ?
        AND current_row.status IN ('valid', 'warning')
        AND current_job.status = 'importing'
        AND current_job.updated_at = ?
        AND current_report.id = ?
        AND json_extract(current_row.normalized_record, '$.sequenceNumber') = ?
        AND json_extract(current_row.normalized_record, '$.analyteCode') = ?
        AND json_extract(current_row.normalized_record, '$.value') = ?
        AND json_extract(current_row.normalized_record, '$.unit') = ?
    `).bind(
      resultId,
      row.sequenceNumber,
      row.analyteCode,
      row.analyteName,
      row.unit,
      row.value,
      row.idealMin,
      row.idealMax,
      row.idealRangeText,
      row.reportedClassification,
      row.rangeAssessment,
      row.methodKey,
      row.methodLabel,
      JSON.stringify(row.snapshot),
      now,
      row.importRowId,
      input.preview.id,
      token,
      reportId,
      row.sequenceNumber,
      row.analyteCode,
      row.value,
      row.unit,
    ));
    statements.push(client.prepare(`
      INSERT INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table,
        source_key, target_entity, target_id, created_at
      )
      SELECT ?, ?, ?, 'cooprinsem_soil', 'cooprinsem.soil_report.pdf.v1', ?,
             'soil_analysis_result', ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM soil_analysis_results AS saved_result
        WHERE saved_result.id = ?
          AND saved_result.import_job_id = ?
          AND saved_result.import_row_id = ?
          AND saved_result.report_id = ?
      )
    `).bind(
      sourceId,
      input.preview.id,
      row.importRowId,
      `${document.folio}:${row.analyteCode}`,
      resultId,
      now,
      resultId,
      input.preview.id,
      row.importRowId,
      reportId,
    ));
    statements.push(client.prepare(`
      UPDATE import_rows
      SET status = 'imported', updated_at = ?
      WHERE id = ?
        AND import_job_id = ?
        AND status IN ('valid', 'warning')
        AND EXISTS (
          SELECT 1 FROM source_records AS saved_source
          WHERE saved_source.id = ?
            AND saved_source.import_job_id = import_rows.import_job_id
            AND saved_source.import_row_id = import_rows.id
            AND saved_source.target_entity = 'soil_analysis_result'
        )
    `).bind(now, row.importRowId, input.preview.id, sourceId));
  }

  const auditAfter = JSON.stringify({
    importJobId: input.preview.id,
    providerKey: "cooprinsem",
    profileKey: input.preview.profileKey,
    reportId,
    paddockId: input.paddockId,
    folio: document.folio,
    sampleId: document.sampleId,
    reportDate: document.reportDate,
    resultCount: input.rows.length,
    documentaryUse: "technical_result_only",
    signatureStatus: "not_checked",
    qrStatus: "not_checked",
    automaticRecommendationsCreated: false,
    automaticActivitiesCreated: false,
  });
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, 'import.soil_analysis.confirm',
           'soil_analysis_report', ?, NULL, ?, NULL, ?
    WHERE EXISTS (
      SELECT 1
      FROM soil_analysis_reports AS saved_report
      WHERE saved_report.id = ?
        AND saved_report.import_job_id = ?
        AND saved_report.paddock_id = ?
        AND (SELECT COUNT(*) FROM soil_analysis_results
             WHERE report_id = saved_report.id) = ?
    )
  `).bind(
    auditId,
    input.access.organizationId,
    input.preview.fieldId,
    input.access.email,
    reportId,
    auditAfter,
    now,
    reportId,
    input.preview.id,
    input.paddockId,
    input.rows.length,
  ));
  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = ?, is_dry_run = 0, confirmed_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'importing'
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM soil_analysis_reports
           WHERE import_job_id = import_jobs.id) = 1
      AND (SELECT COUNT(*) FROM soil_analysis_results
           WHERE import_job_id = import_jobs.id) = ?
      AND (SELECT COUNT(*) FROM import_rows
           WHERE import_job_id = import_jobs.id AND status = 'imported') = ?
      AND (SELECT COUNT(*) FROM source_records
           WHERE import_job_id = import_jobs.id
             AND target_entity = 'soil_analysis_result') = ?
      AND EXISTS (
        SELECT 1 FROM audit_log
        WHERE id = ? AND entity_id = ?
      )
  `).bind(
    finalStatus,
    now,
    now,
    now,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.rows.length,
    input.rows.length,
    input.rows.length,
    auditId,
    reportId,
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM import_jobs AS saved_job
      INNER JOIN soil_analysis_reports AS saved_report
        ON saved_report.import_job_id = saved_job.id
      WHERE saved_job.id = ?
        AND saved_job.organization_id = ?
        AND saved_job.field_id = ?
        AND saved_job.status = ?
        AND saved_job.confirmed_at = ?
        AND saved_job.completed_at = ?
        AND saved_report.id = ?
        AND saved_report.paddock_id = ?
        AND (SELECT COUNT(*) FROM soil_analysis_results
             WHERE import_job_id = saved_job.id) = ?
        AND (SELECT COUNT(*) FROM source_records
             WHERE import_job_id = saved_job.id
               AND target_entity = 'soil_analysis_result') = ?
        AND (SELECT COUNT(*) FROM import_rows
             WHERE import_job_id = saved_job.id AND status = 'imported') = ?
        AND EXISTS (
          SELECT 1 FROM audit_log
          WHERE id = ? AND entity_id = saved_report.id
        )
    ) THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    finalStatus,
    now,
    now,
    reportId,
    input.paddockId,
    input.rows.length,
    input.rows.length,
    input.rows.length,
    auditId,
  ));
  if (statements.length > BATCH_STATEMENT_LIMIT) {
    throw new ImportCenterError(
      "El informe de suelo genera demasiadas escrituras para una confirmación segura.",
      "IMPORT_CONFIRMATION_LIMIT",
    );
  }
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const completed = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (completed?.complete !== 1) {
      throw new ImportCenterError(
        "La importación cambió después de la revisión. Vuelve a abrirla.",
        "IMPORT_PLAN_STALE",
      );
    }
  } catch (cause) {
    const existing = await readPostCommitConfirmationSafely(
      () => existingSoilConfirmation(input.preview, input.access),
    );
    if (existing) return existing;
    if (cause instanceof ImportCenterError) throw cause;
    throw new ImportCenterError(
      "La importación cambió después de la revisión. Vuelve a abrirla.",
      "IMPORT_PLAN_STALE",
    );
  }
  return {
    importJobId: input.preview.id,
    targetEntity: "soil_analysis_report",
    targetId: reportId,
    visitId: null,
    status: finalStatus,
    importedRowCount: input.rows.length,
    skippedRowCount: 0,
    confirmedAt: now,
    reused: false,
  };
}

async function persistSurvetConfirmation(input: {
  access: ImportActorAccess;
  preview: ImportCenterPreview;
  rows: CanonicalSurvetRow[];
}): Promise<ImportConfirmationReceiptBase> {
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const auditId = `audit:import-survet-controls:${input.preview.id}`;
  const fieldIds = JSON.stringify(input.access.fieldIds);
  const finalStatus = input.preview.summary.warningRowCount > 0
    || input.preview.summary.skippedRowCount > 0
    ? "completed_with_errors"
    : "completed";
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET status = 'importing', updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'survet'
      AND status = 'preview_ready'
      AND updated_at = ?
      AND error_row_count = 0
      AND file_issue_count = 0
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM source_records WHERE import_job_id = import_jobs.id)
      AND (SELECT COUNT(*) FROM import_rows AS ready_row
           WHERE ready_row.import_job_id = import_jobs.id
             AND ready_row.status IN ('valid', 'warning')) = ?
      AND NOT EXISTS (
        SELECT 1
        FROM import_rows AS stale_row
        WHERE stale_row.import_job_id = import_jobs.id
          AND stale_row.status IN ('valid', 'warning')
          AND NOT EXISTS (
            SELECT 1
            FROM livestock_animals AS current_animal
            INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
            WHERE current_animal.id = json_extract(stale_row.normalized_record, '$.animalId')
              AND current_animal.status = 'active'
              AND current_lot.field_id = import_jobs.field_id
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM import_rows AS conflicting_row
        INNER JOIN livestock_milk_controls AS existing_control
          ON existing_control.animal_id = json_extract(conflicting_row.normalized_record, '$.animalId')
         AND existing_control.control_date = json_extract(conflicting_row.normalized_record, '$.controlDate')
        WHERE conflicting_row.import_job_id = import_jobs.id
          AND conflicting_row.status IN ('valid', 'warning')
          AND existing_control.field_id = import_jobs.field_id
      )
      AND EXISTS (
        SELECT 1 FROM import_job_specs AS current_spec
        WHERE current_spec.import_job_id = import_jobs.id
          AND current_spec.profile_key = 'survet.milk_control.xlsx.v1'
          AND current_spec.profile_version = ?
      )
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = ?
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(?))
         AND current_actor.normalized_email <> ?
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
  `).bind(
    token,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    input.preview.revision,
    input.rows.length,
    input.preview.profileVersion,
    input.access.membershipId,
    input.access.email,
    DEMO_EMAIL,
    input.access.organizationId,
    fieldIds,
  )];

  for (const row of input.rows) {
    const controlId = `milk-control:survet:${row.importRowId}`;
    const sourceId = `source:survet-milk-control:${row.importRowId}`;
    const notes = [
      row.notes,
      "Survet reporta producción en kg; FundoSmart conserva el valor fuente como equivalente operativo 1:1, sin aplicar densidad.",
    ].filter(Boolean).join(" ");
    statements.push(client.prepare(`
      INSERT INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table,
        source_key, target_entity, target_id, created_at
      )
      SELECT ?, ?, ?, 'survet', 'survet.milk_control.xlsx.v1', ?,
             'livestock_milk_control', ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM import_rows AS current_row
        INNER JOIN import_jobs AS current_job ON current_job.id = current_row.import_job_id
        WHERE current_row.id = ?
          AND current_row.import_job_id = ?
          AND current_row.status IN ('valid', 'warning')
          AND current_job.status = 'importing'
          AND current_job.updated_at = ?
          AND json_extract(current_row.normalized_record, '$.animalId') = ?
          AND json_extract(current_row.normalized_record, '$.controlDate') = ?
      )
    `).bind(
      sourceId,
      input.preview.id,
      row.importRowId,
      row.externalAnimalId,
      controlId,
      now,
      row.importRowId,
      input.preview.id,
      token,
      row.animalId,
      row.controlDate,
    ));
    statements.push(client.prepare(`
      INSERT INTO livestock_milk_controls (
        id, field_id, animal_id, lactation_id, control_date,
        morning_liters, afternoon_liters, third_milking_liters, total_liters,
        fat_pct, protein_pct, somatic_cell_count, notes, source,
        source_record_id, created_by, created_at, updated_at
      )
      SELECT ?, ?, ?, (
        SELECT current_lactation.id
        FROM livestock_lactations AS current_lactation
        WHERE current_lactation.animal_id = ?
          AND current_lactation.started_at <= ?
          AND (current_lactation.ended_at IS NULL OR current_lactation.ended_at >= ?)
        ORDER BY current_lactation.sequence_number DESC
        LIMIT 1
      ), ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM source_records AS saved_source
        INNER JOIN import_jobs AS current_job ON current_job.id = saved_source.import_job_id
        INNER JOIN livestock_animals AS current_animal ON current_animal.id = ?
        INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
        WHERE saved_source.id = ?
          AND saved_source.import_job_id = ?
          AND saved_source.import_row_id = ?
          AND saved_source.target_entity = 'livestock_milk_control'
          AND saved_source.target_id = ?
          AND current_job.status = 'importing'
          AND current_job.updated_at = ?
          AND current_animal.status = 'active'
          AND current_lot.field_id = ?
      )
    `).bind(
      controlId,
      input.preview.fieldId,
      row.animalId,
      row.animalId,
      row.controlDate,
      row.controlDate,
      row.controlDate,
      row.morningLiters,
      row.afternoonLiters,
      row.totalLiters,
      row.somaticCellCount,
      notes,
      "Survet · kg fuente (equivalente operativo 1:1)",
      sourceId,
      input.access.email,
      now,
      now,
      row.animalId,
      sourceId,
      input.preview.id,
      row.importRowId,
      controlId,
      token,
      input.preview.fieldId,
    ));
    statements.push(client.prepare(`
      UPDATE import_rows
      SET status = 'imported', updated_at = ?
      WHERE id = ?
        AND import_job_id = ?
        AND status IN ('valid', 'warning')
        AND EXISTS (
          SELECT 1
          FROM source_records AS saved_source
          INNER JOIN livestock_milk_controls AS saved_control
            ON saved_control.id = saved_source.target_id
           AND saved_control.source_record_id = saved_source.id
          WHERE saved_source.id = ?
            AND saved_source.import_job_id = import_rows.import_job_id
            AND saved_source.import_row_id = import_rows.id
        )
    `).bind(now, row.importRowId, input.preview.id, sourceId));
  }

  const auditAfter = JSON.stringify({
    importJobId: input.preview.id,
    providerKey: "survet",
    profileKey: input.preview.profileKey,
    controlDate: input.preview.effectiveAt,
    importedRowCount: input.rows.length,
    skippedRowCount: input.preview.summary.skippedRowCount,
    sourceMilkUnit: "kg",
    canonicalProductionUnit: "liter_equivalent",
    productionConversion: "source_value_preserved_1_to_1",
    rcsReportedUnit: "thousand_cells_per_ml",
    rcsCanonicalUnit: "cells_per_ml",
    rcsMultiplier: 1000,
  });
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, 'import.survet_milk_control.confirm',
           'livestock_milk_control_batch', ?, NULL, ?, NULL, ?
    WHERE (SELECT COUNT(*)
           FROM source_records AS saved_source
           INNER JOIN livestock_milk_controls AS saved_control
             ON saved_control.id = saved_source.target_id
            AND saved_control.source_record_id = saved_source.id
           WHERE saved_source.import_job_id = ?) = ?
  `).bind(
    auditId,
    input.access.organizationId,
    input.preview.fieldId,
    input.access.email,
    input.preview.id,
    auditAfter,
    now,
    input.preview.id,
    input.rows.length,
  ));
  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = ?, is_dry_run = 0, confirmed_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'importing'
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM import_rows
           WHERE import_job_id = import_jobs.id AND status = 'imported') = ?
      AND (SELECT COUNT(*) FROM import_rows
           WHERE import_job_id = import_jobs.id AND status = 'skipped') = ?
      AND (SELECT COUNT(*) FROM source_records
           WHERE import_job_id = import_jobs.id
             AND target_entity = 'livestock_milk_control') = ?
      AND EXISTS (
        SELECT 1 FROM audit_log
        WHERE id = ? AND entity_id = import_jobs.id
      )
  `).bind(
    finalStatus,
    now,
    now,
    now,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.rows.length,
    input.preview.summary.skippedRowCount,
    input.rows.length,
    auditId,
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM import_jobs AS saved_job
      WHERE saved_job.id = ?
        AND saved_job.organization_id = ?
        AND saved_job.field_id = ?
        AND saved_job.status = ?
        AND saved_job.confirmed_at = ?
        AND saved_job.completed_at = ?
        AND (SELECT COUNT(*) FROM import_rows
             WHERE import_job_id = saved_job.id AND status = 'imported') = ?
        AND (SELECT COUNT(*) FROM import_rows
             WHERE import_job_id = saved_job.id AND status = 'skipped') = ?
        AND (SELECT COUNT(*) FROM source_records
             WHERE import_job_id = saved_job.id
               AND target_entity = 'livestock_milk_control') = ?
        AND EXISTS (
          SELECT 1 FROM audit_log
          WHERE id = ? AND entity_id = saved_job.id
        )
    ) THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    finalStatus,
    now,
    now,
    input.rows.length,
    input.preview.summary.skippedRowCount,
    input.rows.length,
    auditId,
  ));
  if (statements.length > BATCH_STATEMENT_LIMIT) {
    throw new ImportCenterError(
      "La planilla Survet genera demasiadas escrituras para una confirmación segura.",
      "IMPORT_CONFIRMATION_LIMIT",
    );
  }
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const completed = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (completed?.complete !== 1) {
      throw new ImportCenterError(
        "La importación cambió después de la revisión. Vuelve a abrirla.",
        "IMPORT_PLAN_STALE",
      );
    }
  } catch (cause) {
    const existing = await readPostCommitConfirmationSafely(
      () => existingSurvetConfirmation(input.preview, input.access),
    );
    if (existing) return existing;
    if (cause instanceof ImportCenterError) throw cause;
    throw new ImportCenterError(
      "La importación cambió después de la revisión. Vuelve a abrirla.",
      "IMPORT_PLAN_STALE",
    );
  }
  return {
    importJobId: input.preview.id,
    targetEntity: "livestock_milk_control_batch",
    targetId: input.preview.id,
    visitId: null,
    status: finalStatus,
    importedRowCount: input.rows.length,
    skippedRowCount: input.preview.summary.skippedRowCount,
    confirmedAt: now,
    reused: false,
  };
}

async function persistAgronomicConfirmation(input: {
  access: ImportActorAccess;
  preview: ImportCenterPreview;
  rows: CanonicalAgronomicRecommendationRow[];
}): Promise<ImportConfirmationReceiptBase> {
  const document = input.preview.document;
  if (document.kind !== "agronomic_visit_report") {
    throw new ImportCenterError(
      "El perfil agronómico perdió su documento normalizado.",
      "IMPORT_PROFILE_STALE",
    );
  }
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const visitId = `field-visit:${input.preview.id}`;
  const auditId = `audit:import-agronomic-visit:${input.preview.id}`;
  const fieldIds = JSON.stringify(input.access.fieldIds);
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET status = 'importing', updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'agronomic_advisor'
      AND status = 'preview_ready'
      AND updated_at = ?
      AND valid_row_count = ?
      AND warning_row_count = 0
      AND error_row_count = 0
      AND file_issue_count = 0
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM field_visits WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (SELECT 1 FROM source_records WHERE import_job_id = import_jobs.id)
      AND NOT EXISTS (
        SELECT 1
        FROM import_rows AS current_row
        LEFT JOIN potreros AS current_paddock
          ON current_paddock.id = json_extract(current_row.normalized_record, '$.paddockId')
         AND current_paddock.field_id = import_jobs.field_id
         AND current_paddock.deleted_at IS NULL
         AND current_paddock.archived_at IS NULL
        WHERE current_row.import_job_id = import_jobs.id
          AND (
            current_row.status <> 'valid'
            OR current_paddock.id IS NULL
          )
      )
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = ?
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(?))
         AND current_actor.normalized_email <> ?
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
  `).bind(
    token,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    input.preview.revision,
    input.rows.length,
    input.access.membershipId,
    input.access.email,
    DEMO_EMAIL,
    input.access.organizationId,
    fieldIds,
  ), client.prepare(`
    INSERT INTO field_visits (
      id, organization_id, field_id, import_job_id, visit_kind, provider_key,
      profile_key, profile_version, visit_date, next_visit_date, report_generated_at,
      external_producer_name, external_producer_code, snapshot_json,
      confirmed_by, confirmed_at, created_at
    )
    SELECT ?, ?, ?, ?, 'technical_visit', 'agronomic_advisor',
           current_spec.profile_key, current_spec.profile_version, ?, NULL, NULL,
           NULL, NULL, current_spec.document_json, ?, ?, ?
    FROM import_job_specs AS current_spec
    INNER JOIN import_jobs AS current_job ON current_job.id = current_spec.import_job_id
    WHERE current_job.id = ?
      AND current_job.organization_id = ?
      AND current_job.field_id = ?
      AND current_job.source_system = 'agronomic_advisor'
      AND current_job.status = 'importing'
      AND current_job.updated_at = ?
      AND current_spec.profile_key = 'agronomic.visit_report.pdf.v1'
      AND current_spec.profile_version = ?
      AND json_extract(current_spec.document_json, '$.kind') = 'agronomic_visit_report'
  `).bind(
    visitId,
    input.access.organizationId,
    input.preview.fieldId,
    input.preview.id,
    document.visitDate,
    input.access.email,
    now,
    now,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.preview.profileVersion,
  )];

  for (const row of input.rows) {
    const recommendationId = `field-visit-recommendation:${row.importRowId}`;
    const sourceId = `source:field-visit-recommendation:${row.importRowId}`;
    statements.push(client.prepare(`
      INSERT INTO field_visit_recommendations (
        id, organization_id, field_id, visit_id, import_job_id, import_row_id,
        sequence_number, action_group_number, external_paddock_key, paddock_id,
        visit_date, action_heading, recommendation_text, reported_group_area_ha,
        snapshot_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM import_rows AS current_row
        INNER JOIN import_jobs AS current_job ON current_job.id = current_row.import_job_id
        INNER JOIN field_visits AS current_visit ON current_visit.import_job_id = current_job.id
        INNER JOIN potreros AS current_paddock
          ON current_paddock.id = ?
         AND current_paddock.field_id = current_job.field_id
         AND current_paddock.deleted_at IS NULL
         AND current_paddock.archived_at IS NULL
        WHERE current_row.id = ?
          AND current_row.import_job_id = ?
          AND current_row.status = 'valid'
          AND json_extract(current_row.normalized_record, '$.paddockId') = ?
          AND current_job.status = 'importing'
          AND current_job.updated_at = ?
          AND current_visit.id = ?
      )
    `).bind(
      recommendationId,
      input.access.organizationId,
      input.preview.fieldId,
      visitId,
      input.preview.id,
      row.importRowId,
      row.sequenceNumber,
      row.actionGroupNumber,
      row.externalPaddockKey,
      row.paddockId,
      row.visitDate,
      row.actionHeading,
      row.recommendationText,
      row.reportedGroupAreaHa,
      JSON.stringify(row.snapshot),
      now,
      row.paddockId,
      row.importRowId,
      input.preview.id,
      row.paddockId,
      token,
      visitId,
    ));
    statements.push(client.prepare(`
      INSERT INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table,
        source_key, target_entity, target_id, created_at
      )
      SELECT ?, ?, ?, 'agronomic_advisor', 'agronomic.visit_report.pdf.v1',
             ?, 'field_visit_recommendation', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM field_visit_recommendations
        WHERE id = ?
          AND import_job_id = ?
          AND import_row_id = ?
      )
    `).bind(
      sourceId,
      input.preview.id,
      row.importRowId,
      row.externalPaddockKey,
      recommendationId,
      now,
      recommendationId,
      input.preview.id,
      row.importRowId,
    ));
    statements.push(client.prepare(`
      UPDATE import_rows
      SET status = 'imported', updated_at = ?
      WHERE id = ?
        AND import_job_id = ?
        AND status = 'valid'
        AND EXISTS (
          SELECT 1 FROM source_records
          WHERE id = ?
            AND import_job_id = import_rows.import_job_id
            AND import_row_id = import_rows.id
        )
    `).bind(now, row.importRowId, input.preview.id, sourceId));
  }

  const auditAfter = JSON.stringify({
    importJobId: input.preview.id,
    profileKey: input.preview.profileKey,
    recommendationCount: input.rows.length,
    visitDate: document.visitDate,
    visitId,
  });
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, 'import.agronomic_visit.confirm', 'field_visit', ?,
           NULL, ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM field_visits
      WHERE id = ?
        AND import_job_id = ?
        AND (SELECT COUNT(*) FROM field_visit_recommendations
             WHERE visit_id = field_visits.id) = ?
    )
  `).bind(
    auditId,
    input.access.organizationId,
    input.preview.fieldId,
    input.access.email,
    visitId,
    auditAfter,
    now,
    visitId,
    input.preview.id,
    input.rows.length,
  ));
  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = 'completed', is_dry_run = 0, confirmed_at = ?,
        completed_at = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system = 'agronomic_advisor'
      AND status = 'importing'
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM import_rows
           WHERE import_job_id = import_jobs.id AND status = 'imported') = ?
      AND (SELECT COUNT(*) FROM source_records
           WHERE import_job_id = import_jobs.id
             AND target_entity = 'field_visit_recommendation') = ?
      AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND entity_id = ?)
  `).bind(
    now,
    now,
    now,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.rows.length,
    input.rows.length,
    auditId,
    visitId,
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1
      FROM import_jobs AS saved_job
      INNER JOIN field_visits AS saved_visit ON saved_visit.import_job_id = saved_job.id
      WHERE saved_job.id = ?
        AND saved_job.organization_id = ?
        AND saved_job.field_id = ?
        AND saved_job.source_system = 'agronomic_advisor'
        AND saved_job.status = 'completed'
        AND saved_job.confirmed_at = ?
        AND saved_visit.id = ?
        AND (SELECT COUNT(*) FROM field_visit_recommendations
             WHERE visit_id = saved_visit.id) = ?
    ) THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    now,
    visitId,
    input.rows.length,
  ));
  if (statements.length > BATCH_STATEMENT_LIMIT) {
    throw new ImportCenterError(
      "El informe genera demasiadas escrituras para una confirmación segura.",
      "IMPORT_CONFIRMATION_LIMIT",
    );
  }
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const completed = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (completed?.complete !== 1) {
      throw new ImportCenterError(
        "La importación cambió después de la revisión. Vuelve a abrirla.",
        "IMPORT_PLAN_STALE",
      );
    }
  } catch (cause) {
    const existing = await readPostCommitConfirmationSafely(
      () => existingConfirmation(input.preview, input.access),
    );
    if (existing) return existing;
    if (cause instanceof ImportCenterError) throw cause;
    throw new ImportCenterError(
      "La importación cambió después de la revisión. Vuelve a abrirla.",
      "IMPORT_PLAN_STALE",
    );
  }
  return {
    importJobId: input.preview.id,
    targetEntity: "field_visit",
    targetId: visitId,
    visitId,
    status: "completed",
    importedRowCount: input.rows.length,
    skippedRowCount: 0,
    confirmedAt: now,
    reused: false,
  };
}

async function persistConfirmation(input: {
  access: ImportActorAccess;
  preview: ImportCenterPreview;
  rows: CanonicalVisitRow[];
  visitDate: string;
}): Promise<ImportConfirmationReceiptBase> {
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const now = new Date().toISOString();
  const token = crypto.randomUUID();
  const visitId = `field-visit:${input.preview.id}`;
  const auditId = `audit:import-visit:${input.preview.id}`;
  const fieldIds = JSON.stringify(input.access.fieldIds);
  const document = input.preview.document;
  const visitKind = document.kind === "watts_visit_report" ? "technical_visit" : "pasture_measurement_batch";
  const nextVisitDate = document.kind === "watts_visit_report" ? document.nextVisitDate : null;
  const reportGeneratedAt = document.kind === "watts_visit_report" ? document.reportGeneratedLocal : null;
  const producerName = document.kind === "watts_visit_report" ? document.producer.name : null;
  const producerCode = document.kind === "watts_visit_report" ? document.producer.code : null;
  const finalStatus = input.preview.summary.warningRowCount > 0 ? "completed_with_errors" : "completed";
  const statements: BatchItem[] = [client.prepare(`
    UPDATE import_jobs
    SET status = 'importing', updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND source_system IN ('watts', 'generic')
      AND status = 'preview_ready'
      AND updated_at = ?
      AND error_row_count = 0
      AND file_issue_count = 0
      AND confirmed_at IS NULL
      AND completed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM field_visits WHERE import_job_id = import_jobs.id)
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = ?
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(?))
         AND current_actor.normalized_email <> ?
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = ?
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
  `).bind(
    token,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    input.preview.revision,
    input.access.membershipId,
    input.access.email,
    DEMO_EMAIL,
    input.access.organizationId,
    fieldIds,
  ), client.prepare(`
    INSERT INTO field_visits (
      id, organization_id, field_id, import_job_id, visit_kind, provider_key,
      profile_key, profile_version, visit_date, next_visit_date, report_generated_at,
      external_producer_name, external_producer_code, snapshot_json,
      confirmed_by, confirmed_at, created_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM import_jobs AS current_job
      INNER JOIN import_job_specs AS current_spec ON current_spec.import_job_id = current_job.id
      WHERE current_job.id = ?
        AND current_job.organization_id = ?
        AND current_job.field_id = ?
        AND current_job.status = 'importing'
        AND current_job.updated_at = ?
        AND current_spec.profile_key = ?
        AND current_spec.profile_version = ?
    )
  `).bind(
    visitId,
    input.access.organizationId,
    input.preview.fieldId,
    input.preview.id,
    visitKind,
    input.preview.sourceSystem,
    input.preview.profileKey,
    input.preview.profileVersion,
    input.visitDate,
    nextVisitDate,
    reportGeneratedAt,
    producerName,
    producerCode,
    JSON.stringify(document),
    input.access.email,
    now,
    now,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.preview.profileKey,
    input.preview.profileVersion,
  )];

  for (const row of input.rows) {
    const childId = `field-visit-paddock:${row.importRowId}`;
    const sourceId = `source:field-visit-paddock:${row.importRowId}`;
    statements.push(client.prepare(`
      INSERT INTO field_visit_paddocks (
        id, organization_id, field_id, visit_id, import_job_id, import_row_id,
        sequence_number, external_paddock_key, paddock_id, observed_at, planned_entry_date,
        current_biomass_kg_dm_ha, projected_biomass_kg_dm_ha, area_ha, daily_area_ha,
        calculated_days, adjusted_days, adjusted_intake_kg_dm_cow_day, notes,
        snapshot_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM import_rows AS current_row
        INNER JOIN import_jobs AS current_job ON current_job.id = current_row.import_job_id
        INNER JOIN field_visits AS current_visit ON current_visit.import_job_id = current_job.id
        WHERE current_row.id = ?
          AND current_row.import_job_id = ?
          AND current_row.status IN ('valid', 'warning')
          AND current_job.status = 'importing'
          AND current_job.updated_at = ?
          AND current_visit.id = ?
      )
    `).bind(
      childId,
      input.access.organizationId,
      input.preview.fieldId,
      visitId,
      input.preview.id,
      row.importRowId,
      row.sequenceNumber,
      row.externalPaddockKey,
      row.observedAt,
      row.plannedEntryDate,
      row.currentBiomassKgDmHa,
      row.projectedBiomassKgDmHa,
      row.areaHa,
      row.dailyAreaHa,
      row.calculatedDays,
      row.adjustedDays,
      row.adjustedIntakeKgDmCowDay,
      row.notes,
      JSON.stringify(row.snapshot),
      now,
      row.importRowId,
      input.preview.id,
      token,
      visitId,
    ));
    statements.push(client.prepare(`
      INSERT INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table,
        source_key, target_entity, target_id, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, 'field_visit_paddock', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM field_visit_paddocks AS saved_row
        WHERE saved_row.id = ?
          AND saved_row.import_job_id = ?
          AND saved_row.import_row_id = ?
      )
    `).bind(
      sourceId,
      input.preview.id,
      row.importRowId,
      input.preview.sourceSystem,
      input.preview.profileKey,
      row.externalPaddockKey,
      childId,
      now,
      childId,
      input.preview.id,
      row.importRowId,
    ));
    statements.push(client.prepare(`
      UPDATE import_rows
      SET status = 'imported', updated_at = ?
      WHERE id = ?
        AND import_job_id = ?
        AND status IN ('valid', 'warning')
        AND EXISTS (
          SELECT 1 FROM source_records
          WHERE source_records.id = ?
            AND source_records.import_job_id = import_rows.import_job_id
            AND source_records.import_row_id = import_rows.id
        )
    `).bind(now, row.importRowId, input.preview.id, sourceId));
  }

  const auditAfter = JSON.stringify({
    importJobId: input.preview.id,
    providerKey: input.preview.sourceSystem,
    profileKey: input.preview.profileKey,
    rowCount: input.rows.length,
    visitDate: input.visitDate,
    visitId,
  });
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, 'import.visit.confirm', 'field_visit', ?, NULL, ?, NULL, ?
    WHERE EXISTS (
      SELECT 1 FROM field_visits
      WHERE field_visits.id = ?
        AND field_visits.import_job_id = ?
        AND (SELECT COUNT(*) FROM field_visit_paddocks WHERE visit_id = field_visits.id) = ?
    )
  `).bind(
    auditId,
    input.access.organizationId,
    input.preview.fieldId,
    input.access.email,
    visitId,
    auditAfter,
    now,
    visitId,
    input.preview.id,
    input.rows.length,
  ));
  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = ?, is_dry_run = 0, confirmed_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'importing'
      AND updated_at = ?
      AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = import_jobs.id AND status = 'imported') = ?
      AND (SELECT COUNT(*) FROM source_records WHERE import_job_id = import_jobs.id AND target_entity = 'field_visit_paddock') = ?
      AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND entity_id = ?)
  `).bind(
    finalStatus,
    now,
    now,
    now,
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    token,
    input.rows.length,
    input.rows.length,
    auditId,
    visitId,
  ));
  statements.push(client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM import_jobs AS saved_job
      INNER JOIN field_visits AS saved_visit ON saved_visit.import_job_id = saved_job.id
      WHERE saved_job.id = ?
        AND saved_job.organization_id = ?
        AND saved_job.field_id = ?
        AND saved_job.status = ?
        AND saved_job.confirmed_at = ?
        AND saved_job.completed_at = ?
        AND saved_visit.id = ?
        AND (SELECT COUNT(*) FROM field_visit_paddocks WHERE visit_id = saved_visit.id) = ?
        AND (SELECT COUNT(*) FROM source_records WHERE import_job_id = saved_job.id AND target_entity = 'field_visit_paddock') = ?
        AND (SELECT COUNT(*) FROM import_rows WHERE import_job_id = saved_job.id AND status = 'imported') = ?
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ? AND entity_id = saved_visit.id)
    ) THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    input.preview.id,
    input.access.organizationId,
    input.preview.fieldId,
    finalStatus,
    now,
    now,
    visitId,
    input.rows.length,
    input.rows.length,
    input.rows.length,
    auditId,
  ));
  if (statements.length > BATCH_STATEMENT_LIMIT) {
    throw new ImportCenterError("La importación genera demasiadas escrituras para una confirmación segura.", "IMPORT_CONFIRMATION_LIMIT");
  }
  try {
    const results = await client.batch(statements as [BatchItem, ...BatchItem[]]);
    const completed = results.at(-1)?.results[0] as { complete?: number } | undefined;
    if (completed?.complete !== 1) throw new ImportCenterError("La importación cambió después de la revisión. Vuelve a abrirla.", "IMPORT_PLAN_STALE");
  } catch (cause) {
    const existing = await readPostCommitConfirmationSafely(
      () => existingConfirmation(input.preview, input.access),
    );
    if (existing) return existing;
    if (cause instanceof ImportCenterError) throw cause;
    throw new ImportCenterError("La importación cambió después de la revisión. Vuelve a abrirla.", "IMPORT_PLAN_STALE");
  }
  return {
    importJobId: input.preview.id,
    targetEntity: "field_visit",
    targetId: visitId,
    visitId,
    status: finalStatus,
    importedRowCount: input.rows.length,
    skippedRowCount: input.preview.summary.skippedRowCount,
    confirmedAt: now,
    reused: false,
  };
}

async function existingSoilConfirmation(
  preview: ImportCenterPreview,
  access: ImportActorAccess,
): Promise<ImportConfirmationReceiptBase | null> {
  const [saved] = await getDb()
    .select({
      id: soilAnalysisReports.id,
      confirmedAt: soilAnalysisReports.confirmedAt,
      status: importJobs.status,
      resultCount: count(soilAnalysisResults.id),
    })
    .from(soilAnalysisReports)
    .innerJoin(importJobs, eq(importJobs.id, soilAnalysisReports.importJobId))
    .innerJoin(fields, eq(fields.id, soilAnalysisReports.fieldId))
    .leftJoin(soilAnalysisResults, eq(soilAnalysisResults.reportId, soilAnalysisReports.id))
    .where(and(
      eq(soilAnalysisReports.importJobId, preview.id),
      eq(soilAnalysisReports.organizationId, access.organizationId),
      eq(soilAnalysisReports.providerKey, "cooprinsem"),
      eq(soilAnalysisReports.profileKey, preview.profileKey),
      eq(soilAnalysisReports.profileVersion, preview.profileVersion),
      eq(fields.organizationId, access.organizationId),
      inArray(soilAnalysisReports.fieldId, access.fieldIds),
      inArray(fields.id, access.fieldIds),
    ))
    .groupBy(soilAnalysisReports.id, soilAnalysisReports.confirmedAt, importJobs.status)
    .limit(1);
  if (
    !saved
    || (saved.status !== "completed" && saved.status !== "completed_with_errors")
    || Number(saved.resultCount) !== preview.summary.rowCount
  ) {
    return null;
  }
  await assertCurrentImportActorAccess(access, [preview.fieldId]);
  return {
    importJobId: preview.id,
    targetEntity: "soil_analysis_report",
    targetId: saved.id,
    visitId: null,
    status: saved.status,
    importedRowCount: Number(saved.resultCount),
    skippedRowCount: preview.summary.skippedRowCount,
    confirmedAt: saved.confirmedAt,
    reused: true,
  };
}

async function existingConfirmation(
  preview: ImportCenterPreview,
  access: ImportActorAccess,
): Promise<ImportConfirmationReceiptBase | null> {
  const [visit] = await getDb()
    .select({ id: fieldVisits.id, confirmedAt: fieldVisits.confirmedAt })
    .from(fieldVisits)
    .innerJoin(fields, eq(fields.id, fieldVisits.fieldId))
    .where(and(
      eq(fieldVisits.importJobId, preview.id),
      eq(fieldVisits.organizationId, access.organizationId),
      eq(fieldVisits.providerKey, preview.sourceSystem),
      eq(fieldVisits.profileKey, preview.profileKey),
      eq(fieldVisits.profileVersion, preview.profileVersion),
      eq(fields.organizationId, access.organizationId),
      inArray(fieldVisits.fieldId, access.fieldIds),
      inArray(fields.id, access.fieldIds),
    ))
    .limit(1);
  if (!visit) return null;
  await assertCurrentImportActorAccess(access, [preview.fieldId]);
  return {
    importJobId: preview.id,
    targetEntity: "field_visit",
    targetId: visit.id,
    visitId: visit.id,
    status: preview.status === "completed" ? "completed" : "completed_with_errors",
    importedRowCount: preview.summary.rowCount,
    skippedRowCount: preview.summary.skippedRowCount,
    confirmedAt: visit.confirmedAt,
    reused: true,
  };
}

async function existingSurvetConfirmation(
  preview: ImportCenterPreview,
  access: ImportActorAccess,
): Promise<ImportConfirmationReceiptBase | null> {
  const fieldIds = JSON.stringify(access.fieldIds);
  const saved = await getDb().$client.prepare(`
    SELECT saved_job.confirmed_at AS confirmedAt,
           saved_job.status AS status,
           (SELECT COUNT(*) FROM import_rows
            WHERE import_job_id = saved_job.id AND status = 'imported') AS importedRowCount,
           (SELECT COUNT(*) FROM import_rows
            WHERE import_job_id = saved_job.id AND status = 'skipped') AS skippedRowCount
    FROM import_jobs AS saved_job
    INNER JOIN fields AS saved_field ON saved_field.id = saved_job.field_id
    WHERE saved_job.id = ?
      AND saved_job.organization_id = ?
      AND saved_job.field_id = ?
      AND saved_job.source_system = 'survet'
      AND saved_job.status IN ('completed', 'completed_with_errors')
      AND saved_job.confirmed_at IS NOT NULL
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      AND EXISTS (
        SELECT 1 FROM audit_log AS saved_audit
        WHERE saved_audit.organization_id = saved_job.organization_id
          AND saved_audit.field_id = saved_job.field_id
          AND saved_audit.action = 'import.survet_milk_control.confirm'
          AND saved_audit.entity_type = 'livestock_milk_control_batch'
          AND saved_audit.entity_id = saved_job.id
      )
  `).bind(
    preview.id,
    access.organizationId,
    preview.fieldId,
    access.organizationId,
    fieldIds,
  ).first<{
    confirmedAt: string;
    status: "completed" | "completed_with_errors";
    importedRowCount: number;
    skippedRowCount: number;
  }>();
  if (!saved) return null;
  await assertCurrentImportActorAccess(access, [preview.fieldId]);
  return {
    importJobId: preview.id,
    targetEntity: "livestock_milk_control_batch",
    targetId: preview.id,
    visitId: null,
    status: saved.status,
    importedRowCount: Number(saved.importedRowCount),
    skippedRowCount: Number(saved.skippedRowCount),
    confirmedAt: saved.confirmedAt,
    reused: true,
  };
}

async function existingLivestockInventoryConfirmation(
  preview: ImportCenterPreview,
  access: ImportActorAccess,
): Promise<ImportConfirmationReceiptBase | null> {
  const fieldIds = JSON.stringify(access.fieldIds);
  const saved = await getDb().$client.prepare(`
    SELECT saved_job.confirmed_at AS confirmedAt,
           saved_job.status AS status,
           (SELECT COUNT(*) FROM import_rows
            WHERE import_job_id = saved_job.id AND status = 'imported') AS importedRowCount,
           (SELECT COUNT(*) FROM import_rows
            WHERE import_job_id = saved_job.id AND status = 'skipped') AS skippedRowCount
    FROM import_jobs AS saved_job
    INNER JOIN fields AS saved_field ON saved_field.id = saved_job.field_id
    WHERE saved_job.id = ?
      AND saved_job.organization_id = ?
      AND saved_job.field_id = ?
      AND saved_job.status IN ('completed', 'completed_with_errors')
      AND saved_job.confirmed_at IS NOT NULL
      AND saved_field.organization_id = ?
      AND saved_field.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      AND EXISTS (
        SELECT 1 FROM audit_log AS saved_audit
        WHERE saved_audit.organization_id = saved_job.organization_id
          AND saved_audit.field_id = saved_job.field_id
          AND saved_audit.action = 'import.livestock_inventory.confirm'
          AND saved_audit.entity_type = 'livestock_inventory_batch'
          AND saved_audit.entity_id = saved_job.id
      )
  `).bind(
    preview.id,
    access.organizationId,
    preview.fieldId,
    access.organizationId,
    fieldIds,
  ).first<{
    confirmedAt: string;
    status: "completed" | "completed_with_errors";
    importedRowCount: number;
    skippedRowCount: number;
  }>();
  if (!saved) {
    return null;
  }
  await assertCurrentImportActorAccess(access, [preview.fieldId]);
  return {
    importJobId: preview.id,
    targetEntity: "livestock_inventory_batch",
    targetId: preview.id,
    visitId: null,
    status: saved.status,
    importedRowCount: Number(saved.importedRowCount),
    skippedRowCount: Number(saved.skippedRowCount),
    confirmedAt: saved.confirmedAt,
    reused: true,
  };
}

async function persistLivestockInventoryConfirmation(input: {
  access: ImportActorAccess;
  preview: ImportCenterPreview;
}): Promise<ImportConfirmationReceiptBase> {
  const client = getDb().$client;
  type BatchItem = Parameters<typeof client.batch>[0][number];
  const now = new Date().toISOString();

  const lotsResult = await client.prepare(`
    SELECT id, name FROM livestock_lots WHERE field_id = ?
  `).bind(input.preview.fieldId).all<{ id: string; name: string }>();

  const animalsResult = await client.prepare(`
    SELECT animal.id, animal.tag, animal.birth_date AS birthDate, animal.status
    FROM livestock_animals AS animal
    INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
    WHERE lot.field_id = ?
  `).bind(input.preview.fieldId).all<{ id: string; tag: string; birthDate: string | null; status: string }>();

  const existingLotsByName: Record<string, { id: string; name: string }> = {};
  for (const lot of (lotsResult.results ?? [])) {
    existingLotsByName[lot.name] = lot;
  }

  const existingAnimalsByTag: Record<string, { id: string; birthDate?: string | null; status?: "active" | "sold" | "departed" | "dead" }> = {};
  for (const animal of (animalsResult.results ?? [])) {
    existingAnimalsByTag[String(animal.tag)] = {
      id: animal.id,
      birthDate: animal.birthDate,
      status: animal.status as "active" | "sold" | "departed" | "dead" | undefined,
    };
  }

  const parsedRows: ParsedLivestockInventoryRow[] = input.preview.rows.map((r) => ({
    recordNumber: r.recordNumber,
    rowNumber: r.recordNumber + 1,
    rawRecord: r.rawRecord ?? {},
    normalizedRecord: (r.normalizedRecord ?? {}) as ParsedLivestockInventoryRow["normalizedRecord"],
    status: r.status as unknown as ParsedLivestockInventoryRow["status"],
    issues: r.issues ?? [],
  }));

  const parsed = {
    rows: parsedRows,
    document: input.preview.document ?? {},
    summary: input.preview.summary ?? {},
  };

  const plan = planLivestockInventoryImport(parsed, {
    fieldId: input.preview.fieldId,
    existingAnimalsByTag,
    existingLotsByName,
  });

  const readiness = evaluateLivestockInventoryPlanReadiness(plan);
  if (!readiness.confirmable) {
    throw new ImportCenterError(
      readiness.reason ?? "El inventario animal contiene conflictos irrenunciables.",
      "IMPORT_PLAN_NOT_READY",
    );
  }

  const newId = (kind: string, dedupeKey: string) =>
    `${kind}_${crypto.createHash("sha256").update(`${input.preview.id}:${kind}:${dedupeKey}`).digest("hex").slice(0, 24)}`;

  const { operations, unresolved } = buildLivestockInventoryOperations(plan, {
    existingAnimalsByTag,
    existingLotsByName,
    newId,
  });

  if (unresolved.length > 0) {
    throw new ImportCenterError(
      "No se pudieron resolver las referencias requeridas para la confirmación del inventario.",
      "IMPORT_UNRESOLVED_REFERENCES",
    );
  }

  const normalizeKey = (value: string | null | undefined) => String(value ?? "").trim().toLowerCase();

  const lotIdByCreatedKey = new Map<string, string>();
  for (const op of operations) {
    if (op.kind === "lot.insert" && "values" in op && op.values && typeof op.values === "object" && "name" in op.values) {
      lotIdByCreatedKey.set(normalizeKey(String((op.values as Record<string, unknown>).name)), op.id);
    }
  }
  for (const [name, lot] of Object.entries(existingLotsByName)) {
    lotIdByCreatedKey.set(normalizeKey(name), lot.id);
  }

  const statements: BatchItem[] = [
    client.prepare(`
      UPDATE import_jobs
      SET status = 'importing', updated_at = ?
      WHERE id = ?
        AND organization_id = ?
        AND field_id = ?
        AND status = 'preview_ready'
        AND confirmed_at IS NULL
    `).bind(now, input.preview.id, input.access.organizationId, input.preview.fieldId),
  ];

  let fallbackLotId = lotIdByCreatedKey.get("general") ?? lotIdByCreatedKey.values().next().value ?? null;
  if (!fallbackLotId) {
    fallbackLotId = newId("lot", "default:general");
    statements.push(client.prepare(`
      INSERT INTO livestock_lots (
        id, field_id, name, tracking_mode, category, animal_count, entry_date, status, created_at, updated_at
      ) VALUES (?, ?, 'General', 'individual', 'dairy', 0, ?, 'active', ?, ?)
    `).bind(fallbackLotId, input.preview.fieldId, now, now, now));
    lotIdByCreatedKey.set("general", fallbackLotId);
  }

  const resolveLotId = (lotName: string | null | undefined) => {
    if (!lotName) return fallbackLotId;
    return lotIdByCreatedKey.get(normalizeKey(lotName)) ?? fallbackLotId;
  };

  for (const op of operations) {
    if (op.kind === "lot.insert") {
      statements.push(client.prepare(`
        INSERT INTO livestock_lots (
          id, field_id, name, tracking_mode, category, animal_count, entry_date, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'individual', 'dairy', 0, ?, 'active', ?, ?)
      `).bind(op.id, input.preview.fieldId, op.values.name, now, now, now));
    } else if (op.kind === "animal.insert") {
      const membership = plan.lotMemberships.find((m) => m.tag === op.values.tag);
      const lotId = resolveLotId(membership?.lotName);
      statements.push(client.prepare(`
        INSERT INTO livestock_animals (
          id, lot_id, tag, sex, status, birth_date, source, created_at, updated_at
        ) VALUES (?, ?, ?, 'female', ?, ?, 'import_xlsx', ?, ?)
      `).bind(op.id, lotId, op.values.tag, op.values.status, op.values.birthDate, now, now));
    } else if (op.kind === "animal.update_birth_date") {
      statements.push(client.prepare(`
        UPDATE livestock_animals
        SET birth_date = ?, updated_at = ?
        WHERE id = ? AND (birth_date IS NULL OR birth_date <> ?)
      `).bind(op.values.birthDate, now, op.id, op.values.birthDate));
    } else if (op.kind === "animal.update_status") {
      statements.push(client.prepare(`
        UPDATE livestock_animals
        SET status = ?, status_date = ?, status_reason = ?, updated_at = ?
        WHERE id = ?
      `).bind(op.values.status, op.values.statusDate, op.values.statusReason, now, op.id));
    } else if (op.kind === "lot_membership.insert") {
      statements.push(client.prepare(`
        INSERT INTO livestock_lot_memberships (
          id, animal_id, lot_id, started_at, ended_at, source_system, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, 'import_xlsx', ?, ?)
      `).bind(op.id, op.values.animalId, op.values.lotId, now, now, now));
    } else if (op.kind === "reproductive_event.insert") {
      statements.push(client.prepare(`
        INSERT INTO livestock_reproductive_events (
          id, field_id, animal_id, event_type, occurred_at, method, result,
          sire_identifier, notes, metadata, source, source_record_id,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'import', ?, NULL, 'Importado de planilla de inventario', '{}', 'import_xlsx', NULL, ?, ?, ?)
      `).bind(
        op.id,
        input.preview.fieldId,
        op.values.animalId,
        op.values.eventType,
        op.values.occurredAt,
        op.values.result ?? null,
        input.access.email,
        now,
        now,
      ));
    } else if (op.kind === "birth.insert") {
      statements.push(client.prepare(`
        INSERT INTO livestock_births (
          id, field_id, dam_animal_id, reproductive_event_id, occurred_at,
          calving_type, difficulty, outcome, sire_identifier, notes, source,
          source_record_id, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'single', 'unassisted', 'live', NULL, 'Importado de planilla de inventario', 'import_xlsx', NULL, ?, ?, ?)
      `).bind(
        op.id,
        input.preview.fieldId,
        op.values.damAnimalId,
        op.values.reproductiveEventId,
        op.values.occurredAt,
        input.access.email,
        now,
        now,
      ));
    }
  }

  statements.push(client.prepare(`
    UPDATE import_rows
    SET status = 'imported', updated_at = ?
    WHERE import_job_id = ? AND status IN ('valid', 'warning')
  `).bind(now, input.preview.id));

  const outcomes = buildLivestockInventoryReceiptOutcomes(plan);
  const finalStatus = plan.conflicts.length > 0 || plan.pending.length > 0
    ? "completed_with_errors"
    : "completed";

  statements.push(client.prepare(`
    UPDATE import_jobs
    SET status = ?, confirmed_at = ?, completed_at = ?, updated_at = ?
    WHERE id = ? AND organization_id = ? AND field_id = ?
  `).bind(finalStatus, now, now, now, input.preview.id, input.access.organizationId, input.preview.fieldId));

  const auditId = `audit:import-livestock-inventory:${input.preview.id}`;
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    ) VALUES (?, ?, ?, ?, 'import.livestock_inventory.confirm', 'livestock_inventory_batch', ?, NULL, ?, NULL, ?)
  `).bind(
    auditId,
    input.access.organizationId,
    input.preview.fieldId,
    input.access.email,
    input.preview.id,
    JSON.stringify({ rowCount: plan.rowsSeen, importedRowCount: outcomes.insertedRowCount + outcomes.updatedRowCount }),
    now,
  ));

  await client.batch(statements);

  return {
    importJobId: input.preview.id,
    targetEntity: "livestock_inventory_batch",
    targetId: input.preview.id,
    visitId: null,
    status: finalStatus,
    importedRowCount: outcomes.insertedRowCount + outcomes.updatedRowCount,
    skippedRowCount: outcomes.unchangedRowCount + outcomes.rejectedRowCount,
    confirmedAt: now,
    reused: false,
  };
}

type CanonicalSoilRow = {
  importRowId: string;
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
  snapshot: ImportRecord;
};

function canonicalSoilRow(
  row: ImportCenterPreview["rows"][number],
): CanonicalSoilRow {
  if ((row.status !== "valid" && row.status !== "warning") || !row.normalizedRecord) {
    throw new ImportCenterError(
      `La fila ${row.recordNumber} de suelo no está lista para confirmar.`,
      "IMPORT_ROW_NOT_READY",
    );
  }
  const record = row.normalizedRecord;
  const sequenceNumber = finiteNumber(record.sequenceNumber);
  const value = finiteNumber(record.value);
  const idealMin = finiteNumber(record.idealMin);
  const idealMax = finiteNumber(record.idealMax);
  const analyteCode = text(record.analyteCode);
  const analyteName = text(record.analyteName);
  const unit = text(record.unit);
  const idealRangeText = text(record.idealRangeText);
  const rangeAssessment = text(record.rangeAssessment);
  const reportedClassification = text(record.reportedClassification) || null;
  const methodKey = text(record.methodKey) || null;
  const methodLabel = text(record.methodLabel) || null;
  if (
    sequenceNumber === null
    || !Number.isInteger(sequenceNumber)
    || sequenceNumber <= 0
    || !/^[a-z0-9_]{1,80}$/.test(analyteCode)
    || !analyteName
    || analyteName.length > 120
    || !unit
    || unit.length > 40
    || value === null
    || idealMin === null
    || idealMax === null
    || idealMin > idealMax
    || !idealRangeText
    || idealRangeText.length > 80
    || !["below", "within", "above"].includes(rangeAssessment)
    || (reportedClassification?.length ?? 0) > 120
    || Boolean(methodKey) !== Boolean(methodLabel)
    || (methodKey?.length ?? 0) > 120
    || (methodLabel?.length ?? 0) > 240
  ) {
    throw new ImportCenterError(
      `La fila ${row.recordNumber} de suelo no conserva el contrato normalizado.`,
      "IMPORT_ROW_INVALID",
    );
  }
  const expectedAssessment = value < idealMin ? "below" : value > idealMax ? "above" : "within";
  if (rangeAssessment !== expectedAssessment) {
    throw new ImportCenterError(
      `La clasificación por rango de la fila ${row.recordNumber} cambió.`,
      "IMPORT_ROW_INVALID",
    );
  }
  return {
    importRowId: row.id,
    sequenceNumber,
    analyteCode,
    analyteName,
    unit,
    value,
    idealMin,
    idealMax,
    idealRangeText,
    reportedClassification,
    rangeAssessment: rangeAssessment as SoilAnalysisRangeAssessment,
    methodKey,
    methodLabel,
    snapshot: record,
  };
}

function assertSoilRowsMatchDocument(
  rows: CanonicalSoilRow[],
  documentResults: Array<{
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
  }>,
) {
  if (
    rows.length === 0
    || rows.length !== documentResults.length
    || new Set(rows.map((row) => row.sequenceNumber)).size !== rows.length
    || new Set(rows.map((row) => row.analyteCode)).size !== rows.length
  ) {
    throw new ImportCenterError(
      "Las filas del análisis de suelo no coinciden con el documento revisado.",
      "IMPORT_PROFILE_STALE",
    );
  }
  for (const row of rows) {
    const result = documentResults.find((candidate) => candidate.sequenceNumber === row.sequenceNumber);
    if (
      !result
      || result.analyteCode !== row.analyteCode
      || result.analyteName !== row.analyteName
      || result.unit !== row.unit
      || result.value !== row.value
      || result.idealMin !== row.idealMin
      || result.idealMax !== row.idealMax
      || result.idealRangeText !== row.idealRangeText
      || result.reportedClassification !== row.reportedClassification
      || result.rangeAssessment !== row.rangeAssessment
      || result.methodKey !== row.methodKey
      || result.methodLabel !== row.methodLabel
    ) {
      throw new ImportCenterError(
        "Las filas del análisis de suelo no coinciden con el documento revisado.",
        "IMPORT_PROFILE_STALE",
      );
    }
  }
}

type CanonicalSurvetRow = {
  importRowId: string;
  animalId: string;
  animalTag: string;
  externalAnimalId: string;
  controlDate: string;
  morningLiters: number | null;
  afternoonLiters: number | null;
  totalLiters: number;
  somaticCellCount: number | null;
  notes: string | null;
  snapshot: ImportRecord;
};

function canonicalSurvetRow(
  row: ImportCenterPreview["rows"][number],
): CanonicalSurvetRow {
  const record = row.normalizedRecord;
  if (!record || (row.status !== "valid" && row.status !== "warning")) {
    throw new ImportCenterError(
      `La fila ${row.recordNumber} no está lista para confirmar.`,
      "IMPORT_ROW_NOT_READY",
    );
  }
  const animalId = text(record.animalId);
  const animalTag = text(record.animalTag);
  const externalAnimalId = text(record.externalAnimalId);
  const controlDate = isoDate(record.controlDate);
  const totalLiters = finiteNumber(record.canonicalTotalLiters);
  const morningLiters = finiteNumber(record.canonicalMorningLiters);
  const afternoonLiters = finiteNumber(record.canonicalAfternoonLiters);
  const somaticCellCount = record.somaticCellCount === null
    ? null
    : finiteNumber(record.somaticCellCount);
  if (!animalId || !animalTag || !externalAnimalId || !controlDate
    || totalLiters === null || totalLiters <= 0
    || (morningLiters !== null && morningLiters < 0)
    || (afternoonLiters !== null && afternoonLiters < 0)
    || (somaticCellCount !== null
      && (!Number.isSafeInteger(somaticCellCount) || somaticCellCount < 0))) {
    throw new ImportCenterError(
      `La fila ${row.recordNumber} perdió campos requeridos.`,
      "IMPORT_ROW_INVALID",
    );
  }
  return {
    importRowId: row.id,
    animalId,
    animalTag,
    externalAnimalId,
    controlDate,
    morningLiters,
    afternoonLiters,
    totalLiters,
    somaticCellCount,
    notes: text(record.notes) || null,
    snapshot: record,
  };
}

type CanonicalAgronomicRecommendationRow = {
  importRowId: string;
  sequenceNumber: number;
  actionGroupNumber: number;
  externalPaddockKey: string;
  paddockId: string;
  visitDate: string;
  actionHeading: string;
  recommendationText: string;
  reportedGroupAreaHa: number | null;
  snapshot: ImportRecord;
};

function canonicalAgronomicRecommendationRow(
  row: ImportCenterPreview["rows"][number],
): CanonicalAgronomicRecommendationRow {
  const record = row.normalizedRecord;
  if (!record || row.status !== "valid") {
    throw new ImportCenterError(
      `Concilia el potrero de la fila ${row.recordNumber} antes de confirmar.`,
      "IMPORT_PADDOCK_REQUIRED",
    );
  }
  const actionGroupNumber = finiteNumber(record.actionGroupNumber);
  const externalPaddockKey = text(record.externalPaddockKey);
  const paddockId = text(record.paddockId);
  const visitDate = isoDate(record.visitDate);
  const actionHeading = text(record.actionHeading);
  const recommendationText = text(record.recommendationText);
  const reportedGroupAreaHa = record.reportedGroupAreaHa === null
    ? null
    : finiteNumber(record.reportedGroupAreaHa);
  if (
    text(record.actionKind) !== "agronomic_recommendation"
    || actionGroupNumber === null
    || !Number.isInteger(actionGroupNumber)
    || actionGroupNumber <= 0
    || !externalPaddockKey
    || externalPaddockKey.length > 80
    || !paddockId
    || !visitDate
    || actionHeading.length < 3
    || actionHeading.length > 500
    || recommendationText.length < 3
    || recommendationText.length > 8000
    || (reportedGroupAreaHa !== null && reportedGroupAreaHa <= 0)
  ) {
    throw new ImportCenterError(
      `La fila ${row.recordNumber} perdió el contrato de recomendación agronómica.`,
      "IMPORT_ROW_INVALID",
    );
  }
  return {
    importRowId: row.id,
    sequenceNumber: row.recordNumber,
    actionGroupNumber,
    externalPaddockKey,
    paddockId,
    visitDate,
    actionHeading,
    recommendationText,
    reportedGroupAreaHa,
    snapshot: record,
  };
}

function assertAgronomicRowsMatchDocument(
  rows: CanonicalAgronomicRecommendationRow[],
  groups: AgronomicVisitActionGroup[],
) {
  const expected = groups.flatMap((group) => group.externalPaddockKeys.map((externalPaddockKey) => ({
    actionGroupNumber: group.sequenceNumber,
    actionHeading: group.heading,
    externalPaddockKey,
    recommendationText: group.recommendationText,
    reportedGroupAreaHa: group.reportedGroupAreaHa,
  })));
  if (rows.length !== expected.length) {
    throw new ImportCenterError(
      "Las filas conciliadas no coinciden con el documento agronómico revisado.",
      "IMPORT_PROFILE_STALE",
    );
  }
  const externalToPaddock = new Map<string, string>();
  const paddockToExternal = new Map<string, string>();
  rows.forEach((row, index) => {
    const source = expected[index];
    if (
      row.sequenceNumber !== index + 1
      || row.actionGroupNumber !== source.actionGroupNumber
      || row.actionHeading !== source.actionHeading
      || row.externalPaddockKey !== source.externalPaddockKey
      || row.recommendationText !== source.recommendationText
      || row.reportedGroupAreaHa !== source.reportedGroupAreaHa
    ) {
      throw new ImportCenterError(
        "Las filas conciliadas no coinciden con el documento agronómico revisado.",
        "IMPORT_PROFILE_STALE",
      );
    }
    const existingPaddock = externalToPaddock.get(row.externalPaddockKey);
    const existingExternal = paddockToExternal.get(row.paddockId);
    if (
      (existingPaddock && existingPaddock !== row.paddockId)
      || (existingExternal && existingExternal !== row.externalPaddockKey)
    ) {
      throw new ImportCenterError(
        "La conciliación de potreros es inconsistente.",
        "IMPORT_PADDOCK_MAPPING_INCONSISTENT",
      );
    }
    externalToPaddock.set(row.externalPaddockKey, row.paddockId);
    paddockToExternal.set(row.paddockId, row.externalPaddockKey);
  });
}

type CanonicalVisitRow = {
  importRowId: string;
  sequenceNumber: number;
  externalPaddockKey: string;
  observedAt: string | null;
  plannedEntryDate: string | null;
  currentBiomassKgDmHa: number | null;
  projectedBiomassKgDmHa: number | null;
  areaHa: number | null;
  dailyAreaHa: number | null;
  calculatedDays: number | null;
  adjustedDays: number | null;
  adjustedIntakeKgDmCowDay: number | null;
  notes: string | null;
  snapshot: ImportRecord;
};

function canonicalVisitRow(row: ImportCenterPreview["rows"][number], fallbackObservedAt: string): CanonicalVisitRow {
  const record = row.normalizedRecord;
  if (!record || (row.status !== "valid" && row.status !== "warning")) {
    throw new ImportCenterError(`La fila ${row.recordNumber} no está lista para confirmar.`, "IMPORT_ROW_NOT_READY");
  }
  const externalPaddockKey = text(record.externalPaddockKey);
  const current = finiteNumber(record.currentBiomassKgDmHa);
  const projected = finiteNumber(record.projectedBiomassKgDmHa);
  if (!externalPaddockKey || (current === null && projected === null)) {
    throw new ImportCenterError(`La fila ${row.recordNumber} perdió campos requeridos.`, "IMPORT_ROW_INVALID");
  }
  return {
    importRowId: row.id,
    sequenceNumber: row.recordNumber,
    externalPaddockKey,
    observedAt: isoDate(record.observedAt) ?? fallbackObservedAt,
    plannedEntryDate: isoDate(record.plannedEntryDate),
    currentBiomassKgDmHa: current,
    projectedBiomassKgDmHa: projected,
    areaHa: finiteNumber(record.areaHa),
    dailyAreaHa: finiteNumber(record.dailyAreaHa),
    calculatedDays: finiteNumber(record.calculatedDays),
    adjustedDays: finiteNumber(record.adjustedDays),
    adjustedIntakeKgDmCowDay: finiteNumber(record.adjustedIntakeKgDmCowDay),
    notes: text(record.notes) || null,
    snapshot: record,
  };
}

function dashboardScope(access: ImportFieldAccess) {
  return and(
    inArray(importJobs.sourceSystem, [...CENTER_SOURCES]),
    eq(importJobs.organizationId, access.organizationId),
    eq(fields.organizationId, access.organizationId),
    inArray(importJobs.fieldId, access.fieldIds),
    inArray(fields.id, access.fieldIds),
    eq(fields.isDemo, false),
  );
}

function centerReadScope(access: ImportFieldAccess) {
  return and(
    inArray(importJobs.sourceSystem, [...CENTER_SOURCES]),
    eq(importJobs.organizationId, access.organizationId),
    eq(fields.organizationId, access.organizationId),
    inArray(importJobs.fieldId, access.fieldIds),
    inArray(fields.id, access.fieldIds),
    eq(fields.isDemo, false),
  );
}

function summaryFromJob(job: {
  rowCount: number;
  validRowCount: number;
  warningRowCount: number;
  errorRowCount: number;
  skippedRowCount: number;
  fileIssueCount: number;
}): ImportCenterSummary {
  return {
    rowCount: job.rowCount,
    validRowCount: job.validRowCount,
    warningRowCount: job.warningRowCount,
    errorRowCount: job.errorRowCount,
    skippedRowCount: job.skippedRowCount,
    fileIssueCount: job.fileIssueCount,
  };
}

function summaryFromRows(rows: StagedPreviewRow[]): ImportCenterSummary {
  return {
    rowCount: rows.length,
    validRowCount: rows.filter((row) => row.status === "valid").length,
    warningRowCount: rows.filter((row) => row.status === "warning").length,
    errorRowCount: rows.filter((row) => row.status === "error").length,
    skippedRowCount: rows.filter((row) => row.status === "skipped").length,
    fileIssueCount: 0,
  };
}

function emptyDashboard(): ImportCenterDashboard {
  return {
    imports: [],
    totals: { importCount: 0, confirmedCount: 0, pendingReviewCount: 0, errorCount: 0 },
  };
}

function isCenterSource(value: string): value is CenterSource {
  return CENTER_SOURCES.includes(value as CenterSource);
}

function paddockReconciliations(
  value: unknown,
  rows: ImportCenterPreview["rows"],
): ImportPaddockReconciliation[] {
  if (!Array.isArray(value) || value.length !== rows.length) {
    throw new ImportCenterError(
      "Selecciona un potrero para cada fila del informe.",
      "IMPORT_PADDOCK_REQUIRED",
    );
  }
  const allowedRowIds = new Set(rows.map((row) => row.id));
  const seenRowIds = new Set<string>();
  const mappings = value.map((entry): ImportPaddockReconciliation => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new ImportCenterError("La conciliación de potreros no es válida.", "IMPORT_MAPPING_INVALID");
    }
    const importRowId = text((entry as Record<string, unknown>).importRowId);
    const paddockId = text((entry as Record<string, unknown>).paddockId);
    if (!allowedRowIds.has(importRowId) || seenRowIds.has(importRowId) || !paddockId) {
      throw new ImportCenterError("La conciliación de potreros no es válida.", "IMPORT_MAPPING_INVALID");
    }
    seenRowIds.add(importRowId);
    return { importRowId, paddockId };
  });
  if (seenRowIds.size !== rows.length) {
    throw new ImportCenterError(
      "Selecciona un potrero para cada fila del informe.",
      "IMPORT_PADDOCK_REQUIRED",
    );
  }
  return mappings;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isoDate(value: unknown): string | null {
  const normalized = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : null;
}

function text(value: unknown): string {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizedIdentifier(value: unknown): string {
  return text(value).normalize("NFKC").toLocaleUpperCase("es-CL");
}
