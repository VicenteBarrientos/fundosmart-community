import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { unexpectedApiFailure } from "../app/api-failure.mjs";

const routeUrl = new URL("../app/api/staff/feedback/route.ts", import.meta.url);
const repositoryUrl = new URL(
  "../src/modules/feedback/server/feedback-repository.ts",
  import.meta.url,
);
const STAFF_CUTOVER_MARKER_KEY = "platform-staff-v2-required";
const privateValues = [
  "feedback-private-id",
  "Persona Privada",
  "persona.privada@example.com",
  "El mensaje privado no puede salir tras la revocación.",
  "Nota interna reservada.",
];
const initialStaff = {
  subject: "google:staff-owner",
  email: "staff.owner@example.com",
  displayName: "Staff inicial",
  fullName: "Staff inicial",
};
const currentStaff = {
  ...initialStaff,
  email: "STAFF.OWNER@EXAMPLE.COM",
  displayName: "Staff vigente",
  fullName: "Staff vigente",
};

class FeedbackRequestError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "FeedbackRequestError";
    this.status = status;
    this.code = code;
  }
}

test("GET discards loaded list, CSV and JSON when final staff authority changes", async () => {
  for (const suffix of ["", "?format=csv", "?format=json"]) {
    const loaded = await loadFeedbackRoute(["revoked"]);
    const response = await loaded.mod.GET(
      new Request(`https://fundosmart.test/app/api/staff/feedback${suffix}`),
    );
    const body = await response.text();

    assert.equal(response.status, 409, suffix || "list");
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(JSON.parse(body), {
      error: "Tu acceso staff cambió durante la solicitud. Actualiza la página e inténtalo nuevamente.",
      code: "FEEDBACK_STAFF_ACCESS_CHANGED",
    });
    assertPrivateValuesAbsent(body);
    assert.equal(loaded.state.listCalls, 1);
    assert.equal(loaded.state.sensitiveReads, 0);
    assert.deepEqual(loaded.state.expectedActors, [{
      subject: initialStaff.subject,
      email: initialStaff.email,
    }]);
  }
});

test("current staff retains list and both exports after the final barrier", async () => {
  for (const suffix of ["", "?format=csv", "?format=json"]) {
    const loaded = await loadFeedbackRoute(["allowed"]);
    const response = await loaded.mod.GET(
      new Request(`https://fundosmart.test/app/api/staff/feedback${suffix}`),
    );
    const body = await response.text();

    assert.equal(response.status, 200, suffix || "list");
    assert.match(body, /persona\.privada@example\.com/u);
    assert.match(body, /mensaje privado/u);
    assert.ok(loaded.state.sensitiveReads > 0);
    assert.deepEqual(
      loaded.state.events,
      ["list", "reauthorize", ...(suffix ? [] : ["serialize"])],
    );
  }
});

test("PATCH reauthorizes before the writer and returns no loaded feedback after revocation", async () => {
  const beforeWrite = await loadFeedbackRoute(["revoked"]);
  const beforeResponse = await beforeWrite.mod.PATCH(feedbackPatchRequest());
  const beforeBody = await beforeResponse.text();
  assert.equal(beforeResponse.status, 409);
  assert.equal(beforeWrite.state.updateCalls, 0);
  assertPrivateValuesAbsent(beforeBody);

  const afterWrite = await loadFeedbackRoute(["allowed", "revoked"]);
  const afterResponse = await afterWrite.mod.PATCH(feedbackPatchRequest());
  const afterBody = await afterResponse.text();
  assert.equal(afterResponse.status, 409);
  assert.equal(afterWrite.state.updateCalls, 1);
  assert.equal(afterWrite.state.sensitiveReads, 0);
  assertPrivateValuesAbsent(afterBody);
  assert.deepEqual(afterWrite.state.events, [
    "reauthorize",
    "update",
    "reauthorize",
    "serialize",
  ]);
});

