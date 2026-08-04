import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const actor = {
  membershipId: "trace-operator-a",
  organizationId: "trace-runtime-org-a",
  email: "trace-operator-a@example.com",
  displayName: "Trace Operator A",
  role: "operator",
  fieldIds: ["trace-runtime-field-a"],
};
const actorB = {
  membershipId: "trace-operator-b",
  organizationId: "trace-runtime-org-b",
  email: "trace-operator-b@example.com",
  displayName: "Trace Operator B",
  role: "operator",
  fieldIds: ["trace-runtime-field-b"],
};

let sqlite;
let vite;
let repository;
let bucket;
let d1;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.exec(`
    INSERT OR IGNORE INTO organizations (id, name) VALUES
      ('trace-runtime-org-a', 'Trace Runtime A'), ('trace-runtime-org-b', 'Trace Runtime B');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('trace-runtime-field-a', 'trace-runtime-org-a', 'Field A', 'Osorno', 0, 10, '[[-40.5,-73.2],[-40.5,-73.1],[-40.4,-73.1],[-40.5,-73.2]]'),
      ('trace-runtime-field-b', 'trace-runtime-org-b', 'Field B', 'Osorno', 0, 10, '[[-41.5,-74.2],[-41.5,-74.1],[-41.4,-74.1],[-41.5,-74.2]]');
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('trace-operator-a', 'trace-runtime-org-a', 'trace-operator-a@example.com', 'trace-operator-a@example.com', 'Operator A', 'operator', 'active', 'test'),
      ('trace-viewer-a', 'trace-runtime-org-a', 'trace-viewer-a@example.com', 'trace-viewer-a@example.com', 'Viewer A', 'viewer', 'active', 'test'),
      ('trace-operator-b', 'trace-runtime-org-b', 'trace-operator-b@example.com', 'trace-operator-b@example.com', 'Operator B', 'operator', 'active', 'test');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by) VALUES
      ('trace-access-a', 'trace-operator-a', 'trace-runtime-field-a', 'test'),
      ('trace-access-viewer-a', 'trace-viewer-a', 'trace-runtime-field-a', 'test'),
      ('trace-access-b', 'trace-operator-b', 'trace-runtime-field-b', 'test');
    INSERT INTO organization_feature_flags
      (id, organization_id, field_id, feature, enabled, created_by, updated_by)
    VALUES
      ('trace-feature-a', 'trace-runtime-org-a', 'trace-runtime-field-a', 'trazabilidad', 1, 'test', 'test'),
      ('trace-feature-b', 'trace-runtime-org-b', 'trace-runtime-field-b', 'trazabilidad', 1, 'test', 'test');
    INSERT INTO traceability_establishments
      (id, organization_id, field_id, rup, normalized_rup, kind, status,
       holder_rut, holder_name, commune, address, created_by)
    VALUES
      ('trace-runtime-est-a', 'trace-runtime-org-a', 'trace-runtime-field-a', '01.02.1234', '01.02.1234', 'dairy', 'active',
       '12.345.678-5', 'Agrícola A', 'Osorno', 'Camino A', 'test'),
      ('trace-runtime-est-b', 'trace-runtime-org-b', 'trace-runtime-field-b', '02.03.4321', '02.03.4321', 'dairy', 'active',
       '11.111.111-1', 'Agrícola B', 'Osorno', 'Camino B', 'test');
    INSERT INTO livestock_lots
      (id, field_id, name, category, animal_count, entry_date, status, tracking_mode)
    VALUES
      ('trace-runtime-lot-a', 'trace-runtime-field-a', 'Vacas A', 'dairy_cow', 2, '2026-01-01', 'active', 'individual'),
      ('trace-runtime-lot-b', 'trace-runtime-field-b', 'Vacas B', 'dairy_cow', 1, '2026-01-01', 'active', 'individual');
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status) VALUES
      ('trace-runtime-animal-a', 'trace-runtime-lot-a', '100000001', 'female', 'active'),
      ('trace-runtime-animal-a2', 'trace-runtime-lot-a', '100000002', 'female', 'active'),
      ('trace-runtime-animal-b', 'trace-runtime-lot-b', '200000001', 'female', 'active');
  `);
  bucket = new TestR2Bucket();
  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_TRACEABILITY_TEST_ENV__ = { DB: d1, FILES: bucket };
  const virtualWorkers = "\0fundosmart-traceability-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-traceability-cloudflare-workers",
      enforce: "pre",
      resolveId(id) { if (id === "cloudflare:workers") return virtualWorkers; },
      load(id) { if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_TRACEABILITY_TEST_ENV__"; },
    }],
  });
  repository = await vite.ssrLoadModule("/src/modules/trazabilidad/server/traceability-repository.ts");
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_TRACEABILITY_TEST_ENV__;
});

