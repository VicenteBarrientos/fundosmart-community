import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  PUBLIC_RELEASE_CONTRACT,
  PublicReleaseContractError,
  identityFromEnvironment,
  validateLegacyReleaseSnapshot,
  verifyReleaseBundle,
} from "./verify-public-release.mjs";

const API_ORIGIN = "https://api.github.com";
const UPLOAD_ORIGIN = "https://uploads.github.com";
const API_VERSION = "2022-11-28";
const RELEASE_ASSET_TYPES = Object.freeze({
  archive: "application/gzip",
  sbom: "application/vnd.cyclonedx+json",
  checksums: "text/plain; charset=utf-8",
});

export class PublicReleasePublisherError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "PublicReleasePublisherError";
  }
}

export class GitHubRestClient {
  constructor({
    token,
    fetchImpl = globalThis.fetch,
    readOnly = false,
    tokenEnvironmentName = "PUBLIC_RELEASE_TOKEN",
  } = {}) {
    if (typeof token !== "string" || !token.trim()) {
      throw new PublicReleasePublisherError(`${tokenEnvironmentName} is required for GitHub publication.`);
    }
    if (typeof fetchImpl !== "function") {
      throw new PublicReleasePublisherError("A Fetch implementation is required for GitHub publication.");
    }
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.readOnly = readOnly;
  }