test("current staff PATCH preserves CAS input and the canonical D1 cutover marker", async () => {
  const loaded = await loadFeedbackRoute(["allowed", "allowed"]);
  const response = await loaded.mod.PATCH(feedbackPatchRequest());
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.match(body, /persona\.privada@example\.com/u);
  assert.deepEqual(loaded.state.updateInput, {
    actorSubject: currentStaff.subject,
    actorEmail: currentStaff.email,
    staffCutoverMarkerKey: STAFF_CUTOVER_MARKER_KEY,
    update: {
      feedbackId: privateValues[0],
      expectedVersion: 7,
      status: "planned",
      priority: "p1",
      staffNote: privateValues[4],
    },
  });
  assert.deepEqual(loaded.state.events, [
    "reauthorize",
    "update",
    "reauthorize",
    "serialize",
  ]);
});

test("route barriers and repository guards remain adjacent and fail closed", async () => {
  const [route, repository] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
  ]);

  assert.equal((route.match(/reauthorizeStaffCapability\(/gu) ?? []).length, 3);
  assert.doesNotMatch(route, /\bisStaffEmail\b/u);
  assert.match(route, /await authorizeStaffCapability\("support:read"\)/u);
  assert.match(
    route,
    /const result = await listProductFeedbackForStaff\(filters\);[\s\S]+const currentStaff = await reauthorizeStaffCapability\(staff\);[\s\S]+if \(!currentStaff\) return staffAccessChangedResponse\(\);[\s\S]+if \(format === "csv"\)/u,
  );
  assertNoAwaitBetween(
    route,
    "const currentStaff = await reauthorizeStaffCapability(staff);",
    'if (format === "csv")',
  );
  assert.match(
    route,
    /const update = validateStaffFeedbackUpdate\(payload\);[\s\S]+const currentStaff = await reauthorizeStaffCapability\(staff\);[\s\S]+const feedback = await updateProductFeedbackForStaff\([\s\S]+const responseStaff = await reauthorizeStaffCapability\(staff\);[\s\S]+return privateFeedbackJson\(\{ feedback \}\)/u,
  );
  assertNoAwaitBetween(
    route,
    "const responseStaff = await reauthorizeStaffCapability(staff);",
    "return privateFeedbackJson({ feedback });",
  );
  assert.match(route, /actorSubject: currentStaff\.user\.subject/u);
  assert.match(route, /staffCutoverMarkerKey: PLATFORM_STAFF_V2_REQUIRED_KEY/u);
  assert.match(route, /FEEDBACK_STAFF_ACCESS_CHANGED/u);

  assert.equal(
    (repository.match(/\$\{authority\.sql\}/gu) ?? []).length,
    4,
    "UPDATE, event, postcondition and diagnostic must share the authority seal",
  );
  assert.match(
    repository,
    /UPDATE product_feedback[\s\S]+AND \$\{authority\.sql\}/u,
  );
  assert.match(
    repository,
    /INSERT INTO product_feedback_events[\s\S]+AND \$\{authority\.sql\}/u,
  );
  assert.match(
    repository,
    /function staffFeedbackAuthorityCondition[\s\S]+auth_identities[\s\S]+account_closure_requests AS account_closure[\s\S]+account_closure_requests AS organization_closure[\s\S]+app_state AS staff_cutover/u,
  );
  assert.match(repository, /fundosmart_feedback_staff_access_changed/u);
  assert.match(repository, /FEEDBACK_STAFF_ACCESS_CHANGED/u);
});

