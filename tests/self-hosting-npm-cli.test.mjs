import assert from "node:assert/strict";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { resolveTrustedNpmCli } from "../scripts/release/run-self-hosting-check.mjs";

test("the self-hosting gate resolves npm from the active Node installation, never npm_execpath", async () => {
  const npmCli = await resolveTrustedNpmCli();
  const stats = await lstat(npmCli);
  assert.equal(stats.isFile(), true);
  assert.equal(path.basename(npmCli), "npm-cli.js");

  const source = await readFile(
    new URL("../scripts/release/run-self-hosting-check.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /npm_execpath/u);
});
