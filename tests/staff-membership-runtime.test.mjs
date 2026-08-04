import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { afterEach, before, beforeEach, test } from "node:test";
import ts from "typescript";

const repositoryUrl = new URL(
  "../src/modules/staff/server/staff-membership-repository.ts",
  import.meta.url,
);
const markerKey = "platform-staff-v2-required";
const now = new Date("2026-07-29T14:30:00.000Z");

let sqlite;
let d1;
let repository;
let repositorySource;

before(async () => {
  repositorySource = await readFile(repositoryUrl, "utf8");
  const output = ts.transpileModule(repositorySource, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      const stubs = {
        "@/db": { getDb: () => ({ $client: d1 }) },
        "@/src/modules/access/domain/access-rules.mjs": {
          normalizeAccessEmail: (email) => String(email ?? "").trim().toLowerCase(),
        },
        "@/src/modules/access/domain/types": {
          ORGANIZATION_MEMBERSHIP_ROLES: ["owner", "admin", "manager", "operator", "viewer"],
          ORGANIZATION_MEMBERSHIP_STATUSES: ["active", "suspended"],
        },
      };
      assert.ok(specifier in stubs, `Unexpected import: ${specifier}`);
      return stubs[specifier];
    },
    loadedModule,
    loadedModule.exports,
  );
  repository = loadedModule.exports;
});

test("uses the canonical membership enums and access-email normalizer", () => {
  assert.match(
    repositorySource,
    /import \{ normalizeAccessEmail \} from "@\/src\/modules\/access\/domain\/access-rules\.mjs";/u,
  );
  assert.match(
    repositorySource,
    /import \{[\s\S]*ORGANIZATION_MEMBERSHIP_ROLES,[\s\S]*ORGANIZATION_MEMBERSHIP_STATUSES,[\s\S]*\} from "@\/src\/modules\/access\/domain\/types";/u,
  );
  assert.doesNotMatch(repositorySource, /const MEMBERSHIP_(?:ROLES|STATUSES)\s*=/u);
  assert.doesNotMatch(repositorySource, /function normalizeEmail\s*\(/u);
  assert.equal(
    (repositorySource.match(/\$\{authority\.sql\}/gu) ?? []).length,
    5,
  );
  assert.match(
    repositorySource,
    /function currentStaffAuthorityCondition[\s\S]+auth_identities[\s\S]+account_closure_requests AS account_closure[\s\S]+account_closure_requests AS organization_closure[\s\S]+app_state AS staff_cutover/u,
  );
});

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(RELEVANT_SCHEMA);
  sqlite.exec(`
    INSERT INTO organizations (id, name) VALUES
      ('organization-a', 'Organization A'),
      ('organization-b', 'Organization B');
    INSERT INTO fields (id, organization_id, name) VALUES
      ('field-a-1', 'organization-a', 'Field A1'),
      ('field-a-2', 'organization-a', 'Field A2'),
      ('field-b-1', 'organization-b', 'Field B1');
  `);
  d1 = new TestD1Database(sqlite);
});

afterEach(() => {
  sqlite.close();
});

