import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, FUNDOSMART_BACKUP_FORMAT, sha256Hex } from "../src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import {
  applyInsertOnlyRestoreSimulation,
  RESTORE_SECTION_TABLES,
} from "../src/modules/integraciones/cooprinsem/server/isolated-restore-writer.mjs";
import {
  buildPortableRestorePlan,
  portableRestoreOriginalInventory,
  PortableBackupValidationError,
  SECTION_KEY_FIELDS,
  validatePortableBackup,
} from "../src/modules/integraciones/cooprinsem/server/restore-rules.mjs";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";

const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/restauracion/route.ts", import.meta.url), "utf8");
const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/backup-repository.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");
const ISOLATED_GUARD = { target: "isolated_sqlite_memory", productWritesEnabled: false };

test("acepta un respaldo portable íntegro y rechaza una sección alterada", async () => {
  const backup = await sampleBackup({
    fields: [{ id: "field-1", organization_id: "org-fundosmart", name: "Fundo Uno" }],
    livestockAnimals: [{ id: "animal-1", lot_id: "lot-1", tag: "101" }],
  });
  assert.equal((await validatePortableBackup(backup)).manifest.format, FUNDOSMART_BACKUP_FORMAT);
  backup.data.livestockAnimals[0].tag = "alterado";
  await assert.rejects(
    () => validatePortableBackup(backup),
    (cause) => cause instanceof PortableBackupValidationError && cause.issues.some((issue) => issue.includes("huella")),
  );
});

test("rechaza liquidaciones inválidas aunque el respaldo tenga conteos y hashes correctos", async () => {
  const fields = [{ id: "field-1", organization_id: "org-fundosmart", name: "Fundo Uno" }];
  const validData = { fields, milkSettlements: [portableMilkSettlement()] };
  const validBackup = await sampleBackup(validData);
  const validPlan = buildPortableRestorePlan(await validatePortableBackup(validBackup), {
    fields: structuredClone(fields),
  });
  assert.equal(validPlan.assessment, "ready");
  assert.equal(validPlan.totals.insertableRowCount, 1);
  assert.equal(validPlan.totals.referenceIssueCount, 0);
  assert.deepEqual(validPlan.blockers, []);

  const cases = [
    [{ period: "2026-13" }, /período/iu],
    [{ generated_at: "2026-02-30T12:00:00.000Z" }, /fecha.*emisión/iu],
    [{ liters_first_half: -1, liters_second_half: 1001 }, /primera.*quincena/iu],
    [{ liters_second_half: 499 }, /quincena/iu],
    [{ tax_amount_clp: -1 }, /IVA/iu],
    [{ gross_amount_clp: 1 }, /total.*neto.*IVA/iu],
    [{ net_price_per_liter_clp: 1 }, /precio neto.*litro/iu],
    [{ gross_price_per_liter_clp: 1 }, /precio bruto.*litro/iu],
    [{ line_items: [{ label: "Leche", amountClp: 300000 }] }, /descripción/iu],
    [{
      line_items: [{
        description: "Leche",
        measurement: null,
        unitPriceClp: null,
        amountClp: 1,
      }],
    }, /suma.*líneas.*detalle/iu],
    [{ created_at: "bad-date" }, /versión temporal/iu],
    [{ updated_at: "2026-02-30T12:00:00.000Z" }, /versión temporal/iu],
  ];
  for (const [overrides, expected] of cases) {
    const backup = await sampleBackup({
      fields,
      milkSettlements: [portableMilkSettlement(overrides)],
    });
    await assert.rejects(
      () => validatePortableBackup(backup),
      (cause) => cause instanceof PortableBackupValidationError
        && cause.code === "PORTABLE_BACKUP_INVALID"
        && cause.issues.some(
          (issue) => issue.includes("milkSettlements[0]") && expected.test(issue),
        ),
    );
  }
});

test("el plan revalida liquidaciones mutadas después de validar y nunca declara ready", async () => {
  const fields = [{ id: "field-1", organization_id: "org-fundosmart", name: "Fundo Uno" }];
  const backup = await sampleBackup({ fields, milkSettlements: [portableMilkSettlement()] });
  const validated = await validatePortableBackup(backup);
  validated.data.milkSettlements[0].gross_amount_clp = 1;

  assert.throws(
    () => buildPortableRestorePlan(validated, { fields: structuredClone(fields) }),
    (cause) => cause instanceof PortableBackupValidationError
      && cause.code === "PORTABLE_BACKUP_INVALID"
      && cause.issues.some((issue) => issue.includes("milkSettlements[0]") && /neto.*IVA/iu.test(issue)),
  );
});

