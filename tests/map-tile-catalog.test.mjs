import assert from "node:assert/strict";
import test from "node:test";
import {
  BASEMAP_SURFACES,
  FORBIDDEN_TILE_HOSTS,
  LICENSED_BASEMAP_HOST,
  MAP_BASEMAP_CATALOG,
  MAP_TILE_POLICY,
  basemapEntitlement,
  fallbackBasemap,
  isValidTileUsageReport,
  resolveBasemap,
  shouldDegradeOnStatus,
} from "../src/core/maps/tile-policy.mjs";

test("el catálogo se agrega sin alterar la política de teselas vigente", () => {
  assert.equal(MAP_TILE_POLICY.version, "fundosmart.map-tiles.v1", "la política existente no cambia de forma");
  assert.equal(MAP_TILE_POLICY.online.urlTemplate, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(MAP_TILE_POLICY.offline.enabled, false, "el catálogo licenciado no habilita offline");
  assert.equal(MAP_TILE_POLICY.exports.thirdPartyBasemapEnabled, false, "ni exportación impresa");
  assert.equal(MAP_BASEMAP_CATALOG.version, "fundosmart.map-catalog.v1");
});

test("solo OSM funciona sin credencial y es el único fallback", () => {
  const sinCredencial = MAP_BASEMAP_CATALOG.providers.filter((provider) => !provider.requiresCredential);
  assert.deepEqual(sinCredencial.map((provider) => provider.id), ["osm"]);

  const fallbacks = MAP_BASEMAP_CATALOG.providers.filter((provider) => provider.isFallback);
  assert.equal(fallbacks.length, 1, "dos fallbacks es no tener ninguno");
  assert.equal(fallbackBasemap().id, "osm");
  assert.equal(fallbackBasemap().requiresCredential, false, "un fallback que exige credencial falla cuando más se necesita");
});

test("el catálogo declara Satélite, Topográfico y Relieve con estilo y atribución", () => {
  const licenciados = MAP_BASEMAP_CATALOG.providers.filter((provider) => provider.requiresCredential);
  assert.deepEqual(licenciados.map((provider) => provider.id).sort(), ["relieve", "satelite", "topografico"]);
  licenciados.forEach((provider) => {
    assert.match(provider.styleName, /^arcgis\//u, `${provider.id} debe declarar un estilo oficial`);
    assert.ok(provider.attribution.includes("Esri"), `${provider.id} debe atribuir al proveedor`);
    assert.equal(provider.urlTemplate, undefined, "la URL la construye el plugin oficial, no este módulo");
  });
});

test("los endpoints anónimos de Esri siguen prohibidos y no aparecen en el catálogo", () => {
  const serializado = JSON.stringify(MAP_BASEMAP_CATALOG);
  FORBIDDEN_TILE_HOSTS.forEach((host) => {
    assert.doesNotMatch(serializado, new RegExp(host.replace(/\./gu, "\\."), "iu"), `${host} fue retirado por la política de proveedores`);
  });
  assert.ok(FORBIDDEN_TILE_HOSTS.includes("server.arcgisonline.com"));
  assert.ok(FORBIDDEN_TILE_HOSTS.includes("services.arcgisonline.com"));
  assert.ok(FORBIDDEN_TILE_HOSTS.includes("ibasemaps-api.arcgis.com"));
  assert.notEqual(LICENSED_BASEMAP_HOST, "server.arcgisonline.com", "el host licenciado no puede ser el anónimo");
});

test("sin credencial cualquier capa licenciada degrada a OSM en vez de fallar", () => {
  ["satelite", "topografico", "relieve"].forEach((basemapId) => {
    const resultado = resolveBasemap({ basemapId, surface: "editar", credentialPresent: false });
    assert.equal(resultado.provider.id, "osm");
    assert.equal(resultado.degraded, true);
    assert.equal(resultado.reason, "missing-credential");
  });
});

test("un proveedor caído degrada a OSM y un id desconocido también", () => {
  const caido = resolveBasemap({ basemapId: "satelite", surface: "operar", credentialPresent: true, providerHealthy: false });
  assert.equal(caido.provider.id, "osm");
  assert.equal(caido.reason, "provider-unavailable");

  const inventado = resolveBasemap({ basemapId: "no-existe", surface: "operar", credentialPresent: true });
  assert.equal(inventado.provider.id, "osm");
  assert.equal(inventado.reason, "unknown-basemap");
});

test("con credencial el satelital se sirve en ambas superficies mientras se mide el consumo", () => {
  BASEMAP_SURFACES.forEach((surface) => {
    const resultado = resolveBasemap({ basemapId: "satelite", surface, plan: "free", credentialPresent: true });
    assert.equal(resultado.provider.id, "satelite", `el plan gratis conserva satelital en ${surface}`);
    assert.equal(resultado.degraded, false);
  });
});

test("la costura de derecho de uso existe y hoy autoriza todo", () => {
  const permiso = basemapEntitlement({ basemapId: "satelite", surface: "operar", plan: "free" });
  assert.equal(permiso.allowed, true);
  assert.equal(permiso.reason, "always-available-while-measuring");

  assert.equal(basemapEntitlement({ basemapId: "satelite", surface: "imprimir" }).allowed, false, "una superficie desconocida no se autoriza sola");
});

test("los estados del proveedor que obligan a degradar incluyen credencial y cuota", () => {
  [401, 403, 429, 503].forEach((status) => assert.ok(shouldDegradeOnStatus(status), `${status} debe degradar`));
  [200, 204, 304].forEach((status) => assert.ok(!shouldDegradeOnStatus(status), `${status} no degrada`));
});

test("el reporte de consumo acepta conteos y rechaza cualquier dato ubicable", () => {
  assert.ok(isValidTileUsageReport({ basemapId: "satelite", surface: "editar", tileCount: 240, degraded: false, sessionSeq: 3 }));

  const valid = {
    basemapId: "satelite",
    surface: "editar",
    tileCount: 240,
    degraded: false,
    sessionSeq: 3,
  };
  assert.ok(!isValidTileUsageReport({ ...valid, latitude: -40.4855 }), "una coordenada invalida el reporte");
  assert.ok(!isValidTileUsageReport({ ...valid, paddockId: "8321c3af" }), "un identificador real invalida el reporte");
  assert.ok(!isValidTileUsageReport({ ...valid, zoom: 16 }), "el zoom localizable invalida el reporte");
  assert.ok(!isValidTileUsageReport({ ...valid, tileCount: -1 }), "un conteo negativo no es un conteo");
  assert.ok(!isValidTileUsageReport({ ...valid, surface: "imprimir" }), "solo se reportan superficies conocidas");
  assert.ok(!isValidTileUsageReport({ ...valid, degraded: "false" }), "degraded es booleano, no texto libre");
  assert.ok(!isValidTileUsageReport({ ...valid, sessionSeq: 0 }), "la secuencia comienza en uno");
  assert.ok(!isValidTileUsageReport({ basemapId: "satelite", surface: "editar", tileCount: 1 }), "faltan campos obligatorios");
});
