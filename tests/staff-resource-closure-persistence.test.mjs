import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const repositoryUrl = new URL(
  "../src/modules/staff/server/staff-resource-repository.ts",
  import.meta.url,
);
const markerKey = "platform-staff-v2-required";
const staffActor = {
  subject: "google:staff-subject",
  email: "Staff@Example.com",
};
const unscopedActor = {
  subject: "google:staff-no-memberships",
  email: "unscoped-staff@example.com",
};
const now = "2026-07-29T16:00:00.000Z";

let sqlite;
let d1;
let repository;

before(async () => {
  const source = await readFile(repositoryUrl, "utf8");
  const output = ts.transpileModule(source, {
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
          normalizeAccessEmail: (value) => String(value ?? "").trim().toLowerCase(),
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

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationNames = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrationNames) {
    const source = await readFile(path.join(root, "drizzle", name), "utf8");
    sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
  }
  seedBase(sqlite);
  d1 = new TestD1Database(sqlite);
});

afterEach(() => {
  sqlite.close();
});

test("workspace y auditoría se confirman en un único batch primary de tres statements", async () => {
  await repository.commitLegacyStaffWorkspace({
    actor: staffActor,
    staffCutoverMarkerKey: markerKey,
    workspaceId: "org-created",
    name: "Espacio creado",
    kind: "shared",
    now,
    auditId: "audit-workspace",
  });

  assert.equal(d1.batchCalls, 1);
  assert.deepEqual(d1.sessions, ["first-primary"]);
  assert.equal(d1.lastBatch.length, 3);
  assert.equal(d1.executedStatements, 3);
  assert.match(d1.lastBatch[2].sql, /abs\(-9223372036854775807 - 1\)/u);
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT id, name, kind, created_at
      FROM organizations WHERE id = 'org-created'
    `).get() },
    {
      id: "org-created",
      name: "Espacio creado",
      kind: "shared",
      created_at: now,
    },
  );
  const audit = sqlite.prepare(`
    SELECT organization_id, field_id, actor, action, entity_type, entity_id,
           before, after, occurred_at
    FROM audit_log WHERE id = 'audit-workspace'
  `).get();
  assert.equal(audit.organization_id, "org-created");
  assert.equal(audit.field_id, null);
  assert.equal(audit.actor, staffActor.email);
  assert.equal(audit.action, "organization.created");
  assert.equal(audit.entity_type, "organization");
  assert.equal(audit.entity_id, "org-created");
  assert.equal(audit.before, null);
  assert.deepEqual(JSON.parse(audit.after), {
    id: "org-created",
    name: "Espacio creado",
    kind: "shared",
  });
  assert.equal(audit.occurred_at, now);
});

test("un cierre de cuenta concurrente aborta antes del recurso y revierte la auditoría", async () => {
  d1.beforeNextBatch = () => seedAccountClosure(unscopedActor.subject);

  await assert.rejects(
    repository.commitLegacyStaffWorkspace({
      actor: unscopedActor,
      staffCutoverMarkerKey: markerKey,
      workspaceId: "org-blocked-account",
      name: "No debe existir",
      kind: "shared",
      now,
      auditId: "audit-blocked-account",
    }),
    (cause) => {
      assert.ok(cause instanceof repository.LegacyStaffResourceError);
      assert.equal(cause.code, "STAFF_RESOURCE_CONFLICT");
      assert.equal(cause.status, 409);
      return true;
    },
  );

  assert.equal(d1.batchCalls, 1);
  assert.equal(d1.executedStatements, 3);
  assert.equal(rowCount("organizations", "id = 'org-blocked-account'"), 0);
  assert.equal(rowCount("audit_log", "id = 'audit-blocked-account'"), 0);
});

test("un cierre organizacional bloquea fundo y feature flag dentro de sus batches", async () => {
  d1.beforeNextBatch = () => seedOrganizationClosure("org-a");

  await assert.rejects(
    repository.commitLegacyStaffField({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      fieldId: "field-blocked",
      organizationId: "org-a",
      expectedOrganizationKind: "shared",
      name: "Fundo bloqueado",
      location: "Osorno",
      now,
      auditId: "audit-field-blocked",
    }),
    repository.LegacyStaffResourceError,
  );
  assert.equal(rowCount("fields", "id = 'field-blocked'"), 0);
  assert.equal(rowCount("audit_log", "id = 'audit-field-blocked'"), 0);

  const before = featureSnapshot("flag-a");
  await assert.rejects(
    repository.commitLegacyStaffFeatureFlag({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      flagId: "flag-a",
      organizationId: "org-a",
      fieldId: null,
      feature: "analitica",
      enabled: true,
      previous: before,
      now,
      auditId: "audit-flag-blocked",
    }),
    repository.LegacyStaffResourceError,
  );
  assert.deepEqual(featureSnapshot("flag-a"), before);
  assert.equal(rowCount("audit_log", "id = 'audit-flag-blocked'"), 0);
});

test("el CAS de feature flags actualiza sólo la fila objetivo y conserva otra bandera", async () => {
  const targetBefore = featureSnapshot("flag-a");
  const unrelatedBefore = featureSnapshot("flag-other");

  await repository.commitLegacyStaffFeatureFlag({
    actor: staffActor,
    staffCutoverMarkerKey: markerKey,
    flagId: "flag-a",
    organizationId: "org-a",
    fieldId: null,
    feature: "analitica",
    enabled: true,
    previous: targetBefore,
    now,
    auditId: "audit-flag-success",
  });

  assert.equal(d1.lastBatch.length, 3);
  assert.deepEqual(featureSnapshot("flag-other"), unrelatedBefore);
  assert.deepEqual(featureSnapshot("flag-a"), {
    ...targetBefore,
    enabled: true,
    updatedBy: staffActor.email,
    updatedAt: now,
  });
  const audit = sqlite.prepare(`
    SELECT actor, action, before, after
    FROM audit_log WHERE id = 'audit-flag-success'
  `).get();
  assert.equal(audit.actor, staffActor.email);
  assert.equal(audit.action, "feature.enabled");
  assert.deepEqual(JSON.parse(audit.before), {
    feature: "analitica",
    fieldId: null,
    enabled: false,
  });
  assert.deepEqual(JSON.parse(audit.after), {
    feature: "analitica",
    fieldId: null,
    enabled: true,
  });
});

test("inserta una feature flag ausente con recibo exacto", async () => {
  await repository.commitLegacyStaffFeatureFlag({
    actor: staffActor,
    staffCutoverMarkerKey: markerKey,
    flagId: "flag-new",
    organizationId: "org-a",
    fieldId: null,
    feature: "benchmarking",
    enabled: true,
    previous: null,
    now,
    auditId: "audit-flag-insert",
  });

  assert.deepEqual(featureSnapshot("flag-new"), {
    id: "flag-new",
    organizationId: "org-a",
    fieldId: null,
    feature: "benchmarking",
    enabled: true,
    createdBy: staffActor.email,
    updatedBy: staffActor.email,
    createdAt: now,
    updatedAt: now,
  });
  assert.equal(rowCount("audit_log", "id = 'audit-flag-insert'"), 1);
});

test("un cambio concurrente del preimage preserva al ganador y no deja recibo", async () => {
  const previous = featureSnapshot("flag-a");
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      UPDATE organization_feature_flags
      SET enabled = 1, updated_by = 'winner@example.com',
          updated_at = '2026-07-29T15:59:59.000Z'
      WHERE id = 'flag-a'
    `).run();
  };

  await assert.rejects(
    repository.commitLegacyStaffFeatureFlag({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      flagId: "flag-a",
      organizationId: "org-a",
      fieldId: null,
      feature: "analitica",
      enabled: true,
      previous,
      now,
      auditId: "audit-flag-race",
    }),
    repository.LegacyStaffResourceError,
  );

  assert.deepEqual(featureSnapshot("flag-a"), {
    ...previous,
    enabled: true,
    updatedBy: "winner@example.com",
    updatedAt: "2026-07-29T15:59:59.000Z",
  });
  assert.equal(rowCount("audit_log", "id = 'audit-flag-race'"), 0);
});

