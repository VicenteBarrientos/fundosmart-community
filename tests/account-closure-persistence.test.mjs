import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import ts from "typescript";
import * as closureDomain from "../src/modules/account-lifecycle/account-closure.mjs";

const root = path.resolve(import.meta.dirname, "..");
const repositoryUrl = new URL(
  "../src/modules/account-lifecycle/server/account-closure-repository.ts",
  import.meta.url,
);
const identityA = {
  subject: "google:subject-a",
  email: "Owner.A@Example.com",
};
const identityB = {
  subject: "google:subject-b",
  email: "manager.b@example.com",
};
const requestedAt = "2099-07-29T12:00:00.000Z";

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
        "@/app/auth-core.mjs": {
          normalizeAuthEmail: (value) => String(value ?? "").trim().toLowerCase(),
        },
        "@/src/modules/account-lifecycle/account-closure.mjs": closureDomain,
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
  seedWorkspace(sqlite);
  d1 = new TestD1Database(sqlite);
});

afterEach(() => {
  sqlite.close();
});

test("account closure suspends every own membership, revokes sessions, and restores exact ACL", async () => {
  const before = accountAcl("owner.a@example.com");
  assert.throws(
    () => sqlite.prepare(`
      UPDATE organization_memberships
      SET status = 'suspended'
      WHERE id = 'membership-a-org-a'
    `).run(),
    /LAST_ACTIVE_OWNER/u,
  );

  const closure = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-account-close",
    requestedAt,
    idFactory: ids("account"),
  });

  assert.equal(closure.status, "grace");
  assert.equal(d1.batchCalls, 2);
  assert.equal(d1.lastBatch.length, 5);
  assert.match(d1.lastBatch.at(-1).sql, /abs\(-9223372036854775807 - 1\)/u);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT id, status, closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE normalized_email = 'owner.a@example.com'
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      { id: "membership-a-org-a", status: "suspended", closureRequestId: closure.id },
      { id: "membership-a-org-b", status: "suspended", closureRequestId: closure.id },
    ],
  );
  assert.equal(sessionCount(identityA.subject), 0);
  assert.equal(sessionCount(identityB.subject), 1);
  assert.throws(
    () => sqlite.prepare(`
      UPDATE organization_memberships SET role = 'admin'
      WHERE id = 'membership-a-org-a'
    `).run(),
    /ACCOUNT_CLOSURE_MEMBERSHIP_FROZEN/u,
  );
  assert.throws(
    () => sqlite.prepare(`
      DELETE FROM membership_field_access
      WHERE id = 'access-a-org-a'
    `).run(),
    /ACCOUNT_CLOSURE_FIELD_ACCESS_FROZEN/u,
  );

  const replay = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-account-close",
    requestedAt,
    idFactory: ids("unused"),
  });
  assert.equal(replay.id, closure.id);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM personal_data_events
      WHERE event_type = 'account.closure.requested'
    `).get().count,
    1,
  );

  insertSession(identityA.subject, "c");
  const revoked = await repository.revokeAccountClosure(d1, {
    actor: identityA,
    closureRequestId: closure.id,
    requestId: "request-account-revoke",
    revokedAt: closure.graceEndsAt,
    idFactory: ids("revoke-account"),
  });

  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedAt, closure.graceEndsAt);
  assert.deepEqual(accountAcl("owner.a@example.com"), before);
  assert.equal(sessionCount(identityA.subject), 1);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT token_hash AS tokenHash FROM auth_sessions
      WHERE identity_id = ?
    `).all(identityA.subject).map((row) => ({ ...row })),
    [{ tokenHash: "c".repeat(64) }],
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM personal_data_events
      WHERE entity_id = ?
    `).get(closure.id).count,
    2,
  );
  await assert.rejects(
    repository.requestAccountClosure(d1, {
      actor: identityA,
      scope: "account",
      targetId: identityA.subject,
      requestId: "request-account-close",
      requestedAt,
      idFactory: ids("revoked-replay"),
    }),
    (error) =>
      error instanceof repository.AccountClosurePersistenceError
      && error.code === "ACCOUNT_CLOSURE_REQUEST_REVOKED",
  );
  assert.equal(tableCount("account_closure_requests"), 1);
  assert.equal(tableCount("personal_data_events"), 2);
  assert.throws(
    () => sqlite.prepare(`
      UPDATE organization_memberships
      SET status = 'suspended'
      WHERE id = 'membership-a-org-a'
    `).run(),
    /LAST_ACTIVE_OWNER/u,
  );
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("organization closure is owner-only, tenant-scoped, and preserves all sessions", async () => {
  await assert.rejects(
    repository.requestAccountClosure(d1, {
      actor: identityB,
      scope: "organization",
      targetId: "org-a",
      requestId: "request-org-forbidden",
      requestedAt,
      organizationConfirmation: "Organization A",
      idFactory: ids("forbidden"),
    }),
    (error) =>
      error instanceof repository.AccountClosurePersistenceError
      && error.code === "ACCOUNT_CLOSURE_OWNER_REQUIRED",
  );
  assert.equal(tableCount("account_closure_requests"), 0);

  const before = organizationAcl("org-a");
  const sessionsBefore = tableCount("auth_sessions");
  const closure = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "organization",
    targetId: "org-a",
    requestId: "request-org-close",
    requestedAt,
    organizationConfirmation: "Organization A",
    idFactory: ids("organization"),
  });

  assert.equal(sessionCount(identityA.subject), 2);
  assert.equal(tableCount("auth_sessions"), sessionsBefore);
  assert.deepEqual(
    sqlite.prepare(`
      SELECT id, status FROM organization_memberships
      WHERE organization_id = 'org-a'
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      { id: "membership-a-org-a", status: "suspended" },
      { id: "membership-b-org-a", status: "suspended" },
    ],
  );
  assert.equal(
    sqlite.prepare(`
      SELECT status FROM organization_memberships
      WHERE id = 'membership-a-org-b'
    `).get().status,
    "suspended",
  );
  assert.throws(
    () => sqlite.prepare(`
      INSERT INTO organization_memberships (
        id, organization_id, user_email, normalized_email, display_name,
        role, status, created_by, created_at, updated_at
      ) VALUES (
        'membership-new', 'org-a', 'new@example.com', 'new@example.com',
        'New', 'viewer', 'active', 'owner.a@example.com',
        '2099-07-29T12:00:00.000Z', '2099-07-29T12:00:00.000Z'
      )
    `).run(),
    /ACCOUNT_CLOSURE_TARGET_FROZEN/u,
  );

  await repository.revokeAccountClosure(d1, {
    actor: identityA,
    closureRequestId: closure.id,
    requestId: "request-org-revoke",
    revokedAt: "2099-08-01T12:00:00.000Z",
    idFactory: ids("revoke-organization"),
  });
  assert.deepEqual(organizationAcl("org-a"), before);
  assert.equal(tableCount("auth_sessions"), sessionsBefore);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("organization confirmation is exact and remains bound to the mutation batch", async () => {
  await assert.rejects(
    repository.requestAccountClosure(d1, {
      actor: identityA,
      scope: "organization",
      targetId: "org-a",
      requestId: "request-org-wrong-name",
      requestedAt,
      organizationConfirmation: "Organization B",
      idFactory: ids("wrong-name"),
    }),
    (error) =>
      error instanceof repository.AccountClosurePersistenceError
      && error.code === "CLOSURE_CONFIRMATION_MISMATCH",
  );
  assert.equal(tableCount("account_closure_requests"), 0);
  assert.equal(tableCount("personal_data_events"), 0);

  const mutationBatchCall = d1.batchCalls + 2;
  d1.beforeBatch = (nextBatchCall) => {
    if (nextBatchCall === mutationBatchCall) {
      sqlite.prepare(`
        UPDATE organizations SET name = 'Renamed Organization' WHERE id = 'org-a'
      `).run();
    }
  };
  await assert.rejects(
    repository.requestAccountClosure(d1, {
      actor: identityA,
      scope: "organization",
      targetId: "org-a",
      requestId: "request-org-renamed",
      requestedAt,
      organizationConfirmation: "Organization A",
      idFactory: ids("renamed"),
    }),
    (error) =>
      error instanceof repository.AccountClosurePersistenceError
      && error.code === "ACCOUNT_CLOSURE_NOT_REQUESTED",
  );
  assert.equal(tableCount("account_closure_requests"), 0);
  assert.equal(tableCount("personal_data_events"), 0);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM organization_memberships
      WHERE closure_request_id IS NOT NULL
    `).get().count,
    0,
  );
  assert.equal(sessionCount(identityA.subject), 2);
});

test("pre-commit reauthorization aborts request and revocation without partial writes", async () => {
  const requestStopped = new Error("request authorization changed");
  await assert.rejects(
    repository.requestAccountClosure(d1, {
      actor: identityA,
      scope: "account",
      targetId: identityA.subject,
      requestId: "request-precommit-stopped",
      requestedAt,
      beforeCommit: async () => {
        throw requestStopped;
      },
      idFactory: ids("precommit-request"),
    }),
    (error) => error === requestStopped,
  );
  assert.equal(tableCount("account_closure_requests"), 0);
  assert.equal(tableCount("personal_data_events"), 0);
  assert.equal(sessionCount(identityA.subject), 2);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM organization_memberships
      WHERE closure_request_id IS NOT NULL
    `).get().count,
    0,
  );

  const closure = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-precommit-created",
    requestedAt,
    idFactory: ids("precommit-created"),
  });
  insertSession(identityA.subject, "f");
  const revokeStopped = new Error("revocation authorization changed");
  await assert.rejects(
    repository.revokeAccountClosure(d1, {
      actor: identityA,
      closureRequestId: closure.id,
      requestId: "request-precommit-revoke-stopped",
      revokedAt: "2099-08-01T12:00:00.000Z",
      beforeCommit: async () => {
        throw revokeStopped;
      },
      idFactory: ids("precommit-revoke"),
    }),
    (error) => error === revokeStopped,
  );
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT status, revoked_at AS revokedAt, version
      FROM account_closure_requests WHERE id = ?
    `).get(closure.id) },
    { status: "grace", revokedAt: null, version: 1 },
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM personal_data_events
      WHERE event_type = 'account.closure.revoked'
    `).get().count,
    0,
  );
  assert.equal(sessionCount(identityA.subject), 1);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM organization_memberships
      WHERE closure_request_id = ? AND status = 'suspended'
    `).get(closure.id).count,
    2,
  );
});

test("revocation after the exact grace boundary fails closed and keeps suspension", async () => {
  const closure = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-expiring-close",
    requestedAt,
    idFactory: ids("expiring"),
  });
  insertSession(identityA.subject, "d");

  await assert.rejects(
    repository.revokeAccountClosure(d1, {
      actor: identityA,
      closureRequestId: closure.id,
      requestId: "request-expired-revoke",
      revokedAt: "2099-08-28T12:00:00.001Z",
      idFactory: ids("late"),
    }),
    (error) =>
      error instanceof closureDomain.AccountClosureError
      && error.code === "GRACE_WINDOW_EXPIRED",
  );
  assert.equal(
    sqlite.prepare(`
      SELECT status FROM account_closure_requests WHERE id = ?
    `).get(closure.id).status,
    "grace",
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM organization_memberships
      WHERE closure_request_id = ?
    `).get(closure.id).count,
    2,
  );
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM personal_data_events
      WHERE event_type = 'account.closure.revoked'
    `).get().count,
    0,
  );
});

test("account and organization grace overlays coexist and restore in either order", async () => {
  sqlite.prepare(`
    UPDATE organization_memberships
    SET role = 'owner'
    WHERE id = 'membership-b-org-a'
  `).run();
  const beforeAccount = accountAcl("owner.a@example.com");
  const beforeOrganization = organizationAcl("org-a");
  const account = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-overlap-account",
    requestedAt,
    idFactory: ids("overlap-account"),
  });
  const organization = await repository.requestAccountClosure(d1, {
    actor: identityB,
    scope: "organization",
    targetId: "org-a",
    requestId: "request-overlap-organization",
    requestedAt: "2099-07-30T12:00:00.000Z",
    organizationConfirmation: "Organization A",
    idFactory: ids("overlap-organization"),
  });

  assert.equal(
    sqlite.prepare(`
      SELECT closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get().closureRequestId,
    account.id,
  );
  await repository.revokeAccountClosure(d1, {
    actor: identityA,
    closureRequestId: account.id,
    requestId: "request-overlap-account-revoke",
    revokedAt: "2099-08-01T12:00:00.000Z",
    idFactory: ids("overlap-account-revoke"),
  });
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT status, closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get() },
    { status: "suspended", closureRequestId: organization.id },
  );
  await repository.revokeAccountClosure(d1, {
    actor: identityB,
    closureRequestId: organization.id,
    requestId: "request-overlap-organization-revoke",
    revokedAt: "2099-08-02T12:00:00.000Z",
    idFactory: ids("overlap-organization-revoke"),
  });
  assert.deepEqual(accountAcl("owner.a@example.com"), beforeAccount);
  assert.deepEqual(organizationAcl("org-a"), beforeOrganization);
});

