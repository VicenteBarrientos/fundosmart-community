import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  IssueResolutionError,
  normalizeIssueResolution,
} from "../src/modules/integraciones/cooprinsem/server/issue-resolution.mjs";

const repository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/import-repository.ts", import.meta.url),
  "utf8",
);
const route = readFileSync(
  new URL("../app/api/integraciones/cooprinsem/inconsistencias/route.ts", import.meta.url),
  "utf8",
);

test("normalizes human resolution decisions", () => {
  assert.deepEqual(normalizeIssueResolution({ status: "resolved", resolutionNotes: "  DIIO confirmado  " }), {
    status: "resolved",
    resolutionNotes: "DIIO confirmado",
  });
  assert.deepEqual(normalizeIssueResolution({ status: "open", resolutionNotes: "texto anterior" }), {
    status: "open",
    resolutionNotes: null,
  });
});

test("requires an explicit reason before ignoring source inconsistencies", () => {
  assert.throws(
    () => normalizeIssueResolution({ status: "ignored", resolutionNotes: "no" }),
    (error) => error instanceof IssueResolutionError && error.code === "ISSUE_IGNORE_REASON_REQUIRED",
  );
  assert.deepEqual(normalizeIssueResolution({ status: "ignored", resolutionNotes: "Dato legado sin efecto" }), {
    status: "ignored",
    resolutionNotes: "Dato legado sin efecto",
  });
});

test("rejects unknown resolution states", () => {
  assert.throws(
    () => normalizeIssueResolution({ status: "deleted" }),
    (error) => error instanceof IssueResolutionError && error.code === "ISSUE_STATUS_INVALID",
  );
});

test("persists resolutions only through a scoped guarded batch", () => {
  assert.match(route, /organizationId: access\.organizationId/);
  assert.match(route, /fieldIds: access\.fieldIds/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /email: access\.email/);
  assert.doesNotMatch(repository, /db\.update\(importErrors\)/);
  assert.match(repository, /UPDATE import_errors[\s\S]+current_job\.organization_id = \?/);
  assert.match(repository, /current_field\.id IN \(SELECT value FROM json_each\(\?\)\)/);
  assert.match(repository, /organization_memberships AS current_actor/);
  assert.match(repository, /current_actor\.status = 'active'/);
  assert.match(repository, /membership_field_access AS current_scope/);
  assert.match(repository, /current_field\.is_demo = 0/);
  assert.match(repository, /WHERE changes\(\) = 1[\s\S]+saved_issue\.updated_at = \?/);
  assert.match(repository, /guardedResolution, insertAudit, assertComplete/);
  assert.match(repository, /saved_audit\.before = \?[\s\S]+saved_audit\.after = \?/);
  assert.match(repository, /integer overflow/);
  assert.match(route, /IMPORT_ACCESS_CHANGED|ImportAccessChangedError/);
});