test("dashboard and writes revalidate current tenant, field, feature and persisted role", async () => {
  const dashboard = await repository.getTraceabilityDashboard(actor, "trace-runtime-field-a");
  assert.equal(dashboard.field.id, "trace-runtime-field-a");
  assert.equal(dashboard.devices.length, 0);
  await assert.rejects(
    repository.getTraceabilityDashboard(actor, "trace-runtime-field-b"),
    (error) => error.status === 404 && error.code === "FIELD_SCOPE_CONFLICT",
  );
  const forgedViewer = {
    ...actor,
    membershipId: "trace-viewer-a",
    email: "trace-viewer-a@example.com",
    role: "owner",
  };
  await assert.rejects(
    repository.addTraceabilityDiio(forgedViewer, {
      fieldId: "trace-runtime-field-a",
      officialNumber: "100000001",
      deviceType: "double_ear_tag",
      idempotencyKey: "diio:viewer-forgery",
    }),
    (error) => error.status === 422 || error.status === 409,
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_diios WHERE organization_id='trace-runtime-org-a'").get().count, 0);
});

test("DIIO lifecycle is atomic, idempotent and journaled", async () => {
  await repository.addTraceabilityDiio(actor, {
    fieldId: "trace-runtime-field-a",
    officialNumber: "100000001",
    deviceType: "double_ear_tag",
    idempotencyKey: "diio:create-runtime-a",
  });
  await repository.addTraceabilityDiio(actor, {
    fieldId: "trace-runtime-field-a",
    officialNumber: "100000001",
    deviceType: "double_ear_tag",
    idempotencyKey: "diio:create-runtime-a",
  });
  const device = sqlite.prepare("SELECT id FROM traceability_diios WHERE organization_id='trace-runtime-org-a'").get();
  assert.ok(device.id);
  await repository.transitionTraceabilityDiio(actor, {
    fieldId: "trace-runtime-field-a",
    deviceId: device.id,
    action: "assign",
    animalId: "trace-runtime-animal-a",
    occurredAt: "2026-07-21T14:00:00.000Z",
    idempotencyKey: "diio:assign-runtime-a",
  });
  await repository.transitionTraceabilityDiio(actor, {
    fieldId: "trace-runtime-field-a",
    deviceId: device.id,
    action: "assign",
    animalId: "trace-runtime-animal-a",
    occurredAt: "2026-07-21T14:00:00.000Z",
    idempotencyKey: "diio:assign-runtime-a",
  });
  assert.deepEqual({ ...sqlite.prepare("SELECT status, animal_id AS animalId, version FROM traceability_diios WHERE id=?").get(device.id) }, {
    status: "assigned", animalId: "trace-runtime-animal-a", version: 2,
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_events WHERE entity_id=?").get(device.id).count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_id=?").get(device.id).count, 2);
});

test("staged import keeps review separate from an idempotent commit", async () => {
  const staged = await repository.stageTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    sourceKind: "cliex_dbf",
    idempotencyKey: "import:stage:runtime-a2",
    rows: [{
      sourceRecordId: "cliex-row-2",
      rup: "01.02.1234",
      diio: "100000002",
      animal_id: "trace-runtime-animal-a2",
      tipo_dispositivo: "arete",
    }],
  });
  const stagedReplay = await repository.stageTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    sourceKind: "cliex_dbf",
    idempotencyKey: "import:stage:runtime-a2",
    rows: [{
      sourceRecordId: "cliex-row-2",
      rup: "01.02.1234",
      diio: "100000002",
      animal_id: "trace-runtime-animal-a2",
      tipo_dispositivo: "arete",
    }],
  });
  assert.deepEqual(stagedReplay, staged);
  assert.equal(staged.result.summary.accepted, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_diios WHERE animal_id='trace-runtime-animal-a2'").get().count, 0);
  const committed = await repository.commitTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    stageId: staged.stageId,
    idempotencyKey: "import:commit:runtime-a2",
  });
  const committedReplay = await repository.commitTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    stageId: staged.stageId,
    idempotencyKey: "import:commit:runtime-a2",
  });
  assert.deepEqual(committedReplay, committed);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_diios WHERE animal_id='trace-runtime-animal-a2'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT status FROM traceability_import_stages WHERE id=?").get(staged.stageId).status, "committed");
});

test("Cliex DBF bytes reuse Cooprinsem identifiers and remain staged before commit", async () => {
  sqlite.exec(`
    INSERT INTO livestock_animal_identifiers
      (id, field_id, animal_id, source_system, kind, value, normalized_value, is_primary)
    VALUES ('trace-cliex-id-a2', 'trace-runtime-field-a', 'trace-runtime-animal-a2',
      'cooprinsem', 'cooprinsem_numvaca', '22', '22', 1);
  `);
  const bytes = buildDbf([
    { name: "DIIO", type: "C", length: 9 },
    { name: "NUMVACA", type: "C", length: 10 },
  ], [{ DIIO: "100000002", NUMVACA: "22" }]);
  const staged = await repository.stageTraceabilityDbfImport(actor, {
    fieldId: "trace-runtime-field-a",
    filename: "Cliex-DIIO.dbf",
    bytes: bytes.buffer,
    idempotencyKey: "import:stage:runtime-dbf-a2",
  });
  assert.equal(staged.source.parser, "cooprinsem-dbf");
  assert.equal(staged.result.summary.unchanged, 1);
  assert.equal(staged.result.summary.accepted, 0);
  assert.equal(sqlite.prepare("SELECT status FROM traceability_import_stages WHERE id=?").get(staged.stageId).status, "staged");
});