test("el plan rechaza data ausente o secciones mutadas con un error portable controlado", () => {
  for (const backup of [
    {},
    { data: {} },
    { data: { milkSettlements: { id: "settlement-not-an-array" } } },
  ]) {
    assert.throws(
      () => buildPortableRestorePlan(backup, {}),
      (cause) => cause instanceof PortableBackupValidationError
        && cause.code === "PORTABLE_BACKUP_INVALID"
        && cause.issues.length > 0,
    );
  }
});

test("detecta filas insertables, idénticas y conflictivas sin habilitar escritura", async () => {
  const backup = await sampleBackup({
    livestockAnimals: [
      { id: "same", lot_id: "lot-1", tag: "101" },
      { id: "new", lot_id: "lot-1", tag: "102" },
      { id: "changed", lot_id: "lot-1", tag: "103" },
    ],
  });
  const plan = buildPortableRestorePlan(await validatePortableBackup(backup), {
    livestockLots: [{ id: "lot-1", field_id: "field-1" }],
    livestockAnimals: [
      { id: "same", lot_id: "lot-1", tag: "101" },
      { id: "changed", lot_id: "lot-1", tag: "otro" },
    ],
  });
  assert.equal(plan.assessment, "conflicts");
  assert.equal(plan.writeEnabled, false);
  assert.equal(plan.totals.insertableRowCount, 1);
  assert.equal(plan.totals.unchangedRowCount, 1);
  assert.equal(plan.totals.conflictRowCount, 1);
  assert.equal(plan.conflicts[0].key, "changed");
});

test("un respaldo ya presente produce una simulación sin cambios", async () => {
  const data = {
    fields: [{ id: "field-1", organization_id: "org-fundosmart", name: "Fundo Uno" }],
    importJobs: [{ id: "job-1", field_id: "field-1", organization_id: "org-fundosmart", sha256: "a".repeat(64), file_size_bytes: 0 }],
    importRows: [{ id: "row-1", import_job_id: "job-1", record_number: 1, raw_record: { RP: "001" } }],
  };
  const backup = await sampleBackup(data, "import", "job-1");
  const plan = buildPortableRestorePlan(await validatePortableBackup(backup), data);
  assert.equal(plan.assessment, "no_changes");
  assert.equal(plan.totals.unchangedRowCount, 3);
  assert.equal(plan.blockers.length, 0);
});

test("bloquea referencias huérfanas aunque las claves primarias sean nuevas", async () => {
  const backup = await sampleBackup({ livestockAnimals: [{ id: "animal-1", lot_id: "missing-lot", tag: "101" }] });
  const plan = buildPortableRestorePlan(await validatePortableBackup(backup), {});
  assert.equal(plan.assessment, "conflicts");
  assert.equal(plan.totals.referenceIssueCount, 1);
  assert.match(plan.blockers[0], /referencia/);
});

test("verifica también el destino semántico de source_records", async () => {
  const backup = await sampleBackup({
    fields: [{ id: "field-1", organization_id: "org-fundosmart" }],
    importJobs: [{ id: "job-1", organization_id: "org-fundosmart", field_id: "field-1", sha256: "a".repeat(64), file_size_bytes: 0 }],
    importRows: [{ id: "row-1", import_job_id: "job-1" }],
    sourceRecords: [{ id: "source-1", import_job_id: "job-1", import_row_id: "row-1", target_entity: "livestock_animal", target_id: "missing-animal" }],
  }, "import", "job-1");
  const plan = buildPortableRestorePlan(await validatePortableBackup(backup), {});
  assert.equal(plan.assessment, "conflicts");
  assert.equal(plan.totals.referenceIssueCount, 1);
  assert.match(plan.conflicts[0].reason, /livestockAnimals/);
});

