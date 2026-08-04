import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL(
  "../app/api/cuenta/datos/cierre/route.ts",
  import.meta.url,
);
const pageUrl = new URL("../app/cuenta/datos/page.tsx", import.meta.url);
const noAccessUrl = new URL("../app/sin-acceso/page.tsx", import.meta.url);
const spacesUrl = new URL("../app/espacios/page.tsx", import.meta.url);
const organizationRouteUrl = new URL(
  "../app/api/cuenta/organizacion/route.ts",
  import.meta.url,
);
const shellUrl = new URL("../src/core/layout/AppShell.tsx", import.meta.url);
const repositoryUrl = new URL(
  "../src/modules/account-lifecycle/server/account-closure-repository.ts",
  import.meta.url,
);
const accessRepositoryUrl = new URL(
  "../src/modules/access/server/access-repository.ts",
  import.meta.url,
);
const authSessionUrl = new URL("../app/auth-session.ts", import.meta.url);
const migrationUrl = new URL(
  "../drizzle/0001_public_invariants.sql",
  import.meta.url,
);

function parse(source, fileName, scriptKind = ts.ScriptKind.TS) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
}

function functionText(sourceFile, name) {
  const declaration = sourceFile.statements.find(
    (statement) => ts.isFunctionDeclaration(statement)
      && statement.name?.text === name,
  );
  assert.ok(declaration?.body, `Missing function: ${name}`);
  return declaration.body.getText(sourceFile);
}

function assertInOrder(source, fragments) {
  let cursor = -1;
  for (const fragment of fragments) {
    const index = source.indexOf(fragment, cursor + 1);
    assert.notEqual(index, -1, `Missing ordered fragment: ${fragment}`);
    assert.ok(index > cursor, `Out-of-order fragment: ${fragment}`);
    cursor = index;
  }
}

test("the closure API verifies origin, identity and legal consent before input", async () => {
  const source = await readFile(routeUrl, "utf8");
  const post = functionText(parse(source, "closure-route.ts"), "POST");

  assertInOrder(post, [
    "isSameOriginMutation(request)",
    "await getAppUser()",
    "await authorizeApiLegalAcceptance(user)",
    "await readBoundedUrlEncodedForm(request)",
  ]);
  assert.match(source, /if \(formData instanceof Response\) return formData;/u);
  assert.match(source, /"Cache-Control": "private, no-store"/u);
  assert.match(source, /"X-Content-Type-Options": "nosniff"/u);
});

test("closure requests need exact typed confirmation and explicit understanding", async () => {
  const [source, repository] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
  ]);
  const route = parse(source, "closure-route.ts");
  const requestClosure = functionText(route, "requestClosure");
  const repositorySource = parse(repository, "account-closure-repository.ts");
  const requestWriter = functionText(repositorySource, "requestAccountClosure");

  assert.match(requestClosure, /formData\.get\("understand"\) !== "on"/u);
  assert.match(
    requestClosure,
    /normalizeAuthEmail\(suppliedConfirmation\) !== normalizeAuthEmail\(user\.email\)/u,
  );
  assert.match(
    requestClosure,
    /organizationConfirmation:\s*scope === "organization"[\s\S]+suppliedConfirmation/u,
  );
  assert.match(requestClosure, /beforeCommit:\s*\(\) => requireCurrentClosureActor\(user\)/u);
  assert.doesNotMatch(source, /function organizationName/u);
  assert.match(
    requestWriter,
    /membership\.role = 'owner'[\s\S]+membership\.status = 'active'[\s\S]+organization\.name = \?/u,
  );
  assertInOrder(requestWriter, [
    "if (input.beforeCommit) await input.beforeCommit()",
    "await session.batch<Record<string, unknown>>(statements)",
  ]);
  assertInOrder(requestClosure, [
    "await requestAccountClosure(env.DB",
    'if (scope === "account")',
    "return accountClosureRedirect(request.url)",
    "await reauthorizeLegalApi(user)",
    "return redirectResponse(",
  ]);

  const accountBranch = requestClosure.slice(
    requestClosure.indexOf('if (scope === "account")'),
    requestClosure.indexOf("const current = await reauthorizeLegalApi(user)"),
  );
  assert.doesNotMatch(accountBranch, /\bawait\b/u);
});

