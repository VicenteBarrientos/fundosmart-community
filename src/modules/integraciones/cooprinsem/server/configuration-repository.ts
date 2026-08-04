import { getDb } from "@/db";
import {
  cooprinsemHistoryUnitContracts,
  importJobs,
  importRows,
  livestockAnimalIdentifiers,
  livestockAnimals,
  livestockBirthOffspring,
  livestockBirths,
  livestockLotExternalIdentifiers,
  livestockLotMemberships,
  livestockLots,
  livestockReproductiveEvents,
  sourceRecords,
} from "@/db/schema";
import { prepareIndividualLotSummaryUpdate } from "@/src/modules/ganado/server/livestock-repository";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type {
  CooprinsemConfigurationDashboard,
  CooprinsemGenealogyConfirmation,
  CooprinsemGenealogyPlan,
  CooprinsemGenealogyResolutionRow,
  CooprinsemGroupImpact,
  CooprinsemGroupMappingConfirmation,
  CooprinsemGroupMappingItem,
  CooprinsemGroupMappingPlan,
  CooprinsemHistoryServiceConfirmation,
  CooprinsemHistoryServicePlan,
  CooprinsemHistoryServicePlanRow,
  CooprinsemMilkUnitContractConfirmation,
  CooprinsemQuarantineAnimal,
  CooprinsemQuarantineReassignmentConfirmation,
  CooprinsemQuarantineReassignmentPlan,
  ImportRecord,
} from "../domain/types";
import {
  buildConfirmationToken,
  markDuplicateGenealogyCandidates,
  normalizeCooprinsemGroupCode,
  resolveGenealogyCandidate,
} from "./configuration-rules.mjs";
import {
  COOPRINSEM_QUARANTINE_LOT_NAME,
  deterministicProjectionId,
  normalizeExternalIdentifier,
  projectionQuarantineLotId,
} from "./projection-rules.mjs";
import {
  buildCooprinsemHistoryWorkset,
  COOPRINSEM_MILK_CANONICAL_UNIT,
  COOPRINSEM_MILK_SOURCE_FIELDS,
  COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
} from "./history-projection-rules.mjs";
import {
  currentCooprinsemActorFieldGuard,
  normalizeCooprinsemActorFieldAccess,
  type CooprinsemActorFieldAccess,
  type NormalizedCooprinsemActorFieldAccess,
} from "./current-actor-access";

const GROUP_KIND = "cooprinsem_grupo";
const PREVIEW_LIMIT = 50;
const MILK_UNIT_CONFIRMATION_PHRASE = "LECHE*=LITROS";
const HISTORY_SERVICES_CONFIRMATION_PHRASE = "CONFIRMAR CUBIERTAS";

type FieldScope = { fieldId: string; fieldName: string; organizationId: string };
export type ConfigurationFieldAccess = CooprinsemActorFieldAccess;
type GroupStats = { groupCode: string; normalizedGroupCode: string; impact: CooprinsemGroupImpact };
type GroupAnimalSource = CooprinsemQuarantineAnimal & {
  lotId: string;
  membership: typeof livestockLotMemberships.$inferSelect | null;
};
type ConfigurationContext = {
  scope: FieldScope;
  lots: Array<typeof livestockLots.$inferSelect>;
  mappings: Array<typeof livestockLotExternalIdentifiers.$inferSelect>;
  groupStats: Map<string, GroupStats>;
  sourcesByGroup: Map<string, Map<string, GroupAnimalSource>>;
  quarantineLotId: string;
  quarantineAnimalCount: number;
};
type ReassignmentContext = {
  plan: CooprinsemQuarantineReassignmentPlan;
  scope: FieldScope;
  mapping: typeof livestockLotExternalIdentifiers.$inferSelect | null;
  candidates: GroupAnimalSource[];
};
type GenealogySourceSnapshot = {
  record: typeof sourceRecords.$inferSelect;
  organizationId: string;
  fieldId: string;
  jobSourceSystem: string;
  jobSourceTable: string;
};
type GenealogyWorkRow = CooprinsemGenealogyResolutionRow & {
  offspringSnapshot: typeof livestockBirthOffspring.$inferSelect;
  birthSnapshot: typeof livestockBirths.$inferSelect;
  candidateSnapshot: typeof livestockAnimals.$inferSelect | null;
  sourceSnapshot: GenealogySourceSnapshot | null;
};
type HistorySource = {
  importJobId: string;
  importRowId: string;
  sourceTable: string;
  sourceKey: string | null;
};
type HistorySourceSnapshot = HistorySource & {
  originalSource: typeof sourceRecords.$inferSelect;
  importRow: typeof importRows.$inferSelect;
  importJob: typeof importJobs.$inferSelect;
};
type HistoryServiceWorkRow = CooprinsemHistoryServicePlanRow & {
  targetId: string | null;
  sources: HistorySourceSnapshot[];
  animalSnapshot: typeof livestockAnimals.$inferSelect | null;
  existingEvent: typeof livestockReproductiveEvents.$inferSelect | null;
};
type HistoryConfigurationContext = {
  scope: FieldScope;
  unitContract: typeof cooprinsemHistoryUnitContracts.$inferSelect | null;
  configuration: CooprinsemConfigurationDashboard["history"];
  serviceRows: HistoryServiceWorkRow[];
};

export class CooprinsemConfigurationError extends Error {
  constructor(message: string, public code = "COOPRINSEM_CONFIGURATION_INVALID") {
    super(message);
    this.name = "CooprinsemConfigurationError";
  }
}

export async function getCooprinsemConfiguration(
  input: ConfigurationFieldAccess & { fieldId: string },
): Promise<CooprinsemConfigurationDashboard | null> {
  const access = normalizeConfigurationAccess(input);
  if (!access) return null;
  const context = await loadConfigurationContext(input.fieldId, access);
  if (!context) return null;
  const [genealogy, historyContext] = await Promise.all([
    buildGenealogyPlan(context.scope, access.membershipId),
    buildHistoryConfigurationContext(context.scope, access.membershipId),
  ]);
  const currentScope = await resolveFieldScope(input.fieldId, access);
  if (!sameFieldScope(context.scope, currentScope)) return null;
  const lotNameById = new Map(context.lots.map((lot) => [lot.id, lot.name]));
  const mappedGroups = new Set(context.mappings.map((mapping) => mapping.normalizedValue));
  return {
    fieldId: context.scope.fieldId,
    fieldName: context.scope.fieldName,
    lots: context.lots
      .filter((lot) => lot.status === "active" && lot.trackingMode === "individual" && lot.id !== context.quarantineLotId)
      .map((lot) => ({ id: lot.id, name: lot.name, animalCount: lot.animalCount, trackingMode: lot.trackingMode }))
      .sort((left, right) => left.name.localeCompare(right.name, "es")),
    mappings: context.mappings
      .map((mapping) => mappingItem(mapping, lotNameById.get(mapping.lotId) ?? "Lote no disponible", impactFor(context, mapping.normalizedValue)))
      .sort((left, right) => left.groupCode.localeCompare(right.groupCode, "es", { numeric: true })),
    unconfiguredGroups: [...context.groupStats.values()]
      .filter((entry) => !mappedGroups.has(entry.normalizedGroupCode))
      .sort((left, right) => right.impact.quarantineAnimalCount - left.impact.quarantineAnimalCount || right.impact.stagedRowCount - left.impact.stagedRowCount),
    quarantine: {
      lotId: context.quarantineLotId,
      lotName: lotNameById.get(context.quarantineLotId) ?? COOPRINSEM_QUARANTINE_LOT_NAME,
      animalCount: context.quarantineAnimalCount,
    },
    genealogy,
    history: historyContext.configuration,
  };
}

