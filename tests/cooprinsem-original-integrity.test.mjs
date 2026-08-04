import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assessDeepOriginalIntegrity,
  assessOriginalIntegrity,
} from "../src/modules/integraciones/cooprinsem/server/original-integrity.mjs";

const expected = {
  fileSizeBytes: 2048,
  sha256: "a".repeat(64),
  organizationId: "org-1",
  fieldId: "field-1",
  sourceTable: "_Traspasos.DBF",
};
const stored = {
  size: 2048,
  customMetadata: {
    sha256: "a".repeat(64),
    organizationId: "org-1",
    fieldId: "field-1",
    sourceTable: "_Traspasos.DBF",
  },
};

const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/original-integrity-repository.ts", import.meta.url), "utf8");
const currentActorAccess = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/current-actor-access.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/conservacion/route.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");

test("clasifica como saludable un original cuyo inventario R2 coincide con D1", () => {
  assert.deepEqual(assessOriginalIntegrity(expected, stored), { status: "healthy", issues: [] });
});

test("distingue un objeto R2 faltante", () => {
  assert.equal(assessOriginalIntegrity(expected, null).status, "missing");
});

test("prioriza la diferencia de tamaño cuando hay más de una discrepancia", () => {
  const result = assessOriginalIntegrity(expected, { size: 1, customMetadata: {} });
  assert.equal(result.status, "size_mismatch");
  assert.ok(result.issues.length >= 2);
});

test("detecta una huella de metadatos distinta", () => {
  const result = assessOriginalIntegrity(expected, {
    ...stored,
    customMetadata: { ...stored.customMetadata, sha256: "b".repeat(64) },
  });
  assert.equal(result.status, "sha_mismatch");
});

test("detecta metadatos de alcance que no pertenecen al fundo", () => {
  const result = assessOriginalIntegrity(expected, {
    ...stored,
    customMetadata: { ...stored.customMetadata, fieldId: "field-2" },
  });
  assert.equal(result.status, "metadata_mismatch");
  assert.match(result.issues[0], /fieldId/);
});

test("la verificación profunda detecta contenido alterado aunque el inventario coincida", () => {
  const result = assessDeepOriginalIntegrity(expected, stored, "b".repeat(64));
  assert.equal(result.status, "content_mismatch");
  assert.match(result.issues[0], /bytes/);
});

test("distingue metadatos alterados de bytes íntegros", () => {
  const result = assessDeepOriginalIntegrity(expected, {
    ...stored,
    customMetadata: { ...stored.customMetadata, sha256: "b".repeat(64) },
  }, expected.sha256);
  assert.equal(result.status, "metadata_mismatch");
  assert.doesNotMatch(result.issues.join(" "), /recalculado desde los bytes/);
});

test("el inventario es acotado, autorizado, agregado y no expone claves R2", () => {
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /requireContextField\(access, fieldId\)/);
  assert.match(route, /requireResourceField\(access, "import_job", importJobId\)/);
  assert.match(route, /organizationId: access\.organizationId, fieldIds: access\.fieldIds/);
  assert.match(route, /cause instanceof OriginalIntegrityScopeError/);
  assert.match(route, /status: 409/);
  assert.match(repository, /MAX_SCAN_FILES = 100/);
  assert.match(repository, /MAX_DEEP_VERIFY_BYTES = 20 \* 1024 \* 1024/);
  assert.match(repository, /headImportFile\(candidate\.objectKey\)/);
  assert.match(repository, /sha256Hex\(await object\.arrayBuffer\(\)\)/);
  assert.match(repository, /class OriginalIntegrityScopeError/);
  assert.match(repository, /'import\.originals\.verified', 'field'/);
  assert.match(repository, /'import\.original\.deep_verified', 'import_job'/);
  assert.match(repository, /json\(current_snapshot\.value\) = json\(\?\)/);
  assert.match(repository, /current_job\.object_key = \?/);
  assert.match(repository, /currentCooprinsemActorFieldGuard\("current_field", input\.access\)/);
  assert.match(repository, /AND \$\{actorGuard\.sql\}/);
  assert.match(currentActorAccess, /current_actor\.id = \?/);
  assert.match(currentActorAccess, /current_actor\.status = 'active'/);
  assert.match(currentActorAccess, /current_actor\.role IN \('owner', 'admin', 'manager'\)/);
  assert.match(currentActorAccess, /current_scope\.field_id = \$\{fieldAlias\}\.id/);
  assert.match(currentActorAccess, /\$\{fieldAlias\}\.id IN \(SELECT CAST\(value AS TEXT\) FROM json_each\(\?\)\)/);
  assert.doesNotMatch(repository.match(/return \{[\s\S]+?storedAt:[\s\S]+?\};/)?.[0] ?? "", /objectKey:/);
  assert.match(page, /Verificar conservación R2/);
  assert.match(page, /Recalcular bytes/);
});