test("un snapshot cruzado de feature flag falla antes del batch", async () => {
  const previous = featureSnapshot("flag-other");
  const previousBatchCalls = d1.batchCalls;
  await assert.rejects(
    repository.commitLegacyStaffFeatureFlag({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      flagId: "flag-a",
      organizationId: "org-a",
      fieldId: null,
      feature: "analitica",
      enabled: true,
      previous,
      now,
      auditId: "audit-crossed-snapshot",
    }),
    repository.LegacyStaffResourceError,
  );
  assert.equal(d1.batchCalls, previousBatchCalls);
  assert.equal(rowCount("audit_log", "id = 'audit-crossed-snapshot'"), 0);
  assert.deepEqual(featureSnapshot("flag-other"), previous);
});

test("crea un fundo exacto y falla cerrado si cambia el kind preleído", async () => {
  await repository.commitLegacyStaffField({
    actor: staffActor,
    staffCutoverMarkerKey: markerKey,
    fieldId: "field-success",
    organizationId: "org-a",
    expectedOrganizationKind: "shared",
    name: "Fundo exacto",
    location: "Purranque",
    now,
    auditId: "audit-field-success",
  });
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT id, organization_id, name, location, is_demo, created_at
      FROM fields WHERE id = 'field-success'
    `).get() },
    {
      id: "field-success",
      organization_id: "org-a",
      name: "Fundo exacto",
      location: "Purranque",
      is_demo: 0,
      created_at: now,
    },
  );

  d1.beforeNextBatch = () => {
    sqlite.prepare("UPDATE organizations SET kind = 'demo' WHERE id = 'org-a'").run();
  };
  await assert.rejects(
    repository.commitLegacyStaffField({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      fieldId: "field-kind-race",
      organizationId: "org-a",
      expectedOrganizationKind: "shared",
      name: "No debe existir",
      location: "",
      now,
      auditId: "audit-kind-race",
    }),
    repository.LegacyStaffResourceError,
  );
  assert.equal(rowCount("fields", "id = 'field-kind-race'"), 0);
  assert.equal(rowCount("audit_log", "id = 'audit-kind-race'"), 0);
});

test("un fallo de auditoría revierte el fundo insertado", async () => {
  sqlite.exec(`
    INSERT INTO audit_log (
      id, organization_id, actor, action, entity_type, entity_id, occurred_at
    ) VALUES (
      'audit-collision', 'org-a', 'seed@example.com', 'seeded',
      'seed', 'seed', '2026-07-29T00:00:00.000Z'
    );
  `);

  await assert.rejects(
    repository.commitLegacyStaffField({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      fieldId: "field-rolled-back",
      organizationId: "org-a",
      expectedOrganizationKind: "shared",
      name: "Fundo transitorio",
      location: "",
      now,
      auditId: "audit-collision",
    }),
    repository.LegacyStaffResourceError,
  );

  assert.equal(rowCount("fields", "id = 'field-rolled-back'"), 0);
  assert.equal(rowCount("audit_log", "id = 'audit-collision'"), 1);
});

test("cutover concurrente bloquea el batch y el actor dev exacto sigue operativo", async () => {
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      INSERT INTO app_state (key, value, updated_at) VALUES (?, '1', ?)
    `).run(markerKey, now);
  };
  await assert.rejects(
    repository.commitLegacyStaffWorkspace({
      actor: staffActor,
      staffCutoverMarkerKey: markerKey,
      workspaceId: "org-blocked-cutover",
      name: "Bloqueado",
      kind: "shared",
      now,
      auditId: "audit-blocked-cutover",
    }),
    repository.LegacyStaffResourceError,
  );
  assert.equal(rowCount("organizations", "id = 'org-blocked-cutover'"), 0);

  sqlite.prepare("DELETE FROM app_state WHERE key = ?").run(markerKey);
  await repository.commitLegacyStaffWorkspace({
    actor: {
      subject: "dev:local-staff@example.com",
      email: " Local-Staff@Example.com ",
    },
    staffCutoverMarkerKey: markerKey,
    workspaceId: "org-dev",
    name: "Local",
    kind: "personal",
    now,
    auditId: "audit-dev",
  });
  assert.equal(rowCount("organizations", "id = 'org-dev'"), 1);
  assert.equal(
    sqlite.prepare("SELECT actor FROM audit_log WHERE id = 'audit-dev'").get().actor,
    " Local-Staff@Example.com ",
  );
});

