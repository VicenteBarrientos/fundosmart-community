import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";
import {
  authorizeStaff,
  readStaffAuthorization,
  reauthorizeStaff,
} from "../src/modules/staff/server/platform-staff-repository.ts";

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
const OTHER_SESSION_HASH = "b".repeat(64);
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
      FOREIGN KEY (identity_id) REFERENCES auth_identities(id)
    );
    CREATE TABLE organizations (id TEXT PRIMARY KEY NOT NULL);
    INSERT INTO auth_identities (id, normalized_email) VALUES
      ('auth-owner', 'owner@example.com'),
      ('auth-staff', 'staff@example.com'),
      ('auth-sin-principal', 'ajeno@example.com');
    INSERT INTO auth_sessions (token_hash, identity_id) VALUES
      ('${SESSION_HASH}', 'auth-staff'),
      ('${OTHER_SESSION_HASH}', 'auth-staff');
  `);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
  seedOwnerAndStaff();
});

function seedOwnerAndStaff() {
  db.exec(`
    INSERT INTO platform_staff_bootstrap_claims (
      id, normalized_email, status, principal_id, created_at, claimed_at, disabled_at, version
    ) VALUES ('bootstrap-owner-v1', 'owner@example.com', 'pending', NULL, 900, NULL, NULL, 1);
  `);
  db.prepare(`
    INSERT INTO platform_staff_principals (
      id, auth_identity_id, normalized_email_snapshot, display_name, kind, status,
      version, created_by_principal_id, created_at, updated_at, suspended_at
    ) VALUES (?, 'auth-owner', 'owner@example.com', 'Owner', 'owner', 'active', 1, NULL, 1000, 1000, NULL)
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

function grant(capability, { id = `grant-${capability}`, principalId = STAFF_ID } = {}) {
  db.prepare(`
    INSERT INTO platform_staff_capability_grants (
      id, principal_id, capability, status, reason, granted_by_principal_id,
      granted_at, revoked_by_principal_id, revoked_at, version
    ) VALUES (?, ?, ?, 'active', 'Alta de operación', ?, 1000, NULL, NULL, 1)
  `).run(id, principalId, capability, OWNER_ID);
}

function revokeGrant(id) {
  db.prepare(`
    UPDATE platform_staff_capability_grants
    SET status = 'revoked', revoked_by_principal_id = ?, revoked_at = 1100, version = version + 1
    WHERE id = ?
  `).run(OWNER_ID, id);
}

function suspendPrincipal(id) {
  db.prepare(`
    UPDATE platform_staff_principals
    SET status = 'suspended', suspended_at = 1100, updated_at = 1100, version = version + 1
    WHERE id = ?
  `).run(id);
}