test("an organization overlay can precede an account overlay without losing base state", async () => {
  sqlite.prepare(`
    UPDATE organization_memberships
    SET role = 'owner'
    WHERE id = 'membership-b-org-a'
  `).run();
  const beforeAccount = accountAcl("owner.a@example.com");
  const beforeOrganization = organizationAcl("org-a");
  const organization = await repository.requestAccountClosure(d1, {
    actor: identityB,
    scope: "organization",
    targetId: "org-a",
    requestId: "request-inverse-organization",
    requestedAt,
    organizationConfirmation: "Organization A",
    idFactory: ids("inverse-organization"),
  });
  const account = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-inverse-account",
    requestedAt: "2099-07-30T12:00:00.000Z",
    idFactory: ids("inverse-account"),
  });

  await repository.revokeAccountClosure(d1, {
    actor: identityB,
    closureRequestId: organization.id,
    requestId: "request-inverse-organization-revoke",
    revokedAt: "2099-08-01T12:00:00.000Z",
    idFactory: ids("inverse-organization-revoke"),
  });
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT status, closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get() },
    { status: "suspended", closureRequestId: account.id },
  );
  await repository.revokeAccountClosure(d1, {
    actor: identityA,
    closureRequestId: account.id,
    requestId: "request-inverse-account-revoke",
    revokedAt: "2099-08-02T12:00:00.000Z",
    idFactory: ids("inverse-account-revoke"),
  });
  assert.deepEqual(accountAcl("owner.a@example.com"), beforeAccount);
  assert.deepEqual(organizationAcl("org-a"), beforeOrganization);
});