test("creates one membership, canonical scope set, and exact audit in a fixed five-statement batch", async () => {
  const plan = await preparePlan({
    organizationId: "organization-a",
    email: " Member@Example.COM ",
    displayName: "Member",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-2", "field-a-1", "field-a-2"],
    now,
    idFactory: sequenceFactory(1),
  });

  const result = await repository.commitLegacyStaffMembership({
    plan,
    actorSubject: "dev:fresh-staff@example.com",
    actorEmail: " Fresh-Staff@Example.COM ",
    staffCutoverMarkerKey: markerKey,
  });

  assert.equal(d1.batchCalls, 1);
  assert.equal(d1.lastBatch.length, 5);
  assert.match(d1.lastBatch[0].sql, /INSERT INTO audit_log/u);
  assert.match(d1.lastBatch[1].sql, /ON CONFLICT\(organization_id, normalized_email\)/u);
  assert.match(d1.lastBatch[2].sql, /DELETE FROM membership_field_access/u);
  assert.match(d1.lastBatch[3].sql, /json_each/u);
  assert.match(d1.lastBatch[4].sql, /abs\(-9223372036854775807 - 1\)/u);

  const membership = membershipByEmail("member@example.com");
  assert.equal(result.membershipId, membership.id);
  assert.equal(membership.user_email, "Member@Example.COM");
  assert.equal(membership.normalized_email, "member@example.com");
  assert.equal(membership.display_name, "Member");
  assert.equal(membership.role, "manager");
  assert.equal(membership.status, "active");
  assert.equal(membership.created_by, "Fresh-Staff@Example.COM");
  assert.equal(membership.created_at, now.toISOString());
  assert.equal(membership.updated_at, now.toISOString());
  assert.deepEqual(scopeIds(membership.id), ["field-a-1", "field-a-2"]);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT created_by FROM membership_field_access
      WHERE membership_id = ? ORDER BY field_id
    `).all(membership.id).map((row) => row.created_by),
    ["Fresh-Staff@Example.COM", "Fresh-Staff@Example.COM"],
  );

  const audit = singleAudit();
  assert.equal(audit.actor, "Fresh-Staff@Example.COM");
  assert.equal(audit.action, "access.membership.created");
  assert.equal(audit.entity_type, "organization_membership");
  assert.equal(audit.entity_id, membership.id);
  assert.equal(audit.before, null);
  assert.deepEqual(JSON.parse(audit.after), {
    id: membership.id,
    userEmail: "Member@Example.COM",
    displayName: "Member",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1", "field-a-2"],
  });
});

test("updates by composite identity, preserves immutable columns, and clears global scopes atomically", async () => {
  seedMembership({
    id: "membership-existing",
    email: "member@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  const before = membershipByEmail("member@example.com");
  const plan = await preparePlan({
    organizationId: "organization-a",
    email: "member@example.com",
    displayName: "After",
    role: "admin",
    status: "active",
    fieldIds: ["field-a-2"],
    now,
    idFactory: sequenceFactory(20),
  });

  const result = await repository.commitLegacyStaffMembership({
    plan,
    actorSubject: "dev:reauthorized@example.com",
    actorEmail: "reauthorized@example.com",
    staffCutoverMarkerKey: markerKey,
  });

  const membership = membershipByEmail("member@example.com");
  assert.equal(result.membershipId, "membership-existing");
  assert.equal(membership.id, "membership-existing");
  assert.equal(membership.user_email, before.user_email);
  assert.equal(membership.normalized_email, before.normalized_email);
  assert.equal(membership.created_by, before.created_by);
  assert.equal(membership.created_at, before.created_at);
  assert.equal(membership.display_name, "After");
  assert.equal(membership.role, "admin");
  assert.deepEqual(scopeIds(membership.id), []);

  const audit = singleAudit();
  assert.equal(audit.action, "access.membership.updated");
  assert.deepEqual(JSON.parse(audit.before), {
    id: "membership-existing",
    userEmail: "member@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  assert.deepEqual(JSON.parse(audit.after), {
    id: "membership-existing",
    userEmail: "member@example.com",
    displayName: "After",
    role: "admin",
    status: "active",
    fieldIds: [],
  });
});

test("rolls back audit, membership, and scopes when the staff cutover wins immediately before the batch", async () => {
  seedMembership({
    id: "membership-cutover",
    email: "cutover@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  const plan = await preparedUpdate("cutover@example.com", {
    displayName: "After",
    fieldIds: ["field-a-2"],
  });
  const before = membershipByEmail("cutover@example.com");
  d1.beforeNextBatch = (statements) => {
    assert.equal(statements.length, 5);
    sqlite.prepare("INSERT INTO app_state (key, value) VALUES (?, 'required')").run(markerKey);
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT" && error.status === 409,
  );

  assert.deepEqual(membershipByEmail("cutover@example.com"), before);
  assert.deepEqual(scopeIds("membership-cutover"), ["field-a-1"]);
  assert.equal(auditCount(), 0);
});

test("rolls back the full membership batch when the staff account closes", async () => {
  seedMembership({
    id: "membership-actor-closure",
    email: "actor-closure@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  const plan = await preparedUpdate("actor-closure@example.com", {
    displayName: "After",
    fieldIds: ["field-a-2"],
  });
  const before = membershipByEmail("actor-closure@example.com");
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      INSERT INTO account_closure_requests (id, scope, target_id, status)
      VALUES ('closure-staff', 'account', 'dev:staff@example.com', 'grace')
    `).run();
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT",
  );
  assert.deepEqual(membershipByEmail("actor-closure@example.com"), before);
  assert.deepEqual(scopeIds("membership-actor-closure"), ["field-a-1"]);
  assert.equal(auditCount(), 0);
});

