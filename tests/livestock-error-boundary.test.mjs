import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DomainRuleError } from "../src/core/server/domain-rule-error.mjs";

const REPOSITORIES = [
  "../src/modules/ganado/server/livestock-repository.ts",
  "../src/modules/ganado/server/livestock-animal-repository.ts",
  "../src/modules/ganado/server/livestock-ration-repository.ts",
  "../src/modules/ganado/server/livestock-weighing-repository.ts",
  "../src/modules/ganado/server/livestock-finance-repository.ts",
  "../src/modules/leche/server/milk-settlement-repository.ts",
];
const SCOPE_HELPER = "../src/modules/access/server/organization-field-scope.ts";

const ROUTES = [
  "../app/api/ganado/route.ts",
  "../app/api/ganado/animales/route.ts",
  "../app/api/ganado/racion/route.ts",
  "../app/api/ganado/pesajes/route.ts",
  "../app/api/ganado/plata/socios/route.ts",
  "../app/api/ganado/plata/aportes/route.ts",
  "../app/api/ganado/plata/egresos/route.ts",
  "../app/api/leche/route.ts",
];

test("domain rule errors carry a stable public code", () => {
  const error = new DomainRuleError("Regla visible.");
  assert.equal(error.name, "DomainRuleError");
  assert.equal(error.message, "Regla visible.");
  assert.equal(error.code, "DOMAIN_RULE_VIOLATION");
});

test("livestock repositories type every expected public rule", async () => {
  const sources = await Promise.all([...REPOSITORIES, SCOPE_HELPER].map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const combined = sources.join("\n");

  assert.equal((combined.match(/new DomainRuleError\(/g) ?? []).length, 28);
  assert.match(combined, /LIVESTOCK_TAG_SCOPE_CONFLICT/);
  assert.match(combined, /MILK_SETTLEMENT_INVALID/);
  // Editar el número de un animal con historia obliga a pasar por la ficha.
  assert.match(combined, /RENUMBER_REQUIRED/);
  assert.doesNotMatch(combined, /throw new Error\(/);
  for (const source of sources.slice(0, REPOSITORIES.length)) {
    assert.match(source, /(?:import \{ DomainRuleError \} from "@\/src\/core\/server\/domain-rule-error\.mjs";|organization-field-scope)/);
  }
});

test("livestock routes expose deliberate public statuses and sanitize unexpected failures", async () => {
  const sources = await Promise.all(ROUTES.map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const combined = sources.join("\n");

  assert.equal((combined.match(/cause instanceof DomainRuleError/g) ?? []).length, 11);
  assert.equal((combined.match(/unexpectedApiFailure\(/g) ?? []).length, 13);
  assert.equal((combined.match(/status: 422/g) ?? []).length, 9);
  assert.match(sources[4], /FINANCE_VERSION_CONFLICT[\s\S]+?status: 409/);
  assert.match(sources[4], /return Response\.json\(\{ error: cause\.message, code: cause\.code \}, \{ status: 422 \}\)/);
  assert.match(sources[5], /FINANCE_CONTRIBUTION_VERSION_CONFLICT[\s\S]+?status: 409/);
  assert.match(sources[5], /return Response\.json\(\{ error: cause\.message, code: cause\.code \}, \{ status: 422 \}\)/);
  assert.doesNotMatch(combined, /const message = cause instanceof Error \? cause\.message/);
  for (const source of sources) {
    assert.match(source, /import \{ unexpectedApiFailure \} from "@\/app\/api-failure\.mjs";/);
    assert.match(source, /import \{ DomainRuleError \} from "@\/src\/core\/server\/domain-rule-error\.mjs";/);
  }
});
