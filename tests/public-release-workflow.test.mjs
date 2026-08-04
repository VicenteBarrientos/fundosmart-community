import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { load as parseYaml } from "js-yaml";

import {
  PUBLIC_RELEASE_CONTRACT,
  createDeterministicSourceArchive,
  validateLegacyReleaseSnapshot,
  validateReleaseMetadata,
  validateWorkflowIdentity,
  verifyReleaseBundle,
} from "../scripts/release/verify-public-release.mjs";
import {
  GitHubRestClient,
  publishPublicRelease,
  validateTagProtectionRulesets,
} from "../scripts/release/publish-public-release.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const releaseSha = "a".repeat(40);

function validIdentity(overrides = {}) {
  return validateWorkflowIdentity({
    repository: PUBLIC_RELEASE_CONTRACT.repository,
    ref: PUBLIC_RELEASE_CONTRACT.ref,
    eventSha: releaseSha,
    releaseSha,
    version: PUBLIC_RELEASE_CONTRACT.version,
    confirmation: PUBLIC_RELEASE_CONTRACT.confirmation,
    ...overrides,
  });
}

test("the release workflow parses and keeps build, OIDC and publication permissions separated", async () => {
  const source = await readFile(path.join(root, ".github", "workflows", "release.yml"), "utf8");
  const workflow = parseYaml(source);

  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, {});
  assert.equal(workflow.concurrency.group, "public-release-v0.2.0");
  assert.equal(workflow.concurrency["cancel-in-progress"], false);
  assert.deepEqual(workflow.jobs.gate.permissions, { contents: "read" });
  assert.equal(
    workflow.jobs.gate.if,
    "github.repository == 'VicenteBarrientos/fundosmart-community' && github.ref == 'refs/heads/main'",
  );
  assert.deepEqual(workflow.jobs.attest.permissions, {
    actions: "read",
    "id-token": "write",
    attestations: "write",
    "artifact-metadata": "write",
  });
  assert.deepEqual(workflow.jobs.publish.permissions, { actions: "read", contents: "write" });
  assert.equal(workflow.jobs.publish.environment.name, "public-release");

  const actionReferences = [...source.matchAll(/^\s*uses:\s*([^\s#]+)/gmu)].map((match) => match[1]);
  assert.ok(actionReferences.length >= 8);
  for (const reference of actionReferences) {
    assert.match(reference, /^actions\/[a-z-]+@[0-9a-f]{40}$/u, `${reference} must use a full immutable SHA`);
  }
  assert.doesNotMatch(source, /pull_request_target|push:\s*\n\s*tags/iu);
  assert.doesNotMatch(source, /ref:\s*\$\{\{\s*inputs\.release_sha\s*\}\}/u);
  assert.doesNotMatch(source, /ref:\s*\$\{\{\s*needs\.gate\.outputs\.release_sha\s*\}\}/u);
  const checkoutSteps = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkoutSteps.length, 2);
  assert.equal(checkoutSteps.every((step) => step.with.ref === "${{ github.sha }}"), true);
  assert.equal(workflow.jobs.gate.env.RELEASE_SHA, "${{ github.sha }}");
  assert.equal(workflow.jobs.publish.env.RELEASE_SHA, "${{ github.sha }}");

  const gateSteps = workflow.jobs.gate.steps;
  assert.equal(gateSteps[0].name, "Reject an invalid dispatch identity before checkout");
  assert.match(gateSteps[0].run, /INPUT_RELEASE_SHA[\s\S]+EVENT_SHA/u);
  const gateStepIndex = (name) => gateSteps.findIndex((step) => step.name === name);
  const prepareIndex = gateStepIndex("Create and verify deterministic release assets");
  const uploadIndex = gateStepIndex("Upload the exact release bundle before dependency execution");
  const pinNpmIndex = gateStepIndex("Pin the declared npm release");
  const installIndex = gateStepIndex("Install locked dependencies");
  const checkIndex = gateStepIndex("Run the complete source gate");
  assert.ok(prepareIndex >= 0 && prepareIndex < uploadIndex);
  assert.ok(uploadIndex < pinNpmIndex && pinNpmIndex < installIndex && installIndex < checkIndex);

  assert.doesNotMatch(source, /wrangler\s+deploy|self-host:wrangler|npm\s+publish/iu);
  assert.match(source, /CLOUDFLARE_API_TOKEN:\s*""/u);
  assert.match(source, /PUBLIC_RELEASE_TOKEN:\s*\$\{\{ github\.token \}\}/u);
  assert.match(
    source,
    /PUBLIC_RELEASE_ADMIN_READ_TOKEN:\s*\$\{\{ secrets\.PUBLIC_RELEASE_ADMIN_READ_TOKEN \}\}/u,
  );
  assert.doesNotMatch(source, /PUBLIC_RELEASE_TOKEN:[\s\S]*npm (?:ci|install|run)/u);
});

test("workflow identity rejects every repository, ref, version, SHA or confirmation substitution", () => {
  assert.equal(validIdentity().tag, "v0.2.0");
  for (const override of [
    { repository: "attacker/fundosmart-community" },
    { ref: "refs/heads/release" },
    { eventSha: "b".repeat(40) },
    { releaseSha: "abc123" },
    { version: "0.1.0" },
    { confirmation: "publish" },
  ]) {
    assert.throws(() => validIdentity(override));
  }
});

test("release metadata must synchronize package, lockfile, CycloneDX and reviewed notes", async (t) => {
  const fixture = await createMetadataFixture(t);
  const identity = validIdentity();
  const result = await validateReleaseMetadata({ cwd: fixture, identity });
  assert.equal(result.packageMetadata.version, "0.2.0");
  assert.equal(result.sbom.metadata.component.purl, "pkg:npm/fundosmart-community@0.2.0");

  const mismatched = JSON.parse(await readFile(path.join(fixture, "sbom.cdx.json"), "utf8"));
  mismatched.metadata.component.version = "0.1.0";
  await writeFile(path.join(fixture, "sbom.cdx.json"), JSON.stringify(mismatched));
  await assert.rejects(() => validateReleaseMetadata({ cwd: fixture, identity }), /CycloneDX SBOM/u);
});

test("v0.1.0 fingerprint protects the annotated tag, commit and only legacy asset", () => {
  const expected = PUBLIC_RELEASE_CONTRACT.legacy;
  const snapshot = {
    tagRef: { ref: `refs/tags/${expected.tag}`, object: { type: "tag", sha: expected.tagObjectSha } },
    annotatedTag: { sha: expected.tagObjectSha, object: { type: "commit", sha: expected.commitSha } },
    release: {
      id: expected.releaseId,
      tag_name: expected.tag,
      draft: false,
      prerelease: false,
      assets: [{ name: expected.assetName, size: expected.assetSize, digest: expected.assetDigest }],
    },
  };
  assert.equal(validateLegacyReleaseSnapshot(snapshot), true);
  assert.throws(
    () => validateLegacyReleaseSnapshot({
      ...snapshot,
      release: { ...snapshot.release, assets: [{ ...snapshot.release.assets[0], digest: "sha256:tampered" }] },
    }),
    /legacy v0\.1\.0 release/u,
  );
});

test("tag ruleset must actively prohibit update and deletion of both release tags", () => {
  const protectedRuleset = [{
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
    rules: [
      { type: "update", parameters: { update_allows_fetch_and_merge: false } },
      { type: "deletion" },
    ],
  }];
  assert.equal(validateTagProtectionRulesets(protectedRuleset), true);
  const rulesetWithoutVisibleBypassActors = structuredClone(protectedRuleset[0]);
  Reflect.deleteProperty(rulesetWithoutVisibleBypassActors, "bypass_actors");
  assert.throws(
    () => validateTagProtectionRulesets([rulesetWithoutVisibleBypassActors]),
    /no exclusions or bypass actors/u,
  );
  assert.throws(
    () => validateTagProtectionRulesets([{ ...protectedRuleset[0], rules: [{ type: "deletion" }] }]),
    /exactly protect refs\/tags\/v\*/u,
  );
  assert.throws(
    () => validateTagProtectionRulesets([{
      ...protectedRuleset[0],
      conditions: { ref_name: { include: ["refs/tags/v0.2.0"], exclude: [] } },
    }]),
    /exactly protect refs\/tags\/v\*/u,
  );
  assert.throws(
    () => validateTagProtectionRulesets([{
      ...protectedRuleset[0],
      conditions: { ref_name: { include: ["refs/tags/v*"], exclude: ["refs/tags/v0.1.0"] } },
    }]),
    /no exclusions or bypass actors/u,
  );
  assert.throws(
    () => validateTagProtectionRulesets([{
      ...protectedRuleset[0],
      bypass_actors: [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }],
    }]),
    /no exclusions or bypass actors/u,
  );
  assert.throws(
    () => validateTagProtectionRulesets([{
      ...protectedRuleset[0],
      rules: [
        { type: "update", parameters: { update_allows_fetch_and_merge: true } },
        { type: "deletion" },
      ],
    }]),
    /exactly protect refs\/tags\/v\*/u,
  );
});

test("source archives are byte-identical for the same exact Git commit", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "fundosmart-release-archive-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  runGit(fixture, ["init"]);
  await writeFile(path.join(fixture, "tracked.txt"), "exact release bytes\n");
  runGit(fixture, ["add", "tracked.txt"]);
  runGit(fixture, ["-c", "user.name=Release Test", "-c", "user.email=release@example.invalid", "commit", "-m", "Fixture"]);
  const sha = runGit(fixture, ["rev-parse", "HEAD"]).trim();
  await writeFile(path.join(fixture, ".git", "info", "attributes"), "tracked.txt export-ignore\n");
  const first = path.join(fixture, "first.tar.gz");
  const second = path.join(fixture, "second.tar.gz");
  const [firstDescriptor, secondDescriptor] = await Promise.all([
    createDeterministicSourceArchive({ cwd: fixture, releaseSha: sha, destinationPath: first, prefix: "release-v0.2.0/" }),
    createDeterministicSourceArchive({ cwd: fixture, releaseSha: sha, destinationPath: second, prefix: "release-v0.2.0/" }),
  ]);
  assert.deepEqual(firstDescriptor, secondDescriptor);
  assert.deepEqual(await readFile(first), await readFile(second));
  assert.match(gunzipSync(await readFile(first)).toString("utf8"), /exact release bytes/u);
});

