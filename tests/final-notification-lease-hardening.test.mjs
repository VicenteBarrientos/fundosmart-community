import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const T0 = new Date("2026-07-22T12:00:00.000Z");
const BEFORE_EXPIRY = new Date("2026-07-22T12:01:00.000Z");
const AFTER_EXPIRY = new Date("2026-07-22T12:06:00.000Z");

let sqlite;
let d1;
let vite;
let livestockNotifications;
let pabcoNotifications;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle")))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
    .sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }
  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_NOTIFICATION_TEST_ENV__ = { DB: d1 };
  const virtualWorkers = "\0fundosmart-notification-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-notification-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_NOTIFICATION_TEST_ENV__";
        }
      },
    }],
  });
  [livestockNotifications, pabcoNotifications] = await Promise.all([
    vite.ssrLoadModule("/src/modules/ganado/server/livestock-notification-repository.ts"),
    vite.ssrLoadModule("/src/modules/leche/server/pabco-notification-repository.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_NOTIFICATION_TEST_ENV__;
});

test("livestock final claims reject suspension, revoked scope, non-operating roles and demo races", async () => {
  const cases = [
    {
      suffix: "suspended",
      revoke(fixture) {
        sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(fixture.membershipId);
      },
    },
    {
      suffix: "scope",
      revoke(fixture) {
        sqlite.prepare("DELETE FROM membership_field_access WHERE membership_id=? AND field_id=?").run(fixture.membershipId, fixture.fieldId);
      },
    },
    {
      suffix: "role",
      revoke(fixture) {
        sqlite.prepare("UPDATE organization_memberships SET role='viewer' WHERE id=?").run(fixture.membershipId);
      },
    },
    {
      suffix: "demo",
      revoke(fixture) {
        sqlite.prepare("UPDATE fields SET is_demo=1 WHERE id=?").run(fixture.fieldId);
      },
    },
  ];

  for (const entry of cases) {
    const fixture = seedLivestockFixture(entry.suffix);
    const messages = [];
    d1.beforeNextDeliveryClaim = () => entry.revoke(fixture);
    const result = await livestockNotifications.runDueLivestockNotifications({
      async send(message) {
        messages.push(message);
        return { messageId: `unexpected-${entry.suffix}` };
      },
    }, { now: T0, today: "2026-07-22" });
    assert.deepEqual(result, { recipients: 0, deliveries: 0, failures: 0 }, entry.suffix);
    assert.equal(messages.length, 0, entry.suffix);
    assert.equal(sqlite.prepare(`
      SELECT COUNT(*) AS count FROM livestock_notification_deliveries
      WHERE preference_id = ?
    `).get(fixture.preferenceId).count, 0, entry.suffix);
  }
});

test("livestock leases prevent concurrent sends, recover after a crash and reject a stale release", async () => {
  const fixture = seedLivestockFixture("lease");
  const firstSend = deferredRejection();
  let attemptedSends = 0;
  const firstRun = withoutExpectedDiagnostics(() => (
    livestockNotifications.runDueLivestockNotifications({
      async send() {
        attemptedSends += 1;
        firstSend.start();
        return firstSend.promise;
      },
    }, { now: T0, today: "2026-07-22" })
  ));
  await firstSend.started;

  const claimed = sqlite.prepare(`
    SELECT status, error, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
    FROM livestock_notification_deliveries WHERE preference_id = ?
  `).get(fixture.preferenceId);
  assert.equal(claimed.status, "failed");
  assert.match(claimed.error, /^livestock\.delivery\.reserved:/u);
  assert.ok(claimed.leaseToken);
  assert.equal(claimed.leaseExpiresAt, "2026-07-22T12:05:00.000Z");

  const concurrent = await livestockNotifications.runDueLivestockNotifications({
    async send() {
      attemptedSends += 1;
      return { messageId: "should-not-send" };
    },
  }, { now: BEFORE_EXPIRY, today: "2026-07-22" });
  assert.deepEqual(concurrent, { recipients: 0, deliveries: 0, failures: 0 });

  const recovered = await livestockNotifications.runDueLivestockNotifications({
    async send() {
      attemptedSends += 1;
      return { messageId: "livestock-recovered" };
    },
  }, { now: AFTER_EXPIRY, today: "2026-07-22" });
  assert.deepEqual(recovered, { recipients: 1, deliveries: 1, failures: 0 });
  firstSend.reject(new Error("worker_crashed"));
  assert.deepEqual(await firstRun, { recipients: 0, deliveries: 0, failures: 1 });
  assert.equal(attemptedSends, 2);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT status, error, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt, sent_at AS sentAt
    FROM livestock_notification_deliveries WHERE preference_id = ?
  `).get(fixture.preferenceId) }, {
    status: "sent",
    error: null,
    leaseToken: null,
    leaseExpiresAt: null,
    sentAt: "2026-07-22T12:06:00.000Z",
  });
});

test("PABCO recovers legacy prefix reservations and uses the same lease CAS boundary", async () => {
  const legacy = seedPabcoFixture("legacy");
  sqlite.prepare(`
    INSERT INTO livestock_notification_deliveries (
      id, preference_id, work_item_id, due_date, channel, status, error, created_at
    ) VALUES (?, ?, ?, '2026-07-22', 'email', 'failed', 'pabco.delivery.reserved:crashed-worker', ?)
  `).run(
    `delivery:${legacy.preferenceId}:pabco:${legacy.itemId}:2026-07-22:email`,
    legacy.preferenceId,
    `pabco:${legacy.itemId}`,
    "2026-07-22T11:00:00.000Z",
  );
  let legacySends = 0;
  assert.deepEqual(await pabcoNotifications.runDuePabcoNotifications({
    async send() {
      legacySends += 1;
      return { messageId: "pabco-legacy-recovered" };
    },
  }, { now: T0, today: "2026-07-20" }), { recipients: 1, deliveries: 1, failures: 0 });
  assert.equal(legacySends, 1);

  const fixture = seedPabcoFixture("lease");
  const firstSend = deferredRejection();
  let attemptedSends = 0;
  const firstRun = withoutExpectedDiagnostics(() => (
    pabcoNotifications.runDuePabcoNotifications({
      async send() {
        attemptedSends += 1;
        firstSend.start();
        return firstSend.promise;
      },
    }, { now: T0, today: "2026-07-20" })
  ));
  await firstSend.started;

  const claimed = sqlite.prepare(`
    SELECT error, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt
    FROM livestock_notification_deliveries WHERE preference_id = ?
  `).get(fixture.preferenceId);
  assert.match(claimed.error, /^pabco\.delivery\.reserved:/u);
  assert.ok(claimed.leaseToken);
  assert.equal(claimed.leaseExpiresAt, "2026-07-22T12:05:00.000Z");

  assert.deepEqual(await pabcoNotifications.runDuePabcoNotifications({
    async send() {
      attemptedSends += 1;
      return { messageId: "should-not-send" };
    },
  }, { now: BEFORE_EXPIRY, today: "2026-07-20" }), { recipients: 0, deliveries: 0, failures: 0 });

  assert.deepEqual(await pabcoNotifications.runDuePabcoNotifications({
    async send() {
      attemptedSends += 1;
      return { messageId: "pabco-recovered" };
    },
  }, { now: AFTER_EXPIRY, today: "2026-07-20" }), { recipients: 1, deliveries: 1, failures: 0 });
  firstSend.reject(new Error("worker_crashed"));
  assert.deepEqual(await firstRun, { recipients: 0, deliveries: 0, failures: 1 });
  assert.equal(attemptedSends, 2);
  assert.deepEqual({ ...sqlite.prepare(`
    SELECT status, error, lease_token AS leaseToken, lease_expires_at AS leaseExpiresAt, sent_at AS sentAt
    FROM livestock_notification_deliveries WHERE preference_id = ?
  `).get(fixture.preferenceId) }, {
    status: "sent",
    error: null,
    leaseToken: null,
    leaseExpiresAt: null,
    sentAt: "2026-07-22T12:06:00.000Z",
  });
});

function seedLivestockFixture(suffix) {
  const organizationId = `notification-org-livestock-${suffix}`;
  const fieldId = `notification-field-livestock-${suffix}`;
  const membershipId = `notification-member-livestock-${suffix}`;
  const preferenceId = `notification-pref-livestock-${suffix}`;
  const email = `livestock-${suffix}@example.com`;
  sqlite.exec(`
    INSERT INTO organizations (id, name) VALUES ('${organizationId}', 'Notification livestock ${suffix}');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates)
    VALUES ('${fieldId}', '${organizationId}', 'Livestock ${suffix}', 'Osorno', 0, 5, '[]');
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name, role, status, created_by
    ) VALUES (
      '${membershipId}', '${organizationId}', '${email}', '${email}', 'Livestock ${suffix}', 'operator', 'active', 'fixture'
    );
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('notification-access-livestock-${suffix}', '${membershipId}', '${fieldId}', 'fixture');
    INSERT INTO livestock_lots (
      id, field_id, name, category, animal_count, average_weight_kg, entry_date, status, tracking_mode
    ) VALUES (
      'notification-lot-${suffix}', '${fieldId}', 'Lote ${suffix}', 'dairy_cow', 1, 500, '2026-01-01', 'active', 'individual'
    );
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status)
    VALUES ('notification-animal-${suffix}', 'notification-lot-${suffix}', 'TAG-${suffix}', 'female', 'active');
    INSERT INTO livestock_notification_preferences (
      id, organization_id, field_id, user_email, email_enabled, browser_enabled, reminder_days, timezone
    ) VALUES (
      '${preferenceId}', '${organizationId}', '${fieldId}', '${email}', 1, 0, 14, 'America/Santiago'
    );
  `);
  return { organizationId, fieldId, membershipId, preferenceId, email };
}

function seedPabcoFixture(suffix) {
  const organizationId = `notification-org-pabco-${suffix}`;
  const fieldId = `notification-field-pabco-${suffix}`;
  const membershipId = `notification-member-pabco-${suffix}`;
  const preferenceId = `notification-pref-pabco-${suffix}`;
  const itemId = `notification-item-pabco-${suffix}`;
  const email = `pabco-${suffix}@example.com`;
  sqlite.exec(`
    INSERT INTO organizations (id, name) VALUES ('${organizationId}', 'Notification PABCO ${suffix}');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates)
    VALUES ('${fieldId}', '${organizationId}', 'PABCO ${suffix}', 'Osorno', 0, 5, '[]');
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name, role, status, created_by
    ) VALUES (
      '${membershipId}', '${organizationId}', '${email}', '${email}', 'PABCO ${suffix}', 'operator', 'active', 'fixture'
    );
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('notification-access-pabco-${suffix}', '${membershipId}', '${fieldId}', 'fixture');
    INSERT INTO livestock_notification_preferences (
      id, organization_id, field_id, user_email, email_enabled, browser_enabled, reminder_days, timezone
    ) VALUES (
      '${preferenceId}', '${organizationId}', '${fieldId}', '${email}', 1, 0, 14, 'America/Santiago'
    );
    INSERT INTO pabco_compliance_items (
      id, organization_id, field_id, requirement, status, valid_from, valid_until,
      reminder_at, source, notes, created_by
    ) VALUES (
      '${itemId}', '${organizationId}', '${fieldId}', 'annual_water_analysis', 'compliant',
      '2026-07-01', '2026-08-01', '2026-07-22', 'manual', 'Lease ${suffix}', 'fixture'
    );
  `);
  return { organizationId, fieldId, membershipId, preferenceId, itemId, email };
}

function deferredRejection() {
  let markStarted;
  let rejectPromise;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const promise = new Promise((resolve, reject) => { rejectPromise = reject; });
  return {
    started,
    promise,
    start: () => markStarted(),
    reject: (cause) => rejectPromise(cause),
  };
}

async function withoutExpectedDiagnostics(operation) {
  const original = console.error;
  console.error = () => undefined;
  try {
    return await operation();
  } finally {
    console.error = original;
  }
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
    return options.columnNames
      ? [statement.columns().map((column) => column.name), ...rows]
      : rows;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.batchTail = Promise.resolve();
    this.beforeNextDeliveryClaim = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    const execute = async () => {
      if (
        this.beforeNextDeliveryClaim
        && statements.some((statement) => /INSERT INTO livestock_notification_deliveries/u.test(statement.sql))
      ) {
        const hook = this.beforeNextDeliveryClaim;
        this.beforeNextDeliveryClaim = null;
        hook();
      }
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
      } catch (cause) {
        this.database.exec("ROLLBACK");
        throw cause;
      }
    };
    const pending = this.batchTail.then(execute, execute);
    this.batchTail = pending.catch(() => undefined);
    return pending;
  }
}