test("revocation reauthorizes last and account closure clears only session cookies", async () => {
  const [source, repository] = await Promise.all([
    readFile(routeUrl, "utf8"),
    readFile(repositoryUrl, "utf8"),
  ]);
  const route = parse(source, "closure-route.ts");
  const revoke = functionText(route, "revokeClosure");
  const redirect = functionText(route, "accountClosureRedirect");
  const repositorySource = parse(repository, "account-closure-repository.ts");
  const revokeWriter = functionText(repositorySource, "revokeAccountClosure");

  assertInOrder(revoke, [
    "await revokeAccountClosure(env.DB",
    "await reauthorizeLegalApi(user)",
    "return redirectResponse(",
  ]);
  assert.doesNotMatch(
    revoke.slice(revoke.indexOf("await reauthorizeLegalApi(user)")),
    /\bawait\b[\s\S]*\bawait\b/u,
  );
  assert.match(redirect, /clearSessionCookies\(requestUrl\)/u);
  assert.match(redirect, /ACCOUNT_MODE_COOKIE, ACTIVE_ORGANIZATION_COOKIE/u);
  assert.match(revoke, /beforeCommit:\s*\(\) => requireCurrentClosureActor\(user\)/u);
  assertInOrder(revokeWriter, [
    "if (input.beforeCommit) await input.beforeCommit()",
    "await session.batch<Record<string, unknown>>(statements)",
  ]);
});

test("the recovery page repeats its snapshot and states retention honestly", async () => {
  const [page, shell, noAccess] = await Promise.all([
    readFile(pageUrl, "utf8"),
    readFile(shellUrl, "utf8"),
    readFile(noAccessUrl, "utf8"),
  ]);

  assertInOrder(page, [
    "const snapshot = await loadAccountDataSnapshotOrRedirect(user, now)",
    "const current = await reauthorizeAccountDataSnapshot(user, snapshot, now)",
    "const currentUser = current.user",
    "const { closures, organizations } = current.snapshot",
    "return (",
  ]);
  const finalBarrier = page.slice(
    page.indexOf("const current = await reauthorizeAccountDataSnapshot"),
    page.indexOf("return (", page.indexOf("const current = await reauthorizeAccountDataSnapshot")),
  );
  assert.equal([...finalBarrier.matchAll(/\bawait\b/gu)].length, 1);
  const snapshotBarrier = functionText(
    parse(page, "account-data-page.tsx", ts.ScriptKind.TSX),
    "reauthorizeAccountDataSnapshot",
  );
  assertInOrder(snapshotBarrier, [
    "await reauthorizeLegalIdentity(user)",
    "await loadAccountDataSnapshotOrRedirect(",
    "JSON.stringify(currentSnapshot)",
    'redirect("/app/cuenta/datos?error=state-changed")',
    "return Object.freeze(",
  ]);
  assert.doesNotMatch(
    snapshotBarrier.slice(
      snapshotBarrier.indexOf("await loadAccountDataSnapshotOrRedirect(") + 1,
    ),
    /\bawait\b/u,
  );
  assert.match(page, /accountClosed[\s\S]+organizations = accountClosed\s+\? \[\]\s+:\s+await listAccessibleOrganizations\(user\)/u);
  assert.match(page, /Escribe tu correo exacto/u);
  assert.match(page, /Escribe el nombre exacto/u);
  assert.match(page, /30 d\u00edas/u);
  assert.match(page, /No se elimina, anonimiza ni purga ning\u00fan dato/u);
  assert.match(page, /No se ejecut\u00f3 eliminaci\u00f3n alguna/u);
  assert.match(shell, /href="\/app\/cuenta\/datos"/u);
  assert.match(shell, /Cuenta y datos/u);
  assert.match(
    noAccess,
    /code === "MEMBERSHIP_SUSPENDED"\s*\|\|\s*code === "ACCOUNT_CLOSURE_ACTIVE"/u,
  );
  assert.match(noAccess, /ACCOUNT_CLOSURE_ACTIVE:[\s\S]+solicitud de cierre vigente/u);
  assert.doesNotMatch(noAccess, /dentro de la ventana de gracia/u);
  assert.match(noAccess, /href="\/app\/cuenta\/datos"/u);
  assert.match(noAccess, /Revisar estado del cierre/u);
});

test("workspace selection handles an active account closure without a 500", async () => {
  const [spaces, organizationRoute, accessRepository] = await Promise.all([
    readFile(spacesUrl, "utf8"),
    readFile(organizationRouteUrl, "utf8"),
    readFile(accessRepositoryUrl, "utf8"),
  ]);

  assert.match(
    spaces,
    /cause instanceof AccessDeniedError[\s\S]+cause\.code === "ACCOUNT_CLOSURE_ACTIVE"[\s\S]+redirect\("\/app\/sin-acceso\?code=ACCOUNT_CLOSURE_ACTIVE"\)/u,
  );
  assert.match(
    organizationRoute,
    /cause instanceof AccessDeniedError[\s\S]+cause\.code === "ACCOUNT_CLOSURE_ACTIVE"[\s\S]+status: 423/u,
  );
  assert.match(organizationRoute, /"Cache-Control": "private, no-store"/u);
  assert.match(organizationRoute, /recovery: "\/app\/cuenta\/datos"/u);
  assert.match(
    accessRepository,
    /function loadAccessibleOrganizationsSnapshot[\s\S]+withSession\("first-primary"\)[\s\S]+account_closure_requests[\s\S]+organization_memberships[\s\S]+LEFT JOIN fields/u,
  );
});

