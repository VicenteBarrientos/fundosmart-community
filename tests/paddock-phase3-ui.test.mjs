import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildExclusionPreview, removePaddockExclusion } from "../src/modules/potreros/utils/exclusions.ts";
import { paddockAreaMetrics } from "../src/modules/potreros/utils/paddock-metrics.ts";
import { metersToDegrees } from "../src/modules/potreros/utils/geometry.ts";

const root = new URL("../", import.meta.url);
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;
const ORIGIN_LATITUDE = -40;
const ORIGIN_LONGITUDE = -73;

function coordinate(northMeters, eastMeters) {
  return [
    ORIGIN_LATITUDE + metersToDegrees(northMeters, ORIGIN_LATITUDE, "latitude"),
    ORIGIN_LONGITUDE + metersToDegrees(eastMeters, ORIGIN_LATITUDE, "longitude"),
  ];
}

function rectangle(westMeters, eastMeters, southMeters, northMeters) {
  return [
    coordinate(southMeters, westMeters),
    coordinate(southMeters, eastMeters),
    coordinate(northMeters, eastMeters),
    coordinate(northMeters, westMeters),
  ];
}

function paddock(id, name, outer, overrides = {}) {
  return {
    id,
    fieldId: "field-1",
    name,
    sector: "Norte",
    areaHectares: 999,
    coordinates: outer,
    geometry: { outer, holes: [] },
    grazeableAreaHectares: null,
    landUse: "pradera_permanente",
    holeKinds: [],
    soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    lastActivity: "Creado",
    status: "Disponible",
    ...overrides,
  };
}

test("safe paddock exclusion previews gross/net/useful area and preserves explicit kind", () => {
  const source = paddock("p-1", "Norte", rectangle(0, 400, 0, 250));
  const preview = buildExclusionPreview({
    scope: { kind: "paddock", fieldId: "field-1", paddockId: source.id, paddockName: source.name },
    kind: "laguna",
    exclusion: rectangle(100, 300, 75, 175),
    paddocks: [source],
  });
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.affected.length, 1);
  assert.ok(Math.abs(preview.affected[0].grossAreaHectares - 10) < 0.05);
  assert.ok(Math.abs(preview.affected[0].nextNetAreaHectares - 8) < 0.05);
  assert.deepEqual(preview.affected[0].updatedPaddock.holeKinds, ["laguna"]);
  assert.equal(preview.affected[0].updatedPaddock.geometry.holes.length, 1);
});

test("field exclusion enumerates every affected paddock before confirmation", () => {
  const west = paddock("p-west", "Oeste", rectangle(0, 200, 0, 200));
  const east = paddock("p-east", "Este", rectangle(250, 450, 0, 200));
  const preview = buildExclusionPreview({
    scope: { kind: "field", fieldId: "field-1", fieldName: "Fundo prueba" },
    kind: "humedal",
    exclusion: rectangle(50, 400, 50, 150),
    paddocks: [west, east],
  });
  assert.deepEqual(preview.affected, []);
  assert.equal(preview.blockers.length, 2);
  assert.match(preview.blockers[0], /toca o cruza el borde exterior/i);
  assert.match(preview.blockers[1], /toca o cruza el borde exterior/i);
});

test("manual grazeable override is clamped explicitly and removing the hole restores net area", () => {
  const source = paddock("p-1", "Norte", rectangle(0, 400, 0, 250), { grazeableAreaHectares: 9 });
  const preview = buildExclusionPreview({
    scope: { kind: "paddock", fieldId: "field-1", paddockId: source.id, paddockName: source.name },
    kind: "bosque",
    exclusion: rectangle(100, 300, 75, 175),
    paddocks: [source],
  });
  const updated = preview.affected[0].updatedPaddock;
  assert.equal(preview.affected[0].overrideClamped, true);
  assert.ok(preview.warnings.length > 0);
  assert.equal(updated.grazeableAreaHectares, updated.netAreaHectares);
  const restored = removePaddockExclusion(updated, 0);
  assert.deepEqual(restored.holeKinds, []);
  assert.ok(Math.abs(paddockAreaMetrics(restored).netAreaHectares - 10) < 0.05);
});

sourceContractTest("phase 3 controls remain explicit, online-only and read-only aware", async () => {
  const [page, map, editDialog, panel, history, list] = await Promise.all([
    source("src/modules/potreros/PotrerosPage.tsx"),
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("src/modules/potreros/components/ManagePotreroDialog.tsx"),
    source("src/modules/potreros/components/MapPotreroPanel.tsx"),
    source("src/modules/potreros/components/HistorialPotrero.tsx"),
    source("src/modules/potreros/components/ListaPotreros.tsx"),
  ]);
  assert.match(map, /positions=\{\[geometry\.outer, \.\.\.visibleHoles\]\}/);
  assert.match(map, /geometry\.holes\.filter\(\(_, index\) => index !== editingExclusionIndex\)/);
  assert.match(map, /Dibujar exclusión/);
  assert.match(panel, /Dibujar exclusión/);
  assert.match(panel, /disabled=\{!networkOnline\}/);
  assert.match(page, /fetchFieldStockingLoad/);
  assert.match(page, /Sin conexión: las exclusiones no se aplican ni se encolan/);
  assert.match(editDialog, /Uso de suelo/);
  assert.match(history, /Carga animal/);
  assert.match(history, /operaciones estructurales están bloqueadas/i);
  assert.match(list, /Superficie total/);
  assert.match(list, /Superficie útil/);
});

function source(path) {
  return readFile(new URL(path, root), "utf8");
}
