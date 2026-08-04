import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const scope = { organizationId: "org-linked-boundary", fieldIds: ["field-linked-boundary"] };
const originalFieldCoordinates = [
  [-40, -73],
  [-40, -72.99],
  [-39.99, -72.99],
  [-39.99, -73],
];
const nextFieldCoordinates = [
  [-40, -73],
  [-40, -72.988],
  [-39.99, -72.99],
  [-39.99, -73],
];
const originalPaddockCoordinates = [
  [-40, -73],
  [-40, -72.99],
  [-39.995, -72.99],
  [-39.995, -73],
];
const nextPaddockCoordinates = [
  [-40, -73],
  [-40, -72.988],
  [-39.995, -72.989],
  [-39.995, -73],
];

let sqlite;
let testDb;
let vite;
let fundoRepository;
let potreroRepository;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle")))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
    .sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  testDb = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_LINKED_BOUNDARY_TEST_ENV__ = { DB: testDb };

  const virtualWorkers = "\0fundosmart-linked-boundary-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-linked-boundary-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_LINKED_BOUNDARY_TEST_ENV__";
        }
      },
    }],
  });
  [fundoRepository, potreroRepository] = await Promise.all([
    vite.ssrLoadModule("/src/modules/potreros/server/fundo-repository.ts"),
    vite.ssrLoadModule("/src/modules/potreros/server/potrero-repository.ts"),
  ]);
});

beforeEach(() => {
  resetFixture();
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_LINKED_BOUNDARY_TEST_ENV__;
});

test("guarda el fundo y sus potreros vinculados en una sola versión", async () => {
  const input = await linkedBoundaryInput();
  const saved = await potreroRepository.updateLinkedFieldBoundary(input.fundo, input.potreros, scope);

  assert.deepEqual(saved.fundo.coordinates, nextFieldCoordinates);
  assert.deepEqual(saved.potreros[0].coordinates, nextPaddockCoordinates);
  assert.notEqual(saved.fundo.snapshotToken, input.fundo.snapshotToken);
  assert.notEqual(saved.potreros[0].updatedAt, input.potreros[0].updatedAt);

  const fieldRow = sqlite.prepare("SELECT coordinates FROM fields WHERE id = ?").get(scope.fieldIds[0]);
  const paddockRow = sqlite.prepare("SELECT coordinates FROM potreros WHERE id = ?").get("paddock-linked-boundary");
  assert.deepEqual(JSON.parse(fieldRow.coordinates), nextFieldCoordinates);
  assert.deepEqual(JSON.parse(paddockRow.coordinates).outer, nextPaddockCoordinates);
});

test("un cambio concurrente del potrero deja intacto el límite del fundo", async () => {
  const input = await linkedBoundaryInput();
  testDb.beforeNextBatch(() => {
    sqlite.prepare("UPDATE potreros SET updated_at = ? WHERE id = ?")
      .run("2026-07-27T12:30:00.000Z", "paddock-linked-boundary");
  });

  await assert.rejects(
    potreroRepository.updateLinkedFieldBoundary(input.fundo, input.potreros, scope),
    /cambió antes de guardar/iu,
  );
  assert.deepEqual(
    JSON.parse(sqlite.prepare("SELECT coordinates FROM fields WHERE id = ?").get(scope.fieldIds[0]).coordinates),
    originalFieldCoordinates,
  );
  assert.deepEqual(
    JSON.parse(sqlite.prepare("SELECT coordinates FROM potreros WHERE id = ?").get("paddock-linked-boundary").coordinates).outer,
    originalPaddockCoordinates,
  );
});

test("un cambio concurrente del fundo deja intacto el límite del potrero", async () => {
  const input = await linkedBoundaryInput();
  testDb.beforeNextBatch(() => {
    sqlite.prepare("UPDATE fields SET name = ? WHERE id = ?")
      .run("Nombre concurrente", scope.fieldIds[0]);
  });

  await assert.rejects(
    potreroRepository.updateLinkedFieldBoundary(input.fundo, input.potreros, scope),
    /cambió antes de guardar/iu,
  );
  assert.equal(
    sqlite.prepare("SELECT name FROM fields WHERE id = ?").get(scope.fieldIds[0]).name,
    "Nombre concurrente",
  );
  assert.deepEqual(
    JSON.parse(sqlite.prepare("SELECT coordinates FROM fields WHERE id = ?").get(scope.fieldIds[0]).coordinates),
    originalFieldCoordinates,
  );
  assert.deepEqual(
    JSON.parse(sqlite.prepare("SELECT coordinates FROM potreros WHERE id = ?").get("paddock-linked-boundary").coordinates).outer,
    originalPaddockCoordinates,
  );
});

test("la ruta exige alcance, snapshot y reautorización, y el cliente usa el endpoint combinado", async () => {
  const [route, repository, client] = await Promise.all([
    readFile(path.join(root, "app/api/potreros/limites-fundo/route.ts"), "utf8"),
    readFile(path.join(root, "src/modules/potreros/server/potrero-repository.ts"), "utf8"),
    readFile(path.join(root, "src/modules/potreros/api/potreros-client.ts"), "utf8"),
  ]);

  assert.match(route, /authorizeApiAccess\("manage_members"\)/u);
  assert.match(route, /requireContextField\(access, payload\.fundo\.id\)/u);
  assert.match(route, /requireResourceField\(access, "paddock", potrero\.id\)/u);
  assert.match(route, /reauthorizeApiAccess\(access, "operate", saved\.fundo\.id\)/u);
  assert.match(repository, /client\.batch\(\[\s*paddockMutation,\s*fieldMutation,\s*selectField,\s*selectPaddocks,/u);
  assert.match(client, /"\/api\/potreros\/limites-fundo"/u);
});

async function linkedBoundaryInput() {
  const [fundo] = await fundoRepository.listFundos(scope);
  const [potrero] = await potreroRepository.listPotreros(scope, scope.fieldIds[0]);
  return {
    fundo: {
      ...fundo,
      areaHectares: 110,
      coordinates: nextFieldCoordinates,
    },
    potreros: [{
      ...potrero,
      areaHectares: 55,
      coordinates: nextPaddockCoordinates,
      geometry: { outer: nextPaddockCoordinates, holes: [] },
    }],
  };
}

function resetFixture() {
  sqlite.prepare("DELETE FROM potreros WHERE id = ?").run("paddock-linked-boundary");
  sqlite.prepare("DELETE FROM fields WHERE id = ?").run(scope.fieldIds[0]);
  sqlite.prepare("DELETE FROM organizations WHERE id = ?").run(scope.organizationId);
  sqlite.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)")
    .run(scope.organizationId, "Organización límites");
  sqlite.prepare(`
    INSERT INTO fields
      (id, organization_id, name, location, is_demo, area_hectares, coordinates, created_at)
    VALUES (?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    scope.fieldIds[0],
    scope.organizationId,
    "Fundo límites",
    "Osorno",
    100,
    JSON.stringify(originalFieldCoordinates),
    "2026-07-27T12:00:00.000Z",
  );
  sqlite.prepare(`
    INSERT INTO potreros
      (id, field_id, name, sector, area_hectares, coordinates, hole_kinds, last_activity, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
  `).run(
    "paddock-linked-boundary",
    scope.fieldIds[0],
    "Potrero límite",
    "Norte",
    50,
    JSON.stringify({ outer: originalPaddockCoordinates, holes: [] }),
    "Sin actividad",
    "Disponible",
    "2026-07-27T12:00:00.000Z",
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
