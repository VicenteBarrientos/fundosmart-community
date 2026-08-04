import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const ownerA = {
  membershipId: "membership-a",
  organizationId: "org-a",
  email: "owner-a@example.com",
  displayName: "Owner A",
  role: "owner",
  fieldIds: ["field-a"],
};
const ownerB = {
  membershipId: "membership-b",
  organizationId: "org-b",
  email: "owner-b@example.com",
  displayName: "Owner B",
  role: "owner",
  fieldIds: ["field-b"],
};

let sqlite;
let vite;
let repository;
let d1;

async function setup() {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(createSchema());
  seed(sqlite);
  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_BENCHMARK_TEST_ENV__ = { DB: d1 };
  const virtualWorkers = "\0fundosmart-benchmark-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-benchmark-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_BENCHMARK_TEST_ENV__";
      },
    }],
  });
  repository = await vite.ssrLoadModule("/src/modules/benchmarking/server/benchmarking-repository.ts");
}

async function teardown() {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_BENCHMARK_TEST_ENV__;
}

test("the job reads only opted-in Phase 3 metrics and publishes no peer rows", async () => {
  const result = await repository.executeBenchmarkAggregationJob({
    type: repository.BENCHMARK_JOB_TYPE,
    payload: { period: "2026-06", kThreshold: 3 },
    now: new Date("2026-07-21T12:00:00.000Z"),
  });
  assert.deepEqual(result, {
    period: "2026-06",
    aggregates: 1,
    positions: 3,
    skippedForConsentRace: 0,
  });

  const dashboard = await repository.getBenchmarkDashboard({ actor: ownerA, fieldId: "field-a", period: "2026-06" });
  assert.equal("participantCount" in dashboard.metrics[0], false);
  assert.equal(dashboard.privacy.exactParticipantCountsExposed, false);
  assert.equal(dashboard.metrics[0].percentiles.p50, 20);
  assert.deepEqual(dashboard.metrics[0].own, { value: 10, percentileRank: 16.67 });
  assert.equal(dashboard.privacy.peerRowsExposed, false);
  const serialized = JSON.stringify(dashboard);
  assert.doesNotMatch(serialized, /org-b|field-b|owner-b|demo-field|1000/u);
  assert.doesNotMatch(serialized, /org-legacy|field-legacy|999/u);
  assert.doesNotMatch(serialized, /sourceIds|references|evidence/u);
  assert.doesNotMatch(serialized, /participantCount/u);
});