test("resuelve controles lecheros de source_records y bloquea un destino huérfano", async () => {
  const data = {
    fields: [{ id: "field-1", organization_id: "org-fundosmart" }],
    livestockLots: [{ id: "lot-1", field_id: "field-1" }],
    livestockAnimals: [{ id: "animal-1", lot_id: "lot-1" }],
    importJobs: [{
      id: "job-1",
      organization_id: "org-fundosmart",
      field_id: "field-1",
      sha256: "a".repeat(64),
      file_size_bytes: 0,
    }],
    importRows: [{ id: "row-1", import_job_id: "job-1" }],
    sourceRecords: [{
      id: "source-control-1",
      import_job_id: "job-1",
      import_row_id: "row-1",
      target_entity: "livestock_milk_control",
      target_id: "control-1",
    }],
    livestockMilkControls: [{
      id: "control-1",
      field_id: "field-1",
      animal_id: "animal-1",
      lactation_id: null,
      source_record_id: "source-control-1",
    }],
  };
  const validBackup = await sampleBackup(data);
  const validPlan = buildPortableRestorePlan(
    await validatePortableBackup(validBackup),
    {},
  );
  assert.equal(validPlan.assessment, "ready");
  assert.equal(validPlan.totals.referenceIssueCount, 0);
  assert.deepEqual(validPlan.blockers, []);

  const orphanedData = structuredClone(data);
  orphanedData.sourceRecords[0].target_id = "missing-control";
  const orphanedBackup = await sampleBackup(orphanedData);
  const orphanedPlan = buildPortableRestorePlan(
    await validatePortableBackup(orphanedBackup),
    {},
  );
  assert.equal(orphanedPlan.assessment, "conflicts");
  assert.equal(orphanedPlan.totals.referenceIssueCount, 1);
  assert.match(orphanedPlan.conflicts.at(-1).reason, /livestockMilkControls/);
});

test("el inventario de originales exige correspondencia exacta con importJobs", async () => {
  const backup = await sampleBackup({
    importJobs: [{ id: "job-1", sha256: "a".repeat(64), file_size_bytes: 12 }],
  });
  const validated = await validatePortableBackup(backup);
  assert.deepEqual(portableRestoreOriginalInventory(validated), [
    { importJobId: "job-1", sha256: "a".repeat(64), fileSizeBytes: 12 },
  ]);
  backup.manifest.originalFiles[0].fileSizeBytes = 13;
  await assert.rejects(() => validatePortableBackup(backup), /tamaño del original job-1 no coincide/i);
});

test("el contrato v1 admite las siete secciones nuevas sin volverlas obligatorias para respaldos antiguos", async () => {
  const legacy = await sampleBackup({
    fields: [{ id: "field-1", organization_id: "org-fundosmart", name: "Fundo Uno" }],
  });
  const legacyPlan = buildPortableRestorePlan(await validatePortableBackup(legacy), {});
  assert.equal(legacyPlan.assessment, "ready");
  assert.equal(legacyPlan.blockers.length, 0);

  assert.deepEqual({
    paddockNdvi: SECTION_KEY_FIELDS.paddockNdvi,
    paddockCellOperations: SECTION_KEY_FIELDS.paddockCellOperations,
    paddockCells: SECTION_KEY_FIELDS.paddockCells,
    paddockRotationSettingOperations: SECTION_KEY_FIELDS.paddockRotationSettingOperations,
    paddockRotationSettings: SECTION_KEY_FIELDS.paddockRotationSettings,
    fieldLandmarkOperations: SECTION_KEY_FIELDS.fieldLandmarkOperations,
    fieldLandmarks: SECTION_KEY_FIELDS.fieldLandmarks,
  }, {
    paddockNdvi: "id",
    paddockCellOperations: "id",
    paddockCells: "id",
    paddockRotationSettingOperations: "id",
    paddockRotationSettings: "field_id",
    fieldLandmarkOperations: "id",
    fieldLandmarks: "id",
  });
  assert.deepEqual({
    paddockNdvi: RESTORE_SECTION_TABLES.paddockNdvi,
    paddockCellOperations: RESTORE_SECTION_TABLES.paddockCellOperations,
    paddockCells: RESTORE_SECTION_TABLES.paddockCells,
    paddockRotationSettingOperations: RESTORE_SECTION_TABLES.paddockRotationSettingOperations,
    paddockRotationSettings: RESTORE_SECTION_TABLES.paddockRotationSettings,
    fieldLandmarkOperations: RESTORE_SECTION_TABLES.fieldLandmarkOperations,
    fieldLandmarks: RESTORE_SECTION_TABLES.fieldLandmarks,
  }, {
    paddockNdvi: "paddock_ndvi",
    paddockCellOperations: "paddock_cell_operations",
    paddockCells: "paddock_cells",
    paddockRotationSettingOperations: "paddock_rotation_setting_operations",
    paddockRotationSettings: "paddock_rotation_settings",
    fieldLandmarkOperations: "field_landmark_operations",
    fieldLandmarks: "field_landmarks",
  });
  assert.ok(Object.keys(RESTORE_SECTION_TABLES).indexOf("paddocks") < Object.keys(RESTORE_SECTION_TABLES).indexOf("paddockNdvi"));
});

