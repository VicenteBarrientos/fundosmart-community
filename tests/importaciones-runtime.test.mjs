import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const ownerAccess = {
  membershipId: "owner-import",
  organizationId: "org-import",
  fieldIds: ["field-import"],
  email: "owner.import@example.com",
};

let sqlite;
let d1;
let vite;
let importRepository;
let importCenterRepository;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const name of migrations) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  seed(sqlite);
  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_IMPORT_CENTER_TEST_ENV__ = { DB: d1 };

  const virtualWorkers = "\0fundosmart-import-center-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-import-center-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_IMPORT_CENTER_TEST_ENV__";
        }
      },
    }],
  });

  [importRepository, importCenterRepository] = await Promise.all([
    vite.ssrLoadModule("/src/modules/integraciones/cooprinsem/server/import-repository.ts"),
    vite.ssrLoadModule("/src/modules/importaciones/server/import-center-repository.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_IMPORT_CENTER_TEST_ENV__;
});

test("generic imports are mapped, confirmed atomically and replayed idempotently", async () => {
  const jobId = "generic-job-atomic";
  await stageGenericJob(jobId, ownerAccess, [
    { Potrero: "Norte 1", Biomasa: "1.850", Superficie: "2,5" },
    { Potrero: "Norte 2", Biomasa: "1720", Superficie: "3,25" },
  ]);
  await assert.rejects(
    importCenterRepository.remapGenericImport({
      importJobId: jobId,
      ...ownerAccess,
      mapping: {
        externalPaddockKey: "Potrero",
        biomassKgDmHa: "Potrero",
        observedDate: null,
        areaHa: null,
        notes: null,
      },
    }),
    (error) => error instanceof importCenterRepository.ImportCenterError
      && error.code === "PASTURE_MAPPING_DUPLICATE_COLUMN",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");

  const mapped = await importCenterRepository.remapGenericImport({
    importJobId: jobId,
    ...ownerAccess,
    mapping: {
      externalPaddockKey: "Potrero",
      biomassKgDmHa: "Biomasa",
      observedDate: null,
      areaHa: "Superficie",
      notes: null,
    },
  });
  assert.equal(mapped.summary.validRowCount, 2);
  assert.equal(mapped.summary.errorRowCount, 0);
  assert.equal(mapped.mapping.externalPaddockKey, "Potrero");
  assert.ok(mapped.rows.every((row) => row.normalizedRecord.paddockId === null));

  d1.beforeBatch = (statements) => {
    assert.match(statements[0].sql, /SET status = 'importing'/);
    sqlite.prepare("UPDATE import_jobs SET updated_at = ? WHERE id = ?").run("concurrent-remap", jobId);
  };
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(count("field_visits", "import_job_id", jobId), 0);

  sqlite.exec(`
    CREATE TRIGGER force_import_confirmation_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'import.visit.confirm'
    BEGIN
      SELECT RAISE(ABORT, 'forced_import_confirmation_audit_failure');
    END;
  `);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(count("field_visits", "import_job_id", jobId), 0);
  assert.equal(count("field_visit_paddocks", "import_job_id", jobId), 0);
  assert.equal(count("source_records", "import_job_id", jobId), 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'imported'").get(jobId).count, 0);
  sqlite.exec("DROP TRIGGER force_import_confirmation_audit_failure");

  const confirmed = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.importedRowCount, 2);
  assert.equal(confirmed.reused, false);
  assertInsertOnlyReceipt(confirmed, mapped.rows);
  assert.equal(count("field_visits", "import_job_id", jobId), 1);
  assert.equal(count("field_visit_paddocks", "import_job_id", jobId), 2);
  assert.equal(count("source_records", "import_job_id", jobId), 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'imported'").get(jobId).count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'import.visit.confirm' AND entity_id = ?").get(confirmed.visitId).count, 1);

  const replay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(replay.visitId, confirmed.visitId);
  assert.equal(replay.reused, true);
  assertReceiptReplay(confirmed, replay);
  assert.equal(count("field_visits", "import_job_id", jobId), 1);

  sqlite.prepare(
    "UPDATE import_rows SET status = 'valid' WHERE import_job_id = ? AND record_number = 1",
  ).run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT"
      && /No repitas la carga/u.test(error.message),
  );
  sqlite.prepare(
    "UPDATE import_rows SET status = 'imported' WHERE import_job_id = ? AND record_number = 1",
  ).run(jobId);

  sqlite.prepare("UPDATE import_jobs SET row_count = row_count + 1 WHERE id = ?").run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare("UPDATE import_jobs SET row_count = row_count - 1 WHERE id = ?").run(jobId);

  sqlite.prepare("UPDATE import_jobs SET status = 'completed_with_errors' WHERE id = ?").run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare("UPDATE import_jobs SET status = 'completed' WHERE id = ?").run(jobId);

  const currentRowId = mapped.rows[0].id;
  sqlite.prepare(`
    UPDATE source_records
    SET source_system = 'tampered'
    WHERE import_job_id = ? AND import_row_id = ?
  `).run(jobId, currentRowId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare(`
    UPDATE source_records
    SET source_system = 'generic'
    WHERE import_job_id = ? AND import_row_id = ?
  `).run(jobId, currentRowId);

  const currentTargetId = sqlite.prepare(`
    SELECT target_id AS targetId
    FROM source_records
    WHERE import_job_id = ? AND import_row_id = ?
  `).get(jobId, currentRowId).targetId;
  sqlite.prepare(`
    UPDATE source_records
    SET target_id = 'missing-target'
    WHERE import_job_id = ? AND import_row_id = ?
  `).run(jobId, currentRowId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare(`
    UPDATE source_records
    SET target_id = ?
    WHERE import_job_id = ? AND import_row_id = ?
  `).run(currentTargetId, jobId, currentRowId);

  const mixedTerminalSource = sqlite.prepare(`
    SELECT id, import_job_id AS importJobId, import_row_id AS importRowId,
           source_system AS sourceSystem, source_table AS sourceTable,
           source_key AS sourceKey, target_entity AS targetEntity,
           target_id AS targetId, created_at AS createdAt
    FROM source_records
    WHERE import_job_id = ? AND import_row_id = ?
  `).get(jobId, currentRowId);
  sqlite.prepare("DELETE FROM source_records WHERE id = ?").run(mixedTerminalSource.id);
  sqlite.prepare("UPDATE import_rows SET status = 'skipped' WHERE id = ?").run(currentRowId);
  sqlite.prepare(`
    UPDATE import_jobs
    SET status = 'completed_with_errors',
        valid_row_count = valid_row_count - 1,
        skipped_row_count = skipped_row_count + 1
    WHERE id = ?
  `).run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
    "a target that remains materialized cannot be reclassified as rejected after losing provenance",
  );
  sqlite.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table,
      source_key, target_entity, target_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mixedTerminalSource.id,
    mixedTerminalSource.importJobId,
    mixedTerminalSource.importRowId,
    mixedTerminalSource.sourceSystem,
    mixedTerminalSource.sourceTable,
    mixedTerminalSource.sourceKey,
    mixedTerminalSource.targetEntity,
    mixedTerminalSource.targetId,
    mixedTerminalSource.createdAt,
  );
  sqlite.prepare("UPDATE import_rows SET status = 'imported' WHERE id = ?").run(currentRowId);
  sqlite.prepare(`
    UPDATE import_jobs
    SET status = 'completed',
        valid_row_count = valid_row_count + 1,
        skipped_row_count = skipped_row_count - 1
    WHERE id = ?
  `).run(jobId);

  const otherJobId = "generic-job-lineage-other";
  await stageGenericJob(otherJobId, ownerAccess, [{ Potrero: "Otro", Biomasa: "1500" }]);
  const otherMapped = await importCenterRepository.remapGenericImport({
    importJobId: otherJobId,
    ...ownerAccess,
    mapping: {
      externalPaddockKey: "Potrero",
      biomassKgDmHa: "Biomasa",
      observedDate: null,
      areaHa: null,
      notes: null,
    },
  });
  sqlite.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table,
      target_entity, target_id
    ) VALUES (?, ?, ?, 'generic', 'generic.pasture_measurements.table.v1',
      'field_visit_paddock', 'cross-target')
  `).run("source:cross-job-to-other-row", jobId, otherMapped.rows[0].id);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare("DELETE FROM source_records WHERE id = ?").run("source:cross-job-to-other-row");

  sqlite.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table,
      target_entity, target_id
    ) VALUES (?, ?, ?, 'generic', 'generic.pasture_measurements.table.v1',
      'field_visit_paddock', 'cross-target')
  `).run("source:other-job-to-current-row", otherJobId, currentRowId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare("DELETE FROM source_records WHERE id = ?").run("source:other-job-to-current-row");

  sqlite.prepare(`
    INSERT INTO field_visit_paddocks (
      id, organization_id, field_id, visit_id, import_job_id, import_row_id,
      sequence_number, external_paddock_key, current_biomass_kg_dm_ha,
      snapshot_json
    ) VALUES (
      'target:extra-current-visit', 'org-import', 'field-import', ?, ?, ?,
      99, 'Target extra', 1000, '{}'
    )
  `).run(confirmed.visitId, otherJobId, otherMapped.rows[0].id);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
    "an extra target under the durable visit must fail the closed cardinality check",
  );
  sqlite.prepare("DELETE FROM field_visit_paddocks WHERE id = ?").run("target:extra-current-visit");

  sqlite.prepare(`
    INSERT INTO field_visits (
      id, organization_id, field_id, import_job_id, visit_kind, provider_key,
      profile_key, profile_version, visit_date, snapshot_json,
      confirmed_by, confirmed_at
    ) VALUES (
      'field-visit:reparent-fixture', 'org-import', 'field-import', ?,
      'pasture_measurement_batch', 'generic',
      'generic.pasture_measurements.table.v1', '1.0.0', '2026-07-24', '{}',
      'fixture', '2026-07-24T00:00:00.000Z'
    )
  `).run(otherJobId);
  sqlite.prepare("DELETE FROM source_records WHERE id = ?").run(mixedTerminalSource.id);
  sqlite.prepare("UPDATE import_rows SET status = 'skipped' WHERE id = ?").run(currentRowId);
  sqlite.prepare(`
    UPDATE import_jobs
    SET status = 'completed_with_errors',
        valid_row_count = valid_row_count - 1,
        skipped_row_count = skipped_row_count + 1
    WHERE id = ?
  `).run(jobId);
  sqlite.prepare(`
    UPDATE field_visit_paddocks
    SET id = 'field-visit-paddock:reparented-renamed',
        visit_id = 'field-visit:reparent-fixture'
    WHERE id = ?
  `)
    .run(currentTargetId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
    "a renamed and reparented target cannot be hidden by marking its durable row rejected",
  );
  sqlite.prepare(`
    UPDATE field_visit_paddocks
    SET id = ?,
        visit_id = ?
    WHERE id = 'field-visit-paddock:reparented-renamed'
  `).run(currentTargetId, confirmed.visitId);
  sqlite.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table,
      source_key, target_entity, target_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mixedTerminalSource.id,
    mixedTerminalSource.importJobId,
    mixedTerminalSource.importRowId,
    mixedTerminalSource.sourceSystem,
    mixedTerminalSource.sourceTable,
    mixedTerminalSource.sourceKey,
    mixedTerminalSource.targetEntity,
    mixedTerminalSource.targetId,
    mixedTerminalSource.createdAt,
  );
  sqlite.prepare("UPDATE import_rows SET status = 'imported' WHERE id = ?").run(currentRowId);
  sqlite.prepare(`
    UPDATE import_jobs
    SET status = 'completed',
        valid_row_count = valid_row_count + 1,
        skipped_row_count = skipped_row_count - 1
    WHERE id = ?
  `).run(jobId);
  sqlite.prepare("DELETE FROM field_visits WHERE id = ?").run("field-visit:reparent-fixture");
  sqlite.prepare("DELETE FROM import_jobs WHERE id = ?").run(otherJobId);

  const recoveredReplay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assertReceiptReplay(confirmed, recoveredReplay);

  const savedSources = sqlite.prepare(`
    SELECT id, import_job_id AS importJobId, import_row_id AS importRowId,
           source_system AS sourceSystem, source_table AS sourceTable,
           source_key AS sourceKey, target_entity AS targetEntity,
           target_id AS targetId, created_at AS createdAt
    FROM source_records
    WHERE import_job_id = ?
    ORDER BY id
  `).all(jobId);
  sqlite.prepare("DELETE FROM source_records WHERE import_job_id = ?").run(jobId);
  sqlite.prepare("UPDATE import_rows SET status = 'skipped' WHERE import_job_id = ?").run(jobId);
  sqlite.prepare(`
    UPDATE import_jobs
    SET status = 'completed_with_errors',
        valid_row_count = 0,
        warning_row_count = 0,
        skipped_row_count = row_count
    WHERE id = ?
  `).run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  const restoreSource = sqlite.prepare(`
    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table,
      source_key, target_entity, target_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const source of savedSources) {
    restoreSource.run(
      source.id,
      source.importJobId,
      source.importRowId,
      source.sourceSystem,
      source.sourceTable,
      source.sourceKey,
      source.targetEntity,
      source.targetId,
      source.createdAt,
    );
  }
  sqlite.prepare("UPDATE import_rows SET status = 'imported' WHERE import_job_id = ?").run(jobId);
  sqlite.prepare(`
    UPDATE import_jobs
    SET status = 'completed',
        valid_row_count = row_count,
        warning_row_count = 0,
        skipped_row_count = 0
    WHERE id = ?
  `).run(jobId);
  const restoredReplay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assertReceiptReplay(confirmed, restoredReplay);

  const center = await importCenterRepository.getImportCenterDashboard(ownerAccess);
  const cooprinsem = await importRepository.getImportDashboard(ownerAccess);
  assert.equal(center.imports.some((entry) => entry.id === jobId), true);
  assert.equal(cooprinsem.imports.some((entry) => entry.id === jobId), false);

  sqlite.prepare("DELETE FROM field_visits WHERE import_job_id = ?").run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  assert.equal(count("source_records", "import_job_id", jobId), 2);
  assert.equal(
    sqlite.prepare(
      "SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'imported'",
    ).get(jobId).count,
    2,
  );
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("receipt integrity failures use the stable no-repeat contract", () => {
  const error = importCenterRepository.confirmationReceiptIntegrityError();
  assert.equal(error.code, "IMPORT_RECEIPT_INCONSISTENT");
  assert.match(error.message, /confirmada/u);
  assert.match(error.message, /No repitas la carga/u);
});

test("Watts warning rows produce a truthful insert-only receipt and replay", async () => {
  const jobId = "watts-job-warning-receipt";
  const staged = await stageWattsJob(jobId, ownerAccess);
  assert.equal(staged.summary.warningRowCount, 1);
  assert.equal(staged.summary.skippedRowCount, 0);
  assert.equal(staged.rows[0].status, "warning");

  const confirmed = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(confirmed.status, "completed_with_errors");
  assert.equal(confirmed.reused, false);
  assertInsertOnlyReceipt(confirmed, staged.rows);
  assert.equal(count("field_visits", "import_job_id", jobId), 1);
  assert.equal(count("field_visit_paddocks", "import_job_id", jobId), 1);
  assert.equal(count("source_records", "import_job_id", jobId), 1);

  const replay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assertReceiptReplay(confirmed, replay);

  sqlite.prepare("UPDATE field_visits SET profile_key = 'tampered.profile' WHERE import_job_id = ?").run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare("UPDATE field_visits SET profile_key = ? WHERE import_job_id = ?")
    .run("watts.visit_report.pdf.v1", jobId);
  const recoveredReplay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assertReceiptReplay(confirmed, recoveredReplay);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("Survet reconciles DIIO, skips unmatched rows and confirms milk controls atomically", async () => {
  sqlite.exec(`
    INSERT INTO livestock_lots (id, field_id, name, category, animal_count, entry_date)
    VALUES
      ('lot-survet', 'field-import', 'Vacas Survet', 'dairy_cow', 3, '2026-01-01'),
      ('lot-survet-other', 'field-other', 'Vacas ajenas', 'dairy_cow', 1, '2026-01-01');
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status, source)
    VALUES
      ('animal-survet-tag', 'lot-survet', 'TEST-001', 'female', 'active', 'fixture'),
      ('animal-survet-identifier', 'lot-survet', 'INTERNO-002', 'female', 'active', 'fixture'),
      ('animal-survet-duplicate', 'lot-survet', 'DUPLICATE-003', 'female', 'active', 'fixture'),
      ('animal-survet-other', 'lot-survet-other', 'OTHER-001', 'female', 'active', 'fixture');
    INSERT INTO livestock_lactations (
      id, field_id, animal_id, sequence_number, started_at, created_by
    ) VALUES (
      'lactation-survet-other', 'field-other', 'animal-survet-other',
      1, '2026-01-01', 'fixture'
    );
    INSERT INTO livestock_animal_identifiers (
      id, field_id, animal_id, source_system, kind, value, normalized_value, is_primary
    ) VALUES (
      'identifier-survet-002', 'field-import', 'animal-survet-identifier',
      'survet', 'diio', 'TEST-002', 'TEST-002', 1
    );
  `);
  const jobId = "survet-job-atomic";
  const staged = await stageSurvetJob(jobId, ownerAccess, [
    survetRow(10, "TEST-001", 11.5, 450_000),
    survetRow(11, "TEST-002", 9, 180_000),
    survetRow(12, "TEST-UNMATCHED", 8, 220_000),
  ]);
  assert.deepEqual(staged.rows.map((row) => row.status), ["valid", "valid", "skipped"]);
  assert.equal(staged.summary.skippedRowCount, 1);
  assert.equal(staged.rows[1].normalizedRecord.animalId, "animal-survet-identifier");
  assert.deepEqual(staged.rows[1].normalizedRecord.matchedBy, ["identifier:survet:diio"]);

  sqlite.exec(`
    CREATE TRIGGER force_survet_confirmation_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'import.survet_milk_control.confirm'
    BEGIN
      SELECT RAISE(ABORT, 'forced_survet_confirmation_audit_failure');
    END;
  `);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(count("livestock_milk_controls", "source", "Survet · kg fuente (equivalente operativo 1:1)"), 0);
  assert.equal(count("source_records", "import_job_id", jobId), 0);
  sqlite.exec("DROP TRIGGER force_survet_confirmation_audit_failure");

  const confirmed = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(confirmed.status, "completed_with_errors");
  assert.equal(confirmed.targetEntity, "livestock_milk_control_batch");
  assert.equal(confirmed.targetId, jobId);
  assert.equal(confirmed.visitId, null);
  assert.equal(confirmed.importedRowCount, 2);
  assert.equal(confirmed.skippedRowCount, 1);
  assert.equal(confirmed.reused, false);
  assertInsertOnlyReceipt(confirmed, staged.rows);
  assert.equal(count("source_records", "import_job_id", jobId), 2);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'imported'",
  ).get(jobId).count, 2);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'skipped'",
  ).get(jobId).count, 1);
  assert.deepEqual(sqlite.prepare(`
    SELECT animal_id AS animalId, total_liters AS totalLiters,
           somatic_cell_count AS somaticCellCount, source
    FROM livestock_milk_controls
    WHERE source_record_id IN (
      SELECT id FROM source_records WHERE import_job_id = ?
    )
    ORDER BY animal_id
  `).all(jobId).map((row) => ({ ...row })), [
    {
      animalId: "animal-survet-identifier",
      totalLiters: 9,
      somaticCellCount: 180_000,
      source: "Survet · kg fuente (equivalente operativo 1:1)",
    },
    {
      animalId: "animal-survet-tag",
      totalLiters: 11.5,
      somaticCellCount: 450_000,
      source: "Survet · kg fuente (equivalente operativo 1:1)",
    },
  ]);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'import.survet_milk_control.confirm' AND entity_id = ?",
  ).get(jobId).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM livestock_health_events").get().count, 0);

  const replay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(replay.targetId, confirmed.targetId);
  assert.equal(replay.reused, true);
  assertReceiptReplay(confirmed, replay);
  assert.equal(count("source_records", "import_job_id", jobId), 2);

  sqlite.prepare(`
    UPDATE livestock_milk_controls
    SET field_id = 'field-other'
    WHERE source_record_id IN (
      SELECT id FROM source_records WHERE import_job_id = ?
    )
  `).run(jobId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
  );
  sqlite.prepare(`
    UPDATE livestock_milk_controls
    SET field_id = 'field-import'
    WHERE source_record_id IN (
      SELECT id FROM source_records WHERE import_job_id = ?
    )
  `).run(jobId);

  const scopedControl = sqlite.prepare(`
    SELECT id, animal_id AS animalId, lactation_id AS lactationId
    FROM livestock_milk_controls
    WHERE source_record_id IN (
      SELECT id FROM source_records WHERE import_job_id = ?
    )
    ORDER BY id
    LIMIT 1
  `).get(jobId);
  sqlite.prepare("UPDATE livestock_milk_controls SET animal_id = 'animal-survet-other' WHERE id = ?")
    .run(scopedControl.id);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
    "the target animal must belong to the same field as the milk control",
  );
  sqlite.prepare("UPDATE livestock_milk_controls SET animal_id = ? WHERE id = ?")
    .run(scopedControl.animalId, scopedControl.id);

  sqlite.prepare("UPDATE livestock_milk_controls SET lactation_id = 'lactation-survet-other' WHERE id = ?")
    .run(scopedControl.id);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
    "a milk-control lactation must belong to the same animal and field",
  );
  sqlite.prepare("UPDATE livestock_milk_controls SET lactation_id = ? WHERE id = ?")
    .run(scopedControl.lactationId, scopedControl.id);

  sqlite.prepare(`
    INSERT INTO livestock_milk_controls (
      id, field_id, animal_id, lactation_id, control_date,
      morning_liters, afternoon_liters, third_milking_liters, total_liters,
      fat_pct, protein_pct, somatic_cell_count, notes, source,
      source_record_id, created_by, created_at, updated_at
    )
    SELECT
      'milk-control:survet:duplicate', field_id, 'animal-survet-duplicate',
      NULL, control_date, morning_liters, afternoon_liters, third_milking_liters,
      total_liters, fat_pct, protein_pct, somatic_cell_count, notes, source,
      source_record_id, created_by, created_at, updated_at
    FROM livestock_milk_controls
    WHERE id = ?
  `).run(scopedControl.id);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_RECEIPT_INCONSISTENT",
    "one provenance record cannot validate more than one milk-control target",
  );
  sqlite.prepare("DELETE FROM livestock_milk_controls WHERE id = ?")
    .run("milk-control:survet:duplicate");

  const recoveredReplay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assertReceiptReplay(confirmed, recoveredReplay);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("soil reports require a current paddock link and confirm technical results atomically", async () => {
  const jobId = "soil-job-atomic";
  const activitiesBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM activities").get().count;
  const document = await stageSoilJob(jobId, ownerAccess);
  const stagedPreview = await importCenterRepository.getImportCenterPreview(jobId, ownerAccess);
  assert.ok(stagedPreview);

  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PADDOCK_REQUIRED",
  );
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
      paddockId: "paddock-other",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(count("soil_analysis_reports", "import_job_id", jobId), 0);

  sqlite.exec(`
    CREATE TRIGGER force_soil_confirmation_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'import.soil_analysis.confirm'
    BEGIN
      SELECT RAISE(ABORT, 'forced_soil_confirmation_audit_failure');
    END;
  `);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
      paddockId: "paddock-import",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(count("soil_analysis_reports", "import_job_id", jobId), 0);
  assert.equal(count("soil_analysis_results", "import_job_id", jobId), 0);
  assert.equal(count("source_records", "import_job_id", jobId), 0);
  sqlite.exec("DROP TRIGGER force_soil_confirmation_audit_failure");

  const confirmed = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
    paddockId: "paddock-import",
  });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.targetEntity, "soil_analysis_report");
  assert.equal(confirmed.visitId, null);
  assert.equal(confirmed.importedRowCount, document.results.length);
  assert.equal(confirmed.reused, false);
  assertInsertOnlyReceipt(confirmed, stagedPreview.rows);
  assert.deepEqual({
    ...sqlite.prepare(`
      SELECT paddock_id AS paddockId, folio, sample_id AS sampleId,
             signature_status AS signatureStatus, qr_status AS qrStatus,
             documentary_use AS documentaryUse
      FROM soil_analysis_reports
      WHERE import_job_id = ?
    `).get(jobId),
  }, {
    paddockId: "paddock-import",
    folio: document.folio,
    sampleId: document.sampleId,
    signatureStatus: "not_checked",
    qrStatus: "not_checked",
    documentaryUse: "technical_result_only",
  });
  assert.equal(count("soil_analysis_results", "import_job_id", jobId), document.results.length);
  assert.equal(count("source_records", "import_job_id", jobId), document.results.length);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'imported'",
  ).get(jobId).count, document.results.length);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'import.soil_analysis.confirm' AND entity_id = ?",
  ).get(confirmed.targetId).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM activities").get().count, activitiesBefore);

  const reopened = await importCenterRepository.getImportCenterPreview(jobId, ownerAccess);
  assert.deepEqual(reopened.soilLink, {
    paddockId: "paddock-import",
    paddockName: "Potrero de prueba",
  });
  const legacyCooprinsemDashboard = await importRepository.getImportDashboard(ownerAccess);
  assert.equal(legacyCooprinsemDashboard.imports.some((entry) => entry.id === jobId), false);
  const replay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(replay.targetId, confirmed.targetId);
  assert.equal(replay.reused, true);
  assertReceiptReplay(confirmed, replay);
  assert.equal(count("soil_analysis_reports", "import_job_id", jobId), 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("agronomic visits require explicit paddock reconciliation and never create activities", async () => {
  const jobId = "agronomic-job-atomic";
  const activitiesBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM activities").get().count;
  const staged = await stageAgronomicJob(jobId, ownerAccess);

  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PADDOCK_REQUIRED",
  );
  await assert.rejects(
    importCenterRepository.reconcileAgronomicPaddocks({
      importJobId: jobId,
      ...ownerAccess,
      mappings: staged.rows.map((row) => ({
        importRowId: row.id,
        paddockId: "paddock-other",
      })),
    }),
    (error) => error.code === "IMPORT_PADDOCK_INVALID",
  );
  await assert.rejects(
    importCenterRepository.reconcileAgronomicPaddocks({
      importJobId: jobId,
      ...ownerAccess,
      mappings: staged.rows.map((row) => ({
        importRowId: row.id,
        paddockId: "paddock-import",
      })),
    }),
    (error) => error.code === "IMPORT_PADDOCK_MAPPING_AMBIGUOUS",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");

  sqlite.exec(`
    CREATE TRIGGER archive_paddock_during_agronomic_reconciliation
    AFTER UPDATE OF status ON import_jobs
    WHEN NEW.id = '${jobId}' AND NEW.status = 'parsing'
    BEGIN
      UPDATE potreros
      SET archived_at = '2026-07-27T11:00:00.000Z'
      WHERE id = 'paddock-import-2';
    END;
  `);
  await assert.rejects(
    importCenterRepository.reconcileAgronomicPaddocks({
      importJobId: jobId,
      ...ownerAccess,
      mappings: [
        { importRowId: staged.rows[0].id, paddockId: "paddock-import" },
        { importRowId: staged.rows[1].id, paddockId: "paddock-import-2" },
      ],
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(sqlite.prepare("SELECT archived_at FROM potreros WHERE id = ?").get("paddock-import-2").archived_at, null);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM import_rows WHERE import_job_id = ? AND status = 'warning'",
  ).get(jobId).count, 2);
  sqlite.exec("DROP TRIGGER archive_paddock_during_agronomic_reconciliation");

  const reconciled = await importCenterRepository.reconcileAgronomicPaddocks({
    importJobId: jobId,
    ...ownerAccess,
    mappings: [
      { importRowId: staged.rows[0].id, paddockId: "paddock-import" },
      { importRowId: staged.rows[1].id, paddockId: "paddock-import-2" },
    ],
  });
  assert.equal(reconciled.summary.validRowCount, 2);
  assert.equal(reconciled.summary.warningRowCount, 0);
  assert.deepEqual(
    reconciled.rows.map((row) => row.normalizedRecord.paddockId),
    ["paddock-import", "paddock-import-2"],
  );

  sqlite.prepare("UPDATE potreros SET archived_at = ? WHERE id = ?").run("2026-07-27T12:00:00.000Z", "paddock-import-2");
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(count("field_visits", "import_job_id", jobId), 0);
  assert.equal(count("field_visit_recommendations", "import_job_id", jobId), 0);
  sqlite.prepare("UPDATE potreros SET archived_at = NULL WHERE id = ?").run("paddock-import-2");

  sqlite.exec(`
    CREATE TRIGGER force_agronomic_confirmation_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'import.agronomic_visit.confirm'
    BEGIN
      SELECT RAISE(ABORT, 'forced_agronomic_confirmation_audit_failure');
    END;
  `);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...ownerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_PLAN_STALE",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(count("field_visits", "import_job_id", jobId), 0);
  assert.equal(count("field_visit_recommendations", "import_job_id", jobId), 0);
  assert.equal(count("source_records", "import_job_id", jobId), 0);
  sqlite.exec("DROP TRIGGER force_agronomic_confirmation_audit_failure");

  const confirmed = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.targetEntity, "field_visit");
  assert.equal(confirmed.importedRowCount, 2);
  assert.equal(confirmed.reused, false);
  assertInsertOnlyReceipt(confirmed, reconciled.rows);
  assert.equal(count("field_visits", "import_job_id", jobId), 1);
  assert.equal(count("field_visit_recommendations", "import_job_id", jobId), 2);
  assert.equal(count("source_records", "import_job_id", jobId), 2);
  assert.deepEqual(sqlite.prepare(`
    SELECT external_paddock_key AS externalPaddockKey, paddock_id AS paddockId,
           action_heading AS actionHeading
    FROM field_visit_recommendations
    WHERE import_job_id = ?
    ORDER BY sequence_number
  `).all(jobId).map((row) => ({ ...row })), [
    {
      externalPaddockKey: "7",
      paddockId: "paddock-import",
      actionHeading: "Siembras obligadas, potreros 7 y 15 (8 ha).",
    },
    {
      externalPaddockKey: "15",
      paddockId: "paddock-import-2",
      actionHeading: "Siembras obligadas, potreros 7 y 15 (8 ha).",
    },
  ]);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM source_records WHERE import_job_id = ? AND target_entity = 'field_visit_recommendation'",
  ).get(jobId).count, 2);
  assert.equal(sqlite.prepare(
    "SELECT COUNT(*) AS count FROM audit_log WHERE action = 'import.agronomic_visit.confirm' AND entity_id = ?",
  ).get(confirmed.visitId).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM activities").get().count, activitiesBefore);

  const replay = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    ...ownerAccess,
    confirmation: "CONFIRMAR IMPORTACIÓN",
  });
  assert.equal(replay.visitId, confirmed.visitId);
  assert.equal(replay.reused, true);
  assertReceiptReplay(confirmed, replay);
  assert.equal(count("field_visit_recommendations", "import_job_id", jobId), 2);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("tenant scope and current membership are rechecked before confirmation", async () => {
  const managerAccess = {
    membershipId: "manager-import",
    organizationId: "org-import",
    fieldIds: ["field-import"],
    email: "manager.import@example.com",
  };
  const jobId = "generic-job-revoked";
  await stageGenericJob(jobId, managerAccess, [{ Potrero: "Sur 1", Biomasa: "1600" }]);
  await importCenterRepository.remapGenericImport({
    importJobId: jobId,
    ...managerAccess,
    mapping: {
      externalPaddockKey: "Potrero",
      biomassKgDmHa: "Biomasa",
      observedDate: null,
      areaHa: null,
      notes: null,
    },
  });

  const otherTenant = await importCenterRepository.getImportCenterDashboard({
    membershipId: "owner-other",
    organizationId: "org-other",
    fieldIds: ["field-other"],
    email: "owner.other@example.com",
  });
  assert.equal(otherTenant.imports.some((entry) => entry.id === jobId), false);

  sqlite.prepare("UPDATE organization_memberships SET status = 'suspended' WHERE id = ?").run(managerAccess.membershipId);
  await assert.rejects(
    importCenterRepository.confirmImportVisit({
      importJobId: jobId,
      ...managerAccess,
      confirmation: "CONFIRMAR IMPORTACIÓN",
    }),
    (error) => error.code === "IMPORT_ACCESS_CHANGED",
  );
  assert.equal(sqlite.prepare("SELECT status FROM import_jobs WHERE id = ?").get(jobId).status, "preview_ready");
  assert.equal(count("field_visits", "import_job_id", jobId), 0);
});

async function stageGenericJob(jobId, access, records) {
  const digest = createHash("sha256").update(jobId).digest("hex");
  const created = await importRepository.createImportJob({
    id: jobId,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    sourceSystem: "generic",
    sourceFormat: "csv",
    sourceTable: "pasture_measurements",
    originalFilename: `${jobId}.csv`,
    contentType: "text/csv",
    fileSizeBytes: 100,
    objectKey: `generic/${jobId}.csv`,
    sha256: digest,
    mappingVersion: "generic.pasture_measurements.table.v1:parser.1.0.0",
    effectiveAt: "2026-07-24",
    requestedBy: access.email,
  });
  assert.equal(created.created, true);
  const parsingStartedAt = await importRepository.markImportParsing({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
  });
  const headers = Object.keys(records[0]);
  await importCenterRepository.saveImportJobSpec({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    sourceSystem: "generic",
    profileKey: "generic.pasture_measurements.table.v1",
    profileVersion: "1.0.0",
    document: {
      kind: "tabular_pasture_measurements",
      schemaVersion: "fundosmart.tabular-pasture-measurements.v1",
      headers,
      sheetName: null,
      sourceRowCount: records.length,
      truncated: false,
    },
    effectiveAt: "2026-07-24",
    updatedBy: access.email,
  });
  await importRepository.saveImportPreview({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    rows: records.map((rawRecord, index) => ({
      recordNumber: index + 1,
      rawRecord,
      normalizedRecord: null,
      status: "pending",
      issues: [],
    })),
    summary: {
      rowCount: records.length,
      validRowCount: 0,
      warningRowCount: 0,
      errorRowCount: 0,
      skippedRowCount: 0,
      fileIssueCount: 0,
    },
  });
}

async function stageAgronomicJob(jobId, access) {
  const digest = createHash("sha256").update(jobId).digest("hex");
  const created = await importRepository.createImportJob({
    id: jobId,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    sourceSystem: "agronomic_advisor",
    sourceFormat: "pdf",
    sourceTable: "agronomic_visit_report",
    originalFilename: `${jobId}.pdf`,
    contentType: "application/pdf",
    fileSizeBytes: 900,
    objectKey: `agronomic_advisor/${jobId}.pdf`,
    sha256: digest,
    mappingVersion: "agronomic.visit_report.pdf.v1:parser.1.0.0",
    effectiveAt: null,
    requestedBy: access.email,
  });
  assert.equal(created.created, true);
  const parsingStartedAt = await importRepository.markImportParsing({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
  });
  const actionGroup = {
    sequenceNumber: 1,
    heading: "Siembras obligadas, potreros 7 y 15 (8 ha).",
    recommendationText: "Revisar el barbecho y la siembra en la próxima ventana de trabajo.",
    externalPaddockKeys: ["7", "15"],
    reportedGroupAreaHa: 8,
  };
  const document = {
    kind: "agronomic_visit_report",
    schemaVersion: "fundosmart.agronomic.visit-report.v1",
    sourceLabel: "Asesoría agronómica",
    visitDate: "2026-02-17",
    sectionHeading: "Manejos agronómicos.",
    reportedIndicators: [],
    actionGroups: [actionGroup],
    limitations: [
      "Conciliación humana requerida.",
      "No crea actividades.",
    ],
  };
  await importCenterRepository.saveImportJobSpec({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    sourceSystem: "agronomic_advisor",
    profileKey: "agronomic.visit_report.pdf.v1",
    profileVersion: "1.0.0",
    document,
    effectiveAt: document.visitDate,
    updatedBy: access.email,
  });
  await importRepository.saveImportPreview({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    rows: actionGroup.externalPaddockKeys.map((externalPaddockKey, index) => ({
      recordNumber: index + 1,
      rawRecord: {
        actionGroupNumber: actionGroup.sequenceNumber,
        actionHeading: actionGroup.heading,
        externalPaddockKey,
        recommendationText: actionGroup.recommendationText,
        reportedGroupAreaHa: actionGroup.reportedGroupAreaHa,
      },
      normalizedRecord: {
        actionKind: "agronomic_recommendation",
        actionGroupNumber: actionGroup.sequenceNumber,
        actionHeading: actionGroup.heading,
        externalPaddockKey,
        paddockId: null,
        visitDate: document.visitDate,
        recommendationText: actionGroup.recommendationText,
        reportedGroupAreaHa: actionGroup.reportedGroupAreaHa,
      },
      status: "warning",
      issues: [{
        fieldName: "paddockId",
        ruleCode: "PADDOCK_RECONCILIATION_PENDING",
        severity: "warning",
        message: `Concilia el potrero externo ${externalPaddockKey}.`,
        sourceValue: externalPaddockKey,
      }],
    })),
    summary: {
      rowCount: actionGroup.externalPaddockKeys.length,
      validRowCount: 0,
      warningRowCount: actionGroup.externalPaddockKeys.length,
      errorRowCount: 0,
      skippedRowCount: 0,
      fileIssueCount: 0,
    },
  });
  return importCenterRepository.getImportCenterPreview(jobId, access);
}

async function stageSurvetJob(jobId, access, rows) {
  const digest = createHash("sha256").update(jobId).digest("hex");
  const created = await importRepository.createImportJob({
    id: jobId,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    sourceSystem: "survet",
    sourceFormat: "xlsx",
    sourceTable: "milk_control",
    originalFilename: `${jobId}.xlsx`,
    contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    fileSizeBytes: 500,
    objectKey: `survet/${jobId}.xlsx`,
    sha256: digest,
    mappingVersion: "survet.milk_control.xlsx.v1:parser.1.0.0",
    effectiveAt: null,
    requestedBy: access.email,
  });
  assert.equal(created.created, true);
  const parsingStartedAt = await importRepository.markImportParsing({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
  });
  const document = {
    kind: "survet_milk_control",
    schemaVersion: "fundosmart.survet.milk-control.v1",
    worksheetName: "ORDEN DIIO",
    producerName: "PRODUCTOR PRUEBA",
    farmName: "FUNDO PRUEBA",
    generatedAtLocal: "2026-02-27T10:00:00.000",
    controlDate: "2026-02-27",
    controlPeriod: "2026-02",
    previousRcsPeriodLabel: "ENE",
    currentRcsPeriodLabel: "FEB",
    sourceRowCount: rows.length,
    sourceMilkUnit: "kg",
    rcsReportedUnit: "thousand_cells_per_ml",
    rcsCanonicalUnit: "cells_per_ml",
    rcsMultiplier: 1000,
    limitations: [],
  };
  await importCenterRepository.saveImportJobSpec({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    sourceSystem: "survet",
    profileKey: "survet.milk_control.xlsx.v1",
    profileVersion: "1.0.0",
    document,
    effectiveAt: document.controlDate,
    updatedBy: access.email,
  });
  const reconciled = await importCenterRepository.reconcileSurvetImportRows({
    access,
    fieldId: access.fieldIds[0],
    controlDate: document.controlDate,
    rows,
  });
  await importRepository.saveImportPreview({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    rows: reconciled.rows,
    summary: reconciled.summary,
  });
  return reconciled;
}

async function stageWattsJob(jobId, access) {
  const digest = createHash("sha256").update(jobId).digest("hex");
  const created = await importRepository.createImportJob({
    id: jobId,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    sourceSystem: "watts",
    sourceFormat: "pdf",
    sourceTable: "visit_report",
    originalFilename: `${jobId}.pdf`,
    contentType: "application/pdf",
    fileSizeBytes: 700,
    objectKey: `watts/${jobId}.pdf`,
    sha256: digest,
    mappingVersion: "watts.visit_report.pdf.v1:parser.1.0.0",
    effectiveAt: null,
    requestedBy: access.email,
  });
  assert.equal(created.created, true);
  const parsingStartedAt = await importRepository.markImportParsing({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
  });
  const paddock = {
    sequenceNumber: 1,
    externalPaddockKey: "W-01",
    plannedEntryDate: "2026-07-25",
    projectedBiomassKgDmHa: 1560,
    areaHa: 3,
    dailyAreaHa: 0.71,
    calculatedDays: 4.2,
    adjustedDays: 4,
    adjustedIntakeKgDmCowDay: 10.5,
  };
  const document = {
    kind: "watts_visit_report",
    schemaVersion: "fundosmart.watts.visit-report.v1",
    producer: { name: "Productor de prueba", code: "WATTS-01" },
    visitDate: "2026-07-24",
    nextVisitDate: "2026-08-25",
    reportGeneratedLocal: "2026-07-25T19:49:27",
    herd: {
      massCows: 50,
      milkingCows: 36,
      averageLitersPerCowDay: 8.3,
      bodyCondition: 3.25,
    },
    grazing: {
      dayAvailabilityKgDmHa: 1278,
      nightAvailabilityKgDmHa: 2145,
      dayResidueKgDmHa: 1500,
      nightResidueKgDmHa: 1600,
      dayConsumptionKgDm: 9,
      nightConsumptionKgDm: 6,
      dayStripHa: 0.7,
      nightStripHa: 0.5,
      dayKgDmCowDay: 9,
      nightKgDmCowDay: 6,
      totalKgDmCowDay: 15,
    },
    diet: {
      pastureParticipationPercent: 70,
      pastureKgDmCowDay: 15,
      reportedTotalPrice: null,
    },
    plan: {
      startDate: "2026-07-25",
      targetKgDmCowDay: 15,
      growthRateKgDmHaDay: 45,
      cowCount: 36,
      residueKgDmHa: 1500,
      totalAreaHa: paddock.areaHa,
      totalAdjustedDays: paddock.adjustedDays,
      paddocks: [paddock],
    },
    notes: [],
    limitations: ["La etiqueta externa requiere conciliación posterior."],
  };
  await importCenterRepository.saveImportJobSpec({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    sourceSystem: "watts",
    profileKey: "watts.visit_report.pdf.v1",
    profileVersion: "1.0.0",
    document,
    effectiveAt: document.visitDate,
    updatedBy: access.email,
  });
  await importRepository.saveImportPreview({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    rows: [{
      recordNumber: paddock.sequenceNumber,
      rawRecord: { ...paddock },
      normalizedRecord: {
        externalPaddockKey: paddock.externalPaddockKey,
        paddockId: null,
        observedAt: document.visitDate,
        plannedEntryDate: paddock.plannedEntryDate,
        currentBiomassKgDmHa: null,
        projectedBiomassKgDmHa: paddock.projectedBiomassKgDmHa,
        areaHa: paddock.areaHa,
        dailyAreaHa: paddock.dailyAreaHa,
        calculatedDays: paddock.calculatedDays,
        adjustedDays: paddock.adjustedDays,
        adjustedIntakeKgDmCowDay: paddock.adjustedIntakeKgDmCowDay,
        notes: null,
      },
      status: "warning",
      issues: [{
        fieldName: "externalPaddockKey",
        ruleCode: "PADDOCK_RECONCILIATION_PENDING",
        severity: "warning",
        message: "La etiqueta externa debe conciliarse antes de usarla como potrero canónico.",
        sourceValue: paddock.externalPaddockKey,
      }],
    }],
    summary: {
      rowCount: 1,
      validRowCount: 0,
      warningRowCount: 1,
      errorRowCount: 0,
      skippedRowCount: 0,
      fileIssueCount: 0,
    },
  });
  return importCenterRepository.getImportCenterPreview(jobId, access);
}

async function stageSoilJob(jobId, access) {
  const digest = createHash("sha256").update(jobId).digest("hex");
  const created = await importRepository.createImportJob({
    id: jobId,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    sourceSystem: "cooprinsem_soil",
    sourceFormat: "pdf",
    sourceTable: "soil_report",
    originalFilename: `${jobId}.pdf`,
    contentType: "application/pdf",
    fileSizeBytes: 800,
    objectKey: `cooprinsem_soil/${jobId}.pdf`,
    sha256: digest,
    mappingVersion: "cooprinsem.soil_report.pdf.v1:parser.1.0.0",
    effectiveAt: null,
    requestedBy: access.email,
  });
  assert.equal(created.created, true);
  const parsingStartedAt = await importRepository.markImportParsing({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
  });
  const results = [
    {
      sequenceNumber: 1,
      analyteCode: "ph_h2o",
      analyteName: "pH H2O",
      unit: "pH",
      value: 5.9,
      idealMin: 5.8,
      idealMax: 7,
      idealRangeText: "5.8 - 7",
      reportedClassification: "Moderado",
      rangeAssessment: "within",
      methodKey: "ph_water_cacl2_ratio_1_2_5",
      methodLabel: "pH en agua y CaCl2, relación 1:2,5",
    },
    {
      sequenceNumber: 2,
      analyteCode: "phosphorus_olsen",
      analyteName: "Fósforo Olsen",
      unit: "mg/kg",
      value: 18,
      idealMin: 20,
      idealMax: 40,
      idealRangeText: "20 - 40",
      reportedClassification: "Medio",
      rangeAssessment: "below",
      methodKey: "nahco3_0_5mol_l_ph_8_5",
      methodLabel: "Extracto NaHCO3 0,5 mol/l a pH 8,5",
    },
  ];
  const document = {
    kind: "cooprinsem_soil_report",
    schemaVersion: "fundosmart.cooprinsem.soil-report.v1",
    provider: {
      key: "cooprinsem",
      laboratoryName: "Laboratorio Análisis de Suelo y Forraje",
    },
    sampleId: "M-01",
    folio: "90001-7",
    receivedDate: "2026-05-05",
    reportDate: "2026-05-12",
    analysisType: "ANÁLISIS BÁSICO SUELO",
    sampledBy: "Cliente",
    reportedSamplingDepthCm: null,
    idealRangeReferenceDepthCm: 20,
    analyticalMethodsText: "Técnicas analíticas: pH agua y CaCl2 relación 1:2,5. P extracto NaHCO3 0,5 mol/l a pH 8,5. K, Ca, Mg y Na extracto CH3COONH4 1 mol/l a pH 7,0.",
    results,
    accreditationClaim: {
      presentInDocument: true,
      verificationStatus: "reported_unverified",
    },
    documentaryVerification: {
      signatureStatus: "not_checked",
      qrStatus: "not_checked",
      use: "technical_result_only",
      originalRequired: true,
    },
    limitations: [
      "Sin recomendaciones automáticas.",
      "Firma y QR no verificados.",
    ],
  };
  await importCenterRepository.saveImportJobSpec({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    sourceSystem: "cooprinsem_soil",
    profileKey: "cooprinsem.soil_report.pdf.v1",
    profileVersion: "1.0.0",
    document,
    effectiveAt: document.reportDate,
    updatedBy: access.email,
  });
  await importRepository.saveImportPreview({
    importJobId: jobId,
    organizationId: access.organizationId,
    fieldId: access.fieldIds[0],
    fieldIds: access.fieldIds,
    parsingStartedAt,
    rows: results.map((result) => ({
      recordNumber: result.sequenceNumber,
      rawRecord: {
        analyteName: result.analyteName,
        unit: result.unit,
        value: result.value,
        idealRangeText: result.idealRangeText,
        reportedClassification: result.reportedClassification,
      },
      normalizedRecord: { ...result },
      status: "valid",
      issues: [],
    })),
    summary: {
      rowCount: results.length,
      validRowCount: results.length,
      warningRowCount: 0,
      errorRowCount: 0,
      skippedRowCount: 0,
      fileIssueCount: 0,
    },
  });
  return document;
}

function survetRow(recordNumber, externalAnimalId, totalMilkKg, somaticCellCount) {
  return {
    recordNumber,
    rawRecord: {
      sourceRowNumber: recordNumber,
      animalIdentifier: externalAnimalId,
      totalMilkKg,
      currentRcsReported: somaticCellCount / 1000,
    },
    normalizedRecord: {
      sourceRowNumber: recordNumber,
      externalAnimalId,
      animalId: null,
      animalTag: null,
      matchedBy: [],
      controlDate: "2026-02-27",
      morningMilkKg: totalMilkKg / 2,
      afternoonMilkKg: totalMilkKg / 2,
      totalMilkKg,
      canonicalMorningLiters: totalMilkKg / 2,
      canonicalAfternoonLiters: totalMilkKg / 2,
      canonicalTotalLiters: totalMilkKg,
      productionSourceUnit: "kg",
      productionCanonicalUnit: "liter_equivalent",
      productionConversion: "source_value_preserved_1_to_1",
      somaticCellCountReported: somaticCellCount / 1000,
      somaticCellCountReportedUnit: "thousand_cells_per_ml",
      somaticCellCount,
      notes: null,
    },
    status: "pending",
    issues: [],
  };
}

function assertInsertOnlyReceipt(receipt, previewRows) {
  const expectedOutcomes = [...previewRows]
    .sort((left, right) => left.recordNumber - right.recordNumber || left.id.localeCompare(right.id))
    .map((row) => ({
      recordNumber: row.recordNumber,
      outcome: row.status === "skipped" ? "rejected" : "inserted",
    }));
  const insertedRowCount = expectedOutcomes.filter((row) => row.outcome === "inserted").length;
  const rejectedRowCount = expectedOutcomes.filter((row) => row.outcome === "rejected").length;

  assert.equal(receipt.receiptVersion, "fundosmart.import-confirmation-receipt.v1");
  assert.equal(receipt.rowCount, expectedOutcomes.length);
  assert.equal(receipt.insertedRowCount, insertedRowCount);
  assert.equal(receipt.updatedRowCount, 0);
  assert.equal(receipt.unchangedRowCount, 0);
  assert.equal(receipt.conflictRowCount, 0);
  assert.equal(receipt.rejectedRowCount, rejectedRowCount);
  assert.equal(
    receipt.rowCount,
    receipt.insertedRowCount
      + receipt.updatedRowCount
      + receipt.unchangedRowCount
      + receipt.conflictRowCount
      + receipt.rejectedRowCount,
  );
  assert.equal(receipt.importedRowCount, insertedRowCount);
  assert.equal(receipt.skippedRowCount, rejectedRowCount);
  assert.deepEqual(receipt.rowOutcomes, expectedOutcomes);
}

function assertReceiptReplay(original, replay) {
  const { reused: originalReused, ...originalStable } = original;
  const { reused: replayReused, ...replayStable } = replay;
  assert.equal(originalReused, false);
  assert.equal(replayReused, true);
  assert.deepEqual(replayStable, originalStable);
}

function count(table, field, value) {
  return sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${field} = ?`).get(value).count;
}

