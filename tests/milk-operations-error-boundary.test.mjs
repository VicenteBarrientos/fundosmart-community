import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("milk operation routes expose typed domain errors and sanitize infrastructure failures", async () => {
  const [route, repository] = await Promise.all([
    readSource("../app/api/leche/operaciones/route.ts"),
    readSource("../src/modules/leche/server/milk-operations-repository.ts"),
  ]);

  assert.match(route, /import \{ unexpectedApiFailure \} from "@\/app\/api-failure\.mjs"/);
  assert.match(route, /class MilkOperationRequestError extends Error/);
  assert.match(route, /cause instanceof MilkOperationRequestError/);
  assert.match(route, /cause instanceof MilkOperationInputError/);
  for (const operation of [
    "milk.operations.list",
    "milk.operations.save",
    "milk.operations.delete",
  ]) {
    assert.match(route, new RegExp(`unexpectedApiFailure\\(\\s*"${operation.replaceAll(".", "\\.")}"`));
  }
  assert.doesNotMatch(
    route,
    /cause instanceof Error\s*\)\s*return Response\.json\(\{ error: cause\.message \}/,
  );

  assert.match(repository, /export class MilkOperationInputError extends Error/);
  assert.match(repository, /throw new MilkOperationInputError/);
  assert.match(repository, /throw new MilkOperationConflictError/);
  assert.doesNotMatch(repository, /throw new Error\(/);
});