export async function confirmCooprinsemMilkUnitContract(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  confirmation: string;
  phrase: string;
}): Promise<CooprinsemMilkUnitContractConfirmation> {
  const actorAccess = requireConfigurationAccess(input);
  if (input.phrase !== MILK_UNIT_CONFIRMATION_PHRASE) {
    throw new CooprinsemConfigurationError(
      `Escribe exactamente ${MILK_UNIT_CONFIRMATION_PHRASE} para confirmar el contrato de unidad.`,
      "MILK_UNIT_PHRASE_MISMATCH",
    );
  }
  const scope = await resolveFieldScope(input.fieldId, input);
  if (!scope) throw new CooprinsemConfigurationError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND");
  const context = await buildHistoryConfigurationContext(scope, actorAccess.membershipId);
  if (!sameFieldScope(scope, await resolveFieldScope(input.fieldId, input))) throw stalePlanError();
  const plan = context.configuration.milkUnitContract;
  if (plan.confirmationToken !== input.confirmation) throw stalePlanError();
  if (context.unitContract) {
    return { action: "reused", contractId: context.unitContract.id, confirmedAt: context.unitContract.confirmedAt };
  }

  const now = new Date().toISOString();
  const contractId = deterministicProjectionId("history-unit-contract", [input.fieldId, COOPRINSEM_MILK_UNIT_CONTRACT_VERSION]);
  const auditId = deterministicProjectionId("audit", [contractId, "confirmed"]);
  const sourceFields = JSON.stringify(COOPRINSEM_MILK_SOURCE_FIELDS);
  const evidenceSha256 = confirmationDigest(plan.confirmationToken);
  const after = JSON.stringify({
    contractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
    canonicalUnit: COOPRINSEM_MILK_CANONICAL_UNIT,
    sourceFields: COOPRINSEM_MILK_SOURCE_FIELDS,
    evidenceSha256,
  });
  const client = getDb().$client;
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", actorAccess);
  const insertContract = client.prepare(`
      INSERT INTO cooprinsem_history_unit_contracts (
        id, organization_id, field_id, source_system, contract_version, canonical_unit,
        source_fields, evidence_sha256, confirmed_by, confirmed_at, created_at
      )
      SELECT ?, ?, ?, 'cooprinsem', ?, 'liters', ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = ?
          AND ${actorGuard.sql}
      )
        AND NOT EXISTS (
          SELECT 1 FROM cooprinsem_history_unit_contracts AS existing_contract
          WHERE existing_contract.id = ?
             OR (existing_contract.field_id = ? AND existing_contract.contract_version = ?)
        )
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(
    contractId,
    scope.organizationId,
    input.fieldId,
    COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
    sourceFields,
    evidenceSha256,
    actorAccess.actorEmail,
    now,
    now,
    input.fieldId,
    ...actorGuard.bindings,
    contractId,
    input.fieldId,
    COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
    auditId,
  );
  const insertAudit = client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id,
        before, after, source_record_id, occurred_at
      )
      SELECT ?, ?, ?, ?, 'import.history.milk_unit.confirmed', 'cooprinsem_history_unit_contract', ?,
        NULL, ?, NULL, ?
      WHERE changes() = 1
        AND EXISTS (
          SELECT 1 FROM fields AS current_field
          WHERE current_field.id = ? AND current_field.organization_id = ?
        )
        AND EXISTS (
          SELECT 1 FROM cooprinsem_history_unit_contracts AS created_contract
          WHERE created_contract.id = ?
            AND created_contract.organization_id = ?
            AND created_contract.field_id = ?
            AND created_contract.source_system = 'cooprinsem'
            AND created_contract.contract_version = ?
            AND created_contract.canonical_unit = 'liters'
            AND created_contract.source_fields = ?
            AND created_contract.evidence_sha256 = ?
            AND created_contract.confirmed_by = ?
            AND created_contract.confirmed_at = ?
            AND created_contract.created_at = ?
        )
    `).bind(
    auditId,
    scope.organizationId,
    input.fieldId,
    actorAccess.actorEmail,
    contractId,
    after,
    now,
    input.fieldId,
    scope.organizationId,
    contractId,
    scope.organizationId,
    input.fieldId,
    COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
    sourceFields,
    evidenceSha256,
    actorAccess.actorEmail,
    now,
    now,
  );
  const assertComplete = client.prepare(`
    SELECT CASE WHEN
      EXISTS (
        SELECT 1 FROM cooprinsem_history_unit_contracts AS created_contract
        WHERE created_contract.id = ?
          AND created_contract.organization_id = ?
          AND created_contract.field_id = ?
          AND created_contract.source_system = 'cooprinsem'
          AND created_contract.contract_version = ?
          AND created_contract.canonical_unit = 'liters'
          AND created_contract.source_fields = ?
          AND created_contract.evidence_sha256 = ?
          AND created_contract.confirmed_by = ?
          AND created_contract.confirmed_at = ?
          AND created_contract.created_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM audit_log AS confirmation_audit
        WHERE confirmation_audit.id = ?
          AND confirmation_audit.organization_id = ?
          AND confirmation_audit.field_id = ?
          AND confirmation_audit.actor = ?
          AND confirmation_audit.action = 'import.history.milk_unit.confirmed'
          AND confirmation_audit.entity_type = 'cooprinsem_history_unit_contract'
          AND confirmation_audit.entity_id = ?
          AND confirmation_audit.before IS NULL
          AND confirmation_audit.after = ?
          AND confirmation_audit.source_record_id IS NULL
          AND confirmation_audit.occurred_at = ?
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    contractId,
    scope.organizationId,
    input.fieldId,
    COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
    sourceFields,
    evidenceSha256,
    actorAccess.actorEmail,
    now,
    now,
    auditId,
    scope.organizationId,
    input.fieldId,
    actorAccess.actorEmail,
    contractId,
    after,
    now,
  );
  try {
    const results = await client.batch([insertContract, insertAudit, assertComplete]);
    if ((results[2].results[0] as { complete?: number } | undefined)?.complete !== 1) throw stalePlanError();
  } catch (cause) {
    if (cause instanceof CooprinsemConfigurationError) throw cause;
    if (cause instanceof Error && /(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|integer overflow)/i.test(cause.message)) throw stalePlanError();
    throw cause;
  }
  return { action: "created", contractId, confirmedAt: now };
}

export async function confirmCooprinsemHistoryServices(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  confirmation: string;
  phrase: string;
}): Promise<CooprinsemHistoryServiceConfirmation> {
  const actorAccess = requireConfigurationAccess(input);
  if (input.phrase !== HISTORY_SERVICES_CONFIRMATION_PHRASE) {
    throw new CooprinsemConfigurationError(
      `Escribe exactamente ${HISTORY_SERVICES_CONFIRMATION_PHRASE} para confirmar las cubiertas.`,
      "HISTORY_SERVICES_PHRASE_MISMATCH",
    );
  }
  const scope = await resolveFieldScope(input.fieldId, input);
  if (!scope) throw new CooprinsemConfigurationError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND");
  const context = await buildHistoryConfigurationContext(scope, actorAccess.membershipId);
  if (!sameFieldScope(scope, await resolveFieldScope(input.fieldId, input))) throw stalePlanError();
  const plan = context.configuration.services;
  if (plan.confirmationToken !== input.confirmation) throw stalePlanError();
  const readyRows = context.serviceRows.filter((row) => row.state === "ready" && row.targetId);
  if (readyRows.length === 0) {
    throw new CooprinsemConfigurationError("No hay cubiertas inequívocas listas para confirmar.", "HISTORY_SERVICES_NOT_READY");
  }

  const now = new Date().toISOString();
  const client = getDb().$client;
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", actorAccess);
  const services = readyRows.map((row) => {
    const targetId = row.targetId as string;
    const animal = row.animalSnapshot;
    const primary = row.sources[0];
    if (!animal || !primary || !row.occurredAt) throw stalePlanError();
    const existing = row.existingEvent;
    const primarySourceRecordId = historySourceRecordId(primary, targetId);
    return {
      fieldId: scope.fieldId,
      organizationId: scope.organizationId,
      targetId,
      action: row.action,
      animalId: animal.id,
      animalLotId: animal.lotId,
      animalTag: animal.tag,
      animalSex: animal.sex,
      animalStatus: animal.status,
      animalStatusDate: animal.statusDate,
      animalStatusReason: animal.statusReason,
      animalBirthDate: animal.birthDate,
      animalPurchasePriceClp: animal.purchasePriceClp,
      animalPurchaseDate: animal.purchaseDate,
      animalOrigin: animal.origin,
      animalNotes: animal.notes,
      animalSource: animal.source,
      animalCreatedAt: animal.createdAt,
      animalUpdatedAt: animal.updatedAt,
      occurredAt: row.occurredAt,
      sireIdentifier: row.sireIdentifier,
      normalizedSire: normalizeHistorySire(row.sireIdentifier),
      metadata: JSON.stringify({ cooprinsemRoles: row.roles, confirmationFormat: plan.format }),
      sourceCount: row.sources.length,
      primarySourceRecordId,
      linkExistingSource: Boolean(existing && existing.source === "Cooprinsem" && existing.sourceRecordId === null),
      existingId: existing?.id ?? null,
      existingFieldId: existing?.fieldId ?? null,
      existingAnimalId: existing?.animalId ?? null,
      existingEventType: existing?.eventType ?? null,
      existingOccurredAt: existing?.occurredAt ?? null,
      existingMethod: existing?.method ?? null,
      existingResult: existing?.result ?? null,
      existingSireIdentifier: existing?.sireIdentifier ?? null,
      existingNotes: existing?.notes ?? null,
      existingMetadata: existing ? JSON.stringify(existing.metadata) : null,
      existingSource: existing?.source ?? null,
      existingSourceRecordId: existing?.sourceRecordId ?? null,
      existingCreatedBy: existing?.createdBy ?? null,
      existingCreatedAt: existing?.createdAt ?? null,
      existingUpdatedAt: existing?.updatedAt ?? null,
      auditId: deterministicProjectionId("audit", [targetId, "history-service-confirmed"]),
      before: existing ? JSON.stringify(existing) : null,
      after: JSON.stringify({
        animalId: row.animalId,
        eventType: "service",
        occurredAt: row.occurredAt,
        sireIdentifier: row.sireIdentifier,
        sourceCount: row.sources.length,
      }),
    };
  });
  const sourceLinks = readyRows.flatMap((row) => {
    const targetId = row.targetId as string;
    return row.sources.map((source) => ({
      id: historySourceRecordId(source, targetId),
      targetId,
      animalId: row.animalId,
      importJobId: source.importJobId,
      importRowId: source.importRowId,
      sourceTable: source.sourceTable,
      sourceKey: source.sourceKey,
      originalSourceId: source.originalSource.id,
      originalSourceSystem: source.originalSource.sourceSystem,
      originalSourceTable: source.originalSource.sourceTable,
      originalSourceKey: source.originalSource.sourceKey,
      originalSourceTargetEntity: source.originalSource.targetEntity,
      originalSourceTargetId: source.originalSource.targetId,
      originalSourceCreatedAt: source.originalSource.createdAt,
      importRowRecordNumber: source.importRow.recordNumber,
      importRowSourceKey: source.importRow.sourceKey,
      importRowRawRecord: JSON.stringify(source.importRow.rawRecord),
      importRowNormalizedRecord: source.importRow.normalizedRecord ? JSON.stringify(source.importRow.normalizedRecord) : null,
      importRowStatus: source.importRow.status,
      importRowWarningCount: source.importRow.warningCount,
      importRowErrorCount: source.importRow.errorCount,
      importRowCreatedAt: source.importRow.createdAt,
      importRowUpdatedAt: source.importRow.updatedAt,
      importJobOrganizationId: source.importJob.organizationId,
      importJobFieldId: source.importJob.fieldId,
      importJobSourceSystem: source.importJob.sourceSystem,
      importJobSourceTable: source.importJob.sourceTable,
      importJobEffectiveAt: source.importJob.effectiveAt,
      importJobStatus: source.importJob.status,
      importJobSha256: source.importJob.sha256,
      importJobMappingVersion: source.importJob.mappingVersion,
      importJobUpdatedAt: source.importJob.updatedAt,
    }));
  });
  const servicePayload = JSON.stringify(services);
  const sourcePayload = JSON.stringify(sourceLinks);
  const serviceCount = services.length;
  const sourceLinkCount = sourceLinks.length;
  const createCount = services.filter((service) => service.action === "create").length;
  const reuseLinkCount = services.filter((service) => service.linkExistingSource).length;
  const sourceGuards = client.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table, source_key,
      target_entity, target_id, created_at
    )
    SELECT
      json_extract(source.value, '$.id'),
      json_extract(source.value, '$.importJobId'),
      json_extract(source.value, '$.importRowId'),
      'cooprinsem',
      json_extract(source.value, '$.sourceTable'),
      json_extract(source.value, '$.sourceKey'),
      'livestock_reproductive_event',
      json_extract(source.value, '$.targetId'),
      ?
    FROM json_each(?) AS source
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each(?) AS invalid_service
      WHERE NOT EXISTS (
        SELECT 1 FROM fields AS current_field
        WHERE current_field.id = json_extract(invalid_service.value, '$.fieldId')
          AND current_field.organization_id = json_extract(invalid_service.value, '$.organizationId')
          AND ${actorGuard.sql}
      )
        OR NOT EXISTS (
          SELECT 1
          FROM livestock_animals AS current_animal
          INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id
          WHERE current_animal.id = json_extract(invalid_service.value, '$.animalId')
            AND current_animal.lot_id = json_extract(invalid_service.value, '$.animalLotId')
            AND current_lot.field_id = json_extract(invalid_service.value, '$.fieldId')
            AND current_animal.tag = json_extract(invalid_service.value, '$.animalTag')
            AND current_animal.sex = json_extract(invalid_service.value, '$.animalSex')
            AND current_animal.status = json_extract(invalid_service.value, '$.animalStatus')
            AND current_animal.status_date IS json_extract(invalid_service.value, '$.animalStatusDate')
            AND current_animal.status_reason IS json_extract(invalid_service.value, '$.animalStatusReason')
            AND current_animal.birth_date IS json_extract(invalid_service.value, '$.animalBirthDate')
            AND current_animal.purchase_price_clp IS json_extract(invalid_service.value, '$.animalPurchasePriceClp')
            AND current_animal.purchase_date IS json_extract(invalid_service.value, '$.animalPurchaseDate')
            AND current_animal.origin IS json_extract(invalid_service.value, '$.animalOrigin')
            AND current_animal.notes = json_extract(invalid_service.value, '$.animalNotes')
            AND current_animal.source = json_extract(invalid_service.value, '$.animalSource')
            AND current_animal.created_at = json_extract(invalid_service.value, '$.animalCreatedAt')
            AND current_animal.updated_at = json_extract(invalid_service.value, '$.animalUpdatedAt')
        )
        OR json_extract(invalid_service.value, '$.animalSex') = 'male'
        OR json_extract(invalid_service.value, '$.occurredAt') IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM json_each(?) AS expected_source
          WHERE json_extract(expected_source.value, '$.id') = json_extract(invalid_service.value, '$.primarySourceRecordId')
            AND json_extract(expected_source.value, '$.targetId') = json_extract(invalid_service.value, '$.targetId')
        )
        OR (SELECT COUNT(*) FROM json_each(?) AS expected_source
            WHERE json_extract(expected_source.value, '$.targetId') = json_extract(invalid_service.value, '$.targetId'))
          <> json_extract(invalid_service.value, '$.sourceCount')
        OR (
          json_extract(invalid_service.value, '$.action') = 'create'
          AND (
            json_extract(invalid_service.value, '$.existingId') IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM livestock_reproductive_events AS occupied_id
              WHERE occupied_id.id = json_extract(invalid_service.value, '$.targetId')
            )
            OR EXISTS (
              SELECT 1 FROM livestock_reproductive_events AS competing_event
              WHERE competing_event.animal_id = json_extract(invalid_service.value, '$.animalId')
                AND competing_event.occurred_at = json_extract(invalid_service.value, '$.occurredAt')
                AND competing_event.event_type IN ('service', 'insemination')
            )
          )
        )
        OR (
          json_extract(invalid_service.value, '$.action') = 'reuse'
          AND (
            NOT EXISTS (
              SELECT 1 FROM livestock_reproductive_events AS current_event
              WHERE current_event.id = json_extract(invalid_service.value, '$.existingId')
                AND current_event.id = json_extract(invalid_service.value, '$.targetId')
                AND current_event.field_id = json_extract(invalid_service.value, '$.existingFieldId')
                AND current_event.field_id = json_extract(invalid_service.value, '$.fieldId')
                AND current_event.animal_id = json_extract(invalid_service.value, '$.existingAnimalId')
                AND current_event.animal_id = json_extract(invalid_service.value, '$.animalId')
                AND current_event.event_type = json_extract(invalid_service.value, '$.existingEventType')
                AND current_event.event_type = 'service'
                AND current_event.occurred_at = json_extract(invalid_service.value, '$.existingOccurredAt')
                AND current_event.occurred_at = json_extract(invalid_service.value, '$.occurredAt')
                AND current_event.method IS json_extract(invalid_service.value, '$.existingMethod')
                AND current_event.result IS json_extract(invalid_service.value, '$.existingResult')
                AND current_event.sire_identifier IS json_extract(invalid_service.value, '$.existingSireIdentifier')
                AND current_event.notes = json_extract(invalid_service.value, '$.existingNotes')
                AND current_event.metadata = json_extract(invalid_service.value, '$.existingMetadata')
                AND current_event.source = json_extract(invalid_service.value, '$.existingSource')
                AND current_event.source_record_id IS json_extract(invalid_service.value, '$.existingSourceRecordId')
                AND current_event.created_by = json_extract(invalid_service.value, '$.existingCreatedBy')
                AND current_event.created_at = json_extract(invalid_service.value, '$.existingCreatedAt')
                AND current_event.updated_at = json_extract(invalid_service.value, '$.existingUpdatedAt')
            )
            OR (SELECT COUNT(*) FROM livestock_reproductive_events AS equivalent_event
                WHERE equivalent_event.animal_id = json_extract(invalid_service.value, '$.animalId')
                  AND equivalent_event.occurred_at = json_extract(invalid_service.value, '$.occurredAt')
                  AND equivalent_event.event_type IN ('service', 'insemination')) <> 1
          )
        )
        OR EXISTS (
          SELECT 1 FROM audit_log AS occupied_audit
          WHERE occupied_audit.id = json_extract(invalid_service.value, '$.auditId')
        )
    )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS invalid_source
        WHERE EXISTS (
          SELECT 1 FROM source_records AS occupied_source
          WHERE occupied_source.id = json_extract(invalid_source.value, '$.id')
        )
          OR NOT EXISTS (
            SELECT 1 FROM json_each(?) AS parent_service
            WHERE json_extract(parent_service.value, '$.targetId') = json_extract(invalid_source.value, '$.targetId')
              AND json_extract(parent_service.value, '$.animalId') = json_extract(invalid_source.value, '$.animalId')
              AND json_extract(parent_service.value, '$.fieldId') = json_extract(invalid_source.value, '$.importJobFieldId')
              AND json_extract(parent_service.value, '$.organizationId') = json_extract(invalid_source.value, '$.importJobOrganizationId')
          )
          OR NOT EXISTS (
            SELECT 1
            FROM source_records AS original_source
            INNER JOIN import_rows AS current_row
              ON current_row.id = original_source.import_row_id
              AND current_row.import_job_id = original_source.import_job_id
            INNER JOIN import_jobs AS current_job ON current_job.id = original_source.import_job_id
            WHERE original_source.id = json_extract(invalid_source.value, '$.originalSourceId')
              AND original_source.import_job_id = json_extract(invalid_source.value, '$.importJobId')
              AND original_source.import_row_id = json_extract(invalid_source.value, '$.importRowId')
              AND original_source.source_system = json_extract(invalid_source.value, '$.originalSourceSystem')
              AND original_source.source_table = json_extract(invalid_source.value, '$.originalSourceTable')
              AND original_source.source_key IS json_extract(invalid_source.value, '$.originalSourceKey')
              AND original_source.target_entity = json_extract(invalid_source.value, '$.originalSourceTargetEntity')
              AND original_source.target_entity = 'livestock_animal'
              AND original_source.target_id = json_extract(invalid_source.value, '$.originalSourceTargetId')
              AND original_source.target_id = json_extract(invalid_source.value, '$.animalId')
              AND original_source.created_at = json_extract(invalid_source.value, '$.originalSourceCreatedAt')
              AND current_row.record_number = json_extract(invalid_source.value, '$.importRowRecordNumber')
              AND current_row.source_key IS json_extract(invalid_source.value, '$.importRowSourceKey')
              AND current_row.raw_record = json_extract(invalid_source.value, '$.importRowRawRecord')
              AND current_row.normalized_record IS json_extract(invalid_source.value, '$.importRowNormalizedRecord')
              AND current_row.status = json_extract(invalid_source.value, '$.importRowStatus')
              AND current_row.warning_count = json_extract(invalid_source.value, '$.importRowWarningCount')
              AND current_row.error_count = json_extract(invalid_source.value, '$.importRowErrorCount')
              AND current_row.created_at = json_extract(invalid_source.value, '$.importRowCreatedAt')
              AND current_row.updated_at = json_extract(invalid_source.value, '$.importRowUpdatedAt')
              AND current_job.organization_id = json_extract(invalid_source.value, '$.importJobOrganizationId')
              AND current_job.field_id = json_extract(invalid_source.value, '$.importJobFieldId')
              AND current_job.source_system = json_extract(invalid_source.value, '$.importJobSourceSystem')
              AND current_job.source_table = json_extract(invalid_source.value, '$.importJobSourceTable')
              AND current_job.effective_at IS json_extract(invalid_source.value, '$.importJobEffectiveAt')
              AND current_job.status = json_extract(invalid_source.value, '$.importJobStatus')
              AND current_job.sha256 = json_extract(invalid_source.value, '$.importJobSha256')
              AND current_job.mapping_version = json_extract(invalid_source.value, '$.importJobMappingVersion')
              AND current_job.updated_at = json_extract(invalid_source.value, '$.importJobUpdatedAt')
          )
      )
  `).bind(
    now,
    sourcePayload,
    servicePayload,
    ...actorGuard.bindings,
    sourcePayload,
    sourcePayload,
    sourcePayload,
    servicePayload,
  );
  const createEvents = client.prepare(`
    INSERT INTO livestock_reproductive_events (
      id, field_id, animal_id, event_type, occurred_at, method, result, sire_identifier,
      notes, metadata, source, source_record_id, created_by, created_at, updated_at
    )
    SELECT
      json_extract(service.value, '$.targetId'),
      json_extract(service.value, '$.fieldId'),
      json_extract(service.value, '$.animalId'),
      'service',
      json_extract(service.value, '$.occurredAt'),
      'Cubierta histórica',
      NULL,
      json_extract(service.value, '$.sireIdentifier'),
      '',
      json_extract(service.value, '$.metadata'),
      'Cooprinsem',
      json_extract(service.value, '$.primarySourceRecordId'),
      ?,
      ?,
      ?
    FROM json_each(?) AS service
    WHERE json_extract(service.value, '$.action') = 'create'
      AND (SELECT COUNT(*) FROM source_records AS saved_source
           WHERE saved_source.id IN (
             SELECT json_extract(source.value, '$.id') FROM json_each(?) AS source
             WHERE json_extract(source.value, '$.targetId') = json_extract(service.value, '$.targetId')
           )) = json_extract(service.value, '$.sourceCount')
  `).bind(actorAccess.actorEmail, now, now, servicePayload, sourcePayload);
  const linkReusedEvents = client.prepare(`
    UPDATE livestock_reproductive_events
    SET
      source_record_id = (
        SELECT json_extract(service.value, '$.primarySourceRecordId')
        FROM json_each(?) AS service
        WHERE json_extract(service.value, '$.targetId') = livestock_reproductive_events.id
      ),
      updated_at = ?
    WHERE id IN (
      SELECT json_extract(service.value, '$.targetId') FROM json_each(?) AS service
      WHERE json_extract(service.value, '$.action') = 'reuse'
        AND json_extract(service.value, '$.linkExistingSource') = 1
        AND EXISTS (
          SELECT 1 FROM source_records AS primary_source
          WHERE primary_source.id = json_extract(service.value, '$.primarySourceRecordId')
        )
    )
      AND source = 'Cooprinsem'
      AND source_record_id IS NULL
  `).bind(servicePayload, now, servicePayload);
  const serviceAudits = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(service.value, '$.auditId'),
      json_extract(service.value, '$.organizationId'),
      json_extract(service.value, '$.fieldId'),
      ?,
      CASE WHEN json_extract(service.value, '$.action') = 'reuse'
        THEN 'import.history.service.reused' ELSE 'import.history.service.created' END,
      'livestock_reproductive_event',
      json_extract(service.value, '$.targetId'),
      json_extract(service.value, '$.before'),
      json_extract(service.value, '$.after'),
      json_extract(service.value, '$.primarySourceRecordId'),
      ?
    FROM json_each(?) AS service
    WHERE EXISTS (
      SELECT 1 FROM livestock_reproductive_events AS saved_event
      WHERE saved_event.id = json_extract(service.value, '$.targetId')
        AND saved_event.field_id = json_extract(service.value, '$.fieldId')
        AND saved_event.animal_id = json_extract(service.value, '$.animalId')
        AND saved_event.event_type = 'service'
        AND saved_event.occurred_at = json_extract(service.value, '$.occurredAt')
        AND lower(trim(COALESCE(saved_event.sire_identifier, ''))) = lower(json_extract(service.value, '$.normalizedSire'))
    )
      AND (SELECT COUNT(*) FROM source_records AS saved_source
           WHERE saved_source.id IN (
             SELECT json_extract(source.value, '$.id') FROM json_each(?) AS source
             WHERE json_extract(source.value, '$.targetId') = json_extract(service.value, '$.targetId')
           )) = json_extract(service.value, '$.sourceCount')
  `).bind(actorAccess.actorEmail, now, servicePayload, sourcePayload);
  const assertComplete = client.prepare(`
    SELECT CASE WHEN
      (SELECT COUNT(*) FROM source_records AS saved_source
       WHERE saved_source.id IN (
         SELECT json_extract(source.value, '$.id') FROM json_each(?) AS source
       )) = ?
      AND (SELECT COUNT(*) FROM json_each(?) AS service
       WHERE EXISTS (
         SELECT 1 FROM livestock_reproductive_events AS saved_event
         WHERE saved_event.id = json_extract(service.value, '$.targetId')
           AND saved_event.field_id = json_extract(service.value, '$.fieldId')
           AND saved_event.animal_id = json_extract(service.value, '$.animalId')
           AND saved_event.event_type = 'service'
           AND saved_event.occurred_at = json_extract(service.value, '$.occurredAt')
           AND lower(trim(COALESCE(saved_event.sire_identifier, ''))) = lower(json_extract(service.value, '$.normalizedSire'))
       )) = ?
      AND (SELECT COUNT(*) FROM audit_log AS saved_audit
       WHERE saved_audit.id IN (
         SELECT json_extract(service.value, '$.auditId') FROM json_each(?) AS service
       ) AND saved_audit.actor = ? AND saved_audit.occurred_at = ?) = ?
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(sourcePayload, sourceLinkCount, servicePayload, serviceCount, servicePayload, actorAccess.actorEmail, now, serviceCount);
  try {
    const results = await client.batch([sourceGuards, createEvents, linkReusedEvents, serviceAudits, assertComplete]);
    if (results[0].meta.changes !== sourceLinkCount
      || results[1].meta.changes !== createCount
      || results[2].meta.changes !== reuseLinkCount
      || results[3].meta.changes !== serviceCount
      || (results[4].results[0] as { complete?: number } | undefined)?.complete !== 1) throw stalePlanError();
  } catch (cause) {
    if (cause instanceof CooprinsemConfigurationError) throw cause;
    if (cause instanceof Error && /(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|integer overflow)/i.test(cause.message)) throw stalePlanError();
    throw cause;
  }
  return {
    confirmedServiceCount: serviceCount,
    createdServiceCount: createCount,
    reusedServiceCount: serviceCount - createCount,
    sourceLinkCount,
    confirmedAt: now,
  };
}

