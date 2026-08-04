import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const staffAccessUrl = new URL("../app/staff-access.ts", import.meta.url);
const routeUrl = new URL("../app/api/staff/route.ts", import.meta.url);
const pageUrl = new URL("../app/(producto)/staff/page.tsx", import.meta.url);

function parseSource(source, fileName, scriptKind) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function getFunction(sourceFile, name) {
  const declaration = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement)
      && statement.name?.text === name,
  );
  assert.ok(declaration?.body, `Missing function body: ${name}`);
  return declaration;
}

function getSingleReturnCall(sourceFile, name, callee) {
  const declaration = getFunction(sourceFile, name);
  const modifiers = declaration.modifiers ?? [];
  assert.ok(
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
    `${name} must stay exported`,
  );
  assert.ok(
    modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
    `${name} must stay async`,
  );
  const expectedParameters = name === "GET" ? [] : ["request: Request"];
  assert.deepEqual(
    declaration.parameters.map((parameter) => parameter.getText(sourceFile)),
    expectedParameters,
    `${name} must keep its request signature`,
  );
  const statements = declaration.body.statements;
  if (name === "GET") {
    assert.equal(
      statements.length,
      1,
      `${name} must contain only its guarded delegation`,
    );
  } else {
    assert.equal(
      statements.length,
      2,
      `${name} must reject cross-origin mutations before its guarded delegation`,
    );
    const [csrfGuard] = statements;
    assert.ok(
      ts.isIfStatement(csrfGuard)
        && csrfGuard.expression.getText(sourceFile) === "!isSameOriginMutation(request)"
        && ts.isReturnStatement(csrfGuard.thenStatement)
        && csrfGuard.thenStatement.expression?.getText(sourceFile) === "staffCsrfResponse()",
      `${name} must fail closed on its same-origin guard`,
    );
  }
  const statement = statements.at(-1);
  assert.ok(
    ts.isReturnStatement(statement)
      && statement.expression
      && ts.isCallExpression(statement.expression),
    `${name} must directly return ${callee}(...)`,
  );
  assert.equal(statement.expression.expression.getText(sourceFile), callee);
  return statement.expression;
}

/**
 * Contrato de autorización por capacidad. Cada helper debe exigir la
 * capacidad concreta de su operación antes de cualquier trabajo de datos.
 * `allowedPrelude` sólo admite sentencias que no tocan datos: `updateStaffResource`
 * necesita leer la acción del cuerpo para saber qué capacidad exigir.
 */
