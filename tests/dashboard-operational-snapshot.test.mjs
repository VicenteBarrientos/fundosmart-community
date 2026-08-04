import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

import {
  buildDashboardHerdWorkItems,
  buildHerdOperations,
} from "../src/modules/ganado/lib/operations-rules.ts";

const root = process.cwd();
const NOW = "2026-07-20T12:00:00.000Z";
const scope = {
  organizationId: "dashboard-org-a",
  fieldIds: ["dashboard-field-a"],
};

let sqlite;
let d1;
let vite;
let repository;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle")))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
    .sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.exec(`
    INSERT INTO organizations (id, name, kind, plan_code) VALUES
      ('dashboard-org-a', 'Organización A', 'shared', 'legacy'),
      ('dashboard-org-b', 'Organización B', 'shared', 'legacy');
    INSERT INTO fields (
      id, organization_id, name, location, is_demo, area_hectares, coordinates
    ) VALUES
      ('dashboard-field-a', 'dashboard-org-a', 'Campo A', 'Osorno', 0, 20, '[]'),
      ('dashboard-field-b', 'dashboard-org-b', 'Campo B', 'Osorno', 0, 20, '[]');
    INSERT INTO potreros (
      id, field_id, name, sector, area_hectares, coordinates, archived_at
    ) VALUES
      ('dashboard-paddock-a', 'dashboard-field-a', 'Potrero A', 'Norte', 10, '[]', NULL),
      ('dashboard-paddock-a-archived', 'dashboard-field-a', 'Potrero A archivado', 'Norte', 2, '[]', '2026-07-10'),
      ('dashboard-paddock-b', 'dashboard-field-b', 'Potrero B', 'Sur', 10, '[]', NULL);
    INSERT INTO activities (
      id, paddock_id, type, occurred_at, description, cost_clp, created_at, deleted_at
    ) VALUES
      ('dashboard-activity-a-1', 'dashboard-paddock-a', 'maintenance', '2026-07-01', 'A 1', 100, '2026-07-01T12:00:00Z', NULL),
      ('dashboard-activity-a-2', 'dashboard-paddock-a', 'maintenance', '2026-07-02', 'A 2', 200, '2026-07-02T12:00:00Z', NULL),
      ('dashboard-activity-a-3', 'dashboard-paddock-a', 'maintenance', '2026-07-03', 'A 3', 300, '2026-07-03T12:00:00Z', NULL),
      ('dashboard-activity-a-4', 'dashboard-paddock-a', 'maintenance', '2026-07-04', 'A 4', 400, '2026-07-04T12:00:00Z', NULL),
      ('dashboard-activity-a-5', 'dashboard-paddock-a', 'maintenance', '2026-07-05', 'A 5', 500, '2026-07-05T12:00:00Z', NULL),
      ('dashboard-activity-a-6', 'dashboard-paddock-a', 'maintenance', '2026-07-06', 'A 6', 600, '2026-07-06T12:00:00Z', NULL),
      ('dashboard-activity-a-7', 'dashboard-paddock-a', 'maintenance', '2026-07-07', 'A 7', 700, '2026-07-07T12:00:00Z', NULL),
      ('dashboard-activity-a-old', 'dashboard-paddock-a', 'maintenance', '2026-06-15', 'A old', 900, '2026-06-15T12:00:00Z', NULL),
      ('dashboard-activity-a-deleted', 'dashboard-paddock-a', 'maintenance', '2026-07-20', 'A deleted', 8000, '2026-07-20T12:00:00Z', '2026-07-20T13:00:00Z'),
      ('dashboard-activity-a-archived', 'dashboard-paddock-a-archived', 'maintenance', '2026-07-19', 'A archived', 7000, '2026-07-19T12:00:00Z', NULL),
      ('dashboard-activity-b', 'dashboard-paddock-b', 'maintenance', '2026-07-18', 'B', 9999, '2026-07-18T12:00:00Z', NULL);
    INSERT INTO livestock_lots (
      id, field_id, name, category, animal_count, entry_date, tracking_mode
    ) VALUES
      ('dashboard-lot-a', 'dashboard-field-a', 'Vacas A', 'dairy_cow', 1, '2025-01-01', 'individual'),
      ('dashboard-lot-a-empty', 'dashboard-field-a', 'Vacas secas A', 'dry_cow', 0, '2025-01-01', 'summary'),
      ('dashboard-lot-b', 'dashboard-field-b', 'Vacas B', 'dairy_cow', 1, '2025-01-01', 'individual');
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status, source) VALUES
      ('dashboard-cow-a', 'dashboard-lot-a', 'A-001', 'female', 'active', 'Prueba'),
      ('dashboard-cow-b', 'dashboard-lot-b', 'B-001', 'female', 'active', 'Prueba');
    INSERT INTO livestock_weighings (
      id, lot_id, animal_id, recorded_at, weight_kg, source
    ) VALUES
      ('dashboard-weight-a-old', 'dashboard-lot-a', 'dashboard-cow-a', '2026-01-01', 480, 'Prueba'),
      ('dashboard-weight-a-latest', 'dashboard-lot-a', 'dashboard-cow-a', '2026-04-01', 510, 'Prueba'),
      ('dashboard-weight-b', 'dashboard-lot-b', 'dashboard-cow-b', '2026-04-15', 520, 'Prueba');
    INSERT INTO livestock_reproductive_events (
      id, field_id, animal_id, event_type, occurred_at, result, sire_identifier, created_by
    ) VALUES
      ('dashboard-service-a', 'dashboard-field-a', 'dashboard-cow-a', 'insemination', '2026-01-01', NULL, 'TORO-A', 'test'),
      ('dashboard-diagnosis-a', 'dashboard-field-a', 'dashboard-cow-a', 'pregnancy_diagnosis', '2026-02-10', 'positive', NULL, 'test'),
      ('dashboard-service-b', 'dashboard-field-b', 'dashboard-cow-b', 'insemination', '2026-01-01', NULL, 'TORO-B', 'test');
    INSERT INTO livestock_births (
      id, field_id, dam_animal_id, occurred_at, calving_type, difficulty, outcome, created_by
    ) VALUES
      ('dashboard-birth-a', 'dashboard-field-a', 'dashboard-cow-a', '2025-01-01', 'single', 'unassisted', 'live', 'test');
    INSERT INTO livestock_health_events (
      id, field_id, animal_id, event_type, occurred_at, status, condition,
      product_name, withdrawal_milk_until, withdrawal_meat_until, created_by
    ) VALUES
      ('dashboard-health-a', 'dashboard-field-a', 'dashboard-cow-a', 'treatment', '2026-07-01', 'open', 'Mastitis',
       'Producto A', '2026-07-25', '2026-07-28', 'test'),
      ('dashboard-health-b', 'dashboard-field-b', 'dashboard-cow-b', 'treatment', '2026-07-01', 'open', 'Mastitis',
       'Producto B', '2026-07-25', '2026-07-28', 'test');
    INSERT INTO livestock_milk_controls (
      id, field_id, animal_id, control_date, total_liters, somatic_cell_count, created_by
    ) VALUES
      ('dashboard-control-a-old', 'dashboard-field-a', 'dashboard-cow-a', '2026-06-15', 20, 300000, 'test'),
      ('dashboard-control-a-latest', 'dashboard-field-a', 'dashboard-cow-a', '2026-07-15', 18, 800000, 'test'),
      ('dashboard-control-b', 'dashboard-field-b', 'dashboard-cow-b', '2026-07-15', 18, 900000, 'test');
  `);

  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_DASHBOARD_SNAPSHOT_TEST_ENV__ = { DB: d1 };
  const virtualWorkers = "\0fundosmart-dashboard-snapshot-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-dashboard-snapshot-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_DASHBOARD_SNAPSHOT_TEST_ENV__";
        }
      },
    }],
  });
  repository = await vite.ssrLoadModule(
    "/src/modules/dashboard/dashboard-operational-snapshot-repository.ts",
  );
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_DASHBOARD_SNAPSHOT_TEST_ENV__;
});