export async function simulateGroupMapping(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  groupCode: string;
  lotId: string | null;
  deactivate?: boolean;
}): Promise<CooprinsemGroupMappingPlan> {
  const context = await loadConfigurationContext(input.fieldId, input);
  if (!context) throw new CooprinsemConfigurationError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND");
  const groupCode = input.groupCode.trim();
  if (!groupCode) throw new CooprinsemConfigurationError("Ingresa el código de grupo Cooprinsem.", "GROUP_CODE_REQUIRED");
  const normalizedGroupCode = normalizeCooprinsemGroupCode(groupCode);
  const current = context.mappings.find((mapping) => mapping.normalizedValue === normalizedGroupCode) ?? null;
  const target = input.deactivate ? null : context.lots.find((lot) => lot.id === input.lotId) ?? null;
  const blockers: string[] = [];
  if (!input.deactivate && (!target || target.status !== "active" || target.trackingMode !== "individual" || target.id === context.quarantineLotId)) {
    blockers.push("El lote de destino debe estar activo, usar seguimiento individual y no ser el lote técnico.");
  }
  if (input.deactivate && !current) blockers.push("El grupo ya no tiene un mapeo activo.");
  const action = input.deactivate ? (current ? "deactivate" : "noop") : current?.lotId === target?.id ? "noop" : current ? "change" : "create";
  if (action === "noop" && !input.deactivate) blockers.push("El grupo ya está configurado en ese lote.");
  const lotNameById = new Map(context.lots.map((lot) => [lot.id, lot.name]));
  const currentMapping = current ? mappingItem(current, lotNameById.get(current.lotId) ?? "Lote no disponible", impactFor(context, normalizedGroupCode)) : null;
  const confirmationToken = await buildConfirmationToken("group-mapping", {
    fieldId: input.fieldId,
    membershipId: input.membershipId,
    normalizedGroupCode,
    currentMappingId: current?.id ?? null,
    currentLotId: current?.lotId ?? null,
    targetLotId: target?.id ?? null,
    action,
  });
  if (!sameFieldScope(context.scope, await resolveFieldScope(input.fieldId, input))) throw stalePlanError();
  return {
    fieldId: context.scope.fieldId,
    fieldName: context.scope.fieldName,
    action,
    groupCode: current?.value ?? groupCode,
    normalizedGroupCode,
    currentMapping,
    targetLot: target ? { id: target.id, name: target.name } : null,
    impact: impactFor(context, normalizedGroupCode),
    ready: blockers.length === 0 && action !== "noop",
    blockers,
    confirmationToken,
  };
}