test("SIPEC staging fails closed before persisting a stage or audit receipt", async () => {
  const stagesBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_import_stages").get().count;
  const auditsBefore = sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='traceability.import.staged'").get().count;
  await assert.rejects(repository.stageTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    sourceKind: "sipec_file",
    rows: [{ diio: "100000001" }],
    idempotencyKey: "import:stage:sipec-unavailable",
  }), (cause) => cause?.status === 409
    && cause?.code === "SIPEC_SPECIFICATION_UNAVAILABLE"
    && cause?.issues?.officiallySubmittable === false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_import_stages").get().count, stagesBefore);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='traceability.import.staged'").get().count, auditsBefore);
});

test("import idempotency keys reject collisions and converge when a concurrent writer wins", async () => {
  const firstStage = await repository.stageTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    sourceKind: "manual_template",
    idempotencyKey: "import:stage:collision-runtime",
    rows: [{ sourceRecordId: "invalid-stage-a", diio: "invalid", animal_id: "" }],
  });
  await assert.rejects(
    repository.stageTraceabilityImport(actor, {
      fieldId: "trace-runtime-field-a",
      sourceKind: "manual_template",
      idempotencyKey: "import:stage:collision-runtime",
      rows: [{ sourceRecordId: "invalid-stage-b", diio: "invalid", animal_id: "" }],
    }),
    (cause) => cause?.status === 409 && cause?.code === "IDEMPOTENCY_COLLISION",
  );

  const secondStage = await repository.stageTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    sourceKind: "manual_template",
    idempotencyKey: "import:stage:collision-runtime-2",
    rows: [{ sourceRecordId: "invalid-stage-b", diio: "invalid", animal_id: "" }],
  });
  const committed = await repository.commitTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    stageId: firstStage.stageId,
    idempotencyKey: "import:commit:collision-runtime",
  });
  await assert.rejects(
    repository.commitTraceabilityImport(actor, {
      fieldId: "trace-runtime-field-a",
      stageId: secondStage.stageId,
      idempotencyKey: "import:commit:collision-runtime",
    }),
    (cause) => cause?.status === 409 && cause?.code === "IDEMPOTENCY_COLLISION",
  );
  assert.equal(committed.accepted, 0);
  assert.equal(sqlite.prepare("SELECT status FROM traceability_import_stages WHERE id=?").get(secondStage.stageId).status, "staged");

  d1.beforeNextBatch = executeWinningBatch;
  const racedStage = await repository.stageTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    sourceKind: "manual_template",
    idempotencyKey: "import:stage:race-runtime",
    rows: [{ sourceRecordId: "invalid-stage-race", diio: "invalid", animal_id: "" }],
  });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_import_stages WHERE id=?").get(racedStage.stageId).count, 1);

  d1.beforeNextBatch = executeWinningBatch;
  const racedCommit = await repository.commitTraceabilityImport(actor, {
    fieldId: "trace-runtime-field-a",
    stageId: racedStage.stageId,
    idempotencyKey: "import:commit:race-runtime",
  });
  assert.equal(racedCommit.status, "committed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE id LIKE 'traceability:import:committed:audit:%' AND entity_id=?").get(racedStage.stageId).count, 1);
});

test("import idempotency ledgers are partitioned by tenant and field", async () => {
  const sharedIntent = {
    sourceKind: "manual_template",
    idempotencyKey: "import:stage:shared-cross-tenant",
    rows: [{ sourceRecordId: "same-source-id", diio: "invalid", animal_id: "" }],
  };
  const [stageA, stageB] = await Promise.all([
    repository.stageTraceabilityImport(actor, { ...sharedIntent, fieldId: "trace-runtime-field-a" }),
    repository.stageTraceabilityImport(actorB, { ...sharedIntent, fieldId: "trace-runtime-field-b" }),
  ]);
  assert.notEqual(stageA.stageId, stageB.stageId);
  assert.deepEqual(sqlite.prepare(`
    SELECT organization_id AS organizationId, field_id AS fieldId
    FROM traceability_import_stages WHERE id IN (?, ?) ORDER BY organization_id
  `).all(stageA.stageId, stageB.stageId).map((row) => ({ ...row })), [
    { organizationId: "trace-runtime-org-a", fieldId: "trace-runtime-field-a" },
    { organizationId: "trace-runtime-org-b", fieldId: "trace-runtime-field-b" },
  ]);
});