test("narrow herd builder preserves the full operations work queue", () => {
  const lot = fixtureLot();
  const animal = fixtureAnimal({ latestWeightDate: "2026-04-01", latestWeightKg: 510 });
  const reproductiveEvents = [
    fixtureReproductiveEvent(),
    fixtureReproductiveEvent({
      id: "diagnosis-a",
      eventType: "pregnancy_diagnosis",
      occurredAt: "2026-02-10",
      result: "positive",
      sireIdentifier: null,
    }),
  ];
  const births = [fixtureBirth()];
  const healthEvents = [fixtureHealthEvent()];
  const weighings = [
    fixtureWeighing({ id: "weight-old", recordedAt: "2026-01-01", weightKg: 480 }),
    fixtureWeighing({ id: "weight-latest", recordedAt: "2026-04-01", weightKg: 510 }),
  ];
  const full = buildHerdOperations({
    animals: [animal],
    lots: [lot],
    weighings,
    reproductiveEvents,
    births,
    healthEvents,
    expenses: [],
    now: NOW,
  });
  const narrow = buildDashboardHerdWorkItems({
    animals: [animal],
    lots: [lot],
    reproductiveEvents,
    births,
    healthEvents,
    now: NOW,
  });

  assert.deepEqual(narrow, full.workItems);
});