function assertStaffHelperStartsGuarded(sourceFile, name, capabilityExpression, allowedPrelude = 0) {
  const declaration = getFunction(sourceFile, name);
  const statements = declaration.body.statements;
  assert.ok(
    statements.length >= allowedPrelude + 2,
    `${name} must verify staff before doing work`,
  );

  const prelude = statements
    .slice(0, allowedPrelude)
    .map((statement) => statement.getText(sourceFile))
    .join("\n");
  assert.doesNotMatch(
    prelude,
    /getDb\(|reauthorizeStaffCapability|prepareLegacyStaffMembership|commitLegacyStaffMembership/u,
    `${name} no puede tocar datos antes de autorizar`,
  );

  const verification = statements[allowedPrelude];
  const responseGuard = statements[allowedPrelude + 1];
  const denial = statements[allowedPrelude + 2];
  assert.equal(
    verification.getText(sourceFile),
    `const staffAccess = await verifyStaff(${capabilityExpression});`,
    `${name} must authorize with its exact capability`,
  );
  assert.ok(
    ts.isIfStatement(responseGuard) && responseGuard.expression.getText(sourceFile) === "staffAccess instanceof Response",
    `${name} must propagate legal/closure responses`,
  );
  assert.ok(
    ts.isIfStatement(denial) && denial.expression.getText(sourceFile) === "!staffAccess",
    `${name} must immediately deny a missing staff actor`,
  );
  assert.ok(
    ts.isBlock(denial.thenStatement)
      && denial.thenStatement.statements.length === 1
      && ts.isReturnStatement(denial.thenStatement.statements[0])
      && denial.thenStatement.statements[0].expression?.getText(sourceFile)
        === 'Response.json({ error: "No autorizado" }, { status: 403 })',
    `${name} must fail closed with 403`,
  );
}

function assertStaffHandlerDelegates(sourceFile, method, helper) {
  const call = getSingleReturnCall(sourceFile, method, "withStaffApiFailure");
  assert.equal(call.arguments.length, 3, `${method} must use the staff failure boundary`);
  const handler = call.arguments[2];
  if (method === "GET") {
    assert.ok(ts.isIdentifier(handler));
    assert.equal(handler.text, helper);
    return;
  }
  assert.ok(
    ts.isArrowFunction(handler) && ts.isCallExpression(handler.body),
    `${method} must delegate through an inline callback`,
  );
  assert.equal(handler.body.expression.getText(sourceFile), helper);
  assert.deepEqual(
    handler.body.arguments.map((argument) => argument.getText(sourceFile)),
    ["request"],
  );
}

async function loadStaffAccessModule(options = {}) {
  const {
    user = null,
    dbFailure = false,
    includeDb = true,
  } = options;
  const users = Array.isArray(options.users) ? [...options.users] : null;
  let markerResult = Object.hasOwn(options, "markerResult")
    ? options.markerResult
    : null;
  const {
    sessionCookies = {},
    resolution = null,
  } = options;
  let authorityResult = Object.hasOwn(options, "authorityResult")
    ? options.authorityResult
    : { allowed: 1 };
  const observed = {
    authReads: 0,
    sessions: [],
    statements: [],
    bindings: [],
    resolverRequests: [],
    barrierRequests: [],
    cookieReads: [],
  };
  const source = await readFile(staffAccessUrl, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      esModuleInterop: true,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;

  const stubs = {
    "@/app/auth": {
      getAppUser: async () => {
        observed.authReads += 1;
        return users ? (users.shift() ?? null) : user;
      },
    },
    "@/app/legal-access": {
      requirePageLegalAcceptance: async () => {},
      reauthorizeLegalIdentity: async (current) => {
        if (Object.hasOwn(options, "authorityAfterLegal")) {
          authorityResult = options.authorityAfterLegal;
        }
        return { ok: true, user: current };
      },
    },
    "@/src/modules/account-lifecycle/server/account-closure-repository": {
      getActiveAccountClosure: async () => options.activeClosure ?? null,
    },
    "@/src/modules/access/domain/access-rules.mjs": {
      normalizeAccessEmail: (email) => String(email ?? "").trim().toLowerCase(),
    },
    "cloudflare:workers": {
      env: {
        FUNDOSMART_OWNER_EMAIL: "env-owner@example.com",
        ...(includeDb ? {
          DB: {
            withSession(mode) {
              observed.sessions.push(mode);
              return {
                prepare(statement) {
                  observed.statements.push(statement);
                  return {
                    bind(...bindings) {
                      observed.bindings.push(bindings);
                      return {
                        async first() {
                          if (dbFailure) throw new Error("private D1 failure");
                          return /\bAS allowed\b/u.test(statement)
                            ? authorityResult
                            : markerResult;
                        },
                      };
                    },
                  };
                },
              };
            },
          },
        } : {}),
      },
    },
    "next/navigation": {
      redirect: (url) => { throw new Error(`Redirect to ${url}`); },
    },
    "next/headers": {
      cookies: async () => ({
        get: (name) => {
          observed.cookieReads.push(name);
          const value = sessionCookies[name];
          return value ? { name, value } : undefined;
        },
      }),
    },
    "./auth-core.mjs": {
      SESSION_COOKIE_NAMES: Object.freeze([
        "__Host-fundosmart_session",
        "fundosmart_session",
      ]),
      sha256Hex: async (value) => `sha256(${value})`,
    },
    "@/src/modules/staff/server/staff-access-resolver": {
      reauthorizeResolvedStaffAccess: async (database, resolved, request) => {
        observed.barrierRequests.push({
          hasDatabase: Boolean(database),
          resolvedCapability: resolved?.capability ?? null,
          ...request,
        });
        return options.barrierResolution ?? resolution ?? {
          granted: false,
          mode: "principal",
          capability: request.capability,
          decision: null,
          session: null,
          snapshot: null,
          reasonCode: "IDENTITY_MISSING",
          publicCode: "STAFF_REQUIRED",
        };
      },
      resolveStaffAccess: async (database, request) => {
        observed.resolverRequests.push({ hasDatabase: Boolean(database), ...request });
        return resolution ?? {
          granted: false,
          mode: "principal",
          capability: request.capability,
          decision: null,
          session: null,
          snapshot: null,
          reasonCode: "IDENTITY_MISSING",
          publicCode: "STAFF_REQUIRED",
        };
      },
    },
  };

  const loadedModule = { exports: {} };
  Function("require", "module", "exports", output)(
    (specifier) => {
      if (specifier in stubs) return stubs[specifier];
      throw new Error(`Unexpected import in staff-access.ts: ${specifier}`);
    },
    loadedModule,
    loadedModule.exports
  );
  return {
    mod: loadedModule.exports,
    observed,
    setMarkerResult(value) {
      markerResult = value;
    },
  };
}

test("legacy staff candidates use a fresh primary session and are not cached across cutover", async () => {
  const loaded = await loadStaffAccessModule();

  assert.equal(await loaded.mod.isStaffEmail("env-owner@example.com"), true);
  loaded.setMarkerResult({ required: 1 });
  assert.equal(await loaded.mod.isStaffEmail("ENV-OWNER@EXAMPLE.COM"), false);
  assert.deepEqual(loaded.observed.sessions, ["first-primary", "first-primary"]);
  assert.equal(
    loaded.observed.statements.every((statement) => /FROM app_state WHERE key = \?1 LIMIT 1/u.test(statement)),
    true,
  );
  assert.deepEqual(loaded.observed.bindings, [
    ["platform-staff-v2-required"],
    ["platform-staff-v2-required"],
  ]);
});

test("the configured owner remains transitional only while the cutover marker is absent", async () => {
  const absent = await loadStaffAccessModule();
  assert.equal(await absent.mod.isStaffEmail("env-owner@example.com"), true);

  const present = await loadStaffAccessModule({
    markerResult: { required: 0, ignoredValue: "false" },
  });
  assert.equal(await present.mod.isStaffEmail("env-owner@example.com"), false);
});

test("non-staff email is denied without a D1 query", async () => {
  const loaded = await loadStaffAccessModule();

  assert.equal(await loaded.mod.isStaffEmail("env-owner+sandbox@example.com"), false);
  assert.equal(await loaded.mod.isStaffEmail("someone.else@example.com"), false);
  assert.equal(await loaded.mod.isStaffEmail(""), false);
  assert.equal(await loaded.mod.isStaffEmail(null), false);
  assert.equal(await loaded.mod.isStaffEmail(undefined), false);
  assert.deepEqual(loaded.observed.sessions, []);
});

test("missing D1, query failures and unexpected results fail closed", async () => {
  const missing = await loadStaffAccessModule({ includeDb: false });
  assert.equal(await missing.mod.isStaffEmail("env-owner@example.com"), false);

  const failed = await loadStaffAccessModule({ dbFailure: true });
  assert.equal(await failed.mod.isStaffEmail("env-owner@example.com"), false);

  const unexpected = await loadStaffAccessModule({ markerResult: undefined });
  assert.equal(await unexpected.mod.isStaffEmail("env-owner@example.com"), false);
});

test("requireStaffAccess preserves login flow and denies legacy staff after cutover", async () => {
  const anonymous = await loadStaffAccessModule();
  await assert.rejects(
    () => anonymous.mod.requireStaffAccess("/app/staff"),
    /Redirect to \/cuenta\?modo=personal&returnTo=%2Fapp%2Fstaff/u,
  );

  const user = {
    subject: "google:owner",
    email: "env-owner@example.com",
    displayName: "Owner",
    fullName: "Owner",
  };
  const allowed = await loadStaffAccessModule({ user });
  assert.equal(await allowed.mod.requireStaffAccess("/app/staff"), user);

  const blocked = await loadStaffAccessModule({
    user,
    markerResult: { required: 1 },
  });
  await assert.rejects(
    () => blocked.mod.requireStaffAccess("/app/staff"),
    /Redirect to \/app\/sin-acceso\?code=STAFF_REQUIRED/u,
  );
});

test("reauthorizeStaffAccess matches stable identity and repeats the primary marker check", async () => {
  const expected = {
    subject: "google:owner",
    email: "ENV-OWNER@EXAMPLE.COM",
  };
  const current = {
    subject: "google:owner",
    email: "env-owner@example.com",
    displayName: "Updated owner",
    fullName: "Updated owner",
  };
  const allowed = await loadStaffAccessModule({ users: [current] });
  assert.equal(await allowed.mod.reauthorizeStaffAccess(expected), current);
  assert.equal(allowed.observed.authReads, 1);
  assert.deepEqual(allowed.observed.sessions, ["first-primary"]);

  const replaced = await loadStaffAccessModule({
    users: [{ ...current, subject: "google:replacement" }],
  });
  assert.equal(await replaced.mod.reauthorizeStaffAccess(expected), null);
  assert.deepEqual(replaced.observed.sessions, []);

  const changedEmail = await loadStaffAccessModule({
    users: [{ ...current, email: "other@example.com" }],
  });
  assert.equal(await changedEmail.mod.reauthorizeStaffAccess(expected), null);
  assert.deepEqual(changedEmail.observed.sessions, []);

  const revokedSession = await loadStaffAccessModule({ users: [null] });
  assert.equal(await revokedSession.mod.reauthorizeStaffAccess(expected), null);
  assert.deepEqual(revokedSession.observed.sessions, []);

  const cutover = await loadStaffAccessModule({
    users: [current],
    authorityResult: { allowed: 0 },
  });
  assert.equal(await cutover.mod.reauthorizeStaffAccess(expected), null);
  assert.deepEqual(cutover.observed.sessions, ["first-primary"]);

  const closedDuringLegal = await loadStaffAccessModule({
    users: [current],
    authorityAfterLegal: { allowed: 0 },
  });
  assert.equal(
    await closedDuringLegal.mod.reauthorizeStaffAccess(expected),
    null,
  );
  assert.equal(closedDuringLegal.observed.statements.length, 1);
  assert.match(
    closedDuringLegal.observed.statements[0],
    /auth_identities[\s\S]+account_closure_requests[\s\S]+app_state/u,
  );
});

test("an active account closure cuts staff access during grace", async () => {
  const user = {
    subject: "google:owner",
    email: "env-owner@example.com",
    displayName: "Owner",
    fullName: "Owner",
  };
  const closed = await loadStaffAccessModule({
    user,
    activeClosure: { id: "closure-account-1" },
    authorityResult: { allowed: 0 },
  });

  await assert.rejects(
    () => closed.mod.requireStaffAccess("/app/staff"),
    /Redirect to \/app\/cuenta\/datos\?error=account-suspended/u,
  );
  assert.equal(await closed.mod.reauthorizeStaffAccess(user), null);
});

const STAFF_USER = Object.freeze({
  subject: "google:staff",
  email: "STAFF@Example.com",
  displayName: "Operadora",
  fullName: "Operadora",
});

const GRANTED = Object.freeze({
  granted: true,
  mode: "principal",
  capability: "support:read",
  decision: null,
  session: null,
  snapshot: null,
  reasonCode: null,
  publicCode: null,
});

test("authorizeStaffCapability delega en el resolutor con identidad, correo y sesión", async () => {
  const loaded = await loadStaffAccessModule({
    user: STAFF_USER,
    resolution: GRANTED,
    sessionCookies: { "__Host-fundosmart_session": "token-vigente" },
  });

  const access = await loaded.mod.authorizeStaffCapability("support:read");

  assert.equal(access.user, STAFF_USER);
  assert.equal(access.resolution.granted, true);
  assert.equal(loaded.observed.resolverRequests.length, 1);
  const [request] = loaded.observed.resolverRequests;
  assert.equal(request.hasDatabase, true);
  assert.equal(request.authIdentityId, "google:staff");
  assert.equal(request.normalizedEmail, "staff@example.com");
  assert.equal(request.authSessionTokenHash, "sha256(token-vigente)");
  assert.equal(request.capability, "support:read");
  assert.ok(Number.isSafeInteger(request.now) && request.now > 0);
  assert.deepEqual([...request.legacyOwnerEmails], ["env-owner@example.com"]);
});

test("authorizeStaffCapability no consulta nada sin sesión ni sin binding D1", async () => {
  const anonymous = await loadStaffAccessModule({ resolution: GRANTED });
  assert.equal(await anonymous.mod.authorizeStaffCapability("support:read"), null);
  assert.deepEqual(anonymous.observed.resolverRequests, []);

  const withoutDatabase = await loadStaffAccessModule({
    user: STAFF_USER,
    includeDb: false,
    resolution: GRANTED,
  });
  assert.equal(await withoutDatabase.mod.authorizeStaffCapability("support:read"), null);
  assert.deepEqual(withoutDatabase.observed.resolverRequests, []);
});

test("sin cookie de sesión la elevación queda sin ligar y falla cerrada aguas abajo", async () => {
  const loaded = await loadStaffAccessModule({ user: STAFF_USER, resolution: GRANTED });

  await loaded.mod.authorizeStaffCapability("staff:manage");

  assert.equal(loaded.observed.resolverRequests[0].authSessionTokenHash, null);
  assert.deepEqual(loaded.observed.cookieReads, [
    "__Host-fundosmart_session",
    "fundosmart_session",
  ]);
});

test("requireStaffCapability distingue falta de sesión de falta de autoridad", async () => {
  const anonymous = await loadStaffAccessModule({ resolution: GRANTED });
  await assert.rejects(
    () => anonymous.mod.requireStaffCapability("/app/staff", "support:read"),
    /Redirect to \/cuenta\?modo=personal&returnTo=%2Fapp%2Fstaff/u,
  );

  const denied = await loadStaffAccessModule({
    user: STAFF_USER,
    resolution: {
      ...GRANTED,
      granted: false,
      publicCode: "STAFF_ELEVATION_REQUIRED",
    },
  });
  await assert.rejects(
    () => denied.mod.requireStaffCapability("/app/staff", "operations:sensitive"),
    /Redirect to \/app\/sin-acceso\?code=STAFF_ELEVATION_REQUIRED/u,
  );

  const allowed = await loadStaffAccessModule({ user: STAFF_USER, resolution: GRANTED });
  const access = await allowed.mod.requireStaffCapability("/app/staff", "support:read");
  assert.equal(access.user, STAFF_USER);
  assert.equal(access.resolution.granted, true);
});

test("una denegación sin código público no revela el motivo interno", async () => {
  const loaded = await loadStaffAccessModule({
    user: STAFF_USER,
    resolution: { ...GRANTED, granted: false, publicCode: null },
  });

  await assert.rejects(
    () => loaded.mod.requireStaffCapability("/app/staff", "support:read"),
    /Redirect to \/app\/sin-acceso\?code=STAFF_REQUIRED$/u,
  );
});

test("reauthorizeStaffCapability exige identidad estable y autoridad vigente", async () => {
  const access = { user: STAFF_USER, resolution: GRANTED };

  const stable = await loadStaffAccessModule({
    users: [{ ...STAFF_USER, displayName: "Operadora Senior" }],
    barrierResolution: GRANTED,
  });
  const confirmed = await stable.mod.reauthorizeStaffCapability(access);
  assert.equal(confirmed.user.displayName, "Operadora Senior");
  assert.equal(confirmed.resolution.granted, true);
  assert.equal(stable.observed.barrierRequests.length, 1);
  assert.equal(stable.observed.barrierRequests[0].capability, "support:read");
  assert.equal(stable.observed.barrierRequests[0].resolvedCapability, "support:read");

  const replaced = await loadStaffAccessModule({
    users: [{ ...STAFF_USER, subject: "google:reemplazo" }],
    barrierResolution: GRANTED,
  });
  assert.equal(await replaced.mod.reauthorizeStaffCapability(access), null);
  assert.deepEqual(replaced.observed.barrierRequests, []);

  const renamedEmail = await loadStaffAccessModule({
    users: [{ ...STAFF_USER, email: "otra@example.com" }],
    barrierResolution: GRANTED,
  });
  assert.equal(await renamedEmail.mod.reauthorizeStaffCapability(access), null);
  assert.deepEqual(renamedEmail.observed.barrierRequests, []);

  const signedOut = await loadStaffAccessModule({ users: [null] });
  assert.equal(await signedOut.mod.reauthorizeStaffCapability(access), null);
  assert.deepEqual(signedOut.observed.barrierRequests, []);

  const revoked = await loadStaffAccessModule({
    users: [STAFF_USER],
    barrierResolution: { ...GRANTED, granted: false, publicCode: "STAFF_ACCESS_CHANGED" },
  });
  assert.equal(await revoked.mod.reauthorizeStaffCapability(access), null);
  assert.equal(revoked.observed.barrierRequests.length, 1);
});

test("staff page requireStaffAccess is called with correct return path", async () => {
  const source = await readFile(pageUrl, "utf8");
  const sourceFile = parseSource(source, "app/(producto)/staff/page.tsx", ts.ScriptKind.TSX);
  const route = getFunction(sourceFile, "StaffConsoleRoute");
  const modifiers = route.modifiers ?? [];
  for (const kind of [
    ts.SyntaxKind.ExportKeyword,
    ts.SyntaxKind.DefaultKeyword,
    ts.SyntaxKind.AsyncKeyword,
  ]) {
    assert.ok(modifiers.some((modifier) => modifier.kind === kind));
  }
  assert.equal(route.parameters.length, 0);
  assert.equal(
    route.body.statements[0]?.getText(sourceFile),
    'const access = await requireStaffCapability("/app/staff", "support:read");',
    "la consola debe exigir una capacidad explícita como primera operación",
  );
  const reauthorization = route.body.statements.find((statement) =>
    ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(
        (declaration) => declaration.name.getText(sourceFile) === "currentAccess",
      ));
  assert.ok(reauthorization, "Missing final staff reauthorization");
  assert.match(
    reauthorization.getText(sourceFile),
    /^const currentAccess = await reauthorizeStaffCapability\(access\);$/u,
  );
  assert.doesNotMatch(source, /\bisStaffEmail\b/u);
  assert.doesNotMatch(source, /\brequireStaffAccess\b/u);
  assert.doesNotMatch(source, /\brequirePageAccess\b/u);
  assert.doesNotMatch(source, /from ["']@\/app\/access["']/u);
  assert.doesNotMatch(source, /if\s*\(\s*false\s*\)/u);
  assert.doesNotMatch(source, /For static test compliance/u);
});

test("staff API route authorizes every operation with its own capability", async () => {
  const source = await readFile(routeUrl, "utf8");
  const sourceFile = parseSource(source, "app/api/staff/route.ts", ts.ScriptKind.TS);

  const verification = getFunction(sourceFile, "verifyStaff");
  assert.deepEqual(
    verification.parameters.map((parameter) => parameter.getText(sourceFile)),
    ["capability: StaffCapability"],
    "verifyStaff must require an explicit capability",
  );
  assert.equal(verification.body.statements.length, 6);
  assert.equal(
    verification.body.statements[0].getText(sourceFile),
    "const access = await authorizeStaffCapability(capability);",
  );
  const denial = verification.body.statements[1];
  assert.ok(
    ts.isIfStatement(denial)
      && denial.expression.getText(sourceFile)
        === "!access || !access.resolution.granted",
    "verifyStaff must deny a missing actor and a denied resolution",
  );
  assert.ok(
    ts.isBlock(denial.thenStatement)
      && denial.thenStatement.statements.length === 1
      && ts.isReturnStatement(denial.thenStatement.statements[0])
      && denial.thenStatement.statements[0].expression?.kind === ts.SyntaxKind.NullKeyword,
    "verifyStaff must return null immediately when authority fails",
  );
  assert.equal(
    verification.body.statements[2].getText(sourceFile),
    "const legalResponse = await authorizeApiLegalAcceptance(access.user);",
  );
  assert.equal(
    verification.body.statements[3].getText(sourceFile),
    "if (legalResponse) return legalResponse;",
  );
  assert.match(
    verification.body.statements[4].getText(sourceFile),
    /if \(!\(await isStaffAccountOpen\(access\.user\.subject\)\)\)[\s\S]+ACCOUNT_CLOSURE_ACTIVE[\s\S]+status: 423/u,
  );
  assert.equal(
    verification.body.statements[5].getText(sourceFile),
    "return access;",
  );

  assertStaffHandlerDelegates(sourceFile, "GET", "readStaffConsole");
  assertStaffHandlerDelegates(sourceFile, "POST", "createStaffResource");
  assertStaffHandlerDelegates(sourceFile, "PUT", "updateStaffResource");

  assertStaffHelperStartsGuarded(sourceFile, "readStaffConsole", '"support:read"');
  assertStaffHelperStartsGuarded(sourceFile, "createStaffResource", '"tenants:manage"');
  // La acción viaja en el cuerpo, así que sólo su lectura puede preceder al guard.
  assertStaffHelperStartsGuarded(
    sourceFile,
    "updateStaffResource",
    "updateActionCapability(action)",
    3,
  );

  assert.doesNotMatch(source, /\bisStaffEmail\b/u);
  assert.match(
    source,
    /import \{\s*isSameOriginMutation,\s*readBoundedJsonObject,\s*\} from "@\/app\/mutation-request\.mjs";/u,
  );
  assert.equal(
    (source.match(/if \(!isSameOriginMutation\(request\)\) return staffCsrfResponse\(\);/gu) ?? []).length,
    2,
    "POST and PUT must reject cross-origin requests before their handlers",
  );
  assert.equal(
    (source.match(/const payload = await readBoundedJsonObject<Record<string, unknown>>\(request\);/gu) ?? []).length,
    2,
    "both mutation helpers must use the shared bounded JSON reader",
  );
  assert.equal(
    (source.match(/if \(payload instanceof Response\) return payload;/gu) ?? []).length,
    2,
    "both mutation helpers must preserve bounded-reader error responses",
  );
  assert.match(
    source,
    /function staffCsrfResponse\(\)[\s\S]+code: "CSRF_REJECTED"[\s\S]+status: 403[\s\S]+Cache-Control": "private, no-store"[\s\S]+X-Content-Type-Options": "nosniff"/u,
  );
  assert.doesNotMatch(source, /\brequest\.(?:json|formData)\(/u);
  assert.doesNotMatch(source, /\breadJsonObject\b/u);
  assert.doesNotMatch(source, /\bauthorizeApiAccess\b/u);
  assert.doesNotMatch(source, /from ["']@\/app\/access["']/u);
  assert.doesNotMatch(source, /if\s*\(\s*false\s*\)/u);
  assert.doesNotMatch(source, /For static test compliance/u);
});

test("cada acción de actualización declara su capacidad y lo desconocido exige la mayor", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /save_membership: "tenants:manage"/u);
  assert.match(source, /save_feature_flags: "flags:manage"/u);
  assert.match(
    source,
    /const UNKNOWN_ACTION_CAPABILITY: StaffCapability = "staff:manage";/u,
  );
  assert.match(
    source,
    /return Object\.hasOwn\(UPDATE_ACTION_CAPABILITIES, action\)\s*\?\s*UPDATE_ACTION_CAPABILITIES\[action\]\s*:\s*UNKNOWN_ACTION_CAPABILITY;/u,
  );

  // La respuesta 400 de acción desconocida nunca puede preceder al 403.
  const unauthorized = source.indexOf('return Response.json({ error: "No autorizado" }, { status: 403 });');
  const unknownAction = source.indexOf('return Response.json({ error: "Acción no reconocida." }, { status: 400 });');
  assert.ok(unauthorized > 0 && unknownAction > unauthorized);
});