test("bundle verifier rejects any post-gate mutation", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "fundosmart-release-bundle-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const identity = validIdentity();
  await createBundleFixture(fixture, identity);
  const manifest = await verifyReleaseBundle({ bundlePath: fixture, identity });
  assert.equal(manifest.releaseSha, releaseSha);
  await writeFile(path.join(fixture, manifest.assets.archive.name), "changed after gate");
  await assert.rejects(() => verifyReleaseBundle({ bundlePath: fixture, identity }), /does not match its manifest digest/u);
});

test("publisher fails before mutation for any pre-existing v0.2.0 tag, draft or release", async (t) => {
  for (const scenario of [
    { name: "tag", options: { existingTag: true } },
    { name: "draft", options: { existingRelease: { draft: true, immutable: false } } },
    { name: "published release", options: { existingRelease: { draft: false, immutable: true } } },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const cwd = await createPublishFixture(subtest);
      const { client, adminClient } = createFakeClients(scenario.options);
      await assert.rejects(
        () => publishPublicRelease({ cwd, environment: releaseEnvironment(), client, adminClient }),
        /already exists|already has a draft or release/u,
      );
      assert.deepEqual(client.mutations, []);
      assert.deepEqual(adminClient.mutations, []);
    });
  }
});

test("publisher state machine creates an exact tag, rereads it, creates one draft, uploads, verifies and publishes", async (t) => {
  const cwd = await createPublishFixture(t);
  const { client, adminClient } = createFakeClients();
  const result = await publishPublicRelease({ cwd, environment: releaseEnvironment(), client, adminClient });
  assert.deepEqual(result, { releaseId: 900, tag: "v0.2.0", releaseSha });

  const mutationLabels = client.mutations.map(({ method, url, upload }) => {
    if (upload) return "upload";
    if (method === "POST" && url.endsWith("/git/refs")) return "create-ref";
    if (method === "POST" && url.endsWith("/releases")) return "create-release";
    if (method === "PATCH") return "publish-own-draft";
    return `${method} ${url}`;
  });
  assert.deepEqual(mutationLabels, [
    "create-ref",
    "create-release",
    "upload",
    "upload",
    "upload",
    "publish-own-draft",
  ]);
  const createRefIndex = client.log.findIndex(({ method, url }) => method === "POST" && url.endsWith("/git/refs"));
  const rereadRefIndex = client.log.findIndex(
    ({ method, url }, index) => index > createRefIndex && method === "GET" && url.endsWith("/git/ref/tags/v0.2.0"),
  );
  const createReleaseIndex = client.log.findIndex(({ method, url }) => method === "POST" && url.endsWith("/releases"));
  assert.ok(createRefIndex >= 0 && rereadRefIndex > createRefIndex && createReleaseIndex > rereadRefIndex);
  assert.equal(client.candidate.id, 900);
  assert.equal(client.candidate.draft, false);
  assert.equal(client.candidate.immutable, true);
  assert.equal(adminClient.log.length > 0, true);
  assert.equal(adminClient.log.every(({ method }) => method === "GET"), true);
  assert.equal(adminClient.log.some(({ url }) => url.endsWith("/immutable-releases")), true);
  assert.equal(adminClient.log.some(({ url }) => url.includes("/rulesets")), true);
  assert.deepEqual(adminClient.mutations, []);
  assert.equal(client.log.some(({ url }) => url.endsWith("/immutable-releases") || url.includes("/rulesets")), false);
});

