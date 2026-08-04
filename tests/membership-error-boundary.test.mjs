import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("membership rules are typed separately from persistence failures", async () => {
  const repository = await readFile(new URL("../src/modules/access/server/access-repository.ts", import.meta.url), "utf8");

  assert.match(repository, /import \{ DomainRuleError \} from "@\/src\/core\/server\/domain-rule-error\.mjs";/);
  assert.equal((repository.match(/new DomainRuleError\(/g) ?? []).length, 9);
  assert.match(repository, /La cuenta demo pública debe permanecer con acceso de solo lectura/);
  assert.match(repository, /La identidad demo pública está reservada al espacio de demostración/);
  assert.match(repository, /Los permisos, la membresía o los fundos cambiaron mientras se guardaba el acceso/);
  assert.match(repository, /"FIELD_SCOPE_CONFLICT"/);
  assert.doesNotMatch(repository, /throw new Error\(/);
});

test("membership updates expose only typed rules and sanitize unknown errors", async () => {
  const route = await readFile(new URL("../app/api/configuracion/accesos/route.ts", import.meta.url), "utf8");

  assert.match(route, /cause instanceof DomainRuleError[\s\S]+?cause\.message[\s\S]+?status: 422/);
  assert.match(route, /unexpectedApiFailure\("access\.membership\.save"/);
  assert.doesNotMatch(route, /cause instanceof Error \? cause\.message/);
});