test("loads tenant-safe dashboard operations in one narrow D1 batch", async () => {
  const before = d1.batchCalls;
  const snapshot = await repository.getDashboardOperationalSnapshot(scope, {
    includeActivityCosts: true,
    now: NOW,
  });

  assert.equal(d1.batchCalls - before, 1);
  assert.equal(d1.lastBatchSql.length, 8);
  assert.doesNotMatch(
    d1.lastBatchSql.join("\n"),
    /livestock_birth_offspring|livestock_lactations|milk_bulk_production|milk_quality_samples|pabco_compliance_items|milk_settlements|json_object/iu,
  );
  assert.deepEqual(snapshot.animals.map((animal) => animal.id), ["dashboard-cow-a"]);
  assert.deepEqual(
    snapshot.activities.map((activity) => activity.id),
    [
      "dashboard-activity-a-7",
      "dashboard-activity-a-6",
      "dashboard-activity-a-5",
      "dashboard-activity-a-4",
      "dashboard-activity-a-3",
    ],
  );
  assert.deepEqual(snapshot.activityCostsByPeriod, [
    { fieldId: "dashboard-field-a", period: "2026-07", costClp: 2800 },
    { fieldId: "dashboard-field-a", period: "2026-06", costClp: 900 },
  ]);
  assert.deepEqual(
    snapshot.lots.map((lot) => lot.id),
    ["dashboard-lot-a", "dashboard-lot-a-empty"],
  );
  assert.equal(snapshot.animals[0].latestWeightDate, "2026-04-01");
  assert.equal(snapshot.animals[0].latestWeightKg, 510);
  assert.equal("snapshotToken" in snapshot.animals[0], false);
  assert.equal(snapshot.herdWorkItems.some((item) => item.animalId === "dashboard-cow-b"), false);
  assert.deepEqual(
    snapshot.herdWorkItems
      .filter((item) => item.animalId === "dashboard-cow-a")
      .map((item) => [item.kind, item.dueDate]),
    [
      ["health_follow_up", "2026-07-08"],
      ["withdrawal", "2026-07-28"],
      ["weighing", "2026-07-30"],
      ["dry_off", "2026-08-12"],
      ["calving", "2026-10-11"],
    ],
  );
  assert.equal(snapshot.mammaryWorkItems.length, 1);
  assert.deepEqual(
    {
      animalId: snapshot.mammaryWorkItems[0].animalId,
      priority: snapshot.mammaryWorkItems[0].priority,
      action: snapshot.mammaryWorkItems[0].action,
      status: snapshot.mammaryWorkItems[0].status,
      trend: snapshot.mammaryWorkItems[0].trend,
      hasOpenMastitis: snapshot.mammaryWorkItems[0].hasOpenMastitis,
    },
    {
      animalId: "dashboard-cow-a",
      priority: "urgent",
      action: "review_now",
      status: "critical",
      trend: "increasing",
      hasOpenMastitis: true,
    },
  );

  const viewerSnapshot = await repository.getDashboardOperationalSnapshot(scope, { now: NOW });
  assert.equal(d1.lastBatchSql.length, 7);
  assert.deepEqual(viewerSnapshot.activityCostsByPeriod, []);
});

