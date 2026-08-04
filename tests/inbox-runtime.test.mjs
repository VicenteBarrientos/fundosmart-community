import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
const actorA = {
  membershipId: "inbox-member-a",
  organizationId: "inbox-org-a",
  fieldId: "inbox-field-a",
  fieldIds: ["inbox-field-a"],
  email: "owner-a@example.com",
};

let sqlite;
let d1;
let r2;
let vite;
let inboxRepo;

before(async () => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const name of (await readdir(path.join(root, "drizzle")))
    .filter((entry) => /^\d{4}_.+\.sql$/u.test(entry))
    .sort()) {
    sqlite.exec((await readFile(path.join(root, "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", ""));
  }

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS inbox_addresses (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      address_token TEXT NOT NULL UNIQUE,
      email_address TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'active',
      created_by_email TEXT NOT NULL,
      revoked_by_email TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inbox_sender_whitelists (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      sender_email TEXT NOT NULL,
      normalized_sender_email TEXT NOT NULL,
      label TEXT,
      created_by_email TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, normalized_sender_email)
    );

    CREATE TABLE IF NOT EXISTS inbox_quarantine (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      inbox_address_id TEXT NOT NULL REFERENCES inbox_addresses(id) ON DELETE CASCADE,
      sender_email TEXT NOT NULL,
      subject TEXT,
      message_id TEXT,
      attachment_count INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'quarantined',
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS inbox_incoming_messages (
      id TEXT PRIMARY KEY NOT NULL,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES fields(id) ON DELETE CASCADE,
      inbox_address_id TEXT NOT NULL REFERENCES inbox_addresses(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      attachment_sha256 TEXT NOT NULL,
      import_job_id TEXT REFERENCES import_jobs(id) ON DELETE SET NULL,
      sender_email TEXT NOT NULL,
      subject TEXT,
      received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(organization_id, message_id, attachment_sha256)
    );

    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES (
      'google:inbox-owner', 'google', 'inbox-owner',
      'owner-a@example.com', 'owner-a@example.com', 'Owner A', 1, 1
    );
    INSERT INTO organizations (
      id, name, kind, plan_code, field_limit, paddock_limit, self_service_owner_email
    ) VALUES (
      'inbox-org-a', 'Fundo Inbox A', 'shared', 'pro', 5, 100, 'owner-a@example.com'
    );
    INSERT INTO fields (
      id, organization_id, name, location, is_demo, area_hectares, coordinates
    ) VALUES (
      'inbox-field-a', 'inbox-org-a', 'Fundo El Roble', 'Osorno', 0, 100, '[]'
    );
    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name, role, status, created_by
    ) VALUES (
      'inbox-member-a', 'inbox-org-a', 'owner-a@example.com', 'owner-a@example.com', 'Owner A', 'owner', 'active', 'test'
    );
  `);

  d1 = new TestD1Database(sqlite);
  r2 = new TestR2Bucket();
  globalThis.__FUNDOSMART_INBOX_TEST_ENV__ = { DB: d1, FILES: r2 };
  const virtualWorkers = "\0fundosmart-inbox-cloudflare-workers";

  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
    plugins: [{
      name: "fundosmart-inbox-cloudflare-workers",
      enforce: "pre",
      resolveId(id) {
        if (id === "cloudflare:workers") return virtualWorkers;
      },
      load(id) {
        if (id === virtualWorkers) {
          return "export const env = globalThis.__FUNDOSMART_INBOX_TEST_ENV__";
        }
      },
    }],
  });

  inboxRepo = await vite.ssrLoadModule("/src/modules/importaciones/server/inbox-repository.ts");
});

after(async () => {
  await vite?.close();
  sqlite?.close();
});

test("inbox address creation and rotation invalidates previous address", async () => {
  const addr1 = await inboxRepo.createOrGetActiveInboxAddress({ access: actorA, fieldId: "inbox-field-a" });
  assert.ok(addr1.emailAddress.includes("inbox-"));
  assert.equal(addr1.status, "active");

  const addrSame = await inboxRepo.createOrGetActiveInboxAddress({ access: actorA, fieldId: "inbox-field-a" });
  assert.equal(addrSame.id, addr1.id);

  // Rotate
  const addr2 = await inboxRepo.rotateInboxAddress({ access: actorA, fieldId: "inbox-field-a" });
  assert.notEqual(addr2.id, addr1.id);
  assert.equal(addr2.status, "active");

  // Attempting to send to revoked addr1 fails as invalid_recipient
  const resultRevoked = await inboxRepo.processIncomingEmailMessage({
    recipientAddress: addr1.emailAddress,
    senderEmail: "lab@example.com",
    subject: "Prueba revoked",
    attachments: [{ filename: "test.csv", data: new Uint8Array([1, 2, 3]) }],
  });
  assert.equal(resultRevoked.outcome, "invalid_recipient");
});

test("whitelist enforcement and quarantine for unauthorized senders", async () => {
  const addr = await inboxRepo.getActiveInboxAddress({ access: actorA, fieldId: "inbox-field-a" });
  assert.ok(addr);

  // Sender not whitelisted -> Quarantine
  const resultUnauth = await inboxRepo.processIncomingEmailMessage({
    recipientAddress: addr.emailAddress,
    senderEmail: "unknown-lab@example.com",
    subject: "Resultados Leche",
    messageId: "msg-unauth-1",
    attachments: [{ filename: "control.csv", data: new Uint8Array([65, 66, 67]) }],
  });
  assert.equal(resultUnauth.outcome, "quarantined");
  assert.equal(resultUnauth.reason, "unauthorized_sender");

  const quarantineList = await inboxRepo.listQuarantineMessages({ access: actorA, fieldId: "inbox-field-a" });
  assert.equal(quarantineList.length, 1);
  assert.equal(quarantineList[0].senderEmail, "unknown-lab@example.com");

  // Add to whitelist
  await inboxRepo.addWhitelistedSender({ access: actorA, senderEmail: "known-lab@example.com", label: "Laboratorio Central" });
  const whitelist = await inboxRepo.listWhitelistedSenders({ access: actorA });
  assert.equal(whitelist.length, 1);
  assert.equal(whitelist[0].senderEmail, "known-lab@example.com");

  // Send from whitelisted sender -> Staged
  const resultAuth = await inboxRepo.processIncomingEmailMessage({
    recipientAddress: addr.emailAddress,
    senderEmail: "known-lab@example.com",
    subject: "Resultados Leche Validos",
    messageId: "msg-auth-1",
    attachments: [{ filename: "control.xlsx", data: new Uint8Array([80, 75, 3, 4]) }],
  });

  assert.equal(resultAuth.outcome, "staged");
  assert.ok(resultAuth.importJobIds?.length === 1);

  // Re-send same messageId and attachment -> Duplicate
  const resultDup = await inboxRepo.processIncomingEmailMessage({
    recipientAddress: addr.emailAddress,
    senderEmail: "known-lab@example.com",
    subject: "Resultados Leche Validos Re-send",
    messageId: "msg-auth-1",
    attachments: [{ filename: "control.xlsx", data: new Uint8Array([80, 75, 3, 4]) }],
  });
  assert.equal(resultDup.outcome, "duplicate");

  // Remove from whitelist
  await inboxRepo.removeWhitelistedSender({ access: actorA, senderId: whitelist[0].id });
  const emptyWhitelist = await inboxRepo.listWhitelistedSenders({ access: actorA });
  assert.equal(emptyWhitelist.length, 0);
});

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
    return { results: this.database.prepare(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.bindings) ?? null;
    return column && row ? row[column] ?? null : row;
  }

  async raw(options = {}) {
    const statement = this.database.prepare(this.sql);
    statement.setReturnArrays(true);
    const rows = statement.all(...this.bindings);
    return options.columnNames ? [statement.columns().map((column) => column.name), ...rows] : rows;
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.bindings);
    return {
      success: true,
      meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) },
    };
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
    this.database.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) {
        results.push(/^\s*(SELECT|PRAGMA|WITH|EXPLAIN)/i.test(statement.sql)
          ? await statement.all()
          : await statement.run());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async exec(sql) {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }
}

class TestR2Bucket {
  constructor() {
    this.objects = new Map();
  }

  async put(key, bytes, options = {}) {
    if (options.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const storedBytes = Uint8Array.from(new Uint8Array(bytes));
    const httpEtag = `"test-${storedBytes.byteLength}"`;
    this.objects.set(key, {
      bytes: storedBytes,
      customMetadata: { ...(options.customMetadata ?? {}) },
      checksums: options.sha256 ? { sha256: Uint8Array.from(Buffer.from(String(options.sha256), "hex")).buffer } : {},
      httpEtag,
    });
    return { httpEtag };
  }

  async head(key) {
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata }, checksums: { ...stored.checksums }, httpEtag: stored.httpEtag } : null;
  }

  async get(key) {
    const stored = this.objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata }, checksums: { ...stored.checksums }, httpEtag: stored.httpEtag, arrayBuffer: async () => stored.bytes.slice().buffer } : null;
  }

  async delete(key) {
    this.objects.delete(key);
  }
}