test("FMA is preserved once in R2 and a retry returns the same immutable draft", async () => {
  const input = {
    fieldId: "trace-runtime-field-a",
    animalIds: ["trace-runtime-animal-a"],
    idempotencyKey: "fma:runtime-one",
    movement: {
      destinationRup: "09.09.9999",
      destinationCommune: "Río Negro",
      destinationAddress: "Camino B",
      destinationPurpose: "domestic",
      departureDate: "2026-07-22",
      departureTime: "08:30",
      arrivalDate: "2026-07-22",
      arrivalTime: "10:00",
      carrierName: "Transportista Ficticio",
      carrierRut: "11.111.111-1",
      vehiclePlate: "ABCD12",
      declarations: { noQuarantine: true, noSymptoms: true, noActiveWithdrawal: true },
    },
  };
  const first = await repository.generateFmaDrafts(actor, input);
  const replay = await repository.generateFmaDrafts(actor, input);
  assert.equal(first.documents[0].id, replay.documents[0].id);
  assert.equal(bucket.objects.size, 1);
  const row = sqlite.prepare("SELECT * FROM traceability_movements WHERE organization_id='trace-runtime-org-a'").get();
  assert.equal(row.status, "draft");
  assert.equal(row.folio, null);
  assert.equal(row.document_status, "stored");
  const stored = bucket.objects.get(row.document_object_key);
  assert.equal(stored.customMetadata.organizationId, "trace-runtime-org-a");
  assert.equal(stored.customMetadata.fieldId, "trace-runtime-field-a");
  assert.equal(stored.customMetadata.state, "draft_not_declared");
  const downloaded = await repository.getTraceabilityDocument(actor, {
    fieldId: "trace-runtime-field-a",
    kind: "fma",
    documentId: row.id,
  });
  assert.equal(new TextDecoder("latin1").decode(downloaded.bytes.slice(0, 8)), "%PDF-1.7");

  const revokedDownloads = [
    {
      label: "suspension",
      revoke: () => sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id=?").run(actor.membershipId),
      restore: () => sqlite.prepare("UPDATE organization_memberships SET status='active' WHERE id=?").run(actor.membershipId),
    },
    {
      label: "scope removal",
      revoke: () => sqlite.prepare("DELETE FROM membership_field_access WHERE id='trace-access-a'").run(),
      restore: () => sqlite.prepare(`
        INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
        VALUES ('trace-access-a', 'trace-operator-a', 'trace-runtime-field-a', 'test')
      `).run(),
    },
    {
      label: "same-email replacement",
      revoke: () => sqlite.exec(`
        UPDATE organization_memberships
        SET status='suspended', normalized_email='trace-operator-a-replaced@example.com'
        WHERE id='trace-operator-a';
        INSERT INTO organization_memberships
          (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
        VALUES
          ('trace-operator-a-replacement', 'trace-runtime-org-a', 'trace-operator-a@example.com',
           'trace-operator-a@example.com', 'Replacement A', 'operator', 'active', 'test');
        INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
        VALUES ('trace-access-a-replacement', 'trace-operator-a-replacement', 'trace-runtime-field-a', 'test');
      `),
      restore: () => sqlite.exec(`
        DELETE FROM membership_field_access WHERE id='trace-access-a-replacement';
        DELETE FROM organization_memberships WHERE id='trace-operator-a-replacement';
        UPDATE organization_memberships
        SET status='active', normalized_email='trace-operator-a@example.com'
        WHERE id='trace-operator-a';
      `),
    },
    {
      label: "demo conversion",
      revoke: () => sqlite.prepare("UPDATE fields SET is_demo=1 WHERE id='trace-runtime-field-a'").run(),
      restore: () => sqlite.prepare("UPDATE fields SET is_demo=0 WHERE id='trace-runtime-field-a'").run(),
    },
  ];
  for (const scenario of revokedDownloads) {
    bucket.beforeGet = async () => {
      bucket.beforeGet = null;
      scenario.revoke();
    };
    try {
      await assert.rejects(
        repository.getTraceabilityDocument(actor, {
          fieldId: "trace-runtime-field-a",
          kind: "fma",
          documentId: row.id,
        }),
        (error) => error.status === 404 && error.code === "DOCUMENT_NOT_FOUND",
        scenario.label,
      );
    } finally {
      bucket.beforeGet = null;
      scenario.restore();
    }
  }
});