test("el plan bloquea scope ajeno, claves duplicadas y referencias operacionales ausentes", async () => {
  const validData = portablePaddockData();
  const validBackup = await sampleBackup(validData);
  const validPlan = buildPortableRestorePlan(await validatePortableBackup(validBackup), portableCurrentScope(validData));
  assert.equal(validPlan.assessment, "ready");
  assert.equal(validPlan.totals.referenceIssueCount, 0);

  const missingCloseData = structuredClone(validData);
  missingCloseData.paddockCellOperations = missingCloseData.paddockCellOperations
    .filter((operation) => operation.id !== "cell-operation-close");
  const missingClose = await sampleBackup(missingCloseData);
  const missingClosePlan = buildPortableRestorePlan(
    await validatePortableBackup(missingClose),
    portableCurrentScope(missingCloseData),
  );
  assert.equal(missingClosePlan.assessment, "conflicts");
  assert.match(missingClosePlan.conflicts.map((conflict) => conflict.reason).join(" "), /closed_by_operation_id/iu);

  const orphanNdviData = structuredClone(validData);
  orphanNdviData.paddockNdvi[0].paddock_id = "paddock-missing";
  const orphanNdvi = await sampleBackup(orphanNdviData);
  const orphanNdviPlan = buildPortableRestorePlan(
    await validatePortableBackup(orphanNdvi),
    portableCurrentScope(orphanNdviData),
  );
  assert.equal(orphanNdviPlan.assessment, "conflicts");
  assert.match(orphanNdviPlan.conflicts.map((conflict) => conflict.reason).join(" "), /paddock_id/iu);

  const orphanLandmarkOperationData = structuredClone(validData);
  orphanLandmarkOperationData.fieldLandmarkOperations[0].landmark_id = "landmark-missing";
  const orphanLandmarkOperation = await sampleBackup(orphanLandmarkOperationData);
  const orphanLandmarkOperationPlan = buildPortableRestorePlan(
    await validatePortableBackup(orphanLandmarkOperation),
    portableCurrentScope(orphanLandmarkOperationData),
  );
  assert.equal(orphanLandmarkOperationPlan.assessment, "conflicts");
  assert.match(orphanLandmarkOperationPlan.conflicts.map((conflict) => conflict.reason).join(" "), /landmark_id/iu);

  const wrongTenantData = structuredClone(validData);
  wrongTenantData.paddockNdvi[0].organization_id = "org-ajena";
  const wrongTenant = await sampleBackup(wrongTenantData);
  const wrongTenantPlan = buildPortableRestorePlan(
    await validatePortableBackup(wrongTenant),
    portableCurrentScope(wrongTenantData),
  );
  assert.equal(wrongTenantPlan.assessment, "conflicts");
  assert.match(wrongTenantPlan.conflicts.map((conflict) => conflict.reason).join(" "), /organizationId/iu);

  const duplicateData = structuredClone(validData);
  duplicateData.paddockNdvi.push(structuredClone(duplicateData.paddockNdvi[0]));
  const duplicate = await sampleBackup(duplicateData);
  const duplicatePlan = buildPortableRestorePlan(await validatePortableBackup(duplicate), portableCurrentScope(duplicateData));
  assert.equal(duplicatePlan.assessment, "conflicts");
  assert.match(duplicatePlan.conflicts.map((conflict) => conflict.reason).join(" "), /duplicada/iu);
});

