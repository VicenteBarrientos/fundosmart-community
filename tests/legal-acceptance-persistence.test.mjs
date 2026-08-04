import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import ts from "typescript";
import * as legalDomain from "../src/modules/legal/legal-acceptance.mjs";

const root = path.resolve(import.meta.dirname, "..");
const repositoryUrl = new URL(
  "../src/modules/legal/server/legal-acceptance-repository.ts",
  import.meta.url,
);
const now = "2026-07-29T14:30:00.000Z";

let sqlite;
let d1;
let repository;

before(async () => {
  const source = await readFile(repositoryUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loadedModule = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      const stubs = {
        "@/src/modules/legal/legal-acceptance.mjs": legalDomain,
      };
      assert.ok(specifier in stubs, `Unexpected import: ${specifier}`);
      return stubs[specifier];
    },
    loadedModule,
    loadedModule.exports,
  );
  repository = loadedModule.exports;
});

beforeEach(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrationNames = (await readdir(path.join(root, "drizzle")))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
  for (const name of migrationNames) {
    const source = await readFile(path.join(root, "drizzle", name), "utf8");
    sqlite.exec(source.replaceAll("--> statement-breakpoint", ""));
  }
  sqlite.prepare(`
    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES (?, 'google', ?, ?, ?, ?, 100, 100)
  `).run(
    "google:subject-1",
    "subject-1",
    "person@example.com",
    "person@example.com",
    "Person",
  );
  d1 = new TestD1Database(sqlite);
});

afterEach(() => {
  sqlite.close();
});

test("records both documents and one audit event in a sentinel batch", async () => {
  const status = await repository.recordCurrentLegalAcceptance(d1, acceptanceInput());

  assert.equal(d1.batchCalls, 1);
  assert.equal(d1.lastBatch.length, 4);
  assert.match(d1.lastBatch[0].sql, /INSERT INTO legal_acceptances/u);
  assert.match(d1.lastBatch[2].sql, /INSERT INTO personal_data_events/u);
  assert.match(d1.lastBatch[3].sql, /abs\(-9223372036854775807 - 1\)/u);
  assert.equal(status.complete, true);
  assert.deepEqual(status.missingKinds, []);

  const acceptances = sqlite.prepare(`
    SELECT
      document_kind,
      document_version,
      document_content_sha256,
      evidence_json
    FROM legal_acceptances
    ORDER BY document_kind
  `).all();
  assert.equal(acceptances.length, 2);
  for (const row of acceptances) {
    assert.equal(
      row.document_content_sha256,
      legalDomain.CURRENT_LEGAL_DOCUMENT_RELEASES[row.document_kind].contentSha256,
    );
    const evidence = JSON.parse(row.evidence_json);
    assert.equal(evidence.confirmed, true);
    assert.equal(evidence.document.contentSha256, row.document_content_sha256);
    assert.equal(evidence.requestId, "request-legal-1");
  }
  const event = sqlite.prepare("SELECT * FROM personal_data_events").get();
  assert.equal(event.event_type, "legal.acceptance.recorded");
  assert.equal(event.entity_type, "legal_acceptance");
  assert.equal(event.entity_id, "google:subject-1");
});

test("exports immutable, content-bound receipts for the authenticated identity", async () => {
  await repository.recordCurrentLegalAcceptance(d1, acceptanceInput());
  const receipts = await repository.listLegalAcceptanceReceipts(
    d1,
    "google:subject-1",
  );

  assert.equal(receipts.length, 2);
  assert.ok(Object.isFrozen(receipts));
  for (const receipt of receipts) {
    assert.equal(receipt.evidence.document.contentSha256, receipt.documentContentSha256);
    assert.equal(receipt.evidence.identityId, "google:subject-1");
  }
  assert.throws(
    () => sqlite.prepare("UPDATE legal_acceptances SET request_id = 'changed'").run(),
    /legal_acceptances_append_only/u,
  );
  assert.throws(
    () => sqlite.prepare("DELETE FROM personal_data_events").run(),
    /personal_data_events_append_only/u,
  );
  assert.throws(
    () => sqlite.prepare(`
      INSERT INTO legal_acceptances (
        id, identity_id, document_kind, document_version,
        document_published_on, document_content_sha256, accepted_at,
        evidence_version, evidence_json, request_id
      ) VALUES (?, ?, 'privacy', ?, ?, ?, ?, 1, '{}', ?)
    `).run(
      "forged-acceptance",
      "google:subject-1",
      legalDomain.CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
      legalDomain.CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.publishedOn,
      legalDomain.CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.contentSha256,
      now,
      "forged-request",
    ),
    /legal_acceptance_evidence_invalid/u,
  );
});

