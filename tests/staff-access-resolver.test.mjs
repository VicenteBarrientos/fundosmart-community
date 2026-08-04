import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";
import {
  PLATFORM_STAFF_V2_REQUIRED_KEY,
  reauthorizeResolvedStaffAccess,
  resolveStaffAccess,
} from "../src/modules/staff/server/staff-access-resolver.ts";

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
const NOW = 1_772_000_000;
const LEGACY_OWNERS = Object.freeze(["duenio@example.com"]);

let db;

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_state (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
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
      ('auth-owner', 'duenio@example.com'),
      ('auth-staff', 'staff@example.com');
    INSERT INTO auth_sessions (token_hash, identity_id) VALUES
      ('${SESSION_HASH}', 'auth-staff');
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
    ) VALUES ('grant-support', ?, 'support:read', 'active', 'Soporte', ?, 1000, NULL, NULL, 1)
  `).run(STAFF_ID, OWNER_ID);
}

function enableCutover() {
  db.prepare("INSERT INTO app_state (key, value) VALUES (?, 'true')")
    .run(PLATFORM_STAFF_V2_REQUIRED_KEY);
}

function createDatabase({ failMarker = false } = {}) {
  const sessions = [];
  const constraints = [];
  const database = {
    withSession(constraint) {
      constraints.push(constraint);
      const session = {
        prepare(query) {
          return {
            query,
            values: [],
            bind(...values) {
              return { ...this, values };
            },
            async first() {
              if (failMarker && this.query.includes("app_state")) {
                throw new Error("D1_ERROR: app_state inaccesible");
              }
              return db.prepare(this.query).get(...this.values) ?? null;
            },
          };
        },
        async batch(statements) {
          return statements.map((statement) => ({
            success: true,
            results: db.prepare(statement.query).all(...statement.values),
          }));
        },
        getBookmark: () => null,
      };
      sessions.push(session);
      return session;
    },
  };
  return { database, sessions, constraints };
}

function request(overrides = {}) {
  return {
    authIdentityId: "auth-staff",
    normalizedEmail: "staff@example.com",
    authSessionTokenHash: SESSION_HASH,
    capability: "support:read",
    now: NOW,
    legacyOwnerEmails: LEGACY_OWNERS,
    ...overrides,
  };
}

test("sin el marcador de corte manda el correo legado", async () => {
  const { database, constraints, sessions } = createDatabase();

  const legacy = await resolveStaffAccess(
    database,
    request({ normalizedEmail: "duenio@example.com", authIdentityId: "auth-owner" }),
  );

  assert.deepEqual(constraints, ["first-primary"]);
  assert.equal(legacy.granted, true);
  assert.equal(legacy.mode, "legacy-email");
  assert.equal(legacy.decision, null);
  assert.equal(legacy.session, sessions[0]);
});

test("sin el marcador, un correo que no es el propietario legado no entra", async () => {
  const { database } = createDatabase();

  const resolution = await resolveStaffAccess(database, request());

  assert.equal(resolution.granted, false);
  assert.equal(resolution.mode, "legacy-email");
  assert.equal(resolution.reasonCode, "LEGACY_EMAIL_MISMATCH");
  assert.equal(resolution.publicCode, "STAFF_REQUIRED");
});

test("con el marcador presente el correo legado deja de autorizar", async () => {
  enableCutover();
  const { database } = createDatabase();

  const resolution = await resolveStaffAccess(
    database,
    request({ normalizedEmail: "duenio@example.com", authIdentityId: "auth-owner" }),
  );

  assert.equal(resolution.granted, false);
  assert.equal(resolution.mode, "principal");
  assert.equal(resolution.decision.reasonCode, "GRANT_MISSING");
});

test("con el marcador presente manda el principal con su grant", async () => {
  enableCutover();
  const { database, sessions } = createDatabase();

  const resolution = await resolveStaffAccess(database, request());

  assert.equal(resolution.granted, true);
  assert.equal(resolution.mode, "principal");
  assert.equal(resolution.decision.principalId, STAFF_ID);
  assert.equal(resolution.snapshot.grantId, "grant-support");
  assert.equal(sessions.length, 1, "el marcador y la autorización comparten sesión");
});

test("con el marcador presente una capacidad sin grant se deniega", async () => {
  enableCutover();
  const { database } = createDatabase();

  const resolution = await resolveStaffAccess(
    database,
    request({ capability: "tenants:manage" }),
  );

  assert.equal(resolution.granted, false);
  assert.equal(resolution.decision.reasonCode, "GRANT_MISSING");
  assert.equal(resolution.publicCode, "STAFF_REQUIRED");
  assert.equal(resolution.snapshot, null);
});

test("después del corte, una sesión o identidad ausente falla cerrada", async () => {
  enableCutover();

  const withoutIdentity = await resolveStaffAccess(
    createDatabase().database,
    request({ authIdentityId: null }),
  );
  assert.equal(withoutIdentity.granted, false);
  assert.equal(withoutIdentity.reasonCode, "IDENTITY_MISSING");

  const withoutSession = await resolveStaffAccess(
    createDatabase().database,
    request({ authSessionTokenHash: null }),
  );
  assert.equal(withoutSession.granted, false);
  assert.equal(withoutSession.reasonCode, "SESSION_MISSING");
});

test("un fallo al leer el marcador deniega sin caer al camino legado", async () => {
  const { database } = createDatabase({ failMarker: true });

  const resolution = await resolveStaffAccess(
    database,
    request({ normalizedEmail: "duenio@example.com", authIdentityId: "auth-owner" }),
  );

  assert.equal(resolution.granted, false);
  assert.equal(resolution.mode, null);
  assert.equal(resolution.reasonCode, "BACKEND_UNAVAILABLE");
  assert.doesNotMatch(JSON.stringify({ ...resolution, session: null }), /D1_ERROR|app_state/u);
});

test("la barrera relee en la misma sesión y confirma un estado intacto", async () => {
  enableCutover();
  const { database, sessions } = createDatabase();

  const resolved = await resolveStaffAccess(database, request());
  const barrier = await reauthorizeResolvedStaffAccess(database, resolved, request());

  assert.equal(sessions.length, 1, "la barrera no abre una sesión nueva");
  assert.equal(barrier.granted, true);
  assert.equal(barrier.snapshot.grantId, "grant-support");
});

test("revocar el grant durante la carga descarta la respuesta", async () => {
  enableCutover();
  const { database } = createDatabase();
  const resolved = await resolveStaffAccess(database, request());
  assert.equal(resolved.granted, true);

  db.prepare(`
    UPDATE platform_staff_capability_grants
    SET status = 'revoked', revoked_by_principal_id = ?, revoked_at = 1100, version = version + 1
    WHERE id = 'grant-support'
  `).run(OWNER_ID);

  const barrier = await reauthorizeResolvedStaffAccess(database, resolved, request());

  assert.equal(barrier.granted, false);
  assert.equal(barrier.publicCode, "STAFF_ACCESS_CHANGED");
  assert.equal(barrier.snapshot, null);
});

test("antes del corte la barrera vuelve a resolver el correo legado", async () => {
  const { database, sessions } = createDatabase();
  const legacyRequest = request({
    normalizedEmail: "duenio@example.com",
    authIdentityId: "auth-owner",
  });

  const resolved = await resolveStaffAccess(database, legacyRequest);
  const barrier = await reauthorizeResolvedStaffAccess(database, resolved, legacyRequest);

  assert.equal(barrier.granted, true);
  assert.equal(barrier.mode, "legacy-email");
  assert.equal(sessions.length, 2, "el camino legado abre una sesión nueva por lectura");

  const revoked = await reauthorizeResolvedStaffAccess(database, resolved, request());
  assert.equal(revoked.granted, false);
  assert.equal(revoked.reasonCode, "LEGACY_EMAIL_MISMATCH");
});

test("después del corte, suspender el principal corta el acceso enseguida", async () => {
  enableCutover();
  const { database } = createDatabase();

  const beforeSuspension = await resolveStaffAccess(database, request());
  assert.equal(beforeSuspension.granted, true);

  db.prepare(`
    UPDATE platform_staff_principals
    SET status = 'suspended', suspended_at = 1100, updated_at = 1100, version = version + 1
    WHERE id = ?
  `).run(STAFF_ID);

  const afterSuspension = await resolveStaffAccess(database, request());
  assert.equal(afterSuspension.granted, false);
  assert.equal(afterSuspension.mode, "principal");
  assert.equal(afterSuspension.decision.reasonCode, "PRINCIPAL_SUSPENDED");
});
