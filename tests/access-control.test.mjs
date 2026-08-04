import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  defaultWorkspaceMembership,
  normalizeAccessEmail,
  roleHasCapability,
  roleHasGlobalFieldAccess,
} from "../src/modules/access/domain/access-rules.mjs";

const root = process.cwd();
const staffApiRoute = path.join(root, "app", "api", "staff", "route.ts");
const staffPageRoute = path.join(root, "app", "(producto)", "staff", "page.tsx");
const legalApiRoute = path.join(root, "app", "api", "cuenta", "legal", "route.ts");
const legalPageRoute = path.join(root, "app", "cuenta", "legal", "page.tsx");
const closureApiRoute = path.join(root, "app", "api", "cuenta", "datos", "cierre", "route.ts");
const accountDataPageRoute = path.join(root, "app", "cuenta", "datos", "page.tsx");

test("la matriz de roles separa lectura, operación, finanzas, importaciones y administración", () => {
  assert.equal(roleHasCapability("owner", "manage_members"), true);
  assert.equal(roleHasCapability("admin", "manage_members"), true);
  assert.equal(roleHasCapability("owner", "restore_data"), true);
  assert.equal(roleHasCapability("admin", "restore_data"), true);
  assert.equal(roleHasCapability("owner", "export_data"), true);
  assert.equal(roleHasCapability("admin", "export_data"), true);
  assert.equal(roleHasCapability("manager", "export_data"), false);
  assert.equal(roleHasCapability("manager", "manage_imports"), true);
  assert.equal(roleHasCapability("manager", "manage_finance"), true);
  assert.equal(roleHasCapability("manager", "restore_data"), false);
  assert.equal(roleHasCapability("operator", "operate"), true);
  assert.equal(roleHasCapability("operator", "manage_imports"), false);
  assert.equal(roleHasCapability("viewer", "view"), true);
  assert.equal(roleHasCapability("viewer", "operate"), false);
});

test("solo propietario y administrador heredan todos los fundos", () => {
  assert.equal(roleHasGlobalFieldAccess("owner"), true);
  assert.equal(roleHasGlobalFieldAccess("admin"), true);
  assert.equal(roleHasGlobalFieldAccess("manager"), false);
  assert.equal(roleHasGlobalFieldAccess("operator"), false);
  assert.equal(roleHasGlobalFieldAccess("viewer"), false);
});

test("el espacio de entrada se elige por responsabilidad y nunca es la demo", () => {
  const kinds = new Map([
    ["org-compartida", "shared"],
    ["org-personal", "personal"],
    ["org-demo", "demo"],
    ["org-vecina", "shared"],
  ]);
  const membership = (organizationId, role, createdAt) => ({ organizationId, role, createdAt });

  /* El rol manda: ser propietario del espacio personal pesa más que mirar el
     espacio compartido de otra persona. */
  assert.equal(
    defaultWorkspaceMembership(
      [membership("org-vecina", "viewer", "2026-01-01"), membership("org-personal", "owner", "2026-05-01")],
      kinds,
    ).organizationId,
    "org-personal",
  );

  /* Con el mismo rol gana el espacio compartido: hay otras personas trabajando
     ahí, y el personal es donde uno prueba. */
  assert.equal(
    defaultWorkspaceMembership(
      [membership("org-personal", "owner", "2026-01-01"), membership("org-compartida", "owner", "2026-05-01")],
      kinds,
    ).organizationId,
    "org-compartida",
  );

  /* La demo es de solo lectura: nunca puede ser el destino por omisión mientras
     exista cualquier otro espacio. */
  assert.equal(
    defaultWorkspaceMembership(
      [membership("org-demo", "owner", "2026-01-01"), membership("org-personal", "viewer", "2026-05-01")],
      kinds,
    ).organizationId,
    "org-personal",
  );

  /* Empatados rol y tipo, decide la antigüedad y después el identificador: la
     elección no puede depender del orden en que la base devuelva las filas. */
  const tied = [
    membership("org-b", "admin", "2026-03-01"),
    membership("org-a", "admin", "2026-01-01"),
    membership("org-c", "admin", "2026-01-01"),
  ];
  assert.equal(defaultWorkspaceMembership(tied, kinds).organizationId, "org-a");
  assert.equal(defaultWorkspaceMembership([...tied].reverse(), kinds).organizationId, "org-a");

  assert.equal(defaultWorkspaceMembership([], kinds), null);
});