export async function confirmGroupMapping(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  groupCode: string;
  lotId: string | null;
  deactivate?: boolean;
  confirmation: string;
}): Promise<CooprinsemGroupMappingConfirmation> {
  const actorAccess = requireConfigurationAccess(input);
  const plan = await simulateGroupMapping(input);
  if (plan.confirmationToken !== input.confirmation) throw stalePlanError();
  if (plan.action === "noop") {
    const currentScope = await resolveFieldScope(input.fieldId, input);
    if (!currentScope || currentScope.fieldName !== plan.fieldName) throw stalePlanError();
    return { action: "reused", mappingId: plan.currentMapping?.id ?? null, confirmedAt: new Date().toISOString() };
  }
  if (!plan.ready) throw new CooprinsemConfigurationError(plan.blockers[0] ?? "El mapeo no está listo para confirmar.", "GROUP_MAPPING_NOT_READY");
  const db = getDb();
  const now = new Date().toISOString();
  const [scope, currentRows] = await Promise.all([
    resolveFieldScope(input.fieldId, input),
    db.select().from(livestockLotExternalIdentifiers).where(and(
      eq(livestockLotExternalIdentifiers.fieldId, input.fieldId),
      eq(livestockLotExternalIdentifiers.sourceSystem, "cooprinsem"),
      eq(livestockLotExternalIdentifiers.kind, GROUP_KIND),
      eq(livestockLotExternalIdentifiers.normalizedValue, plan.normalizedGroupCode),
      isNull(livestockLotExternalIdentifiers.validTo),
    )).limit(1),
  ]);
  if (!scope) throw new CooprinsemConfigurationError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND");
  const current = currentRows[0] ?? null;
  const expectedCurrent = plan.currentMapping;
  if (
    (expectedCurrent?.id ?? null) !== (current?.id ?? null)
    || (expectedCurrent && current && (
      expectedCurrent.groupCode !== current.value
      || expectedCurrent.normalizedGroupCode !== current.normalizedValue
      || expectedCurrent.lotId !== current.lotId
      || expectedCurrent.validFrom !== current.validFrom
    ))
  ) throw stalePlanError();

  const client = db.$client;
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", actorAccess);
  const snapshotPredicate = current ? `
    EXISTS (
      SELECT 1 FROM livestock_lot_external_identifiers AS current_mapping
      WHERE current_mapping.id = ?
        AND current_mapping.field_id = ?
        AND current_mapping.lot_id = ?
        AND current_mapping.source_system = ?
        AND current_mapping.kind = ?
        AND current_mapping.value = ?
        AND current_mapping.normalized_value = ?
        AND current_mapping.valid_from IS ?
        AND current_mapping.valid_to IS ?
        AND current_mapping.created_at = ?
        AND current_mapping.updated_at = ?
    )
  ` : `
    NOT EXISTS (
      SELECT 1 FROM livestock_lot_external_identifiers AS current_mapping
      WHERE current_mapping.field_id = ?
        AND current_mapping.source_system = ?
        AND current_mapping.kind = ?
        AND current_mapping.normalized_value = ?
        AND current_mapping.valid_to IS NULL
    )
  `;
  const snapshotBindings = current ? [
    current.id,
    current.fieldId,
    current.lotId,
    current.sourceSystem,
    current.kind,
    current.value,
    current.normalizedValue,
    current.validFrom,
    current.validTo,
    current.createdAt,
    current.updatedAt,
  ] : [input.fieldId, "cooprinsem", GROUP_KIND, plan.normalizedGroupCode];
  const prepareAuditGuard = (guard: {
    auditId: string;
    action: string;
    entityId: string;
    before: string | null;
    after: string;
    targetLotId?: string;
    mappingId?: string;
  }) => {
    const auditGuardSql = `
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT ?, current_field.organization_id, ?, ?, ?, 'livestock_lot_external_identifier', ?,
      ?, ?, NULL, ?
    FROM fields AS current_field
    WHERE current_field.id = ?
      AND ${actorGuard.sql}
      AND ${snapshotPredicate}
      ${guard.targetLotId ? `AND EXISTS (
        SELECT 1 FROM livestock_lots AS target_lot
        WHERE target_lot.id = ?
          AND target_lot.field_id = ?
          AND target_lot.status = 'active'
          AND target_lot.tracking_mode = 'individual'
          AND target_lot.id <> ?
      )` : ""}
      ${guard.mappingId ? `AND NOT EXISTS (
        SELECT 1 FROM livestock_lot_external_identifiers AS conflicting_mapping
        WHERE conflicting_mapping.id = ?
      )` : ""}
      AND NOT EXISTS (SELECT 1 FROM audit_log AS conflicting_audit WHERE conflicting_audit.id = ?)
    `;
    return client.prepare(auditGuardSql).bind(
      guard.auditId,
      input.fieldId,
      actorAccess.actorEmail,
      guard.action,
      guard.entityId,
      guard.before,
      guard.after,
      now,
      input.fieldId,
      ...actorGuard.bindings,
      ...snapshotBindings,
      ...(guard.targetLotId ? [guard.targetLotId, input.fieldId, projectionQuarantineLotId(input.fieldId)] : []),
      ...(guard.mappingId ? [guard.mappingId] : []),
      guard.auditId,
    );
  };

  if (plan.action === "deactivate") {
    if (!current) throw stalePlanError();
    const auditId = crypto.randomUUID();
    const after = { ...current, validTo: now, updatedAt: now };
    const guardStatement = prepareAuditGuard({
      auditId,
      action: "import.group_mapping.deactivated",
      entityId: current.id,
      before: JSON.stringify(current),
      after: JSON.stringify(after),
    });
    const mutationStatement = client.prepare(`
      UPDATE livestock_lot_external_identifiers
      SET valid_to = ?, updated_at = ?
      WHERE id = ? AND valid_to IS NULL
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(now, now, current.id, auditId);
    const selectSaved = client.prepare(`
      SELECT id FROM livestock_lot_external_identifiers
      WHERE id = ? AND valid_to = ?
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(current.id, now, auditId);
    try {
      const [guardResult, mutationResult, savedResult] = await client.batch([guardStatement, mutationStatement, selectSaved]);
      const saved = savedResult.results[0] as { id: string } | undefined;
      if (guardResult.meta.changes !== 1 || mutationResult.meta.changes !== 1 || saved?.id !== current.id) {
        throw stalePlanError();
      }
    } catch (cause) {
      if (cause instanceof CooprinsemConfigurationError) throw cause;
      if (cause instanceof Error && /(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed)/i.test(cause.message)) throw stalePlanError();
      throw cause;
    }
    return { action: "deactivated", mappingId: current.id, confirmedAt: now };
  }
  if (!plan.targetLot) throw stalePlanError();
  const mappingId = `lot-identifier-${crypto.randomUUID()}`;
  const values = {
    id: mappingId,
    fieldId: input.fieldId,
    lotId: plan.targetLot.id,
    sourceSystem: "cooprinsem",
    kind: GROUP_KIND,
    value: plan.groupCode,
    normalizedValue: plan.normalizedGroupCode,
    validFrom: now,
    validTo: null,
    createdAt: now,
    updatedAt: now,
  };
  const auditId = crypto.randomUUID();
  const guardStatement = prepareAuditGuard({
    auditId,
    action: current ? "import.group_mapping.changed" : "import.group_mapping.created",
    entityId: mappingId,
    before: current ? JSON.stringify(current) : null,
    after: JSON.stringify(values),
    targetLotId: plan.targetLot.id,
    mappingId,
  });
  const statements = [guardStatement];
  if (current) statements.push(client.prepare(`
    UPDATE livestock_lot_external_identifiers
    SET valid_to = ?, updated_at = ?
    WHERE id = ? AND valid_to IS NULL
      AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
  `).bind(now, now, current.id, auditId));
  statements.push(
    client.prepare(`
      INSERT INTO livestock_lot_external_identifiers (
        id, field_id, lot_id, source_system, kind, value, normalized_value,
        valid_from, valid_to, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
      WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(
      values.id,
      values.fieldId,
      values.lotId,
      values.sourceSystem,
      values.kind,
      values.value,
      values.normalizedValue,
      values.validFrom,
      values.createdAt,
      values.updatedAt,
      auditId,
    ),
    client.prepare(`
      SELECT id FROM livestock_lot_external_identifiers
      WHERE id = ? AND field_id = ? AND valid_to IS NULL
        AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(mappingId, input.fieldId, auditId),
  );
  try {
    const results = await client.batch(statements);
    const mutationResults = results.slice(0, -1);
    const saved = results.at(-1)?.results[0] as { id: string } | undefined;
    if (mutationResults.some((result) => result.meta.changes !== 1) || saved?.id !== mappingId) throw stalePlanError();
  } catch (cause) {
    if (cause instanceof CooprinsemConfigurationError) throw cause;
    if (cause instanceof Error && /(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed)/i.test(cause.message)) throw stalePlanError();
    throw cause;
  }
  return { action: current ? "changed" : "created", mappingId, confirmedAt: now };
}

export async function simulateQuarantineReassignment(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  groupCode: string;
}): Promise<CooprinsemQuarantineReassignmentPlan> {
  return (await buildReassignmentContext(input)).plan;
}

export async function confirmQuarantineReassignment(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  groupCode: string;
  confirmation: string;
}): Promise<CooprinsemQuarantineReassignmentConfirmation> {
  const actorAccess = requireConfigurationAccess(input);
  const context = await buildReassignmentContext(input);
  if (context.plan.confirmationToken !== input.confirmation) throw stalePlanError();
  if (!context.plan.ready || !context.mapping || !context.plan.targetLotId) {
    throw new CooprinsemConfigurationError(context.plan.blockers[0] ?? "No hay animales listos para reasignar.", "REASSIGNMENT_NOT_READY");
  }
  const mapping = context.mapping;
  const targetLotId = context.plan.targetLotId;
  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const db = getDb();
  const client = db.$client;
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", actorAccess);
  const fieldScope = { organizationId: context.scope.organizationId, fieldIds: [input.fieldId] };
  const candidates = context.candidates.map((candidate) => {
    const moveDate = candidate.membership?.startedAt && candidate.membership.startedAt > today
      ? candidate.membership.startedAt
      : today;
    const membershipId = deterministicProjectionId("membership", [candidate.animalId, targetLotId, moveDate, mapping.id]);
    return {
      animalId: candidate.animalId,
      importJobId: candidate.importJobId,
      importRowId: candidate.importRowId,
      sourceTable: candidate.sourceTable,
      sourceKey: candidate.sourceKey,
      oldMembershipId: candidate.membership?.id ?? null,
      oldMembershipStartedAt: candidate.membership?.startedAt ?? null,
      oldMembershipSourceSystem: candidate.membership?.sourceSystem ?? null,
      oldMembershipCreatedAt: candidate.membership?.createdAt ?? null,
      oldMembershipUpdatedAt: candidate.membership?.updatedAt ?? null,
      moveDate,
      membershipId,
      sourceRecordId: deterministicProjectionId("source", [candidate.importRowId, "livestock_lot_membership", membershipId]),
      auditId: deterministicProjectionId("audit", [mapping.id, candidate.animalId, moveDate]),
      before: JSON.stringify({ lotId: context.plan.sourceLotId, membershipId: candidate.membership?.id ?? null }),
      after: JSON.stringify({ lotId: targetLotId, membershipId, groupCode: context.plan.groupCode }),
    };
  });
  const candidatePayload = JSON.stringify(candidates);
  const candidateCount = candidates.length;
  const oldMembershipCount = candidates.filter((candidate) => candidate.oldMembershipId).length;
  const sourceGuard = client.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table, source_key,
      target_entity, target_id, created_at
    )
    SELECT
      json_extract(candidate.value, '$.sourceRecordId'),
      json_extract(candidate.value, '$.importJobId'),
      json_extract(candidate.value, '$.importRowId'),
      'cooprinsem',
      json_extract(candidate.value, '$.sourceTable'),
      json_extract(candidate.value, '$.sourceKey'),
      'livestock_lot_membership',
      json_extract(candidate.value, '$.membershipId'),
      ?
    FROM json_each(?) AS candidate
    WHERE EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = ?
        AND ${actorGuard.sql}
    )
      AND EXISTS (
        SELECT 1 FROM livestock_lot_external_identifiers AS current_mapping
        WHERE current_mapping.id = ?
          AND current_mapping.field_id = ?
          AND current_mapping.lot_id = ?
          AND current_mapping.source_system = ?
          AND current_mapping.kind = ?
          AND current_mapping.value = ?
          AND current_mapping.normalized_value = ?
          AND current_mapping.valid_from IS ?
          AND current_mapping.valid_to IS ?
          AND current_mapping.created_at = ?
          AND current_mapping.updated_at = ?
      )
      AND EXISTS (
        SELECT 1 FROM livestock_lots AS source_lot
        WHERE source_lot.id = ? AND source_lot.field_id = ?
          AND source_lot.status = 'active' AND source_lot.tracking_mode = 'individual'
      )
      AND EXISTS (
        SELECT 1 FROM livestock_lots AS target_lot
        WHERE target_lot.id = ? AND target_lot.field_id = ?
          AND target_lot.status = 'active' AND target_lot.tracking_mode = 'individual'
          AND target_lot.id <> ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS invalid
        WHERE NOT EXISTS (
          SELECT 1 FROM livestock_animals AS current_animal
          WHERE current_animal.id = json_extract(invalid.value, '$.animalId')
            AND current_animal.lot_id = ?
        )
          OR (
            json_extract(invalid.value, '$.oldMembershipId') IS NULL
            AND EXISTS (
              SELECT 1 FROM livestock_lot_memberships AS unexpected_membership
              WHERE unexpected_membership.animal_id = json_extract(invalid.value, '$.animalId')
                AND unexpected_membership.ended_at IS NULL
            )
          )
          OR (
            json_extract(invalid.value, '$.oldMembershipId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM livestock_lot_memberships AS current_membership
              WHERE current_membership.id = json_extract(invalid.value, '$.oldMembershipId')
                AND current_membership.animal_id = json_extract(invalid.value, '$.animalId')
                AND current_membership.lot_id = ?
                AND current_membership.started_at = json_extract(invalid.value, '$.oldMembershipStartedAt')
                AND current_membership.ended_at IS NULL
                AND current_membership.source_system = json_extract(invalid.value, '$.oldMembershipSourceSystem')
                AND current_membership.created_at = json_extract(invalid.value, '$.oldMembershipCreatedAt')
                AND current_membership.updated_at = json_extract(invalid.value, '$.oldMembershipUpdatedAt')
            )
          )
          OR NOT EXISTS (
            SELECT 1
            FROM source_records AS original_source
            INNER JOIN import_rows AS current_row
              ON current_row.id = original_source.import_row_id
              AND current_row.import_job_id = original_source.import_job_id
            INNER JOIN import_jobs AS current_job ON current_job.id = original_source.import_job_id
            WHERE original_source.import_job_id = json_extract(invalid.value, '$.importJobId')
              AND original_source.import_row_id = json_extract(invalid.value, '$.importRowId')
              AND original_source.source_system = 'cooprinsem'
              AND original_source.source_table = json_extract(invalid.value, '$.sourceTable')
              AND original_source.source_key IS json_extract(invalid.value, '$.sourceKey')
              AND original_source.target_entity = 'livestock_animal'
              AND original_source.target_id = json_extract(invalid.value, '$.animalId')
              AND current_job.organization_id = ?
              AND current_job.field_id = ?
              AND current_job.source_system = 'cooprinsem'
              AND current_job.source_table = json_extract(invalid.value, '$.sourceTable')
          )
          OR EXISTS (
            SELECT 1 FROM livestock_lot_memberships AS conflicting_membership
            WHERE conflicting_membership.id = json_extract(invalid.value, '$.membershipId')
          )
          OR EXISTS (
            SELECT 1 FROM source_records AS conflicting_source
            WHERE conflicting_source.id = json_extract(invalid.value, '$.sourceRecordId')
              OR (
                conflicting_source.import_row_id = json_extract(invalid.value, '$.importRowId')
                AND conflicting_source.target_entity = 'livestock_lot_membership'
                AND conflicting_source.target_id = json_extract(invalid.value, '$.membershipId')
              )
          )
          OR EXISTS (
            SELECT 1 FROM audit_log AS conflicting_audit
            WHERE conflicting_audit.id = json_extract(invalid.value, '$.auditId')
          )
      )
  `).bind(
    now,
    candidatePayload,
    input.fieldId,
    ...actorGuard.bindings,
    mapping.id,
    mapping.fieldId,
    mapping.lotId,
    mapping.sourceSystem,
    mapping.kind,
    mapping.value,
    mapping.normalizedValue,
    mapping.validFrom,
    mapping.validTo,
    mapping.createdAt,
    mapping.updatedAt,
    context.plan.sourceLotId,
    input.fieldId,
    targetLotId,
    input.fieldId,
    context.plan.sourceLotId,
    candidatePayload,
    context.plan.sourceLotId,
    context.plan.sourceLotId,
    context.scope.organizationId,
    input.fieldId,
  );
  const closeMemberships = client.prepare(`
    UPDATE livestock_lot_memberships
    SET
      ended_at = (
        SELECT json_extract(candidate.value, '$.moveDate')
        FROM json_each(?) AS candidate
        WHERE json_extract(candidate.value, '$.oldMembershipId') = livestock_lot_memberships.id
      ),
      updated_at = ?
    WHERE id IN (
      SELECT json_extract(candidate.value, '$.oldMembershipId')
      FROM json_each(?) AS candidate
      WHERE json_extract(candidate.value, '$.oldMembershipId') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM source_records AS guard_source
          WHERE guard_source.id = json_extract(candidate.value, '$.sourceRecordId')
        )
    )
      AND ended_at IS NULL
  `).bind(candidatePayload, now, candidatePayload);
  const insertMemberships = client.prepare(`
    INSERT INTO livestock_lot_memberships (
      id, animal_id, lot_id, started_at, ended_at, source_system, created_at, updated_at
    )
    SELECT
      json_extract(candidate.value, '$.membershipId'),
      json_extract(candidate.value, '$.animalId'),
      ?,
      json_extract(candidate.value, '$.moveDate'),
      NULL,
      'cooprinsem',
      ?,
      ?
    FROM json_each(?) AS candidate
    WHERE EXISTS (
      SELECT 1 FROM source_records AS guard_source
      WHERE guard_source.id = json_extract(candidate.value, '$.sourceRecordId')
    )
      AND EXISTS (
        SELECT 1 FROM livestock_animals AS current_animal
        WHERE current_animal.id = json_extract(candidate.value, '$.animalId')
          AND current_animal.lot_id = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM livestock_lot_memberships AS active_membership
        WHERE active_membership.animal_id = json_extract(candidate.value, '$.animalId')
          AND active_membership.ended_at IS NULL
      )
  `).bind(targetLotId, now, now, candidatePayload, context.plan.sourceLotId);
  const moveAnimals = client.prepare(`
    UPDATE livestock_animals
    SET lot_id = ?, updated_at = ?
    WHERE id IN (
      SELECT json_extract(candidate.value, '$.animalId')
      FROM json_each(?) AS candidate
      WHERE EXISTS (
        SELECT 1 FROM source_records AS guard_source
        WHERE guard_source.id = json_extract(candidate.value, '$.sourceRecordId')
      )
        AND EXISTS (
          SELECT 1 FROM livestock_lot_memberships AS new_membership
          WHERE new_membership.id = json_extract(candidate.value, '$.membershipId')
            AND new_membership.animal_id = json_extract(candidate.value, '$.animalId')
            AND new_membership.lot_id = ?
            AND new_membership.ended_at IS NULL
        )
    )
      AND lot_id = ?
  `).bind(targetLotId, now, candidatePayload, targetLotId, context.plan.sourceLotId);
  const insertAudits = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(candidate.value, '$.auditId'),
      ?,
      ?,
      ?,
      'import.group_lot.reassigned',
      'livestock_animal',
      json_extract(candidate.value, '$.animalId'),
      json_extract(candidate.value, '$.before'),
      json_extract(candidate.value, '$.after'),
      json_extract(candidate.value, '$.sourceRecordId'),
      ?
    FROM json_each(?) AS candidate
    WHERE EXISTS (
      SELECT 1 FROM source_records AS guard_source
      WHERE guard_source.id = json_extract(candidate.value, '$.sourceRecordId')
    )
      AND EXISTS (
        SELECT 1 FROM livestock_lot_memberships AS new_membership
        WHERE new_membership.id = json_extract(candidate.value, '$.membershipId')
          AND new_membership.animal_id = json_extract(candidate.value, '$.animalId')
          AND new_membership.lot_id = ?
          AND new_membership.ended_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM livestock_animals AS moved_animal
        WHERE moved_animal.id = json_extract(candidate.value, '$.animalId')
          AND moved_animal.lot_id = ?
      )
  `).bind(
    context.scope.organizationId,
    input.fieldId,
    actorAccess.actorEmail,
    now,
    candidatePayload,
    targetLotId,
    targetLotId,
  );
  const assertComplete = client.prepare(`
    SELECT CASE WHEN
      (SELECT COUNT(*) FROM source_records AS guard_source
       WHERE guard_source.id IN (
         SELECT json_extract(candidate.value, '$.sourceRecordId') FROM json_each(?) AS candidate
       )) = ?
      AND (SELECT COUNT(*) FROM livestock_lot_memberships AS new_membership
       WHERE new_membership.id IN (
         SELECT json_extract(candidate.value, '$.membershipId') FROM json_each(?) AS candidate
       ) AND new_membership.lot_id = ? AND new_membership.ended_at IS NULL) = ?
      AND (SELECT COUNT(*) FROM livestock_animals AS moved_animal
       WHERE moved_animal.id IN (
         SELECT json_extract(candidate.value, '$.animalId') FROM json_each(?) AS candidate
       ) AND moved_animal.lot_id = ?) = ?
      AND (SELECT COUNT(*) FROM audit_log AS reassignment_audit
       WHERE reassignment_audit.id IN (
         SELECT json_extract(candidate.value, '$.auditId') FROM json_each(?) AS candidate
       )) = ?
      AND (SELECT COUNT(*) FROM livestock_lot_memberships AS closed_membership
       WHERE closed_membership.id IN (
         SELECT json_extract(candidate.value, '$.oldMembershipId')
         FROM json_each(?) AS candidate
         WHERE json_extract(candidate.value, '$.oldMembershipId') IS NOT NULL
       ) AND closed_membership.ended_at = (
         SELECT json_extract(candidate.value, '$.moveDate')
         FROM json_each(?) AS candidate
         WHERE json_extract(candidate.value, '$.oldMembershipId') = closed_membership.id
       )) = ?
      AND EXISTS (
        SELECT 1 FROM livestock_lots AS source_summary
        WHERE source_summary.id = ?
          AND source_summary.animal_count = (
            SELECT COUNT(*) FROM livestock_animals AS source_animal
            WHERE source_animal.lot_id = source_summary.id AND source_animal.status = 'active'
          )
      )
      AND EXISTS (
        SELECT 1 FROM livestock_lots AS target_summary
        WHERE target_summary.id = ?
          AND target_summary.animal_count = (
            SELECT COUNT(*) FROM livestock_animals AS target_animal
            WHERE target_animal.lot_id = target_summary.id AND target_animal.status = 'active'
          )
      )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(
    candidatePayload,
    candidateCount,
    candidatePayload,
    targetLotId,
    candidateCount,
    candidatePayload,
    targetLotId,
    candidateCount,
    candidatePayload,
    candidateCount,
    candidatePayload,
    candidatePayload,
    oldMembershipCount,
    context.plan.sourceLotId,
    targetLotId,
  );
  try {
    const results = await client.batch([
      sourceGuard,
      closeMemberships,
      insertMemberships,
      moveAnimals,
      insertAudits,
      prepareIndividualLotSummaryUpdate(client, context.plan.sourceLotId, fieldScope, now, true),
      prepareIndividualLotSummaryUpdate(client, targetLotId, fieldScope, now, true),
      assertComplete,
    ]);
    const expectedChanges = [candidateCount, oldMembershipCount, candidateCount, candidateCount, candidateCount, 1, 1];
    if (expectedChanges.some((expected, index) => results[index].meta.changes !== expected)
      || (results[7].results[0] as { complete?: number } | undefined)?.complete !== 1) throw stalePlanError();
  } catch (cause) {
    if (cause instanceof CooprinsemConfigurationError) throw cause;
    if (cause instanceof Error && /(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|integer overflow)/i.test(cause.message)) throw stalePlanError();
    throw cause;
  }
  return { movedAnimalCount: candidateCount, sourceLotId: context.plan.sourceLotId, targetLotId, confirmedAt: now };
}

export async function confirmGenealogyReconciliation(input: {
  actorEmail: string;
  fieldId: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
  confirmation: string;
}): Promise<CooprinsemGenealogyConfirmation> {
  const actorAccess = requireConfigurationAccess(input);
  const scope = await resolveFieldScope(input.fieldId, input);
  if (!scope) throw new CooprinsemConfigurationError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND");
  const { plan, workRows } = await buildGenealogyContext(scope, actorAccess.membershipId);
  if (!sameFieldScope(scope, await resolveFieldScope(input.fieldId, actorAccess))) throw stalePlanError();
  if (plan.confirmationToken !== input.confirmation) throw stalePlanError();
  const readyRows = workRows.filter((row) => row.status === "ready" && row.candidateAnimalId);
  if (readyRows.length === 0) throw new CooprinsemConfigurationError("No hay genealogías inequívocas listas para enlazar.", "GENEALOGY_NOT_READY");
  const now = new Date().toISOString();
  const client = getDb().$client;
  const actorGuard = currentCooprinsemActorFieldGuard("current_field", actorAccess);
  const links = readyRows.map((row) => {
    const candidate = row.candidateSnapshot;
    const candidateAnimalId = row.candidateAnimalId;
    if (!candidate || !candidateAnimalId || candidate.id !== candidateAnimalId) throw stalePlanError();
    const offspring = row.offspringSnapshot;
    const birth = row.birthSnapshot;
    const source = row.sourceSnapshot;
    return {
      fieldId: scope.fieldId,
      organizationId: scope.organizationId,
      offspringId: row.offspringId,
      offspringBirthId: offspring.birthId,
      offspringTemporaryIdentifier: offspring.temporaryIdentifier,
      offspringSex: offspring.sex,
      offspringOutcome: offspring.outcome,
      offspringBirthWeightKg: offspring.birthWeightKg,
      offspringNotes: offspring.notes,
      offspringCreatedAt: offspring.createdAt,
      offspringUpdatedAt: offspring.updatedAt,
      birthId: birth.id,
      birthFieldId: birth.fieldId,
      birthDamAnimalId: birth.damAnimalId,
      birthReproductiveEventId: birth.reproductiveEventId,
      birthOccurredAt: birth.occurredAt,
      birthCalvingType: birth.calvingType,
      birthDifficulty: birth.difficulty,
      birthOutcome: birth.outcome,
      birthSireIdentifier: birth.sireIdentifier,
      birthNotes: birth.notes,
      birthSource: birth.source,
      birthSourceRecordId: birth.sourceRecordId,
      birthCreatedBy: birth.createdBy,
      birthCreatedAt: birth.createdAt,
      birthUpdatedAt: birth.updatedAt,
      candidateAnimalId,
      candidateLotId: candidate.lotId,
      candidateTag: candidate.tag,
      candidateSex: candidate.sex,
      candidateStatus: candidate.status,
      candidateStatusDate: candidate.statusDate,
      candidateStatusReason: candidate.statusReason,
      candidateBirthDate: candidate.birthDate,
      candidatePurchasePriceClp: candidate.purchasePriceClp,
      candidatePurchaseDate: candidate.purchaseDate,
      candidateOrigin: candidate.origin,
      candidateNotes: candidate.notes,
      candidateSource: candidate.source,
      candidateCreatedAt: candidate.createdAt,
      candidateUpdatedAt: candidate.updatedAt,
      normalizedTemporaryIdentifier: normalizeExternalIdentifier(row.temporaryIdentifier),
      sourceRecordId: source?.record.id ?? null,
      sourceImportJobId: source?.record.importJobId ?? null,
      sourceImportRowId: source?.record.importRowId ?? null,
      sourceSystem: source?.record.sourceSystem ?? null,
      sourceTable: source?.record.sourceTable ?? null,
      sourceKey: source?.record.sourceKey ?? null,
      sourceTargetEntity: source?.record.targetEntity ?? null,
      sourceTargetId: source?.record.targetId ?? null,
      sourceCreatedAt: source?.record.createdAt ?? null,
      sourceOrganizationId: source?.organizationId ?? null,
      sourceFieldId: source?.fieldId ?? null,
      sourceJobSystem: source?.jobSourceSystem ?? null,
      sourceJobTable: source?.jobSourceTable ?? null,
      auditId: deterministicProjectionId("audit", [row.offspringId, candidateAnimalId, "genealogy-linked"]),
      before: JSON.stringify({ animalId: null, temporaryIdentifier: row.temporaryIdentifier }),
      after: JSON.stringify({ animalId: candidateAnimalId, matchedBy: row.matchedBy }),
    };
  });
  const linkPayload = JSON.stringify(links);
  const linkCount = links.length;
  const guardedLinks = client.prepare(`
    UPDATE livestock_birth_offspring
    SET
      animal_id = (
        SELECT json_extract(link.value, '$.candidateAnimalId')
        FROM json_each(?) AS link
        WHERE json_extract(link.value, '$.offspringId') = livestock_birth_offspring.id
      ),
      updated_at = ?
    WHERE id IN (
      SELECT json_extract(link.value, '$.offspringId') FROM json_each(?) AS link
    )
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) AS invalid
        WHERE NOT EXISTS (
          SELECT 1 FROM fields AS current_field
          WHERE current_field.id = json_extract(invalid.value, '$.fieldId')
            AND current_field.organization_id = json_extract(invalid.value, '$.organizationId')
            AND ${actorGuard.sql}
        )
          OR NOT EXISTS (
            SELECT 1 FROM livestock_birth_offspring AS current_offspring
            WHERE current_offspring.id = json_extract(invalid.value, '$.offspringId')
              AND current_offspring.birth_id = json_extract(invalid.value, '$.offspringBirthId')
              AND current_offspring.animal_id IS NULL
              AND current_offspring.temporary_identifier = json_extract(invalid.value, '$.offspringTemporaryIdentifier')
              AND current_offspring.sex = json_extract(invalid.value, '$.offspringSex')
              AND current_offspring.outcome = json_extract(invalid.value, '$.offspringOutcome')
              AND current_offspring.birth_weight_kg IS json_extract(invalid.value, '$.offspringBirthWeightKg')
              AND current_offspring.notes = json_extract(invalid.value, '$.offspringNotes')
              AND current_offspring.created_at = json_extract(invalid.value, '$.offspringCreatedAt')
              AND current_offspring.updated_at = json_extract(invalid.value, '$.offspringUpdatedAt')
          )
          OR NOT EXISTS (
            SELECT 1 FROM livestock_births AS current_birth
            WHERE current_birth.id = json_extract(invalid.value, '$.birthId')
              AND current_birth.field_id = json_extract(invalid.value, '$.birthFieldId')
              AND current_birth.field_id = json_extract(invalid.value, '$.fieldId')
              AND current_birth.dam_animal_id = json_extract(invalid.value, '$.birthDamAnimalId')
              AND current_birth.reproductive_event_id IS json_extract(invalid.value, '$.birthReproductiveEventId')
              AND current_birth.occurred_at = json_extract(invalid.value, '$.birthOccurredAt')
              AND current_birth.calving_type = json_extract(invalid.value, '$.birthCalvingType')
              AND current_birth.difficulty = json_extract(invalid.value, '$.birthDifficulty')
              AND current_birth.outcome = json_extract(invalid.value, '$.birthOutcome')
              AND current_birth.sire_identifier IS json_extract(invalid.value, '$.birthSireIdentifier')
              AND current_birth.notes = json_extract(invalid.value, '$.birthNotes')
              AND current_birth.source = json_extract(invalid.value, '$.birthSource')
              AND current_birth.source_record_id IS json_extract(invalid.value, '$.birthSourceRecordId')
              AND current_birth.created_by = json_extract(invalid.value, '$.birthCreatedBy')
              AND current_birth.created_at = json_extract(invalid.value, '$.birthCreatedAt')
              AND current_birth.updated_at = json_extract(invalid.value, '$.birthUpdatedAt')
          )
          OR NOT EXISTS (
            SELECT 1
            FROM livestock_animals AS current_dam
            INNER JOIN livestock_lots AS dam_lot ON dam_lot.id = current_dam.lot_id
            WHERE current_dam.id = json_extract(invalid.value, '$.birthDamAnimalId')
              AND dam_lot.field_id = json_extract(invalid.value, '$.fieldId')
          )
          OR NOT EXISTS (
            SELECT 1
            FROM livestock_animals AS current_candidate
            INNER JOIN livestock_lots AS candidate_lot ON candidate_lot.id = current_candidate.lot_id
            WHERE current_candidate.id = json_extract(invalid.value, '$.candidateAnimalId')
              AND current_candidate.lot_id = json_extract(invalid.value, '$.candidateLotId')
              AND candidate_lot.field_id = json_extract(invalid.value, '$.fieldId')
              AND current_candidate.tag = json_extract(invalid.value, '$.candidateTag')
              AND current_candidate.sex = json_extract(invalid.value, '$.candidateSex')
              AND current_candidate.status = json_extract(invalid.value, '$.candidateStatus')
              AND current_candidate.status_date IS json_extract(invalid.value, '$.candidateStatusDate')
              AND current_candidate.status_reason IS json_extract(invalid.value, '$.candidateStatusReason')
              AND current_candidate.birth_date IS json_extract(invalid.value, '$.candidateBirthDate')
              AND current_candidate.purchase_price_clp IS json_extract(invalid.value, '$.candidatePurchasePriceClp')
              AND current_candidate.purchase_date IS json_extract(invalid.value, '$.candidatePurchaseDate')
              AND current_candidate.origin IS json_extract(invalid.value, '$.candidateOrigin')
              AND current_candidate.notes = json_extract(invalid.value, '$.candidateNotes')
              AND current_candidate.source = json_extract(invalid.value, '$.candidateSource')
              AND current_candidate.created_at = json_extract(invalid.value, '$.candidateCreatedAt')
              AND current_candidate.updated_at = json_extract(invalid.value, '$.candidateUpdatedAt')
          )
          OR json_extract(invalid.value, '$.candidateAnimalId') = json_extract(invalid.value, '$.birthDamAnimalId')
          OR (
            json_extract(invalid.value, '$.offspringSex') <> 'unknown'
            AND json_extract(invalid.value, '$.candidateSex') <> 'unknown'
            AND json_extract(invalid.value, '$.offspringSex') <> json_extract(invalid.value, '$.candidateSex')
          )
          OR (
            json_extract(invalid.value, '$.candidateBirthDate') IS NOT NULL
            AND json_extract(invalid.value, '$.candidateBirthDate') <> json_extract(invalid.value, '$.birthOccurredAt')
          )
          OR (
            upper(trim(json_extract(invalid.value, '$.candidateTag'))) <> json_extract(invalid.value, '$.normalizedTemporaryIdentifier')
            AND NOT EXISTS (
              SELECT 1 FROM livestock_animal_identifiers AS candidate_identifier
              WHERE candidate_identifier.field_id = json_extract(invalid.value, '$.fieldId')
                AND candidate_identifier.animal_id = json_extract(invalid.value, '$.candidateAnimalId')
                AND candidate_identifier.normalized_value = json_extract(invalid.value, '$.normalizedTemporaryIdentifier')
                AND candidate_identifier.valid_to IS NULL
            )
          )
          OR EXISTS (
            SELECT 1
            FROM livestock_animals AS competing_animal
            INNER JOIN livestock_lots AS competing_lot ON competing_lot.id = competing_animal.lot_id
            WHERE competing_lot.field_id = json_extract(invalid.value, '$.fieldId')
              AND competing_animal.id <> json_extract(invalid.value, '$.candidateAnimalId')
              AND upper(trim(competing_animal.tag)) = json_extract(invalid.value, '$.normalizedTemporaryIdentifier')
          )
          OR EXISTS (
            SELECT 1 FROM livestock_animal_identifiers AS competing_identifier
            WHERE competing_identifier.field_id = json_extract(invalid.value, '$.fieldId')
              AND competing_identifier.animal_id <> json_extract(invalid.value, '$.candidateAnimalId')
              AND competing_identifier.normalized_value = json_extract(invalid.value, '$.normalizedTemporaryIdentifier')
              AND competing_identifier.valid_to IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM livestock_birth_offspring AS existing_link
            WHERE existing_link.animal_id = json_extract(invalid.value, '$.candidateAnimalId')
          )
          OR (
            json_extract(invalid.value, '$.sourceRecordId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
              FROM source_records AS current_source
              INNER JOIN import_jobs AS current_job ON current_job.id = current_source.import_job_id
              INNER JOIN import_rows AS current_row
                ON current_row.id = current_source.import_row_id
                AND current_row.import_job_id = current_source.import_job_id
              WHERE current_source.id = json_extract(invalid.value, '$.sourceRecordId')
                AND current_source.import_job_id = json_extract(invalid.value, '$.sourceImportJobId')
                AND current_source.import_row_id = json_extract(invalid.value, '$.sourceImportRowId')
                AND current_source.source_system = json_extract(invalid.value, '$.sourceSystem')
                AND current_source.source_table = json_extract(invalid.value, '$.sourceTable')
                AND current_source.source_key IS json_extract(invalid.value, '$.sourceKey')
                AND current_source.target_entity = json_extract(invalid.value, '$.sourceTargetEntity')
                AND current_source.target_id = json_extract(invalid.value, '$.sourceTargetId')
                AND current_source.created_at = json_extract(invalid.value, '$.sourceCreatedAt')
                AND current_job.organization_id = json_extract(invalid.value, '$.sourceOrganizationId')
                AND current_job.field_id = json_extract(invalid.value, '$.sourceFieldId')
                AND current_job.source_system = json_extract(invalid.value, '$.sourceJobSystem')
                AND current_job.source_table = json_extract(invalid.value, '$.sourceJobTable')
            )
          )
          OR EXISTS (
            SELECT 1 FROM audit_log AS existing_audit
            WHERE existing_audit.id = json_extract(invalid.value, '$.auditId')
          )
      )
  `).bind(linkPayload, now, linkPayload, linkPayload, ...actorGuard.bindings);
  const linkAudits = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id,
      before, after, source_record_id, occurred_at
    )
    SELECT
      json_extract(link.value, '$.auditId'),
      json_extract(link.value, '$.organizationId'),
      json_extract(link.value, '$.fieldId'),
      ?,
      'genealogy.offspring.linked',
      'livestock_birth_offspring',
      json_extract(link.value, '$.offspringId'),
      json_extract(link.value, '$.before'),
      json_extract(link.value, '$.after'),
      json_extract(link.value, '$.sourceRecordId'),
      ?
    FROM json_each(?) AS link
    WHERE (SELECT changes()) = ?
      AND EXISTS (
        SELECT 1 FROM livestock_birth_offspring AS linked
        WHERE linked.id = json_extract(link.value, '$.offspringId')
          AND linked.animal_id = json_extract(link.value, '$.candidateAnimalId')
          AND linked.updated_at = ?
      )
  `).bind(actorAccess.actorEmail, now, linkPayload, linkCount, now);
  const assertComplete = client.prepare(`
    SELECT CASE WHEN
      (SELECT COUNT(*) FROM json_each(?) AS link
       WHERE EXISTS (
         SELECT 1 FROM livestock_birth_offspring AS linked
         WHERE linked.id = json_extract(link.value, '$.offspringId')
           AND linked.animal_id = json_extract(link.value, '$.candidateAnimalId')
           AND linked.updated_at = ?
       )) = ?
      AND (SELECT COUNT(*) FROM json_each(?) AS link
       WHERE EXISTS (
         SELECT 1 FROM audit_log AS saved_audit
         WHERE saved_audit.id = json_extract(link.value, '$.auditId')
           AND saved_audit.organization_id = json_extract(link.value, '$.organizationId')
           AND saved_audit.field_id = json_extract(link.value, '$.fieldId')
           AND saved_audit.actor = ?
           AND saved_audit.action = 'genealogy.offspring.linked'
           AND saved_audit.entity_type = 'livestock_birth_offspring'
           AND saved_audit.entity_id = json_extract(link.value, '$.offspringId')
           AND saved_audit.before = json_extract(link.value, '$.before')
           AND saved_audit.after = json_extract(link.value, '$.after')
           AND saved_audit.source_record_id IS json_extract(link.value, '$.sourceRecordId')
           AND saved_audit.occurred_at = ?
       )) = ?
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
  `).bind(linkPayload, now, linkCount, linkPayload, actorAccess.actorEmail, now, linkCount);
  try {
    const results = await client.batch([guardedLinks, linkAudits, assertComplete]);
    if (results[0].meta.changes !== linkCount
      || results[1].meta.changes !== linkCount
      || (results[2].results[0] as { complete?: number } | undefined)?.complete !== 1) throw stalePlanError();
  } catch (cause) {
    if (cause instanceof CooprinsemConfigurationError) throw cause;
    if (cause instanceof Error && /(?:UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|integer overflow)/i.test(cause.message)) throw stalePlanError();
    throw cause;
  }
  return { linkedOffspringCount: linkCount, confirmedAt: now };
}

