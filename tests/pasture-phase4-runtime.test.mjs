import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const managerA = {
  membershipId: "pasture-manager-a",
  organizationId: "pasture-org-a",
  email: "manager-a@example.com",
  displayName: "Manager A",
  role: "manager",
  fieldIds: ["pasture-field-a"],
};
const managerB = {
  membershipId: "pasture-manager-b",
  organizationId: "pasture-org-b",
  email: "manager-b@example.com",
  displayName: "Manager B",
  role: "manager",
  fieldIds: ["pasture-field-b"],
};

let sqlite;
let vite;
let repository;
let ndviConnector;
let paddockNdviRepository;
let files;
let d1;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle"))).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  seedPastureRuntime(sqlite);
  files = new TestR2Bucket();
  d1 = new TestD1Database(sqlite);
  globalThis.__FUNDOSMART_PASTURE_TEST_ENV__ = { DB: d1, FILES: files };
  const virtualWorkers = "\0fundosmart-pasture-cloudflare-workers";
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-pasture-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) return "export const env = globalThis.__FUNDOSMART_PASTURE_TEST_ENV__";
      },
    }],
  });
  repository = await vite.ssrLoadModule("/src/modules/praderas/server/pasture-repository.ts");
  ndviConnector = await vite.ssrLoadModule("/src/modules/praderas/server/ndvi-connector.ts");
  paddockNdviRepository = await vite.ssrLoadModule("/src/modules/potreros/server/paddock-ndvi-repository.ts");
});

after(async () => {
  await vite?.close();
  sqlite?.close();
  delete globalThis.__FUNDOSMART_PASTURE_TEST_ENV__;
});

test("deriva demanda, ración, costos F3 y demo sintética sin tocar R2 ni inventar unidades", async () => {
  const dashboard = await repository.getPastureDashboard("pasture-field-a", managerA);
  assert.equal(dashboard.planningBasis.status, "available");
  assert.equal(dashboard.planningBasis.animalCount, 10);
  assert.equal(dashboard.planningBasis.weightedAverageLiveWeightKg, 500);
  assert.equal(dashboard.planningBasis.dailyDemandKgDm, 150);
  assert.equal(dashboard.planningBasis.supplement.dailyQuantityKgAsFed, 20);
  assert.equal(dashboard.planningBasis.supplement.projectedDailyCostClp, 8_000);
  assert.equal(dashboard.planningBasis.economics.feedCostClp, 200_000);
  assert.equal(dashboard.planningBasis.economics.iofcClp, 1_800_000);
  assert.deepEqual(dashboard.planningBasis.rotationContext.settings, { recentDays: 12, longRestDays: 30, version: 1 });
  assert.deepEqual(dashboard.planningBasis.rotationContext.activeCellsByPaddock, { "pasture-paddock-a": 1 });
  assert.deepEqual(dashboard.planningBasis.rotationContext.activeCellIdsByPaddock, {
    "pasture-paddock-a": [{ id: "pasture-cell-a", name: "Franja 1" }],
  });
  assert.deepEqual(dashboard.planningBasis.paddockBudgets.map((budget) => ({
    paddockId: budget.paddockId,
    availableKgDm: budget.availableKgDm,
    herdDailyDemandKgDm: budget.herdDailyDemandKgDm,
  })), [
    { paddockId: "pasture-paddock-a", availableKgDm: null, herdDailyDemandKgDm: 150 },
    { paddockId: "pasture-paddock-b", availableKgDm: null, herdDailyDemandKgDm: 150 },
  ]);
  assert.equal(dashboard.planningBasis.evidence.demandUnit, "kg_dm_per_day");
  assert.equal(dashboard.planningBasis.evidence.supplementUnit, "kg_as_fed_per_day");
  assert.equal(dashboard.syntheticNdviSamples.length, 2);
  assert.equal(dashboard.syntheticNdviSamples[0].operational, false);
  assert.equal(files.size, 0, "la muestra demo se genera en lectura y no usa R2");

  await assert.rejects(
    repository.getPastureDashboard("pasture-field-b", managerA),
    (cause) => cause?.code === "FIELD_SCOPE_CONFLICT",
  );
  const otherTenant = await repository.getPastureDashboard("pasture-field-b", managerB);
  assert.equal(otherTenant.planningBasis.status, "unavailable");
  assert.match(otherTenant.planningBasis.statusReason, /Falta peso vivo/u);
  assert.equal(otherTenant.planningBasis.economics.status, "unavailable");

  sqlite.prepare("DELETE FROM livestock_feed_inventory WHERE id='pasture-feed-a'").run();
  const incompleteCost = await repository.getPastureDashboard("pasture-field-a", managerA);
  assert.equal(incompleteCost.planningBasis.supplement.status, "partial");
  assert.equal(incompleteCost.planningBasis.supplement.projectedDailyCostClp, null);
  assert.match(incompleteCost.planningBasis.supplement.statusReason, /sin costo unitario/u);
  sqlite.prepare(`
    INSERT INTO livestock_feed_inventory
      (id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg)
    VALUES ('pasture-feed-a', 'pasture-field-a', 'Concentrado', 1000, 400, 100)
  `).run();
});

