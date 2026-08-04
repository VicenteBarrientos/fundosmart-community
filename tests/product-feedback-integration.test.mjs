import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("the authenticated app shell exposes feedback without displacing Importaciones", async () => {
  const appShell = await source("src/core/layout/AppShell.tsx");

  assert.match(appShell, /import\s+\{\s*FeedbackDialog\s*\}/u);
  assert.match(appShell, /<FeedbackDialog isDemo=\{isDemo\}\s*\/>/u);
  assert.match(appShell, /variant="menu"/u);
  assert.match(appShell, /href:\s*"\/app\/importaciones"/u);
});

test("the Drizzle schema, migration and snapshot describe the feedback inbox", async () => {
  const [schema, migration, journal, snapshotText] = await Promise.all([
    source("db/schema.ts"),
    source("drizzle/0001_public_invariants.sql"),
    source("drizzle/meta/_journal.json"),
    source("drizzle/meta/0000_snapshot.json"),
  ]);
  const snapshot = JSON.parse(snapshotText);

  assert.match(schema, /export const productFeedback = sqliteTable/u);
  assert.match(schema, /export const productFeedbackEvents = sqliteTable/u);
  assert.match(migration, /CREATE TRIGGER `product_feedback_capture_immutable`/u);
  assert.match(migration, /CREATE TRIGGER `product_feedback_lifecycle_versioned`/u);
  assert.match(migration, /CREATE TRIGGER `product_feedback_events_no_update`/u);
  assert.match(schema, /NOT GLOB '\*\[\^0-9a-f\]\*'/u);
  assert.doesNotMatch(migration, /(?:\[0-9a-f\]){8}-(?:\[0-9a-f\]){4}/u);
  assert.match(journal, /"tag": "0000_public_schema"/u);
  assert.equal(snapshot.tables.product_feedback.name, "product_feedback");
  assert.equal(snapshot.tables.product_feedback_events.name, "product_feedback_events");
});