test("FMA issue, annulment and correction preserve folio, bytes and append-only journal", async () => {
  const movement = {
    destinationRup: "09.09.9999",
    destinationCommune: "Río Negro",
    destinationAddress: "Camino B",
    destinationPurpose: "domestic",
    departureDate: "2026-07-23",
    departureTime: "08:30",
    arrivalDate: "2026-07-23",
    arrivalTime: "10:00",
    carrierName: "Transportista Interno",
    carrierRut: "11.111.111-1",
    vehiclePlate: "EFGH34",
    declarations: { noQuarantine: true, noSymptoms: true, noActiveWithdrawal: true },
  };
  const input = {
    fieldId: "trace-runtime-field-a",
    animalIds: ["trace-runtime-animal-a"],
    idempotencyKey: "fma:issue-runtime-one",
    movement,
  };
  const first = await repository.issueFmaDocuments(actor, input);
  const replay = await repository.issueFmaDocuments(actor, input);
  assert.equal(first.documents[0].id, replay.documents[0].id);
  sqlite.prepare("UPDATE livestock_animals SET status='inactive' WHERE id='trace-runtime-animal-a'").run();
  const replayAfterInventoryChange = await repository.issueFmaDocuments(actor, input);
  sqlite.prepare("UPDATE livestock_animals SET status='active' WHERE id='trace-runtime-animal-a'").run();
  assert.equal(first.documents[0].id, replayAfterInventoryChange.documents[0].id);
  const issued = sqlite.prepare("SELECT * FROM traceability_movements WHERE request_hash=?").get(first.documents[0].requestHash);
  assert.equal(issued.status, "issued");
  assert.match(issued.folio, /^FS-FMA-[0-9A-F]{16}$/u);
  assert.equal(issued.version, 2);
  const immutable = {
    folio: issued.folio,
    objectKey: issued.document_object_key,
    sha256: issued.document_sha256,
    size: issued.document_size_bytes,
  };
  const stored = bucket.objects.get(issued.document_object_key);
  assert.equal(stored.customMetadata.state, "issued_internal_not_sag");
  const pdf = new TextDecoder("latin1").decode((await repository.getTraceabilityDocument(actor, {
    fieldId: "trace-runtime-field-a",
    kind: "fma",
    documentId: issued.id,
  })).bytes);
  assert.match(pdf, /EMITIDO INTERNO - NO SAG/u);
  assert.match(pdf, new RegExp(issued.folio, "u"));
  assert.throws(() => sqlite.prepare("UPDATE traceability_movements SET folio='ALTERADO' WHERE id=?").run(issued.id), /immutable|transition/u);

  await repository.annulFmaDocument(actor, {
    fieldId: "trace-runtime-field-a",
    documentId: issued.id,
    reason: "Destino digitado incorrectamente",
    idempotencyKey: "fma:annul-runtime-one",
    expectedVersion: 2,
  });
  await repository.annulFmaDocument(actor, {
    fieldId: "trace-runtime-field-a",
    documentId: issued.id,
    reason: "Destino digitado incorrectamente",
    idempotencyKey: "fma:annul-runtime-one",
    expectedVersion: 2,
  });
  const annulled = sqlite.prepare("SELECT * FROM traceability_movements WHERE id=?").get(issued.id);
  assert.equal(annulled.status, "annulled");
  assert.equal(annulled.version, 3);
  assert.deepEqual({ folio: annulled.folio, objectKey: annulled.document_object_key, sha256: annulled.document_sha256, size: annulled.document_size_bytes }, immutable);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_events WHERE entity_id=? AND type='fma.annulled'").get(issued.id).count, 1);
  assert.throws(() => sqlite.prepare("UPDATE traceability_movements SET annulment_reason='Otra' WHERE id=?").run(issued.id), /transition/u);

  const correction = await repository.issueFmaDocuments(actor, {
    ...input,
    idempotencyKey: "fma:correction-runtime-one",
    supersedesDocumentId: issued.id,
    movement: { ...movement, destinationRup: "08.08.8888" },
  });
  const corrected = sqlite.prepare("SELECT status, supersedes_movement_id AS supersedesMovementId FROM traceability_movements WHERE id=?").get(correction.documents[0].id);
  assert.deepEqual({ ...corrected }, { status: "issued", supersedesMovementId: issued.id });
});

