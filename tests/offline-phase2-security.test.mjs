import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  issueOfflineSession,
  verifyOfflineSession,
} from "../src/modules/offline/server/offline-session.ts";
import {
  OfflineAttachmentError,
  preserveOfflineAttachment,
} from "../src/modules/offline/server/offline-attachment-repository.ts";

const actor = {
  membershipId: "membership-a",
  organizationId: "organization-a",
  email: "operator@example.com",
  displayName: "Operador",
  role: "operator",
  fieldIds: ["field-b", "field-a"],
};
const secret = "offline-session-test-secret-with-32-bytes-minimum";

test("short-lived offline sessions are signed, scoped and contain no Access identity", async () => {
  const now = new Date("2026-07-21T12:00:00.000Z");
  const session = await issueOfflineSession({ actor, accountMode: "personal", secret, now });
  assert.equal(session.organizationId, actor.organizationId);
  assert.deepEqual(session.fieldIds, ["field-a", "field-b"]);
  assert.match(session.userSubject, /^[a-f0-9]{64}$/u);
  assert.equal("email" in session, false);
  assert.doesNotMatch(session.token, /operator|example/iu);
  assert.equal((await verifyOfflineSession({ token: session.token, secret, actor, now }))?.sessionId, session.sessionId);
  assert.equal(await verifyOfflineSession({ token: `${session.token.slice(0, -1)}x`, secret, actor, now }), null);
  assert.equal(await verifyOfflineSession({ token: session.token, secret, actor: { ...actor, organizationId: "organization-b" }, now }), null);
  assert.equal(await verifyOfflineSession({ token: session.token, secret, actor, now: new Date("2026-07-21T18:00:01.000Z") }), null);
});

test("offline session secret and lifetime are bounded", async () => {
  await assert.rejects(issueOfflineSession({ actor, accountMode: "personal", secret: "short" }), /32 bytes/iu);
  await assert.rejects(issueOfflineSession({ actor, accountMode: "personal", secret, ttlSeconds: 24 * 60 * 60 }), /vigencia/iu);
});