test("publisher fails closed for remote policy, digest and immutability drift", async (t) => {
  for (const scenario of [
    { name: "immutable releases disabled", options: { immutableEnabled: false }, pattern: /immutability must be enabled/u },
    { name: "environment reviewer missing", options: { environmentReviewers: [] }, pattern: /canonical reviewer/u },
    {
      name: "environment reviewer substituted",
      options: { environmentReviewers: [{ type: "User", reviewer: { id: 1, login: "other" } }] },
      pattern: /canonical reviewer/u,
    },
    { name: "environment self-review prevention drift", options: { preventSelfReview: true }, pattern: /canonical reviewer/u },
    { name: "observable ruleset bypass", options: { rulesetBypass: true }, pattern: /no exclusions or bypass actors/u },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const cwd = await createPublishFixture(subtest);
      const { client, adminClient } = createFakeClients(scenario.options);
      await assert.rejects(
        () => publishPublicRelease({ cwd, environment: releaseEnvironment(), client, adminClient }),
        scenario.pattern,
      );
      assert.deepEqual(client.mutations, []);
      assert.deepEqual(adminClient.mutations, []);
    });
  }

  await t.test("uploaded digest mismatch leaves only the new protected tag and own draft", async (subtest) => {
    const cwd = await createPublishFixture(subtest);
    const { client, adminClient } = createFakeClients({ tamperDigest: true });
    await assert.rejects(
      () => publishPublicRelease({ cwd, environment: releaseEnvironment(), client, adminClient }),
      /does not match its local SHA-256 digest/u,
    );
    assert.equal(client.mutations.some(({ method }) => method === "PATCH"), false);
    assert.equal(client.candidate.draft, true);
    assert.equal(client.tagRef.object.sha, releaseSha);
  });

  await t.test("draft text changed by another actor is never published", async (subtest) => {
    const cwd = await createPublishFixture(subtest);
    const { client, adminClient } = createFakeClients({ mutateDraftBody: true });
    await assert.rejects(
      () => publishPublicRelease({ cwd, environment: releaseEnvironment(), client, adminClient }),
      /identity or asset set is invalid/u,
    );
    assert.equal(client.mutations.some(({ method }) => method === "PATCH"), false);
    assert.equal(client.candidate.draft, true);
  });

  await t.test("missing post-publication immutability is detected", async (subtest) => {
    const cwd = await createPublishFixture(subtest);
    const { client, adminClient } = createFakeClients({ publishedImmutable: false });
    await assert.rejects(
      () => publishPublicRelease({ cwd, environment: releaseEnvironment(), client, adminClient }),
      /is not immutable/u,
    );
    assert.equal(client.mutations.filter(({ method }) => method === "PATCH").length, 1);
    assert.equal(client.mutations.find(({ method }) => method === "PATCH").url.endsWith("/releases/900"), true);
  });
});

