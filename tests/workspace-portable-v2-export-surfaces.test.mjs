import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const routeUrl = new URL(
  "../app/api/cuenta/datos/exportacion/route.ts",
  import.meta.url,
);
const pageUrl = new URL("../app/cuenta/datos/page.tsx", import.meta.url);
const repositoryUrl = new URL(
  "../src/modules/account-lifecycle/server/workspace-export-repository.ts",
  import.meta.url,
);
const v1RouteUrl = new URL(
  "../app/api/integraciones/cooprinsem/respaldos/route.ts",
  import.meta.url,
);
const v1FormatUrl = new URL(
  "../src/modules/integraciones/cooprinsem/server/backup-format.mjs",
  import.meta.url,
);

function parse(source, fileName) {
  return ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
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

test("la ruta autentica, sella y audita la descarga como último await", async () => {
  const source = await readFile(routeUrl, "utf8");
  const post = functionText(parse(source, "export-route.ts"), "POST");

  assertInOrder(post, [
    "isSameOriginMutation(request)",
    "await getAppUser()",
    "await authorizeApiLegalAcceptance(user)",
    "await readBoundedUrlEncodedForm(request)",
    'await authorizeApiAccess(',
    '"export_data"',
    "organizationId",
    "await loadPortableWorkspaceSnapshot(env.DB",
    "await portableWorkspaceSha256(",
    "await createPortableWorkspaceV2(",
    "await portableWorkspaceSha256(verified)",
    "await recordPortableWorkspaceExport(env.DB",
    "canonicalPortableWorkspaceJson(verified)",
    "return new Response(body",
  ]);
  const finalWrite = post.indexOf("await recordPortableWorkspaceExport(env.DB");
  const finalReturn = post.indexOf("return new Response(body", finalWrite);
  assert.notEqual(finalReturn, -1);
  assert.equal(
    [...post.slice(finalWrite, finalReturn).matchAll(/\bawait\b/gu)].length,
    3,
    "Sólo se permiten el writer y sus dos reautorizaciones internas.",
  );
  assert.match(
    post,
    /beforeCommit:\s*async \(\) => \{[\s\S]+await reauthorizeLegalApi\(user\)[\s\S]+await reauthorizeApiSnapshotAccess\(access/u,
  );
  assert.match(source, /capability: "export_data"/u);
  assert.match(source, /organizationId,\s*\}\);/u);
  assert.match(source, /const identityNonce = crypto\.randomUUID\(\);/u);
  assert.match(
    source,
    /fundosmart:portable-workspace-v2:identity:\$\{snapshot\.organization\.id\}:\$\{identityNonce\}:\$\{user\.subject\}/u,
  );
  assert.match(source, /generatedBy: `identity-sha256:\$\{identityDigest\}`/u);
  assert.match(source, /function isUuidV4/u);
  assert.doesNotMatch(source, /generatedBy:\s*(?:user\.email|access\.email)/u);
  assert.doesNotMatch(source, /validatePortableWorkspaceV2/u);
});

test("el cuerpo descargado es JSON canónico y publica ambas huellas", async () => {
  const source = await readFile(routeUrl, "utf8");
  const post = functionText(parse(source, "export-route.ts"), "POST");

  assert.match(source, /const body = canonicalPortableWorkspaceJson\(verified\);/u);
  assert.doesNotMatch(source, /canonicalPortableWorkspaceJson\(verified\)\}\s*\\n/u);
  assert.ok(
    post.indexOf("await recordPortableWorkspaceExport(env.DB")
      < post.indexOf("const body = canonicalPortableWorkspaceJson(verified)"),
  );
  assert.match(source, /const bodySha256 = await portableWorkspaceSha256\(verified\)/u);
  assert.match(source, /"Content-Length": String\(bodyBytes\.byteLength\)/u);
  assert.match(source, /"X-FundoSmart-SHA256": bodySha256/u);
  assert.match(
    source,
    /"X-FundoSmart-Workspace-SHA256": verified\.manifest\.workspaceSha256/u,
  );
  assert.match(source, /attachment; filename="\$\{filename\}"/u);
  assert.match(source, /"Cache-Control": "private, no-store"/u);
  assert.match(source, /"X-Content-Type-Options": "nosniff"/u);
  assert.doesNotMatch(source, /\bR2Bucket\b|\benv\.[A-Z0-9_]*R2\b/u);
});

test("la página ofrece autoservicio sólo a owner/admin activos no demo", async () => {
  const page = await readFile(pageUrl, "utf8");

  assert.match(
    page,
    /organization\.role === "owner" \|\| organization\.role === "admin"/u,
  );
  assert.match(page, /organization\.kind !== "demo"/u);
  assert.match(page, /action="\/api\/cuenta\/datos\/exportacion"/u);
  assert.match(page, /name="organizationId"[\s\S]+value=\{organization\.id\}/u);
  assert.match(page, /name="requestId"/u);
  assert.match(page, /33 secciones habilitadas/u);
  assert.match(page, /SHA-256 por sección/u);
  assert.match(page, /propietarios y administradores/u);
});

test("el snapshot usa columnas selladas, un batch y fail-closed", async () => {
  const repository = await readFile(repositoryUrl, "utf8");

  assert.match(repository, /withSession\("first-primary"\)/u);
  assert.match(
    repository,
    /workspaceMetadataStatement\(session, input\)[\s\S]+PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES\.map/u,
  );
  assert.match(repository, /results\.length !== statements\.length/u);
  assert.match(repository, /result\.success !== true/u);
  assert.match(repository, /WORKSPACE_EXPORT_SNAPSHOT_INCOMPLETE/u);
  assert.match(repository, /PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS \+ 1/u);
  assert.match(repository, /workspacePreflightStatement\(session, input\)/u);
  assert.match(repository, /section_canonical_row_bytes/u);
  assert.match(repository, /PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS/u);
  assert.match(repository, /PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES/u);
  assertInOrder(repository, [
    "workspacePreflightStatement(session, input)",
    "workspaceMetadataStatement(session, input)",
    "...PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map",
  ]);
  assert.match(repository, /WORKSPACE_EXPORT_SELECTION_PLAN/u);
  assert.match(
    repository,
    /PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT[\s\S]+projectionPolicyFingerprint/u,
  );
  assert.match(repository, /assertWorkspaceExportSelectionPlan\(\);/u);
  assert.doesNotMatch(repository, /source_system\s*=\s*'cooprinsem'/u);
  assert.doesNotMatch(
    repository,
    /target_entity\s*<>\s*'milk_quality_sample'/u,
  );
  assert.doesNotMatch(repository, /\.slice\(0,\s*PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS/u);
  assert.doesNotMatch(repository, /\bSELECT\s+(?:root\.)?\*/iu);
  assert.match(repository, /'workspace\.exported'/u);
  assert.match(repository, /abs\(-9223372036854775807 - 1\)/u);
  assertInOrder(repository, [
    "if (input.beforeCommit) await input.beforeCommit()",
    "await session.batch<Record<string, unknown>>(statements)",
  ]);
});

test("portable/restore v1 permanece intacto y separado", async () => {
  const [v1, format] = await Promise.all([
    readFile(v1RouteUrl, "utf8"),
    readFile(v1FormatUrl, "utf8"),
  ]);

  assert.match(format, /fundosmart\.portable-backup\.v1/u);
  assert.match(v1, /backup-format\.mjs/u);
  assert.doesNotMatch(v1, /portable-workspace\.v2/u);
  assert.doesNotMatch(v1, /workspace-export-repository/u);
});
