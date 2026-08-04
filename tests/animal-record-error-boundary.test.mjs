import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("animal record rules are public while integrity failures stay internal", async () => {
  const repository = await readFile(new URL("../src/modules/ganado/ficha/server/animal-record-repository.ts", import.meta.url), "utf8");

  assert.match(repository, /import \{ DomainRuleError \} from "@\/src\/core\/server\/domain-rule-error\.mjs";/);
  assert.ok((repository.match(/new DomainRuleError\(/g) ?? []).length >= 18);
  assert.match(repository, /"FIELD_SCOPE_CONFLICT"/);
  assert.equal((repository.match(/throw new Error\(/g) ?? []).length, 2);
  assert.match(repository, /throw new Error\("La ficha animal no quedó disponible después de guardar\."\)/);
  assert.match(repository, /throw new Error\(`El identificador \$\{key\} coincide con más de un animal del fundo\.`\)/);
});

test("the animal record route preserves validation codes and sanitizes unknown failures", async () => {
  const route = await readFile(new URL("../app/api/ganado/ficha/route.ts", import.meta.url), "utf8");

  assert.match(route, /cause instanceof AnimalRecordRuleError[\s\S]+?status: 400/);
  assert.match(route, /cause instanceof DomainRuleError[\s\S]+?status: 422/);
  assert.match(route, /unexpectedApiFailure\("livestock\.animal-record\.update"/);
  assert.doesNotMatch(route, /cause instanceof Error[\s\S]+?cause\.message/);
});