test("administrative release configuration requires a separate read-only credential", async (t) => {
  const cwd = await createPublishFixture(t);
  await assert.rejects(
    () => publishPublicRelease({
      cwd,
      environment: { ...releaseEnvironment(), PUBLIC_RELEASE_TOKEN: "writer-token" },
    }),
    /PUBLIC_RELEASE_ADMIN_READ_TOKEN is required/u,
  );

  const adminClient = new GitHubRestClient({
    token: "configuration-token",
    readOnly: true,
    tokenEnvironmentName: "PUBLIC_RELEASE_ADMIN_READ_TOKEN",
    fetchImpl: async () => {
      throw new Error("a rejected mutation must not reach fetch");
    },
  });
  await assert.rejects(
    () => adminClient.request("/repos/VicenteBarrientos/fundosmart-community/rulesets", { method: "PATCH" }),
    /administrative configuration client is read-only/u,
  );
});

test("publisher source has no delete path and never installs or executes dependencies", async () => {
  const source = await readFile(path.join(root, "scripts", "release", "publish-public-release.mjs"), "utf8");
  const createTagPosition = source.indexOf("const createdRef = await writerClient.request");
  const createReleasePosition = source.indexOf("const created = await writerClient.request");
  assert.doesNotMatch(source, /method:\s*["']DELETE["']|deleteRelease|deleteRef/iu);
  assert.doesNotMatch(source, /npm|node_modules|child_process|spawn|execFile/iu);
  assert.ok(createTagPosition >= 0 && createTagPosition < createReleasePosition, "the exact tag must be created before the draft");
  assert.match(source, /immutable[^\n]+true/u);
  assert.match(source, /draft:\s*true/u);
  assert.match(source, /method:\s*"PATCH"[\s\S]+body:\s*\{ draft:\s*false/u);
});

async function createMetadataFixture(t) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "fundosmart-release-metadata-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(path.join(fixture, "docs", "releases"), { recursive: true });
  await Promise.all([
    writeFile(path.join(fixture, "package.json"), JSON.stringify({
      name: "fundosmart-community",
      version: "0.2.0",
      private: true,
      packageManager: "npm@10.9.3",
    })),
    writeFile(path.join(fixture, "package-lock.json"), JSON.stringify({
      name: "fundosmart-community",
      version: "0.2.0",
      lockfileVersion: 3,
      packages: { "": { name: "fundosmart-community", version: "0.2.0" } },
    })),
    writeFile(path.join(fixture, "sbom.cdx.json"), JSON.stringify(validSbom())),
    writeFile(path.join(fixture, "docs", "releases", "v0.2.0.md"), "# FundoSmart Community v0.2.0\n"),
  ]);
  return fixture;
}

async function createPublishFixture(t) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "fundosmart-release-publish-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const bundle = path.join(cwd, "work", "public-release");
  await mkdir(bundle, { recursive: true });
  await createBundleFixture(bundle, validIdentity());
  return cwd;
}

async function createBundleFixture(fixture, identity) {
  const names = {
    archive: "fundosmart-community-v0.2.0.tar.gz",
    sbom: "fundosmart-community-v0.2.0.cdx.json",
    checksums: "SHA256SUMS",
    notes: "release-notes.md",
    manifest: "release-manifest.json",
  };
  const archiveBytes = Buffer.from("deterministic archive fixture");
  const sbomBytes = Buffer.from(`${JSON.stringify(validSbom(), null, 2)}\n`);
  const notesBytes = Buffer.from("# FundoSmart Community v0.2.0\n");
  const archive = descriptor(archiveBytes);
  const sbom = descriptor(sbomBytes);
  const checksumsBytes = Buffer.from(`${archive.sha256}  ${names.archive}\n${sbom.sha256}  ${names.sbom}\n`);
  const checksums = descriptor(checksumsBytes);
  const notes = descriptor(notesBytes);
  const manifest = {
    schema: PUBLIC_RELEASE_CONTRACT.schema,
    repository: identity.repository,
    version: identity.version,
    tag: identity.tag,
    releaseSha: identity.releaseSha,
    sourceFileCount: 1,
    assets: {
      archive: { name: names.archive, ...archive },
      sbom: { name: names.sbom, ...sbom },
      checksums: { name: names.checksums, ...checksums },
    },
    releaseNotes: { name: names.notes, ...notes },
    legacyV010: PUBLIC_RELEASE_CONTRACT.legacy,
  };
  await Promise.all([
    writeFile(path.join(fixture, names.archive), archiveBytes),
    writeFile(path.join(fixture, names.sbom), sbomBytes),
    writeFile(path.join(fixture, names.checksums), checksumsBytes),
    writeFile(path.join(fixture, names.notes), notesBytes),
    writeFile(path.join(fixture, names.manifest), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);
}

function validSbom() {
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: "urn:uuid:6ba7b810-9dad-51d1-80b4-00c04fd430c8",
    metadata: {
      component: {
        type: "application",
        name: "fundosmart-community",
        version: "0.2.0",
        purl: "pkg:npm/fundosmart-community@0.2.0",
      },
    },
    components: [{ type: "library", name: "fixture", version: "1.0.0" }],
  };
}

function descriptor(bytes) {
  return { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

function runGit(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

function releaseEnvironment() {
  return {
    GITHUB_REPOSITORY: PUBLIC_RELEASE_CONTRACT.repository,
    GITHUB_REF: PUBLIC_RELEASE_CONTRACT.ref,
    GITHUB_SHA: releaseSha,
    RELEASE_SHA: releaseSha,
    RELEASE_VERSION: PUBLIC_RELEASE_CONTRACT.version,
    RELEASE_CONFIRMATION: PUBLIC_RELEASE_CONTRACT.confirmation,
  };
}

function createFakeClients(options = {}) {
  return {
    client: new FakeReleaseGitHub(options),
    adminClient: new FakeReleaseAdminGitHub(options),
  };
}

class FakeReleaseGitHub {
  constructor({
    existingTag = false,
    existingRelease,
    environmentReviewers = [{ type: "User", reviewer: { id: 175753145, login: "VicenteBarrientos" } }],
    preventSelfReview = false,
    tamperDigest = false,
    mutateDraftBody = false,
    publishedImmutable = true,
  } = {}) {
    this.log = [];
    this.mutations = [];
    this.environmentReviewers = environmentReviewers;
    this.preventSelfReview = preventSelfReview;
    this.tamperDigest = tamperDigest;
    this.mutateDraftBody = mutateDraftBody;
    this.draftReadCount = 0;
    this.publishedImmutable = publishedImmutable;
    this.tagRef = existingTag
      ? { ref: "refs/tags/v0.2.0", object: { type: "commit", sha: releaseSha } }
      : null;
    this.candidate = existingRelease
      ? {
        id: 700,
        tag_name: "v0.2.0",
        target_commitish: releaseSha,
        prerelease: false,
        assets: [],
        ...existingRelease,
      }
      : null;
  }

  async request(url, options = {}) {
    const method = options.method ?? "GET";
    const record = { method, url, upload: options.upload === true };
    this.log.push(record);
    if (method !== "GET") this.mutations.push(record);

    if (method === "GET" && url.endsWith("/git/ref/heads/main")) {
      return response(200, { ref: "refs/heads/main", object: { type: "commit", sha: releaseSha } });
    }
    if (method === "GET" && url.endsWith("/environments/public-release")) {
      return response(200, {
        name: "public-release",
        protection_rules: [{
          type: "required_reviewers",
          prevent_self_review: this.preventSelfReview,
          reviewers: this.environmentReviewers,
        }],
        deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      });
    }
    if (method === "GET" && url.endsWith("/git/ref/tags/v0.2.0")) {
      return this.tagRef ? response(200, this.tagRef) : response(404, null);
    }
    if (method === "GET" && url.endsWith("/git/ref/tags/v0.1.0")) {
      const legacy = PUBLIC_RELEASE_CONTRACT.legacy;
      return response(200, { ref: "refs/tags/v0.1.0", object: { type: "tag", sha: legacy.tagObjectSha } });
    }
    if (method === "GET" && url.endsWith(`/git/tags/${PUBLIC_RELEASE_CONTRACT.legacy.tagObjectSha}`)) {
      const legacy = PUBLIC_RELEASE_CONTRACT.legacy;
      return response(200, { sha: legacy.tagObjectSha, object: { type: "commit", sha: legacy.commitSha } });
    }
    if (method === "GET" && url.endsWith("/releases/tags/v0.1.0")) {
      return response(200, legacyRelease());
    }
    if (method === "GET" && /\/releases\?per_page=100&page=\d+$/u.test(url)) {
      const page = Number(new URL(`${API_FIXTURE_ORIGIN}${url}`).searchParams.get("page"));
      return response(200, page === 1
        ? [legacyRelease(), ...(this.candidate ? [this.releaseSnapshot()] : [])]
        : []);
    }
    if (method === "POST" && url.endsWith("/git/refs")) {
      if (this.tagRef) throw new Error("attempted to replace an existing tag");
      this.tagRef = { ref: options.body.ref, object: { type: "commit", sha: options.body.sha } };
      return response(201, this.tagRef);
    }
    if (method === "POST" && url.endsWith("/releases")) {
      if (this.candidate) throw new Error("attempted to replace an existing release");
      this.candidate = {
        id: 900,
        tag_name: options.body.tag_name,
        target_commitish: options.body.target_commitish,
        name: options.body.name,
        body: options.body.body,
        draft: true,
        prerelease: false,
        immutable: false,
        assets: [],
      };
      return response(201, this.releaseSnapshot());
    }
    if (method === "POST" && options.upload === true && /\/releases\/900\/assets\?name=/u.test(url)) {
      if (!this.candidate || this.candidate.id !== 900 || this.candidate.draft !== true) {
        throw new Error("asset upload did not target the run-owned draft");
      }
      const name = new URL(`${API_FIXTURE_ORIGIN}${url}`).searchParams.get("name");
      const digest = createHash("sha256").update(options.bytes).digest("hex");
      this.candidate.assets.push({ name, size: options.bytes.length, digest: `sha256:${digest}` });
      return response(201, this.candidate.assets.at(-1));
    }
    if (method === "GET" && url.endsWith("/releases/900")) {
      this.draftReadCount += 1;
      if (this.mutateDraftBody && this.candidate?.draft === true && this.draftReadCount === 1) {
        this.candidate.body = "tampered by another writer\n";
      }
      return response(200, this.releaseSnapshot());
    }
    if (method === "PATCH" && url.endsWith("/releases/900")) {
      if (!this.candidate || this.candidate.id !== 900 || this.candidate.draft !== true) {
        throw new Error("PATCH did not target the draft created by this run");
      }
      this.candidate.draft = false;
      this.candidate.prerelease = false;
      this.candidate.immutable = this.publishedImmutable;
      return response(200, this.releaseSnapshot());
    }
    throw new Error(`Unexpected fake GitHub request: ${method} ${url}`);
  }

  releaseSnapshot() {
    const snapshot = structuredClone(this.candidate);
    if (this.tamperDigest && snapshot?.assets?.length > 0) {
      snapshot.assets[0].digest = `sha256:${"0".repeat(64)}`;
    }
    return snapshot;
  }
}

class FakeReleaseAdminGitHub {
  constructor({ immutableEnabled = true, rulesetBypass = false } = {}) {
    this.log = [];
    this.mutations = [];
    this.immutableEnabled = immutableEnabled;
    this.rulesetBypass = rulesetBypass;
  }

  async request(url, options = {}) {
    const method = options.method ?? "GET";
    const record = { method, url, upload: options.upload === true };
    this.log.push(record);
    if (method !== "GET") {
      this.mutations.push(record);
      throw new Error("administrative fixture received a mutation");
    }
    if (url.endsWith("/immutable-releases")) {
      return response(200, { enabled: this.immutableEnabled, enforced_by_owner: false });
    }
    if (url.endsWith("/rulesets?includes_parents=false&per_page=100")) {
      return response(200, [{ id: 17, target: "tag", enforcement: "active" }]);
    }
    if (url.endsWith("/rulesets/17")) {
      const ruleset = {
        id: 17,
        target: "tag",
        enforcement: "active",
        bypass_actors: [],
        conditions: { ref_name: { include: ["refs/tags/v*"], exclude: [] } },
        rules: [
          { type: "update", parameters: { update_allows_fetch_and_merge: false } },
          { type: "deletion" },
        ],
      };
      if (this.rulesetBypass) {
        ruleset.bypass_actors = [{ actor_type: "RepositoryRole", actor_id: 5, bypass_mode: "always" }];
      }
      return response(200, ruleset);
    }
    throw new Error(`Unexpected fake administrative GitHub request: ${method} ${url}`);
  }
}

const API_FIXTURE_ORIGIN = "https://api.github.test";

function legacyRelease() {
  const legacy = PUBLIC_RELEASE_CONTRACT.legacy;
  return {
    id: legacy.releaseId,
    tag_name: legacy.tag,
    draft: false,
    prerelease: false,
    immutable: false,
    assets: [{ name: legacy.assetName, size: legacy.assetSize, digest: legacy.assetDigest }],
  };
}

function response(status, body) {
  return Object.freeze({ status, body });
}
