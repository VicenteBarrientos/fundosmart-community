import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  ORIGINAL_RETENTION_POLICY,
  simulateOriginalRetention,
} from "../src/modules/integraciones/cooprinsem/server/retention-policy.mjs";

const base = {
  fieldId: "field-1",
  fieldName: "Fundo Uno",
  organizationId: "org-1",
  evaluatedAt: "2026-07-18T18:00:00.000Z",
  originalCount: 3,
  totalSizeBytes: 4096,
  openIntegrityIncidentCount: 0,
  oldestImportedAt: "2024-01-01T00:00:00.000Z",
  newestImportedAt: "2026-01-01T00:00:00.000Z",
};

const actorAccessGuard = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/current-actor-access.ts", import.meta.url), "utf8");

const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/retention-repository.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/retencion/route.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/modules/integraciones/cooprinsem/api/import-client.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");

test("la política versionada conserva por defecto y no inventa un plazo", () => {
  assert.deepEqual(ORIGINAL_RETENTION_POLICY, {
    id: "cooprinsem-originals-retain-only",
    version: 1,
    mode: "retain_only",
    deletionEnabled: false,
    approvedRetentionDays: null,
    lifecycleExpirationEnabled: false,
  });
  assert.equal(Object.isFrozen(ORIGINAL_RETENTION_POLICY), true);
});

test("ningún original antiguo resulta eliminable mientras faltan controles", () => {
  const result = simulateOriginalRetention(base);
  assert.equal(result.status, "retain_all");
  assert.equal(result.totals.originalCount, 3);
  assert.equal(result.totals.retainCount, 3);
  assert.equal(result.totals.eligibleForDeletionCount, 0);
  assert.equal(result.gates.filter((gate) => !gate.satisfied).length, 7);
  assert.equal(result.gates.find((gate) => gate.code === "integrity_clear")?.satisfied, true);
});

test("un incidente de integridad agrega un bloqueo explícito", () => {
  const result = simulateOriginalRetention({ ...base, openIntegrityIncidentCount: 2 });
  const gate = result.gates.find((entry) => entry.code === "integrity_clear");
  assert.equal(gate?.satisfied, false);
  assert.match(gate?.detail ?? "", /2 incidentes abiertos/);
  assert.equal(result.totals.eligibleForDeletionCount, 0);
});

test("un inventario vacío sigue sin habilitar eliminación", () => {
  const result = simulateOriginalRetention({
    ...base,
    originalCount: 0,
    totalSizeBytes: 0,
    oldestImportedAt: null,
    newestImportedAt: null,
  });
  assert.equal(result.status, "empty");
  assert.equal(result.totals.retainCount, 0);
  assert.equal(result.totals.eligibleForDeletionCount, 0);
});

test("la simulación API respeta capacidad, fundo y exposición agregada", () => {
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireContextField\(access, fieldId\)/);
  assert.match(route, /getOriginalRetentionDashboard\(\{/);
  assert.match(route, /organizationId: access\.organizationId/);
  assert.match(route, /fieldIds: access\.fieldIds/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /actorEmail: access\.email/);
  assert.doesNotMatch(route, /export async function (?:POST|PUT|PATCH|DELETE)/);
  assert.match(repository, /SELECT COUNT\(\*\)[\s\S]+FROM import_jobs AS current_job/);
  assert.match(repository, /SELECT SUM\(current_job\.file_size_bytes\)/);
  assert.match(repository, /current_incident\.status = 'open'/);
  assert.match(repository, /incident_job\.organization_id = current_incident\.organization_id/);
  assert.match(repository, /currentCooprinsemActorFieldGuard\("current_field", access\)/);
  assert.match(actorAccessGuard, /current_actor\.status = 'active'/);
  assert.match(actorAccessGuard, /membership_field_access AS current_scope/);
  assert.doesNotMatch(repository, /objectKey|object_key|env\.FILES|\.delete\(/);
});

test("el centro muestra la política sin ofrecer una acción destructiva", () => {
  assert.match(client, /\/api\/integraciones\/cooprinsem\/retencion\?fieldId=/);
  assert.match(page, /Simulación de retención/);
  assert.match(page, /Eliminación deshabilitada/);
  assert.match(page, /sin consultas de contenido ni escrituras sobre R2/);
  assert.match(page, /timeZone: "America\/Santiago"/);
  assert.match(page, /replace\(\/\[\\u00a0\\u202f\]\/g, " "\)/);
  assert.doesNotMatch(page.match(/function RetentionPolicyPanel[\s\S]+?\n}/)?.[0] ?? "", /Eliminar|delete|DELETE/);
});
