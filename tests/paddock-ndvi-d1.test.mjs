import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const scopeA = { organizationId: "org-ndvi-a", fieldIds: ["field-ndvi-a"], email: "operator-a@example.com" };
const scopeB = { organizationId: "org-ndvi-b", fieldIds: ["field-ndvi-b"], email: "viewer-b@example.com" };
const interval = { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" };
let sqlite;
let testDb;
let vite;
let repository;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrations) sqlite.exec((await source(`drizzle/${name}`)).replaceAll("--> statement-breakpoint", ""));
  seedFixtures(sqlite);
  testDb = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_PHASE44_TEST_ENV__ = { DB: testDb };
  const virtualWorkers = "\0fundosmart-phase44-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-phase44-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_PHASE44_TEST_ENV__";
      },
    }],
  });
  repository = await vite.ssrLoadModule("/src/modules/potreros/server/paddock-ndvi-repository.ts");
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_PHASE44_TEST_ENV__;
});

test("the public baseline is additive, journaled, tenant-constrained and applies from bootstrap", async () => {
  const [migration, journal] = await Promise.all([
    source("drizzle/0000_public_schema.sql"),
    source("drizzle/meta/_journal.json"),
  ]);
  assert.doesNotMatch(migration, /^(?:DROP|DELETE|ALTER)\b/imu);
  assert.match(migration, /CREATE TABLE `paddock_ndvi`/u);
  assert.match(migration, /FOREIGN KEY \(`organization_id`,`field_id`\)/u);
  assert.match(migration, /FOREIGN KEY \(`field_id`,`paddock_id`\)/u);
  assert.match(migration, /paddock_ndvi_scope_month_unique/u);
  assert.match(migration, /paddock_ndvi_result_check/u);
  assert.match(migration, /geometry_snapshot/u);
  assert.match(migration, /paddock_snapshot/u);
  assert.match(journal, /"idx": 0/u);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='paddock_ndvi'").get().count, 1);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("listing is tenant-strict, returns only active paddocks and persists success without inventing zero", async () => {
  const candidates = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01");
  assert.deepEqual(candidates.map(({ paddockId }) => paddockId), ["paddock-a1", "paddock-a2", "paddock-a3"]);
  assert.equal(candidates.every(({ cache }) => cache === null), true);
  await assert.rejects(
    repository.listPaddockNdviCandidates("field-ndvi-a", scopeB),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );

  const value = await repository.commitPaddockNdviValue({
    scope: scopeA,
    candidate: candidates[0],
    interval,
    result: okResult(),
    computedAt: "2026-07-20T12:00:00.000Z",
    auditId: "audit-ndvi-success-a1",
  });
  assert.equal(value.status, "ok");
  assert.equal(value.meanNdvi, 0.63);
  assert.equal(value.month, "2026-06-01");
  const cached = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01");
  assert.equal(cached[0].cache.meanNdvi, 0.63);
  assert.equal(cached[0].cache.cloudPctIsApproximate, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id='audit-ndvi-success-a1'").get().count, 1);
});

test("explicit no_data is nullable, audited and constrained independently from a real zero", async () => {
  const candidates = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01");
  const value = await repository.commitPaddockNdviValue({
    scope: scopeA,
    candidate: candidates.find(({ paddockId }) => paddockId === "paddock-a2"),
    interval,
    result: noDataResult(),
    computedAt: "2026-07-20T12:01:00.000Z",
    auditId: "audit-ndvi-no-data-a2",
  });
  assert.equal(value.status, "no_data");
  assert.equal(value.meanNdvi, null);
  assert.equal(value.noDataReason, "no_intervals");
  assert.equal(value.interval.from, interval.from);
  const row = sqlite.prepare("SELECT mean_ndvi AS meanNdvi, no_data_reason AS reason FROM paddock_ndvi WHERE paddock_id='paddock-a2'").get();
  assert.deepEqual({ ...row }, { meanNdvi: null, reason: "no_intervals" });
});

test("GET history is one tenant-scoped query with at most six newest rows per active paddock", async () => {
  const months = ["2026-05-01", "2026-04-01", "2026-03-01", "2026-02-01", "2026-01-01", "2025-12-01"];
  const copy = sqlite.prepare(`
    INSERT INTO paddock_ndvi (
      id, organization_id, field_id, paddock_id, month, status, mean_ndvi, no_data_reason,
      cloud_pct, cloud_pct_is_approximate, interval_from, interval_to, observed_at,
      sample_count, no_data_count, valid_sample_count, computed_at, geometry_snapshot,
      paddock_snapshot, geometry_snapshot_token
    )
    SELECT ?, organization_id, field_id, paddock_id, ?, status, ?, no_data_reason, cloud_pct,
      cloud_pct_is_approximate, ?, ?, observed_at, sample_count, no_data_count,
      valid_sample_count, ?, geometry_snapshot,
      paddock_snapshot, geometry_snapshot_token
    FROM paddock_ndvi WHERE paddock_id='paddock-a1' AND month='2026-06-01'
  `);
  months.forEach((month, index) => {
    const nextMonth = new Date(`${month}T00:00:00.000Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    copy.run(
      `history-a1-${month}`,
      month,
      0.5 - index / 100,
      `${month}T00:00:00.000Z`,
      nextMonth.toISOString(),
      `2026-07-20T12:02:${String(index).padStart(2, "0")}.000Z`,
    );
  });
  sqlite.prepare(`
    UPDATE paddock_ndvi
    SET status='no_data', mean_ndvi=NULL, no_data_reason='no_valid_samples',
      cloud_pct=NULL, cloud_pct_is_approximate=0,
      sample_count=0, no_data_count=0, valid_sample_count=0
    WHERE id='history-a1-2026-03-01'
  `).run();

  const listing = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA);
  const history = listing.find(({ paddockId }) => paddockId === "paddock-a1");
  assert.deepEqual(history.history.map(({ month }) => month), [
    "2026-06-01", "2026-05-01", "2026-04-01", "2026-03-01", "2026-02-01", "2026-01-01",
  ]);
  assert.equal(history.cache, history.history[0]);
  assert.equal(history.history.find(({ month }) => month === "2026-03-01").meanNdvi, null);
  assert.equal(listing.some(({ paddockId }) => paddockId === "paddock-archived"), false);
  assert.equal(listing.some(({ paddockId }) => paddockId === "paddock-b1"), false);

  const targetMonth = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-02-01");
  assert.deepEqual(targetMonth.find(({ paddockId }) => paddockId === "paddock-a1").history.map(({ month }) => month), ["2026-02-01"]);
});

test("only geometry semantics invalidate freshness while the complete snapshot remains available for CAS", async () => {
  const before = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01");
  const previous = before.find(({ paddockId }) => paddockId === "paddock-a1");
  assert.equal(previous.cache.geometrySnapshotToken, previous.geometrySnapshotToken);
  sqlite.prepare(`
    UPDATE potreros SET name=?, last_activity=?, status=?, soil_ph=?, updated_at=?
    WHERE id='paddock-a1'
  `).run("Renamed without boundary change", "Pastoreo hoy", "En pastoreo", 6.2, "2026-07-20T12:01:30.000Z");
  const nonGeometry = (await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01"))
    .find(({ paddockId }) => paddockId === "paddock-a1");
  assert.equal(nonGeometry.geometrySnapshotToken, previous.geometrySnapshotToken);
  assert.equal(nonGeometry.cache.geometrySnapshotToken, nonGeometry.geometrySnapshotToken);
  assert.notEqual(nonGeometry.snapshot.name, previous.snapshot.name);

  sqlite.prepare("UPDATE potreros SET coordinates=?, updated_at=? WHERE id='paddock-a1'")
    .run(JSON.stringify(polygon(-40.62)), "2026-07-20T12:02:00.000Z");
  const after = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01");
  const current = after.find(({ paddockId }) => paddockId === "paddock-a1");
  assert.notEqual(current.geometrySnapshotToken, current.cache.geometrySnapshotToken);
  assert.notDeepEqual(current.snapshot.coordinates, previous.snapshot.coordinates);

  const holeKindA = await repository.hashPaddockGeometry({
    id: current.paddockId,
    fieldId: current.snapshot.fieldId,
    rings: current.rings,
    holeKinds: ["laguna"],
  });
  const holeKindB = await repository.hashPaddockGeometry({
    id: current.paddockId,
    fieldId: current.snapshot.fieldId,
    rings: current.rings,
    holeKinds: ["bosque"],
  });
  assert.notEqual(holeKindA, holeKindB);
});

test("post-fetch geometry race rolls back cache and scoped audit atomically", async () => {
  const candidates = await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01");
  const candidate = candidates.find(({ paddockId }) => paddockId === "paddock-a3");
  testDb.beforeNextBatch(() => {
    sqlite.prepare("UPDATE potreros SET name=?, updated_at=? WHERE id='paddock-a3'")
      .run("Paddock won by another request", "2026-07-20T12:03:00.000Z");
  });
  await assert.rejects(repository.commitPaddockNdviValue({
    scope: scopeA,
    candidate,
    interval,
    result: okResult(),
    computedAt: "2026-07-20T12:03:01.000Z",
    auditId: "audit-ndvi-race-a3",
  }), (error) => error.code === "FIELD_SCOPE_CONFLICT");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_ndvi WHERE paddock_id='paddock-a3'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id='audit-ndvi-race-a3'").get().count, 0);
});

test("audit failure rolls back the matching cache write and only confirmed writes are audited", async () => {
  sqlite.exec(`
    INSERT INTO potreros (id, field_id, name, sector, area_hectares, coordinates, updated_at)
    VALUES ('paddock-a4', 'field-ndvi-a', 'Paddock A4', 'North', 4, '${JSON.stringify(polygon(-40.64))}', '2026-07-20T10:00:00.000Z');
    CREATE TRIGGER phase44_force_ndvi_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.id = 'audit-ndvi-forced-failure'
    BEGIN SELECT RAISE(ABORT, 'forced_phase44_ndvi_audit_failure'); END;
  `);
  try {
    const [candidate] = (await repository.listPaddockNdviCandidates("field-ndvi-a", scopeA, "2026-06-01"))
      .filter(({ paddockId }) => paddockId === "paddock-a4");
    await assert.rejects(repository.commitPaddockNdviValue({
      scope: scopeA,
      candidate,
      interval,
      result: okResult(),
      computedAt: "2026-07-20T12:04:00.000Z",
      auditId: "audit-ndvi-forced-failure",
    }), /forced_phase44_ndvi_audit_failure/u);
  } finally {
    sqlite.exec("DROP TRIGGER phase44_force_ndvi_audit_failure");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM paddock_ndvi WHERE paddock_id='paddock-a4'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id='audit-ndvi-forced-failure'").get().count, 0);
});

test("database rejects invalid result counts, orphan paddocks and cross-tenant scope tuples", () => {
  assert.throws(() => sqlite.prepare("UPDATE paddock_ndvi SET sample_count=5 WHERE paddock_id='paddock-a1'").run(), /CHECK constraint failed/u);
  assert.throws(() => sqlite.prepare(`
    INSERT INTO paddock_ndvi
    SELECT 'orphan-cache', organization_id, field_id, 'missing-paddock', month, status, mean_ndvi,
      no_data_reason, cloud_pct, cloud_pct_is_approximate, interval_from, interval_to, observed_at,
      sample_count, no_data_count, valid_sample_count, computed_at, geometry_snapshot,
      paddock_snapshot, geometry_snapshot_token
    FROM paddock_ndvi WHERE paddock_id='paddock-a1' AND month='2026-06-01'
  `).run(), /FOREIGN KEY constraint failed/u);
  assert.throws(() => sqlite.prepare(`
    INSERT INTO paddock_ndvi
    SELECT 'cross-tenant-cache', 'org-ndvi-b', field_id, paddock_id, '2026-05-01', status, mean_ndvi,
      no_data_reason, cloud_pct, cloud_pct_is_approximate, '2026-05-01T00:00:00.000Z',
      '2026-06-01T00:00:00.000Z', observed_at, sample_count, no_data_count, valid_sample_count,
      computed_at, geometry_snapshot, paddock_snapshot, geometry_snapshot_token
    FROM paddock_ndvi WHERE paddock_id='paddock-a1' AND month='2026-06-01'
  `).run(), /FOREIGN KEY constraint failed/u);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("repository uses an atomic D1 batch, revalidates the full snapshot and never deletes domain data", async () => {
  const repositorySource = await source("src/modules/potreros/server/paddock-ndvi-repository.ts");
  assert.match(repositorySource, /client\.batch\(statements\)/u);
  assert.match(repositorySource, /current_paddock\.coordinates/u);
  assert.match(repositorySource, /current_paddock\.updated_at/u);
  assert.match(repositorySource, /INSERT INTO audit_log/u);
  assert.doesNotMatch(repositorySource, /DELETE FROM (?:potreros|fields|paddock_ndvi)/u);
});

function okResult() {
  return {
    status: "ok",
    meanNdvi: 0.63,
    cloudPct: 15,
    cloudPctMethod: "no_data_fraction",
    cloudPctIsApproximate: true,
    observedAt: "2026-06-01T00:00:00.000Z",
    interval,
    sampleCount: 100,
    noDataCount: 15,
    validSampleCount: 85,
  };
}

function noDataResult() {
  return {
    status: "no_data",
    reason: "no_intervals",
    observedAt: null,
    interval: null,
    sampleCount: 0,
    noDataCount: 0,
    validSampleCount: 0,
  };
}

function polygon(latitude) {
  return {
    outer: [[latitude, -73.1], [latitude, -73.09], [latitude + 0.01, -73.09], [latitude + 0.01, -73.1]],
    holes: [],
  };
}

function seedFixtures(database) {
  database.prepare("INSERT INTO organizations (id, name) VALUES (?, ?), (?, ?)")
    .run("org-ndvi-a", "Organization A", "org-ndvi-b", "Organization B");
  database.prepare(`
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates)
    VALUES (?, ?, 'Field A', 'Osorno', 0, 20, '[]'), (?, ?, 'Field B', 'Osorno', 0, 20, '[]')
  `).run("field-ndvi-a", "org-ndvi-a", "field-ndvi-b", "org-ndvi-b");
  const insert = database.prepare(`
    INSERT INTO potreros (id, field_id, name, sector, area_hectares, coordinates, updated_at, archived_at)
    VALUES (?, ?, ?, 'North', 4, ?, '2026-07-20T10:00:00.000Z', ?)
  `);
  insert.run("paddock-a1", "field-ndvi-a", "Paddock A1", JSON.stringify(polygon(-40.60)), null);
  insert.run("paddock-a2", "field-ndvi-a", "Paddock A2", JSON.stringify(polygon(-40.58)), null);
  insert.run("paddock-a3", "field-ndvi-a", "Paddock A3", JSON.stringify(polygon(-40.56)), null);
  insert.run("paddock-archived", "field-ndvi-a", "Paddock archived", JSON.stringify(polygon(-40.54)), "2026-07-19T00:00:00.000Z");
  insert.run("paddock-b1", "field-ndvi-b", "Paddock B1", JSON.stringify(polygon(-41.00)), null);
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