test("profile writes replay exactly and a published multi-farm snapshot freezes cohort changes", async () => {
  const originalUpdatedAt = sqlite.prepare(`
    SELECT updated_at AS updatedAt FROM benchmark_field_profiles
    WHERE organization_id = 'org-a' AND field_id = 'field-a'
  `).get().updatedAt;
  const request = {
    actor: ownerA,
    fieldId: "field-a",
    period: "2026-06",
    idempotencyKey: "profile-field-a-stable",
    profile: { zone: "los_lagos", herdSizeBand: "100_199", productionSystem: "pasture" },
    now: new Date("2026-07-21T12:10:00.000Z"),
  };
  const first = await repository.saveBenchmarkProfile(request);
  const replay = await repository.saveBenchmarkProfile({ ...request, now: new Date("2026-07-21T12:20:00.000Z") });
  assert.deepEqual(replay, first);
  assert.equal(sqlite.prepare(`
    SELECT updated_at AS updatedAt FROM benchmark_field_profiles
    WHERE organization_id = 'org-a' AND field_id = 'field-a'
  `).get().updatedAt, originalUpdatedAt);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE organization_id = 'org-a' AND action = 'benchmark.profile.saved'
  `).get().count, 1);

  await assert.rejects(
    repository.saveBenchmarkProfile({
      ...request,
      profile: { ...request.profile, productionSystem: "mixed" },
    }),
    (error) => error.code === "BENCHMARK_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    repository.saveBenchmarkProfile({
      ...request,
      idempotencyKey: "profile-field-a-change-after-snapshot",
      profile: { ...request.profile, productionSystem: "mixed" },
    }),
    (error) => error.code === "BENCHMARK_PROFILE_FROZEN",
  );
  assert.equal(sqlite.prepare(`
    SELECT production_system AS productionSystem FROM benchmark_field_profiles
    WHERE organization_id = 'org-a' AND field_id = 'field-a'
  `).get().productionSystem, "pasture");
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM benchmark_positions WHERE period = '2026-06'
  `).get().count, 3);
  await assert.rejects(
    repository.enqueueBenchmarkAggregation({
      actor: ownerA,
      fieldId: "field-a",
      period: "2026-06",
      idempotencyKey: "closed-june-recompute",
      kThreshold: 5,
      now: new Date("2026-07-21T12:30:00.000Z"),
    }),
    (error) => error.code === "BENCHMARK_PERIOD_CLOSED",
  );
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM scheduled_jobs WHERE id = 'benchmark.aggregate.v1:2026-06'
  `).get().count, 0);
});

test("opt-out immediately gates reads and removes the fundo from future aggregates", async () => {
  const consentRequest = {
    actor: ownerB,
    fieldId: "field-b",
    idempotencyKey: "consent-org-b-opt-out",
    status: "opted_out",
    termsRevision: null,
    confirmed: false,
    now: new Date("2026-07-21T13:00:00.000Z"),
  };
  const firstOptOut = await repository.setBenchmarkConsent(consentRequest);
  const replayedOptOut = await repository.setBenchmarkConsent({
    ...consentRequest,
    now: new Date("2026-07-21T13:00:30.000Z"),
  });
  assert.deepEqual(replayedOptOut, firstOptOut);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE organization_id = 'org-b' AND action = 'benchmark.consent.opted_out'
  `).get().count, 1);
  await assert.rejects(
    repository.setBenchmarkConsent({
      ...consentRequest,
      status: "opted_in",
      termsRevision: "fundosmart.benchmarking.consent.v1",
      confirmed: true,
    }),
    (error) => error.code === "BENCHMARK_IDEMPOTENCY_CONFLICT",
  );
  const gated = await repository.getBenchmarkDashboard({ actor: ownerB, fieldId: "field-b", period: "2026-06" });
  assert.equal(gated.reason, "consent_required");
  assert.deepEqual(gated.metrics, []);

  await repository.executeBenchmarkAggregationJob({
    type: repository.BENCHMARK_JOB_TYPE,
    payload: { period: "2026-06", kThreshold: 3 },
    now: new Date("2026-07-21T13:01:00.000Z"),
  });
  const dashboardA = await repository.getBenchmarkDashboard({ actor: ownerA, fieldId: "field-a", period: "2026-06" });
  assert.equal(dashboardA.metrics[0].status, "suppressed");
  assert.equal("participantCount" in dashboardA.metrics[0], false);
  assert.equal(dashboardA.metrics[0].percentiles, null);
  assert.equal(dashboardA.metrics[0].own, null);
  assert.equal(sqlite.prepare("SELECT participant_count AS count FROM benchmark_aggregates").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM benchmark_positions").get().count, 0);
});

