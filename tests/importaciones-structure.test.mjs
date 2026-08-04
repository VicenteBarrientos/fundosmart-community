import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

const [
  page,
  route,
  domain,
  ui,
  client,
  shell,
  cooprinsemPage,
  cooprinsemUi,
  schema,
  migration,
  soilMigration,
  agronomicMigration,
  repository,
  cooprinsemRepository,
  projectionRepository,
  backupRepository,
  storage,
  worker,
] = await Promise.all([
  readFile(new URL("app/(producto)/importaciones/page.tsx", root), "utf8"),
  readFile(new URL("app/api/importaciones/route.ts", root), "utf8"),
  readFile(new URL("src/modules/importaciones/domain/types.ts", root), "utf8"),
  readFile(new URL("src/modules/importaciones/ImportacionesPage.tsx", root), "utf8"),
  readFile(new URL("src/modules/importaciones/api/import-client.ts", root), "utf8"),
  readFile(new URL("src/core/layout/AppShell.tsx", root), "utf8"),
  readFile(new URL("app/(producto)/integraciones/cooprinsem/page.tsx", root), "utf8"),
  readFile(new URL("src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", root), "utf8"),
  readFile(new URL("db/schema.ts", root), "utf8"),
  readFile(new URL("drizzle/0000_public_schema.sql", root), "utf8"),
  readFile(new URL("drizzle/0000_public_schema.sql", root), "utf8"),
  readFile(new URL("drizzle/0000_public_schema.sql", root), "utf8"),
  readFile(new URL("src/modules/importaciones/server/import-center-repository.ts", root), "utf8"),
  readFile(new URL("src/modules/integraciones/cooprinsem/server/import-repository.ts", root), "utf8"),
  readFile(new URL("src/modules/integraciones/cooprinsem/server/projection-repository.ts", root), "utf8"),
  readFile(new URL("src/modules/integraciones/cooprinsem/server/backup-repository.ts", root), "utf8"),
  readFile(new URL("src/modules/integraciones/cooprinsem/server/file-storage.ts", root), "utf8"),
  readFile(new URL("worker/index.ts", root), "utf8"),
]);
const [tabularParser, pdfParser, soilParser, agronomicParser, survetParser] = await Promise.all([
  readFile(new URL("src/modules/importaciones/server/tabular-parser.mjs", root), "utf8"),
  readFile(new URL("src/modules/importaciones/server/pdf-text.mjs", root), "utf8"),
  readFile(new URL("src/modules/importaciones/server/soil-report-parser.mjs", root), "utf8"),
  readFile(new URL("src/modules/importaciones/server/agronomic-visit-parser.mjs", root), "utf8"),
  readFile(new URL("src/modules/importaciones/server/survet-control-parser.mjs", root), "utf8"),
]);

test("the import center is private, field-scoped and reauthorizes its server snapshot", () => {
  assert.match(page, /requirePageAccess\("\/app\/importaciones", "manage_imports"\)/);
  assert.match(page, /reauthorizePageSnapshotAccess\(access, "\/app\/importaciones"/);
  assert.match(page, /fieldIds: access\.fieldIds/);
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireContextField\(access, fieldId\)/);
  assert.match(route, /requireResourceField\(access, "import_job", importId\)/);
  assert.match(repository, /assertCurrentImportActorAccess/);
  assert.match(repository, /current_actor\.status = 'active'/);
  assert.match(repository, /current_field\.is_demo = 0/);
});

