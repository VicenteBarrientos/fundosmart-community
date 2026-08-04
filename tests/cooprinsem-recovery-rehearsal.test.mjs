import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, FUNDOSMART_BACKUP_FORMAT, sha256Hex } from "../src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import { runIsolatedRecoveryRehearsal } from "../src/modules/integraciones/cooprinsem/server/isolated-recovery-rehearsal.mjs";
import { restorePlanSha256, restoreSnapshotSha256 } from "../src/modules/integraciones/cooprinsem/server/restore-confirmation-rules.mjs";
import { buildPortableRestorePlan, validatePortableBackup } from "../src/modules/integraciones/cooprinsem/server/restore-rules.mjs";

const root = process.cwd();
const NOW = "2026-07-18T06:00:00.000Z";
const EXPIRES_AT = "2026-07-18T06:15:00.000Z";
const TOKEN = "recovery-token-" + "7".repeat(64);
const guard = { target: "isolated_sqlite_memory", productWritesEnabled: false };

test("el ensayo completo respalda el destino, restaura 26 secciones y consume el token con los inserts", async () => {
  const scenario = await buildScenario();
  const report = await runIsolatedRecoveryRehearsal(scenario.db, scenario.input);
  const expectedRows = Object.values(scenario.backup.data).reduce((total, rows) => total + rows.length, 0);
  assert.equal(report.format, "fundosmart.recovery-rehearsal.v1");
  assert.equal(report.productWritesEnabled, false);
  assert.equal(report.verifiedSectionCount, 26);
  assert.equal(report.verifiedRowCount, expectedRows);
  assert.equal(report.insertedRowCount, expectedRows - 1);
  assert.equal(report.originalFileCount, 1);
  assert.equal(report.originalBytes, scenario.originalBytes.byteLength);
  assert.equal(report.foreignKeyIssueCount, 0);
  assert.equal(report.tokenConsumed, true);
  assert.equal(report.preRestoreBackup.rowCounts.fields, 1);
  assert.equal(report.preRestoreBackup.rowCounts.importJobs, 0);
  assert.equal(await sha256Hex(report.preRestoreBackup.payload), report.preRestoreBackup.sha256);
  assert.match(report.postRestoreSha256, /^[a-f0-9]{64}$/);
  assert.equal(scenario.db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-rehearsal'").get().status, "consumed");
  assert.match(scenario.db.prepare("SELECT object_key FROM import_jobs WHERE id = 'job-restore'").get().object_key, /^isolated-restores\//);
  assert.equal(scenario.store.size, 1);
  assert.doesNotMatch(JSON.stringify(report), /isolated-restores\//);

  await assert.rejects(
    () => runIsolatedRecoveryRehearsal(scenario.db, scenario.input),
    /consumed/,
  );
  assert.equal(scenario.store.size, 1);
  scenario.db.close();
});

test("un original alterado detiene el ensayo antes de tocar D1 u objetos", async () => {
  const scenario = await buildScenario({ corruptOriginal: true });
  await assert.rejects(() => runIsolatedRecoveryRehearsal(scenario.db, scenario.input), /SHA-256 del original/);
  assert.equal(scenario.db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-rehearsal'").get().status, "active");
  assert.equal(scenario.db.prepare("SELECT count(*) AS count FROM potreros").get().count, 0);
  assert.equal(scenario.store.size, 0);
  scenario.db.close();
});

test("un drift de esquema revierte D1, conserva el token y compensa los objetos copiados", async () => {
  const scenario = await buildScenario({ schemaDrift: true });
  await assert.rejects(() => runIsolatedRecoveryRehearsal(scenario.db, scenario.input), /columnas ajenas/);
  assert.equal(scenario.db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-rehearsal'").get().status, "active");
  assert.equal(scenario.db.prepare("SELECT count(*) AS count FROM potreros").get().count, 0);
  assert.equal(scenario.db.prepare("SELECT count(*) AS count FROM import_jobs").get().count, 0);
  assert.equal(scenario.store.size, 0);
  scenario.db.close();
});

test("un cambio del destino invalida el snapshot antes de copiar originales", async () => {
  const scenario = await buildScenario();
  scenario.db.exec("UPDATE fields SET area_hectares = 81 WHERE id = 'field-restore'");
  await assert.rejects(() => runIsolatedRecoveryRehearsal(scenario.db, scenario.input), /snapshot de fields cambio/);
  assert.equal(scenario.db.prepare("SELECT status FROM restore_confirmation_tokens WHERE id = 'confirmation-rehearsal'").get().status, "active");
  assert.equal(scenario.store.size, 0);
  scenario.db.close();
});

test("el ensayo no forma parte del artefacto ni de la ruta productiva", async () => {
  const route = await readFile(path.join(root, "app", "api", "integraciones", "cooprinsem", "restauracion", "route.ts"), "utf8");
  const worker = await readFile(path.join(root, "dist", "server", "index.js"), "utf8");
  assert.doesNotMatch(route, /isolated-recovery-rehearsal|runIsolatedRecoveryRehearsal/);
  assert.doesNotMatch(worker, /fundosmart\.recovery-rehearsal\.v1|isolated_sqlite_memory/);
});

async function buildScenario(options = {}) {
  const originalBytes = new TextEncoder().encode("DBF-isolated-original-v31");
  const originalSha256 = await sha256Hex(originalBytes);
  const backup = await comprehensiveBackup(originalBytes.byteLength, originalSha256, options.schemaDrift);
  const validated = await validatePortableBackup(backup);
  const currentData = Object.fromEntries(Object.keys(backup.data).map((section) => [section, section === "fields" ? backup.data.fields : []]));
  const plan = buildPortableRestorePlan(validated, currentData);
  assert.equal(plan.assessment, "ready");
  const backupPayload = canonicalJson(backup);
  const binding = {
    actorEmail: "owner@example.com",
    organizationId: "org-fundosmart",
    fieldId: "field-restore",
    backupSha256: await sha256Hex(backupPayload),
    snapshotSha256: await restoreSnapshotSha256(currentData),
    planSha256: await restorePlanSha256(plan),
  };
  const db = await isolatedDatabase(backup.data.fields[0]);
  db.prepare(`
    INSERT INTO restore_confirmation_tokens
      (id, organization_id, field_id, actor_email, token_sha256, backup_sha256, snapshot_sha256, plan_sha256, status, expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).run(
    "confirmation-rehearsal",
    binding.organizationId,
    binding.fieldId,
    binding.actorEmail,
    await sha256Hex(TOKEN),
    binding.backupSha256,
    binding.snapshotSha256,
    binding.planSha256,
    EXPIRES_AT,
    NOW,
    NOW,
  );
  const store = new MemoryObjectStore();
  const suppliedBytes = options.corruptOriginal ? new TextEncoder().encode("altered-original") : originalBytes;
  return {
    db,
    store,
    backup,
    originalBytes,
    input: {
      backup: validated,
      backupPayload,
      currentData,
      plan,
      confirmation: { token: TOKEN, binding, now: NOW },
      originalFiles: new Map([["job-restore", suppliedBytes]]),
      objectStore: store,
      guard,
    },
  };
}

async function isolatedDatabase(field) {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = path.join(root, "drizzle");
  for (const name of (await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql") && entry !== "0002_public_demo.sql").sort()) {
    db.exec((await readFile(path.join(migrationDirectory, name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec("PRAGMA foreign_keys = ON");
  db.prepare("INSERT INTO organizations (id, name, created_at) VALUES (?, ?, ?)").run("org-fundosmart", "FundoSmart", NOW);
  db.prepare(`
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(field.id, field.organization_id, field.name, field.location, field.is_demo, field.area_hectares, canonicalJson(field.coordinates), field.created_at);
  return db;
}

async function comprehensiveBackup(fileSizeBytes, originalSha256, schemaDrift) {
  const field = { id: "field-restore", organization_id: "org-fundosmart", name: "Fundo restaurado", location: "Osorno", is_demo: 0, area_hectares: 80, coordinates: [], soil_report_filename: null, soil_report_folio: null, soil_sample_id: null, soil_report_date: null, created_at: NOW };
  const animal = { id: "animal-dam", lot_id: "lot-restore", tag: "RP-9001", sex: "female", status: "active", status_date: null, status_reason: null, birth_date: "2022-01-01", purchase_price_clp: null, purchase_date: null, origin: "Cooprinsem", notes: "", source: "Respaldo portable", created_at: NOW, updated_at: NOW };
  if (schemaDrift) animal.unknown_column = "drift";
  const data = {
    fields: [field],
    paddocks: [{ id: "paddock-restore", field_id: field.id, name: "Potrero 1", sector: "Norte", area_hectares: 10, coordinates: [], soil_ph: null, soil_nitrogen: null, soil_phosphorus: null, soil_potassium: null, last_activity: "Restaurado", status: "Disponible", created_at: NOW, updated_at: NOW }],
    activities: [{ id: "activity-restore", paddock_id: "paddock-restore", type: "pastoreo", occurred_at: NOW, description: "Actividad restaurada", quantity: 1, unit: "evento", cost_clp: 0, created_at: NOW, updated_at: NOW }],
    subdivisionDrafts: [{ field_id: field.id, history: [], line: [], updated_at: NOW }],
    livestockLots: [{ id: "lot-restore", field_id: field.id, paddock_id: "paddock-restore", name: "Lote restaurado", category: "dairy_cow", animal_count: 2, average_weight_kg: 450, entry_date: "2026-01-01", status: "active", owner_name: null, tracking_mode: "individual", notes: "", created_at: NOW, updated_at: NOW }],
    livestockAnimals: [animal, { id: "animal-calf", lot_id: "lot-restore", tag: "RP-9002", sex: "female", status: "active", status_date: null, status_reason: null, birth_date: "2026-02-01", purchase_price_clp: null, purchase_date: null, origin: "Cooprinsem", notes: "", source: "Respaldo portable", created_at: NOW, updated_at: NOW }],
    livestockWeighings: [{ id: "weighing-restore", lot_id: "lot-restore", animal_id: "animal-dam", recorded_at: "2026-06-01", weight_kg: 520, notes: "", source: "Respaldo portable", created_at: NOW }],
    livestockFeedingPlans: [{ id: "feeding-restore", lot_id: "lot-restore", product_name: "Concentrado", kg_per_animal_day: 4, sack_weight_kg: 25, notes: "", created_at: NOW, updated_at: NOW }],
    livestockPartners: [{ id: "partner-restore", name: "Socio restaurado", email: "socio@example.com", created_at: NOW }],
    livestockExpenses: [{ id: "expense-restore", field_id: field.id, date: "2026-06-01", description: "Insumo", category: "alimentacion", amount_clp: 10000, payment_source: "partner", paid_by_id: "partner-restore", lot_id: "lot-restore", created_at: NOW }],
    milkSettlements: [{ id: "settlement-restore", field_id: field.id, period: "2026-06", generated_at: NOW, plant: "Planta", purchase_order: "OC-RESTORE", producer_code: "P1", producer_name: "Productor", buyer_name: "Comprador", liters_first_half: 500, liters_second_half: 500, total_liters: 1000, net_amount_clp: 300000, tax_amount_clp: 57000, gross_amount_clp: 357000, net_price_per_liter_clp: 300, gross_price_per_liter_clp: 357, source_document_name: "liquidacion.pdf", notes: "", line_items: [{ description: "Leche", measurement: null, unitPriceClp: null, amountClp: 300000 }], created_at: NOW, updated_at: NOW }],
    importJobs: [{ id: "job-restore", organization_id: "org-fundosmart", field_id: field.id, source_system: "cooprinsem", source_format: "dbf", source_table: "PreDetimp.dbf", original_filename: "PreDetimp.dbf", content_type: "application/octet-stream", file_size_bytes: fileSizeBytes, sha256: originalSha256, mapping_version: "cooprinsem-v1", effective_at: null, status: "completed", is_dry_run: 0, requested_by: "owner@example.com", row_count: 1, valid_row_count: 1, warning_row_count: 0, error_row_count: 0, skipped_row_count: 0, file_issue_count: 0, failure_message: null, started_at: NOW, previewed_at: NOW, confirmed_at: NOW, completed_at: NOW, created_at: NOW, updated_at: NOW }],
    importRows: [{ id: "row-restore", import_job_id: "job-restore", record_number: 1, source_key: "RP-9001", raw_record: { RP: "9001" }, normalized_record: { RP: "9001" }, status: "imported", warning_count: 0, error_count: 0, created_at: NOW, updated_at: NOW }],
    importErrors: [{ id: "error-restore", import_job_id: "job-restore", import_row_id: "row-restore", field_name: "RP", rule_code: "REVIEWED", severity: "warning", message: "Advertencia resuelta", source_value: "9001", status: "resolved", resolution_notes: "Validado", resolved_by: "owner@example.com", resolved_at: NOW, created_at: NOW, updated_at: NOW }],
    sourceRecords: [{ id: "source-restore", import_job_id: "job-restore", import_row_id: "row-restore", source_system: "cooprinsem", source_table: "PreDetimp.dbf", source_key: "RP-9001", target_entity: "livestock_animal", target_id: "animal-dam", created_at: NOW }],
    livestockLactations: [{ id: "lactation-restore", field_id: field.id, animal_id: "animal-dam", sequence_number: 1, calving_date: "2026-02-01", started_at: "2026-02-01", ended_at: null, status: "active", dry_off_reason: null, source: "Cooprinsem", source_record_id: "source-restore", created_by: "owner@example.com", created_at: NOW, updated_at: NOW }],
    livestockMilkControls: [{ id: "control-restore", field_id: field.id, animal_id: "animal-dam", lactation_id: "lactation-restore", control_date: "2026-06-01", morning_liters: 12, afternoon_liters: 10, third_milking_liters: null, total_liters: 22, fat_pct: 3.8, protein_pct: 3.2, somatic_cell_count: 100000, notes: "", source: "Cooprinsem", source_record_id: "source-restore", created_by: "owner@example.com", created_at: NOW, updated_at: NOW }],
    livestockReproductiveEvents: [{ id: "repro-restore", field_id: field.id, animal_id: "animal-dam", event_type: "calving", occurred_at: "2026-02-01", method: null, result: "live", sire_identifier: "TORO-1", notes: "", metadata: {}, source: "Cooprinsem", source_record_id: "source-restore", created_by: "owner@example.com", created_at: NOW, updated_at: NOW }],
    livestockBirths: [{ id: "birth-restore", field_id: field.id, dam_animal_id: "animal-dam", reproductive_event_id: "repro-restore", occurred_at: "2026-02-01", calving_type: "single", difficulty: "unassisted", outcome: "live", sire_identifier: "TORO-1", notes: "", source: "Cooprinsem", source_record_id: "source-restore", created_by: "owner@example.com", created_at: NOW, updated_at: NOW }],
    livestockBirthOffspring: [{ id: "offspring-restore", birth_id: "birth-restore", animal_id: "animal-calf", temporary_identifier: "CRIA-1", sex: "female", outcome: "alive", birth_weight_kg: 35, notes: "", created_at: NOW, updated_at: NOW }],
    livestockHealthEvents: [{ id: "health-restore", field_id: field.id, animal_id: "animal-dam", event_type: "treatment", occurred_at: "2026-06-01", status: "completed", condition: "Mastitis", product_name: "Producto", active_ingredient: "Ingrediente", dose_amount: 10, dose_unit: "ml", route: "IM", withdrawal_milk_until: "2026-06-05", withdrawal_meat_until: "2026-06-10", professional: "Veterinario", notes: "", metadata: {}, source: "Cooprinsem", source_record_id: "source-restore", created_by: "owner@example.com", created_at: NOW, updated_at: NOW }],
    fieldExternalIdentifiers: [{ id: "field-id-restore", organization_id: "org-fundosmart", field_id: field.id, source_system: "cooprinsem", kind: "predio", value: "P-001", normalized_value: "p-001", valid_from: "2026-01-01", valid_to: null, created_at: NOW, updated_at: NOW }],
    livestockLotExternalIdentifiers: [{ id: "lot-id-restore", field_id: field.id, lot_id: "lot-restore", source_system: "cooprinsem", kind: "grupo", value: "1", normalized_value: "1", valid_from: "2026-01-01", valid_to: null, created_at: NOW, updated_at: NOW }],
    livestockAnimalIdentifiers: [{ id: "animal-id-restore", field_id: field.id, animal_id: "animal-dam", source_system: "cooprinsem", kind: "rp", value: "9001", normalized_value: "9001", valid_from: "2026-01-01", valid_to: null, is_primary: 1, created_at: NOW, updated_at: NOW }],
    livestockLotMemberships: [{ id: "membership-dam", animal_id: "animal-dam", lot_id: "lot-restore", started_at: "2026-01-01", ended_at: null, source_system: "cooprinsem", created_at: NOW, updated_at: NOW }, { id: "membership-calf", animal_id: "animal-calf", lot_id: "lot-restore", started_at: "2026-02-01", ended_at: null, source_system: "cooprinsem", created_at: NOW, updated_at: NOW }],
    auditLog: [{ id: "audit-restore", organization_id: "org-fundosmart", field_id: field.id, actor: "owner@example.com", action: "backup.source.restored", entity_type: "import_job", entity_id: "job-restore", before: null, after: { verified: true }, source_record_id: "source-restore", occurred_at: NOW }],
  };
  const entries = Object.entries(data);
  return {
    manifest: {
      format: FUNDOSMART_BACKUP_FORMAT,
      generatedAt: NOW,
      generatedBy: "owner@example.com",
      encoding: "UTF-8 JSON",
      scope: { type: "field", id: field.id, name: field.name, organizationId: "org-fundosmart", organizationName: "FundoSmart", fieldId: field.id, fieldName: field.name },
      recordCounts: Object.fromEntries(entries.map(([section, rows]) => [section, rows.length])),
      sectionSha256: Object.fromEntries(await Promise.all(entries.map(async ([section, rows]) => [section, await sha256Hex(canonicalJson(rows))]))),
      originalFiles: [{ importJobId: "job-restore", organizationId: "org-fundosmart", fieldId: field.id, fieldName: field.name, originalFilename: "PreDetimp.dbf", contentType: "application/octet-stream", fileSizeBytes, sha256: originalSha256, sourceTable: "PreDetimp.dbf", createdAt: NOW, downloadPath: "/isolated/original" }],
      excluded: [],
    },
    data,
  };
}

class MemoryObjectStore extends Map {
  async get(key) {
    return super.get(key) ?? null;
  }
  async put(key, bytes, metadata) {
    super.set(key, { bytes: new Uint8Array(bytes), metadata });
  }
  async delete(key) {
    super.delete(key);
  }
}