test("an expired account closure no longer freezes tenant ACL or blocks an organization closure", async () => {
  sqlite.prepare(`
    UPDATE organization_memberships
    SET role = 'owner'
    WHERE id = 'membership-b-org-a'
  `).run();
  const account = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-expired-account-overlap",
    requestedAt: "2025-01-01T00:00:00.000Z",
    idFactory: ids("expired-account-overlap"),
  });
  assert.equal(account.graceEndsAt, "2025-01-31T00:00:00.000Z");
  assert.doesNotThrow(() => sqlite.prepare(`
    DELETE FROM membership_field_access
    WHERE id = 'access-a-org-b'
  `).run());

  const organization = await repository.requestAccountClosure(d1, {
    actor: identityB,
    scope: "organization",
    targetId: "org-a",
    requestId: "request-after-expired-account",
    requestedAt,
    organizationConfirmation: "Organization A",
    idFactory: ids("after-expired-account"),
  });
  assert.equal(organization.status, "grace");
  assert.equal(
    sqlite.prepare(`
      SELECT closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get().closureRequestId,
    account.id,
  );
  assert.throws(
    () => sqlite.prepare(`
      DELETE FROM membership_field_access
      WHERE id = 'access-a-org-a'
    `).run(),
    /ACCOUNT_CLOSURE_FIELD_ACCESS_FROZEN/u,
  );
  await repository.revokeAccountClosure(d1, {
    actor: identityB,
    closureRequestId: organization.id,
    requestId: "request-after-expired-account-revoke",
    revokedAt: "2099-08-01T12:00:00.000Z",
    idFactory: ids("after-expired-account-revoke"),
  });
  assert.deepEqual(
    sqlite.prepare(`
      SELECT id, status, closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE organization_id = 'org-a'
      ORDER BY id
    `).all().map((row) => ({ ...row })),
    [
      {
        id: "membership-a-org-a",
        status: "suspended",
        closureRequestId: account.id,
      },
      {
        id: "membership-b-org-a",
        status: "active",
        closureRequestId: null,
      },
    ],
  );
});

test("an overlay that expires during another grace remains the durable suspension", async () => {
  sqlite.prepare(`
    UPDATE organization_memberships
    SET role = 'owner'
    WHERE id = 'membership-b-org-a'
  `).run();
  const account = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-overlap-expiring-account",
    requestedAt: "2099-07-01T12:00:00.000Z",
    idFactory: ids("overlap-expiring-account"),
  });
  const organization = await repository.requestAccountClosure(d1, {
    actor: identityB,
    scope: "organization",
    targetId: "org-a",
    requestId: "request-overlap-after-account",
    requestedAt: "2099-07-15T12:00:00.000Z",
    organizationConfirmation: "Organization A",
    idFactory: ids("overlap-after-account"),
  });

  await repository.revokeAccountClosure(d1, {
    actor: identityB,
    closureRequestId: organization.id,
    requestId: "request-overlap-after-account-revoke",
    revokedAt: "2099-08-01T12:00:00.000Z",
    idFactory: ids("overlap-after-account-revoke"),
  });
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT status, closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get() },
    { status: "suspended", closureRequestId: account.id },
  );
});

test("an expired organization overlay survives a later account revocation", async () => {
  const organization = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "organization",
    targetId: "org-a",
    requestId: "request-expired-organization-first",
    requestedAt: "2025-01-01T00:00:00.000Z",
    organizationConfirmation: "Organization A",
    idFactory: ids("expired-organization-first"),
  });
  const account = await repository.requestAccountClosure(d1, {
    actor: identityA,
    scope: "account",
    targetId: identityA.subject,
    requestId: "request-account-after-expired-organization",
    requestedAt,
    idFactory: ids("account-after-expired-organization"),
  });

  await repository.revokeAccountClosure(d1, {
    actor: identityA,
    closureRequestId: account.id,
    requestId: "request-account-after-expired-organization-revoke",
    revokedAt: "2099-08-01T12:00:00.000Z",
    idFactory: ids("account-after-expired-organization-revoke"),
  });
  assert.deepEqual(
    { ...sqlite.prepare(`
      SELECT status, closure_request_id AS closureRequestId
      FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get() },
    { status: "suspended", closureRequestId: organization.id },
  );
});