async function loadFeedbackRoute(reauthorizationResults) {
  const source = await readFile(routeUrl, "utf8");
  const state = {
    events: [],
    expectedActors: [],
    listCalls: 0,
    reauthorizationResults: [...reauthorizationResults],
    requestedCapabilities: [],
    sensitiveReads: 0,
    updateCalls: 0,
    updateInput: null,
  };
  const result = feedbackResult(state);
  const stubs = {
    "@/app/api-failure.mjs": {
      unexpectedApiFailure,
    },
    "@/app/auth": {
      getAppUser: async () => initialStaff,
    },
    "@/app/legal-access": {
      authorizeApiLegalAcceptance: async () => null,
    },
    "@/app/staff-access": {
      isStaffAccountOpen: async () => true,
      isStaffEmail: async () => true,
      PLATFORM_STAFF_V2_REQUIRED_KEY: STAFF_CUTOVER_MARKER_KEY,
      authorizeStaffCapability: async (capability) => {
        state.requestedCapabilities.push(capability);
        return {
          user: initialStaff,
          resolution: { granted: true, mode: "principal", capability },
        };
      },
      reauthorizeStaffCapability: async (expectedAccess) => {
        state.events.push("reauthorize");
        state.expectedActors.push({
          subject: expectedAccess.user.subject,
          email: expectedAccess.user.email,
        });
        const outcome = state.reauthorizationResults.shift();
        if (outcome === "throw") throw new Error("private staff reauthorization failure");
        return outcome === "allowed"
          ? { user: currentStaff, resolution: expectedAccess.resolution }
          : null;
      },
    },
    "@/src/modules/feedback/domain/types": {
      FeedbackRequestError,
      parseStaffFeedbackFilters: (_params, limit) => ({ limit }),
      validateStaffFeedbackUpdate: (value) => value,
    },
    "@/src/modules/feedback/server/feedback-http": {
      isSameOriginFeedbackMutation: () => true,
      privateFeedbackJson: (value, status = 200) => {
        state.events.push("serialize");
        return new Response(JSON.stringify(value), {
          status,
          headers: {
            "Cache-Control": "private, no-store",
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
          },
        });
      },
      readBoundedJsonObject: (request) => request.json(),
    },
    "@/src/modules/feedback/server/feedback-repository": {
      listProductFeedbackForStaff: async () => {
        state.events.push("list");
        state.listCalls += 1;
        return result;
      },
      updateProductFeedbackForStaff: async (input) => {
        state.events.push("update");
        state.updateCalls += 1;
        state.updateInput = input;
        return result.items[0];
      },
    },
  };
  return {
    mod: loadCommonJs(source, stubs),
    state,
  };
}

function feedbackResult(state) {
  const sensitive = (value) => ({
    enumerable: true,
    get() {
      state.sensitiveReads += 1;
      return value;
    },
  });
  const item = {
    organizationId: "organization-private",
    organizationName: "Organización privada",
    fieldId: "field-private",
    fieldName: "Fundo privado",
    reporterMembershipId: "membership-private",
    planCode: "free",
    category: "bug",
    impact: "blocked",
    contactAllowed: true,
    pagePath: "/app/potreros",
    releaseSha: "private-release",
    userAgent: "private-agent",
    viewportWidth: 1280,
    viewportHeight: 800,
    online: true,
    status: "new",
    priority: null,
    version: 7,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
  Object.defineProperties(item, {
    id: sensitive(privateValues[0]),
    reporterName: sensitive(privateValues[1]),
    reporterEmail: sensitive(privateValues[2]),
    message: sensitive(privateValues[3]),
    staffNote: sensitive(privateValues[4]),
  });
  return {
    items: [item],
    summary: {
      total: 1,
      new: 1,
      reviewing: 0,
      planned: 0,
      resolved: 0,
      closed: 0,
    },
  };
}

function feedbackPatchRequest() {
  return new Request("https://fundosmart.test/app/api/staff/feedback", {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://fundosmart.test",
    },
    body: JSON.stringify({
      feedbackId: privateValues[0],
      expectedVersion: 7,
      status: "planned",
      priority: "p1",
      staffNote: privateValues[4],
    }),
  });
}

function loadCommonJs(source, stubs) {
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
      assert.ok(specifier in stubs, `Unexpected import: ${specifier}`);
      return stubs[specifier];
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

function assertPrivateValuesAbsent(value) {
  for (const secret of privateValues) {
    assert.doesNotMatch(value, new RegExp(escapeRegExp(secret), "u"));
  }
}

function assertNoAwaitBetween(source, barrier, output) {
  const barrierIndex = source.indexOf(barrier);
  const outputIndex = source.indexOf(output, barrierIndex + barrier.length);
  assert.notEqual(barrierIndex, -1, barrier);
  assert.notEqual(outputIndex, -1, output);
  assert.doesNotMatch(
    source.slice(barrierIndex + barrier.length, outputIndex),
    /\bawait\b/u,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