test("identidades inexistentes y actores dev malformados fallan cerrados", async () => {
  await assert.rejects(
    repository.commitLegacyStaffWorkspace({
      actor: {
        subject: "google:missing",
        email: "missing@example.com",
      },
      staffCutoverMarkerKey: markerKey,
      workspaceId: "org-missing-identity",
      name: "No debe existir",
      kind: "shared",
      now,
      auditId: "audit-missing-identity",
    }),
    repository.LegacyStaffResourceError,
  );
  assert.equal(rowCount("organizations", "id = 'org-missing-identity'"), 0);

  const previousBatchCalls = d1.batchCalls;
  for (const actor of [
    { subject: "dev:", email: "" },
    { subject: "dev:other@example.com", email: "local@example.com" },
    { subject: "", email: "staff@example.com" },
  ]) {
    await assert.rejects(
      repository.commitLegacyStaffWorkspace({
        actor,
        staffCutoverMarkerKey: markerKey,
        workspaceId: `org-invalid-${previousBatchCalls}`,
        name: "No debe existir",
        kind: "shared",
        now,
        auditId: `audit-invalid-${previousBatchCalls}`,
      }),
      repository.LegacyStaffResourceError,
    );
  }
  assert.equal(d1.batchCalls, previousBatchCalls);
});