test("a snapshot race aborts request, event, suspension, and session revocation together", async () => {
  d1.beforeBatch = (nextBatchCall) => {
    if (nextBatchCall === 2) {
      sqlite.prepare(`
        DELETE FROM membership_field_access WHERE id = 'access-a-org-a'
      `).run();
    }
  };
  await assert.rejects(
    repository.requestAccountClosure(d1, {
      actor: identityA,
      scope: "account",
      targetId: identityA.subject,
      requestId: "request-raced-close",
      requestedAt,
      idFactory: ids("raced"),
    }),
    (error) =>
      error instanceof repository.AccountClosurePersistenceError
      && error.code === "ACCOUNT_CLOSURE_NOT_REQUESTED",
  );
  assert.equal(tableCount("account_closure_requests"), 0);
  assert.equal(tableCount("personal_data_events"), 0);
  assert.equal(
    sqlite.prepare(`
      SELECT COUNT(*) AS count FROM organization_memberships
      WHERE closure_request_id IS NOT NULL
    `).get().count,
    0,
  );
  assert.equal(
    sqlite.prepare(`
      SELECT status FROM organization_memberships
      WHERE id = 'membership-a-org-a'
    `).get().status,
    "active",
  );
  assert.equal(sessionCount(identityA.subject), 2);
});

