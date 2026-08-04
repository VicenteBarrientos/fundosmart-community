import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const scopeA = { organizationId: "org-cell-a", fieldIds: ["field-cell-a"], email: "operator-a@example.com" };
const scopeB = { organizationId: "org-cell-b", fieldIds: ["field-cell-b"], email: "operator-b@example.com" };
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

let sqlite;
let testDb;
let vite;
let cellRepository;
let rotationRepository;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrations) {
    sqlite.exec((await source(`drizzle/${name}`)).replaceAll("--> statement-breakpoint", ""));
  }
  seedFixtures(sqlite);
  testDb = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_PHASE5_TEST_ENV__ = { DB: testDb };

  const virtualWorkers = "\0fundosmart-phase5-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-phase5-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_PHASE5_TEST_ENV__";
      },
    }],
  });
  [cellRepository, rotationRepository] = await Promise.all([
    vite.ssrLoadModule("/src/modules/potreros/server/paddock-cell-repository.ts"),
    vite.ssrLoadModule("/src/modules/potreros/server/paddock-rotation-repository.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_PHASE5_TEST_ENV__;
});

test("the public baseline is additive, constrained, journaled and applicable", async () => {
  const [migration, journal] = await Promise.all([
    source("drizzle/0000_public_schema.sql"),
    source("drizzle/meta/_journal.json"),
  ]);
  assert.doesNotMatch(migration, /^(?:DROP|DELETE|ALTER)\b/imu);
  for (const table of [
    "paddock_cell_operations",
    "paddock_cells",
    "paddock_rotation_settings",
    "paddock_rotation_setting_operations",
  ]) {
    assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `missing migration table ${table}`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).count, 1);
  }
  assert.match(migration, /active_from/);
  assert.match(migration, /active_to/);
  assert.match(migration, /json_valid/);
  assert.match(migration, /recent_days.*<.*long_rest_days/su);
  assert.match(journal, /"idx": 0/);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("confirmed strip preview conserves area, is idempotent and never mutates the paddock", async () => {
  const request = { fieldId: "field-cell-a", paddockId: "paddock-cell-a1", count: 4, bearingDegrees: 90 };
  const paddockBefore = sqlite.prepare(`
    SELECT coordinates, updated_at AS updatedAt FROM potreros WHERE id = 'paddock-cell-a1'
  `).get();
  const preview = await cellRepository.previewPaddockCellGeneration(request, scopeA);
  assert.equal(preview.cells.length, 4);
  assert.ok(Math.abs(preview.areaDeltaSquareMeters) <= preview.areaToleranceSquareMeters);
  assert.ok(preview.cells.every(({ geometry }) => geometry.holes.length === 0));

  const commit = {
    ...request,
    operationId: "phase5-create-a1-first",
    requestHash: preview.requestHash,
    expectedSnapshotToken: preview.snapshotToken,
  };
  const result = await cellRepository.commitPaddockCellGeneration(commit, scopeA);
  assert.equal(result.activeCells.length, 4);
  assert.equal(result.closedCells.length, 0);
  assert.equal(result.idempotentReplay, false);
  assert.ok(Math.abs(result.activeCells.reduce((sum, cell) => sum + cell.areaSquareMeters, 0) - preview.sourceAreaSquareMeters)
    <= preview.areaToleranceSquareMeters);
  assert.deepEqual(sqlite.prepare(`
    SELECT coordinates, updated_at AS updatedAt FROM potreros WHERE id = 'paddock-cell-a1'
  `).get(), paddockBefore);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cells WHERE paddock_id = ? AND active_to IS NULL")
    .get(request.paddockId).count, 4);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_id = ?")
    .get(commit.operationId).count, 1);

  const siblingRequest = { fieldId: request.fieldId, paddockId: "paddock-cell-a3", count: 2, bearingDegrees: 45 };
  const siblingPreview = await cellRepository.previewPaddockCellGeneration(siblingRequest, scopeA);
  await cellRepository.commitPaddockCellGeneration({
    ...siblingRequest,
    operationId: "phase5-create-a3-field-listing",
    requestHash: siblingPreview.requestHash,
    expectedSnapshotToken: siblingPreview.snapshotToken,
  }, scopeA);
  const fieldListing = await cellRepository.listFieldActivePaddockCells(request.fieldId, scopeA);
  assert.equal(fieldListing.fieldId, request.fieldId);
  assert.ok(fieldListing.snapshotToken.startsWith("field-active-cells-snapshot:v1:"));
  assert.deepEqual([...new Set(fieldListing.active.map(({ paddockId }) => paddockId))], [request.paddockId, siblingRequest.paddockId]);
  assert.equal(fieldListing.active.length, 6);
  sqlite.prepare("UPDATE potreros SET archived_at = ? WHERE id = ?").run("2026-07-20T12:00:00.000Z", request.paddockId);
  assert.deepEqual(
    [...new Set((await cellRepository.listFieldActivePaddockCells(request.fieldId, scopeA)).active.map(({ paddockId }) => paddockId))],
    [siblingRequest.paddockId],
  );
  sqlite.prepare("UPDATE potreros SET archived_at = NULL WHERE id = ?").run(request.paddockId);
  await assert.rejects(
    cellRepository.listFieldActivePaddockCells(request.fieldId, scopeB),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );

  const replay = await cellRepository.commitPaddockCellGeneration(commit, scopeA);
  assert.equal(replay.idempotentReplay, true);
  assert.deepEqual(replay.activeCells.map(({ id }) => id), result.activeCells.map(({ id }) => id));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cell_operations WHERE id = ?")
    .get(commit.operationId).count, 1);
  await assert.rejects(
    cellRepository.commitPaddockCellGeneration({ ...commit, requestHash: "different-payload" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    cellRepository.listPaddockCells(request.fieldId, request.paddockId, scopeB),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
});

test("new generations close the active set, preserve history and support auditable close without resurrection", async () => {
  const request = { fieldId: "field-cell-a", paddockId: "paddock-cell-a1", count: 3, bearingDegrees: 0 };
  const preview = await cellRepository.previewPaddockCellGeneration(request, scopeA);
  const replaced = await cellRepository.commitPaddockCellGeneration({
    ...request,
    operationId: "phase5-create-a1-second",
    requestHash: preview.requestHash,
    expectedSnapshotToken: preview.snapshotToken,
  }, scopeA);
  assert.equal(replaced.activeCells.length, 3);
  assert.equal(replaced.closedCells.length, 4);
  assert.ok(replaced.closedCells.every((cell) => cell.activeTo === replaced.committedAt && cell.version === 2));

  const listing = await cellRepository.listPaddockCells(request.fieldId, request.paddockId, scopeA);
  assert.equal(listing.active.length, 3);
  assert.equal(listing.history.length, 4);
  const closeRequest = {
    fieldId: request.fieldId,
    paddockId: request.paddockId,
    operationId: "phase5-close-a1",
    expectedSnapshotToken: listing.snapshotToken,
  };
  const closed = await cellRepository.closePaddockCells(closeRequest, scopeA);
  assert.equal(closed.activeCells.length, 0);
  assert.equal(closed.closedCells.length, 3);
  assert.equal((await cellRepository.closePaddockCells(closeRequest, scopeA)).idempotentReplay, true);
  const finalListing = await cellRepository.listPaddockCells(request.fieldId, request.paddockId, scopeA);
  assert.equal(finalListing.active.length, 0);
  assert.equal(finalListing.history.length, 7);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cells WHERE active_to IS NULL AND closed_by_operation_id IS NOT NULL")
    .get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_id IN (?, ?)")
    .get("phase5-create-a1-second", "phase5-close-a1").count, 2);
});