test("a missing identity makes the sentinel roll back every write", async () => {
  await assert.rejects(
    repository.recordCurrentLegalAcceptance(d1, {
      ...acceptanceInput(),
      identityId: "google:missing",
      requestId: "request-legal-missing",
    }),
    (error) =>
      error instanceof repository.LegalAcceptancePersistenceError
      && error.code === "LEGAL_ACCEPTANCE_NOT_RECORDED",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM legal_acceptances").get().count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM personal_data_events").get().count,
    0,
  );
});

test("stale versions and absent explicit confirmation never reach D1", async () => {
  for (const input of [
    { ...acceptanceInput(), acceptedVersions: { privacy: "1.1", terms: "1.2" } },
    { ...acceptanceInput(), confirmed: false },
  ]) {
    await assert.rejects(repository.recordCurrentLegalAcceptance(d1, input));
  }
  assert.equal(d1.batchCalls, 0);
});

test("a revoked session in the final hook aborts before the acceptance batch", async () => {
  let hookCalls = 0;
  await assert.rejects(
    repository.recordCurrentLegalAcceptance(d1, {
      ...acceptanceInput(),
      beforeCommit: async () => {
        hookCalls += 1;
        throw new Error("SESSION_REVOKED");
      },
    }),
    /SESSION_REVOKED/u,
  );
  assert.equal(hookCalls, 1);
  assert.equal(d1.batchCalls, 0);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM legal_acceptances").get().count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM personal_data_events").get().count,
    0,
  );
});

test("an old event cannot authorize new receipts when a request id is reused", async () => {
  sqlite.prepare(`
    INSERT INTO personal_data_events (
      id, identity_id, organization_id, request_id, event_type, entity_type,
      entity_id, payload_json, occurred_at
    ) VALUES (?, ?, NULL, ?, 'legal.acceptance.recorded', 'legal_acceptance', ?, '{}', ?)
  `).run(
    "event-from-an-older-release",
    "google:subject-1",
    "request-legal-1",
    "google:subject-1",
    "2026-07-01T10:00:00.000Z",
  );

  await assert.rejects(
    repository.recordCurrentLegalAcceptance(d1, acceptanceInput()),
    (error) =>
      error instanceof repository.LegalAcceptancePersistenceError
      && error.code === "LEGAL_ACCEPTANCE_NOT_RECORDED",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM legal_acceptances").get().count,
    0,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM personal_data_events").get().count,
    1,
  );
});

test("status, receipts, mutation, and read-after-write all pin the primary session", async () => {
  await repository.recordCurrentLegalAcceptance(d1, acceptanceInput());
  await repository.listLegalAcceptanceReceipts(d1, "google:subject-1");
  assert.ok(d1.sessions.length >= 4);
  assert.deepEqual([...new Set(d1.sessions)], ["first-primary"]);
});

function acceptanceInput() {
  let sequence = 0;
  return {
    identityId: "google:subject-1",
    requestId: "request-legal-1",
    acceptedAt: now,
    acceptedVersions: {
      privacy: legalDomain.CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
      terms: legalDomain.CURRENT_LEGAL_DOCUMENT_RELEASES.terms.version,
    },
    confirmed: true,
    userAgentSha256: "a".repeat(64),
    idFactory: (label) => `${label}-${++sequence}`,
  };
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

  async all() {
    return {
      results: this.database.prepare(this.sql).all(...this.bindings),
      success: true,
      meta: {},
    };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class TestD1Database {
  constructor(database) {
    this.database = database;
    this.batchCalls = 0;
    this.lastBatch = [];
    this.sessions = [];
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  withSession(mode) {
    this.sessions.push(mode);
    return this;
  }

  async batch(statements) {
    this.batchCalls += 1;
    this.lastBatch = statements;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/iu.test(statement.sql)
          ? await statement.all()
          : await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (cause) {
      this.database.exec("ROLLBACK");
      throw cause;
    }
  }
}
