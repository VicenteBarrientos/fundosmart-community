import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("finance repositories bind every read and mutation to an explicit scope", async () => {
  const repository = await readFile(new URL("../src/modules/ganado/server/livestock-finance-repository.ts", import.meta.url), "utf8");

  assert.match(repository, /listLivestockFinance\(scope: LivestockFinanceReadScope\)/);
  assert.match(repository, /eq\(livestockExpenses\.organizationId, scope\.organizationId\)/);
  assert.match(repository, /inArray\(livestockExpenses\.fieldId, \[\.\.\.scope\.fieldIds\]\)/);
  assert.match(repository, /scope\.allowOrganizationWide[\s\S]+livestockPartners\.organizationId, scope\.organizationId/);
  assert.match(repository, /scope\.allowOrganizationWide[\s\S]+livestockContributions\.organizationId, scope\.organizationId/);
  assert.match(repository, /existing\.organizationId !== organizationId/);
  assert.match(repository, /eq\(livestockPartners\.organizationId, organizationId\)/);
  assert.match(repository, /current_partner\.organization_id = \?/);
  assert.match(repository, /duplicate_partner\.organization_id = \?/);
  assert.match(repository, /current_contribution\.partner_id = \?/);
  assert.match(repository, /current_expense\.paid_by_id = \?/);
  assert.match(repository, /current_contribution\.organization_id = \?/);
  assert.match(repository, /eq\(livestockExpenses\.organizationId, scope\.organizationId\)/);
  assert.match(repository, /const existingFieldId = existing \? await expenseScopeField\(existing\) : null/);
  assert.match(repository, /assertWritableExpenseField\(existingFieldId, scope\)/);
  assert.doesNotMatch(repository, /onConflictDoUpdate/);
});

test("financial routes and pages use the authorized organization and global-role boundary", async () => {
  const files = await Promise.all([
    "../app/api/ganado/plata/socios/route.ts",
    "../app/api/ganado/plata/aportes/route.ts",
    "../app/api/ganado/plata/egresos/route.ts",
    "../app/(producto)/ganado/page.tsx",
    "../app/(producto)/dashboard/page.tsx",
    "../app/(producto)/costos/page.tsx",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const combined = files.join("\n");

  assert.equal((combined.match(/listLivestockFinance\(/g) ?? []).length, 4);
  assert.match(combined, /fieldIds: access\.fieldIds/);
  assert.match(combined, /allowOrganizationWide:/);
  assert.match(files[0], /roleHasGlobalFieldAccess\(access\.role\)/);
  assert.match(files[1], /roleHasGlobalFieldAccess\(access\.role\)/);
  assert.match(files[2], /allowOrganizationWide: roleHasGlobalFieldAccess\(access\.role\)/);
  assert.doesNotMatch(combined, /listLivestockFinance\(\)/);
  assert.doesNotMatch(combined, /!expense\.fieldId \|\| access\.fieldIds\.includes/);
});

test("financial audit is append-only, actor-bound, atomic, and role-aware", async () => {
  const [schema, invariants, repository, partnersRoute, contributionsRoute, expensesRoute, page, clientPage, section] = await Promise.all([
    readFile(new URL("../drizzle/0000_public_schema.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0001_public_invariants.sql", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/ganado/server/livestock-finance-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ganado/plata/socios/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ganado/plata/aportes/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/ganado/plata/egresos/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/(producto)/ganado/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/ganado/GanadoPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/ganado/components/PlataSection.tsx", import.meta.url), "utf8"),
  ]);
  const migration = `${schema}\n${invariants}`;
  const routes = [partnersRoute, contributionsRoute, expensesRoute].join("\n");

  assert.match(migration, /CREATE TRIGGER `audit_log_no_update`/);
  assert.match(migration, /CREATE TRIGGER `audit_log_no_delete`/);
  assert.equal((migration.match(/audit_log_append_only/g) ?? []).length, 2);
  assert.equal((repository.match(/await (?:db|client)\.batch\(/g) ?? []).length, 6);
  assert.match(repository, /prepareConditionalFinanceAudit/);
  assert.match(repository, /auditResult\.meta\.changes !== 1 \|\| mutationResult\.meta\.changes !== 1/);
  assert.match(repository, /before: existing \?\? null/);
  assert.match(repository, /after: saved/);
  assert.match(repository, /listLivestockFinanceAudit/);
  assert.match(repository, /eq\(auditLog\.entityType, "livestock_expense"\)/);
  assert.equal((routes.match(/actorEmail: access\.email/g) ?? []).length, 6);
  assert.match(page, /listLivestockFinanceAudit\(financeScope\)/);
  assert.match(page, /canManageFinance=\{canViewFinance\}/);
  assert.match(clientPage, /item\.key !== "plata" \|\| canManageFinance/);
  assert.match(clientPage, /canManageFinance && tab === "plata"/);
  assert.match(section, /Registro inmutable/);
  assert.match(section, /tus fundos asignados/);
});

test("legacy field backups receive their manifest organization during isolated restore", async () => {
  const writer = await readFile(new URL("../src/modules/integraciones/cooprinsem/server/isolated-restore-writer.mjs", import.meta.url), "utf8");

  assert.match(writer, /LEGACY_ORGANIZATION_SCOPED_SECTIONS = new Set\(\["livestockPartners", "livestockExpenses"\]\)/);
  assert.match(writer, /withLegacyOrganizationScope\(section, row, input\.backup\.manifest\.scope\.organizationId\)/);
  assert.match(writer, /row\.organization_id !== organizationId/);
});