async function buildHistoryConfigurationContext(
  scope: FieldScope,
  membershipId: string,
): Promise<HistoryConfigurationContext> {
  const db = getDb();
  const [contracts, sourceRows, eventRows] = await Promise.all([
    db.select().from(cooprinsemHistoryUnitContracts).where(and(
      eq(cooprinsemHistoryUnitContracts.organizationId, scope.organizationId),
      eq(cooprinsemHistoryUnitContracts.fieldId, scope.fieldId),
      eq(cooprinsemHistoryUnitContracts.contractVersion, COOPRINSEM_MILK_UNIT_CONTRACT_VERSION),
    )).orderBy(desc(cooprinsemHistoryUnitContracts.confirmedAt)),
    db.select({
      animal: livestockAnimals,
      originalSource: sourceRecords,
      importRow: importRows,
      importJob: importJobs,
    }).from(sourceRecords)
      .innerJoin(importRows, eq(importRows.id, sourceRecords.importRowId))
      .innerJoin(importJobs, eq(importJobs.id, sourceRecords.importJobId))
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, sourceRecords.targetId))
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .where(and(
        eq(sourceRecords.targetEntity, "livestock_animal"),
        eq(importJobs.organizationId, scope.organizationId),
        eq(importJobs.fieldId, scope.fieldId),
        eq(livestockLots.fieldId, scope.fieldId),
      )),
    db.select().from(livestockReproductiveEvents).where(eq(livestockReproductiveEvents.fieldId, scope.fieldId)),
  ]);
  const unitContract = contracts[0] ?? null;
  const entries = sourceRows.flatMap((row) => row.importRow.normalizedRecord ? [{
    animalId: row.animal.id,
    importJobId: row.importJob.id,
    importRowId: row.importRow.id,
    sourceTable: row.importJob.sourceTable,
    sourceKey: row.originalSource.sourceKey,
    record: row.importRow.normalizedRecord,
    effectiveAt: row.importJob.effectiveAt,
  }] : []);
  const proposedWorkset = buildCooprinsemHistoryWorkset(entries, {
    milkUnitContractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
  });
  const milkReadyAfterConfirmation = proposedWorkset.milkControls.filter((candidate) => candidate.state === "ready").length;
  const milkConfirmationToken = await buildConfirmationToken("history-milk-unit-contract", {
    format: "fundosmart.cooprinsem-milk-unit-contract-plan.v1",
    fieldId: scope.fieldId,
    membershipId,
    contractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
    canonicalUnit: COOPRINSEM_MILK_CANONICAL_UNIT,
    sourceFields: COOPRINSEM_MILK_SOURCE_FIELDS,
  });

  const animalById = new Map(sourceRows.map((row) => [row.animal.id, row.animal]));
  const sourceSnapshotByKey = new Map<string, HistorySourceSnapshot>();
  for (const row of sourceRows) {
    sourceSnapshotByKey.set(`${row.importJob.id}:${row.importRow.id}`, {
      importJobId: row.importJob.id,
      importRowId: row.importRow.id,
      sourceTable: row.importJob.sourceTable,
      sourceKey: row.originalSource.sourceKey,
      originalSource: row.originalSource,
      importRow: row.importRow,
      importJob: row.importJob,
    });
  }
  const eventsByAnimalDate = new Map<string, Array<typeof livestockReproductiveEvents.$inferSelect>>();
  for (const event of eventRows.filter((row) => row.eventType === "service" || row.eventType === "insemination")) {
    const key = `${event.animalId}:${event.occurredAt}`;
    eventsByAnimalDate.set(key, [...(eventsByAnimalDate.get(key) ?? []), event]);
  }
  const serviceRows: HistoryServiceWorkRow[] = proposedWorkset.reproductiveServices.map((candidate) => {
    const blockers = new Set(candidate.blockers);
    const sources = completeHistorySources(candidate.sources).flatMap((source) => {
      const snapshot = sourceSnapshotByKey.get(`${source.importJobId}:${source.importRowId}`);
      return snapshot ? [snapshot] : [];
    });
    if (sources.length === 0 || sources.length !== candidate.sources.length) {
      blockers.add("La cubierta no conserva una procedencia completa y no puede confirmarse.");
    }
    if (animalById.get(candidate.animalId)?.sex === "male") blockers.add("Un macho no puede recibir esta cubierta histórica.");
    if (!candidate.occurredAt) blockers.add("La cubierta requiere una fecha válida.");
    const existing = candidate.occurredAt
      ? eventsByAnimalDate.get(`${candidate.animalId}:${candidate.occurredAt}`) ?? []
      : [];
    let existingEvent: typeof livestockReproductiveEvents.$inferSelect | null = null;
    if (existing.length > 1) {
      blockers.add("Existe más de un evento reproductivo equivalente en la fecha y requiere resolución.");
    } else if (existing.length === 1) {
      existingEvent = existing[0];
      if (existingEvent.eventType !== "service") blockers.add("Ya existe una inseminación en esa fecha; no se reemplazará por una cubierta genérica.");
      else if (normalizeHistorySire(existingEvent.sireIdentifier) !== normalizeHistorySire(candidate.sireIdentifier)) {
        blockers.add("La cubierta existente tiene un reproductor distinto.");
      }
    }
    const ready = blockers.size === 0;
    const targetId = ready
      ? existingEvent?.id ?? `repro:${candidate.animalId}:service:${candidate.occurredAt}`
      : null;
    return {
      animalId: candidate.animalId,
      animalTag: animalById.get(candidate.animalId)?.tag ?? candidate.animalId,
      occurredAt: candidate.occurredAt,
      sireIdentifier: candidate.sireIdentifier,
      roles: candidate.roles,
      state: ready ? "ready" : "blocked",
      action: ready ? (existingEvent ? "reuse" : "create") : "blocked",
      sourceCount: sources.length,
      blockers: [...blockers].sort(),
      targetId,
      sources,
      animalSnapshot: animalById.get(candidate.animalId) ?? null,
      existingEvent,
    };
  });
  const readyServices = serviceRows.filter((row) => row.state === "ready" && row.targetId);
  const serviceConfirmationToken = await buildConfirmationToken("history-services", {
    format: "fundosmart.cooprinsem-history-service-plan.v1",
    fieldId: scope.fieldId,
    membershipId,
    services: readyServices.map((row) => [
      row.animalId,
      row.occurredAt,
      normalizeHistorySire(row.sireIdentifier),
      row.targetId,
      row.sources.map((source) => [source.importJobId, source.importRowId, source.sourceTable, source.sourceKey]),
    ]),
  });
  const servicePlan: CooprinsemHistoryServicePlan = {
    format: "fundosmart.cooprinsem-history-service-plan.v1",
    fieldId: scope.fieldId,
    fieldName: scope.fieldName,
    ready: readyServices.length > 0,
    summary: {
      candidateCount: serviceRows.length,
      readyCount: readyServices.length,
      createCount: readyServices.filter((row) => row.action === "create").length,
      reuseCount: readyServices.filter((row) => row.action === "reuse").length,
      blockedCount: serviceRows.length - readyServices.length,
      sourceLinkCount: readyServices.reduce((total, row) => total + row.sources.length, 0),
    },
    rows: serviceRows.slice(0, PREVIEW_LIMIT).map((row) => ({
      animalId: row.animalId,
      animalTag: row.animalTag,
      occurredAt: row.occurredAt,
      sireIdentifier: row.sireIdentifier,
      roles: row.roles,
      state: row.state,
      action: row.action,
      sourceCount: row.sourceCount,
      blockers: row.blockers,
    })),
    rowsTruncated: serviceRows.length > PREVIEW_LIMIT,
    confirmationPhrase: HISTORY_SERVICES_CONFIRMATION_PHRASE,
    confirmationToken: serviceConfirmationToken,
  };
  return {
    scope,
    unitContract,
    serviceRows,
    configuration: {
      milkUnitContract: {
        format: "fundosmart.cooprinsem-milk-unit-contract-plan.v1",
        fieldId: scope.fieldId,
        fieldName: scope.fieldName,
        contractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
        canonicalUnit: COOPRINSEM_MILK_CANONICAL_UNIT,
        sourceFields: [...COOPRINSEM_MILK_SOURCE_FIELDS],
        confirmed: Boolean(unitContract),
        contractId: unitContract?.id ?? null,
        confirmedAt: unitContract?.confirmedAt ?? null,
        candidateCount: proposedWorkset.milkControls.length,
        readyAfterConfirmationCount: milkReadyAfterConfirmation,
        blockedAfterConfirmationCount: proposedWorkset.milkControls.length - milkReadyAfterConfirmation,
        confirmationPhrase: MILK_UNIT_CONFIRMATION_PHRASE,
        confirmationToken: milkConfirmationToken,
      },
      services: servicePlan,
    },
  };
}