test("uploads are bounded, originals are retained and known profiles fail closed", () => {
  assert.match(route, /const WATTS_MAX_BYTES = 10 \* 1024 \* 1024/);
  assert.match(route, /const TABLE_MAX_BYTES = 5 \* 1024 \* 1024/);
  assert.match(route, /createStoredImportJob/);
  assert.match(route, /watts\.visit_report\.pdf\.v1/);
  assert.match(route, /agronomic\.visit_report\.pdf\.v1/);
  assert.match(route, /cooprinsem\.soil_report\.pdf\.v1/);
  assert.match(route, /survet\.milk_control\.xlsx\.v1/);
  assert.match(domain, /generic\.pasture_measurements\.table\.v1/);
  assert.match(domain, /fundosmart\.survet\.milk-control\.v1/);
  assert.match(domain, /fundosmart\.cooprinsem\.soil-report\.v1/);
  assert.match(domain, /fundosmart\.agronomic\.visit-report\.v1/);
  assert.match(storage, /safeSegment\(input\.sourceSystem \?\? "cooprinsem"\)/);
  assert.match(storage, /if \(input\.sourceSystem\) customMetadata\.sourceSystem = input\.sourceSystem/);
  assert.match(storage, /if \(input\.sourceFormat\) customMetadata\.sourceFormat = input\.sourceFormat/);
  assert.match(tabularParser, /parseDelimitedBounded/);
  assert.match(tabularParser, /internalStream\("uint8array"\)/);
  assert.doesNotMatch(tabularParser, /\.async\("string"\)/);
  assert.match(pdfParser, /cause instanceof PdfTextExtractionError/);
  assert.match(soilParser, /SOIL_RESULT_SUMMARY_MISMATCH/);
  assert.match(soilParser, /signatureStatus: "not_checked"/);
  assert.match(soilParser, /no genera recomendaciones, dosis, fertilizaciones ni actividades/);
  assert.match(agronomicParser, /AGRONOMIC_SECTION_MISSING/);
  assert.match(agronomicParser, /PADDOCK_RECONCILIATION_PENDING/);
  assert.match(survetParser, /SURVET_MAX_ROWS = 200/);
  assert.match(survetParser, /thousand_cells_per_ml/);
  assert.match(survetParser, /source_value_preserved_1_to_1/);
  assert.doesNotMatch(route, /fetch\(["']https?:\/\//);
});

test("the UI exposes operational profiles honestly and requires preview plus explicit confirmation", () => {
  assert.match(ui, /title="Cooprinsem"/);
  assert.match(ui, /title="Cooprinsem · Suelo"/);
  assert.match(ui, /title="Watt's"/);
  assert.match(ui, /title="Asesoría agronómica"/);
  assert.match(ui, /title="Survet"/);
  assert.match(ui, /title="Planilla común"/);
  assert.match(ui, /title="Ferosor"/);
  assert.match(ui, /status="Requiere muestra"/);
  assert.match(ui, /<TableExplorer/);
  assert.match(ui, /id="importaciones\.preview"/);
  assert.match(ui, /Buscar potrero, fecha o valor/);
  assert.match(ui, /Buscar DIIO, vaca, RCS o aviso/);
  assert.match(ui, /filter=\{\{ allLabel: "Todos los estados"/);
  assert.match(ui, /preview && preview\.fieldId !== next/);
  assert.match(ui, /setFieldId\(next\.fieldId\)/);
  assert.match(ui, /role="alert"/);
  assert.match(ui, /row\.issues\.map\(\(issue, index\)/);
  assert.match(ui, /CONFIRMAR IMPORTACIÓN/);
  assert.match(ui, /Sin OCR ni cobros por documento/);
  assert.match(ui, /sin vínculo automático/);
  assert.match(ui, /no se crean diagnósticos ni tratamientos/);
  assert.match(ui, /No se crean recomendaciones, dosis, fertilizaciones ni actividades/);
  assert.match(ui, /Potrero de la muestra/);
  assert.match(ui, /Guardar conciliación de potreros/);
  assert.match(ui, /No se crean actividades, fertilizaciones, compras, dosis ni reservas/);
  assert.match(ui, /agronomicReconciliationSaved/);
  assert.match(ui, /agronomicPaddocks\[row\.id\] === savedPaddockId/);
  assert.match(client, /reconcile_paddocks/);
  assert.match(client, /fetch\("\/api\/importaciones"/);
  assert.match(page, /listPotreros\(access\)/);
});

test("navigation makes Importaciones canonical while preserving the specialized Cooprinsem flow", () => {
  assert.match(shell, /label: "Importaciones"/);
  assert.match(shell, /href: "\/app\/importaciones"/);
  assert.match(ui, /\/app\/integraciones\/cooprinsem/);
  assert.match(cooprinsemPage, /requestedFieldId/);
  assert.match(cooprinsemPage, /initialFieldId=\{initialFieldId\}/);
  assert.match(cooprinsemUi, /useState\(initialFieldId \|\| fundos\[0\]\?\.id \|\| ""\)/);
  assert.match(worker, /"\/importaciones"/);
});

test("persistence keeps profile, visit, row provenance and atomic audit links", () => {
  for (const table of ["import_job_specs", "field_visits", "field_visit_paddocks"]) {
    assert.match(migration, new RegExp(`CREATE TABLE \\\`${table}\\\``));
  }
  assert.match(schema, /import_jobs_scope_id_unique/);
  assert.match(schema, /import_rows_job_id_unique/);
  assert.match(schema, /field_visits_scope_job_fk/);
  assert.match(schema, /field_visit_paddocks_job_row_fk/);
  assert.match(repository, /INSERT INTO source_records/);
  assert.match(repository, /'import\.visit\.confirm'/);
  assert.match(repository, /'import\.survet_milk_control\.confirm'/);
  assert.match(repository, /'import\.soil_analysis\.confirm'/);
  assert.match(repository, /'import\.agronomic_visit\.confirm'/);
  assert.match(repository, /'soil_analysis_report'/);
  assert.match(repository, /'livestock_milk_control_batch'/);
  assert.match(repository, /SURVET_DIIO_AMBIGUOUS/);
  assert.match(repository, /SURVET_CONTROL_ALREADY_EXISTS/);
  assert.match(repository, /input\.preview\.revision/);
  assert.match(domain, /revision: string/);
  assert.match(repository, /NOT EXISTS \(SELECT 1 FROM field_visits WHERE import_job_id = import_jobs\.id\)/);
  assert.match(repository, /paddock_id[\s\S]*SELECT \?, \?, \?, \?, \?, \?, \?, \?, NULL/);
  for (const table of ["soil_analysis_reports", "soil_analysis_results"]) {
    assert.match(soilMigration, new RegExp(`CREATE TABLE \\\`${table}\\\``));
  }
  assert.match(schema, /soil_analysis_reports_field_paddock_fk/);
  assert.match(schema, /soil_analysis_results_job_row_fk/);
  assert.match(repository, /current_paddock\.deleted_at IS NULL/);
  assert.match(repository, /automaticRecommendationsCreated: false/);
  assert.match(agronomicMigration, /CREATE TABLE `field_visit_recommendations`/);
  assert.match(agronomicMigration, /FOREIGN KEY \(`field_id`,`paddock_id`\) REFERENCES `potreros`/);
  assert.match(schema, /field_visit_recommendations_job_row_fk/);
  assert.match(repository, /target_entity = 'field_visit_recommendation'/);
  assert.match(repository, /current_paddock\.archived_at IS NULL/);
});

test("non-Cooprinsem jobs cannot enter legacy animal projection or its dashboard", () => {
  assert.match(route, /sourceSystem: "cooprinsem_soil"/);
  assert.match(repository, /source_system = 'cooprinsem_soil'/);
  assert.match(cooprinsemRepository, /eq\(importJobs\.sourceSystem, "cooprinsem"\)/);
  assert.match(projectionRepository, /eq\(importJobs\.sourceSystem, "cooprinsem"\)/);
  assert.match(backupRepository, /eq\(importJobs\.sourceSystem, "cooprinsem"\)/);
  assert.match(backupRepository, /source_system = 'cooprinsem'/);
  assert.match(backupRepository, /no forman parte del respaldo portable Cooprinsem v1/);
});
