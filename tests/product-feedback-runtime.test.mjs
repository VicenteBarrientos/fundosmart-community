import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const STAFF_CUTOVER_MARKER_KEY = "platform-staff-v2-required";
const actorA = {
  membershipId: "feedback-member-a",
  organizationId: "feedback-org-a",
  email: "owner-a@example.com",
  displayName: "Owner A",
  role: "owner",
  fieldIds: ["feedback-field-a"],
};
const actorB = {
  membershipId: "feedback-member-b",
  organizationId: "feedback-org-b",
  email: "viewer-b@example.com",
  displayName: "Viewer B",
  role: "viewer",
  fieldIds: ["feedback-field-b"],
};
const baseTime = new Date("2026-07-27T16:00:00.000Z");

let sqlite;
let d1;
let vite;
let repository;
let domain;
let http;

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
    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES (
      'google:staff-owner', 'google', 'staff-owner',
      'staff@example.com', 'staff@example.com', 'Staff', 1, 1
    );
    INSERT INTO organizations (
      id, name, kind, plan_code, field_limit, paddock_limit, self_service_owner_email
    ) VALUES (
      'feedback-org-a', 'Fundo Gratis A', 'personal', 'free', 2, 200, 'owner-a@example.com'
    );
    INSERT INTO organizations (id, name, kind, plan_code)
    VALUES ('feedback-org-b', 'Fundo Legacy B', 'shared', 'legacy');
    INSERT INTO fields (
      id, organization_id, name, location, is_demo, area_hectares, coordinates
    ) VALUES
      ('feedback-field-a', 'feedback-org-a', 'Campo A', 'Osorno', 0, 10, '[]'),
      ('feedback-field-b', 'feedback-org-b', 'Campo B', 'Puerto Montt', 0, 12, '[]');
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name, role, status, created_by
    ) VALUES
      ('feedback-member-a', 'feedback-org-a', 'owner-a@example.com', 'owner-a@example.com', 'Owner A', 'owner', 'active', 'test'),
      ('feedback-member-b', 'feedback-org-b', 'viewer-b@example.com', 'viewer-b@example.com', 'Viewer B', 'viewer', 'active', 'test');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('feedback-access-b', 'feedback-member-b', 'feedback-field-b', 'test');
  `);

  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_FEEDBACK_TEST_ENV__ = { DB: d1 };
  const virtualWorkers = "\0fundosmart-feedback-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-feedback-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_FEEDBACK_TEST_ENV__";
        }
      },
    }],
  });
  [repository, domain, http] = await Promise.all([
    vite.ssrLoadModule("/src/modules/feedback/server/feedback-repository.ts"),
    vite.ssrLoadModule("/src/modules/feedback/domain/types.ts"),
    vite.ssrLoadModule("/src/modules/feedback/server/feedback-http.ts"),
  ]);
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_FEEDBACK_TEST_ENV__;
});

test("stores an authenticated free-plan submission with server-derived tenant data and idempotent replay", async () => {
  const first = await repository.submitProductFeedback({
    actor: actorA,
    submission: submission(1),
    releaseSha: "abc123release",
    userAgent: "FundoSmart Test Browser",
    now: baseTime,
    idFactory: uuidFactory(100),
  });

  assert.equal(first.replay, false);
  assert.equal(first.feedback.organizationId, actorA.organizationId);
  assert.equal(first.feedback.organizationName, "Fundo Gratis A");
  assert.equal(first.feedback.fieldId, "feedback-field-a");
  assert.equal(first.feedback.reporterEmail, actorA.email);
  assert.equal(first.feedback.planCode, "free");
  assert.equal(first.feedback.status, "new");
  assert.equal(first.feedback.version, 1);
  assert.equal(first.feedback.releaseSha, "abc123release");

  const replay = await repository.submitProductFeedback({
    actor: actorA,
    submission: submission(1),
    releaseSha: "different-client-retry",
    userAgent: "Retry Browser",
    now: new Date(baseTime.getTime() + 1_000),
    idFactory: uuidFactory(200),
  });
  assert.equal(replay.replay, true);
  assert.equal(replay.feedback.id, first.feedback.id);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM product_feedback").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM product_feedback_events").get().count, 1);
});

test("fails closed when a user tries to attach feedback to another tenant's field", async () => {
  await assert.rejects(
    repository.submitProductFeedback({
      actor: actorA,
      submission: { ...submission(2), fieldId: "feedback-field-b" },
      releaseSha: "abc123release",
      userAgent: "Test",
      now: new Date(baseTime.getTime() + 2_000),
      idFactory: uuidFactory(300),
    }),
    (error) => error.code === "FEEDBACK_ACCESS_CHANGED" && error.status === 409,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM product_feedback WHERE field_id = 'feedback-field-b'").get().count,
    0,
  );
});

test("enforces the atomic per-membership rate limit without affecting another organization", async () => {
  for (let index = 2; index <= 5; index += 1) {
    const result = await repository.submitProductFeedback({
      actor: actorA,
      submission: submission(index),
      releaseSha: "abc123release",
      userAgent: "Test",
      now: new Date(baseTime.getTime() + index * 1_000),
      idFactory: uuidFactory(400 + index * 10),
    });
    assert.equal(result.replay, false);
  }

  await assert.rejects(
    repository.submitProductFeedback({
      actor: actorA,
      submission: submission(6),
      releaseSha: "abc123release",
      userAgent: "Test",
      now: new Date(baseTime.getTime() + 6_000),
      idFactory: uuidFactory(500),
    }),
    (error) => error.code === "FEEDBACK_RATE_LIMITED" && error.status === 429,
  );

  const otherTenant = await repository.submitProductFeedback({
    actor: actorB,
    submission: { ...submission(7), fieldId: "feedback-field-b" },
    releaseSha: "abc123release",
    userAgent: "Test",
    now: new Date(baseTime.getTime() + 7_000),
    idFactory: uuidFactory(600),
  });
  assert.equal(otherTenant.feedback.organizationId, actorB.organizationId);
  assert.equal(otherTenant.feedback.planCode, "legacy");
});

test("staff can filter and version triage while capture fields and event history remain immutable", async () => {
  const initial = await repository.listProductFeedbackForStaff({
    organizationId: actorA.organizationId,
    category: "bug",
  });
  assert.equal(initial.items.length, 5);
  assert.equal(initial.summary.total, 6);
  assert.equal(initial.summary.new, 6);

  const target = initial.items[0];
  const updated = await repository.updateProductFeedbackForStaff({
    actorSubject: "google:staff-owner",
    actorEmail: "staff@example.com",
    staffCutoverMarkerKey: STAFF_CUTOVER_MARKER_KEY,
    update: {
      feedbackId: target.id,
      expectedVersion: target.version,
      status: "planned",
      priority: "p1",
      staffNote: "Agrupar con otros errores del onboarding.",
    },
    now: new Date(baseTime.getTime() + 60_000),
    idFactory: uuidFactory(700),
  });
  assert.equal(updated.status, "planned");
  assert.equal(updated.priority, "p1");
  assert.equal(updated.version, 2);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM product_feedback_events WHERE feedback_id = ?").get(target.id).count,
    2,
  );

  d1.runBeforeNextBatch(() => {
    sqlite.prepare(`
      INSERT INTO app_state (key, value, updated_at)
      VALUES (?, 'required', ?)
    `).run(STAFF_CUTOVER_MARKER_KEY, new Date(baseTime.getTime() + 61_000).toISOString());
  });
  await assert.rejects(
    repository.updateProductFeedbackForStaff({
      actorSubject: "google:staff-owner",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: STAFF_CUTOVER_MARKER_KEY,
      update: {
        feedbackId: target.id,
        expectedVersion: updated.version,
        status: "resolved",
        priority: "p0",
        staffNote: "Este cambio no debe confirmarse después del corte.",
      },
      now: new Date(baseTime.getTime() + 62_000),
      idFactory: uuidFactory(750),
    }),
    (error) => error.code === "FEEDBACK_STAFF_ACCESS_CHANGED" && error.status === 409,
  );
  const unchangedAfterCutover = sqlite.prepare(`
    SELECT status, priority, staff_note AS staffNote, version
    FROM product_feedback
    WHERE id = ?
  `).get(target.id);
  assert.deepEqual({ ...unchangedAfterCutover }, {
    status: "planned",
    priority: "p1",
    staffNote: "Agrupar con otros errores del onboarding.",
    version: 2,
  });
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM product_feedback_events WHERE feedback_id = ?").get(target.id).count,
    2,
  );
  sqlite.prepare("DELETE FROM app_state WHERE key = ?").run(STAFF_CUTOVER_MARKER_KEY);

  await assert.rejects(
    repository.updateProductFeedbackForStaff({
      actorSubject: "google:staff-owner",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: STAFF_CUTOVER_MARKER_KEY,
      update: {
        feedbackId: target.id,
        expectedVersion: 1,
        status: "closed",
        priority: "p3",
        staffNote: null,
      },
      idFactory: uuidFactory(800),
    }),
    (error) => error.code === "FEEDBACK_VERSION_CONFLICT" && error.status === 409,
  );

  assert.throws(
    () => sqlite.prepare(`
      UPDATE product_feedback
      SET message = 'Texto capturado reemplazado',
          version = version + 1,
          updated_at = '2026-07-27T17:00:00.000Z',
          last_event_id = 'tamper-event'
      WHERE id = ?
    `).run(target.id),
    /PRODUCT_FEEDBACK_CAPTURE_IMMUTABLE/u,
  );
  assert.throws(
    () => sqlite.prepare("DELETE FROM product_feedback_events WHERE feedback_id = ?").run(target.id),
    /PRODUCT_FEEDBACK_EVENT_APPEND_ONLY/u,
  );

  const planned = await repository.listProductFeedbackForStaff({
    status: "planned",
    priority: "p1",
    search: "onboarding",
  });
  assert.equal(planned.items.length, 1);
  assert.equal(planned.items[0].id, target.id);
});

test("the feedback batch rolls back when the staff account closes immediately before commit", async () => {
  const target = sqlite.prepare(`
    SELECT id, version, status, priority, staff_note AS staffNote
    FROM product_feedback
    WHERE status = 'planned'
    LIMIT 1
  `).get();
  d1.runBeforeNextBatch(() => {
    sqlite.prepare(`
      INSERT INTO account_closure_requests (
        id, scope, target_id, actor_identity_id, request_id, status,
        requested_at, grace_ends_at, revoked_at, version,
        snapshot_version, snapshot_json
      ) VALUES (
        'closure-feedback-staff', 'account', 'google:staff-owner',
        'google:staff-owner', 'request-feedback-staff', 'grace',
        '2026-07-29T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
        NULL, 1, 1, ?
      )
    `).run(JSON.stringify({ memberships: [] }));
  });

  await assert.rejects(
    repository.updateProductFeedbackForStaff({
      actorSubject: "google:staff-owner",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: STAFF_CUTOVER_MARKER_KEY,
      update: {
        feedbackId: target.id,
        expectedVersion: Number(target.version),
        status: "resolved",
        priority: "p0",
        staffNote: "No debe persistir.",
      },
      now: new Date(baseTime.getTime() + 90_000),
      idFactory: uuidFactory(900),
    }),
    (error) => error.code === "FEEDBACK_STAFF_ACCESS_CHANGED",
  );
  assert.deepEqual({
    ...sqlite.prepare(`
      SELECT version, status, priority, staff_note AS staffNote
      FROM product_feedback
      WHERE id = ?
    `).get(target.id),
  }, {
    version: target.version,
    status: target.status,
    priority: target.priority,
    staffNote: target.staffNote,
  });
});

test("submission validation keeps only bounded product context", () => {
  const parsed = domain.validateFeedbackSubmission({
    ...submission(20),
    pagePath: "/app/potreros?fieldId=feedback-field-a#detalle",
  });
  assert.equal(parsed.pagePath, "/app/potreros");
  assert.equal(parsed.message, "El flujo de prueba número 20 no termina como esperaba.");

  assert.throws(
    () => domain.validateFeedbackSubmission({
      ...submission(21),
      pagePath: "https://attacker.example/app",
    }),
    (error) => error.code === "FEEDBACK_PAGE_INVALID" && error.status === 400,
  );
  assert.throws(
    () => domain.validateFeedbackSubmission({
      ...submission(22),
      message: "corto",
    }),
    (error) => error.code === "FEEDBACK_MESSAGE_TOO_SHORT" && error.status === 400,
  );
});

test("feedback HTTP helpers reject cross-site and oversized bodies without trusting Content-Length", async () => {
  const sameOrigin = new Request("https://fundosmart.test/app/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://fundosmart.test",
    },
    body: JSON.stringify({ ok: true }),
  });
  assert.equal(http.isSameOriginFeedbackMutation(sameOrigin), true);
  assert.deepEqual(await http.readBoundedJsonObject(sameOrigin, 128), { ok: true });

  const crossSite = new Request("https://fundosmart.test/app/api/feedback", {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
    },
  });
  assert.equal(http.isSameOriginFeedbackMutation(crossSite), false);

  const oversized = new Request("https://fundosmart.test/app/api/feedback", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://fundosmart.test",
    },
    body: JSON.stringify({ message: "x".repeat(256) }),
  });
  const oversizedResponse = await http.readBoundedJsonObject(oversized, 64);
  assert.ok(oversizedResponse instanceof Response);
  assert.equal(oversizedResponse.status, 413);
  assert.equal(oversizedResponse.headers.get("Cache-Control"), "private, no-store");
  assert.equal(oversizedResponse.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal((await oversizedResponse.json()).code, "REQUEST_TOO_LARGE");
});

function submission(index) {
  return {
    category: "bug",
    impact: index % 2 ? "difficult" : "blocked",
    message: `El flujo de prueba número ${index} no termina como esperaba.`,
    contactAllowed: index % 2 === 1,
    submissionKey: uuid(index),
    pagePath: "/app/potreros",
    fieldId: "feedback-field-a",
    viewportWidth: 1280,
    viewportHeight: 800,
    online: true,
  };
}

function uuid(value) {
  return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
}

function uuidFactory(start) {
  let value = start;
  return () => uuid(value++);
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

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.batchTail = Promise.resolve();
    this.beforeNextBatch = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  runBeforeNextBatch(callback) {
    assert.equal(this.beforeNextBatch, null, "A batch hook is already pending.");
    this.beforeNextBatch = callback;
  }

  async batch(statements) {
    const execute = async () => {
      const beforeBatch = this.beforeNextBatch;
      this.beforeNextBatch = null;
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