function seedWorkspace(database) {
  database.exec(`
    INSERT INTO auth_identities (
      id, provider, provider_subject, email, normalized_email, display_name,
      created_at, updated_at
    ) VALUES
      ('google:subject-a', 'google', 'subject-a', 'Owner.A@Example.com',
        'owner.a@example.com', 'Owner A', 100, 100),
      ('google:subject-b', 'google', 'subject-b', 'manager.b@example.com',
        'manager.b@example.com', 'Manager B', 100, 100);

    INSERT INTO organizations (id, name, kind) VALUES
      ('org-a', 'Organization A', 'shared'),
      ('org-b', 'Organization B', 'shared');

    INSERT INTO fields (id, organization_id, name, location, is_demo) VALUES
      ('field-a', 'org-a', 'Field A', '', 0),
      ('field-b', 'org-b', 'Field B', '', 0);

    INSERT INTO organization_memberships (
      id, organization_id, user_email, normalized_email, display_name,
      role, status, created_by, created_at, updated_at
    ) VALUES
      ('membership-a-org-a', 'org-a', 'Owner.A@Example.com',
        'owner.a@example.com', 'Owner A', 'owner', 'active', 'system',
        '2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'),
      ('membership-b-org-a', 'org-a', 'manager.b@example.com',
        'manager.b@example.com', 'Manager B', 'manager', 'active', 'system',
        '2026-01-02T00:00:00.000Z', '2026-02-02T00:00:00.000Z'),
      ('membership-a-org-b', 'org-b', 'Owner.A@Example.com',
        'owner.a@example.com', 'Owner A', 'viewer', 'suspended', 'system',
        '2026-01-03T00:00:00.000Z', '2026-02-03T00:00:00.000Z');

    INSERT INTO membership_field_access (
      id, membership_id, field_id, created_by, created_at
    ) VALUES
      ('access-a-org-a', 'membership-a-org-a', 'field-a', 'system',
        '2026-01-04T00:00:00.000Z'),
      ('access-b-org-a', 'membership-b-org-a', 'field-a', 'system',
        '2026-01-05T00:00:00.000Z'),
      ('access-a-org-b', 'membership-a-org-b', 'field-b', 'system',
        '2026-01-06T00:00:00.000Z');

    INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at)
    VALUES
      ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'google:subject-a', 100, 1000),
      ('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'google:subject-a', 101, 1000),
      ('eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        'google:subject-b', 100, 1000);
  `);
}

