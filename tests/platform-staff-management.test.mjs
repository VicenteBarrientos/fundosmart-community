import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";
import {
  createStaffPrincipal,
  grantStaffCapability,
  revokeStaffCapability,
  suspendStaffPrincipal,
} from "../src/modules/staff/server/platform-staff-management-repository.ts";
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
const NEW_ID = "018f0000-0000-4000-8000-000000000003";
const SESSION_HASH = "a".repeat(64);
const KEY = "d".repeat(64);
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
      ('auth-nueva', 'nueva@example.com');
    INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at) VALUES
      ('${SESSION_HASH}', 'auth-staff', ${NOW - 1000}, ${NOW + 100_000});
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
}

function createDatabase() {
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
          };
        },
        async batch(statements) {
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

function audit(overrides = {}) {
  return {
    actorPrincipalId: OWNER_ID,
    eventId: "event-1",
    requestId: "req-1",
    idempotencyKeyHash: KEY,
    reason: "Alta autorizada por el propietario.",
    now: NOW,
    ...overrides,
  };
}

function countOf(sql, ...values) {
  return Number(db.prepare(sql).get(...values).total);
}

test("crear un principal lo deja activo, sin capacidades y con evento", async () => {
  const outcome = await createStaffPrincipal(createDatabase(), {
    ...audit(),
    principalId: NEW_ID,
    authIdentityId: "auth-nueva",
    normalizedEmail: "nueva@example.com",
    displayName: "Nueva",
  });

  assert.equal(outcome.ok, true);
  assert.equal(outcome.targetId, NEW_ID);

  const row = db.prepare(
    "SELECT kind, status, version, created_by_principal_id AS creator FROM platform_staff_principals WHERE id = ?",
  ).get(NEW_ID);
  assert.equal(row.kind, "staff");
  assert.equal(row.status, "active");
  assert.equal(row.version, 1);
  assert.equal(row.creator, OWNER_ID);
  assert.equal(
    countOf("SELECT COUNT(*) AS total FROM platform_staff_capability_grants WHERE principal_id = ?", NEW_ID),
    0,
    "un principal nuevo no hereda ninguna capacidad",
  );

  const event = db.prepare(
    "SELECT actor_principal_id AS actorId, action, target_id AS targetId FROM platform_staff_events WHERE id = 'event-1'",
  ).get();
  assert.equal(event.actorId, OWNER_ID);
  assert.equal(event.action, "platform.staff.principal-created.v1");
  assert.equal(event.targetId, NEW_ID);
});

test("un actor suspendido no puede crear principals", async () => {
  db.prepare(`
    UPDATE platform_staff_principals
    SET status = 'suspended', suspended_at = 1100, updated_at = 1100, version = version + 1
    WHERE id = ?
  `).run(STAFF_ID);

  const outcome = await createStaffPrincipal(createDatabase(), {
    ...audit({ actorPrincipalId: STAFF_ID }),
    principalId: NEW_ID,
    authIdentityId: "auth-nueva",
    normalizedEmail: "nueva@example.com",
    displayName: "Nueva",
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "NOT_APPLIED");
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 2);
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_events"), 0);
});

test("una identidad que ya tiene principal no recibe otro", async () => {
  const outcome = await createStaffPrincipal(createDatabase(), {
    ...audit(),
    principalId: NEW_ID,
    authIdentityId: "auth-staff",
    normalizedEmail: "staff@example.com",
    displayName: "Duplicada",
  });

  assert.equal(outcome.ok, false);
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 2);
});

test("conceder y revocar una capacidad cambia la autorización real", async () => {
  const request = {
    authIdentityId: "auth-staff",
    capability: "tenants:manage",
    authSessionTokenHash: SESSION_HASH,
    now: NOW,
  };
  const database = createDatabase();

  const before = await authorizeStaff(database, request);
  assert.equal(before.decision.reasonCode, "GRANT_MISSING");

  const granted = await grantStaffCapability(database, {
    ...audit({ eventId: "event-grant" }),
    grantId: "grant-tenants",
    principalId: STAFF_ID,
    capability: "tenants:manage",
  });
  assert.equal(granted.ok, true);

  const authorized = await authorizeStaff(database, request);
  assert.equal(authorized.decision.allowed, true);
  assert.equal(authorized.decision.grantId, "grant-tenants");

  const revoked = await revokeStaffCapability(database, {
    ...audit({ eventId: "event-revoke", idempotencyKeyHash: "e".repeat(64), now: NOW + 60 }),
    grantId: "grant-tenants",
    principalId: STAFF_ID,
    expectedVersion: 1,
  });
  assert.equal(revoked.ok, true);

  const denied = await authorizeStaff(database, { ...request, now: NOW + 61 });
  assert.equal(denied.decision.allowed, false);
  assert.equal(denied.decision.reasonCode, "GRANT_MISSING");
});

