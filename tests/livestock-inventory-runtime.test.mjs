import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const ownerAccess = {
  membershipId: "owner-inventory",
  organizationId: "org-inventory",
  fieldIds: ["field-inventory"],
  email: "owner.inventory@example.com",
};

let sqlite;
let d1;
let vite;
let importCenterRepository;

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
        try {
          results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(statement.sql)
            ? await statement.all()
            : await statement.run());
        } catch (err) {
          console.error("FAILED SQL:", statement.sql, "BINDINGS:", statement.bindings);
          throw err;
        }
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function seed(sqlite) {
  sqlite.exec(`
    INSERT INTO organizations (id, name) VALUES
      ('org-inventory', 'Import organization');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('field-inventory', 'org-inventory', 'Fundo Norte', 'Los Lagos', 0, 100, '[]');
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('owner-inventory', 'org-inventory', 'owner.inventory@example.com', 'owner.inventory@example.com', 'Owner inventory', 'owner', 'active', 'test');
  `);
}

async function stageLivestockInventoryJob(jobId, rows) {
  const now = new Date().toISOString();
  sqlite.prepare(`
    INSERT INTO import_jobs (
      id, organization_id, field_id, source_system, source_format, source_table,
      original_filename, content_type, file_size_bytes, object_key, sha256,
      mapping_version, is_dry_run, status, requested_by, row_count, valid_row_count, warning_row_count,
      error_row_count, file_issue_count, created_at, updated_at
    ) VALUES (
      ?, ?, ?, 'generic', 'xlsx', 'livestock.inventory.xlsx.v1',
      'ANIMALES 2024.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      1024, 'inventory/sample.xlsx', 'sha256demo',
      'livestock.inventory.xlsx.v1:parser.1.0.0', 0, 'preview_ready', ?,
      ?, ?, 0, 0, 0, ?, ?
    )
  `).run(
    jobId,
    ownerAccess.organizationId,
    ownerAccess.fieldIds[0],
    ownerAccess.email,
    rows.length,
    rows.length,
    now,
    now,
  );

  sqlite.prepare(`
    INSERT INTO import_job_specs (
      import_job_id, organization_id, field_id, profile_key, profile_version, document_json, updated_by, created_at
    ) VALUES (?, ?, ?, 'livestock.inventory.xlsx.v1', '1.0', '{}', ?, ?)
  `).run(jobId, ownerAccess.organizationId, ownerAccess.fieldIds[0], ownerAccess.email, now);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    sqlite.prepare(`
      INSERT INTO import_rows (
        id, import_job_id, record_number, status,
        raw_record, normalized_record, created_at, updated_at
      ) VALUES (?, ?, ?, 'valid', ?, ?, ?, ?)
    `).run(
      `row:${jobId}:${i + 1}`,
      jobId,
      i + 1,
      JSON.stringify(row),
      JSON.stringify(row),
      now,
      now,
    );
  }
}

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

  const virtualWorkers = "\0fundosmart-import-center-cloudflare-workers-inventory";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-import-center-cloudflare-workers-inventory",
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

  importCenterRepository = await vite.ssrLoadModule(
    "/src/modules/importaciones/server/import-center-repository.ts",
  );
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_IMPORT_CENTER_TEST_ENV__;
});

test("livestock inventory import confirms atomically and is replayed idempotently", async () => {
  const jobId = "job-inventory-runtime-1";
  const sampleRows = [
    {
      animalExternalId: "99980001",
      birthDate: "2018-09-20",
      lotName: "Lechería",
      exit: null,
      calvingDates: ["2024-03-15"],
      dryOffDate: "2024-11-20",
      heatDate: null,
      winterHeatDate: null,
      pregnancyStatus: null,
      offspring: { sex: "female", externalId: "99980099" },
      observations: "Buena condición corporal",
    },
    {
      animalExternalId: "99980002",
      birthDate: "2018-10-10",
      lotName: "Lote 2",
      exit: null,
      calvingDates: [],
      dryOffDate: null,
      heatDate: "2025-01-10",
      winterHeatDate: null,
      pregnancyStatus: null,
      offspring: null,
      observations: "",
    },
  ];

  await stageLivestockInventoryJob(jobId, sampleRows);

  const receipt = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    confirmation: "CONFIRMAR IMPORTACIÓN",
    ...ownerAccess,
  });

  assert.equal(receipt.status, "completed");
  assert.equal(receipt.targetEntity, "livestock_inventory_batch");
  assert.equal(receipt.importedRowCount, 2);
  assert.equal(receipt.reused, false);

  // Check database writes
  const lots = sqlite.prepare("SELECT * FROM livestock_lots WHERE field_id = ?").all(ownerAccess.fieldIds[0]);
  assert.ok(lots.length >= 2);
  const lotNames = lots.map((l) => l.name);
  assert.ok(lotNames.includes("Lechería"));
  assert.ok(lotNames.includes("Lote 2"));

  const animals = sqlite.prepare("SELECT * FROM livestock_animals WHERE tag IN ('99980001', '99980002')").all();
  assert.equal(animals.length, 2);
  const animalTags = animals.map((a) => a.tag);
  assert.ok(animalTags.includes("99980001"));
  assert.ok(animalTags.includes("99980002"));

  const events = sqlite.prepare("SELECT * FROM livestock_reproductive_events").all();
  assert.ok(events.length >= 2); // 1 calving + 1 dry_off + 1 heat

  const births = sqlite.prepare("SELECT * FROM livestock_births").all();
  assert.equal(births.length, 1);

  // Replay idempotency check
  const replayedReceipt = await importCenterRepository.confirmImportVisit({
    importJobId: jobId,
    confirmation: "CONFIRMAR IMPORTACIÓN",
    ...ownerAccess,
  });

  assert.equal(replayedReceipt.reused, true);
  assert.equal(replayedReceipt.status, "completed");
  assert.equal(replayedReceipt.importedRowCount, 2);

  // Ensure database row count did not double on replay
  const animalsAfterReplay = sqlite.prepare("SELECT * FROM livestock_animals WHERE tag IN ('99980001', '99980002')").all();
  assert.equal(animalsAfterReplay.length, 2);
});