test("rejects a stale membership preimage without overwriting the winning transaction", async () => {
  seedMembership({
    id: "membership-race",
    email: "race@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  const plan = await preparedUpdate("race@example.com", {
    displayName: "Requested",
    fieldIds: ["field-a-2"],
  });
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      UPDATE organization_memberships
      SET display_name = 'Winning change', updated_at = '2026-07-29T14:29:59.000Z'
      WHERE id = 'membership-race'
    `).run();
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT",
  );
  assert.equal(membershipByEmail("race@example.com").display_name, "Winning change");
  assert.deepEqual(scopeIds("membership-race"), ["field-a-1"]);
  assert.equal(auditCount(), 0);
});

test("rejects scope-only drift without deleting the winning scope set", async () => {
  seedMembership({
    id: "membership-scope-race",
    email: "scope-race@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  const plan = await preparedUpdate("scope-race@example.com", {
    displayName: "Requested",
    fieldIds: ["field-a-2"],
  });
  const before = membershipByEmail("scope-race@example.com");
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      INSERT INTO membership_field_access (
        id, membership_id, field_id, created_by, created_at
      ) VALUES (
        'winning-scope', 'membership-scope-race', 'field-a-2',
        'winner@example.com', '2026-07-29T14:29:59.000Z'
      )
    `).run();
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT",
  );
  assert.deepEqual(membershipByEmail("scope-race@example.com"), before);
  assert.deepEqual(
    scopeIds("membership-scope-race"),
    ["field-a-1", "field-a-2"],
  );
  assert.equal(auditCount(), 0);
});

test("rejects a missing expected scope without overwriting the winning scope set", async () => {
  seedMembership({
    id: "membership-scope-delete-race",
    email: "scope-delete-race@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1", "field-a-2"],
  });
  const plan = await preparedUpdate("scope-delete-race@example.com", {
    displayName: "Requested",
    fieldIds: ["field-a-1"],
  });
  const before = membershipByEmail("scope-delete-race@example.com");
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      DELETE FROM membership_field_access
      WHERE membership_id = 'membership-scope-delete-race'
        AND field_id = 'field-a-2'
    `).run();
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT",
  );
  assert.deepEqual(
    membershipByEmail("scope-delete-race@example.com"),
    before,
  );
  assert.deepEqual(scopeIds("membership-scope-delete-race"), ["field-a-1"]);
  assert.equal(auditCount(), 0);
});

test("rejects an absent-to-present membership race and preserves the winner", async () => {
  const plan = await preparePlan({
    organizationId: "organization-a",
    email: "create-race@example.com",
    displayName: "Requested",
    role: "viewer",
    status: "active",
    fieldIds: [],
    now,
    idFactory: sequenceFactory(140),
  });
  d1.beforeNextBatch = () => {
    seedMembership({
      id: "membership-create-winner",
      email: "create-race@example.com",
      displayName: "Winning membership",
      role: "manager",
      status: "active",
      fieldIds: ["field-a-1"],
    });
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT",
  );
  const winner = membershipByEmail("create-race@example.com");
  assert.equal(winner.id, "membership-create-winner");
  assert.equal(winner.display_name, "Winning membership");
  assert.deepEqual(scopeIds(winner.id), ["field-a-1"]);
  assert.equal(auditCount(), 0);
});

test("rejects a field that leaves the tenant after preparation", async () => {
  const plan = await preparePlan({
    organizationId: "organization-a",
    email: "field-race@example.com",
    displayName: "Requested",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-2"],
    now,
    idFactory: sequenceFactory(160),
  });
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      UPDATE fields SET organization_id = 'organization-b'
      WHERE id = 'field-a-2'
    `).run();
  };

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_CONFLICT",
  );
  assert.equal(membershipByEmail("field-race@example.com"), undefined);
  assert.equal(
    sqlite.prepare("SELECT organization_id FROM fields WHERE id = 'field-a-2'").get().organization_id,
    "organization-b",
  );
  assert.equal(auditCount(), 0);
});

