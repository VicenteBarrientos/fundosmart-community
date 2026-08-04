import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";

const root = new URL("../", import.meta.url);
const benchmarkingSql = publicSqlForTables([
  "benchmark_aggregates",
  "benchmark_consents",
  "benchmark_field_profiles",
  "benchmark_positions",
]);

test("benchmarking API guards reads and mutations with the feature capability", async () => {
  const source = await readFile(new URL("app/api/benchmarking/route.ts", root), "utf8");
  assert.match(source, /authorizeApiAccess\("benchmarking:read", fieldId\)/u);
  assert.match(source, /authorizeApiAccess\("manage_members", fieldId\)/u);
  assert.match(source, /authorizeApiAccess\("benchmarking:write", fieldId\)/u);
  assert.match(source, /readJsonObject/u);
  assert.match(source, /request\.headers\.get\("Idempotency-Key"\)/u);
  assert.match(source, /bodyIdempotencyKey !== headerIdempotencyKey/u);
  assert.match(source, /idempotencyKey: headerIdempotencyKey/u);
  assert.match(source, /Cache-Control": "private, no-store"/u);
  assert.match(source, /enqueueBenchmarkAggregation/u);
  assert.doesNotMatch(source, /executeBenchmarkAggregationJob/u);
  assert.doesNotMatch(source, /cause\.message[\s\S]+status: 500/u);
});

test("the page applies field-level feature access and states the no-peer-data contract", async () => {
  const [page, client, worker, shell, observability, migration, backup] = await Promise.all([
    readFile(new URL("app/(producto)/benchmarking/page.tsx", root), "utf8"),
    readFile(new URL("src/modules/benchmarking/BenchmarkingPage.tsx", root), "utf8"),
    readFile(new URL("worker/index.ts", root), "utf8"),
    readFile(new URL("src/core/layout/AppShell.tsx", root), "utf8"),
    readFile(new URL("worker/observability.mjs", root), "utf8"),
    Promise.all([
      "drizzle/0000_public_schema.sql",
      "drizzle/0001_public_invariants.sql",
      "drizzle/0002_public_demo.sql",
    ].map((path) => readFile(new URL(path, root), "utf8"))).then((parts) => parts.join("\n")),
    readFile(new URL("src/modules/integraciones/cooprinsem/server/backup-repository.ts", root), "utf8"),
  ]);
  assert.match(page, /"benchmarking:read",\s*fieldId/u);
  assert.match(page, /isFeatureEnabled\(baseAccess, "benchmarking", fundo\.id\)/u);
  assert.match(page, /roleHasCapability\(currentAccess\.role, "benchmarking:write"\)/u);
  assert.match(client, /activeSection="benchmarking"/u);
  assert.match(client, /Nunca mostramos filas, nombres ni valores individuales/u);
  assert.match(client, /El conteo exacto permanece oculto/u);
  assert.match(client, /"Idempotency-Key": idempotencyKey/u);
  assert.match(client, /crypto\.randomUUID\(\)/u);
  assert.match(client, /sin conteo exacto, identidades ni filas individuales/u);
  assert.doesNotMatch(client, /metric\.participantCount/u);
  assert.doesNotMatch(client, /participantIds|organizationIds|peerRows/u);
  assert.match(worker, /job\.type === "benchmark\.aggregate\.v1"[\s\S]*executeBenchmarkAggregationJob/u);
  assert.match(shell, /key: "benchmarking"[\s\S]*href: "\/app\/benchmarking"/u);
  assert.match(observability, /api\/benchmarking[\s\S]*api\.benchmarking/u);
  assert.match(migration, /benchmark_positions_insert_privacy_guard/u);
  assert.match(migration, /feature-demo-benchmarking/u);
  assert.match(backup, /section: "benchmarkPositions"[\s\S]*nunca se exportan/u);
  assert.match(backup, /section: "benchmarkSuppressedCounts"[\s\S]*reidentificacion/u);
  assert.doesNotMatch(backup, /name: "benchmark(?:Positions|Aggregates)"/u);
});

test("the public DDL rejects invalid consent and private positions below k", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations (id TEXT PRIMARY KEY);
      CREATE TABLE fields (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, is_demo INTEGER NOT NULL,
        UNIQUE (organization_id, id), FOREIGN KEY (organization_id) REFERENCES organizations(id)
      );
      CREATE TABLE organization_feature_flags (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, field_id TEXT,
        feature TEXT NOT NULL, enabled INTEGER NOT NULL, created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    database.exec(benchmarkingSql);
    database.exec(`
      INSERT INTO organizations (id) VALUES ('org-real'), ('org-demo');
      INSERT INTO fields (id, organization_id, is_demo) VALUES
        ('field-real', 'org-real', 0), ('field-demo', 'org-demo', 1);
    `);
    assert.throws(() => database.exec(`
      INSERT INTO benchmark_consents
        (id, organization_id, status, terms_revision, consented_by, consented_at, created_at, updated_at)
      VALUES ('bad-consent', 'org-real', 'opted_in', NULL, 'owner@example.com',
        '2026-07-21T12:00:00.000Z', '2026-07-21T12:00:00.000Z', '2026-07-21T12:00:00.000Z')
    `), /constraint|check/iu);
    database.exec(`
      INSERT INTO benchmark_aggregates
        (id, cohort_key, period, zone, herd_size_band, production_system, metric_key, unit,
         status, participant_count, k_threshold, schema_version, computed_at)
      VALUES ('suppressed', '2026-07|los_lagos|100_199|pasture', '2026-07', 'los_lagos',
        '100_199', 'pasture', 'finance.iofc_clp', 'CLP', 'suppressed', 2, 5,
        'fundosmart.benchmarking.aggregate.v1', '2026-07-21T12:00:00.000Z');
    `);
    assert.throws(() => database.exec(`
      INSERT INTO benchmark_positions
        (id, organization_id, field_id, cohort_key, period, metric_key, unit, own_value,
         percentile_rank, schema_version, computed_at)
      VALUES ('position-suppressed', 'org-real', 'field-real',
        '2026-07|los_lagos|100_199|pasture', '2026-07', 'finance.iofc_clp', 'CLP', 100,
        50, 'fundosmart.benchmarking.aggregate.v1', '2026-07-21T12:00:00.000Z')
    `), /benchmark_position_privacy_guard/u);
    database.exec(`
      INSERT INTO benchmark_aggregates
        (id, cohort_key, period, zone, herd_size_band, production_system, metric_key, unit,
         status, participant_count, k_threshold, p10, p25, p50, p75, p90, schema_version, computed_at)
      VALUES ('published', '2026-07|los_lagos|100_199|pasture', '2026-07', 'los_lagos',
        '100_199', 'pasture', 'milk.volume_liters', 'L', 'published', 5, 5,
        10, 20, 30, 40, 50, 'fundosmart.benchmarking.aggregate.v1', '2026-07-21T12:00:00.000Z');
      INSERT INTO benchmark_positions
        (id, organization_id, field_id, cohort_key, period, metric_key, unit, own_value,
         percentile_rank, schema_version, computed_at)
      VALUES ('position-real', 'org-real', 'field-real',
        '2026-07|los_lagos|100_199|pasture', '2026-07', 'milk.volume_liters', 'L', 30,
        50, 'fundosmart.benchmarking.aggregate.v1', '2026-07-21T12:00:00.000Z');
    `);
    assert.throws(() => database.exec(`
      INSERT INTO benchmark_positions
        (id, organization_id, field_id, cohort_key, period, metric_key, unit, own_value,
         percentile_rank, schema_version, computed_at)
      VALUES ('position-demo', 'org-demo', 'field-demo',
        '2026-07|los_lagos|100_199|pasture', '2026-07', 'milk.volume_liters', 'L', 30,
        50, 'fundosmart.benchmarking.aggregate.v1', '2026-07-21T12:00:00.000Z')
    `), /benchmark_position_privacy_guard/u);
    database.exec("DELETE FROM benchmark_aggregates WHERE id = 'published'");
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM benchmark_positions").get().count, 0);
  } finally {
    database.close();
  }
});
