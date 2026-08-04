import assert from "node:assert/strict";
import test from "node:test";
import {
  CURRENT_LEGAL_DOCUMENT_RELEASES,
  LegalAcceptanceError,
  canonicalLegalEvidenceJson,
  createLegalAcceptancePlan,
  evaluateLegalAcceptance,
} from "../src/modules/legal/legal-acceptance.mjs";
import {
  ACCOUNT_CLOSURE_GRACE_DAYS,
  AccountClosureError,
  canonicalAccountClosureSnapshotJson,
  createAccountClosureRequestPlan,
  createAccountClosureRevocationPlan,
  evaluateAccountClosure,
} from "../src/modules/account-lifecycle/account-closure.mjs";

test("a legal version change requires a fresh acceptance for each document", () => {
  const stale = evaluateLegalAcceptance([
    acceptanceRecord("privacy", "2026-07-28T12:00:00.000Z", {
      documentVersion: "1.0",
    }),
    acceptanceRecord("terms", "2026-07-29T12:00:00.000Z"),
  ]);

  assert.equal(stale.complete, false);
  assert.deepEqual(stale.missingKinds, ["privacy"]);
  assert.equal(
    stale.requirements.find((entry) => entry.kind === "terms")?.accepted,
    true,
  );

  const current = evaluateLegalAcceptance([
    acceptanceRecord("privacy", "2026-07-29T12:00:00.000Z"),
    acceptanceRecord("terms", "2026-07-29T12:00:01.000Z"),
  ]);
  assert.equal(current.complete, true);
  assert.deepEqual(current.missingKinds, []);
});

test("same version with a changed legal digest fails closed", () => {
  const status = evaluateLegalAcceptance([
    acceptanceRecord("privacy", "2026-07-29T12:00:00.000Z", {
      documentContentSha256: "f".repeat(64),
    }),
    acceptanceRecord("terms", "2026-07-29T12:00:01.000Z"),
  ]);
  assert.equal(status.complete, false);
  assert.deepEqual(status.missingKinds, ["privacy"]);
});

test("missing or mismatched explicit evidence never satisfies the legal gate", () => {
  const validTerms = acceptanceRecord("terms", "2026-07-29T12:00:01.000Z");
  const invalidPrivacy = {
    ...acceptanceRecord("privacy", "2026-07-29T12:00:00.000Z"),
    evidence: {},
  };
  const status = evaluateLegalAcceptance([invalidPrivacy, validTerms]);
  assert.equal(status.complete, false);
  assert.deepEqual(status.missingKinds, ["privacy"]);
});

test("the acceptance plan seals both current versions and auditable evidence", () => {
  const plan = createLegalAcceptancePlan({
    identityId: "google:subject-1",
    requestId: "request-legal-1",
    acceptedAt: "2026-07-29T12:00:00.000Z",
    acceptedVersions: {
      privacy: CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
      terms: CURRENT_LEGAL_DOCUMENT_RELEASES.terms.version,
    },
    confirmed: true,
    userAgentSha256: "a".repeat(64),
    idFactory: sequenceFactory("legal"),
  });

  assert.deepEqual(
    plan.acceptances.map((entry) => entry.documentKind),
    ["privacy", "terms"],
  );
  assert.equal(plan.event.action, "legal.acceptance.recorded");
  assert.deepEqual(plan.event.payload.acceptedVersions, {
    privacy: "1.2",
    terms: "1.2",
  });
  for (const acceptance of plan.acceptances) {
    assert.equal(acceptance.evidence.identityId, "google:subject-1");
    assert.equal(acceptance.evidence.requestId, "request-legal-1");
    assert.match(canonicalLegalEvidenceJson(acceptance.evidence), /"evidenceVersion":1/u);
    assert.ok(Object.isFrozen(acceptance.evidence));
  }
});

test("stale submitted legal versions fail closed", () => {
  assert.throws(
    () => createLegalAcceptancePlan({
      identityId: "google:subject-1",
      requestId: "request-legal-2",
      acceptedAt: "2026-07-29T12:00:00.000Z",
      acceptedVersions: { privacy: "1.1", terms: "1.2" },
      confirmed: true,
      userAgentSha256: null,
      idFactory: sequenceFactory("stale"),
    }),
    (error) => error instanceof LegalAcceptanceError && error.code === "STALE_LEGAL_VERSION",
  );
});

test("legal acceptance requires an explicit confirmation", () => {
  assert.throws(
    () => createLegalAcceptancePlan({
      identityId: "google:subject-1",
      requestId: "request-legal-unconfirmed",
      acceptedAt: "2026-07-29T12:00:00.000Z",
      acceptedVersions: {
        privacy: CURRENT_LEGAL_DOCUMENT_RELEASES.privacy.version,
        terms: CURRENT_LEGAL_DOCUMENT_RELEASES.terms.version,
      },
      confirmed: false,
      userAgentSha256: null,
      idFactory: sequenceFactory("unconfirmed"),
    }),
    (error) =>
      error instanceof LegalAcceptanceError
      && error.code === "EXPLICIT_CONFIRMATION_REQUIRED",
  );
});

