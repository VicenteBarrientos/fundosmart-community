import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  TILE_USAGE_REPORT_ENDPOINT,
  createTileUsageReporter,
  sendTileUsageReport,
} from "../src/modules/potreros/workspace/tile-usage-reporter.ts";

const root = new URL("../", import.meta.url);

test("el contador agrupa teselas y emite exactamente los cinco campos permitidos", async () => {
  const reports = [];
  const reporter = createTileUsageReporter({
    batchSize: 3,
    send: async (report) => {
      reports.push(report);
      return true;
    },
  });

  await reporter.setContext({ basemapId: "satelite", surface: "editar", degraded: false });
  reporter.recordTile();
  reporter.recordTile();
  reporter.recordTile();
  await reporter.flush();

  assert.equal(reports.length, 1);
  assert.deepEqual(reports[0], {
    basemapId: "satelite",
    surface: "editar",
    tileCount: 3,
    degraded: false,
    sessionSeq: 1,
  });
  assert.deepEqual(Object.keys(reports[0]), [
    "basemapId",
    "surface",
    "tileCount",
    "degraded",
    "sessionSeq",
  ]);
});

test("cambiar de superficie o degradar cierra el agregado anterior sin mezclar contextos", async () => {
  const reports = [];
  const reporter = createTileUsageReporter({
    send: async (report) => {
      reports.push(report);
      return true;
    },
  });

  await reporter.setContext({ basemapId: "topografico", surface: "operar", degraded: false });
  reporter.recordTile();
  reporter.recordTile();
  await reporter.setContext({ basemapId: "topografico", surface: "editar", degraded: true });
  reporter.recordTile();
  await reporter.dispose();

  assert.deepEqual(reports, [
    {
      basemapId: "topografico",
      surface: "operar",
      tileCount: 2,
      degraded: false,
      sessionSeq: 1,
    },
    {
      basemapId: "topografico",
      surface: "editar",
      tileCount: 1,
      degraded: true,
      sessionSeq: 2,
    },
  ]);
});

test("el transporte es same-origin, keepalive y no agrega datos localizables", async () => {
  let captured;
  const report = {
    basemapId: "relieve",
    surface: "operar",
    tileCount: 17,
    degraded: false,
    sessionSeq: 4,
  };
  const accepted = await sendTileUsageReport(report, async (input, init) => {
    captured = { input, init };
    return new Response(null, { status: 204 });
  });

  assert.equal(accepted, true);
  assert.equal(captured.input, TILE_USAGE_REPORT_ENDPOINT);
  assert.equal(captured.init.method, "POST");
  assert.equal(captured.init.credentials, "same-origin");
  assert.equal(captured.init.keepalive, true);
  assert.deepEqual(JSON.parse(captured.init.body), report);
  assert.doesNotMatch(captured.init.body, /latitude|longitude|bbox|center|zoom|geometry|fieldId|paddockId|name/u);
});

test("el endpoint valida el contrato antes de escribir un punto agregado sin IDs", async () => {
  const route = await source("app/api/mapas/teselas/consumo/route.ts");
  assert.match(route, /isValidTileUsageReport\(payload\)/u);
  assert.match(route, /authorizeApiAccess\("view"\)/u);
  assert.match(route, /access\.email === DEMO_EMAIL/u);
  assert.match(route, /MAP_USAGE\?\.writeDataPoint/u);
  assert.doesNotMatch(route, /METRICS\?\.writeDataPoint/u);
  assert.match(route, /"map\.tile_usage"/u);
  assert.match(route, /doubles: \[report\.tileCount, report\.sessionSeq\]/u);
  assert.doesNotMatch(route, /organizationId|membershipId|fieldId|paddockId|latitude|longitude|geometry|zoom/u);
});

test("dependencia, notice y SBOM fijan el renderer oficial y sus peers", async () => {
  const [manifest, lockfile, notices, sbom] = await Promise.all([
    json("package.json"),
    json("package-lock.json"),
    source("THIRD_PARTY_NOTICES.md"),
    json("sbom.cdx.json"),
  ]);

  assert.equal(manifest.dependencies["esri-leaflet-vector"], "4.3.2");
  assert.equal(lockfile.packages["node_modules/esri-leaflet-vector"].version, "4.3.2");
  assert.equal(manifest.dependencies["@turf/turf"], undefined);
  assert.match(notices, /Esri Leaflet Vector 4\.3\.2/u);
  assert.match(notices, /Esri Leaflet 3\.0\.19/u);
  assert.match(notices, /MapLibre GL JS 4\.7\.1/u);

  const components = new Map(sbom.components.map((component) => [component.name, component]));
  assert.equal(components.get("esri-leaflet-vector")?.version, "4.3.2");
  assert.equal(components.get("esri-leaflet")?.version, "3.0.19");
  assert.equal(components.get("maplibre-gl")?.version, "4.7.1");
});

function source(path) {
  return readFile(new URL(path, root), "utf8");
}

async function json(path) {
  return JSON.parse(await source(path));
}