test("demo mode cannot issue even an internal folio or create a stored object", async () => {
  const beforeRows = sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_movements").get().count;
  const beforeObjects = bucket.objects.size;
  sqlite.prepare("UPDATE fields SET is_demo=1 WHERE id='trace-runtime-field-a'").run();
  try {
    await assert.rejects(repository.issueFmaDocuments(actor, {
      fieldId: "trace-runtime-field-a",
      animalIds: ["trace-runtime-animal-a"],
      idempotencyKey: "fma:demo-forbidden",
      movement: {},
    }), (error) => error.status === 403 && error.code === "DEMO_WRITE_FORBIDDEN");
    await assert.rejects(repository.stageTraceabilityImport(actor, {
      fieldId: "trace-runtime-field-a",
      sourceKind: "manual_template",
      rows: [],
      idempotencyKey: "import:stage:demo-forbidden",
    }), (error) => error.status === 403 && error.code === "DEMO_WRITE_FORBIDDEN");
  } finally {
    sqlite.prepare("UPDATE fields SET is_demo=0 WHERE id='trace-runtime-field-a'").run();
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_movements").get().count, beforeRows);
  assert.equal(bucket.objects.size, beforeObjects);
});

test("DEA is derived from current inventory and preserved without an official folio", async () => {
  const first = await repository.generateDeaDraft(actor, {
    fieldId: "trace-runtime-field-a",
    period: 2026,
    asOfDate: "2026-06-30",
    idempotencyKey: "dea:runtime-2026",
  });
  const replay = await repository.generateDeaDraft(actor, {
    fieldId: "trace-runtime-field-a",
    period: 2026,
    asOfDate: "2026-06-30",
    idempotencyKey: "dea:runtime-2026",
  });
  assert.equal(first.document.id, replay.document.id);
  const row = sqlite.prepare("SELECT * FROM traceability_declarations WHERE organization_id='trace-runtime-org-a'").get();
  assert.equal(row.total_animals, 2);
  assert.deepEqual(JSON.parse(row.counts), { "bovine:cow": 2 });
  assert.equal(row.status, "draft");
  assert.equal(row.folio, null);
  assert.equal(row.document_status, "stored");
  assert.equal(bucket.objects.get(row.document_object_key).customMetadata.documentKind, "DEA");
});

test("reconciliation job expires stale stages and records a scoped observable result", async () => {
  sqlite.prepare(`
    INSERT INTO traceability_import_stages (
      id, organization_id, field_id, establishment_id, source_kind, canonical_stage,
      stage_hash, result, status, row_count, expires_at, created_by
    ) VALUES (
      'trace-expired-stage', 'trace-runtime-org-a', 'trace-runtime-field-a', 'trace-runtime-est-a',
      'manual_template', '{}', ?, '{}', 'staged', 0, '2026-07-20T00:00:00.000Z', 'test'
    )
  `).run("c".repeat(64));
  sqlite.prepare(`
    INSERT INTO traceability_movements (
      id, organization_id, field_id, establishment_id, origin_rup, destination_rup,
      departure_at, expected_arrival_at, carrier, carrier_rut, vehicle_plate, reason,
      status, form_version, request_hash, created_by, updated_by, created_at, updated_at
    ) VALUES (
      'trace-stale-fma', 'trace-runtime-org-a', 'trace-runtime-field-a', 'trace-runtime-est-a',
      '01.02.1234', '09.09.9999', '2025-01-01T08:00:00.000Z', '2025-01-01T10:00:00.000Z',
      'Transportista de prueba', '11.111.111-1', 'ABCD12', 'movement',
      'draft', 'internal-test-v1', ?, 'test', 'test', '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
    )
  `).run("e".repeat(64));
  sqlite.prepare(`
    INSERT INTO traceability_declarations (
      id, organization_id, field_id, establishment_id, period, revision, as_of_date,
      counts, total_animals, inventory_hash, request_hash, status, form_version,
      created_by, updated_by, created_at, updated_at
    ) VALUES (
      'trace-overdue-dea', 'trace-runtime-org-a', 'trace-runtime-field-a', 'trace-runtime-est-a',
      2025, 1, '2025-12-31', '{}', 0, ?, ?, 'draft', 'internal-test-v1',
      'test', 'test', '2025-12-31T00:00:00.000Z', '2025-12-31T00:00:00.000Z'
    )
  `).run("a".repeat(64), "b".repeat(64));
  await repository.runTraceabilityReconciliationJob({
    organizationId: "trace-runtime-org-a",
    fieldId: "trace-runtime-field-a",
    payload: { establishmentId: "trace-runtime-est-a" },
  });
  assert.equal(sqlite.prepare("SELECT status FROM traceability_import_stages WHERE id='trace-expired-stage'").get().status, "expired");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE type='traceability.reconciliation.completed.v1' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_events WHERE type='reconciliation.completed' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='traceability.reconciliation.completed' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_events WHERE type='reconciliation.completed' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  const scheduledState = JSON.parse(sqlite.prepare("SELECT payload FROM traceability_events WHERE type='reconciliation.completed' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().payload);
  assert.equal(scheduledState.schemaVersion, "fundosmart.traceability.reconciliation-state.v2");
  assert.deepEqual(scheduledState.fmaDrafts.staleIds, ["trace-stale-fma"]);
  assert.deepEqual(scheduledState.dea.overdueDraftIds, ["trace-overdue-dea"]);
  assert.equal(scheduledState.dea.officialDeadlineAssumed, false);
  assert.equal(scheduledState.dea.officiallySubmittable, false);
  const dashboard = await repository.getTraceabilityDashboard(actor, "trace-runtime-field-a");
  assert.equal(dashboard.reconciliation.lastScheduledState.schemaVersion, "fundosmart.traceability.reconciliation-state.v2");

  sqlite.exec(`
    INSERT INTO traceability_import_stages (
      id, organization_id, field_id, establishment_id, source_kind, canonical_stage,
      stage_hash, result, status, row_count, expires_at, created_by
    ) VALUES (
      'trace-disabled-stage', 'trace-runtime-org-a', 'trace-runtime-field-a', 'trace-runtime-est-a',
      'manual_template', '{}', '${"d".repeat(64)}', '{}', 'staged', 0, '2026-07-20T00:00:00.000Z', 'test'
    );
    UPDATE organization_feature_flags SET enabled=0 WHERE id='trace-feature-a';
  `);
  await repository.runTraceabilityReconciliationJob({
    organizationId: "trace-runtime-org-a",
    fieldId: "trace-runtime-field-a",
    payload: { establishmentId: "trace-runtime-est-a" },
  });
  assert.equal(sqlite.prepare("SELECT status FROM traceability_import_stages WHERE id='trace-disabled-stage'").get().status, "staged");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE type='traceability.reconciliation.completed.v1' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  sqlite.prepare("UPDATE organization_feature_flags SET enabled=1 WHERE id='trace-feature-a'").run();

  sqlite.prepare("UPDATE traceability_import_stages SET status='staged' WHERE id='trace-disabled-stage'").run();
  d1.beforeNextBatch = () => {
    sqlite.prepare("UPDATE organization_feature_flags SET enabled=0 WHERE id='trace-feature-a'").run();
  };
  await repository.runTraceabilityReconciliationJob({
    organizationId: "trace-runtime-org-a",
    fieldId: "trace-runtime-field-a",
    payload: { establishmentId: "trace-runtime-est-a" },
  });
  assert.equal(sqlite.prepare("SELECT status FROM traceability_import_stages WHERE id='trace-disabled-stage'").get().status, "staged");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM domain_events WHERE type='traceability.reconciliation.completed.v1' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='traceability.reconciliation.completed' AND organization_id='trace-runtime-org-a' AND field_id='trace-runtime-field-a'").get().count, 1);
  sqlite.prepare("UPDATE organization_feature_flags SET enabled=1 WHERE id='trace-feature-a'").run();
});

test("establishment writes replay exactly and reject idempotency collisions", async () => {
  sqlite.exec(`
    INSERT INTO potreros (id, field_id, name, sector, area_hectares, coordinates)
    VALUES
      ('trace-georef-paddock-a', 'trace-runtime-field-a', 'A activo', 'A', 2,
        '{"outer":[[-40.49,-73.19],[-40.49,-73.18],[-40.48,-73.18],[-40.49,-73.19]],"holes":[]}'),
      ('trace-georef-paddock-b', 'trace-runtime-field-b', 'B ajeno', 'B', 2,
        '[[-41.49,-74.19],[-41.49,-74.18],[-41.48,-74.18],[-41.49,-74.19]]'),
      ('trace-georef-paddock-archived', 'trace-runtime-field-a', 'A archivado', 'A', 2,
        '[[-40.47,-73.17],[-40.47,-73.16],[-40.46,-73.16],[-40.47,-73.17]]');
    UPDATE potreros SET archived_at='2026-01-01T00:00:00.000Z'
    WHERE id='trace-georef-paddock-archived';
  `);
  const input = {
    fieldId: "trace-runtime-field-a",
    rup: "01.02.1234",
    kind: "dairy",
    holderRut: "12.345.678-5",
    holderName: "Agrícola A",
    commune: "Osorno",
    address: "Camino A actualizado",
    idempotencyKey: "establishment:runtime:one",
    georef: { source: "untrusted-client", fieldId: "trace-runtime-field-b" },
  };
  await repository.saveTraceabilityEstablishment(actor, input);
  await repository.saveTraceabilityEstablishment(actor, input);
  assert.equal(sqlite.prepare("SELECT version FROM traceability_establishments WHERE id='trace-runtime-est-a'").get().version, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='traceability.establishment.saved' AND entity_id='trace-runtime-est-a'").get().count, 1);
  const georef = JSON.parse(sqlite.prepare("SELECT georef FROM traceability_establishments WHERE id='trace-runtime-est-a'").get().georef);
  assert.equal(georef.schemaVersion, "fundosmart.traceability.establishment-georef.v1");
  assert.equal(georef.source, "authorized_field_and_active_paddocks");
  assert.deepEqual(georef.fieldBoundary, [[-40.5, -73.2], [-40.5, -73.1], [-40.4, -73.1], [-40.5, -73.2]]);
  assert.deepEqual(georef.activePaddocks.map((paddock) => paddock.id), ["trace-georef-paddock-a"]);
  await assert.rejects(
    repository.saveTraceabilityEstablishment(actor, { ...input, address: "Otro camino" }),
    (cause) => cause?.status === 409 && cause?.code === "IDEMPOTENCY_COLLISION",
  );

  d1.beforeNextBatch = (statements) => {
    const [auditId, organizationId, fieldId, actorEmail, entityId, before, after, occurredAt] = statements[0].bindings;
    const conflictingAfter = { ...JSON.parse(after), requestHash: "f".repeat(64) };
    sqlite.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at
      ) VALUES (?, ?, ?, ?, 'traceability.establishment.saved', 'traceability_establishment', ?, ?, ?, ?)
    `).run(auditId, organizationId, fieldId, actorEmail, entityId, before, JSON.stringify(conflictingAfter), occurredAt);
  };
  await assert.rejects(
    repository.saveTraceabilityEstablishment(actor, {
      ...input,
      address: "Camino de carrera",
      idempotencyKey: "establishment:runtime:concurrent-collision",
    }),
    (cause) => cause?.status === 409 && cause?.code === "IDEMPOTENCY_COLLISION",
  );
});

test("real establishments fail closed when no authorized field or paddock geometry exists", async () => {
  sqlite.exec(`
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates)
    VALUES ('trace-runtime-field-no-geometry', 'trace-runtime-org-a', 'Sin geometría', 'Osorno', 0, 1, '[]');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by)
    VALUES ('trace-access-no-geometry', 'trace-operator-a', 'trace-runtime-field-no-geometry', 'test');
    INSERT INTO organization_feature_flags
      (id, organization_id, field_id, feature, enabled, created_by, updated_by)
    VALUES ('trace-feature-no-geometry', 'trace-runtime-org-a', 'trace-runtime-field-no-geometry', 'trazabilidad', 1, 'test', 'test');
  `);
  await assert.rejects(repository.saveTraceabilityEstablishment(actor, {
    fieldId: "trace-runtime-field-no-geometry",
    rup: "03.04.5678",
    kind: "dairy",
    holderRut: "12.345.678-5",
    holderName: "Agrícola sin geometría",
    commune: "Osorno",
    address: "Camino sin geometría",
    idempotencyKey: "establishment:no-geometry",
  }), (cause) => cause?.status === 422 && cause?.code === "ESTABLISHMENT_GEOREF_REQUIRED");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM traceability_establishments WHERE field_id='trace-runtime-field-no-geometry'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE field_id='trace-runtime-field-no-geometry'").get().count, 0);
});

async function executeWinningBatch(statements) {
  sqlite.exec("BEGIN");
  try {
    for (const statement of statements) {
      if (/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/iu.test(statement.sql)) sqlite.prepare(statement.sql).all(...statement.bindings);
      else sqlite.prepare(statement.sql).run(...statement.bindings);
    }
    sqlite.exec("COMMIT");
  } catch (cause) {
    sqlite.exec("ROLLBACK");
    throw cause;
  }
}

function buildDbf(fieldDefinitions, records) {
  const encoder = new TextEncoder();
  const headerLength = 32 + fieldDefinitions.length * 32 + 1;
  const recordLength = 1 + fieldDefinitions.reduce((total, field) => total + field.length, 0);
  const bytes = new Uint8Array(headerLength + recordLength * records.length + 1);
  const view = new DataView(bytes.buffer);
  bytes.fill(0x20);
  bytes[0] = 0x30;
  view.setUint32(4, records.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  fieldDefinitions.forEach((field, index) => {
    const offset = 32 + index * 32;
    bytes.fill(0, offset, offset + 32);
    bytes.set(encoder.encode(field.name).subarray(0, 11), offset);
    bytes[offset + 11] = field.type.charCodeAt(0);
    bytes[offset + 16] = field.length;
  });
  bytes[headerLength - 1] = 0x0d;
  records.forEach((record, recordIndex) => {
    const rowOffset = headerLength + recordIndex * recordLength;
    bytes[rowOffset] = 0x20;
    let fieldOffset = rowOffset + 1;
    for (const field of fieldDefinitions) {
      bytes.set(encoder.encode(String(record[field.name] ?? "").padEnd(field.length, " ").slice(0, field.length)), fieldOffset);
      fieldOffset += field.length;
    }
  });
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

class TestR2Bucket {
  constructor() { this.objects = new Map(); this.beforeGet = null; }
  async put(key, bytes, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const storedBytes = Uint8Array.from(new Uint8Array(bytes));
    const httpEtag = `"trace-${storedBytes.byteLength}"`;
    this.objects.set(key, {
      bytes: storedBytes,
      customMetadata: { ...(options.customMetadata ?? {}) },
      checksums: options.sha256 ? { sha256: Uint8Array.from(Buffer.from(String(options.sha256), "hex")).buffer } : {},
      httpEtag,
    });
    return { httpEtag };
  }
  async head(key) {
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata }, checksums: { ...stored.checksums }, httpEtag: stored.httpEtag } : null;
  }
  async get(key) {
    if (this.beforeGet) await this.beforeGet(key);
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata }, checksums: { ...stored.checksums }, httpEtag: stored.httpEtag, arrayBuffer: async () => stored.bytes.slice().buffer } : null;
  }
}

class TestD1PreparedStatement {
  constructor(database, sql, bindings = []) { this.database = database; this.sql = sql; this.bindings = bindings; }
  bind(...bindings) { return new TestD1PreparedStatement(this.database, this.sql, bindings); }
  async all() { return { results: this.database.prepare(this.sql).all(...this.bindings), success: true, meta: {} }; }
  async first(column) { const row = this.database.prepare(this.sql).get(...this.bindings) ?? null; return column && row ? row[column] ?? null : row; }
  async raw(options = {}) { const statement = this.database.prepare(this.sql); statement.setReturnArrays(true); const rows = statement.all(...this.bindings); return options.columnNames ? [statement.columns().map((column) => column.name), ...rows] : rows; }
  async run() { const result = this.database.prepare(this.sql).run(...this.bindings); return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; }
}

class TestD1Database {
  constructor(database) { this.database = database; this.beforeNextBatch = null; }
  prepare(sql) { return new TestD1PreparedStatement(this.database, sql); }
  async batch(statements) {
    if (this.beforeNextBatch) {
      const hook = this.beforeNextBatch;
      this.beforeNextBatch = null;
      await hook(statements);
    }
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/iu.test(statement.sql) ? await statement.all() : await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
  }
}