function seedBase(database) {
  database.exec(`
    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES
      (
        'google:staff-subject', 'google', 'staff-subject', 'Staff@Example.com',
        'staff@example.com', 'Staff', 100, 100
      ),
      (
        'google:staff-no-memberships', 'google', 'staff-no-memberships',
        'unscoped-staff@example.com', 'unscoped-staff@example.com',
        'Unscoped staff', 100, 100
      );
    INSERT INTO organizations (id, name, kind, created_at)
    VALUES ('org-a', 'Organization A', 'shared', '2026-01-01T00:00:00.000Z');
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    ) VALUES (
      'membership-owner', 'org-a', 'Staff@Example.com', 'staff@example.com',
      'Staff', 'owner', 'active', 'system',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO organization_feature_flags (
      id, organization_id, field_id, feature, enabled,
      created_by, updated_by, created_at, updated_at
    ) VALUES
      (
        'flag-a', 'org-a', NULL, 'analitica', 0,
        'seed@example.com', 'seed@example.com',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      ),
      (
        'flag-other', 'org-a', NULL, 'trazabilidad', 1,
        'other@example.com', 'other@example.com',
        '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
      );
  `);
}

function seedAccountClosure(identityId) {
  sqlite.prepare(`
    INSERT INTO account_closure_requests (
      id, scope, target_id, actor_identity_id, request_id, status,
      requested_at, grace_ends_at, revoked_at, version,
      snapshot_version, snapshot_json
    ) VALUES (
      'closure-account', 'account', ?, ?, 'request-account', 'grace',
      '2026-07-29T00:00:00.000Z', '2026-08-28T00:00:00.000Z',
      NULL, 1, 1, ?
    )
  `).run(identityId, identityId, JSON.stringify({ memberships: [] }));
}

function seedOrganizationClosure(organizationId) {
  const snapshot = {
    memberships: [{
      id: "membership-owner",
      organizationId,
      role: "owner",
      status: "active",
      fieldIds: [],
    }],
  };
  sqlite.prepare(`
    INSERT INTO account_closure_requests (
      id, scope, target_id, actor_identity_id, request_id, status,
      requested_at, grace_ends_at, revoked_at, version,
      snapshot_version, snapshot_json
    ) VALUES (
      'closure-organization', 'organization', ?, ?, 'request-organization',
      'grace', '2026-07-29T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z', NULL, 1, 1, ?
    )
  `).run(
    organizationId,
    staffActor.subject,
    JSON.stringify(snapshot),
  );
}

function featureSnapshot(id) {
  const row = sqlite.prepare(`
    SELECT id, organization_id, field_id, feature, enabled, created_by,
           updated_by, created_at, updated_at
    FROM organization_feature_flags WHERE id = ?
  `).get(id);
  return {
    id: row.id,
    organizationId: row.organization_id,
    fieldId: row.field_id,
    feature: row.feature,
    enabled: Boolean(row.enabled),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowCount(table, condition) {
  return Number(
    sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${condition}`).get().count,
  );
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

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      results: [],
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
    this.executedStatements = 0;
    this.lastBatch = [];
    this.sessions = [];
    this.beforeNextBatch = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  withSession(mode) {
    this.sessions.push(mode);
    return this;
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.lastBatch = statements;
    this.executedStatements = 0;
    const beforeBatch = this.beforeNextBatch;
    this.beforeNextBatch = null;
    await beforeBatch?.(statements);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        this.executedStatements += 1;
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
