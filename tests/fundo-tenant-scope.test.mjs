import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const repositoryUrl = new URL("../src/modules/potreros/server/fundo-repository.ts", import.meta.url);
const routeUrl = new URL("../app/api/fundos/route.ts", import.meta.url);

test("fundo rows use the organization supplied by the authorized caller", async () => {
  const repository = await readFile(repositoryUrl, "utf8");

  assert.match(repository, /function toFieldRow\(fundo: Fundo, organizationId: string\)/);
  assert.match(repository, /organizationId,\s+name: fundo\.name/);
  assert.match(repository, /export async function upsertFundo\(fundo: Fundo, scope: OrganizationFieldScope\)/);
  assert.match(repository, /const values = toFieldRow\(fundo, scope\.organizationId\)/);
});

test("fundo updates reject foreign identifiers and keep the organization in the write predicate", async () => {
  const repository = await readFile(repositoryUrl, "utf8");
  const upsert = repository.slice(repository.indexOf("export async function upsertFundo"));

  assert.match(upsert, /\.select\(\)\s+\.from\(fields\)/);
  assert.match(upsert, /existing\.organizationId !== scope\.organizationId/);
  assert.match(upsert, /!scope\.fieldIds\.includes\(existing\.id\)/);
  assert.match(upsert, /new DomainRuleError\("El identificador del fundo no está disponible\."/);
  assert.match(upsert, /UPDATE fields[\s\S]+?WHERE id = \?[\s\S]+?AND organization_id = \?[\s\S]+?AND id IN \(SELECT value FROM json_each\(\?\)\)/);
  assert.match(upsert, /AND name = \?[\s\S]+?AND location = \?[\s\S]+?AND is_demo = \?[\s\S]+?AND area_hectares = \?[\s\S]+?AND coordinates = \?[\s\S]+?AND created_at = \?/);
  assert.match(upsert, /WHERE NOT EXISTS \([\s\S]+?conflicting_field\.id = \?[\s\S]+?AND EXISTS \([\s\S]+?current_organization\.id = \?/);
  assert.match(upsert, /client\.batch\(\[mutation, selectSaved\]\)/);
  assert.doesNotMatch(upsert, /onConflictDoUpdate/);
});

test("the fundos API passes its authorized organization and sanitizes non-domain failures", async () => {
  const route = await readFile(routeUrl, "utf8");

  assert.match(route, /upsertFundo\(payload as Fundo, access\)/);
  assert.match(route, /cause instanceof DomainRuleError[\s\S]+?status: 409/);
  assert.match(route, /unexpectedApiFailure\("fields\.list"/);
  assert.match(route, /unexpectedApiFailure\("fields\.save"/);
  assert.doesNotMatch(route, /catch \{/);
});
