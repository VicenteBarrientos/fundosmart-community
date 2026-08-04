import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(new URL("..", import.meta.url).pathname.slice(process.platform === "win32" ? 1 : 0));
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("phase 1 migration is additive, constrained, journaled and applicable", async () => {
  const [migration, journal] = await Promise.all([
    source("drizzle/0000_public_schema.sql"),
    source("drizzle/meta/_journal.json"),
  ]);
  assert.doesNotMatch(migration, /^(?:DROP|DELETE)\b/im);
  assert.match(migration, /CREATE TABLE `paddock_operations`/);
  assert.match(migration, /`organization_id` text NOT NULL/);
  assert.match(migration, /`reverted_at` text/);
  assert.match(migration, /CREATE TABLE `paddock_lineage_edges`/);
  assert.match(migration, /CREATE TABLE `paddock_operation_lot_moves`/);
  assert.match(migration, /CREATE TABLE `paddock_subdivision_drafts`/);
  assert.match(migration, /`base_snapshot_token` text NOT NULL/);
  assert.match(migration, /`archived_at` text/);
  assert.match(journal, /"idx": 0/);

  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = path.join(root, "drizzle");
  for (const name of (await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec((await readFile(path.join(migrationDirectory, name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  for (const name of ["paddock_operations", "paddock_lineage_edges", "paddock_operation_lot_moves", "paddock_subdivision_drafts"]) {
    assert.ok(tables.has(name), `missing ${name}`);
  }
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  db.close();
});

test("operation commits are idempotent, scoped, snapshot guarded and non-destructive", async () => {
  const [repository, route, client] = await Promise.all([
    source("src/modules/potreros/server/paddock-operation-repository.ts"),
    source("app/api/potreros/operaciones/route.ts"),
    source("src/modules/potreros/api/paddock-operations-client.ts"),
  ]);
  assert.doesNotMatch(repository, /DELETE FROM/);
  assert.match(repository, /existing\.requestHash !== request\.requestHash/);
  assert.match(repository, /idempotentReplay: true/);
  assert.match(repository, /current_active\.archived_at IS NULL/);
  assert.match(repository, /expectedActivePaddocksJson/);
  assert.match(repository, /current_field\.coordinates/);
  assert.match(repository, /json_array_length\(\?\)/);
  assert.match(repository, /client\.batch\(statements\)/);
  assert.match(repository, /abs\(-9223372036854775807 - 1\)/);
  assert.match(repository, /activeBefore\.filter[\s\S]+?createdPaddocks/);
  assert.match(repository, /\.sort\(\(first, second\) => first\.id\.localeCompare\(second\.id\)\)/);
  assert.match(repository, /planUndo/);
  assert.match(repository, /reverted_by_operation_id/);
  assert.match(repository, /reason, warning, created_at/);
  assert.match(route, /authorizeApiAccess\("operate"\)/);
  assert.match(route, /requireContextField\(access, payload\.fieldId\)/);
  assert.match(client, /class PaddockOperationApiError/);
  assert.match(client, /response\.status, payload\.code/);
});

test("archived paddocks, lineage activities and scoped drafts have explicit API contracts", async () => {
  const [activityRepository, draftRepository, activityRoute, draftRoute, paddockClient, draftClient] = await Promise.all([
    source("src/modules/potreros/server/activity-repository.ts"),
    source("src/modules/potreros/server/subdivision-draft-repository.ts"),
    source("app/api/actividades/route.ts"),
    source("app/api/subdivisiones/route.ts"),
    source("src/modules/potreros/api/potreros-client.ts"),
    source("src/modules/potreros/api/subdivision-drafts-client.ts"),
  ]);
  assert.match(activityRepository, /WITH RECURSIVE ancestors/);
  assert.match(activityRepository, /row_number\(\) OVER \(PARTITION BY activity\.id/);
  assert.match(activityRepository, /sameActivityPayload/);
  assert.match(activityRepository, /isNull\(paddocks\.archivedAt\)/);
  assert.match(activityRoute, /includeLineage/);
  assert.match(draftRepository, /baseSnapshotToken !== currentToken/);
  assert.match(draftRepository, /expectedUpdatedAt !== existing\.updatedAt/);
  assert.match(draftRepository, /paddock_subdivision_drafts/);
  assert.match(draftRoute, /deleteScopedSubdivisionDraft/);
  assert.match(paddockClient, /fetchArchivedPotreros/);
  assert.match(draftClient, /class SubdivisionDraftApiError/);
  assert.match(draftClient, /fetchScopedSubdivisionDraft/);
});