test("a middle-statement failure rolls back the audit, membership update, and prior-scope deletion", async () => {
  seedMembership({
    id: "membership-rollback",
    email: "rollback@example.com",
    displayName: "Before",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
  });
  sqlite.exec(`
    CREATE TRIGGER fail_selected_scope
    BEFORE INSERT ON membership_field_access
    WHEN NEW.field_id = 'field-a-2'
    BEGIN
      SELECT RAISE(ABORT, 'TEST_SCOPE_FAILURE');
    END;
  `);
  const plan = await preparedUpdate("rollback@example.com", {
    displayName: "After",
    fieldIds: ["field-a-2"],
  });
  const before = membershipByEmail("rollback@example.com");

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    /TEST_SCOPE_FAILURE/u,
  );
  assert.deepEqual(membershipByEmail("rollback@example.com"), before);
  assert.deepEqual(scopeIds("membership-rollback"), ["field-a-1"]);
  assert.equal(auditCount(), 0);
});

test("keeps the final active owner and its audit atomically unchanged", async () => {
  seedMembership({
    id: "membership-owner",
    email: "owner@example.com",
    displayName: "Owner",
    role: "owner",
    status: "active",
    fieldIds: [],
  });
  const plan = await preparedUpdate("owner@example.com", {
    role: "viewer",
    status: "suspended",
    fieldIds: [],
  });
  const before = membershipByEmail("owner@example.com");

  await assert.rejects(
    repository.commitLegacyStaffMembership({
      plan,
      actorSubject: "dev:staff@example.com",
      actorEmail: "staff@example.com",
      staffCutoverMarkerKey: markerKey,
    }),
    (error) => error.code === "STAFF_MEMBERSHIP_LAST_OWNER" && error.status === 409,
  );
  assert.deepEqual(membershipByEmail("owner@example.com"), before);
  assert.deepEqual(scopeIds("membership-owner"), []);
  assert.equal(auditCount(), 0);
});

test("rejects malformed inputs and cross-tenant fields before any batch", async () => {
  const invalidInputs = [
    { role: "superadmin" },
    { status: "deleted" },
    { fieldIds: "field-a-1" },
    { fieldIds: ["field-a-1", 42] },
  ];
  for (const replacement of invalidInputs) {
    await assert.rejects(
      repository.prepareLegacyStaffMembership({
        organizationId: "organization-a",
        email: "member@example.com",
        displayName: "Member",
        role: "manager",
        status: "active",
        fieldIds: [],
        ...replacement,
      }),
      (error) => error.status === 400,
    );
  }
  const crossTenant = await repository.prepareLegacyStaffMembership({
      organizationId: "organization-a",
      email: "member@example.com",
      displayName: "Member",
      role: "manager",
      status: "active",
      fieldIds: ["field-b-1"],
    });
  assert.equal(crossTenant.ok, false);
  assert.equal(crossTenant.error.code, "STAFF_MEMBERSHIP_INVALID_FIELD");
  assert.equal(crossTenant.error.status, 400);
  assert.equal(
    crossTenant.error.message,
    "Uno de los fundos seleccionados no pertenece a la organización.",
  );
  assert.equal(d1.batchCalls, 0);
  assert.equal(auditCount(), 0);
});

test("preserves the exact legacy email and organization validation contracts", async () => {
  await assert.rejects(
    repository.prepareLegacyStaffMembership({
      organizationId: "organization-a",
      email: "invalid-email",
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "STAFF_MEMBERSHIP_INVALID_EMAIL");
      assert.equal(error.message, "Ingresa un correo electrónico válido.");
      return true;
    },
  );
  await assert.rejects(
    repository.prepareLegacyStaffMembership({
      organizationId: "",
      email: "member@example.com",
    }),
    (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.code, "STAFF_MEMBERSHIP_INVALID_ORGANIZATION");
      assert.equal(error.message, "La organización de destino es requerida.");
      return true;
    },
  );

  const nonexistent = await repository.prepareLegacyStaffMembership({
    organizationId: "organization-missing",
    email: "member@example.com",
  });
  assert.equal(nonexistent.ok, false);
  assert.equal(nonexistent.error.status, 400);
  assert.equal(
    nonexistent.error.code,
    "STAFF_MEMBERSHIP_INVALID_ORGANIZATION",
  );
  assert.equal(
    nonexistent.error.message,
    "La organización destino no existe.",
  );
  assert.equal(d1.batchCalls, 0);
  assert.equal(auditCount(), 0);
});

