import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";
import {
  grantStaffElevation,
  revokeStaffElevation,
} from "../src/modules/staff/server/platform-staff-elevation-repository.ts";
import { authorizeStaff } from "../src/modules/staff/server/platform-staff-repository.ts";

const migration = publicSqlForTables([
  "platform_staff_bootstrap_claims",
  "platform_staff_capability_grants",
  "platform_staff_elevations",
  "platform_staff_events",
  "platform_staff_principals",
]);

const OWNER_ID = "018f0000-0000-4000-8000-000000000001";
const STAFF_ID = "018f0000-0000-4000-8000-000000000002";
const SESSION_HASH = "a".repeat(64);
const OTHER_IDENTITY_SESSION = "b".repeat(64);
const EXPIRED_SESSION = "c".repeat(64);
const TOKEN = "1".repeat(64);
const SECOND_TOKEN = "2".repeat(64);
const NOW = 1_772_000_000;

let db;

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE auth_identities (
      id TEXT PRIMARY KEY NOT NULL,
      normalized_email TEXT NOT NULL
    );
    CREATE TABLE auth_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL,
      identity_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      FOREIGN KEY (identity_id) REFERENCES auth_identities(id) ON DELETE CASCADE
    );
    CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
    INSERT INTO auth_identities (id, normalized_email) VALUES
      ('auth-owner', 'duenio@example.com'),
      ('auth-staff', 'staff@example.com'),
      ('auth-otro', 'otro@example.com');
    INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at) VALUES
      ('${SESSION_HASH}', 'auth-staff', ${NOW - 1000}, ${NOW + 100_000}),
      ('${OTHER_IDENTITY_SESSION}', 'auth-otro', ${NOW - 1000}, ${NOW + 100_000}),
      ('${EXPIRED_SESSION}', 'auth-staff', ${NOW - 100_000}, ${NOW - 10});
  `);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  seedPrincipals();
});

function seedPrincipals() {
  db.exec(`
    INSERT INTO platform_staff_bootstrap_claims (
      id, normalized_email, status, principal_id, created_at, claimed_at, disabled_at, version
    ) VALUES ('bootstrap-owner-v1', 'duenio@example.com', 'pending', NULL, 900, NULL, NULL, 1);
  `);
  db.prepare(`
    INSERT INTO platform_staff_principals (
      id, auth_identity_id, normalized_email_snapshot, display_name, kind, status,
      version, created_by_principal_id, created_at, updated_at, suspended_at
    ) VALUES (?, 'auth-owner', 'duenio@example.com', 'Owner', 'owner', 'active', 1, NULL, 1000, 1000, NULL)
  `).run(OWNER_ID);
  db.prepare(`
    UPDATE platform_staff_bootstrap_claims
    SET status = 'claimed', principal_id = ?, claimed_at = 1000, version = 2
    WHERE id = 'bootstrap-owner-v1'
  `).run(OWNER_ID);
  db.prepare(`
    INSERT INTO platform_staff_principals (
      id, auth_identity_id, normalized_email_snapshot, display_name, kind, status,
      version, created_by_principal_id, created_at, updated_at, suspended_at
    ) VALUES (?, 'auth-staff', 'staff@example.com', 'Operadora', 'staff', 'active', 1, ?, 1000, 1000, NULL)
  `).run(STAFF_ID, OWNER_ID);
  db.prepare(`
    INSERT INTO platform_staff_capability_grants (
      id, principal_id, capability, status, reason, granted_by_principal_id,
      granted_at, revoked_by_principal_id, revoked_at, version
    ) VALUES ('grant-staff-manage', ?, 'staff:manage', 'active', 'Gestión', ?, 1000, NULL, NULL, 1)
  `).run(STAFF_ID, OWNER_ID);
}

function createDatabase({ failBatch = false } = {}) {
  return {
    withSession() {
      return {
        prepare(query) {
          return {
            query,
            values: [],
            bind(...values) {
              return { ...this, values };
            },
            async first() {
              return db.prepare(this.query).get(...this.values) ?? null;
            },
          };
        },
        async batch(statements) {
          if (failBatch) throw new Error("D1_ERROR: batch rechazado");
          db.exec("BEGIN");
          try {
            const results = statements.map((statement) => {
              const prepared = db.prepare(statement.query);
              if (/^\s*SELECT/iu.test(statement.query)) {
                return { success: true, results: prepared.all(...statement.values) };
              }
              prepared.run(...statement.values);
              return { success: true, results: [] };
            });
            db.exec("COMMIT");
            return results;
          } catch (cause) {
            db.exec("ROLLBACK");
            throw cause;
          }
        },
        getBookmark: () => null,
      };
    },
  };
}

function grantRequest(overrides = {}) {
  return {
    principalId: STAFF_ID,
    authSessionTokenHash: SESSION_HASH,
    tokenHash: TOKEN,
    eventId: "event-elevation-1",
    requestId: "req-1",
    idempotencyKeyHash: "d".repeat(64),
    now: NOW,
    lifetimeSeconds: 300,
    ...overrides,
  };
}

function activeElevations(sessionHash = SESSION_HASH) {
  return db.prepare(
    "SELECT token_hash AS tokenHash, expires_at AS expiresAt FROM platform_staff_elevations WHERE auth_session_token_hash = ? AND revoked_at IS NULL ORDER BY expires_at",
  ).all(sessionHash);
}

test("una elevación queda ligada al principal, a su sesión y a su vencimiento", async () => {
  const outcome = await grantStaffElevation(createDatabase(), grantRequest());

  assert.equal(outcome.ok, true);
  assert.equal(outcome.tokenHash, TOKEN);
  assert.equal(outcome.expiresAt, NOW + 300);

  const row = db.prepare(
    "SELECT principal_id AS principalId, auth_session_token_hash AS sessionHash, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt FROM platform_staff_elevations WHERE token_hash = ?",
  ).get(TOKEN);
  assert.equal(row.principalId, STAFF_ID);
  assert.equal(row.sessionHash, SESSION_HASH);
  assert.equal(row.createdAt, NOW);
  assert.equal(row.expiresAt, NOW + 300);
  assert.equal(row.revokedAt, null);

  const event = db.prepare(
    "SELECT actor_type AS actorType, actor_principal_id AS actorId, action, target_id AS targetId, reason FROM platform_staff_events WHERE id = 'event-elevation-1'",
  ).get();
  assert.equal(event.actorType, "staff");
  assert.equal(event.actorId, STAFF_ID);
  assert.equal(event.action, "platform.staff.elevation-granted.v1");
  assert.equal(event.targetId, TOKEN);
  assert.ok(event.reason.length >= 3);
});

test("conceder una elevación cierra la anterior de la misma sesión", async () => {
  await grantStaffElevation(createDatabase(), grantRequest());
  const second = await grantStaffElevation(
    createDatabase(),
    grantRequest({ tokenHash: SECOND_TOKEN, eventId: "event-elevation-2", idempotencyKeyHash: "9".repeat(64), now: NOW + 30 }),
  );

  assert.equal(second.ok, true);
  const active = activeElevations();
  assert.equal(active.length, 1);
  assert.equal(active[0].tokenHash, SECOND_TOKEN);

  const previous = db.prepare(
    "SELECT revoked_at AS revokedAt FROM platform_staff_elevations WHERE token_hash = ?",
  ).get(TOKEN);
  assert.equal(previous.revokedAt, NOW + 30);
});

test("una sesión de otra identidad nunca recibe la elevación", async () => {
  const outcome = await grantStaffElevation(
    createDatabase(),
    grantRequest({ authSessionTokenHash: OTHER_IDENTITY_SESSION }),
  );

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "NOT_ELIGIBLE");
  assert.equal(activeElevations(OTHER_IDENTITY_SESSION).length, 0);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM platform_staff_events").get().total,
    0,
  );
});

test("una sesión caducada o inexistente no habilita la elevación", async () => {
  const expired = await grantStaffElevation(
    createDatabase(),
    grantRequest({ authSessionTokenHash: EXPIRED_SESSION }),
  );
  assert.equal(expired.reasonCode, "NOT_ELIGIBLE");

  const missing = await grantStaffElevation(
    createDatabase(),
    grantRequest({ authSessionTokenHash: "9".repeat(64) }),
  );
  assert.equal(missing.reasonCode, "NOT_ELIGIBLE");
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM platform_staff_elevations").get().total,
    0,
  );
});

test("un principal suspendido no puede elevarse", async () => {
  db.prepare(`
    UPDATE platform_staff_principals
    SET status = 'suspended', suspended_at = 1100, updated_at = 1100, version = version + 1
    WHERE id = ?
  `).run(STAFF_ID);

  const outcome = await grantStaffElevation(createDatabase(), grantRequest());

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "NOT_ELIGIBLE");
});

test("la vida de la elevación respeta el techo del esquema", async () => {
  const tooLong = await grantStaffElevation(
    createDatabase(),
    grantRequest({ lifetimeSeconds: 901 }),
  );
  assert.equal(tooLong.reasonCode, "INPUT_INVALID");

  const atCeiling = await grantStaffElevation(
    createDatabase(),
    grantRequest({ lifetimeSeconds: 900 }),
  );
  assert.equal(atCeiling.ok, true);
  assert.equal(atCeiling.expiresAt, NOW + 900);
});

test("revocar cierra la elevación vigente y deja evidencia", async () => {
  await grantStaffElevation(createDatabase(), grantRequest());

  const revoked = await revokeStaffElevation(createDatabase(), {
    principalId: STAFF_ID,
    tokenHash: TOKEN,
    eventId: "event-revoke-1",
    requestId: "req-2",
    idempotencyKeyHash: "e".repeat(64),
    now: NOW + 60,
  });

  assert.equal(revoked.ok, true);
  assert.equal(activeElevations().length, 0);
  const event = db.prepare(
    "SELECT action FROM platform_staff_events WHERE id = 'event-revoke-1'",
  ).get();
  assert.equal(event.action, "platform.staff.elevation-revoked.v1");
});

test("revocar dos veces no vuelve a auditar ni altera la fila", async () => {
  await grantStaffElevation(createDatabase(), grantRequest());
  await revokeStaffElevation(createDatabase(), {
    principalId: STAFF_ID,
    tokenHash: TOKEN,
    eventId: "event-revoke-1",
    requestId: "req-2",
    idempotencyKeyHash: "e".repeat(64),
    now: NOW + 60,
  });

  const again = await revokeStaffElevation(createDatabase(), {
    principalId: STAFF_ID,
    tokenHash: TOKEN,
    eventId: "event-revoke-2",
    requestId: "req-3",
    idempotencyKeyHash: "f".repeat(64),
    now: NOW + 90,
  });

  assert.equal(again.ok, false);
  assert.equal(again.reasonCode, "NOT_ELIGIBLE");
  assert.equal(
    db.prepare("SELECT revoked_at AS revokedAt FROM platform_staff_elevations WHERE token_hash = ?")
      .get(TOKEN).revokedAt,
    NOW + 60,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM platform_staff_events WHERE id = 'event-revoke-2'")
      .get().total,
    0,
  );
});

test("una elevación de otro principal no puede revocarse", async () => {
  await grantStaffElevation(createDatabase(), grantRequest());

  const outcome = await revokeStaffElevation(createDatabase(), {
    principalId: OWNER_ID,
    tokenHash: TOKEN,
    eventId: "event-revoke-ajeno",
    requestId: "req-4",
    idempotencyKeyHash: "0".repeat(64),
    now: NOW + 60,
  });

  assert.equal(outcome.ok, false);
  assert.equal(activeElevations().length, 1);
});

test("una entrada inválida no toca la base", async () => {
  for (const overrides of [
    { tokenHash: "corto" },
    { idempotencyKeyHash: "corto" },
    { tokenHash: "A".repeat(64) },
    { authSessionTokenHash: "corto" },
    { principalId: "" },
    { eventId: "" },
    { requestId: "" },
    { now: NOW + 0.5 },
    { lifetimeSeconds: 0 },
    { lifetimeSeconds: -1 },
  ]) {
    const outcome = await grantStaffElevation(createDatabase(), grantRequest(overrides));
    assert.equal(outcome.reasonCode, "INPUT_INVALID", JSON.stringify(overrides));
  }
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM platform_staff_elevations").get().total,
    0,
  );
});

test("una caída de D1 no deja la elevación a medias", async () => {
  const outcome = await grantStaffElevation(createDatabase({ failBatch: true }), grantRequest());

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "NOT_ELIGIBLE");
  assert.doesNotMatch(JSON.stringify(outcome), /D1_ERROR|platform_staff/u);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS total FROM platform_staff_elevations").get().total,
    0,
  );
});

test("la elevación concedida habilita de verdad una capacidad sensible", async () => {
  const database = createDatabase();
  const request = {
    authIdentityId: "auth-staff",
    capability: "staff:manage",
    authSessionTokenHash: SESSION_HASH,
    now: NOW,
  };

  const before = await authorizeStaff(database, request);
  assert.equal(before.decision.allowed, false);
  assert.equal(before.decision.reasonCode, "ELEVATION_MISSING");

  await grantStaffElevation(database, grantRequest());
  const after = await authorizeStaff(database, request);
  assert.equal(after.decision.allowed, true);
  assert.equal(after.decision.elevationConfirmed, true);

  await revokeStaffElevation(database, {
    principalId: STAFF_ID,
    tokenHash: TOKEN,
    eventId: "event-revoke-1",
    requestId: "req-2",
    idempotencyKeyHash: "e".repeat(64),
    now: NOW + 60,
  });
  const revoked = await authorizeStaff(database, { ...request, now: NOW + 61 });
  assert.equal(revoked.decision.allowed, false);
  assert.equal(revoked.decision.reasonCode, "ELEVATION_REVOKED");
});