test("authorization is rechecked in the repository and recompute only enqueues", async () => {
  await assert.rejects(
    repository.getBenchmarkDashboard({ actor: ownerA, fieldId: "field-b", period: "2026-06" }),
    (error) => error.code === "BENCHMARK_SCOPE_INVALID",
  );
  await assert.rejects(
    repository.setBenchmarkConsent({
      actor: { ...ownerA, role: "manager" },
      fieldId: "field-a",
      idempotencyKey: "manager-cannot-change-consent",
      status: "opted_in",
      termsRevision: "fundosmart.benchmarking.consent.v1",
      confirmed: true,
    }),
    (error) => error.code === "BENCHMARK_CAPABILITY_REQUIRED",
  );

  const queued = await repository.enqueueBenchmarkAggregation({
    actor: ownerA,
    fieldId: "field-a",
    period: "2026-07",
    idempotencyKey: "enqueue-open-july",
    kThreshold: 5,
    now: new Date("2026-07-21T14:00:00.000Z"),
  });
  assert.equal(queued.type, "benchmark.aggregate.v1");
  const replayedQueue = await repository.enqueueBenchmarkAggregation({
    actor: ownerA,
    fieldId: "field-a",
    period: "2026-07",
    idempotencyKey: "enqueue-open-july",
    kThreshold: 5,
    now: new Date("2026-07-21T14:00:30.000Z"),
  });
  assert.deepEqual(replayedQueue, queued);
  assert.deepEqual(await repository.enqueueBenchmarkAggregation({
    actor: ownerA,
    fieldId: "field-a",
    period: "2026-07",
    idempotencyKey: "enqueue-open-july",
    kThreshold: 5,
    now: new Date("2026-08-02T14:00:30.000Z"),
  }), queued);
  await assert.rejects(
    repository.enqueueBenchmarkAggregation({
      actor: ownerA,
      fieldId: "field-a",
      period: "2026-07",
      idempotencyKey: "enqueue-open-july",
      kThreshold: 6,
      now: new Date("2026-07-21T14:00:40.000Z"),
    }),
    (error) => error.code === "BENCHMARK_IDEMPOTENCY_CONFLICT",
  );
  await assert.rejects(
    repository.enqueueBenchmarkAggregation({
      actor: ownerA,
      fieldId: "field-a",
      period: "2026-07",
      idempotencyKey: "enqueue-open-july-second-request",
      kThreshold: 5,
      now: new Date("2026-07-21T14:00:50.000Z"),
    }),
    (error) => error.code === "BENCHMARK_RECOMPUTE_COOLDOWN",
  );
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM scheduled_jobs WHERE id = 'benchmark.aggregate.v1:2026-07'
  `).get().count, 1);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE organization_id = 'org-a' AND action = 'benchmark.recompute.enqueued'
  `).get().count, 1);
  const job = sqlite.prepare("SELECT type, payload, due_at AS dueAt FROM scheduled_jobs WHERE id = ?").get(queued.jobId);
  assert.equal(job.type, "benchmark.aggregate.v1");
  assert.deepEqual(JSON.parse(job.payload), { period: "2026-07", kThreshold: 5 });
  const rolling = sqlite.prepare("SELECT type, payload, interval_seconds AS intervalSeconds FROM scheduled_jobs WHERE id = 'benchmark.aggregate.v1:rolling'").get();
  assert.equal(rolling.type, "benchmark.aggregate.v1");
  assert.deepEqual(JSON.parse(rolling.payload), { mode: "rolling", kThreshold: 5 });
  assert.equal(rolling.intervalSeconds, 86400);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM benchmark_aggregates WHERE period='2026-07'").get().count, 0);
  await repository.executeBenchmarkAggregationJob({
    id: queued.jobId,
    type: repository.BENCHMARK_JOB_TYPE,
    payload: { period: "2026-07", kThreshold: 5 },
    now: new Date("2026-07-21T14:01:00.000Z"),
  });
  assert.equal(sqlite.prepare("SELECT status FROM scheduled_jobs WHERE id = ?").get(queued.jobId).status, "paused");
  await assert.rejects(
    repository.enqueueBenchmarkAggregation({
      actor: ownerA,
      fieldId: "field-a",
      period: "2026-08",
      idempotencyKey: "enqueue-k-downgrade",
      kThreshold: 3,
    }),
    (error) => error.code === "BENCHMARK_K_DOWNGRADE_FORBIDDEN",
  );
  await assert.rejects(
    repository.enqueueBenchmarkAggregation({
      actor: ownerA,
      fieldId: "field-a",
      period: "2026-07",
      idempotencyKey: "enqueue-k-raise",
      kThreshold: 6,
      now: new Date("2026-07-21T14:02:00.000Z"),
    }),
    (error) => error.code === "BENCHMARK_K_OVERRIDE_FORBIDDEN",
  );
});