async function resolveFieldScope(
  fieldId: string,
  accessInput: ConfigurationFieldAccess,
): Promise<FieldScope | null> {
  const access = normalizeConfigurationAccess(accessInput);
  if (!access?.fieldIds.includes(fieldId)) return null;
  const guard = currentCooprinsemActorFieldGuard("current_field", access);
  const scope = await getDb().$client.prepare(`
    SELECT current_field.id AS fieldId,
           current_field.name AS fieldName,
           current_field.organization_id AS organizationId
    FROM fields AS current_field
    WHERE current_field.id = ?
      AND ${guard.sql}
    LIMIT 1
  `).bind(fieldId, ...guard.bindings).first<FieldScope>();
  return scope ?? null;
}

function normalizeConfigurationAccess(
  access: ConfigurationFieldAccess,
): NormalizedCooprinsemActorFieldAccess | null {
  return normalizeCooprinsemActorFieldAccess(access);
}

function sameFieldScope(left: FieldScope, right: FieldScope | null): right is FieldScope {
  return right !== null
    && left.fieldId === right.fieldId
    && left.fieldName === right.fieldName
    && left.organizationId === right.organizationId;
}

function completeHistorySources(sources: Array<{
  importJobId: string | null;
  importRowId: string | null;
  sourceTable: string | null;
  sourceKey: string | null;
}>): HistorySource[] {
  return sources.flatMap((source) => source.importJobId && source.importRowId && source.sourceTable ? [{
    importJobId: source.importJobId,
    importRowId: source.importRowId,
    sourceTable: source.sourceTable,
    sourceKey: source.sourceKey,
  }] : []).sort((left, right) => `${left.importJobId}:${left.importRowId}`.localeCompare(`${right.importJobId}:${right.importRowId}`));
}

