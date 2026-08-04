import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("traceability API is feature-gated, private and never exposes raw failures", async () => {
  const [route, documents, failure] = await Promise.all([
    read("app/api/trazabilidad/route.ts"),
    read("app/api/trazabilidad/documentos/route.ts"),
    read("app/api-failure.mjs"),
  ]);
  assert.match(route, /authorizeApiAccess\("trazabilidad:read", fieldId\)/u);
  assert.match(route, /authorizeApiAccess\("trazabilidad:write", fieldId\)/u);
  assert.match(route, /readJsonObject/u);
  assert.match(route, /Cache-Control": "private, no-store/u);
  assert.doesNotMatch(route, /cause instanceof Error \? cause\.message/u);
  assert.match(documents, /getTraceabilityDocument/u);
  assert.match(documents, /X-Content-Type-Options/u);
  assert.match(failure, /diagnosticToken/u);
});

test("repository revalidates persisted membership and preserves tenant-bound immutable R2 identity", async () => {
  const repository = await read("src/modules/trazabilidad/server/traceability-repository.ts");
  assert.match(repository, /organization_memberships AS current_actor/u);
  assert.match(repository, /membership_field_access AS current_scope/u);
  assert.match(repository, /organization_feature_flags/u);
  assert.match(repository, /current_field\.organization_id = \?/u);
  assert.match(repository, /hasCurrentTraceabilityDocumentAccess\(actor, input\.fieldId\)/u);
  assert.match(repository, /current_field\.is_demo = 0/u);
  assert.match(repository, /onlyIf: \{ etagDoesNotMatch: "\*" \}/u);
  assert.match(repository, /metadata\.organizationId === String\(expected\.organizationId\)/u);
  assert.match(repository, /metadata\.fieldId === String\(expected\.fieldId\)/u);
  assert.match(repository, /issued_internal_not_sag/u);
  assert.match(repository, /draft_not_declared/u);
  assert.match(repository, /officialFormatDecision: "pending_confirmation"/u);
});

test("dispatcher and observability recognize traceability while global mutation guards remain in front", async () => {
  const [worker, observability] = await Promise.all([read("worker/index.ts"), read("worker/observability.mjs")]);
  assert.match(worker, /rejectCrossSiteMutation\(request\)/u);
  assert.match(worker, /enforceApiMutationSize\(request\)/u);
  assert.match(worker, /job\.type === "traceability\.reconcile\.v1"/u);
  assert.match(worker, /runTraceabilityReconciliationJob\(job\)/u);
  assert.match(observability, /api\.traceability/u);
});

test("demo seed is fictitious, read-only and cannot claim official submission", async () => {
  const [migration, client] = await Promise.all([
    read("drizzle/0002_public_demo.sql"),
    read("app/trazabilidad/TraceabilityClient.tsx"),
  ]);
  assert.match(migration, /feature-demo-trazabilidad/u);
  assert.match(migration, /org-fundosmart-demo/u);
  assert.match(migration, /fundo-el-ejemplo/u);
  assert.doesNotMatch(migration, /folio[^\n]*DEMO/iu);
  assert.match(client, /Emisión interna · no declarada SAG/u);
  assert.match(client, /La demostración no puede emitir folios/u);
});

test("DBF intake reuses Cooprinsem parsing and FMA actions expose guarded issue and annul flows", async () => {
  const [route, repository, adapter, sipecAdapter, client] = await Promise.all([
    read("app/api/trazabilidad/route.ts"),
    read("src/modules/trazabilidad/server/traceability-repository.ts"),
    read("src/modules/trazabilidad/server/traceability-import-adapter.mjs"),
    read("src/modules/trazabilidad/server/sipec-adapter.mjs"),
    read("app/trazabilidad/TraceabilityClient.tsx"),
  ]);
  assert.match(adapter, /integraciones\/cooprinsem\/server\/dbf-parser\.mjs/u);
  assert.match(adapter, /buildProjectionCandidate/u);
  assert.match(route, /multipart\/form-data/u);
  assert.match(route, /stageTraceabilityDbfImport/u);
  assert.match(route, /case "stage_import"[\s\S]+idempotencyKey:\s*text\(payload\.idempotencyKey\)/u);
  assert.match(route, /case "commit_import"[\s\S]+idempotencyKey:\s*text\(payload\.idempotencyKey\)/u);
  assert.match(route, /idempotencyKey = text\(formData\.get\("idempotencyKey"\)\)/u);
  assert.match(route, /saveTraceabilityEstablishment[\s\S]+idempotencyKey:\s*text\(payload\.idempotencyKey\)/u);
  assert.match(route, /case "issue_fma"/u);
  assert.match(route, /case "annul_fma"/u);
  assert.match(repository, /status = 'issued'.*version = version \+ 1/su);
  assert.match(repository, /status = 'annulled'.*annulment_reason/su);
  assert.match(repository, /FMA_VERSION_CONFLICT/u);
  assert.match(repository, /featureEnabled/u);
  assert.match(repository, /IDEMPOTENCY_COLLISION/u);
  assert.match(repository, /INNER JOIN fields AS scoped_field[\s\S]+scoped_field\.organization_id = \?/u);
  assert.match(repository, /fundosmart\.traceability\.establishment-georef\.v1/u);
  assert.match(repository, /fundosmart\.traceability\.reconciliation-state\.v2/u);
  assert.match(repository, /officialDeadlineAssumed: false/u);
  assert.match(sipecAdapter, /pending_official_specification/u);
  assert.match(sipecAdapter, /officiallySubmittable: false/u);
  assert.match(sipecAdapter, /SIPEC_SPECIFICATION_UNAVAILABLE/u);
  assert.match(client, /Corregir con nuevo FMA/u);
});
