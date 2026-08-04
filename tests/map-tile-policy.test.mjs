import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MAP_TILE_POLICY } from "../src/core/maps/tile-policy.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("the active provider contract permits only attributed interactive OSM use", async () => {
  const [preferences, map, headers] = await Promise.all([
    source("src/modules/potreros/workspace/map-preferences.ts"),
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("worker/security-headers.mjs"),
  ]);

  assert.equal(MAP_TILE_POLICY.version, "fundosmart.map-tiles.v1");
  assert.equal(MAP_TILE_POLICY.online.mode, "interactive_online_only");
  assert.equal(MAP_TILE_POLICY.online.urlTemplate, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
  assert.equal(MAP_TILE_POLICY.online.prefetchAllowed, false);
  assert.equal(MAP_TILE_POLICY.online.applicationCacheAllowed, false);
  assert.match(MAP_TILE_POLICY.online.attribution, /openstreetmap\.org\/copyright/u);
  // Las preferencias derivan del catálogo central en vez de copiar la URL de OSM.
  // La intención vigilada es la misma de siempre: ninguna URL de teselas se declara
  // a mano fuera de la política.
  assert.match(preferences, /MAP_BASEMAP_CATALOG\.providers\.map/u, "el selector debe derivar del catálogo central");
  assert.doesNotMatch(preferences, /https:\/\/[a-z0-9.-]+\/\{z\}/iu, "ninguna plantilla de teselas se escribe a mano aquí");
  assert.match(preferences, /arcgisBasemapKey/u, "la credencial se lee en un solo lugar");
  assert.match(map, /attribution=\{activeBasemap\.attribution\}/u);
  assert.match(map, /vectorBasemapLayer\(styleName, \{ token \}\)/u, "las capas licenciadas usan el plugin oficial");
  assert.match(map, /activeBasemap\.id === "osm"[\s\S]+<TileLayer/u, "OSM conserva su TileLayer raster");
  assert.match(map, /shouldDegradeOnStatus/u, "el renderer comparte la política de degradación");
  assert.match(headers, /"Referrer-Policy": "strict-origin-when-cross-origin"/u);
});

test("runtime code has no prohibited provider, prefetch, or cross-origin tile cache path", async () => {
  const files = (await Promise.all(["app", "src", "public"].map(runtimeFiles))).flat();
  const runtime = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  const osmTemplates = runtime.match(/https:\/\/tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/gu) ?? [];

  assert.equal(osmTemplates.length, 1, "the online URL must live only in the central policy");

  // Los endpoints anónimos de ArcGIS siguen prohibidos: la política de proveedores los
  // retiró porque se usaban sin licencia. Desde que existe un catálogo licenciado,
  // el único lugar donde esos nombres pueden aparecer es la lista de prohibidos de
  // la política, que es precisamente lo que los vigila. En cualquier otro archivo
  // del runtime siguen siendo un defecto.
  const anonymousEsri = /server\.arcgisonline\.com|services\.arcgisonline\.com|ibasemaps-api\.arcgis\.com/giu;
  const policySource = await source("src/core/maps/tile-policy.mjs");
  const runtimeOutsidePolicy = (await Promise.all(
    files.filter((file) => !file.replace(/\\/gu, "/").endsWith("src/core/maps/tile-policy.mjs"))
      .map((file) => readFile(file, "utf8")),
  )).join("\n");

  assert.doesNotMatch(runtimeOutsidePolicy, anonymousEsri, "un endpoint anónimo de Esri fuera de la política es una reintroducción");
  assert.match(policySource, /FORBIDDEN_TILE_HOSTS/u, "la política debe seguir declarando la lista de hosts prohibidos");
  policySource.match(anonymousEsri)?.forEach((host) => {
    const declaredAsForbidden = new RegExp(`FORBIDDEN_TILE_HOSTS[\\s\\S]*${host.replace(/\./gu, "\\.")}`, "iu");
    assert.match(policySource, declaredAsForbidden, `${host} solo puede aparecer dentro de FORBIDDEN_TILE_HOSTS`);
  });

  assert.doesNotMatch(runtime, /cacheOfflineTileRegion|planOfflineTileUrls|Descargar mapa cercano/u);

  const worker = await source("public/sw.js");
  assert.match(worker, /LEGACY_OFFLINE_TILE_CACHES\.includes\(key\)/u);
  assert.doesNotMatch(worker, /isOfflineTileRequest|readOfflineTile/u);
});

test("offline and export modes fail safe before a self-hosted pack exists", async () => {
  const [printMap, printSheet, terrain] = await Promise.all([
    source("app/(producto)/potreros/imprimir/PrintPaddockMap.tsx"),
    source("app/(producto)/potreros/imprimir/PrintPaddockSheet.tsx"),
    source("src/modules/ganado/components/TerrenoSection.tsx"),
  ]);

  assert.equal(MAP_TILE_POLICY.offline.enabled, false);
  assert.equal(MAP_TILE_POLICY.offline.selectedArchitecture, "self_hosted_pmtiles_on_r2");
  assert.equal(MAP_TILE_POLICY.offline.maximumPackBytes, 512 * 1024 * 1024);
  assert.equal(MAP_TILE_POLICY.offline.maximumTileEquivalents, 11_000);
  assert.equal(MAP_TILE_POLICY.exports.thirdPartyBasemapEnabled, false);
  assert.doesNotMatch(printMap, /TileLayer|https?:\/\//u);
  assert.match(printMap, /FundoSmart · sin mapa base/u);
  assert.match(printSheet, /aunque el proveedor de mapas online no esté disponible/u);
  assert.match(terrain, /capturas y fotos pendientes se conservan localmente/u);
});

async function source(relativePath) {
  return readFile(path.join(projectRoot, relativePath), "utf8");
}

async function runtimeFiles(relativeDirectory) {
  const directory = path.join(projectRoot, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await runtimeFiles(path.relative(projectRoot, target)));
    } else if (/\.(?:js|mjs|ts|tsx)$/u.test(entry.name)) {
      files.push(target);
    }
  }
  return files;
}
