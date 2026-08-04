import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { rejectCrossSiteMutation } from "../worker/request-integrity.mjs";

const TARGET = "https://fundosmart.com/api/actividades";

test("safe methods do not require browser origin metadata", () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const request = new Request(TARGET, {
      method,
      headers: { Origin: "https://attacker.example", "Sec-Fetch-Site": "cross-site" },
    });
    assert.equal(rejectCrossSiteMutation(request), null, method);
  }
});

test("same-origin browser mutations are accepted", () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const request = new Request(TARGET, {
      method,
      headers: { Origin: "https://fundosmart.com", "Sec-Fetch-Site": "same-origin" },
    });
    assert.equal(rejectCrossSiteMutation(request), null, method);
  }
});

test("cross-site browser mutations are rejected without reaching a route", async () => {
  const response = rejectCrossSiteMutation(new Request(TARGET, {
    method: "POST",
    headers: { "Sec-Fetch-Site": "cross-site" },
  }));

  assert.ok(response);
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    error: "La solicitud fue rechazada porque no proviene de este sitio.",
  });
});

test("same-site subdomains cannot mutate across origins", () => {
  const response = rejectCrossSiteMutation(new Request(TARGET, {
    method: "POST",
    headers: { Origin: "https://portal.fundosmart.com", "Sec-Fetch-Site": "same-site" },
  }));

  assert.equal(response?.status, 403);
});

test("opaque and malformed origins fail closed", () => {
  for (const origin of ["null", "not a URL", "https://fundosmart.com https://attacker.example"]) {
    const response = rejectCrossSiteMutation(new Request(TARGET, {
      method: "DELETE",
      headers: { Origin: origin },
    }));
    assert.equal(response?.status, 403, origin);
  }
});

test("non-browser clients without origin metadata remain compatible", () => {
  const request = new Request(TARGET, { method: "POST" });
  assert.equal(rejectCrossSiteMutation(request), null);
});

test("the Worker enforces request integrity before dispatching routes", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const guardCall = source.indexOf("rejectCrossSiteMutation(request)");
  const sizeGuard = source.indexOf("await enforceApiMutationSize(request)", guardCall);
  const routeDispatch = source.indexOf("await handleRequest(guardedRequest, env, ctx)", sizeGuard);

  assert.match(source, /import \{ rejectCrossSiteMutation \} from "\.\/request-integrity\.mjs";/);
  assert.ok(guardCall >= 0);
  assert.ok(sizeGuard > guardCall);
  assert.ok(routeDispatch > sizeGuard);
});
