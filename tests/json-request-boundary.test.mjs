import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readJsonObject } from "../app/json-body.mjs";

const ROUTES = [
  "../app/api/actividades/route.ts",
  "../app/api/configuracion/accesos/route.ts",
  "../app/api/fundos/route.ts",
  "../app/api/ganado/route.ts",
  "../app/api/ganado/animales/route.ts",
  "../app/api/ganado/pesajes/route.ts",
  "../app/api/ganado/plata/aportes/route.ts",
  "../app/api/ganado/plata/egresos/route.ts",
  "../app/api/ganado/plata/socios/route.ts",
  "../app/api/ganado/racion/route.ts",
  "../app/api/ganado/ficha/route.ts",
  "../app/api/integraciones/cooprinsem/configuracion/route.ts",
  "../app/api/integraciones/cooprinsem/conservacion/route.ts",
  "../app/api/integraciones/cooprinsem/conservacion-programada/route.ts",
  "../app/api/integraciones/cooprinsem/inconsistencias/route.ts",
  "../app/api/integraciones/cooprinsem/proyeccion/route.ts",
  "../app/api/leche/route.ts",
  "../app/api/potreros/route.ts",
  "../app/api/potreros/limites/route.ts",
  "../app/api/potreros/lote/route.ts",
  "../app/api/subdivisiones/route.ts",
];

function jsonRequest(body) {
  return new Request("https://fundosmart.com/api/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

test("valid JSON objects cross the request boundary unchanged", async () => {
  const result = await readJsonObject(jsonRequest('{"fieldId":"field-1","nested":{"ok":true}}'));
  assert.deepEqual(result, { fieldId: "field-1", nested: { ok: true } });
});

test("invalid syntax, null, arrays, and primitives receive the same private 400", async () => {
  for (const body of ["{", "null", "[]", '"text"', "42", "true"]) {
    const result = await readJsonObject(jsonRequest(body));
    assert.ok(result instanceof Response, body);
    assert.equal(result.status, 400, body);
    assert.equal(result.headers.get("Cache-Control"), "private, no-store", body);
    assert.deepEqual(await result.json(), {
      error: "La solicitud no contiene un objeto JSON válido.",
      code: "INVALID_JSON_BODY",
    });
  }
});

test("all CRUD routes parse JSON through the shared object boundary", async () => {
  const sources = await Promise.all(ROUTES.map((file) => readFile(new URL(file, import.meta.url), "utf8")));
  const combined = sources.join("\n");

  assert.equal((combined.match(/readJsonObject</g) ?? []).length, ROUTES.length);
  assert.doesNotMatch(combined, /request\.json\(\)/);
  for (const source of sources) {
    assert.match(source, /import \{ readJsonObject \} from "@\/app\/json-body\.mjs";/);
    assert.match(source, /if \((payload|body) instanceof Response\) return \1;/);
  }
});
