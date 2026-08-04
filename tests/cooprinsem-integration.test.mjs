import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");
const domainTypes = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/domain/types.ts", import.meta.url),
  "utf8",
);
const workerConfig = readFileSync(new URL("../vite.config.ts", import.meta.url), "utf8");
const importRoute = readFileSync(
  new URL("../app/api/integraciones/cooprinsem/importaciones/route.ts", import.meta.url),
  "utf8",
);
const importPage = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url),
  "utf8",
);
const importPageRoute = readFileSync(
  new URL("../app/(producto)/integraciones/cooprinsem/page.tsx", import.meta.url),
  "utf8",
);
const issueRoute = readFileSync(
  new URL("../app/api/integraciones/cooprinsem/inconsistencias/route.ts", import.meta.url),
  "utf8",
);
const importRepository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/import-repository.ts", import.meta.url),
  "utf8",
);
const importFileStorage = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/file-storage.ts", import.meta.url),
  "utf8",
);
const importIntakeRepository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/intake-repository.ts", import.meta.url),
  "utf8",
);
const projectionRepository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/projection-repository.ts", import.meta.url),
  "utf8",
);
const projectionRoute = readFileSync(
  new URL("../app/api/integraciones/cooprinsem/proyeccion/route.ts", import.meta.url),
  "utf8",
);
const configurationRepository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/configuration-repository.ts", import.meta.url),
  "utf8",
);

const expectedTables = [
  "audit_log",
  "field_external_identifiers",
  "import_errors",
  "import_jobs",
  "import_rows",
  "livestock_animal_identifiers",
  "livestock_lot_external_identifiers",
  "livestock_lot_memberships",
  "source_records",
];

test("the first Cooprinsem migration is additive and auditable", () => {
  for (const table of expectedTables) {
    assert.match(migration, new RegExp("CREATE TABLE `" + table + "`"));
  }

  assert.doesNotMatch(migration, /^(?:DROP|ALTER|DELETE)\b/im);
  assert.match(migration, /import_jobs_idempotency_unique/);
  assert.match(migration, /raw_record.*text NOT NULL/);
  assert.match(migration, /source_records_row_target_unique/);
  assert.match(migration, /livestock_lot_memberships_one_active_unique[\s\S]+ended_at.*IS NULL/);
  assert.match(migration, /livestock_lot_memberships_dates_check/);
});