test("el writer aislado ordena operaciones antes de filas, conserva historia y canonicaliza JSON", async () => {
  const data = portablePaddockData();
  const backup = await sampleBackup(data);
  const currentData = portableCurrentScope(data);
  const validated = await validatePortableBackup(backup);
  const plan = buildPortableRestorePlan(validated, currentData);
  const database = isolatedPaddockDatabase();

  const result = applyInsertOnlyRestoreSimulation(database, {
    backup: validated,
    currentData,
    plan,
    guard: ISOLATED_GUARD,
  });
  assert.equal(result.insertedRowCount, 11);
  assert.deepEqual(result.sections.filter((section) => section.insertedRowCount > 0).map((section) => section.section), [
    "paddockNdvi",
    "paddockCellOperations",
    "paddockCells",
    "paddockRotationSettingOperations",
    "paddockRotationSettings",
    "fieldLandmarkOperations",
    "fieldLandmarks",
  ]);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM paddock_ndvi").get().count, 2);
  assert.equal(database.prepare("SELECT mean_ndvi FROM paddock_ndvi WHERE id = 'ndvi-archived'").get().mean_ndvi, null);
  assert.equal(
    database.prepare("SELECT geometry_snapshot FROM paddock_ndvi WHERE id = 'ndvi-active'").get().geometry_snapshot,
    canonicalJson(data.paddockNdvi[0].geometry_snapshot),
  );
  assert.equal(
    database.prepare("SELECT paddock_snapshot FROM paddock_ndvi WHERE id = 'ndvi-archived'").get().paddock_snapshot,
    canonicalJson(data.paddockNdvi[1].paddock_snapshot),
  );
  assert.equal(
    database.prepare("SELECT geometry_snapshot_token FROM paddock_ndvi WHERE id = 'ndvi-archived'").get().geometry_snapshot_token,
    data.paddockNdvi[1].geometry_snapshot_token,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM paddock_cells WHERE active_to IS NULL").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM paddock_cells WHERE closed_by_operation_id IS NOT NULL").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM paddock_cell_operations").get().count, 2);
  assert.equal(database.prepare("SELECT recent_days FROM paddock_rotation_settings WHERE field_id = 'field-1'").get().recent_days, 12);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations").get().count, 2);
  assert.equal(database.prepare("SELECT deleted_at FROM field_landmarks WHERE id = 'landmark-1'").get().deleted_at, "2026-07-19T16:00:00.000Z");
  assert.equal(
    database.prepare("SELECT request FROM paddock_cell_operations WHERE id = 'cell-operation-create'").get().request,
    canonicalJson(data.paddockCellOperations[0].request),
  );
  assert.equal(
    database.prepare("SELECT geometry FROM field_landmarks WHERE id = 'landmark-1'").get().geometry,
    canonicalJson(data.fieldLandmarks[0].geometry),
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  database.close();
});

test("el writer revierte carreras de claves y drift de columnas sin filas parciales", async () => {
  const data = portablePaddockData();
  const backup = await sampleBackup(data);
  const currentData = portableCurrentScope(data);
  const validated = await validatePortableBackup(backup);
  const plan = buildPortableRestorePlan(validated, currentData);
  const racedDatabase = isolatedPaddockDatabase();
  insertPaddockNdviRow(racedDatabase, data.paddockNdvi[1]);
  assert.throws(
    () => applyInsertOnlyRestoreSimulation(racedDatabase, {
      backup: validated, currentData, plan, guard: ISOLATED_GUARD,
    }),
    /UNIQUE|constraint/iu,
  );
  assert.equal(racedDatabase.prepare("SELECT COUNT(*) AS count FROM paddock_ndvi").get().count, 1);
  assert.equal(racedDatabase.prepare("SELECT COUNT(*) AS count FROM paddock_ndvi WHERE id = 'ndvi-active'").get().count, 0);
  assert.equal(
    racedDatabase.prepare("SELECT geometry_snapshot_token FROM paddock_ndvi WHERE id = 'ndvi-archived'").get().geometry_snapshot_token,
    "geometry-token-archived",
  );
  assert.equal(racedDatabase.prepare("SELECT COUNT(*) AS count FROM paddock_cells").get().count, 0);
  assert.equal(racedDatabase.prepare("SELECT COUNT(*) AS count FROM field_landmarks").get().count, 0);
  racedDatabase.close();

  const driftData = portablePaddockData();
  driftData.paddockNdvi[0].unexpected_column = "drift";
  const driftBackup = await sampleBackup(driftData);
  const driftValidated = await validatePortableBackup(driftBackup);
  const driftCurrentData = portableCurrentScope(driftData);
  const driftPlan = buildPortableRestorePlan(driftValidated, driftCurrentData);
  const driftDatabase = isolatedPaddockDatabase();
  assert.throws(
    () => applyInsertOnlyRestoreSimulation(driftDatabase, {
      backup: driftValidated,
      currentData: driftCurrentData,
      plan: driftPlan,
      guard: ISOLATED_GUARD,
    }),
    /columnas ajenas/iu,
  );
  assert.equal(driftDatabase.prepare("SELECT COUNT(*) AS count FROM paddock_ndvi").get().count, 0);
  assert.equal(driftDatabase.prepare("SELECT COUNT(*) AS count FROM paddock_cell_operations").get().count, 0);
  assert.equal(driftDatabase.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations").get().count, 0);
  driftDatabase.close();
});

test("el writer aislado revalida liquidaciones si el respaldo cambia después del plan", async () => {
  const fields = [{ id: "field-1", organization_id: "org-fundosmart", name: "Fundo Uno" }];
  const backup = await sampleBackup({ fields, milkSettlements: [portableMilkSettlement()] });
  const currentData = { fields: structuredClone(fields) };
  const validated = await validatePortableBackup(backup);
  const plan = buildPortableRestorePlan(validated, currentData);
  const database = isolatedMilkDatabase();

  validated.data.milkSettlements[0].net_price_per_liter_clp = 1;
  assert.throws(
    () => applyInsertOnlyRestoreSimulation(database, {
      backup: validated,
      currentData,
      plan,
      guard: ISOLATED_GUARD,
    }),
    /precio neto.*litro/iu,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM milk_settlements").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM fields").get().count, 1);
  database.close();
});

test("la API compara y prepara un ensayo bloqueado dentro del fundo autorizado", () => {
  assert.match(route, /prepare_confirmation/);
  assert.match(route, /prepare_recovery/);
  assert.match(route, /"manage_imports"\s*:\s*"restore_data"/);
  assert.match(route, /requireContextField\(access, backup\.manifest\.scope\.fieldId\)/);
  assert.match(route, /organizationId !== access\.organizationId/);
  assert.match(route, /MAX_BACKUP_BYTES/);
  assert.match(route, /buildPortableRestorePlan/);
  assert.match(route, /organizationId: access\.organizationId/);
  assert.match(route, /fieldIds: access\.fieldIds/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /email: access\.email/);
  assert.match(route, /const audited = await recordRestorePreview/);
  assert.match(route, /if \(!audited\)/);
  assert.match(route, /issueRestoreConfirmation/);
  assert.match(route, /prepareDurableRecoveryJob/);
  assert.match(route, /matchesRestorePreparationPhrase/);
  assert.doesNotMatch(route, /insert\(|update\(|delete\(/);
  assert.match(repository, /backup\.restore\.previewed/);
  assert.match(page, /Ejecutar dry-run/);
  assert.match(page, /Escritura deshabilitada/);
  assert.match(page, /Confirmar ensayo durable/);
  assert.match(page, /ejecución deshabilitada/);
});

async function sampleBackup(data, scopeType = "field", id = "field-1") {
  const entries = Object.entries(data);
  const sectionSha256 = Object.fromEntries(await Promise.all(entries.map(async ([section, rows]) => [section, await sha256Hex(canonicalJson(rows))])));
  return {
    manifest: {
      format: FUNDOSMART_BACKUP_FORMAT,
      generatedAt: "2026-07-18T03:00:00.000Z",
      generatedBy: "owner@example.com",
      encoding: "UTF-8 JSON",
      scope: {
        type: scopeType,
        id,
        name: scopeType === "field" ? "Fundo Uno" : "carga.dbf",
        organizationId: "org-fundosmart",
        organizationName: "FundoSmart",
        fieldId: "field-1",
        fieldName: "Fundo Uno",
      },
      recordCounts: Object.fromEntries(entries.map(([section, rows]) => [section, rows.length])),
      sectionSha256,
      originalFiles: (data.importJobs ?? []).map((job) => ({
        importJobId: job.id,
        sha256: job.sha256,
        fileSizeBytes: job.file_size_bytes,
      })),
      excluded: [],
    },
    data,
  };
}

function portableMilkSettlement(overrides = {}) {
  return {
    id: "settlement-restore",
    field_id: "field-1",
    period: "2026-06",
    generated_at: "2026-06-30T12:00:00.000Z",
    plant: "Planta",
    purchase_order: "OC-RESTORE",
    producer_code: "P1",
    producer_name: "Productor",
    buyer_name: "Comprador",
    liters_first_half: 500,
    liters_second_half: 500,
    total_liters: 1000,
    net_amount_clp: 300000,
    tax_amount_clp: 57000,
    gross_amount_clp: 357000,
    net_price_per_liter_clp: 300,
    gross_price_per_liter_clp: 357,
    source_document_name: "liquidacion.pdf",
    notes: "",
    line_items: [{
      description: "Leche",
      measurement: "1.000 L",
      unitPriceClp: 300,
      amountClp: 300000,
    }],
    created_at: "2026-07-18T03:00:00.000Z",
    updated_at: "2026-07-18T03:00:00.000Z",
    ...overrides,
  };
}

function portablePaddockData() {
  const fieldId = "field-1";
  const organizationId = "org-fundosmart";
  const paddockId = "paddock-1";
  return {
    fields: [{ id: fieldId, organization_id: organizationId }],
    paddocks: [
      { id: paddockId, field_id: fieldId, archived_at: null },
      { id: "paddock-archived", field_id: fieldId, archived_at: "2026-07-10T12:00:00.000Z" },
    ],
    paddockNdvi: [
      {
        id: "ndvi-active",
        organization_id: organizationId,
        field_id: fieldId,
        paddock_id: paddockId,
        month: "2026-07-01",
        status: "ok",
        mean_ndvi: 0.62,
        no_data_reason: null,
        cloud_pct: 14,
        cloud_pct_is_approximate: true,
        interval_from: "2026-07-01T00:00:00.000Z",
        interval_to: "2026-08-01T00:00:00.000Z",
        observed_at: "2026-07-18T12:00:00.000Z",
        sample_count: 2,
        no_data_count: 0,
        valid_sample_count: 2,
        computed_at: "2026-07-19T12:00:00.000Z",
        geometry_snapshot: { outer: [[-40.57, -73.14], [-40.57, -73.13], [-40.56, -73.13]], holes: [] },
        paddock_snapshot: { archivedAt: null, id: paddockId, name: "Potrero activo" },
        geometry_snapshot_token: "geometry-token-active",
      },
      {
        id: "ndvi-archived",
        organization_id: organizationId,
        field_id: fieldId,
        paddock_id: "paddock-archived",
        month: "2026-07-01",
        status: "no_data",
        mean_ndvi: null,
        no_data_reason: "no_intervals",
        cloud_pct: null,
        cloud_pct_is_approximate: false,
        interval_from: "2026-07-01T00:00:00.000Z",
        interval_to: "2026-08-01T00:00:00.000Z",
        observed_at: null,
        sample_count: 0,
        no_data_count: 0,
        valid_sample_count: 0,
        computed_at: "2026-07-19T12:05:00.000Z",
        geometry_snapshot: [[-40.6, -73.2], [-40.6, -73.19], [-40.59, -73.19]],
        paddock_snapshot: {
          archivedAt: "2026-07-10T12:00:00.000Z",
          id: "paddock-archived",
          name: "Potrero archivado",
        },
        geometry_snapshot_token: "geometry-token-archived",
      },
    ],
    paddockCells: [
      {
        id: "cell-active",
        field_id: fieldId,
        paddock_id: paddockId,
        name: "Franja activa",
        cell_index: 1,
        coordinates: { outer: [[-40.57, -73.14], [-40.57, -73.13], [-40.56, -73.13]], holes: [] },
        area_square_meters: 25_000,
        start_distance_meters: 0,
        end_distance_meters: 100,
        active_from: "2026-07-19T15:00:00.000Z",
        active_to: null,
        version: 1,
        created_by_operation_id: "cell-operation-create",
        closed_by_operation_id: null,
      },
      {
        id: "cell-historical",
        field_id: fieldId,
        paddock_id: paddockId,
        name: "Franja historica",
        cell_index: 2,
        coordinates: { outer: [[-40.56, -73.14], [-40.56, -73.13], [-40.55, -73.13]], holes: [] },
        area_square_meters: 25_000,
        start_distance_meters: 100,
        end_distance_meters: 200,
        active_from: "2026-07-19T15:00:00.000Z",
        active_to: "2026-07-19T15:30:00.000Z",
        version: 2,
        created_by_operation_id: "cell-operation-create",
        closed_by_operation_id: "cell-operation-close",
      },
    ],
    fieldLandmarks: [{
      id: "landmark-1",
      field_id: fieldId,
      kind: "bebedero",
      geometry_type: "point",
      geometry: [[-40.57, -73.14]],
      name: "Bebedero historico",
      notes: "Reemplazado",
      length_meters: 0,
      created_at: "2026-07-19T15:40:00.000Z",
      updated_at: "2026-07-19T16:00:00.000Z",
      deleted_at: "2026-07-19T16:00:00.000Z",
      version: 2,
      last_operation_id: "landmark-operation-delete",
    }],
    paddockRotationSettings: [{
      field_id: fieldId,
      recent_days: 12,
      long_rest_days: 28,
      version: 1,
    }],
    fieldLandmarkOperations: [
      {
        id: "landmark-operation-create",
        organization_id: organizationId,
        field_id: fieldId,
        landmark_id: "landmark-1",
        kind: "create",
        request_hash: "landmark-create-hash",
        expected_version: null,
        request: { name: "Bebedero historico" },
        result: { version: 1 },
        actor: "owner@example.com",
        committed_at: "2026-07-19T15:40:00.000Z",
      },
      {
        id: "landmark-operation-delete",
        organization_id: organizationId,
        field_id: fieldId,
        landmark_id: "landmark-1",
        kind: "delete",
        request_hash: "landmark-delete-hash",
        expected_version: 1,
        request: { reason: "reemplazado" },
        result: { version: 2 },
        actor: "owner@example.com",
        committed_at: "2026-07-19T16:00:00.000Z",
      },
    ],
    paddockCellOperations: [
      {
        id: "cell-operation-create",
        organization_id: organizationId,
        field_id: fieldId,
        paddock_id: paddockId,
        kind: "create",
        request_hash: "cell-create-hash",
        snapshot_token: "cell-create-snapshot",
        request: { cellCount: 2, direction: { from: [-40.57, -73.14], to: [-40.57, -73.13] } },
        result: { createdCellIds: ["cell-active", "cell-historical"] },
        actor: "owner@example.com",
        committed_at: "2026-07-19T15:00:00.000Z",
      },
      {
        id: "cell-operation-close",
        organization_id: organizationId,
        field_id: fieldId,
        paddock_id: paddockId,
        kind: "close",
        request_hash: "cell-close-hash",
        snapshot_token: "cell-close-snapshot",
        request: { reason: "rotacion completada" },
        result: { closedCellIds: ["cell-historical"] },
        actor: "owner@example.com",
        committed_at: "2026-07-19T15:30:00.000Z",
      },
    ],
    paddockRotationSettingOperations: [{
      id: "rotation-operation-1",
      organization_id: organizationId,
      field_id: fieldId,
      request_hash: "rotation-hash",
      expected_version: null,
      result: { recentDays: 12, longRestDays: 28, version: 1 },
      actor: "owner@example.com",
      committed_at: "2026-07-19T15:35:00.000Z",
    }],
  };
}

function portableCurrentScope(data) {
  return { fields: structuredClone(data.fields), paddocks: structuredClone(data.paddocks) };
}

function insertPaddockNdviRow(database, row) {
  database.prepare(`
    INSERT INTO paddock_ndvi (
      id, organization_id, field_id, paddock_id, month, status, mean_ndvi,
      no_data_reason, cloud_pct, cloud_pct_is_approximate, interval_from,
      interval_to, observed_at, sample_count, no_data_count, valid_sample_count,
      computed_at, geometry_snapshot, paddock_snapshot, geometry_snapshot_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.id,
    row.organization_id,
    row.field_id,
    row.paddock_id,
    row.month,
    row.status,
    row.mean_ndvi,
    row.no_data_reason,
    row.cloud_pct,
    row.cloud_pct_is_approximate ? 1 : 0,
    row.interval_from,
    row.interval_to,
    row.observed_at,
    row.sample_count,
    row.no_data_count,
    row.valid_sample_count,
    row.computed_at,
    canonicalJson(row.geometry_snapshot),
    canonicalJson(row.paddock_snapshot),
    row.geometry_snapshot_token,
  );
}

function isolatedPaddockDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
    CREATE TABLE fields (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL,
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    );
    CREATE TABLE potreros (
      id TEXT PRIMARY KEY NOT NULL,
      field_id TEXT NOT NULL,
      archived_at TEXT,
      FOREIGN KEY (field_id) REFERENCES fields(id)
    );
    CREATE UNIQUE INDEX fields_organization_id_unique ON fields (organization_id, id);
    CREATE UNIQUE INDEX potreros_field_id_unique ON potreros (field_id, id);
    INSERT INTO organizations (id) VALUES ('org-fundosmart');
    INSERT INTO fields (id, organization_id) VALUES ('field-1', 'org-fundosmart');
    INSERT INTO potreros (id, field_id, archived_at) VALUES
      ('paddock-1', 'field-1', NULL),
      ('paddock-archived', 'field-1', '2026-07-10T12:00:00.000Z');
  `);
  database.exec(publicSqlForTables([
    "paddock_ndvi",
    "paddock_cell_operations",
    "paddock_cells",
    "paddock_rotation_setting_operations",
    "paddock_rotation_settings",
    "field_landmark_operations",
    "field_landmarks",
  ]));
  database.exec("PRAGMA foreign_keys = ON");
  return database;
}

function isolatedMilkDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE fields (id TEXT PRIMARY KEY NOT NULL)");
  database.exec(publicSqlForTables(["milk_settlements"]));
  database.exec("INSERT INTO fields (id) VALUES ('field-1')");
  return database;
}