test("persiste evidencia real D1/R2 bajo tenant y nunca usa la muestra demo en oferta", async () => {
  const result = await repository.recordManualPastureObservation({
    operationId: "runtime-manual-a",
    fieldId: "pasture-field-a",
    paddockId: "pasture-paddock-a",
    capturedAt: "2026-07-20T12:00:00.000Z",
    measurement: { sampleKind: "direct", kgDmPerHectare: 2_400 },
    notes: "corte runtime",
  }, managerA);
  assert.equal(result.idempotentReplay, false);
  assert.equal(result.objectKey, `praderas/${managerA.organizationId}/pasture-field-a/raw/${result.id}.json`);
  assert.equal(files.size, 1);
  const object = await files.head(result.objectKey);
  assert.equal(object.customMetadata.organizationId, managerA.organizationId);
  assert.equal(object.customMetadata.fieldId, "pasture-field-a");
  assert.equal(sqlite.prepare("SELECT storage_status FROM pasture_raw_observations WHERE id=?").get(result.id).storage_status, "stored");
  assert.equal(sqlite.prepare("SELECT kg_dm_per_hectare FROM pasture_biomass_estimates WHERE raw_observation_id=?").get(result.id).kg_dm_per_hectare, 2_400);

  const replay = await repository.recordManualPastureObservation({
    operationId: "runtime-manual-a",
    fieldId: "pasture-field-a",
    paddockId: "pasture-paddock-a",
    capturedAt: "2026-07-20T12:00:00.000Z",
    measurement: { sampleKind: "direct", kgDmPerHectare: 2_400 },
    notes: "corte runtime",
  }, managerA);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(files.size, 1);

  const dashboard = await repository.getPastureDashboard("pasture-field-a", managerA);
  assert.equal(dashboard.planningBasis.totalSupplyKgDm, 2_880);
  assert.equal(dashboard.planningBasis.availableDays, 19.2);
  assert.equal(dashboard.growthRates.find((rate) => rate.paddockId === "pasture-paddock-a").status, "insufficient_data");
  assert.equal(dashboard.syntheticNdviSamples[0].indicativeKgDmPerHectare > 0, true);
  assert.notEqual(dashboard.planningBasis.totalSupplyKgDm, dashboard.syntheticNdviSamples[0].indicativeKgDmPerHectare);

  await repository.recordManualPastureObservation({
    operationId: "runtime-manual-a-later",
    fieldId: "pasture-field-a",
    paddockId: "pasture-paddock-a",
    capturedAt: "2026-07-22T12:00:00.000Z",
    measurement: { sampleKind: "direct", kgDmPerHectare: 2_600 },
  }, managerA);
  const growth = (await repository.getPastureDashboard("pasture-field-a", managerA)).growthRates
    .find((rate) => rate.paddockId === "pasture-paddock-a");
  assert.equal(growth.status, "available");
  assert.equal(growth.elapsedDays, 2);
  assert.equal(growth.kgDmPerHaPerDay, 100);

  await assert.rejects(
    repository.recordManualPastureObservation({
      operationId: "runtime-cross-tenant",
      fieldId: "pasture-field-b",
      paddockId: "pasture-paddock-b",
      capturedAt: "2026-07-20T12:00:00.000Z",
      measurement: { sampleKind: "direct", kgDmPerHectare: 2_400 },
    }, managerA),
    (cause) => cause?.code === "FIELD_SCOPE_CONFLICT",
  );
  assert.equal(files.size, 2, "un tenant ajeno no alcanza una escritura R2");
});

test("NDVI revalidates provider and calibration after the external fetch", async () => {
  sqlite.exec(`
    INSERT INTO pasture_provider_decisions (
      id, organization_id, field_id, mode, provider_key, decided_by, decided_at
    ) VALUES (
      'runtime-provider-decision', 'pasture-org-a', 'pasture-field-a', 'configured',
      'runtime-provider', 'test', '2026-07-22T13:00:00.000Z'
    ) ON CONFLICT(organization_id, field_id) DO UPDATE SET
      mode=excluded.mode, provider_key=excluded.provider_key,
      decided_by=excluded.decided_by, decided_at=excluded.decided_at;
    INSERT INTO pasture_ndvi_calibrations (
      id, organization_id, field_id, provider_key, slope_kg_dm_per_ha,
      intercept_kg_dm_per_ha, min_ndvi, max_ndvi, status, valid_from, created_by
    ) VALUES (
      'runtime-calibration', 'pasture-org-a', 'pasture-field-a', 'runtime-provider',
      2000, 500, 0, 1, 'active', '2026-07-01T00:00:00.000Z', 'test'
    );
  `);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT mode, provider_key AS providerKey FROM pasture_provider_decisions WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'").get() },
    { mode: "configured", providerKey: "runtime-provider" },
  );
  assert.equal(sqlite.prepare("SELECT status FROM pasture_ndvi_calibrations WHERE id='runtime-calibration'").get()?.status, "active");
  assert.equal(sqlite.prepare("SELECT status FROM organization_memberships WHERE id='pasture-manager-a'").get()?.status, "active");
  const beforeObjects = files.size;
  files.afterPut = () => sqlite.prepare(`
    UPDATE pasture_provider_decisions SET mode='unconfigured', provider_key=NULL
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
  `).run();
  await assert.rejects(
    repository.recordNdviPastureObservation({
      operationId: "runtime-ndvi-revoked",
      fieldId: "pasture-field-a",
      paddockId: "pasture-paddock-a",
      capturedAt: "2026-07-22T13:00:00.000Z",
      providerKey: "runtime-provider",
      meanNdvi: 0.55,
      usablePixelPercent: 90,
      rawDocument: { provider: "runtime-provider", meanNdvi: 0.55 },
    }, {
      id: "runtime-calibration",
      providerKey: "runtime-provider",
      slopeKgDmPerHa: 2000,
      interceptKgDmPerHa: 500,
      minNdvi: 0,
      maxNdvi: 1,
    }, managerA),
    (cause) => cause?.code === "FIELD_SCOPE_CONFLICT",
  );
  files.afterPut = null;
  assert.equal(files.size, beforeObjects, "la evidencia revocada se compensa en R2");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pasture_raw_observations WHERE operation_id='runtime-ndvi-revoked'").get().count, 0);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pasture_biomass_estimates WHERE calibration_id='runtime-calibration'").get().count, 0);
});