test("closure persistence retains requests and deletes only account sessions", async () => {
  const [repository, migration] = await Promise.all([
    readFile(repositoryUrl, "utf8"),
    readFile(migrationUrl, "utf8"),
  ]);
  const deleteStatements = [...repository.matchAll(/\bDELETE FROM\s+([a-z_]+)/gu)]
    .map((match) => match[1]);

  assert.deepEqual(deleteStatements, ["auth_sessions"]);
  assert.match(migration, /account_closure_requests_no_delete/u);
  assert.match(migration, /account_closure_requests_retained/u);
  assert.match(repository, /account\.closure\.requested/u);
  assert.match(migration, /account\.closure\.revoked/u);
  assert.doesNotMatch(migration, /\bDROP TABLE\b/iu);
});

test("stable subject gating prevents an OIDC email change from reopening access", async () => {
  const [accessRepository, authSession] = await Promise.all([
    readFile(accessRepositoryUrl, "utf8"),
    readFile(authSessionUrl, "utf8"),
  ]);
  const accessSource = parse(accessRepository, "access-repository.ts");
  const authorizeUser = functionText(accessSource, "authorizeUser");
  const authorizeFromSnapshot = functionText(accessSource, "authorizeFromSnapshot");

  /* `authorizeUser` sólo elige de dónde sale el snapshot; la decisión vive en
     `authorizeFromSnapshot`, y ahí el orden que importa no cambió: la puerta de
     cierre se evalúa —y lanza— antes de tocar una membresía, y el sello sigue
     siendo lo último. */
  assertInOrder(authorizeFromSnapshot, [
    "snapshot.accountClosureActive",
    "\"ACCOUNT_CLOSURE_ACTIVE\"",
    "snapshot.memberships",
    "await assertCurrentAccessSeal(",
  ]);
  const finalSeal = authorizeFromSnapshot.slice(
    authorizeFromSnapshot.indexOf("await assertCurrentAccessSeal("),
  );
  assert.equal([...finalSeal.matchAll(/\bawait\b/gu)].length, 1);
  assertInOrder(authorizeUser, [
    "normalizeAccessEmail(user.email)",
    "readAuthorizationSnapshotCache(",
    "loadAuthorizationSnapshot(user.subject",
  ]);

  /* El sello nunca se sirve desde caché: `authorizeFromSnapshot` lo ejecuta en
     cada autorización, así que un snapshot vencido no puede conceder nada. Y una
     negativa desde caché descarta la entrada antes de reintentar contra la base,
     para no negar de más por datos viejos. */
  assert.doesNotMatch(
    functionText(accessSource, "readAuthorizationSnapshotCache"),
    /assertCurrentAccessSeal/u,
  );
  assert.match(
    authorizeUser,
    /catch[\s\S]+authorizationSnapshotCache\.delete\(cacheKey\)[\s\S]+await loadAuthorizationSnapshot\(/u,
  );
  /* Cierre vigente y cuenta sin membresías abren caminos de escritura: nunca se
     guardan, y desde caché se releen antes de aprovisionar. */
  assert.match(
    functionText(accessSource, "writeAuthorizationSnapshotCache"),
    /snapshot\.accountClosureActive \|\| snapshot\.memberships\.length === 0/u,
  );
  assert.equal(
    [...authorizeFromSnapshot.matchAll(/if \(!provision\) throw new StaleAuthorizationSnapshot\(\)/gu)].length,
    2,
  );

  /* La puerta se ancla al sujeto estable (?1), no al correo (?2): cambiar el
     correo en Google no puede reabrir una cuenta en cierre. */
  const snapshotLoader = functionText(accessSource, "loadAuthorizationSnapshot");
  assert.match(snapshotLoader, /\.bind\(\s*subject,\s*normalizedEmail,/u);
  assert.match(
    snapshotLoader,
    /FROM account_closure_requests AS closure[\s\S]+closure\.scope = 'account'[\s\S]+closure\.target_id = \?1[\s\S]+closure\.status = 'grace'/u,
  );
  assert.match(snapshotLoader, /membership\.normalized_email = \?2/u);
  assert.match(
    accessRepository,
    /function assertCurrentAccessSeal[\s\S]+withSession\("first-primary"\)[\s\S]+auth_identities[\s\S]+account_closure_requests[\s\S]+organization_memberships[\s\S]+current_fields[\s\S]+organization_feature_flags/u,
  );
  /* Dos llamadas directas —el directorio de espacios y el tablero de accesos—
     más la puerta que `authorizeUser` resuelve dentro de su propia lectura. */
  assert.equal(
    [...accessRepository.matchAll(/await assertAccountOpen\(user\)/gu)].length,
    2,
  );
  assert.match(
    authSession,
    /ON CONFLICT\(id\) DO UPDATE SET[\s\S]+account_closure_requests[\s\S]+THEN auth_identities\.normalized_email/u,
  );
});