function fixtureLot(overrides = {}) {
  return {
    id: "lot-a",
    fieldId: "field-a",
    paddockId: null,
    name: "Vacas A",
    category: "dairy_cow",
    animalCount: 1,
    averageWeightKg: 510,
    entryDate: "2025-01-01",
    status: "active",
    ownerName: null,
    trackingMode: "individual",
    notes: "",
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureAnimal(overrides = {}) {
  return {
    id: "cow-a",
    lotId: "lot-a",
    tag: "A-001",
    sex: "female",
    status: "active",
    statusDate: null,
    statusReason: null,
    birthDate: "2023-01-01",
    purchasePriceClp: null,
    purchaseDate: null,
    salePriceClp: null,
    saleBuyer: null,
    saleWeightKg: null,
    origin: null,
    notes: "",
    source: "Prueba",
    latestWeightKg: null,
    latestWeightDate: null,
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureReproductiveEvent(overrides = {}) {
  return {
    id: "service-a",
    fieldId: "field-a",
    animalId: "cow-a",
    eventType: "insemination",
    occurredAt: "2026-01-01",
    method: null,
    result: null,
    sireIdentifier: "TORO-A",
    sireAnimalId: null,
    notes: "",
    metadata: {},
    source: "Prueba",
    sourceRecordId: null,
    createdBy: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureBirth(overrides = {}) {
  return {
    id: "birth-a",
    fieldId: "field-a",
    damAnimalId: "cow-a",
    reproductiveEventId: null,
    occurredAt: "2025-01-01",
    calvingType: "single",
    difficulty: "unassisted",
    outcome: "live",
    sireIdentifier: null,
    sireAnimalId: null,
    notes: "",
    source: "Prueba",
    sourceRecordId: null,
    createdBy: "test",
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    offspring: [],
    ...overrides,
  };
}

function fixtureHealthEvent(overrides = {}) {
  return {
    id: "health-a",
    fieldId: "field-a",
    animalId: "cow-a",
    eventType: "treatment",
    occurredAt: "2026-07-01",
    status: "open",
    condition: "Mastitis",
    productName: "Producto A",
    activeIngredient: null,
    doseAmount: null,
    doseUnit: null,
    route: null,
    withdrawalMilkUntil: "2026-07-25",
    withdrawalMeatUntil: "2026-07-28",
    professional: null,
    notes: "",
    metadata: {},
    source: "Prueba",
    sourceRecordId: null,
    createdBy: "test",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function fixtureWeighing(overrides = {}) {
  return {
    id: "weight-a",
    lotId: "lot-a",
    animalId: "cow-a",
    recordedAt: "2026-04-01",
    weightKg: 510,
    notes: "",
    source: "Prueba",
    createdAt: "2026-04-01T00:00:00.000Z",
    ...overrides,
  };
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
    return {
      results: this.database.prepare(this.sql).all(...this.bindings),
      success: true,
      meta: {},
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.batchCalls = 0;
    this.lastBatchSql = [];
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.lastBatchSql = statements.map((statement) => statement.sql);
    for (const statement of statements) {
      assert.ok(statement.bindings.length <= 100);
    }
    return Promise.all(statements.map((statement) => statement.all()));
  }
}