test("runtime source cannot read transactional livestock or milk tables", async () => {
  const source = await readFile(new URL("../src/modules/benchmarking/server/benchmarking-repository.ts", import.meta.url), "utf8");
  assert.match(source, /FROM analytics_herd_metrics AS metric/u);
  assert.match(source, /INNER JOIN benchmark_consents/u);
  assert.match(source, /consent\.terms_revision = \?/u);
  assert.match(source, /field\.is_demo = 0/u);
  assert.match(source, /organization_feature_flags AS field_flag/u);
  for (const forbidden of ["livestock_animals", "livestock_weighings", "milk_settlements", "milk_quality_samples", "animal_record_events"]) {
    assert.doesNotMatch(source, new RegExp(forbidden, "u"));
  }
});

test("a disabled effective feature flag removes the field from the private aggregation", async () => {
  sqlite.prepare(`
    UPDATE benchmark_consents
    SET status = 'opted_in', terms_revision = 'fundosmart.benchmarking.consent.v1',
      consented_at = '2026-07-21T15:00:00.000Z', opted_out_at = NULL
    WHERE organization_id = 'org-b'
  `).run();
  sqlite.prepare("UPDATE organization_feature_flags SET enabled = 0 WHERE organization_id = 'org-b' AND field_id = 'field-b'").run();
  const result = await repository.executeBenchmarkAggregationJob({
    type: repository.BENCHMARK_JOB_TYPE,
    payload: { period: "2026-06", kThreshold: 3 },
    now: new Date("2026-07-21T15:01:00.000Z"),
  });
  assert.equal(result.positions, 0);
  assert.equal(sqlite.prepare("SELECT participant_count AS count FROM benchmark_aggregates").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM benchmark_positions WHERE organization_id = 'org-b'").get().count, 0);
});

test("an opt-out racing a suppressed cohort discards its internal count", async () => {
  sqlite.prepare("UPDATE organization_feature_flags SET enabled = 1 WHERE feature = 'benchmarking'").run();
  sqlite.prepare(`
    UPDATE benchmark_consents
    SET status = 'opted_in', terms_revision = 'fundosmart.benchmarking.consent.v1',
      consented_at = '2026-07-21T16:00:00.000Z', opted_out_at = NULL
    WHERE organization_id IN ('org-a', 'org-b', 'org-c')
  `).run();
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      UPDATE benchmark_consents
      SET status = 'opted_out', terms_revision = NULL, consented_at = NULL,
        opted_out_at = '2026-07-21T16:00:30.000Z'
      WHERE organization_id = 'org-b'
    `).run();
  };
  const result = await repository.executeBenchmarkAggregationJob({
    type: repository.BENCHMARK_JOB_TYPE,
    payload: { period: "2026-06", kThreshold: 5 },
    now: new Date("2026-07-21T16:01:00.000Z"),
  });
  assert.equal(result.aggregates, 0);
  assert.equal(result.positions, 0);
  assert.equal(result.skippedForConsentRace, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM benchmark_aggregates WHERE period = '2026-06'").get().count, 0);
});

test("the rolling job recalculates the open month and closes the previous month on day one", async () => {
  sqlite.prepare("UPDATE organization_feature_flags SET enabled = 1 WHERE feature = 'benchmarking'").run();
  sqlite.prepare(`
    UPDATE benchmark_consents
    SET status = 'opted_in', terms_revision = 'fundosmart.benchmarking.consent.v1',
      consented_at = '2026-07-22T00:00:00.000Z', opted_out_at = NULL
    WHERE organization_id IN ('org-a', 'org-b', 'org-c')
  `).run();
  const result = await repository.executeBenchmarkAggregationJob({
    type: repository.BENCHMARK_JOB_TYPE,
    payload: { mode: "rolling", kThreshold: 3 },
    now: new Date("2026-07-01T16:00:00.000Z"),
  });
  assert.equal(result.mode, "rolling");
  assert.deepEqual(result.periods.map((entry) => entry.period), ["2026-07", "2026-06"]);
  assert.equal(result.periods[0].aggregates, 0);
  assert.equal(result.periods[1].aggregates, 1);
  assert.equal(result.periods[1].positions, 3);
});

test("the aggregate read reauthorizes persisted membership and feature in its final statement", async () => {
  d1.beforeNextAll = () => {
    sqlite.prepare("UPDATE organization_memberships SET status = 'suspended' WHERE id = 'membership-a'").run();
  };
  await assert.rejects(
    repository.getBenchmarkDashboard({ actor: ownerA, fieldId: "field-a", period: "2026-06" }),
    (error) => error.code === "BENCHMARK_SCOPE_INVALID",
  );
  sqlite.prepare("UPDATE organization_memberships SET status = 'active' WHERE id = 'membership-a'").run();

  d1.beforeNextAll = () => {
    sqlite.prepare(`
      UPDATE organization_feature_flags SET enabled = 0
      WHERE organization_id = 'org-a' AND field_id = 'field-a' AND feature = 'benchmarking'
    `).run();
  };
  await assert.rejects(
    repository.getBenchmarkDashboard({ actor: ownerA, fieldId: "field-a", period: "2026-06" }),
    (error) => error.code === "BENCHMARK_SCOPE_INVALID",
  );
  sqlite.prepare(`
    UPDATE organization_feature_flags SET enabled = 1
    WHERE organization_id = 'org-a' AND field_id = 'field-a' AND feature = 'benchmarking'
  `).run();
});

test("administrator batches fail closed when role or feature changes after the API context was built", async () => {
  const consentBefore = sqlite.prepare(`
    SELECT status, updated_at AS updatedAt FROM benchmark_consents WHERE organization_id = 'org-a'
  `).get();
  d1.beforeNextBatch = () => {
    sqlite.prepare("UPDATE organization_memberships SET role = 'manager' WHERE id = 'membership-a'").run();
  };
  await assert.rejects(
    repository.setBenchmarkConsent({
      actor: ownerA,
      fieldId: "field-a",
      idempotencyKey: "role-race-consent",
      status: "opted_out",
      termsRevision: null,
      confirmed: false,
      now: new Date("2026-07-22T10:00:00.000Z"),
    }),
    (error) => error.code === "BENCHMARK_SCOPE_CONFLICT",
  );
  sqlite.prepare("UPDATE organization_memberships SET role = 'owner' WHERE id = 'membership-a'").run();
  assert.deepEqual(sqlite.prepare(`
    SELECT status, updated_at AS updatedAt FROM benchmark_consents WHERE organization_id = 'org-a'
  `).get(), consentBefore);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log WHERE organization_id = 'org-a' AND entity_id = 'benchmark-consent:org-a'
      AND action = 'benchmark.consent.opted_out'
  `).get().count, 0);

  const profileBefore = sqlite.prepare(`
    SELECT zone, herd_size_band AS herdSizeBand, production_system AS productionSystem, updated_at AS updatedAt
    FROM benchmark_field_profiles WHERE organization_id = 'org-a' AND field_id = 'field-a'
  `).get();
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      UPDATE organization_feature_flags SET enabled = 0
      WHERE organization_id = 'org-a' AND field_id = 'field-a' AND feature = 'benchmarking'
    `).run();
  };
  await assert.rejects(
    repository.saveBenchmarkProfile({
      actor: ownerA,
      fieldId: "field-a",
      period: "2026-07",
      idempotencyKey: "feature-race-profile",
      profile: { zone: "los_lagos", herdSizeBand: "100_199", productionSystem: "pasture" },
      now: new Date("2026-07-22T10:01:00.000Z"),
    }),
    (error) => error.code === "BENCHMARK_SCOPE_CONFLICT",
  );
  sqlite.prepare(`
    UPDATE organization_feature_flags SET enabled = 1
    WHERE organization_id = 'org-a' AND field_id = 'field-a' AND feature = 'benchmarking'
  `).run();
  assert.deepEqual(sqlite.prepare(`
    SELECT zone, herd_size_band AS herdSizeBand, production_system AS productionSystem, updated_at AS updatedAt
    FROM benchmark_field_profiles WHERE organization_id = 'org-a' AND field_id = 'field-a'
  `).get(), profileBefore);
});

function createSchema() {
  return `
  PRAGMA foreign_keys = ON;
  CREATE TABLE organizations (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE fields (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, name TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE organization_memberships (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, normalized_email TEXT NOT NULL,
    status TEXT NOT NULL, role TEXT NOT NULL
  );
  CREATE TABLE membership_field_access (
    id TEXT PRIMARY KEY, membership_id TEXT NOT NULL, field_id TEXT NOT NULL,
    created_by TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE (membership_id, field_id)
  );
  CREATE TABLE organization_feature_flags (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, field_id TEXT,
    feature TEXT NOT NULL, enabled INTEGER NOT NULL
  );
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, actor TEXT NOT NULL,
    action TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    before TEXT, after TEXT, occurred_at TEXT NOT NULL
  );
  CREATE TABLE scheduled_jobs (
    id TEXT PRIMARY KEY, organization_id TEXT, field_id TEXT, type TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL, due_at TEXT NOT NULL,
    interval_seconds INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE benchmark_consents (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
    terms_revision TEXT, consented_by TEXT NOT NULL, consented_at TEXT,
    opted_out_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE benchmark_field_profiles (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, field_id TEXT NOT NULL,
    zone TEXT NOT NULL, herd_size_band TEXT NOT NULL, production_system TEXT NOT NULL,
    updated_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE (organization_id, field_id)
  );
  CREATE TABLE analytics_herd_metrics (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, field_id TEXT NOT NULL,
    period TEXT NOT NULL, metric_key TEXT NOT NULL, status TEXT NOT NULL,
    value REAL, unit TEXT NOT NULL, schema_version TEXT NOT NULL, computed_at TEXT NOT NULL
  );
  CREATE TABLE benchmark_aggregates (
    id TEXT PRIMARY KEY, cohort_key TEXT NOT NULL, period TEXT NOT NULL,
    zone TEXT NOT NULL, herd_size_band TEXT NOT NULL, production_system TEXT NOT NULL,
    metric_key TEXT NOT NULL, unit TEXT NOT NULL, status TEXT NOT NULL,
    participant_count INTEGER NOT NULL, k_threshold INTEGER NOT NULL,
    p10 REAL, p25 REAL, p50 REAL, p75 REAL, p90 REAL,
    schema_version TEXT NOT NULL, computed_at TEXT NOT NULL
  );
  CREATE TABLE benchmark_positions (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, field_id TEXT NOT NULL,
    cohort_key TEXT NOT NULL, period TEXT NOT NULL, metric_key TEXT NOT NULL,
    unit TEXT NOT NULL, own_value REAL NOT NULL, percentile_rank REAL NOT NULL,
    schema_version TEXT NOT NULL, computed_at TEXT NOT NULL
  );
`;
}

function seed(database) {
  const insertOrganization = database.prepare("INSERT INTO organizations (id, name) VALUES (?, ?)");
  const insertField = database.prepare("INSERT INTO fields (id, organization_id, name, is_demo) VALUES (?, ?, ?, ?)");
  const insertMembership = database.prepare("INSERT INTO organization_memberships (id, organization_id, normalized_email, status, role) VALUES (?, ?, ?, 'active', 'owner')");
  const insertConsent = database.prepare(`
    INSERT INTO benchmark_consents
      (id, organization_id, status, terms_revision, consented_by, consented_at, created_at, updated_at)
    VALUES (?, ?, 'opted_in', 'fundosmart.benchmarking.consent.v1', ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
  `);
  const insertProfile = database.prepare(`
    INSERT INTO benchmark_field_profiles
      (id, organization_id, field_id, zone, herd_size_band, production_system, updated_by, created_at, updated_at)
    VALUES (?, ?, ?, 'los_lagos', '100_199', 'pasture', ?, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
  `);
  const insertMetric = database.prepare(`
    INSERT INTO analytics_herd_metrics
      (id, organization_id, field_id, period, metric_key, status, value, unit, schema_version, computed_at)
    VALUES (?, ?, ?, '2026-06', 'milk.production_per_cow_day_liters', 'available', ?, 'liters_per_cow_day', 'fundosmart.analytics.projection.v1', '2026-07-01T00:00:00.000Z')
  `);
  const insertFeature = database.prepare(`
    INSERT INTO organization_feature_flags (id, organization_id, field_id, feature, enabled)
    VALUES (?, ?, ?, 'benchmarking', 1)
  `);
  for (const [suffix, value] of [["a", 10], ["b", 20], ["c", 30]]) {
    const organizationId = `org-${suffix}`;
    const fieldId = `field-${suffix}`;
    const email = `owner-${suffix}@example.com`;
    insertOrganization.run(organizationId, `Organization ${suffix}`);
    insertField.run(fieldId, organizationId, `Field ${suffix}`, 0);
    insertMembership.run(`membership-${suffix}`, organizationId, email);
    insertConsent.run(`consent-${suffix}`, organizationId, email);
    insertProfile.run(`profile-${suffix}`, organizationId, fieldId, email);
    insertFeature.run(`feature-${suffix}`, organizationId, fieldId);
    insertMetric.run(`metric-${suffix}`, organizationId, fieldId, value);
  }
  insertOrganization.run("org-demo", "Demo");
  insertField.run("demo-field", "org-demo", "Demo field", 1);
  insertMembership.run("membership-demo", "org-demo", "demo@example.com");
  insertConsent.run("consent-demo", "org-demo", "demo@example.com");
  insertProfile.run("profile-demo", "org-demo", "demo-field", "demo@example.com");
  insertFeature.run("feature-demo", "org-demo", "demo-field");
  insertMetric.run("metric-demo", "org-demo", "demo-field", 1000);

  insertOrganization.run("org-legacy", "Legacy consent");
  insertField.run("field-legacy", "org-legacy", "Legacy field", 0);
  insertMembership.run("membership-legacy", "org-legacy", "owner-legacy@example.com");
  database.prepare(`
    INSERT INTO benchmark_consents
      (id, organization_id, status, terms_revision, consented_by, consented_at, created_at, updated_at)
    VALUES ('consent-legacy', 'org-legacy', 'opted_in', 'fundosmart.benchmarking.consent.v0',
      'owner-legacy@example.com', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')
  `).run();
  insertProfile.run("profile-legacy", "org-legacy", "field-legacy", "owner-legacy@example.com");
  insertFeature.run("feature-legacy", "org-legacy", "field-legacy");
  insertMetric.run("metric-legacy", "org-legacy", "field-legacy", 999);
}

class TestD1PreparedStatement {
  constructor(database, sql, bindings = [], owner = null) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
    this.owner = owner;
  }

  bind(...bindings) {
    return new TestD1PreparedStatement(this.database, this.sql, bindings, this.owner);
  }

  async all() {
    const beforeNextAll = this.owner?.beforeNextAll;
    if (this.owner) this.owner.beforeNextAll = null;
    beforeNextAll?.();
    return { results: this.database.prepare(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql, [], this);
  }

  async batch(statements) {
    const beforeNextBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    beforeNextBatch?.();
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
  }
}

before(setup);
after(teardown);