test("cleanup never deletes R2 evidence that a concurrent request already finalized", async () => {
  sqlite.exec(`
    UPDATE pasture_provider_decisions
    SET mode='configured', provider_key='runtime-provider', decided_at='2026-07-22T14:00:00.000Z'
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a';
  `);
  assert.deepEqual(
    { ...sqlite.prepare("SELECT mode, provider_key AS providerKey FROM pasture_provider_decisions WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'").get() },
    { mode: "configured", providerKey: "runtime-provider" },
  );
  assert.equal(sqlite.prepare("SELECT status FROM pasture_ndvi_calibrations WHERE id='runtime-calibration'").get()?.status, "active");
  assert.equal(sqlite.prepare("SELECT status FROM organization_memberships WHERE id='pasture-manager-a'").get()?.status, "active");
  const beforeObjects = files.size;
  let storedObjectKey = null;
  files.afterPut = (objectKey) => {
    storedObjectKey = objectKey;
    d1.beforeNextBatch = () => {
      const raw = sqlite.prepare(`
        SELECT id, paddock_id AS paddockId FROM pasture_raw_observations
        WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
          AND operation_id='runtime-ndvi-concurrent-finalize'
      `).get();
      sqlite.prepare(`
        INSERT INTO pasture_biomass_estimates (
          id, organization_id, field_id, paddock_id, raw_observation_id, method,
          kg_dm_per_hectare, calibration_id, evidence_json, computed_at, created_by
        ) VALUES (?, 'pasture-org-a', 'pasture-field-a', ?, ?, 'ndvi_linear_calibration', 1600,
          'runtime-calibration', '{}', '2026-07-22T14:00:01.000Z', 'concurrent-test')
      `).run(`concurrent-estimate-${raw.id}`, raw.paddockId, raw.id);
      const stored = sqlite.prepare(`
        UPDATE pasture_raw_observations
        SET etag='"concurrent-etag"', storage_status='stored', stored_at='2026-07-22T14:00:01.000Z'
        WHERE id=? AND storage_status='pending'
      `).run(raw.id);
      assert.equal(Number(stored.changes), 1);
      sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id='pasture-manager-a'").run();
    };
  };
  let rejection = null;
  try {
    await repository.recordNdviPastureObservation({
      operationId: "runtime-ndvi-concurrent-finalize",
      fieldId: "pasture-field-a",
      paddockId: "pasture-paddock-a",
      capturedAt: "2026-07-22T14:00:00.000Z",
      providerKey: "runtime-provider",
      meanNdvi: 0.55,
      usablePixelPercent: 90,
      rawDocument: { provider: "runtime-provider", meanNdvi: 0.55 },
    }, {
      id: "runtime-calibration",
      providerKey: "runtime-provider",
      slopeKgDmPerHa: 2000,
      interceptKgDmPerHa: 500,
      minNdvi: 0,
      maxNdvi: 1,
    }, managerA);
  } catch (cause) {
    rejection = cause;
  }
  assert.equal(rejection?.code, "FIELD_SCOPE_CONFLICT");
  files.afterPut = null;
  sqlite.prepare("UPDATE organization_memberships SET status='active' WHERE id='pasture-manager-a'").run();
  assert.ok(storedObjectKey);
  const raw = sqlite.prepare(`
    SELECT id, operation_id AS operationId, storage_status AS storageStatus
    FROM pasture_raw_observations WHERE object_key=?
  `).get(storedObjectKey);
  assert.equal(raw.storageStatus, "stored");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM pasture_biomass_estimates WHERE raw_observation_id=?").get(raw.id).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='pasture.observation.cleanup_reserved' AND entity_id=?").get(raw.id).count, 0);
  assert.equal(files.size, beforeObjects + 1);
  assert.ok(storedObjectKey && files.objects.has(storedObjectKey));
});

test("el adaptador CDSE conserva JSON estadístico y el job reautoriza antes de persistir", async () => {
  sqlite.exec(`
    UPDATE fields SET is_demo=0 WHERE id='pasture-field-a';
    UPDATE pasture_provider_decisions
    SET mode='configured', provider_key='cdse-sentinel-2', decided_at='2026-07-22T15:00:00.000Z'
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a';
    UPDATE pasture_ndvi_calibrations
    SET provider_key='cdse-sentinel-2', status='active'
    WHERE id='runtime-calibration';
  `);
  let fetchCount = 0;
  const cdseConnector = ndviConnector.createCdsePastureNdviConnector(managerA, {
    clientId: "client-id",
    clientSecret: "client-secret",
  }, {
    listCandidates: (fieldId, actor) => paddockNdviRepository.listPaddockNdviCandidates(fieldId, actor),
    createClient: () => ({
      fetchNdvi: async () => {
        fetchCount += 1;
        return ({
        status: "ok",
        meanNdvi: 0.55,
        cloudPct: 12.5,
        cloudPctMethod: "no_data_fraction",
        cloudPctIsApproximate: true,
        observedAt: "2026-06-20T00:00:00.000Z",
        interval: { from: "2026-06-01T00:00:00.000Z", to: "2026-07-01T00:00:00.000Z" },
        sampleCount: 100,
        noDataCount: 12,
        validSampleCount: 88,
        });
      },
    }),
  });
  const canonical = await cdseConnector.fetchPaddockObservation({
    organizationId: "pasture-org-a",
    fieldId: "pasture-field-a",
    paddockId: "pasture-paddock-a",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-07-01T00:00:00.000Z",
  });
  assert.equal(canonical.usablePixelPercent, 87.5);
  assert.equal(canonical.rawDocument.contentKind, "statistics_json");
  assert.equal(canonical.rawDocument.rasterObject, null);
  await assert.rejects(
    cdseConnector.fetchPaddockObservation({
      organizationId: "pasture-org-a",
      fieldId: "pasture-field-a",
      paddockId: "pasture-paddock-a",
      from: "2026-06-01T00:00:00.000Z",
      to: "2026-07-01T00:00:00.000Z",
      expectedGeometrySnapshotToken: "geometry-v2",
    }),
    (cause) => cause?.code === "FIELD_SCOPE_CONFLICT",
  );
  assert.equal(fetchCount, 1, "una geometría obsoleta falla antes de consultar CDSE");

  const queue = await repository.enqueuePastureNdviCollection("pasture-field-a", managerA, {
    now: new Date("2026-07-22T15:00:00.000Z"),
  });
  assert.equal(queue.jobIds.length, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM scheduled_jobs WHERE type='pasture.ndvi.collect.v1'").get().count, 2);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='pasture.ndvi.collection.enqueued'").get().count, 1);

  const job = {
    id: queue.jobIds.find((id) => id.endsWith(":pasture-paddock-a")),
    organizationId: "pasture-org-a",
    fieldId: "pasture-field-a",
    type: "pasture.ndvi.collect.v1",
    payload: { membershipId: "pasture-manager-a", paddockId: "pasture-paddock-a" },
    status: "active",
    dueAt: queue.dueAt,
    intervalSeconds: 86400,
    attemptCount: 0,
  };
  const completed = await ndviConnector.runPastureNdviCollectionJob(
    job,
    { clientId: "unused", clientSecret: "unused" },
    { now: new Date("2026-07-22T15:00:00.000Z"), connector: cdseConnector },
  );
  assert.equal(completed.status, "stored");
  const raw = JSON.parse(new TextDecoder().decode(files.objects.get(completed.observation.objectKey).bytes));
  assert.equal(raw.contentKind, "statistics_json");
  assert.equal(raw.rasterObject, null);
  const replay = await ndviConnector.runPastureNdviCollectionJob(
    job,
    { clientId: "unused", clientSecret: "unused" },
    { now: new Date("2026-07-22T15:00:00.000Z"), connector: cdseConnector },
  );
  assert.equal(replay.observation.idempotentReplay, true);
  assert.equal(fetchCount, 2, "la repetición mensual no vuelve a consultar CDSE");

  sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id='pasture-manager-a'").run();
  await assert.rejects(
    ndviConnector.runPastureNdviCollectionJob(job, { clientId: "unused", clientSecret: "unused" }, {
      now: new Date("2026-07-22T15:00:00.000Z"),
      connector: cdseConnector,
    }),
    /PASTURE_NDVI_JOB_SCOPE_REVOKED/u,
  );
  sqlite.exec(`
    UPDATE organization_memberships SET status='active' WHERE id='pasture-manager-a';
    UPDATE fields SET is_demo=1 WHERE id='pasture-field-a';
  `);
});

