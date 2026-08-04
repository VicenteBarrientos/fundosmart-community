import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseStrictDotEnvBytes,
  readStrictDotEnvFile,
  serializeCanonicalDotEnv,
  serializeCanonicalJson,
} from "../scripts/release/self-hosting-env-files.mjs";

test("strict dotenv parsing accepts assignments and comments with one declared value per key", () => {
  assert.deepEqual(parseStrictDotEnvBytes(Buffer.from([
    "# selected installation",
    "FUNDOSMART_DEPLOY_ENVIRONMENT=production",
    "AUTH_ORIGIN='https://farm.example'",
    "EMPTY=",
    "",
  ].join("\n"))), {
    FUNDOSMART_DEPLOY_ENVIRONMENT: "production",
    AUTH_ORIGIN: "https://farm.example",
    EMPTY: "",
  });
});

test("strict dotenv parsing rejects dotenv parser differentials, duplicates and controls", () => {
  for (const source of [
    "AUTH_ORIGIN=https://ok.example\nCLOUDFLARE_API_BASE_URL: https://attacker.example/client/v4\n",
    "AUTH_ORIGIN=https://one.example\nAUTH_ORIGIN=https://two.example\n",
    "export AUTH_ORIGIN=https://farm.example\n",
    " AUTH_ORIGIN=https://farm.example\n",
    "AUTH_ORIGIN\t=https://farm.example\n",
    "AUTH_ORIGIN=https://farm.example\u001b]52;c;payload\u0007\n",
  ]) {
    assert.throws(() => parseStrictDotEnvBytes(Buffer.from(source)), /line|repeats|control/u, source);
  }
});

test("canonical snapshots contain only parsed values in deterministic dotenv and JSON formats", () => {
  const values = { Z_KEY: "value # retained", A_KEY: "https://farm.example/a:b", EMPTY: "" };
  assert.equal(
    serializeCanonicalDotEnv(values).toString("utf8"),
    "A_KEY='https://farm.example/a:b'\nEMPTY=''\nZ_KEY='value # retained'\n",
  );
  assert.equal(
    serializeCanonicalJson(values).toString("utf8"),
    '{\n  "A_KEY": "https://farm.example/a:b",\n  "EMPTY": "",\n  "Z_KEY": "value # retained"\n}\n',
  );
});

test("strict reader rejects symlinks and returns the exact stable source bytes", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "fundosmart-env-reader-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = path.join(directory, "source.env");
  const linkPath = path.join(directory, "link.env");
  const bytes = Buffer.from("KEY=value\n");
  await writeFile(sourcePath, bytes);
  const loaded = await readStrictDotEnvFile(sourcePath, { label: "test file" });
  assert.deepEqual(loaded.bytes, bytes);
  assert.deepEqual(loaded.values, { KEY: "value" });

  await mkdir(path.dirname(linkPath), { recursive: true });
  try {
    await symlink(sourcePath, linkPath, "file");
  } catch (error) {
    if (error?.code === "EPERM") return;
    throw error;
  }
  await assert.rejects(readStrictDotEnvFile(linkPath), /regular file/u);
});