function historySourceRecordId(source: HistorySource, targetId: string): string {
  return deterministicProjectionId("source", [source.importRowId, "livestock_reproductive_event", targetId]);
}

function normalizeHistorySire(value: string | null): string {
  return (value ?? "").trim().normalize("NFKC").toLocaleUpperCase("es");
}

async function loadConfigurationContext(
  fieldId: string,
  accessInput: ConfigurationFieldAccess,
): Promise<ConfigurationContext | null> {
  const access = normalizeConfigurationAccess(accessInput);
  if (!access) return null;
  const db = getDb();
  const scope = await resolveFieldScope(fieldId, access);
  if (!scope) return null;
  const quarantineLotId = projectionQuarantineLotId(fieldId);
  const [lots, mappings, stagedRows, animalSources, activeMemberships, quarantineAnimals] = await Promise.all([
    db.select().from(livestockLots).where(eq(livestockLots.fieldId, fieldId)).orderBy(asc(livestockLots.name)),
    db.select().from(livestockLotExternalIdentifiers).where(and(
      eq(livestockLotExternalIdentifiers.fieldId, fieldId), eq(livestockLotExternalIdentifiers.sourceSystem, "cooprinsem"),
      eq(livestockLotExternalIdentifiers.kind, GROUP_KIND), isNull(livestockLotExternalIdentifiers.validTo),
    )),
    db.select({
      rowId: importRows.id, rowStatus: importRows.status, recordNumber: importRows.recordNumber,
      rawRecord: importRows.rawRecord, normalizedRecord: importRows.normalizedRecord, jobStatus: importJobs.status,
    }).from(importRows).innerJoin(importJobs, eq(importJobs.id, importRows.importJobId)).where(and(
      eq(importJobs.organizationId, scope.organizationId),
      eq(importJobs.fieldId, fieldId),
    )),
    db.select({
      animalId: livestockAnimals.id, tag: livestockAnimals.tag, lotId: livestockAnimals.lotId,
      importJobId: importJobs.id, importRowId: importRows.id, sourceTable: importJobs.sourceTable,
      sourceKey: sourceRecords.sourceKey, normalizedRecord: importRows.normalizedRecord, rawRecord: importRows.rawRecord,
    }).from(sourceRecords)
      .innerJoin(importRows, eq(importRows.id, sourceRecords.importRowId))
      .innerJoin(importJobs, eq(importJobs.id, sourceRecords.importJobId))
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, sourceRecords.targetId))
      .where(and(
        eq(sourceRecords.targetEntity, "livestock_animal"),
        eq(importJobs.organizationId, scope.organizationId),
        eq(importJobs.fieldId, fieldId),
      )),
    db.select({ membership: livestockLotMemberships, animalId: livestockAnimals.id })
      .from(livestockLotMemberships)
      .innerJoin(livestockAnimals, eq(livestockAnimals.id, livestockLotMemberships.animalId))
      .where(and(eq(livestockAnimals.lotId, quarantineLotId), isNull(livestockLotMemberships.endedAt))),
    db.select({ id: livestockAnimals.id }).from(livestockAnimals).where(eq(livestockAnimals.lotId, quarantineLotId)),
  ]);
  const groupStats = new Map<string, GroupStats>();
  for (const row of stagedRows) {
    if (row.recordNumber === 0) continue;
    const group = groupValue(row.normalizedRecord ?? row.rawRecord);
    if (!group) continue;
    const normalized = normalizeCooprinsemGroupCode(group);
    const current = groupStats.get(normalized) ?? { groupCode: group, normalizedGroupCode: normalized, impact: emptyImpact() };
    current.impact.stagedRowCount += 1;
    if (row.jobStatus === "preview_ready" && (row.rowStatus === "valid" || row.rowStatus === "warning")) current.impact.pendingRowCount += 1;
    if (row.rowStatus === "imported") current.impact.importedRowCount += 1;
    groupStats.set(normalized, current);
  }
  const membershipByAnimal = new Map(activeMemberships.map((entry) => [entry.animalId, entry.membership]));
  const sourcesByGroup = new Map<string, Map<string, GroupAnimalSource>>();
  for (const source of animalSources) {
    const group = groupValue(source.normalizedRecord ?? source.rawRecord);
    if (!group) continue;
    const normalized = normalizeCooprinsemGroupCode(group);
    const byAnimal = sourcesByGroup.get(normalized) ?? new Map<string, GroupAnimalSource>();
    if (!byAnimal.has(source.animalId)) byAnimal.set(source.animalId, {
      animalId: source.animalId, tag: source.tag, lotId: source.lotId,
      importJobId: source.importJobId, importRowId: source.importRowId,
      sourceTable: source.sourceTable, sourceKey: source.sourceKey,
      membership: membershipByAnimal.get(source.animalId) ?? null,
    });
    sourcesByGroup.set(normalized, byAnimal);
  }
  for (const [normalized, sources] of sourcesByGroup) {
    const stats = groupStats.get(normalized) ?? { groupCode: normalized, normalizedGroupCode: normalized, impact: emptyImpact() };
    stats.impact.quarantineAnimalCount = [...sources.values()].filter((entry) => entry.lotId === quarantineLotId).length;
    groupStats.set(normalized, stats);
  }
  const currentScope = await resolveFieldScope(fieldId, access);
  if (!sameFieldScope(scope, currentScope)) return null;
  return { scope, lots, mappings, groupStats, sourcesByGroup, quarantineLotId, quarantineAnimalCount: quarantineAnimals.length };
}