function seed(database) {
  database.exec(`
    INSERT INTO organizations (id, name) VALUES
      ('org-import', 'Import organization'),
      ('org-other', 'Other organization');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('field-import', 'org-import', 'Fundo Norte', 'Los Lagos', 0, 100, '[]'),
      ('field-other', 'org-other', 'Other field', 'Osorno', 0, 50, '[]');
    INSERT INTO potreros (id, field_id, name, sector, area_hectares, coordinates) VALUES
      ('paddock-import', 'field-import', 'Potrero de prueba', 'Norte', 12, '[]'),
      ('paddock-import-2', 'field-import', 'Potrero de prueba 2', 'Norte', 8, '[]'),
      ('paddock-other', 'field-other', 'Potrero ajeno', 'Sur', 8, '[]');
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('owner-import', 'org-import', 'owner.import@example.com', 'owner.import@example.com', 'Owner import', 'owner', 'active', 'test'),
      ('manager-import', 'org-import', 'manager.import@example.com', 'manager.import@example.com', 'Manager import', 'manager', 'active', 'test'),
      ('owner-other', 'org-other', 'owner.other@example.com', 'owner.other@example.com', 'Owner other', 'owner', 'active', 'test');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('manager-import-field', 'manager-import', 'field-import', 'test');
  `);
}

class TestD1PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new TestD1PreparedStatement(this.database, this.sql, bindings);
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async raw(options = {}) {
    const statement = this.database.prepare(this.sql);
    statement.setReturnArrays(true);
    const rows = statement.all(...this.bindings);
    return options.columnNames ? [statement.columns().map((column) => column.name), ...rows] : rows;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.beforeBatch = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    if (this.beforeBatch) {
      const beforeBatch = this.beforeBatch;
      this.beforeBatch = null;
      await beforeBatch(statements);
    }
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(statement.sql)
          ? await statement.all()
          : await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
