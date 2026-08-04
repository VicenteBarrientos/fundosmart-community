import assert from "node:assert/strict";
import test from "node:test";
import { PRODUCT_ROOT_ROUTE, productRoutePath } from "../worker/product-routes.mjs";

test("las rutas públicas del producto se reescriben a su segmento interno", () => {
  assert.equal(productRoutePath("/app"), PRODUCT_ROOT_ROUTE);
  assert.equal(productRoutePath("/app/potreros"), "/potreros");
  assert.equal(productRoutePath("/app/ganado/ficha"), "/ganado/ficha");
  assert.equal(productRoutePath("/app/configuracion/accesos"), "/configuracion/accesos");
});

/* Sin esta reescritura `/app.rsc` llegaba intacto al App Router, que respondía
   404 y obligaba al navegador a recargar el documento completo cada vez que se
   volvía al Resumen. La carga RSC debe resolverse igual que la ruta que
   representa, para que el cambio de módulo siga siendo navegación de cliente. */
test("la carga RSC del Resumen se reescribe igual que su ruta", () => {
  assert.equal(productRoutePath("/app.rsc"), `${PRODUCT_ROOT_ROUTE}.rsc`);
  assert.equal(productRoutePath("/app/potreros.rsc"), "/potreros.rsc");
  assert.equal(productRoutePath("/app/ganado/ficha.rsc"), "/ganado/ficha.rsc");
});

test("las rutas ajenas al producto no se tocan", () => {
  for (const pathname of ["/", "/precios", "/auth/google", "/api/ganado", "/healthz", "/application"]) {
    assert.equal(productRoutePath(pathname), null, pathname);
  }
});