test("enqueue NDVI conserva leases vigentes, revierte el lote y permite reintentar tras expirar", async () => {
  sqlite.exec(`
    UPDATE fields SET is_demo=0 WHERE id='pasture-field-a';
    UPDATE pasture_provider_decisions
    SET mode='configured', provider_key='cdse-sentinel-2', decided_at='2026-07-22T16:00:00.000Z'
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a';
    UPDATE pasture_ndvi_calibrations
    SET provider_key='cdse-sentinel-2', status='active'
    WHERE id='runtime-calibration';
  `);
  const jobA = "pasture-ndvi:pasture-org-a:pasture-field-a:pasture-paddock-a";
  const jobB = "pasture-ndvi:pasture-org-a:pasture-field-a:pasture-paddock-b";
  sqlite.prepare(`
    UPDATE scheduled_jobs
    SET payload='{"schemaVersion":"original-a","membershipId":"runner-a"}',
      due_at='2026-07-22T16:00:00.000Z', lease_owner='runner-a',
      lease_expires_at='2026-07-22T18:00:00.000Z', attempt_count=3,
      last_error_type='TRANSIENT', updated_at='2026-07-22T16:00:00.000Z'
    WHERE id=?
  `).run(jobA);
  sqlite.prepare(`
    UPDATE scheduled_jobs
    SET payload='{"schemaVersion":"original-b","membershipId":"runner-b"}',
      due_at='2026-07-22T16:05:00.000Z', lease_owner=NULL,
      lease_expires_at=NULL, attempt_count=7, last_error_type='RETRYABLE',
      updated_at='2026-07-22T16:05:00.000Z'
    WHERE id=?
  `).run(jobB);
  const beforeConflict = scheduledNdviJobs();
  const auditsBeforeConflict = sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log WHERE action='pasture.ndvi.collection.enqueued'
  `).get().count;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      repository.enqueuePastureNdviCollection("pasture-field-a", managerA, {
        now: new Date("2026-07-22T17:00:00.000Z"),
      }),
      (cause) => cause?.code === "PASTURE_NDVI_COLLECTION_IN_PROGRESS",
    );
    assert.deepEqual(scheduledNdviJobs(), beforeConflict, "el lote mixto debe revertirse completo en cada retry");
  }
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log WHERE action='pasture.ndvi.collection.enqueued'
  `).get().count, auditsBeforeConflict, "un conflicto no deja auditoría parcial");

  const secondRunnerClaim = sqlite.prepare(`
    UPDATE scheduled_jobs
    SET lease_owner='runner-b', lease_expires_at='2026-07-22T18:30:00.000Z'
    WHERE id=? AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
  `).run(jobA, "2026-07-22T17:00:00.000Z");
  assert.equal(Number(secondRunnerClaim.changes), 0, "un segundo runner no roba el lease vigente");
  const originalRunnerFinish = sqlite.prepare(`
    UPDATE scheduled_jobs
    SET due_at='2026-07-23T16:00:00.000Z', lease_owner=NULL, lease_expires_at=NULL,
      attempt_count=0, last_error_type=NULL, updated_at='2026-07-22T17:01:00.000Z'
    WHERE id=? AND lease_owner='runner-a'
  `).run(jobA);
  assert.equal(Number(originalRunnerFinish.changes), 1, "el runner original conserva su CAS tras el conflicto");

  sqlite.prepare(`
    UPDATE scheduled_jobs
    SET payload='{"schemaVersion":"expired","membershipId":"runner-expired"}',
      due_at='2026-07-22T16:00:00.000Z', lease_owner='runner-expired',
      lease_expires_at='2026-07-22T16:59:59.999Z', attempt_count=4,
      last_error_type='TRANSIENT', updated_at='2026-07-22T16:00:00.000Z'
    WHERE id=?
  `).run(jobA);
  const queued = await repository.enqueuePastureNdviCollection("pasture-field-a", managerA, {
    now: new Date("2026-07-22T17:00:00.000Z"),
  });
  assert.deepEqual(queued.jobIds, [jobA, jobB]);
  for (const row of scheduledNdviJobs()) {
    const payload = JSON.parse(row.payload);
    assert.equal(payload.membershipId, managerA.membershipId);
    assert.equal(payload.requestedBy, managerA.email);
    assert.equal(row.dueAt, queued.dueAt);
    assert.equal(row.leaseOwner, null);
    assert.equal(row.leaseExpiresAt, null);
    assert.equal(row.attemptCount, 0);
    assert.equal(row.lastErrorType, null);
  }

  const replay = await repository.enqueuePastureNdviCollection("pasture-field-a", managerA, {
    now: new Date("2026-07-22T17:00:00.000Z"),
  });
  assert.deepEqual(replay, queued);
  assert.equal(scheduledNdviJobs().length, 2, "el retry reutiliza las identidades deterministas");
  sqlite.prepare("UPDATE fields SET is_demo=1 WHERE id='pasture-field-a'").run();
});

