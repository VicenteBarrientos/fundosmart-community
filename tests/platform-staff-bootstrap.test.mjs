import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, test } from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";
import { claimStaffBootstrap } from "../src/modules/staff/server/platform-staff-bootstrap-repository.ts";
import { STAFF_CAPABILITIES } from "../src/modules/staff/domain/staff-authorization.mjs";

const migration = publicSqlForTables([
  "platform_staff_bootstrap_claims",
  "platform_staff_capability_grants",
  "platform_staff_elevations",
  "platform_staff_events",
  "platform_staff_principals",
]);

const PRINCIPAL_ID = "018f0000-0000-4000-8000-000000000001";
const OTHER_PRINCIPAL_ID = "018f0000-0000-4000-8000-000000000002";
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
      ('auth-otro', 'otro@example.com');
  `);
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));
});

function pendingClaim(email = "owner@example.com", id = "bootstrap-owner-v1") {
  db.prepare(`
    INSERT INTO platform_staff_bootstrap_claims (
      id, normalized_email, status, principal_id, created_at, claimed_at, disabled_at, version
    ) VALUES (?, ?, 'pending', NULL, 900, NULL, NULL, 1)
  `).run(id, email);
}

/**
 * Emula el contrato de D1: `batch()` es una transacción que revierte la
 * secuencia completa cuando falla una sentencia.
 */
function createDatabase({ failOn = null } = {}) {
  const database = {
    withSession() {
      return {
        prepare(query) {
          if (failOn === "prepare") throw new Error("D1_ERROR: prepare rechazado");
          return {
            query,
            values: [],
            bind(...values) {
              return { ...this, values };
            },
            async first() {
              if (failOn === "first") throw new Error("D1_ERROR: lectura rechazada");
              return db.prepare(this.query).get(...this.values) ?? null;
            },
          };
        },
        async batch(statements) {
          if (failOn === "batch") throw new Error("D1_ERROR: batch rechazado");
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
  return database;
}

function request(overrides = {}) {
  return {
    authIdentityId: "auth-owner",
    normalizedEmail: "owner@example.com",
    displayName: "Operador de prueba",
    principalId: PRINCIPAL_ID,
    eventId: "event-bootstrap-1",
    requestId: "req-1",
    now: NOW,
    ...overrides,
  };
}

function countOf(sql, ...values) {
  return Number(db.prepare(sql).get(...values).total);
}

test("reclamar el bootstrap crea principal, grants, evento y cierra el claim", async () => {
  pendingClaim();

  const outcome = await claimStaffBootstrap(createDatabase(), request());

  assert.equal(outcome.claimed, true);
  assert.equal(outcome.principalId, PRINCIPAL_ID);
  assert.deepEqual([...outcome.capabilities], [...STAFF_CAPABILITIES]);

  const principal = db.prepare(
    "SELECT kind, status, version, created_by_principal_id AS creator FROM platform_staff_principals WHERE id = ?",
  ).get(PRINCIPAL_ID);
  assert.equal(principal.kind, "owner");
  assert.equal(principal.status, "active");
  assert.equal(principal.version, 1);
  assert.equal(principal.creator, null);

  const grants = db.prepare(
    "SELECT capability, status, granted_by_principal_id AS grantedBy FROM platform_staff_capability_grants WHERE principal_id = ? ORDER BY capability",
  ).all(PRINCIPAL_ID);
  assert.equal(grants.length, STAFF_CAPABILITIES.length);
  assert.deepEqual(
    grants.map((row) => row.capability),
    [...STAFF_CAPABILITIES].sort(),
  );
  assert.ok(grants.every((row) => row.status === "active" && row.grantedBy === PRINCIPAL_ID));

  const claim = db.prepare(
    "SELECT status, principal_id AS principalId, claimed_at AS claimedAt, version FROM platform_staff_bootstrap_claims WHERE normalized_email = ?",
  ).get("owner@example.com");
  assert.equal(claim.status, "claimed");
  assert.equal(claim.principalId, PRINCIPAL_ID);
  assert.equal(claim.claimedAt, NOW);
  assert.equal(claim.version, 2);

  const event = db.prepare(
    "SELECT actor_type AS actorType, action, target_id AS targetId, after_json AS afterJson FROM platform_staff_events WHERE id = ?",
  ).get("event-bootstrap-1");
  assert.equal(event.actorType, "system");
  assert.equal(event.action, "platform.staff.bootstrap-claimed.v1");
  assert.equal(event.targetId, PRINCIPAL_ID);
  assert.deepEqual(JSON.parse(event.afterJson).capabilities, [...STAFF_CAPABILITIES]);
});

test("el bootstrap es de un solo uso: el segundo intento no concede nada", async () => {
  pendingClaim();
  const first = await claimStaffBootstrap(createDatabase(), request());
  assert.equal(first.claimed, true);

  const second = await claimStaffBootstrap(
    createDatabase(),
    request({ principalId: OTHER_PRINCIPAL_ID, eventId: "event-bootstrap-2" }),
  );

  assert.equal(second.claimed, false);
  assert.equal(second.reasonCode, "PRINCIPAL_EXISTS");
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 1);
  assert.equal(
    countOf("SELECT COUNT(*) AS total FROM platform_staff_capability_grants"),
    STAFF_CAPABILITIES.length,
  );
});

test("sin un claim pendiente el correo no concede acceso", async () => {
  const outcome = await claimStaffBootstrap(createDatabase(), request());

  assert.equal(outcome.claimed, false);
  assert.equal(outcome.reasonCode, "NO_PENDING_CLAIM");
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 0);
});

test("un claim deshabilitado nunca vuelve a conceder acceso", async () => {
  pendingClaim();
  db.exec(`
    UPDATE platform_staff_bootstrap_claims
    SET status = 'disabled', disabled_at = 950, version = 2
    WHERE id = 'bootstrap-owner-v1'
  `);

  const outcome = await claimStaffBootstrap(createDatabase(), request());

  assert.equal(outcome.claimed, false);
  assert.equal(outcome.reasonCode, "NO_PENDING_CLAIM");
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 0);
});

test("una identidad con otro correo no puede reclamar el claim ajeno", async () => {
  pendingClaim();

  const outcome = await claimStaffBootstrap(
    createDatabase(),
    request({ authIdentityId: "auth-otro" }),
  );

  assert.equal(outcome.claimed, false);
  assert.equal(outcome.reasonCode, "IDENTITY_MISMATCH");
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 0);
});

test("un correo con claim pero sin identidad registrada no reclama", async () => {
  pendingClaim("sin-identidad@example.com", "bootstrap-sin-identidad");

  const outcome = await claimStaffBootstrap(
    createDatabase(),
    request({ normalizedEmail: "sin-identidad@example.com" }),
  );

  assert.equal(outcome.claimed, false);
  assert.equal(outcome.reasonCode, "IDENTITY_MISMATCH");
});

test("una entrada inválida se rechaza sin tocar la base", async () => {
  pendingClaim();
  const invalid = [
    { principalId: "no-es-un-id" },
    { principalId: "018F0000-0000-4000-8000-000000000001" },
    { normalizedEmail: "Owner@Example.com" },
    { normalizedEmail: "sin-arroba" },
    { displayName: "   " },
    { now: NOW + 0.5 },
    { now: -1 },
    { requestId: "" },
    { eventId: "" },
    { authIdentityId: "" },
  ];

  for (const overrides of invalid) {
    const outcome = await claimStaffBootstrap(createDatabase(), request(overrides));
    assert.equal(outcome.claimed, false, JSON.stringify(overrides));
    assert.equal(outcome.reasonCode, "INPUT_INVALID", JSON.stringify(overrides));
  }

  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 0);
  assert.equal(
    countOf("SELECT COUNT(*) AS total FROM platform_staff_bootstrap_claims WHERE status = 'pending'"),
    1,
  );
});

test("una caída de D1 no deja el bootstrap a medias", async () => {
  pendingClaim();

  const readFailure = await claimStaffBootstrap(
    createDatabase({ failOn: "first" }),
    request(),
  );
  assert.equal(readFailure.reasonCode, "BACKEND_UNAVAILABLE");

  const batchFailure = await claimStaffBootstrap(
    createDatabase({ failOn: "batch" }),
    request(),
  );
  assert.equal(batchFailure.reasonCode, "CONFLICT");

  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 0);
  assert.equal(
    countOf("SELECT COUNT(*) AS total FROM platform_staff_bootstrap_claims WHERE status = 'pending'"),
    1,
  );
});

test("un identificador de evento ya usado revierte el batch completo", async () => {
  pendingClaim();
  const preexisting = await claimStaffBootstrap(createDatabase(), request());
  assert.equal(preexisting.claimed, true);

  pendingClaim("otro@example.com", "bootstrap-otro");
  const collision = await claimStaffBootstrap(
    createDatabase(),
    request({
      authIdentityId: "auth-otro",
      normalizedEmail: "otro@example.com",
      principalId: OTHER_PRINCIPAL_ID,
      eventId: "event-bootstrap-1",
    }),
  );

  assert.equal(collision.claimed, false);
  assert.equal(collision.reasonCode, "CONFLICT");
  assert.equal(countOf("SELECT COUNT(*) AS total FROM platform_staff_principals"), 1);
  assert.equal(
    countOf(
      "SELECT COUNT(*) AS total FROM platform_staff_bootstrap_claims WHERE normalized_email = 'otro@example.com' AND status = 'pending'",
    ),
    1,
  );
  assert.equal(
    countOf("SELECT COUNT(*) AS total FROM platform_staff_capability_grants"),
    STAFF_CAPABILITIES.length,
  );
});

test("el resultado del bootstrap es un objeto congelado y sin datos internos", async () => {
  pendingClaim();

  const outcome = await claimStaffBootstrap(createDatabase(), request());

  assert.ok(Object.isFrozen(outcome));
  assert.deepEqual(Object.keys(outcome).sort(), [
    "capabilities",
    "claimed",
    "principalId",
    "reasonCode",
  ]);
  assert.doesNotMatch(JSON.stringify(outcome), /platform_staff|D1_ERROR|SELECT/u);
});
