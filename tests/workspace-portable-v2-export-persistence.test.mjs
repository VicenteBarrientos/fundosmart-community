import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import ts from "typescript";
import * as portable from "../src/core/portability/workspace-portable-v2.mjs";
import * as projections from "../src/core/portability/workspace-portable-v2-projections.mjs";

const root = path.resolve(import.meta.dirname, "..");
const repositoryUrl = new URL(
  "../src/modules/account-lifecycle/server/workspace-export-repository.ts",
  import.meta.url,
);
const actor = {
  subject: "google:subject-owner",
  email: "Owner@Example.com",
};
const ownerAccess = {
  membershipId: "membership-owner",
  organizationId: "org-a",
  email: "owner@example.com",
  displayName: "Owner",
  role: "owner",
  fieldIds: ["field-a"],
};

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
        "@/app/auth-core.mjs": {
          normalizeAuthEmail: (value) => String(value ?? "").trim().toLowerCase(),
        },
        "@/src/core/portability/workspace-portable-v2.mjs": portable,
        "@/src/core/portability/workspace-portable-v2-projections.mjs": projections,
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
  seedWorkspace(sqlite);
  d1 = new TestD1Database(sqlite);
});

afterEach(() => {
  sqlite.close();
});

test("snapshot real obtiene las 33 secciones en un batch y produce un portable válido", async () => {
  const snapshot = await repository.loadPortableWorkspaceSnapshot(d1, {
    actor,
    access: ownerAccess,
  });

  assert.equal(d1.batchCalls, 1);
  assert.deepEqual(d1.sessions, ["first-primary"]);
  assert.equal(d1.lastBatch.length, 2 + portable.PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.length);
  assert.equal(d1.executedStatements, d1.lastBatch.length);
  assert.ok(
    new TextEncoder().encode(d1.lastBatch[0].sql).byteLength <= 100_000,
    "El preflight debe caber en el límite de 100 KB de un statement D1.",
  );
  assert.deepEqual(snapshot.organization, { id: "org-a", name: "Organización A" });
  assert.deepEqual(snapshot.fieldIds, ["field-a"]);
  assert.deepEqual(
    Object.keys(snapshot.sections),
    portable.PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
  );
  assert.equal(snapshot.sections.fields.length, 1);
  assert.equal(snapshot.sections.livestock_lots.length, 1);
  assert.equal(snapshot.sections.livestock_animals.length, 1);
  assert.equal(snapshot.sections.livestock_milk_controls.length, 1);
  assert.equal(
    snapshot.sections.livestock_milk_controls[0].__scope_source_record_valid,
    1,
  );
  assert.equal(snapshot.sections.import_jobs.length, 0);
  assert.equal(snapshot.sections.import_rows.length, 0);
  assert.equal(snapshot.sections.source_records.length, 0);
  assert.equal(snapshot.sections.audit_log.length, 0);
  for (const statement of d1.lastBatch) {
    assert.doesNotMatch(statement.sql, /\bSELECT\s+(?:root\.)?\*/iu);
    assertSqlFunctionArgumentLimit(statement.sql, "json_object", 32);
    assertSqlFunctionArgumentLimit(statement.sql, "json_array", 32);
    assert.doesNotMatch(
      statement.sql,
      /FROM fields AS current_field\s+WHERE current_field\.organization_id = \?\s+AND NOT EXISTS\s*\(\s*SELECT 1\s+FROM json_each/iu,
      "La igualdad de fundos no debe recorrer json_each por cada fila de fields.",
    );
    assert.match(
      statement.sql,
      /COUNT\(\*\) = COUNT\(\s*DISTINCT CASE\s+WHEN expected_field\.type = 'text'/iu,
      "La igualdad de fundos debe rechazar tipos inválidos y duplicados en una pasada lineal.",
    );
  }

  const workspace = await portable.createPortableWorkspaceV2({
    generatedAt: "2026-07-29T12:00:00.000Z",
    generatedBy: `identity-sha256:${"a".repeat(64)}`,
    organization: snapshot.organization,
    fieldIds: [...snapshot.fieldIds],
    sections: snapshot.sections,
  });
  const verified = await portable.validatePortableWorkspaceV2(workspace);
  assert.equal(verified.manifest.totalRecordCount, 4);

  let reauthorized = false;
  await repository.recordPortableWorkspaceExport(d1, {
    actor,
    access: ownerAccess,
    requestId: "export-success",
    generatedAt: "2026-07-29T12:00:00.000Z",
    organization: snapshot.organization,
    fieldIds: snapshot.fieldIds,
    filename: "fundosmart-organizacion-a-2026-07-29.portable-v2.json",
    workspaceSha256: verified.manifest.workspaceSha256,
    recordCounts: verified.manifest.recordCounts,
    totalRecordCount: verified.manifest.totalRecordCount,
    beforeCommit: async () => {
      reauthorized = true;
    },
    idFactory: () => "event-export-success",
  });

  assert.equal(reauthorized, true);
  assert.equal(d1.batchCalls, 2);
  assert.equal(d1.lastBatch.length, 2);
  for (const statement of d1.lastBatch) {
    assert.doesNotMatch(
      statement.sql,
      /field\.id NOT IN \(SELECT value FROM json_each/iu,
      "El recibo final no debe correlacionar fields contra json_each.",
    );
    assert.match(
      statement.sql,
      /COUNT\(\*\) = COUNT\(\s*DISTINCT CASE\s+WHEN expected_field\.type = 'text'/iu,
    );
  }
  const event = sqlite.prepare(`
    SELECT identity_id AS identityId, organization_id AS organizationId,
           request_id AS requestId, event_type AS eventType,
           entity_id AS entityId, payload_json AS payloadJson
    FROM personal_data_events
  `).get();
  assert.deepEqual(
    {
      identityId: event.identityId,
      organizationId: event.organizationId,
      requestId: event.requestId,
      eventType: event.eventType,
      entityId: event.entityId,
    },
    {
      identityId: actor.subject,
      organizationId: "org-a",
      requestId: "export-success",
      eventType: "workspace.exported",
      entityId: verified.manifest.workspaceSha256,
    },
  );
  assert.doesNotMatch(event.payloadJson, /owner@example\.com/iu);
  assert.equal(
    JSON.parse(event.payloadJson).workspaceSha256,
    verified.manifest.workspaceSha256,
  );
});

test("preflight sobreestima números JSON y reserva el envelope antes de materializar", async () => {
  sqlite.prepare(`
    UPDATE fields SET coordinates = ?
    WHERE id = 'field-a'
  `).run(JSON.stringify([
    1e20,
    0.000001,
    0.1,
    -1.9041082300000015e104,
  ]));
  sqlite.prepare(`
    INSERT INTO potreros (
      id, field_id, name, sector, area_hectares, coordinates
    ) VALUES (
      'potrero-null-chunk', 'field-a', 'Potrero nullable',
      'Norte', 1, '[]'
    )
  `).run();

  const snapshot = await repository.loadPortableWorkspaceSnapshot(d1, {
    actor,
    access: ownerAccess,
  });
  const workspace = await portable.createPortableWorkspaceV2({
    generatedAt: "2026-07-29T12:00:00.000Z",
    generatedBy: `identity-sha256:${"a".repeat(64)}`,
    organization: snapshot.organization,
    fieldIds: [...snapshot.fieldIds],
    sections: snapshot.sections,
  });
  const preflight = (await d1.lastBatch[0].all()).results[0];
  const dataBytes = new TextEncoder().encode(
    portable.canonicalPortableWorkspaceJson(workspace.data),
  ).byteLength;
  const workspaceBytes = new TextEncoder().encode(
    portable.canonicalPortableWorkspaceJson(workspace),
  ).byteLength;

  assert.ok(Number(preflight.canonicalBytes) >= dataBytes);
  assert.equal(
    Number(preflight.maxDataCanonicalBytes)
      + Number(preflight.envelopeReserveBytes),
    portable.PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES,
  );
  assert.ok(
    workspaceBytes - dataBytes <= Number(preflight.envelopeReserveBytes),
  );
  assert.match(d1.lastBatch[0].sql, /json_tree\(/u);
  assert.match(d1.lastBatch[0].sql, /json_array\(/u);
  assert.doesNotMatch(d1.lastBatch[0].sql, /json_patch\(/u);
  assert.match(d1.lastBatch[0].sql, /ELSE 24/u);
  assert.match(
    d1.lastBatch[0].sql,
    new RegExp(`LIMIT ${portable.PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS + 1}`, "u"),
  );
});

test("snapshot rechaza manager, batches truncados y secciones sobre el límite", async () => {
  sqlite.prepare(`
    UPDATE organization_memberships SET role = 'manager'
    WHERE id = 'membership-owner'
  `).run();
  await rejectsPersistence(
    () => repository.loadPortableWorkspaceSnapshot(d1, {
      actor,
      access: { ...ownerAccess, role: "manager" },
    }),
    "WORKSPACE_EXPORT_FORBIDDEN",
  );

  sqlite.prepare(`
    UPDATE organization_memberships SET role = 'owner'
    WHERE id = 'membership-owner'
  `).run();
  d1.resultTransform = (results) => results.slice(0, -1);
  await rejectsPersistence(
    () => repository.loadPortableWorkspaceSnapshot(d1, {
      actor,
      access: ownerAccess,
    }),
    "WORKSPACE_EXPORT_SNAPSHOT_INCOMPLETE",
  );

  d1.resultTransform = null;
  sqlite.exec(`
    WITH RECURSIVE sequence(value) AS (
      SELECT 1
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value <= 10000
    )
    INSERT INTO fields (id, organization_id, name, location, is_demo)
    SELECT printf('field-bulk-%05d', value), 'org-a',
           printf('Fundo %05d', value), '', 0
    FROM sequence
  `);
  const expandedFieldIds = sqlite.prepare(`
    SELECT id FROM fields
    WHERE organization_id = 'org-a'
    ORDER BY name
  `).all().map((row) => row.id);
  await rejectsPersistence(
    () => repository.loadPortableWorkspaceSnapshot(d1, {
      actor,
      access: { ...ownerAccess, fieldIds: expandedFieldIds },
    }),
    "WORKSPACE_EXPORT_SECTION_TOO_LARGE",
  );
  assert.equal(
    d1.executedStatements,
    1,
    "El preflight debe abortar antes de materializar metadata o secciones.",
  );
});

test("snapshot falla stale si cambia el conjunto de fundos antes del batch", async () => {
  d1.beforeBatch = () => {
    sqlite.prepare(`
      INSERT INTO fields (id, organization_id, name, location, is_demo)
      VALUES ('field-concurrent', 'org-a', 'Concurrente', '', 0)
    `).run();
  };
  await rejectsPersistence(
    () => repository.loadPortableWorkspaceSnapshot(d1, {
      actor,
      access: ownerAccess,
    }),
    "WORKSPACE_EXPORT_FORBIDDEN",
  );
  assert.match(d1.lastBatch[0].sql, /json_each\(/u);
  assert.match(d1.lastBatch[1].sql, /json_each\(/u);
});

for (const scenario of [
  {
    name: "resultado unsuccessful",
    corrupt: (result) => ({ ...result, success: false }),
  },
  {
    name: "results no-array",
    corrupt: (result) => ({ ...result, results: null }),
  },
]) {
  test(`snapshot rechaza ${scenario.name} en cualquier statement`, async () => {
    d1.resultTransform = (results) => {
      const corrupted = [...results];
      corrupted[7] = scenario.corrupt(corrupted[7]);
      return corrupted;
    };
    await rejectsPersistence(
      () => repository.loadPortableWorkspaceSnapshot(d1, {
        actor,
        access: ownerAccess,
      }),
      "WORKSPACE_EXPORT_SNAPSHOT_INCOMPLETE",
    );
  });
}

for (const scenario of [
  {
    name: "target_id no recíproco",
    mutate: (database) => database.prepare(`
      UPDATE source_records SET target_id = 'milk-control-other'
      WHERE id = 'source-survet'
    `).run(),
  },
  {
    name: "source_table distinto del job",
    mutate: (database) => database.prepare(`
      UPDATE source_records SET source_table = 'survet.other.xlsx.v1'
      WHERE id = 'source-survet'
    `).run(),
  },
  {
    name: "import_row perteneciente a otro job",
    mutate: (database) => database.prepare(`
      UPDATE source_records SET import_row_id = 'row-survet-other'
      WHERE id = 'source-survet'
    `).run(),
  },
]) {
  test(`el sentinel oculto rechaza linaje Survet con ${scenario.name}`, async () => {
    scenario.mutate(sqlite);
    const snapshot = await repository.loadPortableWorkspaceSnapshot(d1, {
      actor,
      access: ownerAccess,
    });
    assert.equal(
      snapshot.sections.livestock_milk_controls[0].__scope_source_record_valid,
      0,
    );
    await assert.rejects(
      portable.createPortableWorkspaceV2({
        generatedAt: "2026-07-29T12:00:00.000Z",
        generatedBy: `identity-sha256:${"a".repeat(64)}`,
        organization: snapshot.organization,
        fieldIds: [...snapshot.fieldIds],
        sections: snapshot.sections,
      }),
      (error) => {
        assert.ok(error instanceof portable.PortableWorkspaceV2Error);
        assert.equal(error.code, "INVALID_SCOPE_SENTINEL");
        return true;
      },
    );
  });
}

test("una fila organization/field cruzada se conserva para fallar cerrada", async () => {
  sqlite.exec(`
    INSERT INTO organizations (id, name, kind)
    VALUES ('org-b', 'Organización B', 'shared');
    INSERT INTO fields (id, organization_id, name, location, is_demo)
    VALUES ('field-b', 'org-b', 'Fundo B', '', 0);
    INSERT INTO field_external_identifiers (
      id, organization_id, field_id, source_system, kind, value, normalized_value
    ) VALUES (
      'external-crossed', 'org-a', 'field-b', 'cooprinsem',
      'field_code', 'B', 'b'
    );
  `);
  const snapshot = await repository.loadPortableWorkspaceSnapshot(d1, {
    actor,
    access: ownerAccess,
  });
  assert.equal(snapshot.sections.field_external_identifiers.length, 1);
  await assert.rejects(
    portable.createPortableWorkspaceV2({
      generatedAt: "2026-07-29T12:00:00.000Z",
      generatedBy: `identity-sha256:${"a".repeat(64)}`,
      organization: snapshot.organization,
      fieldIds: [...snapshot.fieldIds],
      sections: snapshot.sections,
    }),
    (error) => error instanceof portable.PortableWorkspaceV2Error,
  );
});

for (const scenario of [
  {
    name: "cambio de nombre",
    mutate: (database) =>
      database.prepare("UPDATE organizations SET name = 'Renombrada' WHERE id = 'org-a'").run(),
  },
  {
    name: "nuevo fundo",
    mutate: (database) =>
      database.prepare(`
        INSERT INTO fields (id, organization_id, name, location, is_demo)
        VALUES ('field-new', 'org-a', 'Nuevo', '', 0)
      `).run(),
  },
  {
    name: "pérdida de rol",
    mutate: (database) =>
      database.prepare(`
        UPDATE organization_memberships SET role = 'manager'
        WHERE id = 'membership-owner'
      `).run(),
  },
]) {
  test(`la auditoría revierte íntegramente ante ${scenario.name}`, async () => {
    d1.beforeBatch = () => scenario.mutate(sqlite);
    await rejectsPersistence(
      () => repository.recordPortableWorkspaceExport(
        d1,
        auditInput(`export-race-${scenario.name}`),
      ),
      "WORKSPACE_EXPORT_NOT_RECORDED",
    );
    assert.equal(eventCount(), 0);
  });
}

test("beforeCommit aborta antes del batch y no deja evento", async () => {
  const stopped = new Error("reauthorization changed");
  await assert.rejects(
    repository.recordPortableWorkspaceExport(d1, {
      ...auditInput("export-before-commit"),
      beforeCommit: async () => {
        throw stopped;
      },
    }),
    (error) => error === stopped,
  );
  assert.equal(d1.batchCalls, 0);
  assert.equal(eventCount(), 0);
});

function auditInput(requestId) {
  return {
    actor,
    access: ownerAccess,
    requestId,
    generatedAt: "2026-07-29T12:00:00.000Z",
    organization: { id: "org-a", name: "Organización A" },
    fieldIds: ["field-a"],
    filename: "fundosmart-organizacion-a-2026-07-29.portable-v2.json",
    workspaceSha256: "a".repeat(64),
    recordCounts: { fields: 1 },
    totalRecordCount: 1,
    idFactory: () => `event-${requestId}`,
  };
}

async function rejectsPersistence(operation, code) {
  await assert.rejects(operation, (error) => {
    assert.ok(error instanceof repository.WorkspaceExportPersistenceError);
    assert.equal(error.code, code);
    return true;
  });
}

function eventCount() {
  return Number(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM personal_data_events
  `).get().count);
}

function assertSqlFunctionArgumentLimit(sql, functionName, maximum) {
  const marker = `${functionName}(`;
  let searchFrom = 0;
  while (true) {
    const start = sql.indexOf(marker, searchFrom);
    if (start === -1) return;

    let depth = 1;
    let argumentsCount = 1;
    let quoted = false;
    let cursor = start + marker.length;
    for (; cursor < sql.length && depth > 0; cursor += 1) {
      const character = sql[cursor];
      if (quoted) {
        if (character === "'" && sql[cursor + 1] === "'") {
          cursor += 1;
        } else if (character === "'") {
          quoted = false;
        }
        continue;
      }
      if (character === "'") {
        quoted = true;
      } else if (character === "(") {
        depth += 1;
      } else if (character === ")") {
        depth -= 1;
      } else if (character === "," && depth === 1) {
        argumentsCount += 1;
      }
    }
    assert.equal(depth, 0, `${functionName} debe cerrar sus paréntesis.`);
    assert.ok(
      argumentsCount <= maximum,
      `${functionName} usa ${argumentsCount} argumentos; el máximo es ${maximum}.`,
    );
    searchFrom = cursor;
  }
}

function seedWorkspace(database) {
  database.exec(`
    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES (
      'google:subject-owner', 'google', 'subject-owner',
      'Owner@Example.com', 'owner@example.com', 'Owner', 100, 100
    );

    INSERT INTO organizations (id, name, kind)
    VALUES ('org-a', 'Organización A', 'shared');

    INSERT INTO fields (id, organization_id, name, location, is_demo)
    VALUES ('field-a', 'org-a', 'Fundo A', 'Osorno', 0);

    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    ) VALUES (
      'membership-owner', 'org-a', 'Owner@Example.com', 'owner@example.com',
      'Owner', 'owner', 'active', 'system',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    ), (
      'membership-coowner', 'org-a', 'coowner@example.com',
      'coowner@example.com', 'Co-owner', 'owner', 'active', 'system',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );

    INSERT INTO livestock_lots (
      id, field_id, name, category, animal_count, entry_date
    ) VALUES (
      'lot-survet', 'field-a', 'Lote Survet', 'dairy', 1, '2026-01-01'
    );

    INSERT INTO livestock_animals (id, lot_id, tag)
    VALUES ('animal-survet', 'lot-survet', 'SURVET-1');

    INSERT INTO import_jobs (
      id, organization_id, field_id, source_system, source_format,
      source_table, original_filename, file_size_bytes, object_key, sha256,
      mapping_version, requested_by
    ) VALUES (
      'job-survet', 'org-a', 'field-a', 'survet', 'xlsx',
      'survet.milk_control.xlsx.v1', 'survet.xlsx', 100,
      'imports/survet.xlsx', 'survet-sha', 'survet-v1', 'membership-owner'
    ), (
      'job-survet-other', 'org-a', 'field-a', 'survet', 'xlsx',
      'survet.other.xlsx.v1', 'survet-other.xlsx', 100,
      'imports/survet-other.xlsx', 'survet-other-sha', 'survet-v1',
      'membership-owner'
    );

    INSERT INTO import_rows (
      id, import_job_id, record_number, raw_record
    ) VALUES (
      'row-survet', 'job-survet', 1, '{}'
    ), (
      'row-survet-other', 'job-survet-other', 1, '{}'
    );

    INSERT INTO source_records (
      id, import_job_id, import_row_id, source_system, source_table,
      source_key, target_entity, target_id
    ) VALUES (
      'source-survet', 'job-survet', 'row-survet', 'survet',
      'survet.milk_control.xlsx.v1', 'SURVET-1',
      'livestock_milk_control', 'milk-control-survet'
    );

    INSERT INTO livestock_milk_controls (
      id, field_id, animal_id, control_date, total_liters, notes, source,
      source_record_id, created_by
    ) VALUES (
      'milk-control-survet', 'field-a', 'animal-survet', '2026-07-28',
      20.5, '', 'Survet', 'source-survet', 'membership-owner'
    );

    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id
    ) VALUES (
      'audit-survet', 'org-a', 'field-a', 'membership-owner',
      'import.confirmed', 'import_job', 'job-survet'
    );
  `);
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
    this.beforeBatch = null;
    this.resultTransform = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  withSession(mode) {
    this.sessions.push(mode);
    return this;
  }

  async batch(statements) {
    if (this.beforeBatch) this.beforeBatch(this.batchCalls + 1);
    this.batchCalls += 1;
    this.lastBatch = statements;
    this.executedStatements = 0;
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
      return this.resultTransform ? this.resultTransform(results) : results;
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
  }
}