test("post-preview races and audit failures roll back the whole cell batch", async () => {
  const request = { fieldId: "field-cell-a", paddockId: "paddock-cell-a2", count: 2, bearingDegrees: 180 };
  const preview = await cellRepository.previewPaddockCellGeneration(request, scopeA);
  testDb.beforeNextBatch(() => {
    sqlite.prepare("UPDATE potreros SET updated_at = ? WHERE id = ?")
      .run("2026-07-20T18:00:00.000Z", request.paddockId);
  });
  await assert.rejects(
    cellRepository.commitPaddockCellGeneration({
      ...request,
      operationId: "phase5-raced-create",
      requestHash: preview.requestHash,
      expectedSnapshotToken: preview.snapshotToken,
    }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cell_operations WHERE id = 'phase5-raced-create'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cells WHERE paddock_id = ?").get(request.paddockId).count, 0);

  const refreshed = await cellRepository.previewPaddockCellGeneration(request, scopeA);
  sqlite.exec(`
    CREATE TRIGGER phase5_force_cell_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'paddock.cells.created'
    BEGIN
      SELECT RAISE(ABORT, 'forced_phase5_cell_audit_failure');
    END;
  `);
  try {
    await assert.rejects(cellRepository.commitPaddockCellGeneration({
      ...request,
      operationId: "phase5-audit-failed-create",
      requestHash: refreshed.requestHash,
      expectedSnapshotToken: refreshed.snapshotToken,
    }, scopeA), /forced_phase5_cell_audit_failure/u);
  } finally {
    sqlite.exec("DROP TRIGGER phase5_force_cell_audit_failure");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cell_operations WHERE id = 'phase5-audit-failed-create'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_cells WHERE paddock_id = ?").get(request.paddockId).count, 0);
});

test("field thresholds are strict, optimistic, permanently idempotent and audit-closed", async () => {
  assert.deepEqual(await rotationRepository.getPaddockRotationSettings("field-cell-a", scopeA), {
    fieldId: "field-cell-a",
    recentDays: 15,
    longRestDays: 30,
    version: null,
    createdAt: null,
    updatedAt: null,
  });
  await assert.rejects(
    rotationRepository.updatePaddockRotationSettings({
      fieldId: "field-cell-a",
      operationId: "phase5-invalid-thresholds",
      recentDays: 30,
      longRestDays: 30,
      expectedVersion: null,
    }, scopeA),
    (error) => error.code === "PADDOCK_ROTATION_INVALID",
  );
  const firstRequest = {
    fieldId: "field-cell-a",
    operationId: "phase5-settings-first",
    recentDays: 15,
    longRestDays: 30,
    expectedVersion: null,
  };
  const first = await rotationRepository.updatePaddockRotationSettings(firstRequest, scopeA);
  assert.equal(first.settings.version, 1);
  assert.equal((await rotationRepository.updatePaddockRotationSettings(firstRequest, scopeA)).idempotentReplay, true);
  await assert.rejects(
    rotationRepository.updatePaddockRotationSettings({ ...firstRequest, operationId: "phase5-settings-stale" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  const second = await rotationRepository.updatePaddockRotationSettings({
    fieldId: "field-cell-a",
    operationId: "phase5-settings-second",
    recentDays: 7,
    longRestDays: 21,
    expectedVersion: 1,
  }, scopeA);
  assert.deepEqual({ recentDays: second.settings.recentDays, longRestDays: second.settings.longRestDays, version: second.settings.version }, {
    recentDays: 7,
    longRestDays: 21,
    version: 2,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'paddock.rotation.settings.updated' AND field_id = ?")
    .get("field-cell-a").count, 2);
  await assert.rejects(
    rotationRepository.getPaddockRotationSettings("field-cell-a", scopeB),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );

  sqlite.exec(`
    CREATE TRIGGER phase5_force_settings_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'paddock.rotation.settings.updated'
    BEGIN
      SELECT RAISE(ABORT, 'forced_phase5_settings_audit_failure');
    END;
  `);
  try {
    await assert.rejects(rotationRepository.updatePaddockRotationSettings({
      fieldId: "field-cell-a",
      operationId: "phase5-settings-audit-failed",
      recentDays: 8,
      longRestDays: 22,
      expectedVersion: 2,
    }, scopeA), /forced_phase5_settings_audit_failure/u);
  } finally {
    sqlite.exec("DROP TRIGGER phase5_force_settings_audit_failure");
  }
  assert.equal((await rotationRepository.getPaddockRotationSettings("field-cell-a", scopeA)).version, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_rotation_setting_operations WHERE id = 'phase5-settings-audit-failed'")
    .get().count, 0);
});

test("rotation snapshot uses only grazing activities and active assigned lots, never legacy status", async () => {
  const snapshot = await rotationRepository.getPaddockRotationSnapshot("field-cell-a", scopeA, "2026-07-20");
  assert.equal(snapshot.settings.version, 2);
  assert.deepEqual(snapshot.sources, {
    grazingActivitiesOnly: true,
    activeAssignedLotsOnly: true,
    manualOverrideSupported: false,
  });
  const byId = new Map(snapshot.paddocks.map((paddock) => [paddock.paddockId, paddock]));
  assert.deepEqual({
    classification: byId.get("paddock-cell-a1").classification,
    effectiveStatus: byId.get("paddock-cell-a1").effectiveStatus,
    assignedLots: byId.get("paddock-cell-a1").assignedLotCount,
    manualOverride: byId.get("paddock-cell-a1").manualOverride,
  }, {
    classification: "occupied",
    effectiveStatus: "occupied",
    assignedLots: 1,
    manualOverride: null,
  });
  assert.deepEqual({
    classification: byId.get("paddock-cell-a2").classification,
    restDays: byId.get("paddock-cell-a2").restDays,
    effectiveStatus: byId.get("paddock-cell-a2").effectiveStatus,
    statusSource: byId.get("paddock-cell-a2").statusSource,
  }, {
    classification: "long_rest",
    restDays: 35,
    effectiveStatus: "rest",
    statusSource: "grazing_history",
  });
  assert.deepEqual({
    classification: byId.get("paddock-cell-a3").classification,
    lastGrazingAt: byId.get("paddock-cell-a3").lastGrazingAt,
    dataQuality: byId.get("paddock-cell-a3").dataQuality,
  }, { classification: "long_rest", lastGrazingAt: null, dataQuality: "no_history" });
  assert.ok(snapshot.readyPaddocks.some(({ paddockId }) => paddockId === "paddock-cell-a2"));
  assert.match(snapshot.banner, /A2/u);
  assert.ok(snapshot.snapshotToken.startsWith("paddock-rotation-snapshot:v1:"));
  assert.equal(snapshot.paddocks.some(({ paddockId }) => paddockId === "paddock-cell-b1"), false);
  await assert.rejects(
    rotationRepository.getPaddockRotationSnapshot("field-cell-b", scopeA, "2026-07-20"),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("routes and clients expose authorized, no-store contracts without physical deletion", async () => {
  const [cellRoute, rotationRoute, cellRepositorySource, cellClient, rotationClient] = await Promise.all([
    source("app/api/potreros/celdas/route.ts"),
    source("app/api/potreros/rotacion/route.ts"),
    source("src/modules/potreros/server/paddock-cell-repository.ts"),
    source("src/modules/potreros/api/paddock-cells-client.ts"),
    source("src/modules/potreros/api/paddock-rotation-client.ts"),
  ]);
  assert.match(cellRoute, /authorizeApiAccess\("operate"\)/u);
  assert.match(cellRoute, /requireContextField\(access, payload\.fieldId\)/u);
  assert.match(cellRoute, /private, no-store/u);
  assert.match(rotationRoute, /authorizeApiAccess\("view"\)/u);
  assert.match(rotationRoute, /authorizeApiAccess\("operate"\)/u);
  assert.match(rotationRoute, /private, no-store/u);
  assert.doesNotMatch(cellRepositorySource, /DELETE FROM paddock_cells/u);
  assert.doesNotMatch(cellRepositorySource, /SET active_to = NULL/u);
  assert.match(cellRepositorySource, /client\.batch\(statements\)/u);
  assert.match(cellRepositorySource, /listFieldActivePaddockCells/u);
  assert.match(cellRepositorySource, /isNull\(paddockCells\.activeTo\)/u);
  assert.doesNotMatch(cellRepositorySource, /listFieldActivePaddockCells[\s\S]*?listPaddockCells\(/u);
  assert.match(cellRepositorySource, /INSERT INTO audit_log/u);
  assert.match(cellClient, /class PaddockCellApiError/u);
  assert.match(cellClient, /fetchFieldActivePaddockCells/u);
  assert.match(rotationClient, /class PaddockRotationApiError/u);
});

function seedFixtures(database) {
  const rectangle = JSON.stringify([
    [-40, -73],
    [-40, -72.99645],
    [-39.9982, -72.99645],
    [-39.9982, -73],
  ]);
  database.prepare("INSERT INTO organizations (id, name) VALUES (?, ?), (?, ?)")
    .run("org-cell-a", "Organization A", "org-cell-b", "Organization B");
  database.prepare(`
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates)
    VALUES (?, ?, ?, 'Osorno', 0, 6, ?), (?, ?, ?, 'Osorno', 0, 6, ?)
  `).run("field-cell-a", "org-cell-a", "Field A", rectangle, "field-cell-b", "org-cell-b", "Field B", rectangle);
  const insertPaddock = database.prepare(`
    INSERT INTO potreros (id, field_id, name, sector, area_hectares, coordinates, status, updated_at)
    VALUES (?, ?, ?, 'Norte', 6, ?, ?, ?)
  `);
  insertPaddock.run("paddock-cell-a1", "field-cell-a", "A1", rectangle, "Disponible", "2026-07-20T10:00:00.000Z");
  insertPaddock.run("paddock-cell-a2", "field-cell-a", "A2", rectangle, "En pastoreo", "2026-07-20T10:00:00.000Z");
  insertPaddock.run("paddock-cell-a3", "field-cell-a", "A3", rectangle, "Disponible", "2026-07-20T10:00:00.000Z");
  insertPaddock.run("paddock-cell-b1", "field-cell-b", "B1", rectangle, "En pastoreo", "2026-07-20T10:00:00.000Z");
  database.prepare(`
    INSERT INTO activities (id, paddock_id, type, occurred_at, description, created_at, updated_at)
    VALUES
      ('grazing-a1', 'paddock-cell-a1', 'grazing', '2026-07-05', 'Pastoreo A1', '2026-07-05T10:00:00Z', '2026-07-05T10:00:00Z'),
      ('maintenance-a1', 'paddock-cell-a1', 'maintenance', '2026-07-19', 'Mantención reciente', '2026-07-19T10:00:00Z', '2026-07-19T10:00:00Z'),
      ('grazing-a2', 'paddock-cell-a2', 'grazing', '2026-06-15', 'Pastoreo A2', '2026-06-15T10:00:00Z', '2026-06-15T10:00:00Z'),
      ('maintenance-a3', 'paddock-cell-a3', 'maintenance', '2026-07-20', 'Mantención sin pastoreo', '2026-07-20T10:00:00Z', '2026-07-20T10:00:00Z'),
      ('grazing-b1', 'paddock-cell-b1', 'grazing', '2026-07-20', 'Pastoreo B1', '2026-07-20T10:00:00Z', '2026-07-20T10:00:00Z')
  `).run();
  database.prepare(`
    INSERT INTO livestock_lots (id, field_id, paddock_id, name, category, animal_count, entry_date, status)
    VALUES
      ('active-lot-a1', 'field-cell-a', 'paddock-cell-a1', 'Activo A1', 'heifer', 5, '2026-07-01', 'active'),
      ('sold-lot-a2', 'field-cell-a', 'paddock-cell-a2', 'Vendido A2', 'heifer', 4, '2026-06-01', 'sold'),
      ('active-lot-b1', 'field-cell-b', 'paddock-cell-b1', 'Activo B1', 'heifer', 3, '2026-07-01', 'active')
  `).run();
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
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
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

  beforeNextBatch(callback) {
    this.beforeBatch = callback;
  }

  async batch(statements) {
    const beforeBatch = this.beforeBatch;
    this.beforeBatch = null;
    await beforeBatch?.();
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/iu.test(statement.sql)
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
