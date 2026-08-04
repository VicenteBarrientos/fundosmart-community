import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const actorA = {
  membershipId: "sale-member-a",
  organizationId: "sale-org-a",
  fieldId: "sale-field-a",
  fieldIds: ["sale-field-a"],
  email: "owner-a@example.com",
};

let sqlite;
let d1;
let r2;
let vite;
let saleRepo;

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
    CREATE TABLE IF NOT EXISTS livestock_sale_documents (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      document_type TEXT NOT NULL DEFAULT 'liquidacion_feria',
      document_number TEXT,
      buyer_or_supplier_name TEXT NOT NULL,
      document_date TEXT NOT NULL,
      total_amount_clp INTEGER NOT NULL DEFAULT 0,
      object_key TEXT,
      sha256 TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_by_email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS livestock_sale_document_links (
      id TEXT PRIMARY KEY NOT NULL,
      document_id TEXT NOT NULL REFERENCES livestock_sale_documents(id) ON DELETE CASCADE,
      animal_id TEXT REFERENCES livestock_animals(id) ON DELETE SET NULL,
      lot_id TEXT REFERENCES livestock_lots(id) ON DELETE SET NULL,
      allocated_amount_clp INTEGER NOT NULL DEFAULT 0,
      allocated_weight_kg REAL,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES (
      'google:sale-owner', 'google', 'sale-owner',
      'owner-a@example.com', 'owner-a@example.com', 'Owner A', 1, 1
    );
    INSERT INTO organizations (
      id, name, kind, plan_code, field_limit, paddock_limit, self_service_owner_email
    ) VALUES (
      'sale-org-a', 'Fundo Ventas A', 'shared', 'pro', 5, 100, 'owner-a@example.com'
    );
    INSERT INTO fields (
      id, organization_id, name, location, is_demo, area_hectares, coordinates
    ) VALUES (
      'sale-field-a', 'sale-org-a', 'Fundo El Mirador', 'Osorno', 0, 100, '[]'
    );
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name, role, status, created_by
    ) VALUES (
      'sale-member-a', 'sale-org-a', 'owner-a@example.com', 'owner-a@example.com', 'Owner A', 'owner', 'active', 'test'
    );
    INSERT INTO livestock_lots (
      id, field_id, name, category, animal_count, entry_date
    ) VALUES (
      'sale-lot-a', 'sale-field-a', 'Lote Crianza A', 'steer', 1, '2026-01-01'
    );
    INSERT INTO livestock_animals (
      id, lot_id, tag, sex, status, birth_date, purchase_price_clp
    ) VALUES (
      'anim-sale-1', 'sale-lot-a', 'DIIO-1001', 'male', 'active', '2024-01-15', 200000
    );
  `);

  d1 = new TestD1Database(sqlite);
  r2 = new TestR2Bucket();
  globalThis.__FUNDOSMART_SALE_TEST_ENV__ = { DB: d1, FILES: r2 };
  const virtualWorkers = "\0fundosmart-sale-cloudflare-workers";

  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-sale-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_SALE_TEST_ENV__";
        }
      },
    }],
  });

  saleRepo = await vite.ssrLoadModule("/src/modules/ganado/server/livestock-sale-repository.ts");
});

after(async () => {
  await vite?.close();
  sqlite?.close();
});

test("createSaleDocument, linkSaleDocument, and query getAnimalEconomicMargin", async () => {
  // 1. Create document
  const doc = await saleRepo.createSaleDocument({
    access: actorA,
    fieldId: "sale-field-a",
    documentType: "liquidacion_feria",
    documentNumber: "LIQ-2026-888",
    buyerOrSupplierName: "Feria Tattersall Osorno",
    documentDate: "2026-07-28",
    totalAmountClp: 1200000,
  });

  assert.equal(doc.buyerOrSupplierName, "Feria Tattersall Osorno");
  assert.equal(doc.status, "pending");

  // 2. Link animal to document
  const link = await saleRepo.linkSaleDocument({
    access: actorA,
    documentId: doc.id,
    animalId: "anim-sale-1",
    allocatedAmountClp: 650000,
    allocatedWeightKg: 430,
    notes: "Venta novillo DIIO-1001",
  });

  assert.equal(link.status, "reconciled");

  // 3. Query animal economic margin
  const margin = await saleRepo.getAnimalEconomicMargin({
    access: actorA,
    animalId: "anim-sale-1",
  });

  assert.equal(margin.revenueClp, 650000);
  assert.equal(margin.isReconciled, true);
  assert.ok(margin.marginClp !== null && margin.marginClp > 0);
  assert.ok(margin.imputationRule.length > 0);
});

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
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
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

  async exec(sql) {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }
}

class TestR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, bytes, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const storedBytes = Uint8Array.from(new Uint8Array(bytes));
    const httpEtag = `"test-${storedBytes.byteLength}"`;
    this.objects.set(key, {
      bytes: storedBytes,
      customMetadata: { ...(options.customMetadata ?? {}) },
      checksums: options.sha256 ? { sha256: Uint8Array.from(Buffer.from(String(options.sha256), "hex")).buffer } : {},
      httpEtag,
    });
    return { httpEtag };
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata }, checksums: { ...stored.checksums }, httpEtag: stored.httpEtag } : null;
  }

  async get(key) {
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata }, checksums: { ...stored.checksums }, httpEtag: stored.httpEtag, arrayBuffer: async () => stored.bytes.slice().buffer } : null;
  }

  async delete(key) {
    this.objects.delete(key);
  }
}