test("el correo de membresía se compara de manera canónica", () => {
  assert.equal(normalizeAccessEmail("  Persona@Ejemplo.CL "), "persona@ejemplo.cl");
  assert.equal(normalizeAccessEmail(null), "");
});

test("el acceso staff legado espera el corte fail-closed en todas sus superficies", async () => {
  const [staffAccess, staffApi, staffFeedbackApi, accessConfiguration] = await Promise.all([
    readFile(path.join(root, "app", "staff-access.ts"), "utf8"),
    readFile(path.join(root, "app", "api", "staff", "route.ts"), "utf8"),
    readFile(path.join(root, "app", "api", "staff", "feedback", "route.ts"), "utf8"),
    readFile(path.join(root, "app", "configuracion", "accesos", "page.tsx"), "utf8"),
  ]);

  assert.match(staffAccess, /platform-staff-v2-required/);
  assert.match(staffAccess, /\.withSession\("first-primary"\)/);
  assert.match(staffAccess, /return marker === null/);
  assert.match(staffAccess, /catch\s*\{\s*return false;\s*\}/);
  // Superficies ya migradas: exigen una capacidad explícita por operación y
  // ninguna vuelve a nombrar el correo legado.
  assert.doesNotMatch(staffFeedbackApi, /\bisStaffEmail\b/u);
  assert.match(staffFeedbackApi, /await authorizeStaffCapability\("support:read"\)/u);
  assert.doesNotMatch(staffApi, /\bisStaffEmail\b/u);
  assert.match(staffApi, /await authorizeStaffCapability\(capability\)/u);
  assert.match(staffApi, /await verifyStaff\("support:read"\)/u);
  assert.match(staffApi, /await verifyStaff\("tenants:manage"\)/u);
  assert.match(staffApi, /await verifyStaff\(updateActionCapability\(action\)\)/u);
  // La auditoría no viaja con la capacidad de soporte: exige la suya.
  assert.match(staffApi, /await hasStaffCapability\(staffAccess, "audit:read"\)/u);
  assert.match(staffApi, /const auditLogsList = canReadAudit/u);

  // Superficie migrada a autorización por capacidad persistida:
  // explícita, no del correo, y el indicador falla cerrado ante ausencia.
  assert.doesNotMatch(accessConfiguration, /\bisStaffEmail\b/u);
  assert.match(
    accessConfiguration,
    /await authorizeStaffCapability\("support:read"\)/u,
  );
  assert.match(
    accessConfiguration,
    /staffAccess\?\.resolution\.granted === true/u,
  );
});