test("el INSERT atómico rechaza mismo potrero con otro rebaño y mismo rebaño en otro potrero", async () => {
  const basis = (await repository.getPastureDashboard("pasture-field-a", managerA)).planningBasis;
  assert.ok(basis.herdId);

  insertExistingPlan({
    id: "persisted-other-herd",
    operationId: "persisted-other-herd-op",
    herdId: "another-herd",
    paddockId: "pasture-paddock-a",
  });
  await assert.rejects(
    repository.createPastureRotationPlan(planRequest("runtime-plan-paddock-overlap"), managerA),
    (cause) => cause?.code === "PASTURE_ROTATION_OVERLAP",
  );
  sqlite.prepare("DELETE FROM pasture_rotation_plans WHERE id='persisted-other-herd'").run();

  insertExistingPlan({
    id: "persisted-same-herd",
    operationId: "persisted-same-herd-op",
    herdId: basis.herdId,
    paddockId: "pasture-paddock-b",
  });
  await assert.rejects(
    repository.createPastureRotationPlan(planRequest("runtime-plan-herd-overlap"), managerA),
    (cause) => cause?.code === "PASTURE_ROTATION_OVERLAP",
  );
  sqlite.prepare("DELETE FROM pasture_rotation_plans WHERE id='persisted-same-herd'").run();

  const created = await repository.createPastureRotationPlan({
    ...planRequest("runtime-plan-authoritative"),
    herd: { id: "browser-herd", animalCount: 999_999, averageLiveWeightKg: 1, intakePercentLiveWeight: 9 },
    paddocks: [{ id: "foreign", currentKgDmPerHectare: 9_999_999 }],
  }, managerA);
  assert.equal(created.plan.dailyDemandKgDm, 150);
  assert.equal(created.plan.planningEvidence.basis.animalCount, 10);
  assert.equal(JSON.stringify(created.plan).includes("demo.synthetic"), false);
  const persisted = sqlite.prepare("SELECT input_snapshot_json, plan_json FROM pasture_rotation_plans WHERE id=?").get(created.id);
  assert.equal(persisted.input_snapshot_json.includes("browser-herd"), false);
  assert.equal(persisted.input_snapshot_json.includes("999999"), false);
  assert.equal(persisted.plan_json.includes("demo.synthetic"), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action='pasture.rotation.created' AND entity_id=?").get(created.id).count, 1);
});

test("el código mantiene la colisión dentro de la misma sentencia de inserción", async () => {
  const source = await readFile(path.join(root, "src/modules/praderas/server/pasture-repository.ts"), "utf8");
  assert.match(source, /INSERT INTO pasture_rotation_plans[\s\S]*NOT EXISTS \([\s\S]*json_each\(existing_plan\.plan_json, '\$\.visits'\)[\s\S]*json_each\(\?, '\$\.visits'\)/u);
  assert.match(source, /existing_plan\.herd_id = \?[\s\S]*json_extract\(existing_visit\.value, '\$\.paddockId'\) = json_extract\(requested_visit\.value, '\$\.paddockId'\)/u);
  assert.match(source, /json_extract\(existing_visit\.value, '\$\.startsOn'\) < json_extract\(requested_visit\.value, '\$\.endsOn'\)/u);
});

test("no_data mensual se reproduce sin CDSE/R2 y no cachea fallos ni degrada evidencia positiva", async () => {
  sqlite.exec(`
    UPDATE fields SET is_demo=0 WHERE id='pasture-field-a';
    UPDATE pasture_provider_decisions
    SET mode='configured', provider_key='cdse-sentinel-2', decided_at='2026-07-22T16:00:00.000Z'
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a';
    UPDATE pasture_ndvi_calibrations
    SET provider_key='cdse-sentinel-2', status='active'
    WHERE id='runtime-calibration';
  `);
  const job = collectionJob("pasture-paddock-a", "no-data-replay");
  const beforeObjects = files.size;
  let noDataFetches = 0;
  const noDataConnector = {
    providerKey: "cdse-sentinel-2",
    async fetchPaddockObservation(request) {
      noDataFetches += 1;
      return {
        status: "no_data",
        reason: "no_intervals",
        observedAt: null,
        interval: { from: request.from, to: request.to },
        sampleCount: 0,
        noDataCount: 0,
        validSampleCount: 0,
      };
    },
  };
  const juneNow = new Date("2026-07-22T16:00:00.000Z");
  const first = await ndviConnector.runPastureNdviCollectionJob(
    job,
    { clientId: "unused", clientSecret: "unused" },
    { now: juneNow, connector: noDataConnector },
  );
  assert.equal(first.status, "no_data");
  assert.equal(first.idempotentReplay, false);
  assert.equal(first.noData.month, "2026-06-01");
  assert.equal(first.noData.reason, "no_intervals");
  assert.equal(files.size, beforeObjects, "no_data no fabrica evidencia R2");
  const firstRow = sqlite.prepare(`
    SELECT id, status, geometry_snapshot_token AS geometryToken
    FROM paddock_ndvi
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
      AND paddock_id='pasture-paddock-a' AND month='2026-06-01'
  `).get();
  assert.deepEqual({ id: firstRow.id, status: firstRow.status }, { id: first.noData.id, status: "no_data" });
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action='pasture.ndvi.no_data.stored' AND entity_id=?
  `).get(first.noData.id).count, 1);

  const replay = await ndviConnector.runPastureNdviCollectionJob(
    job,
    { clientId: "unused", clientSecret: "unused" },
    { now: juneNow, connector: noDataConnector },
  );
  assert.equal(replay.status, "no_data");
  assert.equal(replay.idempotentReplay, true);
  assert.equal(replay.noData.id, first.noData.id);
  assert.equal(replay.noData.geometrySnapshotToken, first.noData.geometrySnapshotToken);
  assert.equal(noDataFetches, 1, "el replay exacto no consulta CDSE");
  assert.equal(files.size, beforeObjects);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action='pasture.ndvi.no_data.stored' AND entity_id=?
  `).get(first.noData.id).count, 1, "el replay conserva el rastro durable original");

  sqlite.prepare(`
    UPDATE pasture_provider_decisions SET mode='unconfigured', provider_key=NULL
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
  `).run();
  await assert.rejects(
    ndviConnector.runPastureNdviCollectionJob(job, {}, { now: juneNow, connector: noDataConnector }),
    (cause) => cause?.code === "NDVI_PROVIDER_UNCONFIGURED",
  );
  sqlite.prepare(`
    UPDATE pasture_provider_decisions SET mode='configured', provider_key='cdse-sentinel-2'
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
  `).run();
  sqlite.prepare("UPDATE pasture_ndvi_calibrations SET status='retired' WHERE id='runtime-calibration'").run();
  await assert.rejects(
    ndviConnector.runPastureNdviCollectionJob(job, {}, { now: juneNow, connector: noDataConnector }),
    (cause) => cause?.code === "NDVI_CALIBRATION_REQUIRED",
  );
  sqlite.prepare("UPDATE pasture_ndvi_calibrations SET status='active' WHERE id='runtime-calibration'").run();
  assert.equal(noDataFetches, 1, "la configuración revocada falla antes de CDSE");

  const originalCoordinates = sqlite.prepare("SELECT coordinates FROM potreros WHERE id='pasture-paddock-a'").get().coordinates;
  sqlite.prepare("UPDATE potreros SET coordinates=? WHERE id='pasture-paddock-a'").run(
    JSON.stringify([[-40, -73], [-40, -72.985], [-39.985, -72.985], [-39.985, -73]]),
  );
  const changedGeometry = await ndviConnector.runPastureNdviCollectionJob(
    job,
    {},
    { now: juneNow, connector: noDataConnector },
  );
  assert.equal(changedGeometry.idempotentReplay, false);
  assert.notEqual(changedGeometry.noData.geometrySnapshotToken, firstRow.geometryToken);
  assert.equal(noDataFetches, 2, "una geometría distinta habilita una consulta nueva");

  const changedMonth = await ndviConnector.runPastureNdviCollectionJob(
    job,
    {},
    { now: new Date("2026-08-22T16:00:00.000Z"), connector: noDataConnector },
  );
  assert.equal(changedMonth.noData.month, "2026-07-01");
  assert.equal(changedMonth.idempotentReplay, false);
  assert.equal(noDataFetches, 3, "un mes distinto habilita una consulta nueva");
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM paddock_ndvi
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
      AND paddock_id='pasture-paddock-a' AND status='no_data'
  `).get().count, 2);

  let transientFetches = 0;
  const transientConnector = {
    providerKey: "cdse-sentinel-2",
    async fetchPaddockObservation() {
      transientFetches += 1;
      throw new Error("CDSE_UNAVAILABLE");
    },
  };
  const transientJob = collectionJob("pasture-paddock-b", "transient");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(
      ndviConnector.runPastureNdviCollectionJob(transientJob, {}, {
        now: new Date("2026-09-22T16:00:00.000Z"),
        connector: transientConnector,
      }),
      /CDSE_UNAVAILABLE/u,
    );
  }
  assert.equal(transientFetches, 2, "los fallos transitorios no se convierten en replay");
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM paddock_ndvi
    WHERE paddock_id='pasture-paddock-b' AND month='2026-08-01'
  `).get().count, 0);

  let revokedFetches = 0;
  const revokedConnector = {
    providerKey: "cdse-sentinel-2",
    async fetchPaddockObservation(request) {
      revokedFetches += 1;
      sqlite.prepare(`
        UPDATE pasture_provider_decisions SET mode='unconfigured', provider_key=NULL
        WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
      `).run();
      return {
        status: "no_data",
        reason: "no_intervals",
        observedAt: null,
        interval: { from: request.from, to: request.to },
        sampleCount: 0,
        noDataCount: 0,
        validSampleCount: 0,
      };
    },
  };
  await assert.rejects(
    ndviConnector.runPastureNdviCollectionJob(collectionJob("pasture-paddock-b", "revoked"), {}, {
      now: new Date("2026-10-22T16:00:00.000Z"),
      connector: revokedConnector,
    }),
    (cause) => cause?.code === "FIELD_SCOPE_CONFLICT",
  );
  assert.equal(revokedFetches, 1);
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM paddock_ndvi
    WHERE paddock_id='pasture-paddock-b' AND month='2026-09-01'
  `).get().count, 0, "una revocación posterior al fetch impide persistir no_data");
  sqlite.prepare(`
    UPDATE pasture_provider_decisions SET mode='configured', provider_key='cdse-sentinel-2'
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
  `).run();

  const octoberInterval = {
    from: "2026-10-01T00:00:00.000Z",
    to: "2026-11-01T00:00:00.000Z",
  };
  const concurrentCandidate = (await paddockNdviRepository.listPaddockNdviCandidates(
    "pasture-field-a",
    managerA,
    "2026-10-01",
  )).find((candidate) => candidate.paddockId === "pasture-paddock-b");
  assert.ok(concurrentCandidate);
  d1.beforeNextBatch = () => {
    sqlite.prepare(`
      INSERT INTO paddock_ndvi (
        id, organization_id, field_id, paddock_id, month, status, mean_ndvi,
        no_data_reason, cloud_pct, cloud_pct_is_approximate, interval_from,
        interval_to, observed_at, sample_count, no_data_count, valid_sample_count,
        computed_at, geometry_snapshot, paddock_snapshot, geometry_snapshot_token
      ) VALUES (?, 'pasture-org-a', 'pasture-field-a', 'pasture-paddock-b',
        '2026-10-01', 'ok', 0.6, NULL, 10, 1, ?, ?, ?, 10, 1, 9, ?, ?, ?, ?)
    `).run(
      "runtime-concurrent-positive-ndvi",
      octoberInterval.from,
      octoberInterval.to,
      "2026-10-20T00:00:00.000Z",
      "2026-07-22T16:10:00.000Z",
      JSON.stringify(concurrentCandidate.snapshot.coordinates),
      JSON.stringify(concurrentCandidate.snapshot),
      concurrentCandidate.geometrySnapshotToken,
    );
  };
  await assert.rejects(
    ndviConnector.runPastureNdviCollectionJob(collectionJob("pasture-paddock-b", "positive-race"), {}, {
      now: new Date("2026-11-22T16:00:00.000Z"),
      connector: noDataConnector,
    }),
    (cause) => cause?.code === "FIELD_SCOPE_CONFLICT",
  );
  const concurrent = sqlite.prepare(`
    SELECT status, geometry_snapshot_token AS geometryToken FROM paddock_ndvi
    WHERE id='runtime-concurrent-positive-ndvi'
  `).get();
  assert.deepEqual(
    { status: concurrent.status, geometryToken: concurrent.geometryToken },
    { status: "ok", geometryToken: concurrentCandidate.geometrySnapshotToken },
    "no_data tardío no reemplaza evidencia positiva de la geometría vigente",
  );
  assert.equal(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM audit_log
    WHERE action='pasture.ndvi.no_data.stored'
      AND entity_id='paddock-ndvi:pasture-org-a:pasture-field-a:pasture-paddock-b:2026-10-01'
  `).get().count, 0);
  assert.equal(files.size, beforeObjects);

  sqlite.prepare("DELETE FROM paddock_ndvi WHERE id='runtime-concurrent-positive-ndvi'").run();
  sqlite.prepare("UPDATE potreros SET coordinates=? WHERE id='pasture-paddock-a'").run(originalCoordinates);
  sqlite.prepare("UPDATE fields SET is_demo=1 WHERE id='pasture-field-a'").run();
});

