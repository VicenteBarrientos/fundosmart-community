import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalJson,
  FUNDOSMART_BACKUP_FORMAT,
  safeDownloadFilename,
  sha256Hex,
} from "../src/modules/integraciones/cooprinsem/server/backup-format.mjs";

const repository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/backup-repository.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../app/api/integraciones/cooprinsem/respaldos/route.ts", import.meta.url),
  "utf8",
);
const storage = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/file-storage.ts", import.meta.url),
  "utf8",
);
const page = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url),
  "utf8",
);

test("el JSON canónico y sus hashes son deterministas", async () => {
  const first = { zebra: 3, alpha: { two: 2, one: 1 }, rows: [{ b: true, a: null }] };
  const second = { rows: [{ a: null, b: true }], alpha: { one: 1, two: 2 }, zebra: 3 };
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(await sha256Hex(first), await sha256Hex(second));
  assert.equal((await sha256Hex(first)).length, 64);
  assert.equal(FUNDOSMART_BACKUP_FORMAT, "fundosmart.portable-backup.v1");
});

test("los nombres descargables eliminan rutas y caracteres inseguros", () => {
  assert.equal(safeDownloadFilename("../Respaldo Fundo Ñuble?.json"), "Respaldo-Fundo-Nuble.json");
  assert.equal(safeDownloadFilename("", "original.dbf"), "original.dbf");
});

test("el respaldo de fundo cubre datos productivos, staging, trazabilidad y auditoría", () => {
  for (const section of [
    "paddocks",
    "paddockNdvi",
    "activities",
    "paddockCellOperations",
    "paddockCells",
    "paddockRotationSettingOperations",
    "paddockRotationSettings",
    "fieldLandmarkOperations",
    "fieldLandmarks",
    "livestockAnimals",
    "livestockWeighings",
    "milkSettlements",
    "importJobs",
    "importRows",
    "importErrors",
    "sourceRecords",
    "livestockMilkControls",
    "livestockReproductiveEvents",
    "livestockBirths",
    "livestockHealthEvents",
    "auditLog",
  ]) {
    assert.match(repository, new RegExp(`name: "${section}"`));
  }
  assert.match(repository, /sectionSha256/);
  assert.match(repository, /client\.batch<BackupRow>/);
  assert.match(repository, /paddockNdvi[\s\S]+jsonColumns: \["geometry_snapshot", "paddock_snapshot"\]/);
  assert.match(repository, /current_field\.organization_id = ndvi\.organization_id/);
  assert.match(repository, /paddock\.id = ndvi\.paddock_id AND paddock\.field_id = current_field\.id/);
  assert.match(repository, /paddockCellOperations[\s\S]+jsonColumns: \["request", "result"\]/);
  assert.match(repository, /paddockCells[\s\S]+jsonColumns: \["coordinates"\]/);
  assert.match(repository, /paddockRotationSettingOperations[\s\S]+jsonColumns: \["result"\]/);
  assert.match(repository, /fieldLandmarkOperations[\s\S]+jsonColumns: \["request", "result"\]/);
  assert.match(repository, /fieldLandmarks[\s\S]+jsonColumns: \["geometry"\]/);
  assert.match(repository, /current_field\.organization_id = operation\.organization_id/);
  assert.ok(repository.indexOf('name: "paddocks"') < repository.indexOf('name: "paddockNdvi"'));
  assert.ok(repository.indexOf('name: "paddockNdvi"') < repository.indexOf('name: "activities"'));
  assert.ok(repository.indexOf('name: "paddockCellOperations"') < repository.indexOf('name: "paddockCells"'));
  assert.ok(repository.indexOf('name: "fieldLandmarkOperations"') < repository.indexOf('name: "fieldLandmarks"'));
  assert.match(repository, /livestockContributions[\s\S]+pertenecen a toda la organización/);
  assert.match(repository, /downloadPath:/);
  assert.doesNotMatch(repository.match(/PORTABLE_IMPORT_JOB_COLUMNS = \[[\s\S]+?\]\.join/)?.[0] ?? "", /object_key/);
  assert.doesNotMatch(repository, /CDSE_CLIENT_(?:ID|SECRET)/u);
});

test("la descarga exige capacidad y alcance, verifica R2 y deja auditoría", () => {
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireContextField\(access, id\)/);
  assert.match(route, /requireResourceField\(access, "import_job", id\)/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /email: access\.email/);
  assert.equal((route.match(/getOriginalFileReference\(importJobId, repositoryAccess\)/g) ?? []).length, 2);
  assert.match(route, /sameOriginalFileReference\(reference, currentReference\)/);
  assert.match(route, /object\.size !== currentReference\.fileSizeBytes/);
  assert.match(route, /storedSha256 !== currentReference\.sha256/);
  assert.match(route, /X-FundoSmart-SHA256/);
  assert.match(route, /const audited = await recordBackupDownload/);
  assert.match(route, /if \(!audited\) return staleScopeResponse\(\)/);
  assert.match(storage, /readImportFile/);
  assert.match(page, /Respaldos abiertos/);
  assert.match(page, /Original DBF/);
});

test("el repositorio repite tenant, snapshot y relaciones compuestas antes de responder", () => {
  assert.match(repository, /ImportFieldAccess/);
  assert.match(repository, /sameFieldScope\(scope, currentScope\)/);
  assert.match(repository, /sameOriginalFileReference\(original, currentOriginal\)/);
  assert.match(repository, /json_each/);
  assert.match(repository, /r\.import_job_id = e\.import_job_id/);
  assert.match(repository, /r\.import_job_id = s\.import_job_id/);
  assert.match(repository, /INSERT INTO audit_log[\s\S]+FROM fields AS current_field/);
  assert.match(repository, /organization_memberships AS current_actor/);
  assert.match(repository, /current_actor\.normalized_email = \?/);
  assert.match(repository, /current_actor\.role IN \('owner', 'admin', 'manager'\)/);
  assert.match(repository, /membership_field_access AS current_scope/);
  assert.match(repository, /current_field\.is_demo = 0/);
  assert.match(repository, /return Number\(result\.meta\.changes\) === 1/);
});

test("cada consulta del respaldo prepara sobre el esquema migrado", async () => {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = path.join(process.cwd(), "drizzle");
  for (const name of (await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec((await readFile(path.join(migrationDirectory, name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  const literalQueries = [...repository.matchAll(/sql: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(literalQueries.length >= 27);
  for (const query of literalQueries) {
    assert.doesNotThrow(() => db.prepare(query), query);
  }
  const columnsBlock = repository.match(/PORTABLE_IMPORT_JOB_COLUMNS = \[([\s\S]+?)\]\.join/)?.[1] ?? "";
  const columns = [...columnsBlock.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(columns.length >= 25);
  assert.doesNotThrow(() => db.prepare(`SELECT ${columns.join(", ")} FROM import_jobs WHERE field_id = ?`));
  db.close();
});