test("no puede haber dos grants activos de la misma capacidad", async () => {
  const database = createDatabase();
  await grantStaffCapability(database, {
    ...audit({ eventId: "event-grant" }),
    grantId: "grant-a",
    principalId: STAFF_ID,
    capability: "flags:manage",
  });

  const duplicate = await grantStaffCapability(database, {
    ...audit({ eventId: "event-grant-2", idempotencyKeyHash: "e".repeat(64) }),
    grantId: "grant-b",
    principalId: STAFF_ID,
    capability: "flags:manage",
  });

  assert.equal(duplicate.ok, false);
  assert.equal(
    countOf(
      "SELECT COUNT(*) AS total FROM platform_staff_capability_grants WHERE principal_id = ? AND status = 'active'",
      STAFF_ID,
    ),
    1,
  );
});

test("revocar con una versión obsoleta no aplica nada", async () => {
  const database = createDatabase();
  await grantStaffCapability(database, {
    ...audit({ eventId: "event-grant" }),
    grantId: "grant-tenants",
    principalId: STAFF_ID,
    capability: "tenants:manage",
  });

  const stale = await revokeStaffCapability(database, {
    ...audit({ eventId: "event-revoke", idempotencyKeyHash: "e".repeat(64) }),
    grantId: "grant-tenants",
    principalId: STAFF_ID,
    expectedVersion: 7,
  });

  assert.equal(stale.ok, false);
  assert.equal(stale.reasonCode, "NOT_APPLIED");
  assert.equal(
    db.prepare("SELECT status FROM platform_staff_capability_grants WHERE id = 'grant-tenants'")
      .get().status,
    "active",
  );
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_events WHERE id = 'event-revoke'"), 0);
});

test("suspender cierra el acceso y sus elevaciones vigentes a la vez", async () => {
  db.prepare(`
    INSERT INTO platform_staff_elevations (
      token_hash, principal_id, auth_session_token_hash, created_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, NULL)
  `).run("1".repeat(64), STAFF_ID, SESSION_HASH, NOW - 60, NOW + 300);

  const outcome = await suspendStaffPrincipal(createDatabase(), {
    ...audit({ eventId: "event-suspend", reason: "Retiro del equipo." }),
    principalId: STAFF_ID,
    expectedVersion: 1,
  });

  assert.equal(outcome.ok, true);
  const row = db.prepare(
    "SELECT status, suspended_at AS suspendedAt, version FROM platform_staff_principals WHERE id = ?",
  ).get(STAFF_ID);
  assert.equal(row.status, "suspended");
  assert.equal(row.suspendedAt, NOW);
  assert.equal(row.version, 2);
  assert.equal(
    countOf(
      "SELECT COUNT(*) AS total FROM platform_staff_elevations WHERE principal_id = ? AND revoked_at IS NULL",
      STAFF_ID,
    ),
    0,
    "una suspensión no puede dejar una elevación viva",
  );
});

test("nadie puede suspenderse a sí mismo", async () => {
  const outcome = await suspendStaffPrincipal(createDatabase(), {
    ...audit({ actorPrincipalId: STAFF_ID, eventId: "event-suspend" }),
    principalId: STAFF_ID,
    expectedVersion: 1,
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.reasonCode, "INPUT_INVALID");
  assert.equal(
    db.prepare("SELECT status FROM platform_staff_principals WHERE id = ?").get(STAFF_ID).status,
    "active",
  );
});

test("el último owner activo no puede quedar suspendido", async () => {
  const outcome = await suspendStaffPrincipal(createDatabase(), {
    ...audit({ actorPrincipalId: STAFF_ID, eventId: "event-suspend" }),
    principalId: OWNER_ID,
    expectedVersion: 1,
  });

  assert.equal(outcome.ok, false);
  assert.equal(
    db.prepare("SELECT status FROM platform_staff_principals WHERE id = ?").get(OWNER_ID).status,
    "active",
  );
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_events"), 0);
});

test("toda entrada inválida se rechaza sin tocar la base", async () => {
  const database = createDatabase();
  const invalid = [
    () => createStaffPrincipal(database, {
      ...audit({ reason: "no" }),
      principalId: NEW_ID,
      authIdentityId: "auth-nueva",
      normalizedEmail: "nueva@example.com",
      displayName: "Nueva",
    }),
    () => createStaffPrincipal(database, {
      ...audit(),
      principalId: "no-es-id",
      authIdentityId: "auth-nueva",
      normalizedEmail: "nueva@example.com",
      displayName: "Nueva",
    }),
    () => createStaffPrincipal(database, {
      ...audit(),
      principalId: NEW_ID,
      authIdentityId: "auth-nueva",
      normalizedEmail: "Nueva@Example.com",
      displayName: "Nueva",
    }),
    () => createStaffPrincipal(database, {
      ...audit({ idempotencyKeyHash: "corto" }),
      principalId: NEW_ID,
      authIdentityId: "auth-nueva",
      normalizedEmail: "nueva@example.com",
      displayName: "Nueva",
    }),
    () => grantStaffCapability(database, {
      ...audit(),
      grantId: "grant-x",
      principalId: STAFF_ID,
      capability: "support:write",
    }),
    () => revokeStaffCapability(database, {
      ...audit(),
      grantId: "grant-x",
      principalId: STAFF_ID,
      expectedVersion: 0,
    }),
  ];

  for (const [index, run] of invalid.entries()) {
    const outcome = await run();
    assert.equal(outcome.ok, false, `caso ${index}`);
    assert.equal(outcome.reasonCode, "INPUT_INVALID", `caso ${index}`);
  }

  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 2);
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_events"), 0);
});