function collectionJob(paddockId, suffix) {
  return {
    id: `pasture:ndvi:runtime:${suffix}:${paddockId}`,
    organizationId: "pasture-org-a",
    fieldId: "pasture-field-a",
    type: "pasture.ndvi.collect.v1",
    payload: { membershipId: "pasture-manager-a", paddockId },
    status: "active",
    dueAt: "2026-07-22T16:00:00.000Z",
    intervalSeconds: 86400,
    attemptCount: 0,
  };
}

function scheduledNdviJobs() {
  return sqlite.prepare(`
    SELECT id, organization_id AS organizationId, field_id AS fieldId, type, payload,
      status, due_at AS dueAt, interval_seconds AS intervalSeconds,
      lease_owner AS leaseOwner, lease_expires_at AS leaseExpiresAt,
      attempt_count AS attemptCount, last_error_type AS lastErrorType, updated_at AS updatedAt
    FROM scheduled_jobs
    WHERE organization_id='pasture-org-a' AND field_id='pasture-field-a'
      AND type='pasture.ndvi.collect.v1'
    ORDER BY id
  `).all().map((row) => ({ ...row }));
}

function planRequest(operationId) {
  return {
    operationId,
    fieldId: "pasture-field-a",
    startDate: "2026-08-01",
    horizonDays: 5,
  };
}

