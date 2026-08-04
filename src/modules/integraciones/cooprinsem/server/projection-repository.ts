import { getDb } from "@/db";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import {
  cooprinsemHistoryUnitContracts,
  fieldExternalIdentifiers,
  fields,
  importErrors,
  importJobs,
  importRows,
  livestockAnimalIdentifiers,
  livestockAnimals,
  livestockLactations,
  livestockLotExternalIdentifiers,
  livestockLots,
  livestockMilkControls,
  milkQualitySamples,
  sourceRecords,
} from "@/db/schema";
import { and, asc, eq, getTableColumns, inArray } from "drizzle-orm";
import type {
  CooprinsemImportConfirmation,
  CooprinsemImportProjectionPlan,
  CooprinsemMilkControlProjection,
  CooprinsemMilkQualityProjection,
  CooprinsemProjectionIdentifier,
  CooprinsemProjectionRow,
} from "../domain/types";
import {
  buildProjectionCandidate,
  COOPRINSEM_QUARANTINE_LOT_NAME,
  deterministicProjectionId,
  normalizeExternalIdentifier,
  projectionIdentityKey,
  projectionQuarantineLotId,
  resolveProjectionMatches,
} from "./projection-rules.mjs";
import {
  buildCooprinsemHistoryAssessment,
  COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
} from "./history-projection-rules.mjs";
import {
  assertCurrentImportActorAccess,
  type ImportActorAccess,
  type ImportFieldAccess,
} from "./import-repository";
import { mapCooprinsemMilkControl, mapCooprinsemMilkQualitySample } from "./milk-control-rules.mjs";

const PLAN_ROW_LIMIT = 200;

type ImportJobRow = typeof importJobs.$inferSelect & { fieldName: string };
type ImportRow = typeof importRows.$inferSelect;
type ImportIssueSnapshot = Pick<typeof importErrors.$inferSelect, "id" | "importRowId" | "severity" | "status" | "message">;
type AnimalRow = typeof livestockAnimals.$inferSelect;
type LotRow = typeof livestockLots.$inferSelect;
type AnimalIdentifierRow = typeof livestockAnimalIdentifiers.$inferSelect;
type LotIdentifierRow = typeof livestockLotExternalIdentifiers.$inferSelect;
type FieldIdentifierRow = typeof fieldExternalIdentifiers.$inferSelect;
type SourceRecordRow = typeof sourceRecords.$inferSelect;

type IdentifierTarget = {
  identifier: CooprinsemProjectionIdentifier;
  id: string;
  shouldInsert: boolean;
};

type MilkControlTarget = {
  id: string;
  sourceRecordId: string;
  lactationId: string | null;
  shouldInsert: boolean;
  values: Omit<CooprinsemMilkControlProjection, "action">;
};

type MilkQualityTarget = {
  id: string;
  sourceRecordId: string;
  shouldInsert: boolean;
  values: Omit<CooprinsemMilkQualityProjection, "action">;
};

type ProjectionWorkRow = CooprinsemProjectionRow & {
  effectiveAt: string;
  fieldCode: string | null;
  normalizedFieldCode: string | null;
  identifierTargets: IdentifierTarget[];
  milkControlTarget: MilkControlTarget | null;
  hasImportedMilkControl: boolean;
  milkQualityTarget: MilkQualityTarget | null;
  hasImportedMilkQualitySample: boolean;
};

type ProjectionContext = {
  job: ImportJobRow;
  plan: CooprinsemImportProjectionPlan;
  workRows: ProjectionWorkRow[];
  quarantineLotId: string;
  importRows: ImportRow[];
  importIssues: ImportIssueSnapshot[];
  animals: AnimalRow[];
  lots: LotRow[];
  animalIdentifiers: AnimalIdentifierRow[];
  lotIdentifiers: LotIdentifierRow[];
  fieldIdentifiers: FieldIdentifierRow[];
  existingAnimalSources: SourceRecordRow[];
};

export class ImportProjectionError extends Error {
  constructor(message: string, public code = "IMPORT_PROJECTION_INVALID") {
    super(message);
    this.name = "ImportProjectionError";
  }
}

export async function getImportProjection(
  importJobId: string,
  access: ImportActorAccess,
): Promise<CooprinsemImportProjectionPlan | null> {
  const context = await buildProjectionContext(importJobId, access);
  if (context) await assertCurrentImportActorAccess(access, [context.job.fieldId]);
  return context?.plan ?? null;
}

export async function confirmImportProjection(input: {
  importJobId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  email: string;
  confirmation: string;
}): Promise<CooprinsemImportConfirmation> {
  if (input.confirmation !== input.importJobId) {
    throw new ImportProjectionError("La confirmación explícita no coincide con la importación revisada.", "IMPORT_CONFIRMATION_MISMATCH");
  }
  const access: ImportActorAccess = {
    membershipId: input.membershipId,
    email: input.email,
    organizationId: input.organizationId,
    fieldIds: input.fieldIds,
  };
  const context = await buildProjectionContext(input.importJobId, access, true);
  if (!context) throw new ImportProjectionError("La importación no existe o no está disponible para este usuario.", "IMPORT_NOT_FOUND");
  if (context.job.status === "completed" || context.job.status === "completed_with_errors") {
    await assertCurrentImportActorAccess(access, [context.job.fieldId]);
    return confirmationFromPlan(context.plan, context.job.confirmedAt ?? context.job.completedAt ?? new Date().toISOString(), true);
  }
  if (!context.plan.ready) {
    await assertCurrentImportActorAccess(access, [context.job.fieldId]);
    throw new ImportProjectionError(context.plan.blockers[0] ?? "La simulación todavía no está lista para confirmar.", "IMPORT_NOT_READY");
  }

  const now = new Date().toISOString();
  const confirmableRows = context.workRows.filter((row) =>
    row.action === "create_animal" || row.action === "link_animal" || row.action === "create_quality_sample");
  const excludedRowCount = context.plan.summary.excludedRowCount + context.plan.summary.conflictRowCount;
  const completedStatus = excludedRowCount > 0 ? "completed_with_errors" as const : "completed" as const;
  try {
    await persistProjectionConfirmation(context, access, confirmableRows, now, completedStatus);
    return confirmationFromPlan(context.plan, now, false, completedStatus);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "La confirmación se interrumpió antes de finalizar.";
    await assertCurrentImportActorAccess(access, [context.job.fieldId]);
    const recorded = await recordProjectionFailure(context, access, message);
    if (!recorded) await assertCurrentImportActorAccess(access, [context.job.fieldId]);
    if (/(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|integer overflow)/i.test(message)) {
      throw new ImportProjectionError(
        "La identidad o pertenencia cambió después de la simulación. Recalcula el plan antes de confirmar nuevamente.",
        "IMPORT_PLAN_STALE",
      );
    }
    throw cause;
  }
}

