import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { portableMilkSettlementIntegrityIssues } from "../src/modules/leche/server/milk-settlement-integrity.mjs";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";

const migrationDirectory = new URL("../drizzle/", import.meta.url);
const milkSettlementSql = publicSqlForTables(["milk_settlements"]);
const settlementColumns = [
  "id",
  "field_id",
  "period",
  "generated_at",
  "plant",
  "purchase_order",
  "producer_code",
  "producer_name",
  "buyer_name",
  "liters_first_half",
  "liters_second_half",
  "total_liters",
  "net_amount_clp",
  "tax_amount_clp",
  "gross_amount_clp",
  "net_price_per_liter_clp",
  "gross_price_per_liter_clp",
  "source_document_name",
  "notes",
  "line_items",
  "created_at",
  "updated_at",
];

function validSettlement(overrides = {}) {
  return {
    id: "settlement-d1",
    field_id: "field-d1",
    period: "2026-06",
    generated_at: "2026-06-30T12:00:00.000Z",
    plant: "Planta Osorno",
    purchase_order: "OC-D1",
    producer_code: "P-D1",
    producer_name: "Productor D1",
    buyer_name: "Comprador D1",
    liters_first_half: 500,
    liters_second_half: 500,
    total_liters: 1000,
    net_amount_clp: 300000,
    tax_amount_clp: 57000,
    gross_amount_clp: 357000,
    net_price_per_liter_clp: 300,
    gross_price_per_liter_clp: 357,
    source_document_name: "liquidacion.pdf",
    notes: "",
    line_items: JSON.stringify([]),
    created_at: "2026-07-18T03:00:00.000Z",
    updated_at: "2026-07-18T03:00:00.000Z",
    ...overrides,
  };
}

async function milkDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE fields (id text PRIMARY KEY NOT NULL)");
  database.exec(milkSettlementSql);
  database.prepare("INSERT INTO fields (id) VALUES (?)").run("field-d1");
  return database;
}

function insertSettlement(database, settlement) {
  const placeholders = settlementColumns.map(() => "?").join(", ");
  database.prepare(`
    INSERT INTO milk_settlements (${settlementColumns.join(", ")})
    VALUES (${placeholders})
  `).run(...settlementColumns.map((column) => settlement[column]));
}

test("D1 accepts a valid milk settlement", async () => {
  const database = await milkDatabase();
  try {
    insertSettlement(database, validSettlement());
    const stored = database.prepare(`
      SELECT period, total_liters, gross_amount_clp
      FROM milk_settlements
      WHERE id = ?
    `).get("settlement-d1");
    assert.deepEqual({ ...stored }, {
      period: "2026-06",
      total_liters: 1000,
      gross_amount_clp: 357000,
    });
  } finally {
    database.close();
  }
});

test("D1 rejects invalid scalar settlement inserts atomically", async () => {
  const invalidCases = [
    { period: "2026-13" },
    { generated_at: "not-a-date" },
    { generated_at: "2026-02-30T12:00:00Z" },
    { liters_second_half: 499 },
    { liters_first_half: -1, liters_second_half: 1001 },
    {
      liters_first_half: 500000000000,
      liters_second_half: 499999999500,
      total_liters: 1000000000000,
      net_amount_clp: 1000000000000,
      tax_amount_clp: 0,
      gross_amount_clp: 1000000000000,
      net_price_per_liter_clp: 1,
      gross_price_per_liter_clp: 1,
    },
    { gross_amount_clp: 356999 },
    { net_price_per_liter_clp: 299 },
    { gross_price_per_liter_clp: 356 },
    { purchase_order: " " },
    { source_document_name: "" },
    { line_items: "not-json" },
    { line_items: JSON.stringify({ description: "Leche" }) },
    { created_at: "not-a-date" },
    { created_at: "2460000" },
  ];
  const database = await milkDatabase();
  try {
    invalidCases.forEach((overrides, index) => {
      const settlement = validSettlement({
        id: `settlement-invalid-${index}`,
        purchase_order: `OC-INVALID-${index}`,
        ...overrides,
      });
      assert.throws(
        () => insertSettlement(database, settlement),
        /milk_settlement_integrity_invalid/,
      );
    });
    assert.equal(
      database.prepare("SELECT COUNT(*) AS count FROM milk_settlements").get().count,
      0,
    );
  } finally {
    database.close();
  }
});

test("D1 rejects invalid settlement updates and preserves the stored row", async () => {
  const invalidUpdates = [
    ["period", "2026-00"],
    ["total_liters", 999],
    ["tax_amount_clp", -1],
    ["net_price_per_liter_clp", 1],
    ["updated_at", "not-a-date"],
    ["line_items", "{}"],
  ];
  const database = await milkDatabase();
  try {
    insertSettlement(database, validSettlement());
    for (const [column, value] of invalidUpdates) {
      assert.throws(
        () => database.prepare(`UPDATE milk_settlements SET ${column} = ? WHERE id = ?`)
          .run(value, "settlement-d1"),
        /milk_settlement_integrity_invalid/,
      );
    }
    const stored = database.prepare(`
      SELECT period, total_liters, tax_amount_clp, net_price_per_liter_clp, updated_at, line_items
      FROM milk_settlements
      WHERE id = ?
    `).get("settlement-d1");
    assert.deepEqual({ ...stored }, {
      period: "2026-06",
      total_liters: 1000,
      tax_amount_clp: 57000,
      net_price_per_liter_clp: 300,
      updated_at: "2026-07-18T03:00:00.000Z",
      line_items: "[]",
    });
  } finally {
    database.close();
  }
});

test("the public invariant layer registers and protects milk settlement writes", async () => {
  const [migration, journalSource] = await Promise.all([
    readFile(new URL("0001_public_invariants.sql", migrationDirectory), "utf8"),
    readFile(new URL("meta/_journal.json", migrationDirectory), "utf8"),
  ]);
  const journal = JSON.parse(journalSource);
  assert.match(migration, /CREATE TRIGGER `milk_settlements_integrity_insert`/);
  assert.match(migration, /CREATE TRIGGER `milk_settlements_integrity_update`/);
  assert.equal((migration.match(/milk_settlement_integrity_invalid/g) ?? []).length, 2);
  assert.deepEqual(journal.entries.find((entry) => entry.tag === "0000_public_schema"), {
    idx: 0,
    version: "6",
    when: journal.entries[0].when,
    tag: "0000_public_schema",
    breakpoints: true,
  });
});

test("the application validator and D1 reject the same date and liter bypasses", () => {
  const portable = {
    ...validSettlement(),
    line_items: [],
  };
  assert.equal(portableMilkSettlementIntegrityIssues(portable).length, 0);
  for (const overrides of [
    { generated_at: "2026-02-30T12:00:00Z" },
    { created_at: "2460000" },
    {
      liters_first_half: 500000000000,
      liters_second_half: 499999999500,
      total_liters: 1000000000000,
      net_amount_clp: 1000000000000,
      tax_amount_clp: 0,
      gross_amount_clp: 1000000000000,
      net_price_per_liter_clp: 1,
      gross_price_per_liter_clp: 1,
    },
  ]) {
    assert.notEqual(portableMilkSettlementIntegrityIssues({ ...portable, ...overrides }).length, 0);
  }
});