test("offline basemap prefetch is disabled and the legacy cache is removed", async () => {
  const [policy, terrain, worker] = await Promise.all([
    readFile(new URL("../src/core/maps/tile-policy.mjs", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/ganado/components/TerrenoSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("../public/sw.js", import.meta.url), "utf8"),
  ]);
  assert.match(policy, /enabled: false/u);
  assert.match(policy, /self_hosted_pmtiles_on_r2/u);
  assert.match(policy, /prefetchAllowed: false/u);
  assert.doesNotMatch(terrain, /cacheOfflineTileRegion|Descargar mapa cercano/u);
  assert.match(terrain, /capturas y fotos pendientes se conservan localmente/u);
  assert.match(worker, /LEGACY_OFFLINE_TILE_CACHES/u);
  assert.match(worker, /LEGACY_OFFLINE_TILE_CACHES\.includes\(key\)/u);
  assert.doesNotMatch(worker, /isOfflineTileRequest|readOfflineTile/u);
});

test("attachments are immutable, tenant-scoped and do not block the data outbox", async () => {
  const [route, repository, queue, terrain, vite] = await Promise.all([
    readFile(new URL("../app/api/offline/attachments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/offline/server/offline-attachment-repository.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/core/offline/mutation-queue.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/ganado/components/TerrenoSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
  ]);
  assert.match(route, /authorizeApiAccess\("operate", fieldId\)/u);
  assert.match(route, /preserveOfflineAttachment/u);
  assert.match(repository, /offline\/\$\{encodeURIComponent\(input\.actor\.organizationId\)\}/u);
  assert.match(repository, /onlyIf: \{ etagDoesNotMatch: "\*" \}/u);
  assert.match(repository, /sha256/u);
  assert.match(route, /env\.FILES/u);
  assert.match(vite, /images:\s*\{\s*binding: "IMAGES"/u);
  assert.doesNotMatch(route, /env\.IMAGES|_vinext\/image/u);
  assert.doesNotMatch(repository, /IMAGES|_vinext\/image/u);
  assert.match(repository, /mutation\.status = 'applied'/u);
  assert.match(repository, /mutation\.actor = current_access\.normalized_email/u);
  assert.match(repository, /json_extract\(mutation\.payload, '\$\.attachmentId'\) = \?/u);
  assert.match(repository, /uploadToken/u);
  assert.match(repository, /removeOwnedObject/u);
  assert.match(queue, /blob: null/u);
  assert.match(queue, /status: "applied"/u);
  assert.match(queue, /linkedSyncMutationStatus/u);
  assert.ok(terrain.indexOf("await sendOrQueueSyncMutations") < terrain.indexOf("await queueOfflineAttachment"), "the data mutation must be queued before the binary");
  assert.ok(terrain.indexOf("await flushOfflineMutations(offlineScope)") < terrain.indexOf("await flushOfflineAttachments(offlineScope)"), "the data outbox must finish before binary uploads");
});

test("R2 attachment preservation replays exact bytes and rejects collisions", async () => {
  const bucket = new MemoryR2();
  const db = new AppliedMutationD1({
    entityId: "livestock_health:01J00000000000000000000041",
    attachmentId: "01J00000000000000000000040",
  });
  const input = {
    bucket,
    db,
    actor,
    fieldId: "field-a",
    attachmentId: "01J00000000000000000000040",
    entityId: "livestock_health:01J00000000000000000000041",
    contentType: "image/jpeg",
    bytes: new Uint8Array([1, 2, 3, 4]),
  };
  const first = await preserveOfflineAttachment(input);
  assert.equal(first.replay, false);
  assert.equal(first.objectKey, "offline/organization-a/field-a/01J00000000000000000000040");
  assert.equal((await preserveOfflineAttachment(input)).replay, true);
  await assert.rejects(
    preserveOfflineAttachment({ ...input, bytes: new Uint8Array([9, 9, 9]) }),
    (cause) => cause instanceof OfflineAttachmentError && cause.status === 409,
  );
  await assert.rejects(
    preserveOfflineAttachment({ ...input, fieldId: "field-z", attachmentId: "01J00000000000000000000042" }),
    (cause) => cause instanceof OfflineAttachmentError && cause.status === 403,
  );
  await assert.rejects(
    preserveOfflineAttachment({ ...input, attachmentId: "01J00000000000000000000042" }),
    (cause) => cause instanceof OfflineAttachmentError && cause.status === 409,
  );
});

test("only the operator recorded on the applied mutation can win its attachment key", async () => {
  const bucket = new MemoryR2();
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(`
      CREATE TABLE fields (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL);
      CREATE TABLE organization_memberships (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, normalized_email TEXT NOT NULL,
        status TEXT NOT NULL, role TEXT NOT NULL
      );
      CREATE TABLE membership_field_access (membership_id TEXT NOT NULL, field_id TEXT NOT NULL);
      CREATE TABLE sync_mutations (
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, field_id TEXT NOT NULL, actor TEXT NOT NULL,
        entity_id TEXT NOT NULL, status TEXT NOT NULL, entity TEXT NOT NULL, payload TEXT NOT NULL
      );
      INSERT INTO fields VALUES ('field-a', 'organization-a');
      INSERT INTO organization_memberships VALUES
        ('membership-a', 'organization-a', 'operator@example.com', 'active', 'operator'),
        ('membership-b', 'organization-a', 'operator-b@example.com', 'active', 'operator');
      INSERT INTO membership_field_access VALUES ('membership-a', 'field-a'), ('membership-b', 'field-a');
      INSERT INTO sync_mutations VALUES (
        'mutation-a', 'organization-a', 'field-a', 'operator@example.com',
        'livestock_health:01J00000000000000000000051', 'applied', 'livestock_health',
        '{"attachmentId":"01J00000000000000000000050"}'
      );
    `);
    const db = new SqliteD1(sqlite);
    const common = {
      bucket,
      db,
      fieldId: "field-a",
      attachmentId: "01J00000000000000000000050",
      entityId: "livestock_health:01J00000000000000000000051",
      contentType: "image/jpeg",
      bytes: new Uint8Array([5, 0, 5, 0]),
    };
    const operatorB = {
      ...actor,
      membershipId: "membership-b",
      email: "operator-b@example.com",
    };
    await assert.rejects(preserveOfflineAttachment({ ...common, actor: operatorB }), isAttachmentStatus(409));
    assert.equal(bucket.size, 0);
    assert.equal((await preserveOfflineAttachment({ ...common, actor })).replay, false);
    assert.equal(bucket.size, 1);

    sqlite.prepare("UPDATE organization_memberships SET status='suspended' WHERE id='membership-a'").run();
    await assert.rejects(preserveOfflineAttachment({ ...common, actor }), isAttachmentStatus(403));
    assert.equal(bucket.size, 1, "a revoked replay must not delete the prior writer object");
  } finally {
    sqlite.close();
  }
});

test("attachment upload fails closed when access is revoked before, during or after the R2 put", async (t) => {
  const makeInput = (db, bucket, suffix) => ({
    bucket,
    db,
    actor,
    fieldId: "field-a",
    attachmentId: `01J00000000000000000000${suffix}`,
    entityId: `livestock_health:01J00000000000000000000${String(Number(suffix) + 1).padStart(3, "0")}`,
    contentType: "image/jpeg",
    bytes: new Uint8Array([Number(suffix), 2, 3]),
  });

  await t.test("before put", async () => {
    const bucket = new MemoryR2();
    const db = new AppliedMutationD1({
      entityId: "livestock_health:01J00000000000000000000061",
      attachmentId: "01J00000000000000000000060",
    });
    db.beforeCheck = (check) => {
      if (check === 2) db.authorized = false;
    };
    await assert.rejects(preserveOfflineAttachment(makeInput(db, bucket, "060")), isAttachmentStatus(403));
    assert.equal(bucket.size, 0);
  });

  await t.test("during put", async () => {
    const bucket = new MemoryR2();
    const db = new AppliedMutationD1({
      entityId: "livestock_health:01J00000000000000000000071",
      attachmentId: "01J00000000000000000000070",
    });
    bucket.afterPut = () => {
      db.authorized = false;
    };
    await assert.rejects(preserveOfflineAttachment(makeInput(db, bucket, "070")), isAttachmentStatus(403));
    assert.equal(bucket.size, 0);
    assert.equal(bucket.deleteCalls, 1);
  });

  await t.test("after put verification", async () => {
    const bucket = new MemoryR2();
    const db = new AppliedMutationD1({
      entityId: "livestock_health:01J00000000000000000000081",
      attachmentId: "01J00000000000000000000080",
    });
    db.beforeCheck = (check) => {
      if (check === 3) db.authorized = false;
    };
    await assert.rejects(preserveOfflineAttachment(makeInput(db, bucket, "080")), isAttachmentStatus(403));
    assert.equal(bucket.size, 0);
    assert.equal(bucket.deleteCalls, 1);
  });
});

test("a losing concurrent uploader never deletes the winning writer object", async () => {
  const bucket = new MemoryR2();
  const db = new AppliedMutationD1({
    entityId: "livestock_health:01J00000000000000000000091",
    attachmentId: "01J00000000000000000000090",
  });
  bucket.beforePut = (key, bytes, options) => {
    bucket.seed(key, bytes, { ...options.customMetadata, uploadToken: "concurrent-writer" });
    db.authorized = false;
  };
  const input = {
    bucket,
    db,
    actor,
    fieldId: "field-a",
    attachmentId: "01J00000000000000000000090",
    entityId: "livestock_health:01J00000000000000000000091",
    contentType: "image/jpeg",
    bytes: new Uint8Array([9, 0]),
  };
  await assert.rejects(preserveOfflineAttachment(input), isAttachmentStatus(403));
  assert.equal(bucket.deleteCalls, 0);
  assert.equal(bucket.object(input.attachmentId).customMetadata.uploadToken, "concurrent-writer");
});

test("an exact concurrent winner is returned as an idempotent replay", async () => {
  const bucket = new MemoryR2();
  const db = new AppliedMutationD1({
    entityId: "livestock_health:01J00000000000000000000121",
    attachmentId: "01J00000000000000000000120",
  });
  bucket.beforePut = (key, bytes, options) => {
    bucket.seed(key, bytes, { ...options.customMetadata, uploadToken: "concurrent-winner" });
  };
  const result = await preserveOfflineAttachment({
    bucket,
    db,
    actor,
    fieldId: "field-a",
    attachmentId: "01J00000000000000000000120",
    entityId: "livestock_health:01J00000000000000000000121",
    contentType: "image/jpeg",
    bytes: new Uint8Array([1, 2, 0]),
  });
  assert.equal(result.replay, true);
  assert.equal(bucket.deleteCalls, 0);
  assert.equal(bucket.object(result.id).customMetadata.uploadToken, "concurrent-winner");
});

test("R2 failures never report attachment success", async (t) => {
  await t.test("put failure", async () => {
    const bucket = new MemoryR2();
    bucket.failPut = true;
    const db = new AppliedMutationD1({
      entityId: "livestock_health:01J00000000000000000000101",
      attachmentId: "01J00000000000000000000100",
    });
    await assert.rejects(preserveOfflineAttachment({
      bucket,
      db,
      actor,
      fieldId: "field-a",
      attachmentId: "01J00000000000000000000100",
      entityId: "livestock_health:01J00000000000000000000101",
      contentType: "image/jpeg",
      bytes: new Uint8Array([1, 0, 0]),
    }), isAttachmentStatus(503));
    assert.equal(bucket.size, 0);
  });

  await t.test("cleanup failure", async () => {
    const bucket = new MemoryR2();
    bucket.failDelete = true;
    const db = new AppliedMutationD1({
      entityId: "livestock_health:01J00000000000000000000111",
      attachmentId: "01J00000000000000000000110",
    });
    bucket.afterPut = () => {
      db.authorized = false;
    };
    await assert.rejects(preserveOfflineAttachment({
      bucket,
      db,
      actor,
      fieldId: "field-a",
      attachmentId: "01J00000000000000000000110",
      entityId: "livestock_health:01J00000000000000000000111",
      contentType: "image/jpeg",
      bytes: new Uint8Array([1, 1, 0]),
    }), isAttachmentStatus(503));
    assert.equal(bucket.size, 1, "a failed cleanup remains private and is never returned as success");
  });

  await t.test("ambiguous put failure after storage", async () => {
    const bucket = new MemoryR2();
    bucket.throwAfterPut = true;
    const db = new AppliedMutationD1({
      entityId: "livestock_health:01J00000000000000000000131",
      attachmentId: "01J00000000000000000000130",
    });
    bucket.afterPut = () => {
      db.authorized = false;
    };
    await assert.rejects(preserveOfflineAttachment({
      bucket,
      db,
      actor,
      fieldId: "field-a",
      attachmentId: "01J00000000000000000000130",
      entityId: "livestock_health:01J00000000000000000000131",
      contentType: "image/jpeg",
      bytes: new Uint8Array([1, 3, 0]),
    }), isAttachmentStatus(403));
    assert.equal(bucket.size, 0);
    assert.equal(bucket.deleteCalls, 1);
  });
});

class AppliedMutationD1 {
  constructor(link) {
    this.link = { mutationActor: actor.email, ...link };
    this.authorized = true;
    this.checks = 0;
    this.beforeCheck = null;
  }

  prepare(sql) {
    assert.match(sql, /mutation\.actor = current_access\.normalized_email/u);
    return {
      bind: (...bindings) => ({
        first: async () => {
          this.checks += 1;
          this.beforeCheck?.(this.checks);
          const [membershipId, organizationId, email, demoEmail, authorizedFieldId, mutationOrganizationId,
            mutationFieldId, entityId, attachmentId] = bindings;
          const authorized = this.authorized
            && membershipId.startsWith("membership-")
            && organizationId === actor.organizationId
            && mutationOrganizationId === actor.organizationId
            && email !== demoEmail
            && authorizedFieldId === "field-a"
            && mutationFieldId === "field-a";
          const linked = authorized
            && entityId === this.link.entityId
            && attachmentId === this.link.attachmentId
            && email === this.link.mutationActor;
          return { authorized: authorized ? 1 : 0, mutationId: linked ? "applied-mutation" : null };
        },
      }),
    };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return {
      bind: (...bindings) => ({
        first: async () => this.database.prepare(sql).get(...bindings) ?? null,
      }),
    };
  }
}

class MemoryR2 {
  #objects = new Map();

  constructor() {
    this.beforePut = null;
    this.afterPut = null;
    this.failPut = false;
    this.throwAfterPut = false;
    this.failDelete = false;
    this.deleteCalls = 0;
  }

  get size() {
    return this.#objects.size;
  }

  object(attachmentId) {
    return this.#objects.get([...this.#objects.keys()].find((key) => key.endsWith(`/${attachmentId}`)));
  }

  seed(key, bytes, customMetadata) {
    this.#objects.set(key, { bytes: bytes.slice(), customMetadata: { ...customMetadata } });
  }

  async head(key) {
    const stored = this.#objects.get(key);
    return stored ? { size: stored.bytes.byteLength, customMetadata: { ...stored.customMetadata } } : null;
  }

  async put(key, bytes, options) {
    this.beforePut?.(key, bytes, options);
    if (this.failPut) throw new Error("R2 unavailable");
    if (this.#objects.has(key)) throw new Error("conditional collision");
    this.seed(key, bytes, options.customMetadata);
    this.afterPut?.(key);
    if (this.throwAfterPut) throw new Error("ambiguous R2 put failure");
    return this.head(key);
  }

  async delete(key) {
    this.deleteCalls += 1;
    if (this.failDelete) throw new Error("R2 delete unavailable");
    this.#objects.delete(key);
  }
}

function isAttachmentStatus(status) {
  return (cause) => cause instanceof OfflineAttachmentError && cause.status === status;
}
