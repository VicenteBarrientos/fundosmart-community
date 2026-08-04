import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { unexpectedApiFailure } from "../app/api-failure.mjs";

const staffRouteUrl = new URL("../app/api/staff/route.ts", import.meta.url);

class StubLegacyStaffMembershipError extends Error {
  constructor(message, status = 409, code = "STAFF_MEMBERSHIP_CONFLICT") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

class StubLegacyStaffResourceError extends Error {
  constructor(message, status = 409, code = "STAFF_RESOURCE_CONFLICT") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

test("unexpected API failures log only bounded diagnostics and return generic details", async () => {
  const originalConsoleError = console.error;
  let diagnostic;
  console.error = (value) => { diagnostic = value; };
  let response;
  try {
    const cause = Object.assign(new Error("SQL and customer data must stay private"), { code: "D1_ERROR" });
    response = unexpectedApiFailure(
      "cooprinsem.import.preview",
      "No fue posible procesar el archivo importado.",
      cause,
      { importId: "import-safe", error: "must not override the public message" },
    );
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    importId: "import-safe",
    error: "No fue posible procesar el archivo importado.",
  });
  assert.deepEqual(diagnostic, {
    event: "fundosmart.api_failure",
    operation: "cooprinsem.import.preview",
    errorType: "Error",
    errorCode: "D1_ERROR",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /customer data|SQL/i);
});

test("unexpected API diagnostics discard unbounded names and codes", () => {
  const originalConsoleError = console.error;
  let diagnostic;
  console.error = (value) => { diagnostic = value; };
  try {
    const cause = Object.assign(new Error("private"), { name: "invalid name with spaces", code: "x".repeat(81) });
    unexpectedApiFailure("bounded.diagnostic", "Error genérico.", cause);
  } finally {
    console.error = originalConsoleError;
  }

  assert.deepEqual(diagnostic, {
    event: "fundosmart.api_failure",
    operation: "bounded.diagnostic",
    errorType: "unknown",
  });
});

test("Cooprinsem routes expose typed domain failures but sanitize every unexpected 500", async () => {
  const configuration = await readFile(new URL("../app/api/integraciones/cooprinsem/configuracion/route.ts", import.meta.url), "utf8");
  const projection = await readFile(new URL("../app/api/integraciones/cooprinsem/proyeccion/route.ts", import.meta.url), "utf8");
  const imports = await readFile(new URL("../app/api/integraciones/cooprinsem/importaciones/route.ts", import.meta.url), "utf8");

  assert.match(configuration, /cause instanceof CooprinsemConfigurationError[\s\S]+?cause\.message[\s\S]+?status: 422/);
  assert.match(projection, /cause instanceof ImportProjectionError[\s\S]+?cause\.message[\s\S]+?status: 422/);
  assert.match(imports, /cause instanceof DbfParseError/);
  assert.match(imports, /cause instanceof ImportPreviewLimitError/);
  for (const source of [configuration, projection, imports]) {
    assert.match(source, /unexpectedApiFailure\(/);
    assert.doesNotMatch(source, /error: cause\.message[^\n]+status: 500/);
  }
  assert.match(imports, /markImportFailed\(\{ \.\.\.parsingLifecycle, message: publicMessage \}\)/);
  assert.doesNotMatch(imports, /markImportFailed\(importId/);
  assert.match(imports, /cause instanceof ImportJobScopeError[\s\S]+importScopeChanged\(cause\)/);
});

test("staff console GET keeps D1 details private and marks the failure response non-cacheable", async () => {
  const privateMessage = "D1_ERROR: no such table platform_staff_principals; SQL=SELECT secret@example.com";
  const route = await loadStaffRoute({ queryFailure: new Error(privateMessage) });
  const originalConsoleError = console.error;
  let diagnostic;
  console.error = (value) => { diagnostic = value; };
  let response;
  try {
    response = await route.GET();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    error: "No fue posible cargar la administración global.",
  });
  assert.deepEqual(diagnostic, {
    event: "fundosmart.api_failure",
    operation: "staff.console.read",
    errorType: "Error",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret@example\.com|SELECT|no such table/u);
});

test("staff console sanitizes authorization failures before every handler body", async () => {
  const privateMessage = "D1_ERROR: session lookup failed for secret@example.com";
  const route = await loadStaffRoute({ userFailure: new Error(privateMessage) });
  const scenarios = [
    {
      invoke: () => route.GET(),
      operation: "staff.console.read",
      message: "No fue posible cargar la administración global.",
    },
    {
      invoke: () => route.POST(jsonRequest("POST", { action: "create_workspace", name: "Espacio" })),
      operation: "staff.console.create",
      message: "No fue posible procesar la solicitud administrativa.",
    },
    {
      invoke: () => route.PUT(jsonRequest("PUT", {
        action: "save_membership",
        email: "member@example.com",
        organizationId: "org-1",
      })),
      operation: "staff.console.update",
      message: "No fue posible procesar la actualización administrativa.",
    },
  ];

  for (const scenario of scenarios) {
    await assertSanitizedStaffFailure(scenario);
  }
});

test("staff console sanitizes D1 factory failures for all five data operations", async () => {
  const privateMessage = "Cloudflare D1 binding DB is unavailable; secret@example.com";
  const route = await loadStaffRoute({ dbFactoryFailure: new Error(privateMessage) });
  const scenarios = [
    {
      invoke: () => route.GET(),
      operation: "staff.console.read",
      message: "No fue posible cargar la administración global.",
    },
    {
      invoke: () => route.POST(jsonRequest("POST", { action: "create_workspace", name: "Espacio" })),
      operation: "staff.workspace.create",
      message: "No fue posible crear el espacio de trabajo.",
    },
    {
      invoke: () => route.POST(jsonRequest("POST", {
        action: "create_fundo",
        name: "Fundo",
        organizationId: "org-1",
      })),
      operation: "staff.field.create",
      message: "No fue posible crear el fundo.",
    },
    {
      invoke: () => route.PUT(jsonRequest("PUT", {
        action: "save_membership",
        email: "member@example.com",
        organizationId: "org-1",
      })),
      operation: "staff.membership.save",
      message: "No fue posible guardar la membresía.",
    },
    {
      invoke: () => route.PUT(jsonRequest("PUT", {
        action: "save_feature_flags",
        organizationId: "org-1",
        feature: "pastoreo",
        enabled: true,
      })),
      operation: "staff.feature_flags.save",
      message: "No fue posible actualizar las banderas de funcionalidad.",
    },
  ];

  for (const scenario of scenarios) {
    await assertSanitizedStaffFailure(scenario);
  }
});

test("staff membership commit failures stay behind the existing private 500 boundary", async () => {
  const privateMessage = "D1_ERROR: TEST_SCOPE_FAILURE for member-private@example.com";
  const route = await loadStaffRoute({
    membershipRepositoryFailure: new Error(privateMessage),
  });
  await assertSanitizedStaffFailure({
    invoke: () => route.PUT(jsonRequest("PUT", {
      action: "save_membership",
      email: "member@example.com",
      organizationId: "org-1",
      role: "viewer",
      status: "active",
      fieldIds: [],
    })),
    operation: "staff.membership.save",
    message: "No fue posible guardar la membresía.",
  });
});

test("staff console boundary contract fixes every public 500 response", async () => {
  const source = await readFile(staffRouteUrl, "utf8");
  const wrappedBoundaries = [
    ["staff.console.read", "No fue posible cargar la administración global.", "readStaffConsole"],
    ["staff.console.create", "No fue posible procesar la solicitud administrativa.", "\\(\\) => createStaffResource\\(request\\)"],
    ["staff.console.update", "No fue posible procesar la actualización administrativa.", "\\(\\) => updateStaffResource\\(request\\)"],
  ];
  const dataBoundaries = [
    ["staff.workspace.create", "No fue posible crear el espacio de trabajo."],
    ["staff.field.create", "No fue posible crear el fundo."],
    ["staff.membership.save", "No fue posible guardar la membresía."],
    ["staff.feature_flags.save", "No fue posible actualizar las banderas de funcionalidad."],
  ];

  assert.match(source, /import \{ unexpectedApiFailure \} from "@\/app\/api-failure\.mjs";/u);
  assert.match(
    source,
    /from "@\/src\/modules\/staff\/server\/staff-membership-repository";/u,
  );
  assert.match(
    source,
    /from "@\/src\/modules\/staff\/server\/staff-resource-repository";/u,
  );
  assert.match(
    source,
    /catch \(cause\) \{\s*return unexpectedApiFailure\(operation, publicMessage, cause\);\s*\}/u,
  );
  for (const [operation, message, handler] of wrappedBoundaries) {
    assert.match(
      source,
      new RegExp(
        `withStaffApiFailure\\(\\s*"${escapeRegExp(operation)}",\\s*"${escapeRegExp(message)}",\\s*${handler},?\\s*\\)`,
        "u",
      ),
    );
  }
  for (const [operation, message] of dataBoundaries) {
    assert.match(
      source,
      new RegExp(
        `unexpectedApiFailure\\(\\s*"${escapeRegExp(operation)}",\\s*"${escapeRegExp(message)}",\\s*cause,?\\s*\\)`,
        "u",
      ),
    );
  }
  assert.equal((source.match(/unexpectedApiFailure\(/gu) ?? []).length, dataBoundaries.length + 1);
  assert.doesNotMatch(source, /error instanceof Error \? error\.message/u);
  assert.doesNotMatch(source, /Response\.json\(\{ error: errMsg \}, \{ status: 500 \}\)/u);
});

async function loadStaffRoute(options = {}) {
  const {
    dbFactoryFailure,
    membershipRepositoryFailure,
    queryFailure = new Error("synthetic query failure"),
    userFailure,
  } = options;
  const source = await readFile(staffRouteUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const table = Object.freeze({});
  const staffUser = {
    subject: "google:staff",
    displayName: "Staff",
    email: "staff@example.com",
  };
  const stubs = {
    "@/app/access": {
      authorizeApiAccess: async () => null,
    },
    "@/app/api-failure.mjs": {
      unexpectedApiFailure,
    },
    "@/app/auth": {
      getAppUser: async () => {
        if (userFailure) throw userFailure;
        return staffUser;
      },
    },
    "@/app/legal-access": {
      authorizeApiLegalAcceptance: async () => null,
    },
    "@/app/mutation-request.mjs": {
      isSameOriginMutation: () => true,
      readBoundedJsonObject: async (request) => request.json(),
    },
    "@/app/staff-access": {
      PLATFORM_STAFF_V2_REQUIRED_KEY: "platform-staff-v2-required",
      isStaffAccountOpen: async () => true,
      isStaffEmail: async () => true,
      reauthorizeStaffAccess: async () => staffUser,
      authorizeStaffCapability: async (capability) => {
        // La autoridad v2 resuelve la identidad por dentro, así que una falla de
        // sesión debe seguir propagándose desde aquí hacia el límite 500.
        if (userFailure) throw userFailure;
        return {
          user: staffUser,
          resolution: { granted: true, mode: "principal", capability },
        };
      },
      hasStaffCapability: async () => true,
      reauthorizeStaffCapability: async () => ({
        user: staffUser,
        resolution: { granted: true, mode: "principal", capability: "support:read" },
      }),
    },
    "@/db": {
      getDb: () => {
        if (dbFactoryFailure) throw dbFactoryFailure;
        return {
          select() {
            throw queryFailure;
          },
        };
      },
    },
    "@/db/schema": {
      auditLog: table,
      fields: table,
      membershipFieldAccess: table,
      organizationFeatureFlags: table,
      organizationMemberships: table,
      organizations: table,
    },
    "@/src/modules/access/domain/access-rules.mjs": {
      normalizeAccessEmail: (email) => String(email ?? "").trim().toLowerCase(),
    },
    "@/src/modules/access/domain/types": {
      ORGANIZATION_MEMBERSHIP_ROLES: ["owner", "admin", "manager", "operator", "viewer"],
      ORGANIZATION_MEMBERSHIP_STATUSES: ["active", "suspended"],
    },
    "@/src/modules/staff/server/staff-membership-repository": {
      LegacyStaffMembershipError: StubLegacyStaffMembershipError,
      prepareLegacyStaffMembership: async (input) => {
        if (dbFactoryFailure) throw dbFactoryFailure;
        return {
          ok: true,
          plan: { membershipId: "membership-test", input },
        };
      },
      commitLegacyStaffMembership: async () => {
        throw membershipRepositoryFailure ?? queryFailure;
      },
    },
    "@/src/modules/staff/server/staff-resource-repository": {
      LegacyStaffResourceError: StubLegacyStaffResourceError,
      commitLegacyStaffFeatureFlag: async () => {
        throw dbFactoryFailure ?? queryFailure;
      },
      commitLegacyStaffField: async () => {
        throw dbFactoryFailure ?? queryFailure;
      },
      commitLegacyStaffWorkspace: async () => {
        throw dbFactoryFailure ?? queryFailure;
      },
    },
    "drizzle-orm": {
      and: (...values) => values,
      asc: (value) => value,
      desc: (value) => value,
      eq: (...values) => values,
    },
  };
  const loadedModule = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      if (specifier in stubs) return stubs[specifier];
      throw new Error(`Unexpected import in staff route: ${specifier}`);
    },
    loadedModule,
    loadedModule.exports,
  );
  return loadedModule.exports;
}

async function assertSanitizedStaffFailure({ invoke, operation, message }) {
  const originalConsoleError = console.error;
  let diagnostic;
  console.error = (value) => { diagnostic = value; };
  let response;
  try {
    response = await invoke();
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(response.status, 500, operation);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store", operation);
  assert.deepEqual(await response.json(), { error: message }, operation);
  assert.deepEqual(diagnostic, {
    event: "fundosmart.api_failure",
    operation,
    errorType: "Error",
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /secret@example\.com|D1|binding|session/u);
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