test("the schema keeps identifiers scoped and non-unique across farms", () => {
  assert.match(schema, /livestockAnimalIdentifiers = sqliteTable/);
  assert.match(schema, /livestock_animal_identifiers_lookup_idx/);
  assert.match(schema, /table\.fieldId,[\s\S]+table\.sourceSystem,[\s\S]+table\.kind,[\s\S]+table\.normalizedValue/);
  assert.doesNotMatch(schema, /uniqueIndex\("livestock_animal_identifiers_lookup_idx"/);
});

test("import lifecycle contracts and original-file storage are configured", () => {
  for (const status of [
    "uploaded",
    "parsing",
    "preview_ready",
    "importing",
    "completed",
    "completed_with_errors",
    "failed",
    "cancelled",
  ]) {
    assert.match(domainTypes, new RegExp(`"${status}"`));
  }

  assert.match(workerConfig, /binding: "DB"/);
  assert.match(workerConfig, /binding: "FILES"/);
  assert.match(importRoute, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(importRoute, /requireContextField\(access, fieldId\)/);
  assert.match(importRoute, /resolveImportField\(fieldId, importAccess\)/);
  assert.match(importRoute, /organizationId: access\.organizationId/);
  assert.match(importRoute, /fieldIds: access\.fieldIds/);
  assert.match(importRoute, /membershipId: access\.membershipId/);
  assert.match(importRoute, /email: access\.email/);
  assert.match(importRoute, /getImportDashboard\(importAccess\)/);
  assert.match(importRoute, /getImportPreview\(id, importAccess\)/);
  assert.doesNotMatch(importRoute, /getImportDashboard\(access\.fieldIds\)/);
  assert.match(importRoute, /parsingStartedAt = await markImportParsing\(lifecycle\)/);
  assert.match(importRoute, /saveImportPreview\(\{ \.\.\.parsingLifecycle/);
  assert.match(importRoute, /markImportFailed\(\{ \.\.\.parsingLifecycle, message: publicMessage \}\)/);
  assert.doesNotMatch(importRoute, /organizationId: field\.organizationId/);
  assert.match(importRoute, /sha256/);
  assert.match(importRoute, /createStoredImportJob/);
  assert.match(importRoute, /membershipId: access\.membershipId/);
  assert.match(importRoute, /currentPreviewResponse\(preview, actorAccess/);
  assert.match(importRoute, /hasCurrentImportActorAccess\(access\)/);
  assert.match(importRoute, /ImportAccessChangedError/);
  assert.match(importPageRoute, /membershipId: access\.membershipId/);
  assert.match(importPageRoute, /email: access\.email/);
  assert.doesNotMatch(importRoute, /await storeImportFile/);
  assert.match(importFileStorage, /safeSegment\(input\.importJobId\)/);
  assert.match(importFileStorage, /onlyIf: \{ etagDoesNotMatch: "\*" \}/);
  assert.match(importFileStorage, /importJobId: input\.importJobId/);
  assert.match(importFileStorage, /export async function deleteImportFile/);
  assert.match(importFileStorage, /await bucket\.head\(objectKey\)/);
  assert.match(importIntakeRepository, /await storeImportFile/);
  assert.match(importIntakeRepository, /await createImportJob/);
  assert.match(importIntakeRepository, /await compensateImportFile\(objectKey, cause\)/);
  assert.match(importIntakeRepository, /if \(!created\.created\)[\s\S]+await compensateImportFile\(objectKey\)/);
  assert.match(importPage, /Vista previa/);
  assert.match(domainTypes, /CalidadLeche\.dbf/);
  assert.match(importPage, /CalidadLeche\.dbf/);
  assert.match(importPage, /no crea animales, controles lecheros ni eventos reproductivos/i);
  assert.match(importPage, /Bandeja de inconsistencias/);
  assert.match(issueRoute, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(issueRoute, /requireResourceField\(access, "import_error"/);
  assert.match(issueRoute, /normalizeIssueResolution/);
  assert.match(issueRoute, /getImportDashboard\(importAccess\)/);
  assert.match(issueRoute, /membershipId: access\.membershipId/);
  assert.match(issueRoute, /email: access\.email/);
  assert.match(importRepository, /client\.batch/);
  assert.match(importRepository, /INSERT INTO audit_log/);
  assert.match(importRepository, /guardedResolution, insertAudit, assertComplete/);
  assert.match(importRepository, /INSERT INTO import_jobs[\s\S]+current_field\.organization_id = \?/);
  assert.match(importRepository, /current_field\.id IN \(SELECT value FROM json_each\(\?\)\)/);
  assert.match(importRepository, /organization_memberships AS current_actor/);
  assert.match(importRepository, /current_actor\.role IN \('owner', 'admin', 'manager'\)/);
  assert.match(importRepository, /membership_field_access AS current_scope/);
  assert.match(importRepository, /current_field\.is_demo = 0/);
  assert.doesNotMatch(importRepository, /\.insert\(importJobs\)[\s\S]+onConflictDoNothing/);
  assert.match(importRepository, /status = 'parsing'[\s\S]+started_at = \?[\s\S]+updated_at = \?/);
  assert.match(importRepository, /WITH staged_rows[\s\S]+INSERT INTO import_rows/);
  assert.match(importRepository, /WITH staged_errors[\s\S]+INSERT INTO import_errors/);
  assert.match(importRepository, /THEN 1 ELSE abs\(-9223372036854775807 - 1\) END AS complete/);
  assert.doesNotMatch(importRepository, /insert\(importRows\)[\s\S]+onConflictDoNothing/);
  assert.doesNotMatch(importRepository, /delete\(importRows\)\.where\(eq\(importRows\.importJobId, id\)\)/);
  assert.match(importRepository, /function importReadScope\(access: ImportFieldAccess\)/);
  assert.match(importRepository, /eq\(importJobs\.organizationId, access\.organizationId\)/);
  assert.match(importRepository, /eq\(fields\.organizationId, access\.organizationId\)/);
  assert.match(importRepository, /inArray\(importJobs\.fieldId, access\.fieldIds\)/);
  assert.match(importRepository, /getImportPreview\([\s\S]+access: ImportActorAccess/);
  assert.match(importRepository, /assertCurrentImportActorAccess\(access, \[preview\.fieldId\]\)/);
  assert.match(importRepository, /dashboard\.imports\.map\(\(entry\) => entry\.fieldId\)/);
  assert.match(importRepository, /dashboard\.issues\.map\(\(entry\) => entry\.fieldId\)/);
  assert.match(importRepository, /and\(importReadScope\(access\), eq\(fields\.isDemo, false\)\)/);
  assert.match(importRepository, /innerJoin\(importJobs, eq\(importJobs\.id, importRows\.importJobId\)\)/);
  assert.match(importRepository, /eq\(importRows\.importJobId, importErrors\.importJobId\)/);
  assert.doesNotMatch(importRepository, /eq\(importJobs\.requestedBy/);
  assert.match(projectionRoute, /getImportProjection\(id, importAccess\)/);
  assert.match(projectionRoute, /organizationId: importAccess\.organizationId/);
  assert.match(projectionRoute, /fieldIds: importAccess\.fieldIds/);
  assert.match(projectionRoute, /membershipId: importAccess\.membershipId/);
  assert.match(projectionRoute, /email: importAccess\.email/);
  assert.doesNotMatch(projectionRoute, /getImportProjection\((?:id|importJobId)\)(?!,)/);
  assert.match(projectionRepository, /buildProjectionContext\(input\.importJobId, access, true\)/);
  assert.match(projectionRepository, /function projectionReadScope\(access: ImportFieldAccess\)/);
  assert.match(projectionRepository, /eq\(importRows\.importJobId, sourceRecords\.importJobId\)/);
  assert.match(projectionRepository, /json_extract\(\(SELECT payload FROM input\), '\$\.access\.organizationId'\)/);
  assert.match(projectionRepository, /json_each\(\(SELECT payload FROM input\), '\$\.access\.fieldIds'\)/);
  assert.match(projectionRepository, /current_actor\.id = json_extract\(input\.payload, '\$\.access\.membershipId'\)/);
  assert.match(projectionRepository, /current_actor\.normalized_email = lower\(trim\(json_extract\(input\.payload, '\$\.access\.email'\)\)\)/);
  assert.match(projectionRepository, /current_field\.is_demo = 0/);
  assert.match(projectionRepository, /membership_field_access AS current_scope/);
  assert.match(projectionRepository, /recordProjectionFailure\(context, access, message\)/);
  assert.doesNotMatch(projectionRepository, /eq\(importJobs\.requestedBy/);
  assert.doesNotMatch(configurationRepository, /eq\(importJobs\.requestedBy/);
});

test("the Cooprinsem RSC snapshot is reauthorized after every load and before rendering", () => {
  assert.equal((importPageRoute.match(/reauthorizePageSnapshotAccess\(/g) ?? []).length, 1);
  assert.ok(importPageRoute.indexOf("Promise.all") < importPageRoute.indexOf("await reauthorizePageSnapshotAccess"));
  assert.ok(importPageRoute.indexOf("await reauthorizePageSnapshotAccess") < importPageRoute.lastIndexOf("return"));
  assert.match(
    importPageRoute,
    /reauthorizePageSnapshotAccess\([\s\S]+capability: "manage_imports",[\s\S]+fieldIds: access\.fieldIds/,
  );
  assert.match(importPageRoute, /isDemo=\{currentAccess\.email === DEMO_EMAIL\}/);
  assert.match(importPageRoute, /userName=\{currentAccess\.displayName\}/);
  assert.match(importPageRoute, /roleHasCapability\(currentAccess\.role, "restore_data"\)/);
});
