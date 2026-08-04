import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEFAULT_API_BODY_LIMIT_BYTES,
  enforceApiMutationSize,
  IMPORT_CENTER_BODY_LIMIT_BYTES,
  IMPORT_BODY_LIMIT_BYTES,
  RESTORE_BODY_LIMIT_BYTES,
} from "../worker/request-size.mjs";

function request(path, method, contentLength, body) {
  const headers = contentLength === undefined ? {} : { "Content-Length": String(contentLength) };
  return new Request(`https://fundosmart.com${path}`, { method, headers, body });
}

test("safe methods do not apply a request body limit", async () => {
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const original = request("/api/fundos", method, Number.MAX_SAFE_INTEGER);
    assert.deepEqual(await enforceApiMutationSize(original), { request: original, rejection: null }, method);
  }
});

test("ordinary API mutations reject declared bodies above 2 MiB", async () => {
  const accepted = request("/api/fundos", "POST", DEFAULT_API_BODY_LIMIT_BYTES);
  assert.deepEqual(await enforceApiMutationSize(accepted), { request: accepted, rejection: null });

  const { rejection: response } = await enforceApiMutationSize(
    request("/api/fundos", "POST", DEFAULT_API_BODY_LIMIT_BYTES + 1),
  );
  assert.ok(response);
  assert.equal(response.status, 413);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.deepEqual(await response.json(), {
    error: "La solicitud supera el tamaño máximo permitido.",
    maxBytes: DEFAULT_API_BODY_LIMIT_BYTES,
  });
});

test("DBF multipart requests receive 1 MiB of framing headroom", async () => {
  const path = "/api/integraciones/cooprinsem/importaciones";
  assert.equal((await enforceApiMutationSize(request(path, "POST", IMPORT_BODY_LIMIT_BYTES))).rejection, null);
  assert.equal((await enforceApiMutationSize(request(`${path}/`, "POST", IMPORT_BODY_LIMIT_BYTES + 1))).rejection?.status, 413);
});

test("the import center accepts its 10 MiB PDF plus multipart framing", async () => {
  const path = "/api/importaciones";
  assert.equal(
    (await enforceApiMutationSize(request(path, "POST", IMPORT_CENTER_BODY_LIMIT_BYTES))).rejection,
    null,
  );
  assert.equal(
    (await enforceApiMutationSize(request(`${path}/`, "POST", IMPORT_CENTER_BODY_LIMIT_BYTES + 1))).rejection?.status,
    413,
  );
});

test("portable backup multipart requests receive their larger route limit", async () => {
  const path = "/api/integraciones/cooprinsem/restauracion?intent=preview";
  assert.equal((await enforceApiMutationSize(request(path, "POST", RESTORE_BODY_LIMIT_BYTES))).rejection, null);
  assert.equal((await enforceApiMutationSize(request(path, "POST", RESTORE_BODY_LIMIT_BYTES + 1))).rejection?.status, 413);
});

test("non-API routes remain compatible without consuming their bodies", async () => {
  const original = request("/demo", "POST", Number.MAX_SAFE_INTEGER);
  assert.deepEqual(await enforceApiMutationSize(original), { request: original, rejection: null });
  assert.equal(original.bodyUsed, false);
});

test("API bodies without a usable length are preserved after bounded inspection", async () => {
  for (const contentLength of [undefined, "invalid"]) {
    const original = request("/api/fundos", "POST", contentLength, "carga de prueba");
    const result = await enforceApiMutationSize(original);

    assert.equal(result.rejection, null);
    assert.notEqual(result.request, original);
    assert.equal(await result.request.text(), "carga de prueba");
    assert.equal(result.request.headers.get("Content-Length"), null);
  }
});

test("streamed API bodies without Content-Length are rejected after crossing the limit", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.enqueue(new Uint8Array(1));
    },
  });
  const streamedRequest = new Request("https://fundosmart.com/api/fundos", {
    method: "POST",
    body,
    duplex: "half",
  });

  const { rejection: response } = await enforceApiMutationSize(streamedRequest);
  assert.equal(response?.status, 413);
  assert.deepEqual(await response.json(), {
    error: "La solicitud supera el tamaño máximo permitido.",
    maxBytes: DEFAULT_API_BODY_LIMIT_BYTES,
  });
});

test("a failed body stream is rejected without dispatching a partial request", async () => {
  const body = new ReadableStream({
    pull() {
      throw new Error("private stream failure");
    },
  });
  const brokenRequest = new Request("https://fundosmart.com/api/fundos", {
    method: "POST",
    body,
    duplex: "half",
  });

  const { rejection: response } = await enforceApiMutationSize(brokenRequest);
  assert.equal(response?.status, 400);
  assert.deepEqual(await response.json(), {
    error: "No fue posible leer el cuerpo de la solicitud.",
  });
});

test("arbitrarily large numeric lengths cannot overflow the comparison", async () => {
  const { rejection: response } = await enforceApiMutationSize(
    request("/api/fundos", "DELETE", "9".repeat(200)),
  );
  assert.equal(response?.status, 413);
});

test("the Worker rejects oversized requests before dispatching routes", async () => {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const sizeGuard = source.indexOf("await enforceApiMutationSize(request)");
  const routeDispatch = source.indexOf("await handleRequest(guardedRequest, env, ctx)", sizeGuard);

  assert.match(source, /import \{ enforceApiMutationSize \} from "\.\/request-size\.mjs";/);
  assert.ok(sizeGuard >= 0);
  assert.ok(routeDispatch > sizeGuard);
});