test("todas las rutas API pasan por autorización interna", async () => {
  const routeFiles = await findFiles(path.join(root, "app", "api"), "route.ts");
  assert.ok(routeFiles.length >= 20);
  for (const file of routeFiles) {
    const source = await readFile(file, "utf8");
    if (file === legalApiRoute) {
      assert.match(source, /getAppUser\(\)/);
      assert.match(source, /await reauthorizeLegalApi\(user/);
      assert.match(source, /"Cache-Control": "private, no-store"/);
      continue;
    }
    if (file === closureApiRoute) {
      assert.match(source, /getAppUser\(\)/);
      assert.match(source, /await authorizeApiLegalAcceptance\(user\)/);
      assert.match(source, /isSameOriginMutation\(request\)/);
      assert.match(source, /requestAccountClosure/);
      assert.match(source, /revokeAccountClosure/);
      assert.match(source, /await reauthorizeLegalApi\(user\)/);
      continue;
    }
    if (file === path.join(root, "app", "api", "cuenta", "organizacion", "route.ts")) {
      assert.match(source, /isSameOriginMutation\(request\)/);
      assert.match(source, /getAppUser\(\)/);
      assert.match(source, /await readBoundedUrlEncodedForm\(request\)/);
      assert.match(source, /await reauthorizeLegalApi\(user\)/);
      assert.match(source, /await canSelectOrganization\(current, organizationId\)/);
      assert.ok(
        source.indexOf("await reauthorizeLegalApi(user)")
          < source.indexOf("await canSelectOrganization(current, organizationId)"),
      );
      continue;
    }
    if (file === path.join(root, "app", "api", "staff", "feedback", "route.ts")) {
      assert.match(source, /await authorizeStaffCapability\("support:read"\)/u);
      assert.doesNotMatch(source, /\bisStaffEmail\b/u);
      continue;
    }
    if (file === staffApiRoute) {
      assert.match(
        source,
        /async function verifyStaff\(capability: StaffCapability\): Promise<StaffCapabilityAccess \| Response \| null> \{\s*const access = await authorizeStaffCapability\(capability\);\s*if \(!access \|\| !access\.resolution\.granted\) \{\s*return null;\s*\}/u,
      );
      assert.match(
        source,
        /async function readStaffConsole\(\)\s*\{\s*const staffAccess = await verifyStaff\("support:read"\);\s*(?:if \(staffAccess instanceof Response\) return staffAccess;\s*)?if \(!staffAccess\)/u,
      );
      assert.doesNotMatch(source, /\bisStaffEmail\b/u);
      for (const method of ["GET", "POST", "PUT"]) {
        assert.match(source, new RegExp(`export async function ${method}\\(`, "u"));
      }
      assert.doesNotMatch(source, /\bauthorizeApiAccess\b/u);
      assert.doesNotMatch(source, /from ["']@\/app\/access["']/u);
      assert.doesNotMatch(source, /if\s*\(\s*false\s*\)/u);
      assert.doesNotMatch(source, /For static test compliance/u);
      continue;
    }
    assert.match(source, /authorizeApiAccess\(/, path.relative(root, file));
  }
});

test("cada mutación API exige una capacidad que la demo de solo lectura no posee", async () => {
  const routeFiles = await findFiles(path.join(root, "app", "api"), "route.ts");
  const mutation = /export async function (POST|PUT|PATCH|DELETE)\b/g;
  const writeCapabilities = new Set([
    "operate",
    "manage_imports",
    "manage_finance",
    "manage_members",
    "export_data",
    "restore_data",
  ]);
  let mutationCount = 0;
  for (const file of routeFiles) {
    const source = await readFile(file, "utf8");
    const isOrganizationSelection = file === path.join(root, "app", "api", "cuenta", "organizacion", "route.ts");
    const isFeedbackSubmission = file === path.join(root, "app", "api", "feedback", "route.ts");
    const isMapTileUsage = file === path.join(root, "app", "api", "mapas", "teselas", "consumo", "route.ts");
    const isStaffFeedback = file === path.join(root, "app", "api", "staff", "feedback", "route.ts");
    const isStaffAdministration = file === staffApiRoute;
    const isLegalAcceptance = file === legalApiRoute;
    const isAccountClosure = file === closureApiRoute;
    for (const match of source.matchAll(mutation)) {
      mutationCount += 1;
      const nextHandler = source.indexOf("\nexport async function ", match.index + 1);
      const authorizationWindow = source.slice(match.index, nextHandler === -1 ? source.length : nextHandler);
      const label = `${path.relative(root, file)}:${match[1]}`;
      if (isLegalAcceptance) {
        assert.match(authorizationWindow, /isSameOriginMutation\(request\)/);
        assert.match(authorizationWindow, /getAppUser\(\)/);
        assert.match(authorizationWindow, /recordCurrentLegalAcceptance/);
        assert.match(authorizationWindow, /await reauthorizeLegalApi\(user/);
        continue;
      }
      if (isAccountClosure) {
        assert.match(authorizationWindow, /isSameOriginMutation\(request\)/);
        assert.match(authorizationWindow, /getAppUser\(\)/);
        assert.match(authorizationWindow, /authorizeApiLegalAcceptance\(user\)/);
        assert.match(source, /requestAccountClosure/);
        assert.match(source, /revokeAccountClosure/);
        continue;
      }
      if (isOrganizationSelection) {
        assert.match(authorizationWindow, /isSameOriginMutation\(request\)/);
        assert.match(authorizationWindow, /getAppUser\(\)/);
        assert.match(authorizationWindow, /readBoundedUrlEncodedForm\(request\)/);
        assert.match(authorizationWindow, /reauthorizeLegalApi\(user\)/);
        assert.match(authorizationWindow, /await canSelectOrganization\(current, organizationId\)/);
        continue;
      }
      if (isFeedbackSubmission) {
        assert.match(authorizationWindow, /authorizeApiAccess\("view"/);
        assert.match(authorizationWindow, /access\.email === DEMO_EMAIL/);
        continue;
      }
      if (isMapTileUsage) {
        assert.match(authorizationWindow, /authorizeApiAccess\("view"/);
        assert.match(authorizationWindow, /access\.email === DEMO_EMAIL/);
        continue;
      }
      if (isStaffFeedback) {
        assert.match(authorizationWindow, /verifyStaff\(\)/);
        assert.match(source, /await authorizeStaffCapability\("support:read"\)/u);
        assert.doesNotMatch(source, /\bisStaffEmail\b/u);
        continue;
      }
      if (isStaffAdministration) {
        const helper = {
          POST: "createStaffResource",
          PUT: "updateStaffResource",
        }[match[1]];
        assert.ok(helper, label);
        assert.match(
          authorizationWindow,
          new RegExp(
            `export async function ${match[1]}\\(request: Request\\) \\{\\s*if \\(!isSameOriginMutation\\(request\\)\\) return staffCsrfResponse\\(\\);\\s*return withStaffApiFailure\\([\\s\\S]*?\\(\\) => ${helper}\\(request\\),\\s*\\);\\s*\\}`,
            "u",
          ),
          label,
        );
        // Cada mutación administrativa exige la capacidad de su acción, y
        // ninguna toca datos antes de recibirla.
        const guard = {
          POST: 'const staffAccess = await verifyStaff("tenants:manage");',
          PUT: "const staffAccess = await verifyStaff(updateActionCapability(action));",
        }[match[1]];
        const guardIndex = authorizationWindow.indexOf(guard);
        assert.ok(guardIndex > 0, `${label}: falta el guard por capacidad`);
        assert.match(
          authorizationWindow.slice(guardIndex),
          /^[^\n]*\n\s*(?:if \(staffAccess instanceof Response\) return staffAccess;\s*\n\s*)?if \(!staffAccess\) \{/u,
          label,
        );
        assert.match(authorizationWindow, /readBoundedJsonObject/iu, label);
        assert.doesNotMatch(authorizationWindow, /\breadJsonObject\b/u, label);
        assert.doesNotMatch(
          authorizationWindow.slice(0, guardIndex),
          /getDb\(/u,
          `${label}: no puede consultar datos antes de autorizar`,
        );
        assert.doesNotMatch(source, /\bauthorizeApiAccess\b/u, label);
        assert.doesNotMatch(source, /if\s*\(\s*false\s*\)/u, label);
        continue;
      }
      const authorization = authorizationWindow.match(/authorizeApiAccess\(([^)]*)\)/);
      assert.ok(authorization, label);
      const capabilities = [...authorization[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
      assert.ok(capabilities.length > 0, label);
      assert.ok(capabilities.some((capability) => writeCapabilities.has(capability)), label);
      assert.equal(capabilities.includes("view"), false, label);
    }
  }
  assert.ok(mutationCount >= 25);
});

test("todas las páginas de negocio exigen membresía", async () => {
  const pageFiles = (await findFiles(path.join(root, "app"), "page.tsx"))
    .filter((file) => file !== path.join(root, "app", "page.tsx"))
    .filter((file) => !file.includes(`${path.sep}auth${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}sin-acceso${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}privacidad${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}terminos${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}precios${path.sep}`))
    .filter((file) => !file.includes(`${path.sep}instalar${path.sep}`));
  for (const file of pageFiles) {
    const source = await readFile(file, "utf8");
    if (file === legalPageRoute) {
      assert.match(source, /requireAppUser\("\/app\/cuenta\/legal"\)/);
      assert.match(source, /await reauthorizeLegalPage/);
      assert.match(source, /name="acceptTerms" required type="checkbox"/);
      assert.match(source, /name="acknowledgePrivacy"/);
      continue;
    }
    if (file === accountDataPageRoute) {
      assert.match(source, /getAppUser\(\)/);
      assert.match(source, /await requirePageLegalAcceptance/);
      assert.match(source, /listAccountClosureRequests/);
      assert.match(source, /reauthorizeLegalIdentity\(user\)/);
      assert.match(source, /loadAccountDataSnapshot\(user, now\)/);
      continue;
    }
    if (file === path.join(root, "app", "espacios", "page.tsx")) {
      assert.match(source, /getAppUser\(\)/);
      assert.match(source, /listAccessibleOrganizations\(user\)/);
      assert.match(source, /await reauthorizeLegalPage\(user, "\/app\/espacios"\)/);
      assert.match(source, /await listOrganizationsOrRecover\(currentUser\)/);
      continue;
    }
    if (file === staffPageRoute) {
      assert.match(
        source,
        /export default async function StaffConsoleRoute\(\)\s*\{\s*const access = await requireStaffCapability\("\/app\/staff", "support:read"\);/u,
      );
      assert.match(
        source,
        /const currentAccess = await reauthorizeStaffCapability\(access\)/u,
      );
      assert.doesNotMatch(source, /\bisStaffEmail\b/u);
      assert.doesNotMatch(source, /\brequirePageAccess\b/u);
      assert.doesNotMatch(source, /from ["']@\/app\/access["']/u);
      assert.doesNotMatch(source, /if\s*\(\s*false\s*\)/u);
      assert.doesNotMatch(source, /For static test compliance/u);
      continue;
    }
    assert.match(source, /requirePageAccess\(/, path.relative(root, file));
  }
});

test("la migración de acceso conserva unicidad e invariantes de rol", async () => {
  const migration = (await Promise.all([
    readFile(path.join(root, "drizzle", "0000_public_schema.sql"), "utf8"),
    readFile(path.join(root, "drizzle", "0001_public_invariants.sql"), "utf8"),
  ])).join("\n");
  assert.match(migration, /CREATE TABLE `organization_memberships`/);
  assert.match(migration, /organization_memberships_email_unique/);
  assert.match(migration, /organization_memberships_role_check/);
  assert.match(migration, /CREATE TABLE `membership_field_access`/);
  assert.match(migration, /CREATE TABLE `organization_access_bootstrap`/);
  assert.match(migration, /organization_memberships_keep_active_owner_update/);
  assert.match(migration, /organization_memberships_keep_active_owner_delete/);
  assert.match(migration, /RAISE\(ABORT, 'LAST_ACTIVE_OWNER'\)/);
});

test("database rejects deleting or demoting the last active owner", async () => {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = path.join(root, "drizzle");
  for (const name of (await readdir(migrationDirectory)).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec((await readFile(path.join(migrationDirectory, name), "utf8")).replaceAll("--> statement-breakpoint", ""));
  }
  db.exec(`
    INSERT OR IGNORE INTO organizations (id, name) VALUES ('org-access-test', 'Access test');
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('owner-1', 'org-access-test', 'one@example.com', 'one@example.com', 'One', 'owner', 'active', 'system');
  `);
  assert.throws(() => db.exec("UPDATE organization_memberships SET role = 'admin' WHERE id = 'owner-1'"), /LAST_ACTIVE_OWNER/);
  assert.throws(() => db.exec("DELETE FROM organization_memberships WHERE id = 'owner-1'"), /LAST_ACTIVE_OWNER/);
  db.exec(`
    INSERT INTO organization_memberships
      (id, organization_id, user_email, normalized_email, display_name, role, status, created_by)
    VALUES
      ('owner-2', 'org-access-test', 'two@example.com', 'two@example.com', 'Two', 'owner', 'active', 'system');
    UPDATE organization_memberships SET role = 'admin' WHERE id = 'owner-1';
  `);
  assert.equal(db.prepare("SELECT role FROM organization_memberships WHERE id = 'owner-1'").get().role, "admin");
  assert.throws(() => db.exec("UPDATE organization_memberships SET status = 'suspended' WHERE id = 'owner-2'"), /LAST_ACTIVE_OWNER/);
  assert.deepEqual(
    { ...db.prepare("SELECT plan_code, field_limit, paddock_limit FROM organizations WHERE id = 'org-access-test'").get() },
    { plan_code: "legacy", field_limit: null, paddock_limit: null },
  );
  assert.throws(() => db.exec(`
    INSERT INTO organizations (
      id, name, kind, plan_code, field_limit, paddock_limit, self_service_owner_email
    ) VALUES (
      'org-invalid-free', 'Invalid', 'personal', 'free', 1, 200, 'free@example.com'
    )
  `), /INVALID_ORGANIZATION_PLAN/);
  db.exec(`
    INSERT INTO organizations (
      id, name, kind, plan_code, field_limit, paddock_limit, self_service_owner_email
    ) VALUES (
      'org-valid-free', 'Valid', 'personal', 'free', 2, 200, 'free@example.com'
    )
  `);
  assert.throws(
    () => db.exec("UPDATE organizations SET paddock_limit = 201 WHERE id = 'org-valid-free'"),
    /INVALID_ORGANIZATION_PLAN/,
  );
  db.close();
});

test("la migración freemium declara límites y validación de planes", async () => {
  const migration = (await Promise.all([
    readFile(path.join(root, "drizzle", "0000_public_schema.sql"), "utf8"),
    readFile(path.join(root, "drizzle", "0001_public_invariants.sql"), "utf8"),
  ])).join("\n");
  assert.match(migration, /`plan_code` text DEFAULT 'legacy' NOT NULL/);
  assert.match(migration, /organizations_self_service_owner_unique/);
  assert.match(migration, /CREATE TRIGGER `organizations_plan_insert`/);
  assert.match(migration, /CREATE TRIGGER `organizations_plan_update`/);
  assert.match(migration, /NEW\.`field_limit` IS NOT 2/);
  assert.match(migration, /NEW\.`paddock_limit` IS NOT 200/);
});

test("membership batches revalidate current authority and chain every write to an audit guard", async () => {
  const source = await readFile(path.join(root, "src", "modules", "access", "server", "access-repository.ts"), "utf8");
  assert.match(source, /current_actor\.status = 'active'/);
  assert.match(source, /current_actor\.role IN \('owner', 'admin'\)/);
  assert.match(source, /current_membership\.updated_at = \?/);
  assert.match(source, /json_each\(\?\) AS expected_access/);
  assert.match(source, /FROM audit_log AS access_guard/);
  assert.match(source, /FIELD_SCOPE_CONFLICT/);
  assert.doesNotMatch(source, /onConflictDoUpdate/);
});

test("feature flag administration revalidates persisted authority in its final batch", async () => {
  const [repository, route] = await Promise.all([
    readFile(path.join(root, "src", "modules", "access", "server", "feature-flag-repository.ts"), "utf8"),
    readFile(path.join(root, "app", "api", "configuracion", "funcionalidades", "route.ts"), "utf8"),
  ]);
  assert.match(repository, /FEATURE_FLAG_ACCESS_CHANGED/);
  assert.match(repository, /current_actor\.role IN \('owner', 'admin'\)/);
  assert.match(repository, /current_field\.is_demo = 0/);
  assert.match(repository, /FROM audit_log AS authorization_receipt/);
  assert.match(repository, /abs\(-9223372036854775807 - 1\)/);
  assert.match(route, /cause instanceof FeatureFlagAccessError[\s\S]+409/);
});

async function findFiles(directory, filename) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return findFiles(target, filename);
    return entry.isFile() && entry.name === filename ? [target] : [];
  }));
  return nested.flat();
}
