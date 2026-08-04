import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const legacyRequire = createRequire(
  new URL("../node_modules/eslint-config-next/package.json", import.meta.url),
);

test("the patched brace expansion adapter remains compatible with old and new minimatch callers", async () => {
  const expand = require("brace-expansion");
  const modernMinimatchPackage = require("minimatch");
  const modernMinimatch =
    typeof modernMinimatchPackage === "function"
      ? modernMinimatchPackage
      : modernMinimatchPackage.minimatch;
  const legacyMinimatch = legacyRequire("minimatch");
  const packageJson = require("brace-expansion/package.json");
  const esmNamespace = await import("brace-expansion");

  assert.equal(packageJson.version, "5.0.9");
  assert.equal(typeof expand, "function");
  assert.equal(typeof esmNamespace.expand, "function");
  assert.deepEqual(expand("{src,tests}/**/*.ts"), [
    "src/**/*.ts",
    "tests/**/*.ts",
  ]);
  assert.equal(modernMinimatch("src/app.ts", "{src,tests}/**/*.ts"), true);
  assert.equal(legacyMinimatch("tests/app.ts", "{src,tests}/**/*.ts"), true);
});