function elevate({
  tokenHash = "c".repeat(64),
  principalId = STAFF_ID,
  sessionHash = SESSION_HASH,
  createdAt = NOW - 60,
  expiresAt = NOW + 300,
  revokedAt = null,
} = {}) {
  db.prepare(`
    INSERT INTO platform_staff_elevations (
      token_hash, principal_id, auth_session_token_hash, created_at, expires_at, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(tokenHash, principalId, sessionHash, createdAt, expiresAt, revokedAt);
}

function createDatabase({ failBatch = false, mutateResults = null } = {}) {
  const constraints = [];
  const sessions = [];

  const database = {
    withSession(constraint) {
      constraints.push(constraint);
      const session = {
        prepare(query) {
          return { bind: (...values) => ({ query, values }) };
        },
        async batch(statements) {
          if (failBatch) {
            throw new Error("D1_ERROR: no such column: platform_staff_principals.secreto");
          }
          const results = statements.map((statement) => ({
            success: true,
            results: db.prepare(statement.query).all(...statement.values),
          }));
          return mutateResults ? mutateResults(results) : results;
        },
        getBookmark: () => null,
      };
      sessions.push(session);
      return session;
    },
  };

  return { database, constraints, sessions };
}

function request(overrides = {}) {
  return {
    authIdentityId: "auth-staff",
    capability: "support:read",
    authSessionTokenHash: SESSION_HASH,
    now: NOW,
    ...overrides,
  };
}

test("la autorización se ancla en la primaria y admite un grant activo", async () => {
  grant("support:read");
  const { database, constraints, sessions } = createDatabase();

  const attempt = await authorizeStaff(database, request());

  assert.deepEqual(constraints, ["first-primary"]);
  assert.equal(sessions.length, 1);
  assert.equal(attempt.session, sessions[0]);
  assert.equal(attempt.decision.allowed, true);
  assert.equal(attempt.decision.principalId, STAFF_ID);
  assert.equal(attempt.decision.grantId, "grant-support:read");
  assert.equal(attempt.decision.snapshot.principalVersion, 1);
  assert.equal(attempt.decision.snapshot.grantVersion, 1);
});

test("una identidad sin principal global nunca autoriza", async () => {
  grant("support:read");
  const { database } = createDatabase();

  const attempt = await authorizeStaff(
    database,
    request({ authIdentityId: "auth-sin-principal" }),
  );

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "PRINCIPAL_MISSING");
  assert.equal(attempt.decision.publicCode, "STAFF_REQUIRED");
});

test("un principal suspendido pierde el acceso en la request siguiente", async () => {
  grant("support:read");
  suspendPrincipal(STAFF_ID);
  const { database } = createDatabase();

  const attempt = await authorizeStaff(database, request());

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "PRINCIPAL_SUSPENDED");
});

test("un grant revocado deja de cargarse y deniega", async () => {
  grant("support:read");
  revokeGrant("grant-support:read");
  const { database } = createDatabase();

  const attempt = await authorizeStaff(database, request());

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "GRANT_MISSING");
});

test("el grant de otro principal no sirve para el actor actual", async () => {
  grant("support:read", { id: "grant-owner-support", principalId: OWNER_ID });
  const { database } = createDatabase();

  const attempt = await authorizeStaff(database, request());

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "GRANT_MISSING");
});

test("una capacidad sensible exige elevación vigente ligada a la sesión", async () => {
  grant("staff:manage");
  const sensitive = request({ capability: "staff:manage" });

  const withoutElevation = await authorizeStaff(createDatabase().database, sensitive);
  assert.equal(withoutElevation.decision.allowed, false);
  assert.equal(withoutElevation.decision.reasonCode, "ELEVATION_MISSING");
  assert.equal(withoutElevation.decision.publicCode, "STAFF_ELEVATION_REQUIRED");

  elevate();
  const withElevation = await authorizeStaff(createDatabase().database, sensitive);
  assert.equal(withElevation.decision.allowed, true);
  assert.equal(withElevation.decision.elevationRequired, true);
  assert.equal(withElevation.decision.elevationConfirmed, true);
});

test("una elevación de otra sesión del mismo principal no se aprovecha", async () => {
  grant("operations:sensitive");
  elevate({ sessionHash: OTHER_SESSION_HASH });
  const { database } = createDatabase();

  const attempt = await authorizeStaff(
    database,
    request({ capability: "operations:sensitive" }),
  );

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "ELEVATION_MISSING");
});

test("una elevación caducada o revocada no habilita la operación sensible", async () => {
  grant("operations:sensitive");
  const sensitive = request({ capability: "operations:sensitive" });

  elevate({ tokenHash: "d".repeat(64), createdAt: NOW - 600, expiresAt: NOW - 300 });
  const expired = await authorizeStaff(createDatabase().database, sensitive);
  assert.equal(expired.decision.reasonCode, "ELEVATION_EXPIRED");

  elevate({
    tokenHash: "e".repeat(64),
    createdAt: NOW - 60,
    expiresAt: NOW + 300,
    revokedAt: NOW - 10,
  });
  const revoked = await authorizeStaff(createDatabase().database, sensitive);
  assert.equal(revoked.decision.reasonCode, "ELEVATION_REVOKED");
});

test("la barrera reutiliza la misma sesión y confirma un estado intacto", async () => {
  grant("support:read");
  const { database, sessions } = createDatabase();

  const attempt = await authorizeStaff(database, request());
  const barrier = await reauthorizeStaff(
    attempt.session,
    request(),
    attempt.decision.snapshot,
  );

  assert.equal(sessions.length, 1);
  assert.equal(barrier.allowed, true);
  assert.equal(barrier.grantId, "grant-support:read");
});

test("revocar el grant durante la carga descarta la respuesta", async () => {
  grant("support:read");
  const { database } = createDatabase();
  const attempt = await authorizeStaff(database, request());
  assert.equal(attempt.decision.allowed, true);

  revokeGrant("grant-support:read");
  const barrier = await reauthorizeStaff(
    attempt.session,
    request(),
    attempt.decision.snapshot,
  );

  assert.equal(barrier.allowed, false);
  assert.equal(barrier.reasonCode, "STAFF_ACCESS_CHANGED");
  assert.equal(barrier.publicCode, "STAFF_ACCESS_CHANGED");
  assert.equal(barrier.snapshot, null);
});

test("suspender el principal durante la carga descarta la respuesta", async () => {
  grant("support:read");
  const { database } = createDatabase();
  const attempt = await authorizeStaff(database, request());

  suspendPrincipal(STAFF_ID);
  const barrier = await reauthorizeStaff(
    attempt.session,
    request(),
    attempt.decision.snapshot,
  );

  assert.equal(barrier.allowed, false);
  assert.equal(barrier.reasonCode, "STAFF_ACCESS_CHANGED");
});

test("un cambio de versión concurrente invalida el snapshot aunque siga activo", async () => {
  grant("support:read");
  const { database } = createDatabase();
  const attempt = await authorizeStaff(database, request());

  db.prepare(`
    UPDATE platform_staff_principals
    SET display_name = 'Operadora Senior', updated_at = 1200, version = version + 1
    WHERE id = ?
  `).run(STAFF_ID);

  const barrier = await reauthorizeStaff(
    attempt.session,
    request(),
    attempt.decision.snapshot,
  );

  assert.equal(barrier.allowed, false);
  assert.equal(barrier.reasonCode, "STAFF_ACCESS_CHANGED");
});

test("una caída de D1 deniega sin publicar el mensaje interno", async () => {
  grant("support:read");
  const { database } = createDatabase({ failBatch: true });

  const attempt = await authorizeStaff(database, request());

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "BACKEND_UNAVAILABLE");
  assert.equal(attempt.decision.publicCode, "STAFF_REQUIRED");
  assert.doesNotMatch(JSON.stringify(attempt.decision), /D1_ERROR|secreto|platform_staff_principals/u);
});

test("una caída de D1 en la barrera no se confunde con una revocación", async () => {
  grant("support:read");
  const { database } = createDatabase();
  const attempt = await authorizeStaff(database, request());

  const broken = {
    prepare: attempt.session.prepare,
    batch: async () => {
      throw new Error("D1_ERROR: connection lost");
    },
    getBookmark: () => null,
  };
  const barrier = await reauthorizeStaff(broken, request(), attempt.decision.snapshot);

  assert.equal(barrier.allowed, false);
  assert.equal(barrier.reasonCode, "BACKEND_UNAVAILABLE");
});

test("una respuesta con forma inesperada falla cerrada", async () => {
  grant("support:read");

  const truncated = createDatabase({ mutateResults: (results) => results.slice(0, 2) });
  const shortBatch = await authorizeStaff(truncated.database, request());
  assert.equal(shortBatch.decision.reasonCode, "ROW_SHAPE_INVALID");

  const corrupted = createDatabase({
    mutateResults: (results) => [
      { success: true, results: [{ ...results[0].results[0], version: "uno" }] },
      results[1],
      results[2],
    ],
  });
  const badRow = await authorizeStaff(corrupted.database, request());
  assert.equal(badRow.decision.reasonCode, "ROW_SHAPE_INVALID");

  const duplicated = createDatabase({
    mutateResults: (results) => [
      { success: true, results: [results[0].results[0], results[0].results[0]] },
      results[1],
      results[2],
    ],
  });
  const twoPrincipals = await authorizeStaff(duplicated.database, request());
  assert.equal(twoPrincipals.decision.reasonCode, "ROW_SHAPE_INVALID");
});

test("una petición sin identidad o sin sesión no consulta la base", async () => {
  grant("support:read");
  const { database, sessions } = createDatabase();
  const session = database.withSession("first-primary");
  let queried = false;
  const observed = {
    prepare: (query) => {
      queried = true;
      return session.prepare(query);
    },
    batch: session.batch,
    getBookmark: () => null,
  };

  const withoutIdentity = await readStaffAuthorization(
    observed,
    request({ authIdentityId: "" }),
  );
  const withoutSession = await readStaffAuthorization(
    observed,
    request({ authSessionTokenHash: "" }),
  );

  assert.equal(queried, false);
  assert.equal(sessions.length, 1);
  assert.equal(withoutIdentity.reasonCode, "ROW_SHAPE_INVALID");
  assert.equal(withoutSession.reasonCode, "ROW_SHAPE_INVALID");
});

test("una capacidad fuera del catálogo se rechaza sin autorizar", async () => {
  grant("support:read");
  const { database } = createDatabase();

  const attempt = await authorizeStaff(database, request({ capability: "support:write" }));

  assert.equal(attempt.decision.allowed, false);
  assert.equal(attempt.decision.reasonCode, "CAPABILITY_INVALID");
  assert.equal(attempt.decision.capability, null);
});
