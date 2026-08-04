import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import ts from "typescript";

const authSessionUrl = new URL("../app/auth-session.ts", import.meta.url);

test("OIDC recovery keeps the closed subject bound to its sealed email", async () => {
  const database = await migratedDatabase();
  try {
    seedClosedIdentity(database);
    const auth = await loadAuthSession();
    const d1 = new TestD1Database(database);
    await auth.createAuthenticatedSession(d1, {
      provider: "google",
      providerSubject: "subject-a",
      email: "new-address@example.com",
      normalizedEmail: "new-address@example.com",
      displayName: "Updated name",
    }, 200);

    assert.deepEqual(
      { ...database.prepare(`
        SELECT email, normalized_email AS normalizedEmail, display_name AS displayName
        FROM auth_identities
        WHERE id = 'google:subject-a'
      `).get() },
      {
        email: "old-address@example.com",
        normalizedEmail: "old-address@example.com",
        displayName: "Updated name",
      },
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*) AS count
        FROM auth_sessions
        WHERE identity_id = 'google:subject-a'
      `).get().count,
      1,
    );
  } finally {
    database.close();
  }
});

test("OIDC still updates email normally when no account closure exists", async () => {
  const database = await migratedDatabase();
  try {
    database.prepare(`
      INSERT INTO auth_identities (
        id, provider, provider_subject, email, normalized_email, display_name,
        created_at, updated_at
      ) VALUES (
        'google:subject-open', 'google', 'subject-open', 'before@example.com',
        'before@example.com', 'Before', 100, 100
      )
    `).run();
    const auth = await loadAuthSession();
    await auth.createAuthenticatedSession(new TestD1Database(database), {
      provider: "google",
      providerSubject: "subject-open",
      email: "after@example.com",
      normalizedEmail: "after@example.com",
      displayName: "After",
    }, 200);

    assert.deepEqual(
      { ...database.prepare(`
        SELECT email, normalized_email AS normalizedEmail
        FROM auth_identities
        WHERE id = 'google:subject-open'
      `).get() },
      {
        email: "after@example.com",
        normalizedEmail: "after@example.com",
      },
    );
  } finally {
    database.close();
  }
});

async function loadAuthSession() {
  const source = await readFile(authSessionUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      assert.equal(specifier, "./auth-core.mjs");
      return {
        OAUTH_STATE_COOKIE_NAMES: ["oauth"],
        SESSION_COOKIE_NAMES: ["session"],
        normalizeAuthEmail: (value) => String(value ?? "").trim().toLowerCase(),
        randomToken: () => "r".repeat(43),
        sha256Hex: async () => "f".repeat(64),
      };
    },
    loaded,
    loaded.exports,
  );
  return loaded.exports;
}

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrations = (await readdir(new URL("../drizzle/", import.meta.url)))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  try {
    for (const name of migrations) {
      const source = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
      database.exec(source.replaceAll("--> statement-breakpoint", ""));
    }
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
}

function seedClosedIdentity(database) {
  const snapshot = JSON.stringify({
    memberships: [{
      id: "membership-a",
      organizationId: "org-a",
      role: "owner",
      status: "active",
      fieldIds: [],
    }],
  });
  database.exec(`
    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES (
      'google:subject-a', 'google', 'subject-a', 'old-address@example.com',
      'old-address@example.com', 'Old name', 100, 100
    );
    INSERT INTO organizations (id, name, kind)
    VALUES ('org-a', 'Organization A', 'shared');
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    ) VALUES (
      'membership-a', 'org-a', 'old-address@example.com',
      'old-address@example.com', 'Owner', 'owner', 'active', 'system',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
  `);
  database.prepare(`
    INSERT INTO account_closure_requests (
      id, scope, target_id, actor_identity_id, request_id, status,
      requested_at, grace_ends_at, revoked_at, version,
      snapshot_version, snapshot_json
    ) VALUES (
      'closure-a', 'account', 'google:subject-a', 'google:subject-a',
      'request-a', 'grace', '2026-07-29T00:00:00.000Z',
      '2026-08-28T00:00:00.000Z', NULL, 1, 1, ?
    )
  `).run(snapshot);
  database.prepare(`
    UPDATE organization_memberships
    SET status = 'suspended', closure_request_id = 'closure-a'
    WHERE id = 'membership-a'
  `).run();
}

class TestD1PreparedStatement {
  constructor(database, sql, bindings = []) {
    this.database = database;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new TestD1PreparedStatement(this.database, this.sql, bindings);
  }

  async run() {
    this.database.prepare(this.sql).run(...this.bindings);
    return { results: [], success: true, meta: {} };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
  }
}