function insertExistingPlan({ id, operationId, herdId, paddockId }) {
  const plan = {
    visits: [{
      herdId,
      paddockId,
      paddockName: paddockId,
      startsOn: "2026-08-01",
      endsOn: "2026-08-04",
      durationDays: 3,
      allocatedKgDm: 450,
    }],
  };
  sqlite.prepare(`
    INSERT INTO pasture_rotation_plans (
      id, organization_id, field_id, herd_id, operation_id, request_hash,
      status, input_snapshot_json, plan_json, created_by, created_at
    ) VALUES (?, 'pasture-org-a', 'pasture-field-a', ?, ?, ?, 'feasible', '{}', ?, 'seed', '2026-07-21T12:00:00.000Z')
  `).run(id, herdId, operationId, "c".repeat(64), JSON.stringify(plan));
}

function seedPastureRuntime(database) {
  database.exec(`
    INSERT OR IGNORE INTO organizations (id, name) VALUES
      ('pasture-org-a', 'Pasture Org A'),
      ('pasture-org-b', 'Pasture Org B');
    INSERT INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('pasture-field-a', 'pasture-org-a', 'Pasture A', 'Osorno', 1, 20, '[]'),
      ('pasture-field-b', 'pasture-org-b', 'Pasture B', 'Osorno', 0, 20, '[]');
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('pasture-manager-a', 'pasture-org-a', 'manager-a@example.com', 'manager-a@example.com', 'Manager A', 'manager', 'active', 'seed'),
      ('pasture-manager-b', 'pasture-org-b', 'manager-b@example.com', 'manager-b@example.com', 'Manager B', 'manager', 'active', 'seed');
    INSERT INTO membership_field_access (id, membership_id, field_id, created_by) VALUES
      ('pasture-access-a', 'pasture-manager-a', 'pasture-field-a', 'seed'),
      ('pasture-access-b', 'pasture-manager-b', 'pasture-field-b', 'seed');
    INSERT INTO organization_feature_flags
      (id, organization_id, field_id, feature, enabled, created_by, updated_by)
    VALUES
      ('pasture-flag-a', 'pasture-org-a', 'pasture-field-a', 'pastoreo', 1, 'seed', 'seed'),
      ('pasture-flag-b', 'pasture-org-b', 'pasture-field-b', 'pastoreo', 1, 'seed', 'seed');
    INSERT INTO potreros (id, field_id, name, sector, area_hectares, coordinates) VALUES
      ('pasture-paddock-a', 'pasture-field-a', 'Potrero A', 'Norte', 4,
        '[[-40,-73],[-40,-72.99],[-39.99,-72.99],[-39.99,-73]]'),
      ('pasture-paddock-b', 'pasture-field-a', 'Potrero B', 'Sur', 3,
        '[[-40.02,-73],[-40.02,-72.99],[-40.01,-72.99],[-40.01,-73]]'),
      ('pasture-paddock-other', 'pasture-field-b', 'Potrero ajeno', 'Sur', 3,
        '[[-40.04,-73],[-40.04,-72.99],[-40.03,-72.99],[-40.03,-73]]');
    INSERT INTO livestock_lots
      (id, field_id, name, category, animal_count, average_weight_kg, entry_date, status, tracking_mode)
    VALUES
      ('pasture-lot-a', 'pasture-field-a', 'Vacas en ordeña', 'dairy_cow', 10, 500, '2026-01-01', 'active', 'summary'),
      ('pasture-lot-b', 'pasture-field-b', 'Lote sin peso', 'dairy_cow', 4, NULL, '2026-01-01', 'active', 'summary');
    INSERT INTO livestock_feeding_plans
      (id, lot_id, product_name, kg_per_animal_day, sack_weight_kg)
    VALUES ('pasture-ration-a', 'pasture-lot-a', 'Concentrado', 2, 25);
    INSERT INTO livestock_feed_inventory
      (id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg)
    VALUES ('pasture-feed-a', 'pasture-field-a', 'Concentrado', 1_000, 400, 100);
    INSERT INTO paddock_rotation_settings (field_id, recent_days, long_rest_days, version)
    VALUES ('pasture-field-a', 12, 30, 1);
    INSERT INTO paddock_cell_operations (
      id, organization_id, field_id, paddock_id, kind, request_hash, snapshot_token,
      request, result, actor, committed_at
    ) VALUES (
      'pasture-cell-operation-a', 'pasture-org-a', 'pasture-field-a', 'pasture-paddock-a', 'create',
      '${"b".repeat(64)}', 'pasture-cell-snapshot-a', '{}', '{}', 'seed', '2026-07-01T12:00:00.000Z'
    );
    INSERT INTO paddock_cells (
      id, field_id, paddock_id, name, cell_index, coordinates, area_square_meters,
      start_distance_meters, end_distance_meters, active_from, version, created_by_operation_id
    ) VALUES (
      'pasture-cell-a', 'pasture-field-a', 'pasture-paddock-a', 'Franja 1', 1,
      '{"type":"Polygon","coordinates":[]}', 1000, 0, 100, '2026-07-01', 1, 'pasture-cell-operation-a'
    );
    INSERT INTO analytics_projection_runs (
      id, organization_id, field_id, period, window_start, window_end,
      comparison_start, comparison_end, source_revision, schema_version, quality_state,
      quality_issues_json, quality_domains_json, source_counts_json, source_coverage_json,
      computed_at, is_current
    ) VALUES (
      'pasture-analytics-a', 'pasture-org-a', 'pasture-field-a', '2026-06', '2026-06-01', '2026-06-30',
      '2026-05-01', '2026-05-31', '${"a".repeat(64)}', 'fundosmart.analytics.projection.v1', 'available',
      '[]', '{}', '{}', '{}', '2026-07-01T12:00:00.000Z', 1
    );
    INSERT INTO analytics_herd_metrics (
      id, projection_id, organization_id, field_id, period, window_start, window_end,
      metric_key, status, status_reason, value, unit, numerator, denominator, sample_count,
      method, references_json, source_revision, schema_version, computed_at
    ) VALUES
      ('pasture-feed-metric', 'pasture-analytics-a', 'pasture-org-a', 'pasture-field-a', '2026-06', '2026-06-01', '2026-06-30',
       'finance.feed_cost_clp', 'available', NULL, 200000, 'CLP', 200000, NULL, 1,
       'sum_feed_cost', '[]', '${"a".repeat(64)}', 'fundosmart.analytics.projection.v1', '2026-07-01T12:00:00.000Z'),
      ('pasture-iofc-metric', 'pasture-analytics-a', 'pasture-org-a', 'pasture-field-a', '2026-06', '2026-06-01', '2026-06-30',
       'finance.iofc_clp', 'available', NULL, 1800000, 'CLP', 2000000, 200000, 1,
       'milk_revenue_minus_feed_cost', '[]', '${"a".repeat(64)}', 'fundosmart.analytics.projection.v1', '2026-07-01T12:00:00.000Z');
  `);
}

class TestR2Bucket {
  constructor() {
    this.objects = new Map();
    this.afterPut = null;
  }

  get size() {
    return this.objects.size;
  }

  async put(key, value, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes = value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(await value.arrayBuffer());
    const object = {
      key,
      size: bytes.byteLength,
      httpEtag: `"etag-${options.sha256 ?? key}"`,
      customMetadata: { ...(options.customMetadata ?? {}) },
      bytes,
    };
    this.objects.set(key, object);
    await this.afterPut?.(key);
    return object;
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async delete(key) {
    this.objects.delete(key);
  }
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
    return { results: this.database.prepare(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.beforeNextBatch = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    if (this.beforeNextBatch) {
      const hook = this.beforeNextBatch;
      this.beforeNextBatch = null;
      await hook(statements);
    }
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
  }
}
