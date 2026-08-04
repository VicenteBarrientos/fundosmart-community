import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { unexpectedApiFailure } from "../app/api-failure.mjs";

const routeUrl = new URL("../app/api/staff/route.ts", import.meta.url);
const pageUrl = new URL("../app/(producto)/staff/page.tsx", import.meta.url);
const snapshotSecrets = [
  "organization-private",
  "field-private",
  "member-private@example.com",
  "flag-private",
  "audit-private",
];
const initialUser = {
  subject: "google:owner",
  email: "env-owner@example.com",
  displayName: "Initial owner",
  fullName: "Initial owner",
};
const currentUser = {
  ...initialUser,
  email: "ENV-OWNER@EXAMPLE.COM",
  displayName: "Current owner",
  fullName: "Current owner",
};

class StubLegacyStaffMembershipError extends Error {
  constructor(
    message = "La membresía cambió mientras se guardaba. Vuelve a cargarla.",
    status = 409,
    code = "STAFF_MEMBERSHIP_CONFLICT",
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class StubLegacyStaffResourceError extends Error {
  constructor(
    message = "El recurso administrativo cambió mientras se guardaba.",
    status = 409,
    code = "STAFF_RESOURCE_CONFLICT",
  ) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test("staff API and page discard loaded snapshots when final authority changes", async () => {
  const route = await loadStaffRoute("revoked");
  const response = await route.mod.GET();
  const body = await response.text();

  assert.equal(response.status, 409);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(JSON.parse(body), {
    error: "Tu acceso staff cambió durante la lectura. Actualiza la página e inténtalo nuevamente.",
    code: "STAFF_ACCESS_CHANGED",
  });
  assertNoSnapshot(body);
  assert.equal(route.state.serializeCount, 0);
  assert.deepEqual(route.state.events, expectedReadEvents());
  assert.deepEqual(route.state.expectedActor, {
    subject: initialUser.subject,
    email: initialUser.email,
  });

  const page = await loadStaffPage("revoked");
  const redirect = await captureRejection(() => page.mod.default());
  assert.equal(redirect.message, "Redirect to /app/sin-acceso?code=STAFF_ACCESS_CHANGED");
  assertNoSnapshot(redirect.message);
  assert.equal(page.state.renderCount, 0);
  assert.deepEqual(page.state.events, expectedReadEvents("require"));
  assert.deepEqual(page.state.expectedActor, {
    subject: initialUser.subject,
    email: initialUser.email,
  });
});

test("allowed staff snapshots reauthorize after every load and use the fresh actor", async () => {
  const route = await loadStaffRoute("allowed");
  const response = await route.mod.GET();
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.organizations[0].name, snapshotSecrets[0]);
  assert.ok(route.state.events.indexOf("load:auditLog") < route.state.events.indexOf("reauthorize"));
  assert.ok(route.state.events.indexOf("reauthorize") < route.state.events.indexOf("serialize"));
  assert.equal(route.state.serializeCount, 1);

  const page = await loadStaffPage("allowed");
  const element = await page.mod.default();
  assert.equal(element.props.userName, currentUser.displayName);
  assert.equal(element.props.initialData.memberships[0].userEmail, snapshotSecrets[2]);
  assert.deepEqual(page.state.events, [...expectedReadEvents("require"), "render"]);
  assert.equal(page.state.renderCount, 1);
});

test("staff resource writes preload or prepare before final reauthorization and commit with the fresh actor", async () => {
  const scenarios = [
    {
      method: "POST",
      payload: {
        action: "create_workspace",
        name: "Espacio nuevo",
        kind: "shared",
      },
      commitEvent: "commit-workspace",
      expectedEvents: [
        "staff-check",
        "read-json",
        "reauthorize",
        "commit-workspace",
      ],
      assertCommit(input, body) {
        assert.equal(body.success, true);
        assert.equal(input.workspaceId, body.workspaceId);
        assert.equal(input.name, "Espacio nuevo");
        assert.equal(input.kind, "shared");
        assert.match(input.workspaceId, /^org-/u);
        assert.match(input.auditId, /^[0-9a-f-]{36}$/u);
      },
    },
    {
      method: "POST",
      payload: {
        action: "create_fundo",
        name: "Fundo nuevo",
        organizationId: "organization-1",
        location: "Los Ángeles",
      },
      commitEvent: "commit-field",
      expectedEvents: [
        "staff-check",
        "read-json",
        "load:organizations",
        "reauthorize",
        "commit-field",
      ],
      assertCommit(input, body) {
        assert.equal(body.success, true);
        assert.equal(input.fieldId, body.fundoId);
        assert.equal(input.organizationId, "organization-1");
        assert.equal(input.expectedOrganizationKind, "shared");
        assert.equal(input.name, "Fundo nuevo");
        assert.equal(input.location, "Los Ángeles");
        assert.match(input.fieldId, /^fundo-/u);
      },
    },
    {
      method: "PUT",
      payload: {
        action: "save_feature_flags",
        organizationId: "organization-1",
        fieldId: "field-1",
        feature: "analitica",
        enabled: false,
      },
      commitEvent: "commit-feature",
      expectedEvents: [
        "read-json",
        "staff-check",
        "load:organizationFeatureFlags",
        "reauthorize",
        "commit-feature",
      ],
      assertCommit(input, body) {
        assert.deepEqual(body, { success: true });
        assert.equal(input.flagId, "feature:organization-1:field-1:analitica");
        assert.equal(input.organizationId, "organization-1");
        assert.equal(input.fieldId, "field-1");
        assert.equal(input.feature, "analitica");
        assert.equal(input.enabled, false);
        assert.equal(input.previous.id, "feature:organization-1:field-1:analitica");
      },
    },
  ];

  for (const scenario of scenarios) {
    const route = await loadStaffRoute("allowed");
    const response = await route.mod[scenario.method](
      jsonRequest(scenario.method, scenario.payload),
    );
    const body = await response.json();

    assert.equal(response.status, 200, scenario.payload.action);
    assert.deepEqual(route.state.events, scenario.expectedEvents);
    assert.deepEqual(route.state.expectedActor, {
      subject: initialUser.subject,
      email: initialUser.email,
    });
    assert.equal(route.state.resourceCommitCount, 1);
    const input = route.state.resourceCommitInputs[scenario.commitEvent];
    assert.deepEqual(input.actor, {
      subject: currentUser.subject,
      email: currentUser.email,
    });
    assert.equal(
      input.staffCutoverMarkerKey,
      "platform-staff-v2-required",
    );
    scenario.assertCommit(input, body);
  }
});

test("revoked staff cannot reach workspace, field, or feature-flag commits", async () => {
  const scenarios = [
    {
      method: "POST",
      payload: {
        action: "create_workspace",
        name: "Espacio nuevo",
        kind: "shared",
      },
      expectedEvents: [
        "staff-check",
        "read-json",
        "reauthorize",
      ],
    },
    {
      method: "POST",
      payload: {
        action: "create_fundo",
        name: "Fundo nuevo",
        organizationId: "organization-1",
      },
      expectedEvents: [
        "staff-check",
        "read-json",
        "load:organizations",
        "reauthorize",
      ],
    },
    {
      method: "PUT",
      payload: {
        action: "save_feature_flags",
        organizationId: "organization-1",
        feature: "pastoreo",
        enabled: true,
      },
      expectedEvents: [
        "read-json",
        "staff-check",
        "load:organizationFeatureFlags",
        "reauthorize",
      ],
    },
  ];

  for (const scenario of scenarios) {
    const route = await loadStaffRoute("revoked");
    const response = await route.mod[scenario.method](
      jsonRequest(scenario.method, scenario.payload),
    );

    assert.equal(response.status, 409, scenario.payload.action);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.deepEqual(await response.json(), {
      error: "Tu acceso staff cambió durante la actualización. Actualiza la página e inténtalo nuevamente.",
      code: "STAFF_ACCESS_CHANGED",
    });
    assert.equal(route.state.resourceCommitCount, 0);
    assert.deepEqual(route.state.events, scenario.expectedEvents);
  }
});

test("staff mutations reject cross-origin requests before auth or body parsing", async () => {
  for (const method of ["POST", "PUT"]) {
    const route = await loadStaffRoute("allowed");
    route.state.sameOrigin = false;
    const response = await route.mod[method](
      jsonRequest(method, { action: "create_workspace", name: "Privado" }),
    );

    assert.equal(response.status, 403);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.deepEqual(await response.json(), {
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    });
    assert.equal(route.state.sameOriginChecks, 1);
    assert.equal(route.state.boundedJsonReads, 0);
    assert.deepEqual(route.state.events, []);
  }
});

test("staff membership writes prepare first, reauthorize last, and commit with the fresh actor", async () => {
  const route = await loadStaffRoute("allowed");
  const response = await route.mod.PUT(jsonRequest("PUT", {
    action: "save_membership",
    organizationId: "organization-1",
    email: "member@example.com",
    displayName: "Member",
    role: "manager",
    status: "active",
    fieldIds: ["field-1"],
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    success: true,
    membershipId: "membership-saved",
  });
  assert.deepEqual(route.state.events, [
    "read-json",
    "staff-check",
    "prepare-membership",
    "reauthorize",
    "commit-membership",
  ]);
  assert.deepEqual(route.state.expectedActor, {
    subject: initialUser.subject,
    email: initialUser.email,
  });
  assert.deepEqual(route.state.prepareInput, {
    organizationId: "organization-1",
    email: "member@example.com",
    displayName: "Member",
    role: "manager",
    status: "active",
    fieldIds: ["field-1"],
  });
  assert.equal(route.state.commitInput.actorSubject, currentUser.subject);
  assert.equal(route.state.commitInput.actorEmail, currentUser.email);
  assert.equal(
    route.state.commitInput.staffCutoverMarkerKey,
    "platform-staff-v2-required",
  );
  assert.equal(route.state.commitInput.plan.membershipId, "membership-saved");
  assert.equal(route.state.membershipCommitCount, 1);
});

test("revoked staff never reaches the membership batch and repository conflicts stay private", async () => {
  const revoked = await loadStaffRoute("revoked");
  const revokedResponse = await revoked.mod.PUT(jsonRequest("PUT", {
    action: "save_membership",
    organizationId: "organization-1",
    email: "member@example.com",
    role: "viewer",
    status: "active",
    fieldIds: [],
  }));
  assert.equal(revokedResponse.status, 409);
  assert.equal(revokedResponse.headers.get("Cache-Control"), "private, no-store");
  assert.equal((await revokedResponse.json()).code, "STAFF_ACCESS_CHANGED");
  assert.equal(revoked.state.membershipCommitCount, 0);
  assert.deepEqual(revoked.state.events, [
    "read-json",
    "staff-check",
    "prepare-membership",
    "reauthorize",
  ]);

  const conflicted = await loadStaffRoute("allowed");
  conflicted.state.membershipFailure = new StubLegacyStaffMembershipError();
  const conflictResponse = await conflicted.mod.PUT(jsonRequest("PUT", {
    action: "save_membership",
    organizationId: "organization-1",
    email: "member@example.com",
    role: "viewer",
    status: "active",
    fieldIds: [],
  }));
  assert.equal(conflictResponse.status, 409);
  assert.equal(conflictResponse.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await conflictResponse.json(), {
    error: "La membresía cambió mientras se guardaba. Vuelve a cargarla.",
    code: "STAFF_MEMBERSHIP_CONFLICT",
  });
  assert.equal(conflicted.state.membershipCommitCount, 1);
});

test("revocation dominates database-derived organization and field validation", async () => {
  for (const error of [
    new StubLegacyStaffMembershipError(
      "La organización destino no existe.",
      400,
      "STAFF_MEMBERSHIP_INVALID_ORGANIZATION",
    ),
    new StubLegacyStaffMembershipError(
      "Uno de los fundos seleccionados no pertenece a la organización.",
      400,
      "STAFF_MEMBERSHIP_INVALID_FIELD",
    ),
  ]) {
    const route = await loadStaffRoute("revoked");
    route.state.preparationOutcome = { ok: false, error };
    const response = await route.mod.PUT(jsonRequest("PUT", {
      action: "save_membership",
      organizationId: "organization-1",
      email: "member@example.com",
      role: "manager",
      status: "active",
      fieldIds: ["field-1"],
    }));

    assert.equal(response.status, 409);
    assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    const body = await response.json();
    assert.deepEqual(body, {
      error: "Tu acceso staff cambió durante la actualización. Actualiza la página e inténtalo nuevamente.",
      code: "STAFF_ACCESS_CHANGED",
    });
    assert.doesNotMatch(JSON.stringify(body), /STAFF_MEMBERSHIP_INVALID_/u);
    assert.doesNotMatch(JSON.stringify(body), /organizaci[oó]n destino|fundos seleccionados/iu);
    assert.equal(route.state.membershipCommitCount, 0);
    assert.deepEqual(route.state.events, [
      "read-json",
      "staff-check",
      "prepare-membership",
      "reauthorize",
    ]);
  }
});

test("legacy membership validation keeps its exact error-only 400 bodies", async () => {
  const cases = [
    {
      message: "Ingresa un correo electrónico válido.",
      code: "STAFF_MEMBERSHIP_INVALID_EMAIL",
      failureKind: "throw",
    },
    {
      message: "La organización de destino es requerida.",
      code: "STAFF_MEMBERSHIP_INVALID_ORGANIZATION",
      failureKind: "throw",
    },
    {
      message: "La organización destino no existe.",
      code: "STAFF_MEMBERSHIP_INVALID_ORGANIZATION",
      failureKind: "outcome",
    },
    {
      message: "El nombre de la persona no es válido.",
      code: "STAFF_MEMBERSHIP_INVALID_DISPLAY_NAME",
      failureKind: "throw",
    },
    {
      message: "El rol seleccionado no es válido.",
      code: "STAFF_MEMBERSHIP_INVALID_ROLE",
      failureKind: "throw",
    },
    {
      message: "El estado seleccionado no es válido.",
      code: "STAFF_MEMBERSHIP_INVALID_STATUS",
      failureKind: "throw",
    },
    {
      message: "Los fundos seleccionados no son válidos.",
      code: "STAFF_MEMBERSHIP_INVALID_FIELDS",
      failureKind: "throw",
    },
    {
      message: "Uno de los fundos seleccionados no pertenece a la organización.",
      code: "STAFF_MEMBERSHIP_INVALID_FIELD",
      failureKind: "outcome",
    },
  ];
  for (const scenario of cases) {
    const route = await loadStaffRoute("allowed");
    const error = new StubLegacyStaffMembershipError(
      scenario.message,
      400,
      scenario.code,
    );
    if (scenario.failureKind === "throw") {
      route.state.prepareFailure = error;
    } else {
      route.state.preparationOutcome = { ok: false, error };
    }
    const response = await route.mod.PUT(jsonRequest("PUT", {
      action: "save_membership",
      organizationId: "organization-1",
      email: "member@example.com",
    }));
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("Cache-Control"), null);
    assert.deepEqual(await response.json(), { error: scenario.message });
    assert.equal(route.state.membershipCommitCount, 0);
  }
});

test("final authorization exceptions cannot serialize API or page snapshots", async () => {
  const route = await loadStaffRoute("throw");
  const originalConsoleError = console.error;
  let diagnostic;
  console.error = (value) => { diagnostic = value; };
  let response;
  try {
    response = await route.mod.GET();
  } finally {
    console.error = originalConsoleError;
  }

  const body = await response.text();
  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(JSON.parse(body), {
    error: "No fue posible cargar la administración global.",
  });
  assertNoSnapshot(body);
  assert.doesNotMatch(body, /final auth D1 private/u);
  assert.equal(route.state.serializeCount, 0);
  assert.deepEqual(diagnostic, {
    event: "fundosmart.api_failure",
    operation: "staff.console.read",
    errorType: "Error",
  });

  const page = await loadStaffPage("throw");
  const pageFailure = await captureRejection(() => page.mod.default());
  assert.equal(pageFailure.message, "final auth D1 private");
  assert.equal(page.state.renderCount, 0);
  assert.deepEqual(page.state.events, expectedReadEvents("require"));
});

test("both staff readers place one final barrier immediately before output", async () => {
  const [route, page] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(pageUrl, "utf8"),
  ]);

  const reader = functionText(route, "readStaffConsole", ts.ScriptKind.TS);
  assert.equal((reader.match(/reauthorizeStaffCapability\(/gu) ?? []).length, 1);
  assert.match(
    reader,
    /const auditLogsList = canReadAudit[\s\S]+const currentStaffAccess = await reauthorizeStaffCapability\(staffAccess\);[\s\S]+if \(!currentStaffAccess\) return staffAccessChangedResponse\(\);[\s\S]+return Response\.json\(/u,
  );
  assertNoAwaitBetween(
    reader,
    "const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);",
    "return Response.json(",
  );
  assert.equal((page.match(/reauthorizeStaffCapability\(/gu) ?? []).length, 1);
  assert.match(
    page,
    /const initialData = \{[\s\S]+const currentAccess = await reauthorizeStaffCapability\(access\);[\s\S]+redirect\("\/app\/sin-acceso\?code=STAFF_ACCESS_CHANGED"\);[\s\S]+return <StaffConsolePage[\s\S]+userName=\{currentUser\.displayName \?\? currentUser\.email\}/u,
  );
  assertNoAwaitBetween(
    page,
    "const currentAccess = await reauthorizeStaffCapability(access);",
    "return <StaffConsolePage",
  );
});

test("la auditoría exige su propia capacidad además de la de soporte", async () => {
  const route = await loadStaffRoute("allowed");
  await route.mod.GET();
  assert.deepEqual(route.state.additionalCapabilities, ["audit:read"]);

  const page = await loadStaffPage("allowed");
  await page.mod.default();
  assert.deepEqual(page.state.additionalCapabilities, ["audit:read"]);
});

test("cada operación administrativa pide en runtime su propia capacidad", async () => {
  const read = await loadStaffRoute("allowed");
  await read.mod.GET();
  assert.deepEqual(read.state.requestedCapabilities, ["support:read"]);

  const created = await loadStaffRoute("allowed");
  await created.mod.POST(jsonRequest("POST", { action: "create_workspace", name: "" }));
  assert.deepEqual(created.state.requestedCapabilities, ["tenants:manage"]);

  const membership = await loadStaffRoute("allowed");
  await membership.mod.PUT(jsonRequest("PUT", {
    action: "save_membership",
    organizationId: "organization-1",
    email: "member@example.com",
    role: "viewer",
    status: "active",
    fieldIds: [],
  }));
  assert.deepEqual(membership.state.requestedCapabilities, ["tenants:manage"]);

  const flags = await loadStaffRoute("allowed");
  await flags.mod.PUT(jsonRequest("PUT", {
    action: "save_feature_flags",
    organizationId: "organization-1",
    feature: "trazabilidad",
    enabled: true,
  }));
  assert.deepEqual(flags.state.requestedCapabilities, ["flags:manage"]);
});

test("una acción desconocida exige la capacidad más restrictiva antes de responder 400", async () => {
  const route = await loadStaffRoute("allowed");
  const response = await route.mod.PUT(jsonRequest("PUT", { action: "borrar_todo" }));

  assert.deepEqual(route.state.requestedCapabilities, ["staff:manage"]);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Acción no reconocida." });
  assert.equal(route.state.membershipCommitCount, 0);
});

test("staff mutation commits have no awaited work after their final reauthorization", async () => {
  const route = await readFile(routeUrl, "utf8");
  const membership = actionBranchText(
    route,
    "updateStaffResource",
    "save_membership",
    ts.ScriptKind.TS,
  );
  assert.match(
    membership,
    /const preparation = await prepareLegacyStaffMembership\([\s\S]+const currentStaffAccess = await reauthorizeStaffCapability\(staffAccess\);[\s\S]+if \(!preparation\.ok\) throw preparation\.error;[\s\S]+const \{ membershipId \} = await commitLegacyStaffMembership\(/u,
  );
  assert.equal((membership.match(/reauthorizeStaffCapability\(/gu) ?? []).length, 1);
  assertNoAwaitBetween(
    membership,
    "const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);",
    "const { membershipId } = await commitLegacyStaffMembership(",
  );
  assert.match(membership, /actorSubject: currentStaffAccess\.user\.subject/u);

  const scenarios = [
    {
      helper: "createStaffResource",
      action: "create_workspace",
      preparation: /const workspaceId = `org-\$\{crypto\.randomUUID\(\)\}`;[\s\S]+const auditId = crypto\.randomUUID\(\);[\s\S]+const currentStaffAccess = await reauthorizeStaffCapability\(staffAccess\);/u,
      commit: "await commitLegacyStaffWorkspace(",
    },
    {
      helper: "createStaffResource",
      action: "create_fundo",
      preparation: /const org = await db\.select\(\)[\s\S]+const auditId = crypto\.randomUUID\(\);[\s\S]+const currentStaffAccess = await reauthorizeStaffCapability\(staffAccess\);[\s\S]+if \(!currentStaffAccess\)[\s\S]+if \(org\.length === 0\)/u,
      commit: "await commitLegacyStaffField(",
    },
    {
      helper: "updateStaffResource",
      action: "save_feature_flags",
      preparation: /const \[existing\] = await db\.select\(\)[\s\S]+const previous = existing[\s\S]+const auditId = crypto\.randomUUID\(\);[\s\S]+const currentStaffAccess = await reauthorizeStaffCapability\(staffAccess\);/u,
      commit: "await commitLegacyStaffFeatureFlag(",
    },
  ];
  for (const scenario of scenarios) {
    const branch = actionBranchText(
      route,
      scenario.helper,
      scenario.action,
      ts.ScriptKind.TS,
    );
    assert.match(branch, scenario.preparation, scenario.action);
    assert.equal(
      (branch.match(/reauthorizeStaffCapability\(/gu) ?? []).length,
      1,
      scenario.action,
    );
    assertNoAwaitBetween(
      branch,
      "const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);",
      scenario.commit,
    );
  }
});

async function loadStaffRoute(mode) {
  const source = await readFile(routeUrl, "utf8");
  const tables = staffTables();
  const state = testState(mode);
  const stubs = {
    "@/app/access": {
      authorizeApiAccess: async () => { throw new Error("unused"); },
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure,
    },
    "@/app/auth": {
      getAppUser: async () => {
        state.events.push("get-user");
        return initialUser;
      },
    },
    "@/app/legal-access": {
      authorizeApiLegalAcceptance: async () => null,
    },
    "@/app/mutation-request.mjs": {
      isSameOriginMutation: () => {
        state.sameOriginChecks += 1;
        return state.sameOrigin;
      },
      readBoundedJsonObject: async (request) => {
        state.events.push("read-json");
        state.boundedJsonReads += 1;
        return request.json();
      },
    },
    "@/app/staff-access": staffAccessStubs(state),
    "@/db": {
      getDb: () => staffDb(state),
    },
    "@/db/schema": tables,
    "@/src/modules/access/domain/access-rules.mjs": {
      normalizeAccessEmail: (email) => String(email ?? "").trim().toLowerCase(),
    },
    "@/src/modules/access/domain/types": {
      ORGANIZATION_MEMBERSHIP_ROLES: ["owner", "admin", "manager", "operator", "viewer"],
      ORGANIZATION_MEMBERSHIP_STATUSES: ["active", "suspended"],
    },
    "@/src/modules/staff/server/staff-membership-repository": membershipRepositoryStubs(state),
    "@/src/modules/staff/server/staff-resource-repository": resourceRepositoryStubs(state),
    "drizzle-orm": {
      and: (...values) => values,
      asc: (value) => value,
      desc: (value) => value,
      eq: (...values) => values,
    },
  };
  return {
    mod: loadCommonJs(source, stubs),
    state,
  };
}

async function loadStaffPage(mode) {
  const source = await readFile(pageUrl, "utf8");
  const tables = staffTables();
  const state = testState(mode);
  const StaffConsolePage = Symbol("StaffConsolePage");
  const stubs = {
    "@/app/access": {
      requirePageAccess: async () => { throw new Error("unused"); },
    },
    "@/app/staff-access": {
      ...staffAccessStubs(state),
      requireStaffAccess: async () => {
        state.events.push("require");
        return initialUser;
      },
      requireStaffCapability: async () => {
        state.events.push("require");
        return { user: initialUser, resolution: grantedResolution };
      },
    },
    "@/db": {
      getDb: () => staffDb(state),
    },
    "@/db/schema": tables,
    "@/src/modules/staff/StaffConsolePage": {
      StaffConsolePage,
    },
    "drizzle-orm": {
      asc: (value) => value,
      desc: (value) => value,
    },
    "next/navigation": {
      redirect: (url) => {
        throw new Error(`Redirect to ${url}`);
      },
    },
    "react/jsx-runtime": {
      Fragment: Symbol("Fragment"),
      jsx: (type, props) => {
        state.events.push("render");
        state.renderCount += 1;
        return { type, props };
      },
      jsxs: (type, props) => {
        state.events.push("render");
        state.renderCount += 1;
        return { type, props };
      },
    },
  };
  return {
    mod: loadCommonJs(source, stubs, true),
    state,
  };
}

function loadCommonJs(source, stubs, jsx = false) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      jsx: jsx ? ts.JsxEmit.ReactJSX : undefined,
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

function staffAccessStubs(state) {
  return {
    PLATFORM_STAFF_V2_REQUIRED_KEY: "platform-staff-v2-required",
    isStaffAccountOpen: async () => true,
    isStaffEmail: async () => {
      state.events.push("staff-check");
      return true;
    },
    authorizeStaffCapability: async (capability) => {
      state.events.push("staff-check");
      state.requestedCapabilities.push(capability);
      return { user: initialUser, resolution: { ...grantedResolution, capability } };
    },
    hasStaffCapability: async (_access, capability) => {
      state.additionalCapabilities.push(capability);
      return true;
    },
    reauthorizeStaffAccess: async (expectedActor) => {
      state.events.push("reauthorize");
      state.expectedActor = expectedActor;
      if (state.mode === "throw") throw new Error("final auth D1 private");
      return state.mode === "allowed" ? currentUser : null;
    },
    reauthorizeStaffCapability: async (expectedAccess) => {
      state.events.push("reauthorize");
      state.expectedActor = {
        subject: expectedAccess.user.subject,
        email: expectedAccess.user.email,
      };
      if (state.mode === "throw") throw new Error("final auth D1 private");
      return state.mode === "allowed"
        ? { user: currentUser, resolution: grantedResolution }
        : null;
    },
  };
}

const grantedResolution = Object.freeze({
  granted: true,
  mode: "principal",
  capability: "support:read",
  decision: null,
  session: null,
  snapshot: null,
  reasonCode: null,
  publicCode: null,
});

function membershipRepositoryStubs(state) {
  return {
    LegacyStaffMembershipError: StubLegacyStaffMembershipError,
    prepareLegacyStaffMembership: async (input) => {
      state.events.push("prepare-membership");
      state.prepareInput = input;
      if (state.prepareFailure) throw state.prepareFailure;
      return state.preparationOutcome ?? {
        ok: true,
        plan: {
          membershipId: "membership-saved",
          input,
        },
      };
    },
    commitLegacyStaffMembership: async (input) => {
      state.events.push("commit-membership");
      state.commitInput = input;
      state.membershipCommitCount += 1;
      if (state.membershipFailure) throw state.membershipFailure;
      return { membershipId: input.plan.membershipId };
    },
  };
}

function resourceRepositoryStubs(state) {
  const commit = (event) => async (input) => {
    state.events.push(event);
    state.resourceCommitCount += 1;
    state.resourceCommitInputs[event] = input;
    if (state.resourceFailure) throw state.resourceFailure;
  };
  return {
    LegacyStaffResourceError: StubLegacyStaffResourceError,
    commitLegacyStaffFeatureFlag: commit("commit-feature"),
    commitLegacyStaffField: commit("commit-field"),
    commitLegacyStaffWorkspace: commit("commit-workspace"),
  };
}

function staffDb(state) {
  return {
    select() {
      let tableName = null;
      let consumed = false;
      const query = {
        from(table) {
          tableName = table.name;
          return query;
        },
        orderBy() {
          return query;
        },
        where() {
          return query;
        },
        limit() {
          return query;
        },
        then(resolve, reject) {
          if (consumed) return Promise.reject(new Error("Query consumed twice")).then(resolve, reject);
          consumed = true;
          state.events.push(`load:${tableName}`);
          return Promise.resolve(state.datasets[tableName]).then(resolve, reject);
        },
      };
      return query;
    },
  };
}

function staffTables() {
  return Object.fromEntries([
    "organizations",
    "organizationMemberships",
    "fields",
    "membershipFieldAccess",
    "organizationFeatureFlags",
    "auditLog",
  ].map((name) => [name, Object.freeze({ name })]));
}

function testState(mode) {
  const state = {
    additionalCapabilities: [],
    datasets: null,
    events: [],
    expectedActor: null,
    membershipCommitCount: 0,
    membershipFailure: null,
    prepareFailure: null,
    preparationOutcome: null,
    prepareInput: null,
    commitInput: null,
    boundedJsonReads: 0,
    mode,
    renderCount: 0,
    requestedCapabilities: [],
    resourceCommitCount: 0,
    resourceCommitInputs: {},
    resourceFailure: null,
    sameOrigin: true,
    sameOriginChecks: 0,
    serializeCount: 0,
  };
  state.datasets = {
    organizations: [{
      id: "organization-1",
      name: snapshotSecrets[0],
      kind: "shared",
      toJSON() {
        state.events.push("serialize");
        state.serializeCount += 1;
        return { id: this.id, name: this.name };
      },
    }],
    fields: [{ id: "field-1", name: snapshotSecrets[1] }],
    organizationMemberships: [{
      id: "membership-1",
      userEmail: snapshotSecrets[2],
    }],
    membershipFieldAccess: [{ membershipId: "membership-1", fieldId: "field-1" }],
    organizationFeatureFlags: [{
      id: "feature:organization-1:field-1:analitica",
      organizationId: "organization-1",
      fieldId: "field-1",
      feature: "analitica",
      enabled: true,
      createdBy: "previous@example.com",
      updatedBy: snapshotSecrets[3],
      createdAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    }],
    auditLog: [{ id: "audit-1", action: snapshotSecrets[4] }],
  };
  return state;
}

function expectedReadEvents(initial = "staff-check") {
  return [
    initial,
    "load:organizations",
    "load:fields",
    "load:organizationMemberships",
    "load:membershipFieldAccess",
    "load:organizationFeatureFlags",
    "load:auditLog",
    "reauthorize",
  ];
}

function assertNoSnapshot(value) {
  for (const secret of snapshotSecrets) {
    assert.doesNotMatch(value, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
}

function functionText(source, name, scriptKind) {
  const parsed = ts.createSourceFile(
    `staff-${name}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const declaration = parsed.statements.find(
    (statement) => ts.isFunctionDeclaration(statement)
      && statement.name?.text === name,
  );
  assert.ok(declaration, `Missing function ${name}`);
  return declaration.getText(parsed);
}

function actionBranchText(source, functionName, action, scriptKind) {
  const parsed = ts.createSourceFile(
    `staff-${functionName}-${action}.ts`,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const declaration = parsed.statements.find(
    (statement) => ts.isFunctionDeclaration(statement)
      && statement.name?.text === functionName,
  );
  assert.ok(declaration?.body, `Missing function ${functionName}`);
  const branch = declaration.body.statements.find(
    (statement) => ts.isIfStatement(statement)
      && ts.isBinaryExpression(statement.expression)
      && statement.expression.left.getText(parsed) === "action"
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && statement.expression.right.getText(parsed) === JSON.stringify(action),
  );
  assert.ok(branch, `Missing ${action} branch in ${functionName}`);
  return branch.thenStatement.getText(parsed);
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

async function captureRejection(action) {
  try {
    await action();
  } catch (cause) {
    return cause;
  }
  assert.fail("Expected action to reject.");
}

function jsonRequest(method, payload) {
  return new Request("https://fundosmart.test/app/api/staff", {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "https://fundosmart.test",
    },
    body: JSON.stringify(payload),
  });
}
