import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { publicSqlForTables } from "./helpers/public-baseline.mjs";

const migration = publicSqlForTables(["organization_ai_configs"], { includeInvariants: false });

test("AI configuration migration stays scoped to its new table", () => {
  assert.doesNotMatch(migration, /\b(?:ALTER|DROP)\b/i);
  assert.match(migration, /CREATE TABLE `organization_ai_configs`/);
  assert.match(migration, /CREATE UNIQUE INDEX `organization_ai_configs_org_provider_idx`/);
  assert.match(migration, /CREATE INDEX `organization_ai_configs_lookup_idx`/);
});

test("AI configuration migration supports the runtime lookup and constraints", () => {
  const database = new DatabaseSync(":memory:");

  try {
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE organizations (
        id text PRIMARY KEY NOT NULL
      );
    `);
    database.exec(migration.replaceAll("--> statement-breakpoint", ""));

    database.prepare("INSERT INTO organizations (id) VALUES (?)").run("org-1");
    const insert = database.prepare(`
      INSERT INTO organization_ai_configs (
        id,
        organization_id,
        provider,
        encrypted_api_key,
        encrypted_key_iv,
        default_model,
        updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run("config-1", "org-1", "openai", "ciphertext", "iv", "gpt-5", "owner@example.com");

    const active = database
      .prepare(`
        SELECT provider, default_model, is_active
        FROM organization_ai_configs
        WHERE organization_id = ? AND is_active = 1
      `)
      .get("org-1");

    assert.equal(active.provider, "openai");
    assert.equal(active.default_model, "gpt-5");
    assert.equal(active.is_active, 1);
    assert.throws(
      () => insert.run("config-2", "org-1", "openai", "ciphertext", "iv", "gpt-5", "owner@example.com"),
      /UNIQUE constraint failed/,
    );
    assert.throws(
      () => insert.run("config-3", "missing-org", "gemini", "ciphertext", "iv", "gemini", "owner@example.com"),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.close();
  }
});