async function buildReassignmentContext(input: ConfigurationFieldAccess & {
  fieldId: string;
  groupCode: string;
}): Promise<ReassignmentContext> {
  const context = await loadConfigurationContext(input.fieldId, input);
  if (!context) throw new CooprinsemConfigurationError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND");
  const groupCode = input.groupCode.trim();
  if (!groupCode) throw new CooprinsemConfigurationError("Falta el grupo que deseas reasignar.", "GROUP_CODE_REQUIRED");
  const normalizedGroupCode = normalizeCooprinsemGroupCode(groupCode);
  const mapping = context.mappings.find((entry) => entry.normalizedValue === normalizedGroupCode) ?? null;
  const targetLot = mapping ? context.lots.find((lot) => lot.id === mapping.lotId) ?? null : null;
  const candidates = [...(context.sourcesByGroup.get(normalizedGroupCode)?.values() ?? [])]
    .filter((entry) => entry.lotId === context.quarantineLotId)
    .sort((left, right) => left.tag.localeCompare(right.tag, "es", { numeric: true }));
  const blockers: string[] = [];
  if (!mapping) blockers.push("El grupo no tiene un lote activo configurado.");
  if (mapping && (!targetLot || targetLot.status !== "active" || targetLot.trackingMode !== "individual" || targetLot.id === context.quarantineLotId)) blockers.push("El lote configurado ya no es un destino individual activo.");
  if (candidates.length === 0) blockers.push("No hay animales de este grupo en el lote técnico.");
  const confirmationToken = await buildConfirmationToken("group-reassignment", {
    fieldId: input.fieldId,
    membershipId: input.membershipId,
    normalizedGroupCode,
    mappingId: mapping?.id ?? null,
    targetLotId: targetLot?.id ?? null,
    candidates: candidates.map((entry) => [entry.animalId, entry.importRowId, entry.membership?.id ?? null]),
  });
  if (!sameFieldScope(context.scope, await resolveFieldScope(input.fieldId, input))) throw stalePlanError();
  return {
    scope: context.scope,
    mapping,
    candidates,
    plan: {
      fieldId: input.fieldId,
      fieldName: context.scope.fieldName,
      groupCode: mapping?.value ?? groupCode,
      normalizedGroupCode,
      sourceLotId: context.quarantineLotId,
      sourceLotName: context.lots.find((lot) => lot.id === context.quarantineLotId)?.name ?? COOPRINSEM_QUARANTINE_LOT_NAME,
      targetLotId: targetLot?.id ?? null,
      targetLotName: targetLot?.name ?? null,
      candidateCount: candidates.length,
      candidates: candidates.slice(0, PREVIEW_LIMIT).map(toPublicQuarantineAnimal),
      rowsTruncated: candidates.length > PREVIEW_LIMIT,
      ready: blockers.length === 0,
      blockers,
      confirmationToken,
    },
  };
}

async function buildGenealogyPlan(scope: FieldScope, membershipId: string): Promise<CooprinsemGenealogyPlan> {
  return (await buildGenealogyContext(scope, membershipId)).plan;
}

async function buildGenealogyContext(
  scope: FieldScope,
  membershipId: string,
): Promise<{ plan: CooprinsemGenealogyPlan; workRows: GenealogyWorkRow[] }> {
  const db = getDb();
  const [unresolved, linked, animalRows, identifiers, animalSources] = await Promise.all([
    db.select({ offspring: livestockBirthOffspring, birth: livestockBirths })
      .from(livestockBirthOffspring).innerJoin(livestockBirths, eq(livestockBirths.id, livestockBirthOffspring.birthId))
      .where(and(eq(livestockBirths.fieldId, scope.fieldId), isNull(livestockBirthOffspring.animalId))),
    db.select({ animalId: livestockBirthOffspring.animalId })
      .from(livestockBirthOffspring).innerJoin(livestockBirths, eq(livestockBirths.id, livestockBirthOffspring.birthId))
      .where(and(eq(livestockBirths.fieldId, scope.fieldId), isNotNull(livestockBirthOffspring.animalId))),
    db.select({ animal: livestockAnimals })
      .from(livestockAnimals).innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId)).where(eq(livestockLots.fieldId, scope.fieldId)),
    db.select().from(livestockAnimalIdentifiers).where(and(eq(livestockAnimalIdentifiers.fieldId, scope.fieldId), isNull(livestockAnimalIdentifiers.validTo))),
    db.select({
      record: sourceRecords,
      organizationId: importJobs.organizationId,
      fieldId: importJobs.fieldId,
      jobSourceSystem: importJobs.sourceSystem,
      jobSourceTable: importJobs.sourceTable,
    })
      .from(sourceRecords).innerJoin(importJobs, eq(importJobs.id, sourceRecords.importJobId))
      .where(and(
        eq(sourceRecords.targetEntity, "livestock_animal"),
        eq(importJobs.organizationId, scope.organizationId),
        eq(importJobs.fieldId, scope.fieldId),
      ))
      .orderBy(asc(sourceRecords.createdAt), asc(sourceRecords.id)),
  ]);
  const animals = animalRows.map((row) => row.animal);
  const animalById = new Map(animals.map((animal) => [animal.id, animal]));
  const matchesByValue = new Map<string, Map<string, { animalId: string; tag: string; sex: "female" | "male" | "unknown"; birthDate: string | null; matchedBy: string[] }>>();
  const addMatch = (value: string, animalId: string, matchedBy: string) => {
    let normalized: string;
    try { normalized = normalizeExternalIdentifier(value); } catch { return; }
    const animal = animalById.get(animalId);
    if (!animal) return;
    const matches = matchesByValue.get(normalized) ?? new Map();
    const current = matches.get(animalId) ?? { ...animal, animalId, matchedBy: [] };
    current.matchedBy = [...new Set([...current.matchedBy, matchedBy])];
    matches.set(animalId, current);
    matchesByValue.set(normalized, matches);
  };
  for (const animal of animals) addMatch(animal.tag, animal.id, "tag");
  for (const identifier of identifiers) addMatch(identifier.value, identifier.animalId, identifier.kind);
  const linkedAnimalIds = new Set(linked.map((entry) => entry.animalId).filter((value): value is string => Boolean(value)));
  const sourceSnapshotByAnimal = new Map<string, GenealogySourceSnapshot>();
  for (const source of animalSources) {
    if (!sourceSnapshotByAnimal.has(source.record.targetId)) sourceSnapshotByAnimal.set(source.record.targetId, source);
  }
  const rawRows: GenealogyWorkRow[] = unresolved.map(({ offspring, birth }) => {
    let normalized = "";
    try { normalized = normalizeExternalIdentifier(offspring.temporaryIdentifier); } catch { /* handled as unmatched */ }
    const resolution = resolveGenealogyCandidate({
      damAnimalId: birth.damAnimalId,
      occurredAt: birth.occurredAt,
      sex: offspring.sex,
      matches: [...(matchesByValue.get(normalized)?.values() ?? [])],
    });
    if (resolution.candidateAnimalId && linkedAnimalIds.has(resolution.candidateAnimalId)) {
      resolution.status = "conflict";
      resolution.issues = ["El animal ya está enlazado como cría de otro parto."];
    }
    return {
      offspringId: offspring.id,
      birthId: birth.id,
      occurredAt: birth.occurredAt,
      damAnimalId: birth.damAnimalId,
      damTag: animalById.get(birth.damAnimalId)?.tag ?? birth.damAnimalId,
      temporaryIdentifier: offspring.temporaryIdentifier,
      sex: offspring.sex,
      ...resolution,
      offspringSnapshot: offspring,
      birthSnapshot: birth,
      candidateSnapshot: resolution.candidateAnimalId ? animalById.get(resolution.candidateAnimalId) ?? null : null,
      sourceSnapshot: resolution.candidateAnimalId ? sourceSnapshotByAnimal.get(resolution.candidateAnimalId) ?? null : null,
    };
  });
  const workRows = markDuplicateGenealogyCandidates(rawRows) as GenealogyWorkRow[];
  const readyRows = workRows.filter((row) => row.status === "ready" && row.candidateAnimalId);
  const confirmationToken = await buildConfirmationToken("genealogy-reconciliation", {
    fieldId: scope.fieldId,
    membershipId,
    links: readyRows.map((row) => [row.offspringId, row.candidateAnimalId]),
  });
  const plan: CooprinsemGenealogyPlan = {
    fieldId: scope.fieldId,
    fieldName: scope.fieldName,
    ready: readyRows.length > 0,
    summary: {
      unresolvedCount: workRows.length,
      readyCount: readyRows.length,
      unmatchedCount: workRows.filter((row) => row.status === "unmatched").length,
      conflictCount: workRows.filter((row) => row.status === "conflict").length,
    },
    rows: workRows.slice(0, PREVIEW_LIMIT).map(toPublicGenealogyRow),
    rowsTruncated: workRows.length > PREVIEW_LIMIT,
    confirmationToken,
  };
  return { plan, workRows };
}

function mappingItem(mapping: typeof livestockLotExternalIdentifiers.$inferSelect, lotName: string, impact: CooprinsemGroupImpact): CooprinsemGroupMappingItem {
  return {
    id: mapping.id,
    groupCode: mapping.value,
    normalizedGroupCode: mapping.normalizedValue,
    lotId: mapping.lotId,
    lotName,
    validFrom: mapping.validFrom,
    impact,
  };
}

function impactFor(context: ConfigurationContext, normalizedGroupCode: string): CooprinsemGroupImpact {
  return context.groupStats.get(normalizedGroupCode)?.impact ?? emptyImpact();
}

function emptyImpact(): CooprinsemGroupImpact {
  return { stagedRowCount: 0, pendingRowCount: 0, importedRowCount: 0, quarantineAnimalCount: 0 };
}

function groupValue(record: ImportRecord | null): string | null {
  const value = record?.GRUPO;
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function toPublicQuarantineAnimal(entry: GroupAnimalSource): CooprinsemQuarantineAnimal {
  return {
    animalId: entry.animalId,
    tag: entry.tag,
    importJobId: entry.importJobId,
    importRowId: entry.importRowId,
    sourceTable: entry.sourceTable,
    sourceKey: entry.sourceKey,
  };
}

function toPublicGenealogyRow(row: GenealogyWorkRow): CooprinsemGenealogyResolutionRow {
  return {
    offspringId: row.offspringId,
    birthId: row.birthId,
    occurredAt: row.occurredAt,
    damAnimalId: row.damAnimalId,
    damTag: row.damTag,
    temporaryIdentifier: row.temporaryIdentifier,
    sex: row.sex,
    status: row.status,
    candidateAnimalId: row.candidateAnimalId,
    candidateTag: row.candidateTag,
    matchedBy: row.matchedBy,
    issues: row.issues,
  };
}

function stalePlanError() {
  return new CooprinsemConfigurationError("La información cambió desde la simulación. Recalcula el plan antes de confirmar.", "CONFIGURATION_PLAN_STALE");
}

function requireConfigurationAccess(
  input: ConfigurationFieldAccess,
): NormalizedCooprinsemActorFieldAccess {
  const access = normalizeConfigurationAccess(input);
  if (!access) throw stalePlanError();
  return access;
}

function confirmationDigest(token: string): string {
  const digest = token.slice(token.lastIndexOf(":") + 1);
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("El token de confirmación no contiene una evidencia SHA-256 válida.");
  return digest;
}
