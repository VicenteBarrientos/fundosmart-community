import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const scopeA = { organizationId: "org-landmark-a", fieldIds: ["field-landmark-a"], email: "operator-a@example.com" };
const scopeB = { organizationId: "org-landmark-b", fieldIds: ["field-landmark-b"], email: "operator-b@example.com" };
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

let sqlite;
let testDb;
let vite;
let landmarkRepository;
let landmarkUtils;

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
  globalThis.__FUNDOSMART_PHASE43_TEST_ENV__ = { DB: testDb };

  const virtualWorkers = "\0fundosmart-phase43-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-phase43-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_PHASE43_TEST_ENV__";
      },
    }],
  });
  [landmarkRepository, landmarkUtils] = await Promise.all([
    vite.ssrLoadModule("/src/modules/potreros/server/field-landmark-repository.ts"),
    vite.ssrLoadModule("/src/modules/potreros/utils/field-landmarks.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_PHASE43_TEST_ENV__;
});

test("the public baseline is additive, constrained, journaled and applicable", async () => {
  const [migration, journal] = await Promise.all([
    source("drizzle/0000_public_schema.sql"),
    source("drizzle/meta/_journal.json"),
  ]);
  assert.doesNotMatch(migration, /^(?:DROP|DELETE|ALTER)\b/imu);
  for (const table of ["field_landmark_operations", "field_landmarks"]) {
    assert.ok(migration.includes(`CREATE TABLE \`${table}\``), `missing migration table ${table}`);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table).count, 1);
  }
  assert.match(migration, /json_array_length/u);
  assert.match(migration, /BETWEEN 2 AND 2000/u);
  assert.match(migration, /last_operation_id/u);
  assert.match(migration, /deleted_at/u);
  assert.match(journal, /"idx": 0/u);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("public importer conversion validates Point and LineString with WGS84 and metric length", () => {
  const point = landmarkUtils.fieldLandmarkInputFromImportedGeometry({
    id: "imported-water-point",
    fieldId: "field-landmark-a",
    kind: "bebedero",
    name: "Bebedero importado",
    geometry: { type: "Point", coordinates: [-40.5, -73.1] },
  });
  assert.deepEqual(point, {
    id: "imported-water-point",
    fieldId: "field-landmark-a",
    kind: "bebedero",
    geometryType: "point",
    geometry: [[-40.5, -73.1]],
    name: "Bebedero importado",
    notes: "",
  });

  const line = landmarkUtils.fieldLandmarkInputFromImportedGeometry({
    id: "imported-water-line",
    fieldId: "field-landmark-a",
    kind: "linea_agua",
    name: "Línea importada",
    notes: "  PVC  ",
    geometry: { type: "LineString", coordinates: [[-40, -73], [-40, -72.999]] },
  });
  const validated = landmarkUtils.validateFieldLandmarkInput(line);
  assert.equal(line.geometryType, "line");
  assert.equal(line.notes, "PVC");
  assert.ok(validated.lengthMeters > 85 && validated.lengthMeters < 86);

  for (const invalid of [
    { ...point, geometry: [[-40, -73], [-40.1, -73.1]] },
    { ...line, geometry: [[-40, -73]] },
    { ...line, geometry: [[-91, -73], [-40, -73]] },
    { ...line, geometry: [[-40, Number.NaN], [-40, -73]] },
    { ...line, geometry: [[-40, -73], [-40, -73]] },
    { ...line, geometry: Array.from({ length: 2_001 }, (_, index) => [-40, -73 + index / 100_000]) },
  ]) {
    assert.throws(() => landmarkUtils.validateFieldLandmarkInput(invalid), { name: "FieldLandmarkValidationError" });
  }
});

test("point creation is tenant-strict, permanently idempotent and audit-closed", async () => {
  const request = pointRequest({ id: "landmark-point-a", operationId: "landmark-create-point-a" });
  const created = await landmarkRepository.upsertFieldLandmark(request, scopeA);
  assert.deepEqual({ kind: created.kind, replay: created.idempotentReplay, version: created.landmark.version }, {
    kind: "create",
    replay: false,
    version: 1,
  });
  assert.equal(created.landmark.lengthMeters, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations WHERE id = ?")
    .get(request.operationId).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type = 'field_landmark' AND entity_id = ?")
    .get(request.id).count, 1);

  const replay = await landmarkRepository.upsertFieldLandmark(request, scopeA);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.landmark.lastOperationId, request.operationId);
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({ ...request, name: "Otro contenido" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({ ...request, operationId: "landmark-recreate-point-a" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    landmarkRepository.listFieldLandmarks("field-landmark-a", scopeB),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({ ...request, id: "tenant-b-id", operationId: "cross-tenant-create" }, scopeB),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );

  const listing = await landmarkRepository.listFieldLandmarks("field-landmark-a", scopeA);
  assert.equal(listing.active.some(({ id }) => id === request.id), true);
  assert.equal(listing.archived.length, 0);
});

test("line updates expose metric length and reject stale pre-read and post-read races", async () => {
  const createRequest = lineRequest({ id: "landmark-line-a", operationId: "landmark-create-line-a" });
  const created = await landmarkRepository.upsertFieldLandmark(createRequest, scopeA);
  assert.ok(created.landmark.lengthMeters > 85 && created.landmark.lengthMeters < 86);

  const updateRequest = {
    ...createRequest,
    name: "Línea de agua extendida",
    geometry: [[-40, -73], [-40, -72.998]],
    operationId: "landmark-update-line-a",
    expectedVersion: 1,
  };
  const updated = await landmarkRepository.upsertFieldLandmark(updateRequest, scopeA);
  assert.equal(updated.kind, "update");
  assert.equal(updated.landmark.version, 2);
  assert.ok(updated.landmark.lengthMeters > 170 && updated.landmark.lengthMeters < 171);
  assert.equal((await landmarkRepository.upsertFieldLandmark(updateRequest, scopeA)).idempotentReplay, true);
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({ ...updateRequest, notes: "Otro contenido" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({ ...updateRequest, operationId: "landmark-stale-line-a" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );

  testDb.beforeNextBatch(() => {
    sqlite.prepare("UPDATE field_landmarks SET name = ?, version = version + 1 WHERE id = ?")
      .run("Ganador concurrente", createRequest.id);
  });
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({
      ...updateRequest,
      name: "Perdedor concurrente",
      operationId: "landmark-raced-line-a",
      expectedVersion: 2,
    }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  assert.deepEqual({ ...sqlite.prepare("SELECT name, version FROM field_landmarks WHERE id = ?").get(createRequest.id) }, {
    name: "Ganador concurrente",
    version: 3,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations WHERE id = 'landmark-raced-line-a'")
    .get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id = 'audit-field-landmark-landmark-raced-line-a'")
    .get().count, 0);
});

test("audit failure rolls back create and tombstone batches", async () => {
  sqlite.exec(`
    CREATE TRIGGER phase43_force_landmark_create_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'paddock.landmark.created'
    BEGIN
      SELECT RAISE(ABORT, 'forced_phase43_landmark_create_audit_failure');
    END;
  `);
  try {
    await assert.rejects(
      landmarkRepository.upsertFieldLandmark(pointRequest({
        id: "landmark-create-rollback",
        operationId: "landmark-create-rollback-op",
      }), scopeA),
      /forced_phase43_landmark_create_audit_failure/u,
    );
  } finally {
    sqlite.exec("DROP TRIGGER phase43_force_landmark_create_audit_failure");
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmarks WHERE id = 'landmark-create-rollback'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations WHERE id = 'landmark-create-rollback-op'").get().count, 0);

  const deleteTarget = pointRequest({ id: "landmark-delete-rollback", operationId: "landmark-delete-rollback-create" });
  await landmarkRepository.upsertFieldLandmark(deleteTarget, scopeA);
  sqlite.exec(`
    CREATE TRIGGER phase43_force_landmark_delete_audit_failure
    BEFORE INSERT ON audit_log
    WHEN NEW.action = 'paddock.landmark.deleted'
    BEGIN
      SELECT RAISE(ABORT, 'forced_phase43_landmark_delete_audit_failure');
    END;
  `);
  try {
    await assert.rejects(
      landmarkRepository.archiveFieldLandmark({
        id: deleteTarget.id,
        fieldId: deleteTarget.fieldId,
        operationId: "landmark-delete-rollback-op",
        expectedVersion: 1,
      }, scopeA),
      /forced_phase43_landmark_delete_audit_failure/u,
    );
  } finally {
    sqlite.exec("DROP TRIGGER phase43_force_landmark_delete_audit_failure");
  }
  assert.deepEqual({
    ...sqlite.prepare("SELECT deleted_at AS deletedAt, version FROM field_landmarks WHERE id = ?").get(deleteTarget.id),
  }, { deletedAt: null, version: 1 });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM field_landmark_operations WHERE id = 'landmark-delete-rollback-op'")
    .get().count, 0);
});

test("DELETE writes an immutable tombstone and prevents update, recreation and physical deletion", async () => {
  const createRequest = pointRequest({ id: "landmark-tombstone", operationId: "landmark-tombstone-create" });
  await landmarkRepository.upsertFieldLandmark(createRequest, scopeA);
  const deleteRequest = {
    id: createRequest.id,
    fieldId: createRequest.fieldId,
    operationId: "landmark-tombstone-delete",
    expectedVersion: 1,
  };
  const deleted = await landmarkRepository.archiveFieldLandmark(deleteRequest, scopeA);
  assert.equal(deleted.kind, "delete");
  assert.equal(deleted.landmark.version, 2);
  assert.equal(deleted.landmark.deletedAt, deleted.committedAt);
  assert.equal((await landmarkRepository.archiveFieldLandmark(deleteRequest, scopeA)).idempotentReplay, true);
  await assert.rejects(
    landmarkRepository.archiveFieldLandmark({ ...deleteRequest, operationId: "landmark-tombstone-delete-stale" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({
      ...createRequest,
      operationId: "landmark-tombstone-update",
      expectedVersion: 2,
    }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  await assert.rejects(
    landmarkRepository.upsertFieldLandmark({ ...createRequest, operationId: "landmark-tombstone-recreate" }, scopeA),
    (error) => error.code === "FIELD_SCOPE_CONFLICT",
  );
  const listing = await landmarkRepository.listFieldLandmarks(createRequest.fieldId, scopeA);
  assert.equal(listing.active.some(({ id }) => id === createRequest.id), false);
  assert.equal(listing.archived.some(({ id }) => id === createRequest.id), true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_id = ?")
    .get(createRequest.id).count, 2);
});

test("foreign keys and strict field ownership reject orphan writes", () => {
  assert.throws(() => sqlite.prepare(`
    INSERT INTO field_landmarks (
      id, field_id, kind, geometry_type, geometry, name, notes, length_meters,
      created_at, updated_at, version, last_operation_id
    ) VALUES (?, ?, 'bebedero', 'point', '[[0,0]]', 'Huérfano', '', 0, ?, ?, 1, ?)
  `).run(
    "orphan-landmark",
    "missing-field",
    "2026-07-20T10:00:00.000Z",
    "2026-07-20T10:00:00.000Z",
    "missing-operation",
  ), /FOREIGN KEY constraint failed/u);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("route and client expose private outbox-ready contracts without resurrection SQL", async () => {
  const [route, repository, client, domain, importer] = await Promise.all([
    source("app/api/potreros/hitos/route.ts"),
    source("src/modules/potreros/server/field-landmark-repository.ts"),
    source("src/modules/potreros/api/field-landmarks-client.ts"),
    source("src/modules/potreros/domain/field-landmarks.ts"),
    source("src/modules/potreros/import/types.ts"),
  ]);
  assert.match(route, /authorizeApiAccess\("view"\)/u);
  assert.match(route, /authorizeApiAccess\("operate"\)/u);
  assert.match(route, /requireContextField\(access, fieldId\)/u);
  assert.match(route, /private, no-store/u);
  assert.match(repository, /client\.batch|\.batch\(statements\)/u);
  assert.match(repository, /INSERT INTO audit_log/u);
  assert.doesNotMatch(repository, /DELETE FROM field_landmarks/u);
  assert.doesNotMatch(repository, /SET deleted_at = NULL/u);
  assert.match(client, /fieldLandmarkOutboxKey/u);
  assert.match(client, /request\.operationId/u);
  assert.match(client, /JSON\.stringify\(request\)/u);
  assert.match(domain, /type: "Point"/u);
  assert.match(domain, /type: "LineString"/u);
  assert.match(importer, /type: "Point"/u);
  assert.match(importer, /type: "LineString"/u);
});

function pointRequest(overrides = {}) {
  return {
    id: "landmark-point",
    fieldId: "field-landmark-a",
    kind: "bebedero",
    geometryType: "point",
    geometry: [[-40.5, -73.1]],
    name: "Bebedero norte",
    notes: "Operativo",
    operationId: "landmark-point-create",
    expectedVersion: null,
    ...overrides,
  };
}

function lineRequest(overrides = {}) {
  return {
    id: "landmark-line",
    fieldId: "field-landmark-a",
    kind: "linea_agua",
    geometryType: "line",
    geometry: [[-40, -73], [-40, -72.999]],
    name: "Línea de agua",
    notes: "PVC",
    operationId: "landmark-line-create",
    expectedVersion: null,
    ...overrides,
  };
}

function seedFixtures(database) {
  database.prepare("INSERT INTO organizations (id, name) VALUES (?, ?), (?, ?)")
    .run("org-landmark-a", "Organization A", "org-landmark-b", "Organization B");
  database.prepare(`
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates)
    VALUES (?, ?, ?, 'Osorno', 0, 10, '[]'), (?, ?, ?, 'Osorno', 0, 10, '[]')
  `).run(
    "field-landmark-a",
    "org-landmark-a",
    "Field A",
    "field-landmark-b",
    "org-landmark-b",
    "Field B",
  );
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