  async request(relativeUrl, {
    method = "GET",
    body,
    bytes,
    contentType,
    expectedStatuses = [200],
    upload = false,
  } = {}) {
    if (typeof relativeUrl !== "string" || !relativeUrl.startsWith("/")) {
      throw new PublicReleasePublisherError("GitHub API requests must use a repository-relative absolute path.");
    }
    if (body !== undefined && bytes !== undefined) {
      throw new PublicReleasePublisherError("A GitHub API request cannot contain both JSON and binary bodies.");
    }
    const normalizedMethod = String(method).toUpperCase();
    if (this.readOnly && normalizedMethod !== "GET") {
      throw new PublicReleasePublisherError("The administrative configuration client is read-only.");
    }
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.token}`,
      "User-Agent": "fundosmart-community-public-release",
      "X-GitHub-Api-Version": API_VERSION,
    };
    let requestBody;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      requestBody = JSON.stringify(body);
    } else if (bytes !== undefined) {
      headers["Content-Type"] = contentType ?? "application/octet-stream";
      headers["Content-Length"] = String(bytes.length);
      requestBody = bytes;
    }
    const response = await this.fetchImpl(`${upload ? UPLOAD_ORIGIN : API_ORIGIN}${relativeUrl}`, {
      method: normalizedMethod,
      headers,
      body: requestBody,
      redirect: "error",
    });
    const responseText = await response.text();
    let responseBody = null;
    if (responseText) {
      try {
        responseBody = JSON.parse(responseText);
      } catch {
        responseBody = responseText;
      }
    }
    if (!expectedStatuses.includes(response.status)) {
      const detail = typeof responseBody === "object" && responseBody !== null
        ? String(responseBody.message ?? "GitHub rejected the request")
        : "GitHub rejected the request";
      throw new PublicReleasePublisherError(
        `GitHub API ${normalizedMethod} ${relativeUrl} failed with ${response.status}: ${detail}.`,
      );
    }
    return Object.freeze({ status: response.status, body: responseBody });
  }
}

export function validateTagProtectionRulesets(rulesets) {
  if (!Array.isArray(rulesets)) {
    throw new PublicReleasePublisherError("GitHub did not return repository rulesets.");
  }
  const protectsEveryTag = rulesets.some((ruleset) => {
    if (ruleset?.target !== "tag" || ruleset?.enforcement !== "active") return false;
    const includes = ruleset.conditions?.ref_name?.include;
    const excludes = ruleset.conditions?.ref_name?.exclude;
    const rules = ruleset.rules;
    const bypassActors = ruleset.bypass_actors;
    const updateRules = Array.isArray(rules) ? rules.filter((rule) => rule?.type === "update") : [];
    const deletionRules = Array.isArray(rules) ? rules.filter((rule) => rule?.type === "deletion") : [];
    const updateParameters = updateRules[0]?.parameters;
    const updateParametersAreSafe = updateParameters === undefined
      || (updateParameters !== null
        && typeof updateParameters === "object"
        && !Array.isArray(updateParameters)
        && Object.keys(updateParameters).length === 1
        && updateParameters.update_allows_fetch_and_merge === false);
    return Array.isArray(includes)
      && includes.length === 1
      && includes[0] === "refs/tags/v*"
      && Array.isArray(excludes)
      && excludes.length === 0
      && Array.isArray(bypassActors)
      && bypassActors.length === 0
      && rules.length === 2
      && updateRules.length === 1
      && updateParametersAreSafe
      && deletionRules.length === 1;
  });
  if (!protectsEveryTag) {
    throw new PublicReleasePublisherError(
      "The active tag ruleset must exactly protect refs/tags/v* from update and deletion with no exclusions or bypass actors.",
    );
  }
  return true;
}

export async function publishPublicRelease({
  cwd = process.cwd(),
  environment = process.env,
  client,
  adminClient,
} = {}) {
  const identity = identityFromEnvironment(environment);
  const writerClient = client ?? new GitHubRestClient({ token: environment.PUBLIC_RELEASE_TOKEN });
  const configurationClient = adminClient ?? new GitHubRestClient({
    token: environment.PUBLIC_RELEASE_ADMIN_READ_TOKEN,
    readOnly: true,
    tokenEnvironmentName: "PUBLIC_RELEASE_ADMIN_READ_TOKEN",
  });
  const bundlePath = path.join(path.resolve(cwd), ...PUBLIC_RELEASE_CONTRACT.outputRelativePath.split("/"));
  const manifest = await verifyReleaseBundle({ bundlePath, identity });
  const [owner, repo] = identity.repository.split("/");
  const repositoryPath = `/repos/${owner}/${repo}`;

  await assertRemotePreconditions({
    client: writerClient,
    adminClient: configurationClient,
    repositoryPath,
    identity,
  });

  const createdRef = await writerClient.request(`${repositoryPath}/git/refs`, {
    method: "POST",
    expectedStatuses: [201],
    body: { ref: `refs/tags/${identity.tag}`, sha: identity.releaseSha },
  });
  assertCandidateTag(createdRef.body, identity);
  assertCandidateTag(await getTagRef({ client: writerClient, repositoryPath, tag: identity.tag }), identity);
  await assertRemotePreconditions({
    client: writerClient,
    adminClient: configurationClient,
    repositoryPath,
    identity,
    allowedTagSha: identity.releaseSha,
  });

  const releaseNotes = await readFile(path.join(bundlePath, manifest.releaseNotes.name), "utf8");
  const expectedRelease = Object.freeze({
    name: `FundoSmart Community ${identity.tag}`,
    body: releaseNotes,
    targetCommitish: identity.releaseSha,
  });
  const created = await writerClient.request(`${repositoryPath}/releases`, {
    method: "POST",
    expectedStatuses: [201],
    body: {
      tag_name: identity.tag,
      target_commitish: identity.releaseSha,
      name: expectedRelease.name,
      body: expectedRelease.body,
      draft: true,
      prerelease: false,
      generate_release_notes: false,
    },
  });
  const draft = created.body;
  if (!Number.isSafeInteger(draft?.id)
    || draft?.tag_name !== identity.tag
    || draft?.target_commitish !== expectedRelease.targetCommitish
    || draft?.name !== expectedRelease.name
    || draft?.body !== expectedRelease.body
    || draft?.draft !== true
    || draft?.prerelease !== false) {
    throw new PublicReleasePublisherError("GitHub did not create the expected exact draft release.");
  }

  for (const key of ["archive", "sbom", "checksums"]) {
    const descriptor = manifest.assets[key];
    const bytes = await readFile(path.join(bundlePath, descriptor.name));
    await writerClient.request(
      `${repositoryPath}/releases/${draft.id}/assets?name=${encodeURIComponent(descriptor.name)}`,
      {
        method: "POST",
        expectedStatuses: [201],
        bytes,
        contentType: RELEASE_ASSET_TYPES[key],
        upload: true,
      },
    );
  }

  await assertDraftRelease({
    client: writerClient,
    repositoryPath,
    releaseId: draft.id,
    identity,
    manifest,
    expectedRelease,
  });
  await assertRemotePreconditions({
    client: writerClient,
    adminClient: configurationClient,
    repositoryPath,
    identity,
    allowedDraftId: draft.id,
    allowedTagSha: identity.releaseSha,
    expectedRelease,
  });

  const publishedResponse = await writerClient.request(`${repositoryPath}/releases/${draft.id}`, {
    method: "PATCH",
    expectedStatuses: [200],
    body: { draft: false, prerelease: false },
  });
  if (publishedResponse.body?.id !== draft.id || publishedResponse.body?.draft !== false) {
    throw new PublicReleasePublisherError("GitHub did not publish the exact draft release created by this run.");
  }

  const published = await getReleaseById({ client: writerClient, repositoryPath, releaseId: draft.id });
  if (published?.immutable !== true) {
    throw new PublicReleasePublisherError("The published v0.2.0 release is not immutable.");
  }
  validateReleaseAssets(published, {
    identity,
    manifest,
    expectedDraft: false,
    expectedRelease,
  });
  assertCandidateTag(await getTagRef({ client: writerClient, repositoryPath, tag: identity.tag }), identity);
  await assertOnlyPublishedCandidate({
    client: writerClient,
    repositoryPath,
    identity,
    releaseId: draft.id,
    expectedRelease,
  });
  await assertLegacyRemoteFingerprint({ client: writerClient, repositoryPath });

  process.stdout.write(
    `Published immutable ${identity.tag} at ${identity.releaseSha} with three verified release assets.\n`,
  );
  return Object.freeze({ releaseId: draft.id, tag: identity.tag, releaseSha: identity.releaseSha });
}

async function assertRemotePreconditions({
  client,
  adminClient,
  repositoryPath,
  identity,
  allowedDraftId,
  allowedTagSha,
  expectedRelease,
} = {}) {
  const [mainRef, immutableSetting, environment, tagRef, releases, legacySnapshot, rulesets] = await Promise.all([
    getRequired(client, `${repositoryPath}/git/ref/heads/main`),
    getRequired(adminClient, `${repositoryPath}/immutable-releases`),
    getRequired(client, `${repositoryPath}/environments/public-release`),
    getOptional(client, `${repositoryPath}/git/ref/tags/${encodeURIComponent(identity.tag)}`),
    listRepositoryReleases({ client, repositoryPath }),
    readLegacyRemoteSnapshot({ client, repositoryPath }),
    readTagRulesets({ client: adminClient, repositoryPath }),
  ]);
  if (mainRef?.ref !== "refs/heads/main"
    || mainRef?.object?.type !== "commit"
    || mainRef?.object?.sha !== identity.releaseSha) {
    throw new PublicReleasePublisherError("Remote main advanced or does not equal the confirmed release SHA.");
  }
  if (immutableSetting?.enabled !== true) {
    throw new PublicReleasePublisherError("Repository release immutability must be enabled before publication.");
  }
  validateProtectedEnvironment(environment);
  validateTagProtectionRulesets(rulesets);
  validateLegacyReleaseSnapshot(legacySnapshot);
  if (tagRef !== null) {
    if (allowedTagSha === undefined) {
      throw new PublicReleasePublisherError(`${identity.tag} already exists; this workflow never updates an existing tag.`);
    }
    assertCandidateTag(tagRef, { ...identity, releaseSha: allowedTagSha });
  } else if (allowedTagSha !== undefined) {
    throw new PublicReleasePublisherError("The exact candidate tag disappeared before the draft could be published.");
  }
  validateCandidateReleaseSet(releases, { identity, allowedDraftId, expectedRelease });
}

async function assertLegacyRemoteFingerprint({ client, repositoryPath }) {
  validateLegacyReleaseSnapshot(await readLegacyRemoteSnapshot({ client, repositoryPath }));
}

async function readLegacyRemoteSnapshot({ client, repositoryPath }) {
  const expected = PUBLIC_RELEASE_CONTRACT.legacy;
  const tagRef = await getRequired(client, `${repositoryPath}/git/ref/tags/${expected.tag}`);
  const [annotatedTag, release] = await Promise.all([
    getRequired(client, `${repositoryPath}/git/tags/${expected.tagObjectSha}`),
    getRequired(client, `${repositoryPath}/releases/tags/${expected.tag}`),
  ]);
  return { tagRef, annotatedTag, release };
}

async function readTagRulesets({ client, repositoryPath }) {
  const summaries = await getRequired(client, `${repositoryPath}/rulesets?includes_parents=false&per_page=100`);
  if (!Array.isArray(summaries)) {
    throw new PublicReleasePublisherError("GitHub did not return repository ruleset summaries.");
  }
  const tagRulesets = summaries.filter((ruleset) => ruleset?.target === "tag" && ruleset?.enforcement === "active");
  return Promise.all(tagRulesets.map((ruleset) => {
    if (!Number.isSafeInteger(ruleset.id)) {
      throw new PublicReleasePublisherError("GitHub returned a tag ruleset without a stable numeric ID.");
    }
    return getRequired(client, `${repositoryPath}/rulesets/${ruleset.id}`);
  }));
}

async function listRepositoryReleases({ client, repositoryPath }) {
  const releases = [];
  for (let page = 1; page <= 10; page += 1) {
    const current = await getRequired(client, `${repositoryPath}/releases?per_page=100&page=${page}`);
    if (!Array.isArray(current)) {
      throw new PublicReleasePublisherError("GitHub did not return an authenticated release list.");
    }
    releases.push(...current);
    if (current.length < 100) return releases;
  }
  throw new PublicReleasePublisherError("The repository has too many releases for a bounded fail-closed scan.");
}

function validateCandidateReleaseSet(releases, { identity, allowedDraftId, expectedRelease }) {
  const candidates = releases.filter((release) => release?.tag_name === identity.tag);
  if (allowedDraftId === undefined && candidates.length !== 0) {
    throw new PublicReleasePublisherError(`${identity.tag} already has a draft or release; this workflow never updates it.`);
  }
  if (allowedDraftId !== undefined
    && (candidates.length !== 1
      || candidates[0]?.id !== allowedDraftId
      || candidates[0]?.draft !== true
      || candidates[0]?.prerelease !== false
      || !matchesExpectedReleaseText(candidates[0], expectedRelease))) {
    throw new PublicReleasePublisherError("The candidate draft set changed while protected publication was running.");
  }
}

async function assertOnlyPublishedCandidate({ client, repositoryPath, identity, releaseId, expectedRelease }) {
  const releases = await listRepositoryReleases({ client, repositoryPath });
  const candidates = releases.filter((release) => release?.tag_name === identity.tag);
  if (candidates.length !== 1
    || candidates[0]?.id !== releaseId
    || candidates[0]?.draft !== false
    || candidates[0]?.immutable !== true
    || !matchesExpectedReleaseText(candidates[0], expectedRelease)) {
    throw new PublicReleasePublisherError("GitHub does not expose exactly the immutable release created by this run.");
  }
}

function validateProtectedEnvironment(environment) {
  const reviewerRule = environment?.protection_rules?.find((rule) => rule?.type === "required_reviewers");
  const branchPolicy = environment?.deployment_branch_policy;
  const reviewers = reviewerRule?.reviewers;
  if (environment?.name !== "public-release"
    || reviewerRule?.prevent_self_review !== false
    || !Array.isArray(reviewers)
    || reviewers.length !== 1
    || reviewers[0]?.type !== "User"
    || reviewers[0]?.reviewer?.id !== 175753145
    || branchPolicy?.protected_branches !== true
    || branchPolicy?.custom_branch_policies !== false) {
    throw new PublicReleasePublisherError(
      "The public-release environment must require the canonical reviewer and allow protected branches only.",
    );
  }
}

async function assertDraftRelease({ client, repositoryPath, releaseId, identity, manifest, expectedRelease }) {
  const release = await getReleaseById({ client, repositoryPath, releaseId });
  validateReleaseAssets(release, { identity, manifest, expectedDraft: true, expectedRelease });
  if (release?.immutable === true) {
    throw new PublicReleasePublisherError("A draft release unexpectedly became immutable before publication.");
  }
}

function validateReleaseAssets(release, { identity, manifest, expectedDraft, expectedRelease }) {
  const expected = new Map(
    ["archive", "sbom", "checksums"].map((key) => {
      const descriptor = manifest.assets[key];
      return [descriptor.name, descriptor];
    }),
  );
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  if (release?.tag_name !== identity.tag
    || release?.draft !== expectedDraft
    || release?.prerelease !== false
    || !matchesExpectedReleaseText(release, expectedRelease)
    || assets.length !== expected.size) {
    throw new PublicReleasePublisherError("The candidate GitHub release identity or asset set is invalid.");
  }
  for (const asset of assets) {
    const descriptor = expected.get(asset?.name);
    if (!descriptor
      || asset.size !== descriptor.size
      || asset.digest !== `sha256:${descriptor.sha256}`) {
      throw new PublicReleasePublisherError(`Release asset ${String(asset?.name)} does not match its local SHA-256 digest.`);
    }
  }
}

function matchesExpectedReleaseText(release, expectedRelease) {
  return expectedRelease !== undefined
    && release?.name === expectedRelease.name
    && release?.body === expectedRelease.body
    && release?.target_commitish === expectedRelease.targetCommitish;
}

function assertCandidateTag(tagRef, identity) {
  if (tagRef?.ref !== `refs/tags/${identity.tag}`
    || tagRef?.object?.type !== "commit"
    || tagRef?.object?.sha !== identity.releaseSha) {
    throw new PublicReleasePublisherError("The candidate tag does not point directly to the exact release commit.");
  }
}

async function getTagRef({ client, repositoryPath, tag }) {
  return getRequired(client, `${repositoryPath}/git/ref/tags/${encodeURIComponent(tag)}`);
}

async function getReleaseById({ client, repositoryPath, releaseId }) {
  return getRequired(client, `${repositoryPath}/releases/${releaseId}`);
}

async function getRequired(client, relativeUrl) {
  return (await client.request(relativeUrl)).body;
}

async function getOptional(client, relativeUrl) {
  const response = await client.request(relativeUrl, { expectedStatuses: [200, 404] });
  return response.status === 404 ? null : response.body;
}

async function runCli() {
  if (process.argv.length !== 2) {
    throw new PublicReleaseContractError("Usage: node scripts/release/publish-public-release.mjs");
  }
  await publishPublicRelease();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