async function preparedUpdate(email, replacement) {
  return preparePlan({
    organizationId: "organization-a",
    email,
    displayName: "Member",
    role: "manager",
    status: "active",
    fieldIds: ["field-a-1"],
    now,
    idFactory: sequenceFactory(100),
    ...replacement,
  });
}

async function preparePlan(input) {
  const preparation = await repository.prepareLegacyStaffMembership(input);
  assert.equal(
    preparation.ok,
    true,
    preparation.ok ? undefined : preparation.error.message,
  );
  return preparation.plan;
}

function seedMembership({ id, email, displayName, role, status, fieldIds }) {
  sqlite.prepare(`
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    ) VALUES (?, 'organization-a', ?, ?, ?, ?, ?, 'seed@example.com',
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')
  `).run(id, email, email.toLowerCase(), displayName, role, status);
  for (const [index, fieldId] of fieldIds.entries()) {
    sqlite.prepare(`
      INSERT INTO membership_field_access (
        id, membership_id, field_id, created_by, created_at
      ) VALUES (?, ?, ?, 'seed@example.com', '2026-07-01T00:00:00.000Z')
    `).run(`seed-access-${id}-${index}`, id, fieldId);
  }
}

function membershipByEmail(email) {
  return sqlite.prepare(`
    SELECT * FROM organization_memberships
    WHERE organization_id = 'organization-a' AND normalized_email = ?
  `).get(email);
}

function scopeIds(membershipId) {
  return sqlite.prepare(`
    SELECT field_id FROM membership_field_access
    WHERE membership_id = ? ORDER BY field_id
  `).all(membershipId).map((row) => row.field_id);
}

function singleAudit() {
  const rows = sqlite.prepare("SELECT * FROM audit_log ORDER BY occurred_at, id").all();
  assert.equal(rows.length, 1);
  return rows[0];
}

function auditCount() {
  return Number(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log").get().count);
}

function sequenceFactory(start) {
  let value = start;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
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
    this.batchCalls = 0;
    this.beforeNextBatch = null;
    this.lastBatch = [];
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.lastBatch = statements;
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    await beforeBatch?.(statements);
    this.database.exec("BEGIN IMMEDIATE");
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
  }
}

const RELEVANT_SCHEMA = `
  CREATE TABLE auth_identities (
    id TEXT PRIMARY KEY NOT NULL,
    normalized_email TEXT NOT NULL
  );
  CREATE TABLE account_closure_requests (
    id TEXT PRIMARY KEY NOT NULL,
    scope TEXT NOT NULL,
    target_id TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE TABLE organizations (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL
  );
  CREATE TABLE fields (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL
  );
  CREATE TABLE app_state (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  CREATE TABLE organization_memberships (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    user_email TEXT NOT NULL,
    normalized_email TEXT NOT NULL,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('owner', 'admin', 'manager', 'operator', 'viewer')),
    status TEXT DEFAULT 'active' NOT NULL CHECK(status IN ('active', 'suspended')),
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  CREATE UNIQUE INDEX organization_memberships_email_unique
    ON organization_memberships (organization_id, normalized_email);
  CREATE UNIQUE INDEX organization_memberships_organization_id_unique
    ON organization_memberships (organization_id, id);
  CREATE TABLE membership_field_access (
    id TEXT PRIMARY KEY NOT NULL,
    membership_id TEXT NOT NULL REFERENCES organization_memberships(id) ON DELETE CASCADE,
    field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
    created_by TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  CREATE UNIQUE INDEX membership_field_access_unique
    ON membership_field_access (membership_id, field_id);
  CREATE TABLE audit_log (
    id TEXT PRIMARY KEY NOT NULL,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    field_id TEXT REFERENCES fields(id),
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before TEXT,
    after TEXT,
    source_record_id TEXT,
    occurred_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
  );
  CREATE TRIGGER organization_memberships_keep_active_owner_update
  BEFORE UPDATE OF role, status ON organization_memberships
  WHEN OLD.role = 'owner'
    AND OLD.status = 'active'
    AND (NEW.role <> 'owner' OR NEW.status <> 'active')
    AND NOT EXISTS (
      SELECT 1 FROM organization_memberships AS other
      WHERE other.organization_id = OLD.organization_id
        AND other.id <> OLD.id
        AND other.role = 'owner'
        AND other.status = 'active'
    )
  BEGIN
    SELECT RAISE(ABORT, 'LAST_ACTIVE_OWNER');
  END;
`;