test("requesting closure creates only a reversible grace overlay with a sealed snapshot", () => {
  const snapshot = {
    memberships: [
      {
        id: "membership-1",
        organizationId: "organization-1",
        role: "owner",
        status: "active",
        fieldIds: ["field-1"],
      },
      {
        id: "membership-2",
        organizationId: "organization-2",
        role: "manager",
        status: "suspended",
        fieldIds: [],
      },
    ],
  };
  const plan = createAccountClosureRequestPlan({
    actorIdentityId: "google:subject-1",
    idFactory: sequenceFactory("closure"),
    now: "2026-07-29T12:00:00.000Z",
    requestId: "request-close-1",
    scope: "account",
    snapshot,
    targetId: "google:subject-1",
  });

  assert.equal(plan.closureRequest.status, "grace");
  assert.equal(
    plan.closureRequest.graceEndsAt,
    "2026-08-28T12:00:00.000Z",
  );
  assert.equal(ACCOUNT_CLOSURE_GRACE_DAYS, 30);
  assert.equal(plan.event.action, "account.closure.requested");
  assert.equal(
    canonicalAccountClosureSnapshotJson(plan.closureRequest.snapshot),
    canonicalAccountClosureSnapshotJson(snapshot),
  );
  assert.ok(Object.isFrozen(plan.closureRequest.snapshot));
});

test("revocation inside grace preserves the exact snapshot and expiry fails closed", () => {
  const request = createAccountClosureRequestPlan({
    actorIdentityId: "google:subject-1",
    idFactory: sequenceFactory("closure"),
    now: "2026-07-29T12:00:00.000Z",
    requestId: "request-close-1",
    scope: "organization",
    snapshot: {
      memberships: [{
        id: "membership-1",
        organizationId: "organization-1",
        role: "owner",
        status: "active",
        fieldIds: ["field-1"],
      }],
    },
    targetId: "organization-1",
  }).closureRequest;

  const revocation = createAccountClosureRevocationPlan({
    actorIdentityId: "google:subject-1",
    current: request,
    idFactory: sequenceFactory("revoke"),
    now: "2026-08-01T12:00:00.000Z",
    requestId: "request-revoke-1",
  });
  assert.equal(revocation.revocation.nextVersion, 2);
  assert.equal(
    canonicalAccountClosureSnapshotJson(revocation.revocation.preservedSnapshot),
    canonicalAccountClosureSnapshotJson(request.snapshot),
  );
  assert.equal(revocation.event.action, "account.closure.revoked");
  assert.deepEqual(evaluateAccountClosure(request, request.graceEndsAt), {
    state: "grace",
    accessSuspended: true,
    revocable: true,
    evaluatedAt: request.graceEndsAt,
  });

  assert.throws(
    () => createAccountClosureRevocationPlan({
      actorIdentityId: "google:subject-1",
      current: request,
      idFactory: sequenceFactory("late"),
      now: "2026-08-28T12:00:00.001Z",
      requestId: "request-revoke-late",
    }),
    (error) =>
      error instanceof AccountClosureError
      && error.code === "GRACE_WINDOW_EXPIRED",
  );
});

test("an account cannot request closure for another identity", () => {
  assert.throws(
    () => createAccountClosureRequestPlan({
      actorIdentityId: "google:subject-1",
      idFactory: sequenceFactory("forbidden"),
      now: "2026-07-29T12:00:00.000Z",
      requestId: "request-close-other",
      scope: "account",
      snapshot: {},
      targetId: "google:subject-2",
    }),
    (error) =>
      error instanceof AccountClosureError
      && error.code === "ACCOUNT_TARGET_MISMATCH",
  );
});

function sequenceFactory(prefix) {
  let sequence = 0;
  return (label) => `${prefix}-${label}-${++sequence}`;
}

function acceptanceRecord(kind, acceptedAt, overrides = {}) {
  const release = CURRENT_LEGAL_DOCUMENT_RELEASES[kind];
  const identityId = "google:subject-1";
  const requestId = `request-${kind}`;
  return {
    identityId,
    requestId,
    documentKind: kind,
    documentVersion: release.version,
    documentPublishedOn: release.publishedOn,
    documentContentSha256: release.contentSha256,
    evidenceVersion: 1,
    acceptedAt,
    evidence: {
      evidenceVersion: 1,
      source: "authenticated_web",
      confirmed: true,
      requestId,
      acceptedAt,
      identityId,
      userAgentSha256: null,
      document: release,
    },
    ...overrides,
  };
}
