import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DEMO_DATA_PROVENANCE } from "../src/modules/demo/data/demo-data.mjs";

const migrationUrls = [
  new URL("../drizzle/0000_public_schema.sql", import.meta.url),
  new URL("../drizzle/0001_public_invariants.sql", import.meta.url),
  new URL("../drizzle/0002_public_demo.sql", import.meta.url),
];

const privateMarkers = [
  [103, 109, 97, 105, 108],
  [112, 97, 108, 111, 115, 32, 110, 101, 103, 114, 111, 115],
  [99, 104, 97, 99, 97, 121, 97, 108],
  [116, 114, 97, 110, 113, 117, 101, 32, 118, 105, 101, 106, 111],
  [118, 105, 99, 101, 110, 116, 101],
  [98, 97, 114, 114, 105, 101, 110, 116, 111, 115],
  [115, 111, 108, 101, 100, 97, 100],
  [109, 97, 116, 105, 97, 115],
].map((codes) => String.fromCharCode(...codes));

test("the public baseline is complete, synthetic and referentially valid", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys=ON");

  const migrationSources = [];
  for (const url of migrationUrls) {
    const source = await readFile(url, "utf8");
    migrationSources.push(source);
    database.exec(source.replaceAll("--> statement-breakpoint", ""));
  }

  const tableCount = database.prepare(`
    SELECT count(*) AS count
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).get().count;
  const triggerCount = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get().count;
  const foreignKeyIssues = database.prepare("PRAGMA foreign_key_check").all();

  assert.equal(tableCount, 111);
  assert.equal(triggerCount, 81);
  assert.deepEqual(foreignKeyIssues, []);
  assert.equal(database.prepare("SELECT count(*) AS count FROM organizations").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM fields WHERE is_demo = 1").get().count, 1);
  assert.equal(database.prepare("SELECT count(*) AS count FROM potreros").get().count, 14);
  assert.equal(database.prepare("SELECT count(*) AS count FROM livestock_animals").get().count, 92);
  assert.equal(database.prepare("SELECT count(*) AS count FROM organization_access_bootstrap").get().count, 0);
  assert.deepEqual(DEMO_DATA_PROVENANCE, {
    kind: "deterministic-synthetic",
    privateSources: false,
    version: "public-demo-v1",
  });

  const normalizedSource = migrationSources.join("\n").normalize("NFD").replaceAll(/\p{Diacritic}/gu, "").toLowerCase();
  for (const marker of privateMarkers) assert.equal(normalizedSource.includes(marker), false);

  database.close();
});