function accountAcl(normalizedEmail) {
  return sqlite.prepare(`
    SELECT
      membership.id,
      membership.organization_id AS organizationId,
      membership.role,
      membership.status,
      membership.created_at AS createdAt,
      membership.updated_at AS updatedAt,
      membership.closure_request_id AS closureRequestId,
      COALESCE((
        SELECT json_group_array(field_id)
        FROM (
          SELECT field_id
          FROM membership_field_access
          WHERE membership_id = membership.id
          ORDER BY field_id
        )
      ), '[]') AS fieldIds
    FROM organization_memberships AS membership
    WHERE membership.normalized_email = ?
    ORDER BY membership.id
  `).all(normalizedEmail);
}

function organizationAcl(organizationId) {
  return sqlite.prepare(`
    SELECT
      membership.id,
      membership.role,
      membership.status,
      membership.created_at AS createdAt,
      membership.updated_at AS updatedAt,
      membership.closure_request_id AS closureRequestId,
      COALESCE((
        SELECT json_group_array(field_id)
        FROM (
          SELECT field_id
          FROM membership_field_access
          WHERE membership_id = membership.id
          ORDER BY field_id
        )
      ), '[]') AS fieldIds
    FROM organization_memberships AS membership
    WHERE membership.organization_id = ?
    ORDER BY membership.id
  `).all(organizationId);
}

function insertSession(identityId, character) {
  sqlite.prepare(`
    INSERT INTO auth_sessions (token_hash, identity_id, created_at, expires_at)
    VALUES (?, ?, 200, 2000)
  `).run(character.repeat(64), identityId);
}

function sessionCount(identityId) {
  return Number(sqlite.prepare(`
    SELECT COUNT(*) AS count FROM auth_sessions WHERE identity_id = ?
  `).get(identityId).count);
}

function tableCount(table) {
  assert.match(table, /^[a-z_]+$/u);
  return Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count);
}

function ids(prefix) {
  let sequence = 0;
  return (label) => `${prefix}-${label}-${++sequence}`;
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
      results: [],
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
    this.beforeBatch = null;
  }

  prepare(sql) {
    return new TestD1PreparedStatement(this.database, sql);
  }

  withSession(mode) {
    this.sessions.push(mode);
    return this;
  }

  async batch(statements) {
    const nextBatchCall = this.batchCalls + 1;
    if (this.beforeBatch) this.beforeBatch(nextBatchCall);
    this.batchCalls = nextBatchCall;
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
