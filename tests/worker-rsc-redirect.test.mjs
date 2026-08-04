import assert from "node:assert/strict";
import test from "node:test";
import { rscNormalizationTarget } from "../worker/rsc-redirect.mjs";

const ORIGIN = "https://fundosmart.example";

function redirect(location, status = 307) {
  return new Response(null, { status, headers: location ? { Location: location } : {} });
}

test("absorbe la normalización de `_rsc` que sólo cambia el valor del parámetro", () => {
  const request = new Request(`${ORIGIN}/ganado.rsc?_rsc=abc123`);
  const target = rscNormalizationTarget(request, redirect("/ganado.rsc?_rsc"));
  assert.equal(target?.pathname, "/ganado.rsc");
  assert.equal(target?.origin, ORIGIN);
});

test("conserva el resto de la query al absorber la normalización", () => {
  const request = new Request(`${ORIGIN}/leche.rsc?section=settlements&_rsc=abc`);
  const target = rscNormalizationTarget(request, redirect("/leche.rsc?section=settlements&_rsc"));
  assert.equal(target?.searchParams.get("section"), "settlements");
});

/* Los redirects que cambian de ruta son los que gobiernan el acceso: si el
   Worker se los tragara, el navegador nunca llegaría a iniciar sesión ni a
   elegir espacio. */
test("deja pasar los redirects reales que cambian de ruta", () => {
  const request = new Request(`${ORIGIN}/dashboard.rsc?_rsc=abc`);
  for (const location of [
    "/cuenta?modo=personal&returnTo=%2Fapp",
    "/app/espacios?returnTo=%2Fapp",
    "/app/sin-acceso?code=MEMBERSHIP_REQUIRED",
  ]) {
    assert.equal(rscNormalizationTarget(request, redirect(location)), null, location);
  }
});

test("deja pasar los redirects que cambian otra parte de la query", () => {
  const request = new Request(`${ORIGIN}/leche.rsc?section=settlements&_rsc=abc`);
  assert.equal(rscNormalizationTarget(request, redirect("/leche.rsc?section=reconciliation&_rsc")), null);
});

test("ignora respuestas que no son redirect de normalización", () => {
  const request = new Request(`${ORIGIN}/ganado.rsc?_rsc=abc`);
  assert.equal(rscNormalizationTarget(request, new Response("ok", { status: 200 })), null);
  assert.equal(rscNormalizationTarget(request, redirect(null)), null);
  assert.equal(rscNormalizationTarget(request, redirect("https://otro.example/ganado.rsc?_rsc")), null);
});

test("no absorbe nada fuera de una navegación sin cuerpo", () => {
  const request = new Request(`${ORIGIN}/ganado.rsc?_rsc=abc`, { method: "POST" });
  assert.equal(rscNormalizationTarget(request, redirect("/ganado.rsc?_rsc")), null);
});

test("exige que ambas URLs traigan `_rsc` para considerarlo normalización", () => {
  const request = new Request(`${ORIGIN}/ganado.rsc`);
  assert.equal(rscNormalizationTarget(request, redirect("/ganado.rsc?_rsc")), null);
});