async function recordProjectionFailure(
  context: ProjectionContext,
  access: ImportActorAccess,
  message: string,
): Promise<boolean> {
  const now = new Date().toISOString();
  const result = await getDb().$client.prepare(`
    UPDATE import_jobs
    SET failure_message = ?, updated_at = ?
    WHERE id = ?
      AND organization_id = ?
      AND field_id = ?
      AND status = 'preview_ready'
      AND updated_at = ?
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
    message.slice(0, 1_000),
    now,
    context.job.id,
    access.organizationId,
    context.job.fieldId,
    context.job.updatedAt,
    access.membershipId,
    access.email,
    DEMO_EMAIL,
    access.organizationId,
    JSON.stringify(access.fieldIds),
  ).run();
  return result.meta.changes === 1;
}

async function buildProjectionContext(
  importJobId: string,
  access: ImportFieldAccess,
  includeAllRows = false,
): Promise<ProjectionContext | null> {
  if (access.fieldIds.length === 0) return null;
  const db = getDb();
  const readScope = projectionReadScope(access);
  const [job] = await db.select({
    id: importJobs.id,
    organizationId: importJobs.organizationId,
    fieldId: importJobs.fieldId,
    sourceSystem: importJobs.sourceSystem,
    sourceFormat: importJobs.sourceFormat,
    sourceTable: importJobs.sourceTable,
    originalFilename: importJobs.originalFilename,
    contentType: importJobs.contentType,
    fileSizeBytes: importJobs.fileSizeBytes,
    objectKey: importJobs.objectKey,
    sha256: importJobs.sha256,
    mappingVersion: importJobs.mappingVersion,
    effectiveAt: importJobs.effectiveAt,
    status: importJobs.status,
    isDryRun: importJobs.isDryRun,
    requestedBy: importJobs.requestedBy,
    rowCount: importJobs.rowCount,
    validRowCount: importJobs.validRowCount,
    warningRowCount: importJobs.warningRowCount,
    errorRowCount: importJobs.errorRowCount,
    skippedRowCount: importJobs.skippedRowCount,
    fileIssueCount: importJobs.fileIssueCount,
    failureMessage: importJobs.failureMessage,
    startedAt: importJobs.startedAt,
    previewedAt: importJobs.previewedAt,
    confirmedAt: importJobs.confirmedAt,
    completedAt: importJobs.completedAt,
    createdAt: importJobs.createdAt,
    updatedAt: importJobs.updatedAt,
    fieldName: fields.name,
  }).from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(eq(importJobs.id, importJobId), readScope))
    .limit(1);
  if (!job) return null;
  if (job.sourceTable === "CalidadLeche.dbf") {
    return buildLaboratoryProjectionContext(job as ImportJobRow, access, includeAllRows);
  }

  const [rows, issueRows, animals, identifiers, lots, lotIdentifiers, fieldIdentifiers, existingSources, historyUnitContracts, existingMilkControls, lactations] = await Promise.all([
    db.select(getTableColumns(importRows)).from(importRows)
      .innerJoin(importJobs, eq(importJobs.id, importRows.importJobId))
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .where(and(eq(importRows.importJobId, importJobId), readScope))
      .orderBy(asc(importRows.recordNumber)),
    db.select({ id: importErrors.id, importRowId: importErrors.importRowId, severity: importErrors.severity, status: importErrors.status, message: importErrors.message })
      .from(importErrors)
      .innerJoin(importRows, and(
        eq(importRows.id, importErrors.importRowId),
        eq(importRows.importJobId, importErrors.importJobId),
      ))
      .innerJoin(importJobs, eq(importJobs.id, importErrors.importJobId))
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .where(and(eq(importErrors.importJobId, importJobId), readScope)),
    db.select(getTableColumns(livestockAnimals)).from(livestockAnimals)
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(eq(livestockLots.fieldId, job.fieldId), projectionFieldScope(access))),
    db.select(getTableColumns(livestockAnimalIdentifiers)).from(livestockAnimalIdentifiers)
      .innerJoin(fields, eq(fields.id, livestockAnimalIdentifiers.fieldId))
      .where(and(eq(livestockAnimalIdentifiers.fieldId, job.fieldId), projectionFieldScope(access))),
    db.select(getTableColumns(livestockLots)).from(livestockLots)
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(and(eq(livestockLots.fieldId, job.fieldId), projectionFieldScope(access))),
    db.select(getTableColumns(livestockLotExternalIdentifiers)).from(livestockLotExternalIdentifiers)
      .innerJoin(fields, eq(fields.id, livestockLotExternalIdentifiers.fieldId))
      .where(and(eq(livestockLotExternalIdentifiers.fieldId, job.fieldId), projectionFieldScope(access))),
    db.select(getTableColumns(fieldExternalIdentifiers)).from(fieldExternalIdentifiers)
      .innerJoin(fields, eq(fields.id, fieldExternalIdentifiers.fieldId))
      .where(and(
        eq(fieldExternalIdentifiers.organizationId, access.organizationId),
        eq(fields.organizationId, access.organizationId),
      )),
    db.select(getTableColumns(sourceRecords)).from(sourceRecords)
      .innerJoin(importRows, and(
        eq(importRows.id, sourceRecords.importRowId),
        eq(importRows.importJobId, sourceRecords.importJobId),
      ))
      .innerJoin(importJobs, eq(importJobs.id, sourceRecords.importJobId))
      .innerJoin(fields, eq(fields.id, importJobs.fieldId))
      .where(and(
        eq(sourceRecords.importJobId, importJobId),
        readScope,
      )),
    db.select({ contractVersion: cooprinsemHistoryUnitContracts.contractVersion })
      .from(cooprinsemHistoryUnitContracts)
      .innerJoin(fields, eq(fields.id, cooprinsemHistoryUnitContracts.fieldId))
      .where(and(
        eq(cooprinsemHistoryUnitContracts.fieldId, job.fieldId),
        eq(cooprinsemHistoryUnitContracts.contractVersion, COOPRINSEM_MILK_UNIT_CONTRACT_VERSION),
        projectionFieldScope(access),
      )),
    db.select(getTableColumns(livestockMilkControls)).from(livestockMilkControls)
      .innerJoin(fields, eq(fields.id, livestockMilkControls.fieldId))
      .where(and(eq(livestockMilkControls.fieldId, job.fieldId), projectionFieldScope(access))),
    db.select(getTableColumns(livestockLactations)).from(livestockLactations)
      .innerJoin(fields, eq(fields.id, livestockLactations.fieldId))
      .where(and(eq(livestockLactations.fieldId, job.fieldId), projectionFieldScope(access))),
  ]);
  const [scopeStillValid] = await db.select({ id: importJobs.id }).from(importJobs)
    .innerJoin(fields, eq(fields.id, importJobs.fieldId))
    .where(and(
      eq(importJobs.id, importJobId),
      eq(importJobs.updatedAt, job.updatedAt),
      readScope,
    ))
    .limit(1);
  if (!scopeStillValid) return null;

  const openIssuesByRow = new Map<string, Array<{ severity: "warning" | "error"; message: string }>>();
  for (const issue of issueRows) {
    if (issue.status !== "open") continue;
    openIssuesByRow.set(issue.importRowId, [...(openIssuesByRow.get(issue.importRowId) ?? []), { severity: issue.severity, message: issue.message }]);
  }
  const sourceAnimalByRow = new Map(existingSources
    .filter((entry) => entry.targetEntity === "livestock_animal")
    .map((entry) => [entry.importRowId, entry.targetId]));
  const sourceMilkControlByRow = new Map(existingSources
    .filter((entry) => entry.targetEntity === "livestock_milk_control")
    .map((entry) => [entry.importRowId, entry.targetId]));
  const milkControlsById = new Map(existingMilkControls.map((entry) => [entry.id, entry]));
  const milkControlsByAnimalDate = new Map(existingMilkControls.map((entry) => [`${entry.animalId}:${entry.controlDate}`, entry]));
  const lactationsByAnimal = new Map<string, typeof lactations>();
  for (const lactation of lactations) {
    lactationsByAnimal.set(lactation.animalId, [...(lactationsByAnimal.get(lactation.animalId) ?? []), lactation]);
  }
  const lotsById = new Map(lots.map((entry) => [entry.id, entry]));
  const animalsById = new Map(animals.map((entry) => [entry.id, entry]));
  const quarantineLotId = projectionQuarantineLotId(job.fieldId);

  const lotIdsByGroup = new Map<string, Set<string>>();
  for (const identifier of lotIdentifiers.filter((entry) => entry.kind === "cooprinsem_grupo" && entry.validTo === null)) {
    const current = lotIdsByGroup.get(identifier.normalizedValue) ?? new Set<string>();
    current.add(identifier.lotId);
    lotIdsByGroup.set(identifier.normalizedValue, current);
  }

  const identifierRowsByIdentity = new Map<string, typeof identifiers>();
  const animalIdsByIdentity = new Map<string, Set<string>>();
  for (const identifier of identifiers) {
    if (identifier.validTo !== null) continue;
    const key = `${identifier.kind}:${identifier.normalizedValue}`;
    identifierRowsByIdentity.set(key, [...(identifierRowsByIdentity.get(key) ?? []), identifier]);
    const matches = animalIdsByIdentity.get(key) ?? new Set<string>();
    matches.add(identifier.animalId);
    animalIdsByIdentity.set(key, matches);
  }
  for (const animal of animals) {
    const normalizedTag = normalizeExternalIdentifier(animal.tag);
    for (const kind of ["cooprinsem_numvaca_dv", "cooprinsem_numvaca", "rp", "cooprinsem_nombre", "barcode"]) {
      const key = `${kind}:${normalizedTag}`;
      const matches = animalIdsByIdentity.get(key) ?? new Set<string>();
      matches.add(animal.id);
      animalIdsByIdentity.set(key, matches);
    }
  }

  const plannedAnimalByIdentity = new Map<string, string>();
  const plannedIdentifierByIdentity = new Map<string, { animalId: string; id: string }>();
  const proposedLotByAnimalId = new Map<string, string>();
  const plannedMilkControlByAnimalDate = new Map<string, MilkControlTarget>();
  const workRows: ProjectionWorkRow[] = [];
  for (const row of rows) {
    const openIssues = openIssuesByRow.get(row.id) ?? [];
    if (row.recordNumber === 0) {
      workRows.push(excludedRow(row, openIssues.map((entry) => entry.message)));
      continue;
    }
    if (row.status === "imported") {
      const milkControl = milkControlsById.get(sourceMilkControlByRow.get(row.id) ?? "");
      workRows.push({
        ...excludedRow(row, []),
        action: "already_imported",
        animalId: sourceAnimalByRow.get(row.id) ?? null,
        milkControl: milkControl ? publicMilkControl(milkControl, "already_imported") : null,
        hasImportedMilkControl: Boolean(milkControl),
        issues: [],
      });
      continue;
    }
    if (!row.normalizedRecord || row.status === "error" || row.status === "skipped" || row.status === "pending") {
      workRows.push(excludedRow(row, openIssues.map((entry) => entry.message)));
      continue;
    }
    if (row.status === "warning" && openIssues.length > 0) {
      workRows.push(excludedRow(row, openIssues.map((entry) => entry.message)));
      continue;
    }

    const candidate = buildProjectionCandidate(row.normalizedRecord, { effectiveAt: job.effectiveAt });
    if (!candidate.canonicalTag || candidate.identifiers.length === 0) {
      workRows.push(excludedRow(row, candidate.issues));
      continue;
    }
    const matches = resolveProjectionMatches(candidate.identifiers, animalIdsByIdentity, plannedAnimalByIdentity);
    if (matches.animalIds.length > 1) {
      workRows.push(conflictRow(row, candidate, "Los identificadores de la fila apuntan a animales distintos."));
      continue;
    }

    let action: "create_animal" | "link_animal";
    let animalId: string;
    if (matches.animalIds.length === 1) {
      action = "link_animal";
      animalId = matches.animalIds[0];
    } else {
      action = "create_animal";
      const primary = candidate.identifiers.find((entry) => entry.isPrimary) ?? candidate.identifiers[0];
      animalId = deterministicProjectionId("animal", [job.fieldId, primary.kind, primary.normalizedValue]);
    }

    const groupLotIds = candidate.normalizedGroupCode ? lotIdsByGroup.get(candidate.normalizedGroupCode) ?? new Set<string>() : new Set<string>();
    if (groupLotIds.size > 1) {
      workRows.push(conflictRow(row, candidate, `El grupo ${candidate.groupCode} resuelve a más de un lote.`));
      continue;
    }
    const resolvedGroupLotId = groupLotIds.size === 1 ? [...groupLotIds][0] : quarantineLotId;
    let lotId = resolvedGroupLotId;
    const rowIssues: string[] = [];
    if (action === "link_animal") {
      const currentLotId = animalsById.get(animalId)?.lotId ?? proposedLotByAnimalId.get(animalId);
      if (!currentLotId) {
        workRows.push(conflictRow(row, candidate, "El identificador coincide con un animal que no pertenece al fundo seleccionado."));
        continue;
      }
      lotId = currentLotId;
      if (groupLotIds.size === 1 && resolvedGroupLotId !== currentLotId) {
        rowIssues.push(`El grupo ${candidate.groupCode} apunta a otro lote; se conservará la pertenencia actual del animal.`);
      } else if (groupLotIds.size === 0 && candidate.groupCode) {
        rowIssues.push(`El grupo ${candidate.groupCode} no está configurado; se conservará la pertenencia actual del animal.`);
      }
    } else {
      proposedLotByAnimalId.set(animalId, lotId);
      if (groupLotIds.size === 0 && candidate.groupCode) {
        rowIssues.push(`Grupo ${candidate.groupCode} sin lote configurado; se usará el lote de revisión.`);
      }
    }
    const lotName = lotsById.get(lotId)?.name ?? (lotId === quarantineLotId ? COOPRINSEM_QUARANTINE_LOT_NAME : "Lote configurado");
    const effectiveAt = candidate.effectiveAt ?? job.effectiveAt ?? job.createdAt.slice(0, 10);
    const identifierTargets = candidate.identifiers.map((identifier) => {
      const key = projectionIdentityKey(identifier);
      const existing = (identifierRowsByIdentity.get(key) ?? []).find((entry) => entry.animalId === animalId);
      const planned = plannedIdentifierByIdentity.get(key);
      return {
        identifier,
        id: existing?.id ?? planned?.id ?? deterministicProjectionId("identifier", [animalId, identifier.kind, identifier.normalizedValue, effectiveAt]),
        shouldInsert: !existing && !planned,
      };
    });
    for (const target of identifierTargets) {
      const key = projectionIdentityKey(target.identifier);
      plannedAnimalByIdentity.set(key, animalId);
      plannedIdentifierByIdentity.set(key, { animalId, id: target.id });
    }
    const milkMapping = mapCooprinsemMilkControl(row.normalizedRecord, { effectiveAt: job.effectiveAt });
    rowIssues.push(...milkMapping.issues);
    let milkControlTarget: MilkControlTarget | null = null;
    let milkControl: CooprinsemMilkControlProjection | null = null;
    let hasImportedMilkControl = false;
    if (milkMapping.control) {
      const key = `${animalId}:${milkMapping.control.controlDate}`;
      const existing = milkControlsByAnimalDate.get(key);
      const planned = plannedMilkControlByAnimalDate.get(key);
      const importedTargetId = sourceMilkControlByRow.get(row.id);
      if (existing) {
        if (existing.id === importedTargetId) {
          milkControl = publicMilkControl(existing, "already_imported");
          hasImportedMilkControl = true;
        } else {
          rowIssues.push(`Ya existe un control lechero para el animal en ${milkMapping.control.controlDate}; no se sobrescribira.`);
        }
      } else if (planned) {
        rowIssues.push(`Otra fila ya proyecto el control lechero del animal en ${milkMapping.control.controlDate}; se conservara la primera.`);
      } else {
        const id = deterministicProjectionId("milk-control", [job.fieldId, animalId, milkMapping.control.controlDate]);
        const sourceRecordId = deterministicProjectionId("source", [row.id, "livestock_milk_control", id]);
        const lactationId = (lactationsByAnimal.get(animalId) ?? []).find((entry) =>
          entry.startedAt <= milkMapping.control!.controlDate
          && (entry.endedAt === null || entry.endedAt >= milkMapping.control!.controlDate))?.id ?? null;
        milkControlTarget = {
          id,
          sourceRecordId,
          lactationId,
          shouldInsert: true,
          values: milkMapping.control,
        };
        plannedMilkControlByAnimalDate.set(key, milkControlTarget);
        milkControl = { action: "create", ...milkMapping.control };
      }
    }
    workRows.push({
      importRowId: row.id,
      recordNumber: row.recordNumber,
      action,
      animalId,
      animalTag: candidate.canonicalTag,
      lotId,
      lotName,
      sourceKey: candidate.sourceKey,
      groupCode: candidate.groupCode,
      identifiers: candidate.identifiers,
      identifierTargets,
      milkControl,
      milkControlTarget,
      hasImportedMilkControl,
      milkQualitySample: null,
      milkQualityTarget: null,
      hasImportedMilkQualitySample: false,
      matchedBy: matches.matchedBy,
      issues: rowIssues,
      effectiveAt,
      fieldCode: candidate.fieldCode,
      normalizedFieldCode: candidate.normalizedFieldCode,
    });
  }

  const projectable = workRows.filter((row) => row.action === "create_animal" || row.action === "link_animal");
  const fieldCodeMap = new Map<string, string>();
  for (const row of projectable) {
    if (row.normalizedFieldCode && row.fieldCode) fieldCodeMap.set(row.normalizedFieldCode, row.fieldCode);
  }
  const fieldCodes = [...fieldCodeMap.entries()];
  const blockers: string[] = [];
  if (job.status === "importing") blockers.push("La importación ya está siendo confirmada.");
  if (!["preview_ready", "completed", "completed_with_errors"].includes(job.status)) blockers.push("La importación todavía no tiene una vista previa confirmable.");
  const fileRow = rows.find((row) => row.recordNumber === 0);
  if (fileRow && (openIssuesByRow.get(fileRow.id) ?? []).some((entry) => entry.severity === "error")) blockers.push("El archivo tiene errores estructurales pendientes.");
  if (fieldCodes.length > 1) blockers.push("El archivo contiene más de un código de predio y no puede proyectarse a un único fundo.");

  let fieldIdentifier: CooprinsemImportProjectionPlan["fieldIdentifier"] = null;
  if (fieldCodes.length === 1) {
    const [normalizedValue, value] = fieldCodes[0];
    const matches = fieldIdentifiers.filter((entry) => entry.sourceSystem === "cooprinsem" && entry.kind === "cooprinsem_predio" && entry.normalizedValue === normalizedValue && entry.validTo === null);
    if (matches.some((entry) => entry.fieldId !== job.fieldId)) blockers.push(`El predio Cooprinsem ${value} ya está vinculado a otro fundo.`);
    else fieldIdentifier = { kind: "cooprinsem_predio", value, normalizedValue, action: matches.length > 0 ? "existing" : "create" };
  }

  const createAnimalCount = workRows.filter((row) => row.action === "create_animal").length;
  const linkAnimalCount = workRows.filter((row) => row.action === "link_animal").length;
  const alreadyImportedCount = workRows.filter((row) => row.action === "already_imported").length;
  const projectableMilkControlCount = workRows.filter((row) => row.milkControlTarget?.shouldInsert).length;
  const alreadyImportedMilkControlCount = workRows.filter((row) => row.hasImportedMilkControl).length;
  const projectableMilkQualitySampleCount = workRows.filter((row) => row.milkQualityTarget?.shouldInsert).length;
  const alreadyImportedMilkQualitySampleCount = workRows.filter((row) => row.hasImportedMilkQualitySample).length;
  const excludedRowCount = workRows.filter((row) => row.action === "excluded" && row.recordNumber > 0).length;
  const conflictRowCount = workRows.filter((row) => row.action === "conflict").length;
  const normalizedRecordByRow = new Map(rows.map((row) => [row.id, row.normalizedRecord]));
  const historyAssessment = buildCooprinsemHistoryAssessment(workRows
    .filter((row) => row.animalId && ["create_animal", "link_animal", "already_imported"].includes(row.action))
    .flatMap((row) => {
      const record = normalizedRecordByRow.get(row.importRowId);
      return record ? [{ animalId: row.animalId as string, importRowId: row.importRowId, record, effectiveAt: job.effectiveAt }] : [];
    }), {
      milkUnitContractVersion: historyUnitContracts[0]?.contractVersion ?? null,
    });
  const publicRows = workRows.filter((row) => row.recordNumber > 0).map(toPublicRow);
  const confirmed = job.status === "completed" || job.status === "completed_with_errors";
  const plan: CooprinsemImportProjectionPlan = {
    importJobId: job.id,
    fieldId: job.fieldId,
    fieldName: job.fieldName,
    sourceTable: job.sourceTable as CooprinsemImportProjectionPlan["sourceTable"],
    originalFilename: job.originalFilename,
    status: job.status,
    confirmedAt: job.confirmedAt,
    ready: !confirmed && job.status === "preview_ready" && blockers.length === 0
      && createAnimalCount + linkAnimalCount + alreadyImportedCount + projectableMilkQualitySampleCount > 0,
    blockers,
    historyAssessment,
    fieldIdentifier,
    summary: {
      rowCount: job.rowCount,
      createAnimalCount,
      linkAnimalCount,
      alreadyImportedCount,
      excludedRowCount,
      conflictRowCount,
      identifierWriteCount: projectable.reduce((total, row) => total + row.identifierTargets.filter((target) => target.shouldInsert).length, 0),
      projectableMilkControlCount,
      alreadyImportedMilkControlCount,
      projectableMilkQualitySampleCount,
      alreadyImportedMilkQualitySampleCount,
      unresolvedGroupCount: projectable.filter((row) => row.action === "create_animal" && row.groupCode && row.lotId === quarantineLotId).length,
    },
    rows: includeAllRows ? publicRows : publicRows.slice(0, PLAN_ROW_LIMIT),
    rowsTruncated: !includeAllRows && publicRows.length > PLAN_ROW_LIMIT,
  };
  return {
    job: job as ImportJobRow,
    plan,
    workRows,
    quarantineLotId,
    importRows: rows,
    importIssues: issueRows,
    animals,
    lots,
    animalIdentifiers: identifiers,
    lotIdentifiers,
    fieldIdentifiers,
    existingAnimalSources: existingSources.filter((entry) => entry.targetEntity === "livestock_animal"),
  };
}

async function buildLaboratoryProjectionContext(job: ImportJobRow, access: ImportFieldAccess, includeAllRows: boolean): Promise<ProjectionContext> {
  if (job.organizationId !== access.organizationId || !access.fieldIds.includes(job.fieldId)) throw staleProjectionError();
  const db = getDb();
  const [rows, issueRows, existingSources, existingSamples, fieldIdentifiers] = await Promise.all([
    db.select().from(importRows).where(eq(importRows.importJobId, job.id)).orderBy(asc(importRows.recordNumber)),
    db.select({ id: importErrors.id, importRowId: importErrors.importRowId, severity: importErrors.severity, status: importErrors.status, message: importErrors.message })
      .from(importErrors).where(eq(importErrors.importJobId, job.id)),
    db.select().from(sourceRecords).where(eq(sourceRecords.importJobId, job.id)),
    db.select().from(milkQualitySamples).where(and(
      eq(milkQualitySamples.fieldId, job.fieldId),
      eq(milkQualitySamples.source, "cooprinsem_laboratory"),
    )),
    db.select().from(fieldExternalIdentifiers).where(eq(fieldExternalIdentifiers.organizationId, job.organizationId)),
  ]);
  const openIssuesByRow = new Map<string, Array<{ severity: "warning" | "error"; message: string }>>();
  for (const issue of issueRows) {
    if (issue.status !== "open") continue;
    openIssuesByRow.set(issue.importRowId, [...(openIssuesByRow.get(issue.importRowId) ?? []), { severity: issue.severity, message: issue.message }]);
  }
  const sourceSampleByRow = new Map(existingSources
    .filter((entry) => entry.targetEntity === "milk_quality_sample")
    .map((entry) => [entry.importRowId, entry.targetId]));
  const samplesById = new Map(existingSamples.map((entry) => [entry.id, entry]));
  const samplesByDate = new Map(existingSamples.map((entry) => [entry.sampledAt, entry]));
  const plannedDates = new Set<string>();
  const workRows: ProjectionWorkRow[] = [];
  for (const row of rows) {
    const openIssues = openIssuesByRow.get(row.id) ?? [];
    if (row.recordNumber === 0 || !row.normalizedRecord || ["error", "skipped", "pending"].includes(row.status)
      || (row.status === "warning" && openIssues.length > 0)) {
      workRows.push(excludedRow(row, openIssues.map((entry) => entry.message)));
      continue;
    }
    if (row.status === "imported") {
      const sample = samplesById.get(sourceSampleByRow.get(row.id) ?? "");
      workRows.push({
        ...excludedRow(row, []),
        action: "already_imported_quality_sample",
        sourceKey: sample ? `cooprinsem_laboratory:${sample.sampledAt}` : row.sourceKey,
        milkQualitySample: sample ? publicMilkQualitySample(sample, "already_imported") : null,
        hasImportedMilkQualitySample: Boolean(sample),
        issues: [],
      });
      continue;
    }
    const mapped = mapCooprinsemMilkQualitySample(row.normalizedRecord);
    if (!mapped.sample) {
      workRows.push(excludedRow(row, mapped.issues));
      continue;
    }
    const sampleValues = qualityProjectionValues(mapped.sample);
    const sourceKey = `cooprinsem_laboratory:${sampleValues.sampledAt}`;
    const fieldCode = fieldText(row.normalizedRecord.NUMPREDIO);
    const normalizedFieldCode = fieldCode ? normalizeExternalIdentifier(fieldCode) : null;
    const existing = samplesByDate.get(sampleValues.sampledAt);
    const importedTargetId = sourceSampleByRow.get(row.id);
    if (existing && existing.id !== importedTargetId) {
      workRows.push(laboratoryConflictRow(row, sampleValues, sourceKey, fieldCode, normalizedFieldCode, `Ya existe una muestra Cooprinsem para ${sampleValues.sampledAt}; no se sobrescribira.`));
      continue;
    }
    if (plannedDates.has(sampleValues.sampledAt)) {
      workRows.push(laboratoryConflictRow(row, sampleValues, sourceKey, fieldCode, normalizedFieldCode, `El archivo contiene mas de una muestra para ${sampleValues.sampledAt}.`));
      continue;
    }
    if (existing) {
      workRows.push({
        ...excludedRow(row, []),
        action: "already_imported_quality_sample",
        sourceKey,
        effectiveAt: sampleValues.sampledAt,
        fieldCode,
        normalizedFieldCode,
        milkQualitySample: publicMilkQualitySample(existing, "already_imported"),
        hasImportedMilkQualitySample: true,
        issues: [],
      });
      continue;
    }
    plannedDates.add(sampleValues.sampledAt);
    const id = deterministicProjectionId("milk-quality", [job.fieldId, sampleValues.sampledAt, "cooprinsem_laboratory"]);
    const target: MilkQualityTarget = {
      id,
      sourceRecordId: deterministicProjectionId("source", [row.id, "milk_quality_sample", id]),
      shouldInsert: true,
      values: sampleValues,
    };
    workRows.push({
      ...excludedRow(row, []),
      action: "create_quality_sample",
      sourceKey,
      effectiveAt: sampleValues.sampledAt,
      fieldCode,
      normalizedFieldCode,
      milkQualitySample: { action: "create", ...sampleValues },
      milkQualityTarget: target,
      issues: mapped.issues,
    });
  }

  const confirmable = workRows.filter((row) => row.action === "create_quality_sample");
  const fieldCodeMap = new Map<string, string>();
  for (const row of confirmable) {
    if (row.normalizedFieldCode && row.fieldCode) fieldCodeMap.set(row.normalizedFieldCode, row.fieldCode);
  }
  const fieldCodes = [...fieldCodeMap.entries()];
  const blockers: string[] = [];
  if (job.status === "importing") blockers.push("La importacion ya esta siendo confirmada.");
  if (!["preview_ready", "completed", "completed_with_errors"].includes(job.status)) blockers.push("La importacion todavia no tiene una vista previa confirmable.");
  const fileRow = rows.find((row) => row.recordNumber === 0);
  if (fileRow && (openIssuesByRow.get(fileRow.id) ?? []).some((entry) => entry.severity === "error")) blockers.push("El archivo tiene errores estructurales pendientes.");
  if (fieldCodes.length > 1) blockers.push("El archivo contiene mas de un codigo de predio.");
  let fieldIdentifier: CooprinsemImportProjectionPlan["fieldIdentifier"] = null;
  if (fieldCodes.length === 1) {
    const [normalizedValue, value] = fieldCodes[0];
    const matches = fieldIdentifiers.filter((entry) => entry.sourceSystem === "cooprinsem" && entry.kind === "cooprinsem_predio"
      && entry.normalizedValue === normalizedValue && entry.validTo === null);
    if (matches.some((entry) => entry.fieldId !== job.fieldId)) blockers.push(`El predio Cooprinsem ${value} ya esta vinculado a otro fundo.`);
    else fieldIdentifier = { kind: "cooprinsem_predio", value, normalizedValue, action: matches.length > 0 ? "existing" : "create" };
  }
  const projectableMilkQualitySampleCount = confirmable.length;
  const alreadyImportedMilkQualitySampleCount = workRows.filter((row) => row.hasImportedMilkQualitySample).length;
  const excludedRowCount = workRows.filter((row) => row.action === "excluded" && row.recordNumber > 0).length;
  const conflictRowCount = workRows.filter((row) => row.action === "conflict").length;
  const publicRows = workRows.filter((row) => row.recordNumber > 0).map(toPublicRow);
  const confirmed = job.status === "completed" || job.status === "completed_with_errors";
  const plan: CooprinsemImportProjectionPlan = {
    importJobId: job.id,
    fieldId: job.fieldId,
    fieldName: job.fieldName,
    sourceTable: "CalidadLeche.dbf",
    originalFilename: job.originalFilename,
    status: job.status,
    confirmedAt: job.confirmedAt,
    ready: !confirmed && job.status === "preview_ready" && blockers.length === 0 && projectableMilkQualitySampleCount > 0,
    blockers,
    fieldIdentifier,
    historyAssessment: buildCooprinsemHistoryAssessment([]),
    summary: {
      rowCount: job.rowCount,
      createAnimalCount: 0,
      linkAnimalCount: 0,
      alreadyImportedCount: alreadyImportedMilkQualitySampleCount,
      excludedRowCount,
      conflictRowCount,
      identifierWriteCount: 0,
      projectableMilkControlCount: 0,
      alreadyImportedMilkControlCount: 0,
      projectableMilkQualitySampleCount,
      alreadyImportedMilkQualitySampleCount,
      unresolvedGroupCount: 0,
    },
    rows: includeAllRows ? publicRows : publicRows.slice(0, PLAN_ROW_LIMIT),
    rowsTruncated: !includeAllRows && publicRows.length > PLAN_ROW_LIMIT,
  };
  return {
    job,
    plan,
    workRows,
    quarantineLotId: projectionQuarantineLotId(job.fieldId),
    importRows: rows,
    importIssues: issueRows,
    animals: [],
    lots: [],
    animalIdentifiers: [],
    lotIdentifiers: [],
    fieldIdentifiers,
    existingAnimalSources: [],
  };
}

function excludedRow(row: ImportRow, issues: string[]): ProjectionWorkRow {
  return {
    importRowId: row.id,
    recordNumber: row.recordNumber,
    action: "excluded",
    animalId: null,
    animalTag: null,
    lotId: null,
    lotName: null,
    sourceKey: row.sourceKey,
    groupCode: null,
    identifiers: [],
    identifierTargets: [],
    milkControl: null,
    milkControlTarget: null,
    hasImportedMilkControl: false,
    milkQualitySample: null,
    milkQualityTarget: null,
    hasImportedMilkQualitySample: false,
    matchedBy: [],
    issues: issues.length > 0 ? issues : [row.status === "skipped" ? "Fila marcada como eliminada en el DBF." : "Fila no elegible para proyección."],
    effectiveAt: row.createdAt.slice(0, 10),
    fieldCode: null,
    normalizedFieldCode: null,
  };
}

function conflictRow(row: ImportRow, candidate: ReturnType<typeof buildProjectionCandidate>, message: string): ProjectionWorkRow {
  return {
    importRowId: row.id,
    recordNumber: row.recordNumber,
    action: "conflict",
    animalId: null,
    animalTag: candidate.canonicalTag,
    lotId: null,
    lotName: null,
    sourceKey: candidate.sourceKey,
    groupCode: candidate.groupCode,
    identifiers: candidate.identifiers,
    identifierTargets: [],
    milkControl: null,
    milkControlTarget: null,
    hasImportedMilkControl: false,
    milkQualitySample: null,
    milkQualityTarget: null,
    hasImportedMilkQualitySample: false,
    matchedBy: [],
    issues: [message],
    effectiveAt: candidate.effectiveAt ?? row.createdAt.slice(0, 10),
    fieldCode: candidate.fieldCode,
    normalizedFieldCode: candidate.normalizedFieldCode,
  };
}

function toPublicRow(row: ProjectionWorkRow): CooprinsemProjectionRow {
  return {
    importRowId: row.importRowId,
    recordNumber: row.recordNumber,
    action: row.action,
    animalId: row.animalId,
    animalTag: row.animalTag,
    lotId: row.lotId,
    lotName: row.lotName,
    sourceKey: row.sourceKey,
    groupCode: row.groupCode,
    identifiers: row.identifiers,
    milkControl: row.milkControl,
    milkQualitySample: row.milkQualitySample,
    matchedBy: row.matchedBy,
    issues: row.issues,
  };
}

const projectionInputCte = `
  WITH input AS (
    SELECT current_job.failure_message AS payload
    FROM import_jobs AS current_job
    WHERE current_job.status = 'importing'
      AND json_extract(current_job.failure_message, '$.confirmationId') = ?
  )
`;
function publicMilkControl(
  control: typeof livestockMilkControls.$inferSelect,
  action: CooprinsemMilkControlProjection["action"],
): CooprinsemMilkControlProjection {
  return {
    action,
    controlDate: control.controlDate,
    morningLiters: control.morningLiters,
    afternoonLiters: control.afternoonLiters,
    thirdMilkingLiters: control.thirdMilkingLiters,
    totalLiters: control.totalLiters,
    fatPct: control.fatPct,
    proteinPct: control.proteinPct,
    somaticCellCount: control.somaticCellCount,
  };
}

function qualityProjectionValues(
  sample: NonNullable<ReturnType<typeof mapCooprinsemMilkQualitySample>["sample"]>,
): Omit<CooprinsemMilkQualityProjection, "action"> {
  return {
    sampledAt: sample.sampledAt,
    period: sample.period,
    fatPercent: sample.fatPercent,
    proteinPercent: sample.proteinPercent,
    totalSolidsPercent: sample.totalSolidsPercent,
    somaticCellCount: sample.somaticCellCount,
    somaticCellCountUnit: sample.somaticCellCountUnit,
    bacterialCount: sample.bacterialCount,
    bacterialCountUnit: sample.bacterialCountUnit,
  };
}

function publicMilkQualitySample(
  sample: typeof milkQualitySamples.$inferSelect,
  action: CooprinsemMilkQualityProjection["action"],
): CooprinsemMilkQualityProjection {
  return {
    action,
    sampledAt: sample.sampledAt,
    period: sample.period,
    fatPercent: sample.fatPercent,
    proteinPercent: sample.proteinPercent,
    totalSolidsPercent: sample.totalSolidsPercent,
    somaticCellCount: sample.somaticCellCount,
    somaticCellCountUnit: sample.somaticCellCountUnit,
    bacterialCount: sample.bacterialCount,
    bacterialCountUnit: sample.bacterialCountUnit,
  };
}

function laboratoryConflictRow(
  row: ImportRow,
  sample: Omit<CooprinsemMilkQualityProjection, "action">,
  sourceKey: string,
  fieldCode: string | null,
  normalizedFieldCode: string | null,
  message: string,
): ProjectionWorkRow {
  return {
    ...excludedRow(row, [message]),
    action: "conflict",
    sourceKey,
    effectiveAt: sample.sampledAt,
    fieldCode,
    normalizedFieldCode,
  };
}

function fieldText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

const projectionGuardExists = `
  EXISTS (
    SELECT 1
    FROM input
    INNER JOIN audit_log AS confirmation_guard
      ON confirmation_guard.id = json_extract(input.payload, '$.guardAuditId')
    WHERE confirmation_guard.organization_id = json_extract(input.payload, '$.organizationId')
      AND confirmation_guard.field_id = json_extract(input.payload, '$.fieldId')
      AND confirmation_guard.actor = json_extract(input.payload, '$.actor')
      AND confirmation_guard.action = 'import.confirmed'
      AND confirmation_guard.entity_type = 'import_job'
      AND confirmation_guard.entity_id = json_extract(input.payload, '$.job.id')
      AND confirmation_guard.before = json_extract(input.payload, '$.guardBeforeJson')
      AND confirmation_guard.after = json_extract(input.payload, '$.guardAfterJson')
      AND confirmation_guard.occurred_at = json_extract(input.payload, '$.now')
  )
`;

async function persistProjectionConfirmation(
  context: ProjectionContext,
  access: ImportActorAccess,
  rows: ProjectionWorkRow[],
  now: string,
  completedStatus: "completed" | "completed_with_errors",
): Promise<void> {
  const client = getDb().$client;
  const actor = access.email;
  const confirmationId = crypto.randomUUID();
  const existingAnimalById = new Map(context.animals.map((animal) => [animal.id, animal]));
  const existingIdentifierById = new Map(context.animalIdentifiers.map((identifier) => [identifier.id, identifier]));
  const existingLotById = new Map(context.lots.map((lot) => [lot.id, lot]));
  const createAnimalIds = new Set(rows.filter((row) => row.action === "create_animal" && row.animalId).map((row) => row.animalId as string));
  const insertedIdentifierIds = new Set(rows.flatMap((row) => row.identifierTargets.filter((target) => target.shouldInsert).map((target) => target.id)));
  const affectedLotIds = [...new Set(rows.filter((row) => row.action === "create_animal" && row.lotId).map((row) => row.lotId as string))];
  const targetLotIds = [...new Set(rows.map((row) => row.lotId).filter((lotId): lotId is string => Boolean(lotId)))];
  const rowSnapshots = context.importRows.map((row) => ({
    ...row,
    rawRecordJson: JSON.stringify(row.rawRecord),
    normalizedRecordJson: row.normalizedRecord === null ? null : JSON.stringify(row.normalizedRecord),
  }));
  const workRows = rows.map((row) => {
    if (row.action === "create_quality_sample" && row.milkQualityTarget) {
      return {
        importRowId: row.importRowId,
        action: row.action,
        sourceKey: row.sourceKey,
        effectiveAt: row.effectiveAt,
        qualityTarget: {
          ...row.milkQualityTarget,
          auditId: deterministicProjectionId("audit", [context.job.id, row.importRowId, "milk-quality"]),
          auditAfterJson: JSON.stringify({ ...row.milkQualityTarget.values, kind: "laboratory", source: "cooprinsem_laboratory" }),
        },
        identifierTargets: [],
      };
    }
    if (!row.animalId || !row.animalTag || !row.lotId) throw staleProjectionError();
    const animalExpectedState = createAnimalIds.has(row.animalId) ? "planned" : "existing";
    const existingAnimal = animalExpectedState === "existing" ? existingAnimalById.get(row.animalId) ?? null : null;
    if (animalExpectedState === "existing" && !existingAnimal) throw staleProjectionError();
    const animalSourceId = deterministicProjectionId("source", [row.importRowId, "livestock_animal", row.animalId]);
    return {
      importRowId: row.importRowId,
      action: row.action,
      animalId: row.animalId,
      animalTag: row.animalTag,
      animalExpectedState,
      existingAnimal,
      lotId: row.lotId,
      effectiveAt: row.effectiveAt,
      sourceKey: row.sourceKey,
      membershipId: row.action === "create_animal"
        ? deterministicProjectionId("membership", [row.animalId, row.lotId, row.effectiveAt])
        : null,
      animalSourceId,
      animalAuditId: deterministicProjectionId("audit", [context.job.id, row.importRowId, "animal"]),
      animalAuditAction: row.action === "create_animal" ? "import.animal.created" : "import.animal.linked",
      animalAuditAfterJson: JSON.stringify({ tag: row.animalTag, identifiers: row.identifiers, lotId: row.lotId }),
      notes: `Creado desde ${context.job.sourceTable}; atributos clínicos y productivos no inferidos.`,
      milkControlTarget: row.milkControlTarget ? {
        ...row.milkControlTarget,
        auditId: deterministicProjectionId("audit", [context.job.id, row.importRowId, "milk-control"]),
        auditAfterJson: JSON.stringify({ animalId: row.animalId, ...row.milkControlTarget.values, source: "Cooprinsem CLO" }),
      } : null,
      identifierTargets: row.identifierTargets.map((target) => {
        const targetState = target.shouldInsert ? "insert" : insertedIdentifierIds.has(target.id) ? "planned" : "existing";
        const existingIdentifier = targetState === "existing" ? existingIdentifierById.get(target.id) ?? null : null;
        if (targetState === "existing" && !existingIdentifier) throw staleProjectionError();
        return {
          id: target.id,
          targetState,
          kind: target.identifier.kind,
          value: target.identifier.value,
          normalizedValue: target.identifier.normalizedValue,
          isPrimary: target.identifier.isPrimary,
          existingIdentifier,
          sourceRecordId: deterministicProjectionId("source", [row.importRowId, "livestock_animal_identifier", target.id]),
        };
      }),
    };
  });
  const quarantineNeeded = rows.some((row) => row.action === "create_animal" && row.lotId === context.quarantineLotId);
  const quarantineExisting = existingLotById.get(context.quarantineLotId) ?? null;
  const quarantine = {
    action: !quarantineNeeded ? "unused" : quarantineExisting ? "existing" : "create",
    id: context.quarantineLotId,
    entryDate: rows.find((row) => row.action === "create_animal" && row.lotId === context.quarantineLotId)?.effectiveAt ?? now.slice(0, 10),
    auditId: deterministicProjectionId("audit", [context.job.id, "quarantine-lot"]),
    auditAfterJson: JSON.stringify({ name: COOPRINSEM_QUARANTINE_LOT_NAME, trackingMode: "individual" }),
  };
  const targetLots = targetLotIds.flatMap((lotId) => {
    const existing = existingLotById.get(lotId);
    if (existing) return [existing];
    if (lotId === context.quarantineLotId && quarantine.action === "create") return [];
    throw staleProjectionError();
  });
  const firstRow = workRows[0];
  const plannedFieldIdentifier = context.plan.fieldIdentifier;
  const existingFieldIdentifier = plannedFieldIdentifier
    ? context.fieldIdentifiers.find((identifier) => identifier.organizationId === context.job.organizationId
      && identifier.fieldId === context.job.fieldId
      && identifier.sourceSystem === "cooprinsem"
      && identifier.kind === plannedFieldIdentifier.kind
      && identifier.normalizedValue === plannedFieldIdentifier.normalizedValue
      && identifier.validTo === null) ?? null
    : null;
  if (plannedFieldIdentifier?.action === "existing" && !existingFieldIdentifier) throw staleProjectionError();
  const fieldIdentifierId = plannedFieldIdentifier && firstRow
    ? existingFieldIdentifier?.id ?? deterministicProjectionId("field-identifier", [
      context.job.fieldId,
      plannedFieldIdentifier.kind,
      plannedFieldIdentifier.normalizedValue,
      firstRow.effectiveAt,
    ])
    : null;
  const fieldIdentifier = plannedFieldIdentifier && firstRow && fieldIdentifierId ? {
    action: plannedFieldIdentifier.action,
    id: fieldIdentifierId,
    kind: plannedFieldIdentifier.kind,
    value: plannedFieldIdentifier.value,
    normalizedValue: plannedFieldIdentifier.normalizedValue,
    validFrom: firstRow.effectiveAt,
    existingIdentifier: existingFieldIdentifier,
    importRowId: firstRow.importRowId,
    sourceKey: firstRow.sourceKey,
    sourceRecordId: deterministicProjectionId("source", [firstRow.importRowId, "field_external_identifier", fieldIdentifierId]),
    auditId: deterministicProjectionId("audit", [context.job.id, "field-identifier", fieldIdentifierId]),
    auditAfterJson: JSON.stringify(plannedFieldIdentifier),
  } : null;
  const guardAuditId = deterministicProjectionId("audit", [context.job.id, "confirmed"]);
  const guardBeforeJson = JSON.stringify({ status: context.job.status, isDryRun: context.job.isDryRun });
  const guardAfterJson = JSON.stringify({ status: completedStatus, ...context.plan.summary, confirmationId });
  const payload = JSON.stringify({
    confirmationId,
    access,
    demoEmail: DEMO_EMAIL,
    organizationId: context.job.organizationId,
    fieldId: context.job.fieldId,
    actor,
/* discarded non-atomic rebase alternative
    action: "import.field_identifier.linked",
    entityType: "field_external_identifier",
    entityId: identifierId,
    before: null,
    after: fieldIdentifier,
    sourceRecordId,
    occurredAt: now,
  }).onConflictDoNothing();
  if (existing) {
    await db.batch([sourceStatement, auditStatement]);
  } else {
    await db.batch([db.insert(fieldExternalIdentifiers).values({
      id: identifierId,
      organizationId: context.job.organizationId,
      fieldId: context.job.fieldId,
      sourceSystem: "cooprinsem",
      kind: fieldIdentifier.kind,
      value: fieldIdentifier.value,
      normalizedValue: fieldIdentifier.normalizedValue,
      validFrom: firstRow.effectiveAt,
      validTo: null,
      createdAt: now,
      updatedAt: now,
    }), sourceStatement, auditStatement]);
  }
}

async function persistProjectionRows(context: ProjectionContext, rows: ProjectionWorkRow[], actor: string, now: string): Promise<void> {
  const client = getDb().$client;
  for (let index = 0; index < rows.length; index += legacyBatchSize) {
    const statements = rows.slice(index, index + legacyBatchSize).flatMap((row) => projectionStatements(client, context, row, actor, now));
    if (statements.length > 0) await client.batch(statements);
  }
}

function projectionStatements(client: ReturnType<typeof getDb>["$client"], context: ProjectionContext, row: ProjectionWorkRow, actor: string, now: string) {
  const statements: ReturnType<typeof client.prepare>[] = [];
  const quality = row.milkQualityTarget;
  if (quality?.shouldInsert) {
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO milk_quality_samples (
        id, organization_id, field_id, sampled_at, period, kind, fat_percent,
        protein_percent, total_solids_percent, somatic_cell_count, somatic_cell_count_unit,
        bacterial_count, bacterial_count_unit, sanitary_flags, source, source_record_id,
        notes, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'laboratory', ?, ?, ?, ?, ?, ?, ?, '{}', 'cooprinsem_laboratory', NULL, ?, ?, ?, ?)
    `).bind(
      quality.id,
      context.job.organizationId,
      context.job.fieldId,
      quality.values.sampledAt,
      quality.values.period,
      quality.values.fatPercent,
      quality.values.proteinPercent,
      quality.values.totalSolidsPercent,
      quality.values.somaticCellCount,
      quality.values.somaticCellCountUnit,
      quality.values.bacterialCount,
      quality.values.bacterialCountUnit,
      `Importado desde ${context.job.sourceTable}.`,
      actor,
      now,
      now,
    ));
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table, source_key, target_entity, target_id, created_at
      )
      SELECT ?, ?, ?, 'cooprinsem', ?, ?, 'milk_quality_sample', ?, ?
      WHERE EXISTS (SELECT 1 FROM milk_quality_samples WHERE id = ?)
    `).bind(quality.sourceRecordId, context.job.id, row.importRowId, context.job.sourceTable, row.sourceKey, quality.id, now, quality.id));
    statements.push(client.prepare(`
      UPDATE milk_quality_samples
      SET source_record_id = ?, updated_at = ?
      WHERE id = ? AND (source_record_id IS NULL OR source_record_id = ?)
    `).bind(quality.sourceRecordId, now, quality.id, quality.sourceRecordId));
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, source_record_id, occurred_at
      )
      SELECT ?, ?, ?, ?, 'import.milk_quality_sample.created', 'milk_quality_sample', ?, NULL, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM milk_quality_samples WHERE id = ?)
        AND EXISTS (SELECT 1 FROM source_records WHERE id = ?)
    `).bind(
      deterministicProjectionId("audit", [context.job.id, row.importRowId, "milk-quality"]),
      context.job.organizationId,
      context.job.fieldId,
      actor,
      quality.id,
      JSON.stringify({ ...quality.values, kind: "laboratory", source: "cooprinsem_laboratory" }),
      quality.sourceRecordId,
      now,
      quality.id,
      quality.sourceRecordId,
    ));
  }
  if (!row.animalId || !row.animalTag || !row.lotId) {
    if (quality?.shouldInsert) {
      statements.push(client.prepare(`UPDATE import_rows SET status = 'imported', source_key = ?, updated_at = ? WHERE id = ?`).bind(row.sourceKey, now, row.importRowId));
    }
    return statements;
  }
  if (row.action === "create_animal") {
    statements.push(client.prepare(`
      Legacy non-atomic animal insert removed during guarded-batch migration.
        id, lot_id, tag, sex, status, status_date, status_reason, birth_date,
        purchase_price_clp, purchase_date, origin, notes, source, created_at, updated_at
      ) VALUES (?, ?, ?, 'unknown', 'active', NULL, NULL, NULL, NULL, NULL, 'Cooprinsem', ?, 'Importación Cooprinsem', ?, ?)
    `).bind(row.animalId, row.lotId, row.animalTag, `Creado desde ${context.job.sourceTable}; atributos clínicos y productivos no inferidos.`, now, now));
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO livestock_lot_memberships (
        id, animal_id, lot_id, started_at, ended_at, source_system, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'cooprinsem', ?, ?)
    `).bind(deterministicProjectionId("membership", [row.animalId, row.lotId, row.effectiveAt]), row.animalId, row.lotId, row.effectiveAt, now, now));
  }
  for (const target of row.identifierTargets) {
    if (target.shouldInsert) statements.push(client.prepare(`
      INSERT INTO livestock_animal_identifiers (
        id, field_id, animal_id, source_system, kind, value, normalized_value,
        valid_from, valid_to, is_primary, created_at, updated_at
      ) VALUES (?, ?, ?, 'cooprinsem', ?, ?, ?, ?, NULL, ?, ?, ?)
    `).bind(target.id, context.job.fieldId, row.animalId, target.identifier.kind, target.identifier.value, target.identifier.normalizedValue, row.effectiveAt, target.identifier.isPrimary ? 1 : 0, now, now));
  }
  const milkControl = row.milkControlTarget;
  if (milkControl?.shouldInsert) {
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO livestock_milk_controls (
        id, field_id, animal_id, lactation_id, control_date, morning_liters,
        afternoon_liters, third_milking_liters, total_liters, fat_pct, protein_pct,
        somatic_cell_count, notes, source, source_record_id, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Cooprinsem CLO', NULL, ?, ?, ?)
    `).bind(
      milkControl.id,
      context.job.fieldId,
      row.animalId,
      milkControl.lactationId,
      milkControl.values.controlDate,
      milkControl.values.morningLiters,
      milkControl.values.afternoonLiters,
      milkControl.values.thirdMilkingLiters,
      milkControl.values.totalLiters,
      milkControl.values.fatPct,
      milkControl.values.proteinPct,
      milkControl.values.somaticCellCount,
      `Importado desde ${context.job.sourceTable}.`,
      actor,
      now,
      now,
    ));
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table, source_key, target_entity, target_id, created_at
      )
      SELECT ?, ?, ?, 'cooprinsem', ?, ?, 'livestock_milk_control', ?, ?
      WHERE EXISTS (SELECT 1 FROM livestock_milk_controls WHERE id = ?)
    `).bind(
      milkControl.sourceRecordId,
      context.job.id,
      row.importRowId,
      context.job.sourceTable,
      row.sourceKey,
      milkControl.id,
      now,
      milkControl.id,
    ));
    statements.push(client.prepare(`
      UPDATE livestock_milk_controls
      SET source_record_id = ?, updated_at = ?
      WHERE id = ? AND (source_record_id IS NULL OR source_record_id = ?)
    `).bind(milkControl.sourceRecordId, now, milkControl.id, milkControl.sourceRecordId));
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, source_record_id, occurred_at
      )
      SELECT ?, ?, ?, ?, 'import.milk_control.created', 'livestock_milk_control', ?, NULL, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM livestock_milk_controls WHERE id = ?)
        AND EXISTS (SELECT 1 FROM source_records WHERE id = ?)
    `).bind(
      deterministicProjectionId("audit", [context.job.id, row.importRowId, "milk-control"]),
      context.job.organizationId,
      context.job.fieldId,
      actor,
      milkControl.id,
      JSON.stringify({ animalId: row.animalId, ...milkControl.values, source: "Cooprinsem CLO" }),
      milkControl.sourceRecordId,
      now,
      milkControl.id,
      milkControl.sourceRecordId,
    ));
  }
  const animalSourceId = deterministicProjectionId("source", [row.importRowId, "livestock_animal", row.animalId]);
  statements.push(client.prepare(`
    INSERT OR IGNORE INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table, source_key, target_entity, target_id, created_at
    ) VALUES (?, ?, ?, 'cooprinsem', ?, ?, 'livestock_animal', ?, ?)
  `).bind(animalSourceId, context.job.id, row.importRowId, context.job.sourceTable, row.sourceKey, row.animalId, now));
  for (const target of row.identifierTargets) {
    statements.push(client.prepare(`
      INSERT OR IGNORE INTO source_records (
        id, import_job_id, import_row_id, source_system, source_table, source_key, target_entity, target_id, created_at
      ) VALUES (?, ?, ?, 'cooprinsem', ?, ?, 'livestock_animal_identifier', ?, ?)
    `).bind(deterministicProjectionId("source", [row.importRowId, "livestock_animal_identifier", target.id]), context.job.id, row.importRowId, context.job.sourceTable, row.sourceKey, target.id, now));
  }
  statements.push(client.prepare(`
    INSERT OR IGNORE INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, source_record_id, occurred_at
    ) VALUES (?, ?, ?, ?, ?, 'livestock_animal', ?, NULL, ?, ?, ?)
  `).bind(
    deterministicProjectionId("audit", [context.job.id, row.importRowId, "animal"]),
    context.job.organizationId,
    context.job.fieldId,
    actor,
    row.action === "create_animal" ? "import.animal.created" : "import.animal.linked",
    row.animalId,
    JSON.stringify({ tag: row.animalTag, identifiers: row.identifiers, lotId: row.lotId }),
    animalSourceId,
*/
    now,
    completedStatus,
    guardAuditId,
    guardBeforeJson,
    guardAfterJson,
    job: context.job,
    lockStartedAt: context.job.startedAt ?? now,
    rows: rowSnapshots,
    issues: context.importIssues,
    scopeAnimals: context.animals.map(({ id, lotId, tag }) => ({ id, lotId, tag })),
    animalIdentifiers: context.animalIdentifiers,
    lotIdentifiers: context.lotIdentifiers,
    fieldIdentifiers: context.fieldIdentifiers,
    existingAnimalSources: context.existingAnimalSources,
    targetLots,
    workRows,
    affectedLotIds,
    quarantine,
    fieldIdentifier,
    expected: {
      workRowCount: workRows.length,
      animalWorkRowCount: rows.filter((row) => row.action === "create_animal" || row.action === "link_animal").length,
      createAnimalCount: rows.filter((row) => row.action === "create_animal").length,
      identifierInsertCount: rows.reduce((count, row) => count + row.identifierTargets.filter((target) => target.shouldInsert).length, 0),
      identifierSourceCount: rows.reduce((count, row) => count + row.identifierTargets.length, 0),
      affectedLotCount: affectedLotIds.length,
    },
  });
  const lockJob = client.prepare(`
    WITH input(payload) AS (VALUES (?))
    UPDATE import_jobs
    SET
      status = 'importing',
      started_at = json_extract((SELECT payload FROM input), '$.lockStartedAt'),
      failure_message = (SELECT payload FROM input),
      updated_at = json_extract((SELECT payload FROM input), '$.now')
    WHERE id = json_extract((SELECT payload FROM input), '$.job.id')
      AND organization_id = json_extract((SELECT payload FROM input), '$.access.organizationId')
      AND field_id IN (SELECT value FROM json_each((SELECT payload FROM input), '$.access.fieldIds'))
      AND organization_id = json_extract((SELECT payload FROM input), '$.job.organizationId')
      AND field_id = json_extract((SELECT payload FROM input), '$.job.fieldId')
      AND source_system = json_extract((SELECT payload FROM input), '$.job.sourceSystem')
      AND source_format = json_extract((SELECT payload FROM input), '$.job.sourceFormat')
      AND source_table = json_extract((SELECT payload FROM input), '$.job.sourceTable')
      AND original_filename = json_extract((SELECT payload FROM input), '$.job.originalFilename')
      AND content_type IS json_extract((SELECT payload FROM input), '$.job.contentType')
      AND file_size_bytes = json_extract((SELECT payload FROM input), '$.job.fileSizeBytes')
      AND object_key = json_extract((SELECT payload FROM input), '$.job.objectKey')
      AND sha256 = json_extract((SELECT payload FROM input), '$.job.sha256')
      AND mapping_version = json_extract((SELECT payload FROM input), '$.job.mappingVersion')
      AND effective_at IS json_extract((SELECT payload FROM input), '$.job.effectiveAt')
      AND status = 'preview_ready'
      AND status = json_extract((SELECT payload FROM input), '$.job.status')
      AND is_dry_run = json_extract((SELECT payload FROM input), '$.job.isDryRun')
      AND requested_by = json_extract((SELECT payload FROM input), '$.job.requestedBy')
      AND row_count = json_extract((SELECT payload FROM input), '$.job.rowCount')
      AND valid_row_count = json_extract((SELECT payload FROM input), '$.job.validRowCount')
      AND warning_row_count = json_extract((SELECT payload FROM input), '$.job.warningRowCount')
      AND error_row_count = json_extract((SELECT payload FROM input), '$.job.errorRowCount')
      AND skipped_row_count = json_extract((SELECT payload FROM input), '$.job.skippedRowCount')
      AND file_issue_count = json_extract((SELECT payload FROM input), '$.job.fileIssueCount')
      AND failure_message IS json_extract((SELECT payload FROM input), '$.job.failureMessage')
      AND started_at IS json_extract((SELECT payload FROM input), '$.job.startedAt')
      AND previewed_at IS json_extract((SELECT payload FROM input), '$.job.previewedAt')
      AND confirmed_at IS json_extract((SELECT payload FROM input), '$.job.confirmedAt')
      AND completed_at IS json_extract((SELECT payload FROM input), '$.job.completedAt')
      AND created_at = json_extract((SELECT payload FROM input), '$.job.createdAt')
      AND updated_at = json_extract((SELECT payload FROM input), '$.job.updatedAt')
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = import_jobs.field_id
          AND current_field.organization_id = json_extract((SELECT payload FROM input), '$.access.organizationId')
          AND current_field.id IN (SELECT value FROM json_each((SELECT payload FROM input), '$.access.fieldIds'))
      )
  `).bind(payload);
  const confirmationGuard = client.prepare(`
    ${projectionInputCte}
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(input.payload, '$.guardAuditId'),
      json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.fieldId'),
      json_extract(input.payload, '$.actor'),
      'import.confirmed',
      'import_job',
      json_extract(input.payload, '$.job.id'),
      json_extract(input.payload, '$.guardBeforeJson'),
      json_extract(input.payload, '$.guardAfterJson'),
      NULL,
      json_extract(input.payload, '$.now')
    FROM input
    WHERE changes() = 1
      AND EXISTS (
        SELECT 1 FROM fields AS current_field
        INNER JOIN organization_memberships AS current_actor
          ON current_actor.id = json_extract(input.payload, '$.access.membershipId')
         AND current_actor.organization_id = current_field.organization_id
         AND current_actor.normalized_email = lower(trim(json_extract(input.payload, '$.access.email')))
         AND current_actor.normalized_email <> json_extract(input.payload, '$.demoEmail')
         AND current_actor.status = 'active'
         AND current_actor.role IN ('owner', 'admin', 'manager')
        WHERE current_field.id = json_extract(input.payload, '$.fieldId')
          AND current_field.organization_id = json_extract(input.payload, '$.access.organizationId')
          AND current_field.is_demo = 0
          AND current_field.id IN (SELECT value FROM json_each(input.payload, '$.access.fieldIds'))
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id
                AND current_scope.field_id = current_field.id
            )
          )
      )
      AND (SELECT COUNT(*) FROM import_rows AS current_row
           WHERE current_row.import_job_id = json_extract(input.payload, '$.job.id')) = json_array_length(input.payload, '$.rows')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.rows') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM import_rows AS current_row
          WHERE current_row.id = json_extract(snapshot.value, '$.id')
            AND current_row.import_job_id = json_extract(snapshot.value, '$.importJobId')
            AND current_row.record_number = json_extract(snapshot.value, '$.recordNumber')
            AND current_row.source_key IS json_extract(snapshot.value, '$.sourceKey')
            AND current_row.raw_record = json_extract(snapshot.value, '$.rawRecordJson')
            AND current_row.normalized_record IS json_extract(snapshot.value, '$.normalizedRecordJson')
            AND current_row.status = json_extract(snapshot.value, '$.status')
            AND current_row.warning_count = json_extract(snapshot.value, '$.warningCount')
            AND current_row.error_count = json_extract(snapshot.value, '$.errorCount')
            AND current_row.created_at = json_extract(snapshot.value, '$.createdAt')
            AND current_row.updated_at = json_extract(snapshot.value, '$.updatedAt')
        )
      )
      AND (SELECT COUNT(*) FROM import_errors AS current_issue
           WHERE current_issue.import_job_id = json_extract(input.payload, '$.job.id')) = json_array_length(input.payload, '$.issues')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.issues') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM import_errors AS current_issue
          WHERE current_issue.id = json_extract(snapshot.value, '$.id')
            AND current_issue.import_job_id = json_extract(input.payload, '$.job.id')
            AND current_issue.import_row_id = json_extract(snapshot.value, '$.importRowId')
            AND current_issue.severity = json_extract(snapshot.value, '$.severity')
            AND current_issue.status = json_extract(snapshot.value, '$.status')
            AND current_issue.message = json_extract(snapshot.value, '$.message')
        )
      )
      AND (SELECT COUNT(*)
           FROM livestock_animals AS current_animal
           INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
           WHERE current_lot.field_id = json_extract(input.payload, '$.fieldId')) = json_array_length(input.payload, '$.scopeAnimals')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.scopeAnimals') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1
          FROM livestock_animals AS current_animal
          INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
          WHERE current_animal.id = json_extract(snapshot.value, '$.id')
            AND current_animal.lot_id = json_extract(snapshot.value, '$.lotId')
            AND current_animal.tag = json_extract(snapshot.value, '$.tag')
            AND current_lot.field_id = json_extract(input.payload, '$.fieldId')
        )
      )
      AND (SELECT COUNT(*) FROM livestock_animal_identifiers AS current_identifier
           WHERE current_identifier.field_id = json_extract(input.payload, '$.fieldId')) = json_array_length(input.payload, '$.animalIdentifiers')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.animalIdentifiers') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM livestock_animal_identifiers AS current_identifier
          WHERE current_identifier.id = json_extract(snapshot.value, '$.id')
            AND current_identifier.field_id = json_extract(snapshot.value, '$.fieldId')
            AND current_identifier.animal_id = json_extract(snapshot.value, '$.animalId')
            AND current_identifier.source_system = json_extract(snapshot.value, '$.sourceSystem')
            AND current_identifier.kind = json_extract(snapshot.value, '$.kind')
            AND current_identifier.value = json_extract(snapshot.value, '$.value')
            AND current_identifier.normalized_value = json_extract(snapshot.value, '$.normalizedValue')
            AND current_identifier.valid_from IS json_extract(snapshot.value, '$.validFrom')
            AND current_identifier.valid_to IS json_extract(snapshot.value, '$.validTo')
            AND current_identifier.is_primary = json_extract(snapshot.value, '$.isPrimary')
            AND current_identifier.created_at = json_extract(snapshot.value, '$.createdAt')
            AND current_identifier.updated_at = json_extract(snapshot.value, '$.updatedAt')
        )
      )
      AND (SELECT COUNT(*) FROM livestock_lot_external_identifiers AS current_identifier
           WHERE current_identifier.field_id = json_extract(input.payload, '$.fieldId')) = json_array_length(input.payload, '$.lotIdentifiers')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.lotIdentifiers') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM livestock_lot_external_identifiers AS current_identifier
          WHERE current_identifier.id = json_extract(snapshot.value, '$.id')
            AND current_identifier.field_id = json_extract(snapshot.value, '$.fieldId')
            AND current_identifier.lot_id = json_extract(snapshot.value, '$.lotId')
            AND current_identifier.source_system = json_extract(snapshot.value, '$.sourceSystem')
            AND current_identifier.kind = json_extract(snapshot.value, '$.kind')
            AND current_identifier.value = json_extract(snapshot.value, '$.value')
            AND current_identifier.normalized_value = json_extract(snapshot.value, '$.normalizedValue')
            AND current_identifier.valid_from IS json_extract(snapshot.value, '$.validFrom')
            AND current_identifier.valid_to IS json_extract(snapshot.value, '$.validTo')
            AND current_identifier.created_at = json_extract(snapshot.value, '$.createdAt')
            AND current_identifier.updated_at = json_extract(snapshot.value, '$.updatedAt')
        )
      )
      AND (SELECT COUNT(*) FROM field_external_identifiers AS current_identifier
           WHERE current_identifier.organization_id = json_extract(input.payload, '$.organizationId')) = json_array_length(input.payload, '$.fieldIdentifiers')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.fieldIdentifiers') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM field_external_identifiers AS current_identifier
          WHERE current_identifier.id = json_extract(snapshot.value, '$.id')
            AND current_identifier.organization_id = json_extract(snapshot.value, '$.organizationId')
            AND current_identifier.field_id = json_extract(snapshot.value, '$.fieldId')
            AND current_identifier.source_system = json_extract(snapshot.value, '$.sourceSystem')
            AND current_identifier.kind = json_extract(snapshot.value, '$.kind')
            AND current_identifier.value = json_extract(snapshot.value, '$.value')
            AND current_identifier.normalized_value = json_extract(snapshot.value, '$.normalizedValue')
            AND current_identifier.valid_from IS json_extract(snapshot.value, '$.validFrom')
            AND current_identifier.valid_to IS json_extract(snapshot.value, '$.validTo')
            AND current_identifier.created_at = json_extract(snapshot.value, '$.createdAt')
            AND current_identifier.updated_at = json_extract(snapshot.value, '$.updatedAt')
        )
      )
      AND (SELECT COUNT(*) FROM source_records AS current_source
           WHERE current_source.import_job_id = json_extract(input.payload, '$.job.id')
             AND current_source.target_entity = 'livestock_animal') = json_array_length(input.payload, '$.existingAnimalSources')
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.existingAnimalSources') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM source_records AS current_source
          WHERE current_source.id = json_extract(snapshot.value, '$.id')
            AND current_source.import_job_id = json_extract(snapshot.value, '$.importJobId')
            AND current_source.import_row_id = json_extract(snapshot.value, '$.importRowId')
            AND current_source.source_system = json_extract(snapshot.value, '$.sourceSystem')
            AND current_source.source_table = json_extract(snapshot.value, '$.sourceTable')
            AND current_source.source_key IS json_extract(snapshot.value, '$.sourceKey')
            AND current_source.target_entity = json_extract(snapshot.value, '$.targetEntity')
            AND current_source.target_id = json_extract(snapshot.value, '$.targetId')
            AND current_source.created_at = json_extract(snapshot.value, '$.createdAt')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.targetLots') AS snapshot
        WHERE NOT EXISTS (
          SELECT 1 FROM livestock_lots AS current_lot
          WHERE current_lot.id = json_extract(snapshot.value, '$.id')
            AND current_lot.field_id = json_extract(snapshot.value, '$.fieldId')
            AND current_lot.paddock_id IS json_extract(snapshot.value, '$.paddockId')
            AND current_lot.name = json_extract(snapshot.value, '$.name')
            AND current_lot.category = json_extract(snapshot.value, '$.category')
            AND current_lot.animal_count = json_extract(snapshot.value, '$.animalCount')
            AND current_lot.average_weight_kg IS json_extract(snapshot.value, '$.averageWeightKg')
            AND current_lot.entry_date = json_extract(snapshot.value, '$.entryDate')
            AND current_lot.status = json_extract(snapshot.value, '$.status')
            AND current_lot.owner_name IS json_extract(snapshot.value, '$.ownerName')
            AND current_lot.tracking_mode = json_extract(snapshot.value, '$.trackingMode')
            AND current_lot.notes = json_extract(snapshot.value, '$.notes')
            AND current_lot.created_at = json_extract(snapshot.value, '$.createdAt')
            AND current_lot.updated_at = json_extract(snapshot.value, '$.updatedAt')
            AND current_lot.field_id = json_extract(input.payload, '$.fieldId')
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.workRows') AS work
        WHERE NOT EXISTS (
          SELECT 1 FROM json_each(input.payload, '$.targetLots') AS target_lot
          WHERE json_extract(target_lot.value, '$.id') = json_extract(work.value, '$.lotId')
        )
          AND NOT (
            json_extract(input.payload, '$.quarantine.action') = 'create'
            AND json_extract(work.value, '$.lotId') = json_extract(input.payload, '$.quarantine.id')
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.workRows') AS work
        WHERE json_extract(work.value, '$.action') = 'create_animal'
          AND NOT (
            EXISTS (
              SELECT 1 FROM json_each(input.payload, '$.targetLots') AS target_lot
              WHERE json_extract(target_lot.value, '$.id') = json_extract(work.value, '$.lotId')
                AND json_extract(target_lot.value, '$.status') = 'active'
                AND json_extract(target_lot.value, '$.trackingMode') = 'individual'
            )
            OR (
              json_extract(input.payload, '$.quarantine.action') = 'create'
              AND json_extract(work.value, '$.lotId') = json_extract(input.payload, '$.quarantine.id')
            )
          )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.workRows') AS work
        WHERE (
          json_extract(work.value, '$.animalExpectedState') = 'planned'
          AND EXISTS (SELECT 1 FROM livestock_animals WHERE id = json_extract(work.value, '$.animalId'))
        ) OR (
          json_extract(work.value, '$.animalExpectedState') = 'existing'
          AND NOT EXISTS (
            SELECT 1
            FROM livestock_animals AS current_animal
            INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
            WHERE current_animal.id = json_extract(work.value, '$.animalId')
              AND current_animal.lot_id = json_extract(work.value, '$.existingAnimal.lotId')
              AND current_animal.tag = json_extract(work.value, '$.existingAnimal.tag')
              AND current_animal.sex = json_extract(work.value, '$.existingAnimal.sex')
              AND current_animal.status = json_extract(work.value, '$.existingAnimal.status')
              AND current_animal.status_date IS json_extract(work.value, '$.existingAnimal.statusDate')
              AND current_animal.status_reason IS json_extract(work.value, '$.existingAnimal.statusReason')
              AND current_animal.birth_date IS json_extract(work.value, '$.existingAnimal.birthDate')
              AND current_animal.purchase_price_clp IS json_extract(work.value, '$.existingAnimal.purchasePriceClp')
              AND current_animal.purchase_date IS json_extract(work.value, '$.existingAnimal.purchaseDate')
              AND current_animal.origin IS json_extract(work.value, '$.existingAnimal.origin')
              AND current_animal.notes = json_extract(work.value, '$.existingAnimal.notes')
              AND current_animal.source = json_extract(work.value, '$.existingAnimal.source')
              AND current_animal.created_at = json_extract(work.value, '$.existingAnimal.createdAt')
              AND current_animal.updated_at = json_extract(work.value, '$.existingAnimal.updatedAt')
              AND current_lot.field_id = json_extract(input.payload, '$.fieldId')
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(input.payload, '$.workRows') AS work,
             json_each(work.value, '$.identifierTargets') AS target
        WHERE (
          json_extract(target.value, '$.targetState') = 'insert'
          AND (
            EXISTS (SELECT 1 FROM livestock_animal_identifiers WHERE id = json_extract(target.value, '$.id'))
            OR EXISTS (
              SELECT 1 FROM livestock_animal_identifiers AS active_identifier
              WHERE active_identifier.field_id = json_extract(input.payload, '$.fieldId')
                AND active_identifier.source_system = 'cooprinsem'
                AND active_identifier.kind = json_extract(target.value, '$.kind')
                AND active_identifier.normalized_value = json_extract(target.value, '$.normalizedValue')
                AND active_identifier.valid_to IS NULL
            )
          )
        ) OR (
          json_extract(target.value, '$.targetState') = 'existing'
          AND NOT EXISTS (
            SELECT 1 FROM livestock_animal_identifiers AS current_identifier
            WHERE current_identifier.id = json_extract(target.value, '$.id')
              AND current_identifier.animal_id = json_extract(work.value, '$.animalId')
              AND current_identifier.field_id = json_extract(input.payload, '$.fieldId')
              AND current_identifier.source_system = 'cooprinsem'
              AND current_identifier.kind = json_extract(target.value, '$.kind')
              AND current_identifier.value = json_extract(target.value, '$.value')
              AND current_identifier.normalized_value = json_extract(target.value, '$.normalizedValue')
              AND current_identifier.valid_to IS NULL
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(input.payload, '$.workRows') AS work
        WHERE EXISTS (SELECT 1 FROM source_records WHERE id = json_extract(work.value, '$.animalSourceId'))
           OR EXISTS (
             SELECT 1 FROM source_records
             WHERE import_row_id = json_extract(work.value, '$.importRowId')
               AND target_entity = 'livestock_animal'
               AND target_id = json_extract(work.value, '$.animalId')
           )
           OR EXISTS (SELECT 1 FROM audit_log WHERE id = json_extract(work.value, '$.animalAuditId'))
           OR (
             json_extract(work.value, '$.action') = 'create_animal'
             AND (
               EXISTS (SELECT 1 FROM livestock_lot_memberships WHERE id = json_extract(work.value, '$.membershipId'))
               OR EXISTS (
                 SELECT 1 FROM livestock_lot_memberships
                 WHERE animal_id = json_extract(work.value, '$.animalId') AND ended_at IS NULL
               )
             )
           )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM json_each(input.payload, '$.workRows') AS work,
             json_each(work.value, '$.identifierTargets') AS target
        WHERE EXISTS (SELECT 1 FROM source_records WHERE id = json_extract(target.value, '$.sourceRecordId'))
           OR EXISTS (
             SELECT 1 FROM source_records
             WHERE import_row_id = json_extract(work.value, '$.importRowId')
               AND target_entity = 'livestock_animal_identifier'
               AND target_id = json_extract(target.value, '$.id')
           )
      )
      AND (
        json_extract(input.payload, '$.quarantine.action') <> 'create'
        OR NOT EXISTS (SELECT 1 FROM livestock_lots WHERE id = json_extract(input.payload, '$.quarantine.id'))
      )
      AND (
        json_extract(input.payload, '$.quarantine.action') = 'unused'
        OR NOT EXISTS (SELECT 1 FROM audit_log WHERE id = json_extract(input.payload, '$.quarantine.auditId'))
      )
      AND (
        json_type(input.payload, '$.fieldIdentifier') = 'null'
        OR (
          NOT EXISTS (SELECT 1 FROM source_records WHERE id = json_extract(input.payload, '$.fieldIdentifier.sourceRecordId'))
          AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = json_extract(input.payload, '$.fieldIdentifier.auditId'))
          AND NOT EXISTS (
            SELECT 1 FROM source_records
            WHERE import_row_id = json_extract(input.payload, '$.fieldIdentifier.importRowId')
              AND target_entity = 'field_external_identifier'
              AND target_id = json_extract(input.payload, '$.fieldIdentifier.id')
          )
          AND (
            (
              json_extract(input.payload, '$.fieldIdentifier.action') = 'create'
              AND NOT EXISTS (SELECT 1 FROM field_external_identifiers WHERE id = json_extract(input.payload, '$.fieldIdentifier.id'))
              AND NOT EXISTS (
                SELECT 1 FROM field_external_identifiers AS active_identifier
                WHERE active_identifier.organization_id = json_extract(input.payload, '$.organizationId')
                  AND active_identifier.source_system = 'cooprinsem'
                  AND active_identifier.kind = json_extract(input.payload, '$.fieldIdentifier.kind')
                  AND active_identifier.normalized_value = json_extract(input.payload, '$.fieldIdentifier.normalizedValue')
                  AND active_identifier.valid_to IS NULL
              )
            )
            OR (
              json_extract(input.payload, '$.fieldIdentifier.action') = 'existing'
              AND EXISTS (
                SELECT 1 FROM field_external_identifiers AS current_identifier
                WHERE current_identifier.id = json_extract(input.payload, '$.fieldIdentifier.id')
                  AND current_identifier.organization_id = json_extract(input.payload, '$.organizationId')
                  AND current_identifier.field_id = json_extract(input.payload, '$.fieldId')
                  AND current_identifier.source_system = 'cooprinsem'
                  AND current_identifier.kind = json_extract(input.payload, '$.fieldIdentifier.kind')
                  AND current_identifier.normalized_value = json_extract(input.payload, '$.fieldIdentifier.normalizedValue')
                  AND current_identifier.valid_to IS NULL
              )
            )
          )
        )
      )
  `).bind(confirmationId);
  const ensureQuarantineLot = client.prepare(`
    ${projectionInputCte}
    INSERT INTO livestock_lots (
      id, field_id, paddock_id, name, category, animal_count, average_weight_kg,
      entry_date, status, owner_name, tracking_mode, notes, created_at, updated_at
    )
    SELECT
      json_extract(input.payload, '$.quarantine.id'),
      json_extract(input.payload, '$.fieldId'),
      NULL,
      '${COOPRINSEM_QUARANTINE_LOT_NAME}',
      'other',
      0,
      NULL,
      json_extract(input.payload, '$.quarantine.entryDate'),
      'active',
      NULL,
      'individual',
      'Lote técnico para animales importados cuyo grupo Cooprinsem todavía no está configurado.',
      json_extract(input.payload, '$.now'),
      json_extract(input.payload, '$.now')
    FROM input
    WHERE json_extract(input.payload, '$.quarantine.action') = 'create'
      AND ${projectionGuardExists}
  `).bind(confirmationId);
  const quarantineAudit = client.prepare(`
    ${projectionInputCte}
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(input.payload, '$.quarantine.auditId'),
      json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.fieldId'),
      json_extract(input.payload, '$.actor'),
      'import.quarantine_lot.ensure',
      'livestock_lot',
      json_extract(input.payload, '$.quarantine.id'),
      NULL,
      json_extract(input.payload, '$.quarantine.auditAfterJson'),
      NULL,
      json_extract(input.payload, '$.now')
    FROM input
    WHERE json_extract(input.payload, '$.quarantine.action') <> 'unused'
      AND ${projectionGuardExists}
      AND EXISTS (
        SELECT 1 FROM livestock_lots AS quarantine_lot
        WHERE quarantine_lot.id = json_extract(input.payload, '$.quarantine.id')
          AND quarantine_lot.field_id = json_extract(input.payload, '$.fieldId')
          AND quarantine_lot.status = 'active'
          AND quarantine_lot.tracking_mode = 'individual'
      )
  `).bind(confirmationId);
  const ensureFieldIdentifier = client.prepare(`
    ${projectionInputCte}
    INSERT INTO field_external_identifiers (
      id, organization_id, field_id, source_system, kind, value, normalized_value,
      valid_from, valid_to, created_at, updated_at
    )
    SELECT
      json_extract(input.payload, '$.fieldIdentifier.id'),
      json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.fieldId'),
      'cooprinsem',
      json_extract(input.payload, '$.fieldIdentifier.kind'),
      json_extract(input.payload, '$.fieldIdentifier.value'),
      json_extract(input.payload, '$.fieldIdentifier.normalizedValue'),
      json_extract(input.payload, '$.fieldIdentifier.validFrom'),
      NULL,
      json_extract(input.payload, '$.now'),
      json_extract(input.payload, '$.now')
    FROM input
    WHERE json_extract(input.payload, '$.fieldIdentifier.action') = 'create'
      AND ${projectionGuardExists}
  `).bind(confirmationId);
  const fieldIdentifierSource = client.prepare(`
    ${projectionInputCte}
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table, source_key,
      target_entity, target_id, created_at
    )
    SELECT
      json_extract(input.payload, '$.fieldIdentifier.sourceRecordId'),
      json_extract(input.payload, '$.job.id'),
      json_extract(input.payload, '$.fieldIdentifier.importRowId'),
      'cooprinsem',
      json_extract(input.payload, '$.job.sourceTable'),
      json_extract(input.payload, '$.fieldIdentifier.sourceKey'),
      'field_external_identifier',
      json_extract(input.payload, '$.fieldIdentifier.id'),
      json_extract(input.payload, '$.now')
    FROM input
    WHERE json_type(input.payload, '$.fieldIdentifier') <> 'null'
      AND ${projectionGuardExists}
      AND EXISTS (
        SELECT 1 FROM field_external_identifiers AS current_identifier
        WHERE current_identifier.id = json_extract(input.payload, '$.fieldIdentifier.id')
          AND current_identifier.organization_id = json_extract(input.payload, '$.organizationId')
          AND current_identifier.field_id = json_extract(input.payload, '$.fieldId')
          AND current_identifier.valid_to IS NULL
      )
  `).bind(confirmationId);
  const fieldIdentifierAudit = client.prepare(`
    ${projectionInputCte}
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(input.payload, '$.fieldIdentifier.auditId'),
      json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.fieldId'),
      json_extract(input.payload, '$.actor'),
      'import.field_identifier.linked',
      'field_external_identifier',
      json_extract(input.payload, '$.fieldIdentifier.id'),
      NULL,
      json_extract(input.payload, '$.fieldIdentifier.auditAfterJson'),
      json_extract(input.payload, '$.fieldIdentifier.sourceRecordId'),
      json_extract(input.payload, '$.now')
    FROM input
    WHERE json_type(input.payload, '$.fieldIdentifier') <> 'null'
      AND ${projectionGuardExists}
      AND EXISTS (SELECT 1 FROM source_records WHERE id = json_extract(input.payload, '$.fieldIdentifier.sourceRecordId'))
  `).bind(confirmationId);
  const createAnimals = client.prepare(`
    ${projectionInputCte}
    INSERT INTO livestock_animals (
      id, lot_id, tag, sex, status, status_date, status_reason, birth_date,
      purchase_price_clp, purchase_date, origin, notes, source, created_at, updated_at
    )
    SELECT
      json_extract(work.value, '$.animalId'),
      json_extract(work.value, '$.lotId'),
      json_extract(work.value, '$.animalTag'),
      'unknown', 'active', NULL, NULL, NULL, NULL, NULL, 'Cooprinsem',
      json_extract(work.value, '$.notes'),
      'Importación Cooprinsem',
      json_extract(input.payload, '$.now'),
      json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_extract(work.value, '$.action') = 'create_animal'
      AND ${projectionGuardExists}
      AND EXISTS (
        SELECT 1 FROM livestock_lots AS target_lot
        WHERE target_lot.id = json_extract(work.value, '$.lotId')
          AND target_lot.field_id = json_extract(input.payload, '$.fieldId')
          AND target_lot.status = 'active'
          AND target_lot.tracking_mode = 'individual'
      )
  `).bind(confirmationId);
  const createMemberships = client.prepare(`
    ${projectionInputCte}
    INSERT INTO livestock_lot_memberships (
      id, animal_id, lot_id, started_at, ended_at, source_system, created_at, updated_at
    )
    SELECT
      json_extract(work.value, '$.membershipId'),
      json_extract(work.value, '$.animalId'),
      json_extract(work.value, '$.lotId'),
      json_extract(work.value, '$.effectiveAt'),
      NULL,
      'cooprinsem',
      json_extract(input.payload, '$.now'),
      json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_extract(work.value, '$.action') = 'create_animal'
      AND ${projectionGuardExists}
      AND EXISTS (
        SELECT 1 FROM livestock_animals AS created_animal
        WHERE created_animal.id = json_extract(work.value, '$.animalId')
          AND created_animal.lot_id = json_extract(work.value, '$.lotId')
      )
  `).bind(confirmationId);
  const createIdentifiers = client.prepare(`
    ${projectionInputCte}
    INSERT INTO livestock_animal_identifiers (
      id, field_id, animal_id, source_system, kind, value, normalized_value,
      valid_from, valid_to, is_primary, created_at, updated_at
    )
    SELECT
      json_extract(target.value, '$.id'),
      json_extract(input.payload, '$.fieldId'),
      json_extract(work.value, '$.animalId'),
      'cooprinsem',
      json_extract(target.value, '$.kind'),
      json_extract(target.value, '$.value'),
      json_extract(target.value, '$.normalizedValue'),
      json_extract(work.value, '$.effectiveAt'),
      NULL,
      json_extract(target.value, '$.isPrimary'),
      json_extract(input.payload, '$.now'),
      json_extract(input.payload, '$.now')
    FROM input,
         json_each(input.payload, '$.workRows') AS work,
         json_each(work.value, '$.identifierTargets') AS target
    WHERE json_extract(target.value, '$.targetState') = 'insert'
      AND ${projectionGuardExists}
      AND EXISTS (
        SELECT 1
        FROM livestock_animals AS current_animal
        INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
        WHERE current_animal.id = json_extract(work.value, '$.animalId')
          AND current_lot.field_id = json_extract(input.payload, '$.fieldId')
      )
  `).bind(confirmationId);
  const animalSources = client.prepare(`
    ${projectionInputCte}
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table, source_key,
      target_entity, target_id, created_at
    )
    SELECT
      json_extract(work.value, '$.animalSourceId'),
      json_extract(input.payload, '$.job.id'),
      json_extract(work.value, '$.importRowId'),
      'cooprinsem',
      json_extract(input.payload, '$.job.sourceTable'),
      json_extract(work.value, '$.sourceKey'),
      'livestock_animal',
      json_extract(work.value, '$.animalId'),
      json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE ${projectionGuardExists}
      AND EXISTS (
        SELECT 1
        FROM livestock_animals AS current_animal
        INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
        WHERE current_animal.id = json_extract(work.value, '$.animalId')
          AND current_lot.field_id = json_extract(input.payload, '$.fieldId')
      )
  `).bind(confirmationId);
  const identifierSources = client.prepare(`
    ${projectionInputCte}
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table, source_key,
      target_entity, target_id, created_at
    )
    SELECT
      json_extract(target.value, '$.sourceRecordId'),
      json_extract(input.payload, '$.job.id'),
      json_extract(work.value, '$.importRowId'),
      'cooprinsem',
      json_extract(input.payload, '$.job.sourceTable'),
      json_extract(work.value, '$.sourceKey'),
      'livestock_animal_identifier',
      json_extract(target.value, '$.id'),
      json_extract(input.payload, '$.now')
    FROM input,
         json_each(input.payload, '$.workRows') AS work,
         json_each(work.value, '$.identifierTargets') AS target
    WHERE ${projectionGuardExists}
      AND EXISTS (
        SELECT 1 FROM livestock_animal_identifiers AS current_identifier
        WHERE current_identifier.id = json_extract(target.value, '$.id')
          AND current_identifier.animal_id = json_extract(work.value, '$.animalId')
          AND current_identifier.field_id = json_extract(input.payload, '$.fieldId')
      )
  `).bind(confirmationId);
  const animalAudits = client.prepare(`
    ${projectionInputCte}
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(work.value, '$.animalAuditId'),
      json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.fieldId'),
      json_extract(input.payload, '$.actor'),
      json_extract(work.value, '$.animalAuditAction'),
      'livestock_animal',
      json_extract(work.value, '$.animalId'),
      NULL,
      json_extract(work.value, '$.animalAuditAfterJson'),
      json_extract(work.value, '$.animalSourceId'),
      json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE ${projectionGuardExists}
      AND EXISTS (SELECT 1 FROM source_records WHERE id = json_extract(work.value, '$.animalSourceId'))
  `).bind(confirmationId);
  const milkSources = client.prepare(`
    ${projectionInputCte}
    INSERT INTO source_records (id, import_job_id, import_row_id, source_system, source_table, source_key, target_entity, target_id, created_at)
    SELECT json_extract(work.value, '$.milkControlTarget.sourceRecordId'), json_extract(input.payload, '$.job.id'),
      json_extract(work.value, '$.importRowId'), 'cooprinsem', json_extract(input.payload, '$.job.sourceTable'),
      json_extract(work.value, '$.sourceKey'), 'livestock_milk_control', json_extract(work.value, '$.milkControlTarget.id'),
      json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_type(work.value, '$.milkControlTarget') <> 'null' AND ${projectionGuardExists}
  `).bind(confirmationId);
  const createMilkControls = client.prepare(`
    ${projectionInputCte}
    INSERT INTO livestock_milk_controls (id, field_id, animal_id, lactation_id, control_date, morning_liters, afternoon_liters,
      third_milking_liters, total_liters, fat_pct, protein_pct, somatic_cell_count, notes, source, source_record_id, created_by, created_at, updated_at)
    SELECT json_extract(work.value, '$.milkControlTarget.id'), json_extract(input.payload, '$.fieldId'), json_extract(work.value, '$.animalId'),
      json_extract(work.value, '$.milkControlTarget.lactationId'), json_extract(work.value, '$.milkControlTarget.values.controlDate'),
      json_extract(work.value, '$.milkControlTarget.values.morningLiters'), json_extract(work.value, '$.milkControlTarget.values.afternoonLiters'),
      json_extract(work.value, '$.milkControlTarget.values.thirdMilkingLiters'), json_extract(work.value, '$.milkControlTarget.values.totalLiters'),
      json_extract(work.value, '$.milkControlTarget.values.fatPct'), json_extract(work.value, '$.milkControlTarget.values.proteinPct'),
      json_extract(work.value, '$.milkControlTarget.values.somaticCellCount'), 'Importado desde Cooprinsem.', 'Cooprinsem CLO',
      json_extract(work.value, '$.milkControlTarget.sourceRecordId'), json_extract(input.payload, '$.actor'),
      json_extract(input.payload, '$.now'), json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_type(work.value, '$.milkControlTarget') <> 'null' AND ${projectionGuardExists}
  `).bind(confirmationId);
  const milkAudits = client.prepare(`
    ${projectionInputCte}
    INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, source_record_id, occurred_at)
    SELECT json_extract(work.value, '$.milkControlTarget.auditId'), json_extract(input.payload, '$.organizationId'),
      json_extract(input.payload, '$.fieldId'), json_extract(input.payload, '$.actor'), 'import.milk_control.created',
      'livestock_milk_control', json_extract(work.value, '$.milkControlTarget.id'), NULL,
      json_extract(work.value, '$.milkControlTarget.auditAfterJson'), json_extract(work.value, '$.milkControlTarget.sourceRecordId'),
      json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_type(work.value, '$.milkControlTarget') <> 'null' AND ${projectionGuardExists}
  `).bind(confirmationId);
  const qualitySources = client.prepare(`
    ${projectionInputCte}
    INSERT INTO source_records (id, import_job_id, import_row_id, source_system, source_table, source_key, target_entity, target_id, created_at)
    SELECT json_extract(work.value, '$.qualityTarget.sourceRecordId'), json_extract(input.payload, '$.job.id'),
      json_extract(work.value, '$.importRowId'), 'cooprinsem', json_extract(input.payload, '$.job.sourceTable'),
      json_extract(work.value, '$.sourceKey'), 'milk_quality_sample', json_extract(work.value, '$.qualityTarget.id'), json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_type(work.value, '$.qualityTarget') <> 'null' AND ${projectionGuardExists}
  `).bind(confirmationId);
  const createQualitySamples = client.prepare(`
    ${projectionInputCte}
    INSERT INTO milk_quality_samples (id, organization_id, field_id, sampled_at, period, kind, fat_percent, protein_percent,
      total_solids_percent, somatic_cell_count, somatic_cell_count_unit, bacterial_count, bacterial_count_unit, sanitary_flags,
      source, source_record_id, notes, created_by, created_at, updated_at)
    SELECT json_extract(work.value, '$.qualityTarget.id'), json_extract(input.payload, '$.organizationId'), json_extract(input.payload, '$.fieldId'),
      json_extract(work.value, '$.qualityTarget.values.sampledAt'), json_extract(work.value, '$.qualityTarget.values.period'), 'laboratory',
      json_extract(work.value, '$.qualityTarget.values.fatPercent'), json_extract(work.value, '$.qualityTarget.values.proteinPercent'),
      json_extract(work.value, '$.qualityTarget.values.totalSolidsPercent'), json_extract(work.value, '$.qualityTarget.values.somaticCellCount'),
      json_extract(work.value, '$.qualityTarget.values.somaticCellCountUnit'), json_extract(work.value, '$.qualityTarget.values.bacterialCount'),
      json_extract(work.value, '$.qualityTarget.values.bacterialCountUnit'), '{}', 'cooprinsem_laboratory',
      json_extract(work.value, '$.qualityTarget.sourceRecordId'), 'Importado desde Cooprinsem.', json_extract(input.payload, '$.actor'),
      json_extract(input.payload, '$.now'), json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_type(work.value, '$.qualityTarget') <> 'null' AND ${projectionGuardExists}
  `).bind(confirmationId);
  const qualityAudits = client.prepare(`
    ${projectionInputCte}
    INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, source_record_id, occurred_at)
    SELECT json_extract(work.value, '$.qualityTarget.auditId'), json_extract(input.payload, '$.organizationId'), json_extract(input.payload, '$.fieldId'),
      json_extract(input.payload, '$.actor'), 'import.milk_quality_sample.created', 'milk_quality_sample', json_extract(work.value, '$.qualityTarget.id'),
      NULL, json_extract(work.value, '$.qualityTarget.auditAfterJson'), json_extract(work.value, '$.qualityTarget.sourceRecordId'), json_extract(input.payload, '$.now')
    FROM input, json_each(input.payload, '$.workRows') AS work
    WHERE json_type(work.value, '$.qualityTarget') <> 'null' AND ${projectionGuardExists}
  `).bind(confirmationId);
  const updateImportRows = client.prepare(`
    ${projectionInputCte}
    UPDATE import_rows
    SET
      status = 'imported',
      source_key = (
        SELECT json_extract(work.value, '$.sourceKey')
        FROM input, json_each(input.payload, '$.workRows') AS work
        WHERE json_extract(work.value, '$.importRowId') = import_rows.id
      ),
      updated_at = (SELECT json_extract(input.payload, '$.now') FROM input)
    WHERE id IN (
      SELECT json_extract(work.value, '$.importRowId')
      FROM input, json_each(input.payload, '$.workRows') AS work
    )
      AND ${projectionGuardExists}
      AND (EXISTS (
        SELECT 1 FROM source_records AS animal_source
        WHERE animal_source.import_row_id = import_rows.id
          AND animal_source.target_entity = 'livestock_animal'
          AND animal_source.id IN (
            SELECT json_extract(work.value, '$.animalSourceId')
            FROM input, json_each(input.payload, '$.workRows') AS work
          )
      ) OR EXISTS (
        SELECT 1 FROM source_records AS quality_source
        WHERE quality_source.import_row_id = import_rows.id
          AND quality_source.target_entity = 'milk_quality_sample'
          AND quality_source.id IN (
            SELECT json_extract(work.value, '$.qualityTarget.sourceRecordId')
            FROM input, json_each(input.payload, '$.workRows') AS work
          )
      ))
  `).bind(confirmationId);
  const updateLotSummaries = client.prepare(`
    ${projectionInputCte}
    UPDATE livestock_lots
    SET
      animal_count = (
        SELECT COUNT(*) FROM livestock_animals AS animal
        WHERE animal.lot_id = livestock_lots.id AND animal.status = 'active'
      ),
      average_weight_kg = (
        SELECT ROUND(AVG(latest.weight_kg), 1)
        FROM (
          SELECT (
            SELECT weighing.weight_kg
            FROM livestock_weighings AS weighing
            WHERE weighing.animal_id = animal.id
            ORDER BY weighing.recorded_at DESC, weighing.created_at DESC
            LIMIT 1
          ) AS weight_kg
          FROM livestock_animals AS animal
          WHERE animal.lot_id = livestock_lots.id AND animal.status = 'active'
        ) AS latest
        WHERE latest.weight_kg IS NOT NULL
      ),
      updated_at = (SELECT json_extract(input.payload, '$.now') FROM input)
    WHERE id IN (
      SELECT value FROM input, json_each(input.payload, '$.affectedLotIds')
    )
      AND field_id = (SELECT json_extract(input.payload, '$.fieldId') FROM input)
      AND tracking_mode = 'individual'
      AND ${projectionGuardExists}
  `).bind(confirmationId);
  const assertComplete = client.prepare(`
    ${projectionInputCte}
    SELECT CASE WHEN
      ${projectionGuardExists}
      AND (SELECT COUNT(*) FROM livestock_animals
           WHERE id IN (SELECT json_extract(work.value, '$.animalId') FROM input, json_each(input.payload, '$.workRows') AS work WHERE json_extract(work.value, '$.action') = 'create_animal'))
          = (SELECT json_extract(input.payload, '$.expected.createAnimalCount') FROM input)
      AND (SELECT COUNT(*) FROM livestock_lot_memberships
           WHERE id IN (SELECT json_extract(work.value, '$.membershipId') FROM input, json_each(input.payload, '$.workRows') AS work WHERE json_extract(work.value, '$.action') = 'create_animal'))
          = (SELECT json_extract(input.payload, '$.expected.createAnimalCount') FROM input)
      AND (SELECT COUNT(*) FROM livestock_animal_identifiers
           WHERE id IN (
             SELECT json_extract(target.value, '$.id')
             FROM input, json_each(input.payload, '$.workRows') AS work, json_each(work.value, '$.identifierTargets') AS target
             WHERE json_extract(target.value, '$.targetState') = 'insert'
           )) = (SELECT json_extract(input.payload, '$.expected.identifierInsertCount') FROM input)
      AND (SELECT COUNT(*) FROM source_records
           WHERE id IN (SELECT json_extract(work.value, '$.animalSourceId') FROM input, json_each(input.payload, '$.workRows') AS work))
          = (SELECT json_extract(input.payload, '$.expected.animalWorkRowCount') FROM input)
      AND (SELECT COUNT(*) FROM source_records
           WHERE id IN (
             SELECT json_extract(target.value, '$.sourceRecordId')
             FROM input, json_each(input.payload, '$.workRows') AS work, json_each(work.value, '$.identifierTargets') AS target
           )) = (SELECT json_extract(input.payload, '$.expected.identifierSourceCount') FROM input)
      AND (SELECT COUNT(*) FROM audit_log
           WHERE id IN (SELECT json_extract(work.value, '$.animalAuditId') FROM input, json_each(input.payload, '$.workRows') AS work))
          = (SELECT json_extract(input.payload, '$.expected.animalWorkRowCount') FROM input)
      AND (SELECT COUNT(*) FROM import_rows AS current_row
           WHERE current_row.id IN (SELECT json_extract(work.value, '$.importRowId') FROM input, json_each(input.payload, '$.workRows') AS work)
             AND current_row.status = 'imported'
             AND current_row.updated_at = (SELECT json_extract(input.payload, '$.now') FROM input)
             AND current_row.source_key IS (
               SELECT json_extract(work.value, '$.sourceKey')
               FROM input, json_each(input.payload, '$.workRows') AS work
               WHERE json_extract(work.value, '$.importRowId') = current_row.id
             )) = (SELECT json_extract(input.payload, '$.expected.workRowCount') FROM input)
      AND (SELECT COUNT(*) FROM livestock_lots AS current_lot
           WHERE current_lot.id IN (SELECT value FROM input, json_each(input.payload, '$.affectedLotIds'))
             AND current_lot.field_id = (SELECT json_extract(input.payload, '$.fieldId') FROM input)
             AND current_lot.animal_count = (SELECT COUNT(*) FROM livestock_animals AS animal WHERE animal.lot_id = current_lot.id AND animal.status = 'active'))
          = (SELECT json_extract(input.payload, '$.expected.affectedLotCount') FROM input)
      AND (
        (SELECT json_extract(input.payload, '$.quarantine.action') FROM input) = 'unused'
        OR (
          EXISTS (SELECT 1 FROM livestock_lots WHERE id = (SELECT json_extract(input.payload, '$.quarantine.id') FROM input))
          AND EXISTS (SELECT 1 FROM audit_log WHERE id = (SELECT json_extract(input.payload, '$.quarantine.auditId') FROM input))
        )
      )
      AND (
        (SELECT json_type(input.payload, '$.fieldIdentifier') FROM input) = 'null'
        OR (
          EXISTS (SELECT 1 FROM field_external_identifiers WHERE id = (SELECT json_extract(input.payload, '$.fieldIdentifier.id') FROM input))
          AND EXISTS (SELECT 1 FROM source_records WHERE id = (SELECT json_extract(input.payload, '$.fieldIdentifier.sourceRecordId') FROM input))
          AND EXISTS (SELECT 1 FROM audit_log WHERE id = (SELECT json_extract(input.payload, '$.fieldIdentifier.auditId') FROM input))
        )
      )
      AND EXISTS (
        SELECT 1 FROM import_jobs AS locked_job, input
        WHERE locked_job.id = json_extract(input.payload, '$.job.id')
          AND locked_job.status = 'importing'
          AND locked_job.failure_message = input.payload
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(confirmationId);
  const finalizeJob = client.prepare(`
    ${projectionInputCte}
    UPDATE import_jobs
    SET
      status = (SELECT json_extract(input.payload, '$.completedStatus') FROM input),
      is_dry_run = 0,
      confirmed_at = (SELECT json_extract(input.payload, '$.now') FROM input),
      completed_at = (SELECT json_extract(input.payload, '$.now') FROM input),
      failure_message = NULL,
      updated_at = (SELECT json_extract(input.payload, '$.now') FROM input)
    WHERE id = (SELECT json_extract(input.payload, '$.job.id') FROM input)
      AND status = 'importing'
      AND failure_message = (SELECT input.payload FROM input)
      AND ${projectionGuardExists}
  `).bind(confirmationId);
  const assertFinalized = client.prepare(`
    SELECT CASE WHEN changes() = 1
      AND EXISTS (
        SELECT 1 FROM import_jobs AS completed_job
        WHERE completed_job.id = ?
          AND completed_job.status = ?
          AND completed_job.is_dry_run = 0
          AND completed_job.confirmed_at = ?
          AND completed_job.completed_at = ?
          AND completed_job.failure_message IS NULL
          AND completed_job.updated_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM audit_log AS confirmation_audit
        WHERE confirmation_audit.id = ? AND confirmation_audit.after = ?
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(context.job.id, completedStatus, now, now, now, guardAuditId, guardAfterJson);
  const statements = [
    lockJob,
    confirmationGuard,
    ensureQuarantineLot,
    quarantineAudit,
    ensureFieldIdentifier,
    fieldIdentifierSource,
    fieldIdentifierAudit,
    createAnimals,
    createMemberships,
    createIdentifiers,
    animalSources,
    identifierSources,
    animalAudits,
    milkSources,
    createMilkControls,
    milkAudits,
    qualitySources,
    createQualitySamples,
    qualityAudits,
    updateImportRows,
    updateLotSummaries,
    assertComplete,
    finalizeJob,
    assertFinalized,
  ];
  const results = await client.batch(statements);
  if ((results[21].results[0] as { complete?: number } | undefined)?.complete !== 1
    || (results[23].results[0] as { complete?: number } | undefined)?.complete !== 1) throw staleProjectionError();
}

function staleProjectionError() {
  return new ImportProjectionError(
    "La identidad o pertenencia cambió después de la simulación. Recalcula el plan antes de confirmar nuevamente.",
    "IMPORT_PLAN_STALE",
  );
}

function projectionReadScope(access: ImportFieldAccess) {
  return and(
    eq(importJobs.sourceSystem, "cooprinsem"),
    eq(importJobs.organizationId, access.organizationId),
    eq(fields.organizationId, access.organizationId),
    inArray(importJobs.fieldId, access.fieldIds),
    inArray(fields.id, access.fieldIds),
  );
}

function projectionFieldScope(access: ImportFieldAccess) {
  return and(
    eq(fields.organizationId, access.organizationId),
    inArray(fields.id, access.fieldIds),
  );
}

function confirmationFromPlan(plan: CooprinsemImportProjectionPlan, confirmedAt: string, reused: boolean, status?: "completed" | "completed_with_errors"): CooprinsemImportConfirmation {
  const excludedRowCount = plan.summary.excludedRowCount + plan.summary.conflictRowCount;
  const laboratory = plan.sourceTable === "CalidadLeche.dbf";
  return {
    importJobId: plan.importJobId,
    status: status ?? (excludedRowCount > 0 ? "completed_with_errors" : "completed"),
    createdAnimalCount: reused ? 0 : plan.summary.createAnimalCount,
    linkedAnimalCount: laboratory ? 0 : reused ? plan.summary.alreadyImportedCount : plan.summary.linkAnimalCount,
    importedRowCount: plan.summary.alreadyImportedCount + (reused ? 0
      : plan.summary.createAnimalCount + plan.summary.linkAnimalCount + plan.summary.projectableMilkQualitySampleCount),
    excludedRowCount,
    identifierWriteCount: reused ? 0 : plan.summary.identifierWriteCount,
    importedMilkControlCount: plan.summary.alreadyImportedMilkControlCount + (reused ? 0 : plan.summary.projectableMilkControlCount),
    importedMilkQualitySampleCount: plan.summary.alreadyImportedMilkQualitySampleCount + (reused ? 0 : plan.summary.projectableMilkQualitySampleCount),
    confirmedAt,
    reused,
  };
}
