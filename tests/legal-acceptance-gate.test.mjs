import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");

test("private access checks the legal release before membership provisioning", async () => {
  const access = await source("app/access.ts");
  const pageGate = access.indexOf("await requirePageLegalAcceptance");
  const pageAuthorization = access.indexOf("return await authorizeUser", pageGate);
  const apiGate = access.indexOf("await authorizeApiLegalAcceptance");
  const apiAuthorization = access.indexOf("return await authorizeUser", apiGate);

  assert.ok(pageGate >= 0 && pageGate < pageAuthorization);
  assert.ok(apiGate >= 0 && apiGate < apiAuthorization);
  assert.match(access, /reauthorizePageAccess[\s\S]+requirePageAccess/);
  assert.match(access, /reauthorizeApiAccess[\s\S]+authorizeApiAccess/);
});

test("workspace selection, organization switching, and staff cannot bypass the gate", async () => {
  const [spaces, organization, staffAccess, staffApi, staffFeedback] = await Promise.all([
    source("app/espacios/page.tsx"),
    source("app/api/cuenta/organizacion/route.ts"),
    source("app/staff-access.ts"),
    source("app/api/staff/route.ts"),
    source("app/api/staff/feedback/route.ts"),
  ]);

  assert.match(spaces, /await requirePageLegalAcceptance/);
  assert.match(spaces, /await reauthorizeLegalPage/);
  assert.match(organization, /await authorizeApiLegalAcceptance/);
  assert.match(organization, /await reauthorizeLegalApi/);
  assert.match(staffAccess, /await requirePageLegalAcceptance/);
  assert.match(staffAccess, /await reauthorizeLegalIdentity/);
  assert.match(staffApi, /await authorizeApiLegalAcceptance/);
  assert.match(staffFeedback, /await authorizeApiLegalAcceptance/);
});

test("legal acceptance is explicit, same-origin, private, and reauthorized before output", async () => {
  const [page, route, access] = await Promise.all([
    source("app/cuenta/legal/page.tsx"),
    source("app/api/cuenta/legal/route.ts"),
    source("app/legal-access.ts"),
  ]);

  assert.match(page, /name="acceptTerms" required type="checkbox"/);
  assert.match(page, /name="acknowledgePrivacy"[\s\S]+required[\s\S]+type="checkbox"/);
  assert.match(route, /isSameOriginMutation\(request\)/);
  assert.match(route, /code: "CSRF_REJECTED"/);
  assert.match(route, /await readBoundedUrlEncodedForm\(request\)/);
  assert.match(route, /if \(formData instanceof Response\) return formData;/);
  assert.match(
    route,
    /beforeCommit:\s*async \(\) => \{[\s\S]+reauthorizeLegalApi\(user, \{[\s\S]+requireCurrentAcceptance: false[\s\S]+if \(current instanceof Response\) throw current/u,
  );
  assert.match(route, /if \(cause instanceof Response\) return cause;/u);
  assert.match(route, /await reauthorizeLegalApi\(user/);
  assert.ok(
    route.indexOf("await reauthorizeLegalApi(user") < route.lastIndexOf("return new Response"),
  );
  assert.match(access, /status: 428/);
  assert.match(access, /"Cache-Control": "private, no-store"/);
  assert.match(access, /"X-Content-Type-Options": "nosniff"/);
  assert.match(access, /parsed\.pathname === LEGAL_ACCEPTANCE_PATH/);
  assert.equal(
    access.includes("parsed.pathname.startsWith(`${LEGAL_ACCEPTANCE_PATH}/`)"),
    true,
  );
});
