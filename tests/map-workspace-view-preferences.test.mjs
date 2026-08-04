import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  createMapViewPreferencesState,
  persistableMapViewPreferences,
  reduceMapViewPreferences,
  shouldShowPaddockLabels,
} from "../src/modules/potreros/workspace/useMapViewPreferences.ts";

const root = new URL("../", import.meta.url);
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;

test("las preferencias parten con la vista vigente y no son persistibles antes de hidratar", () => {
  const initial = createMapViewPreferencesState();

  assert.deepEqual(initial, {
    basemapId: "osm",
    labelsEnabled: true,
    paddockFillsEnabled: false,
    hydrated: false,
  });
  assert.equal(persistableMapViewPreferences(initial), null);
  assert.equal(shouldShowPaddockLabels(initial, 15), false);
  assert.ok(Object.isFrozen(initial));
});

test("hidratar reemplaza los defaults sin mutar el snapshot anterior", () => {
  const initial = createMapViewPreferencesState();
  const hydrated = reduceMapViewPreferences(initial, {
    type: "hydrate",
    preferences: {
      basemapId: "osm",
      labelsEnabled: false,
      paddockFillsEnabled: true,
    },
  });
  const repeated = reduceMapViewPreferences(hydrated, {
    type: "hydrate",
    preferences: {
      basemapId: "osm",
      labelsEnabled: false,
      paddockFillsEnabled: true,
    },
  });

  assert.deepEqual(hydrated, {
    basemapId: "osm",
    labelsEnabled: false,
    paddockFillsEnabled: true,
    hydrated: true,
  });
  assert.deepEqual(initial, {
    basemapId: "osm",
    labelsEnabled: true,
    paddockFillsEnabled: false,
    hydrated: false,
  });
  assert.strictEqual(repeated, hydrated, "la hidratación idempotente conserva identidad");
  assert.deepEqual(persistableMapViewPreferences(hydrated), {
    basemapId: "osm",
    labelsEnabled: false,
    paddockFillsEnabled: true,
  });
  assert.ok(Object.isFrozen(hydrated));
  assert.ok(Object.isFrozen(persistableMapViewPreferences(hydrated)));
});

test("los controles actualizan una preferencia por vez y conservan el umbral inclusivo", () => {
  const hydrated = reduceMapViewPreferences(createMapViewPreferencesState(), {
    type: "hydrate",
    preferences: {
      basemapId: "osm",
      labelsEnabled: true,
      paddockFillsEnabled: false,
    },
  });
  const labelsHidden = reduceMapViewPreferences(hydrated, {
    type: "toggle-labels",
  });
  const fillsVisible = reduceMapViewPreferences(labelsHidden, {
    type: "toggle-paddock-fills",
  });
  const labelsVisibleAgain = reduceMapViewPreferences(fillsVisible, {
    type: "toggle-labels",
  });
  const sameBasemap = reduceMapViewPreferences(fillsVisible, {
    type: "select-basemap",
    basemapId: "osm",
  });

  assert.equal(shouldShowPaddockLabels(hydrated, 14), false);
  assert.equal(shouldShowPaddockLabels(hydrated, 15), true);
  assert.equal(shouldShowPaddockLabels(labelsHidden, 18), false);
  assert.equal(fillsVisible.paddockFillsEnabled, true);
  assert.equal(fillsVisible.labelsEnabled, false);
  assert.equal(labelsVisibleAgain.labelsEnabled, true);
  assert.equal(labelsVisibleAgain.paddockFillsEnabled, true);
  assert.strictEqual(sameBasemap, fillsVisible);
  assert.equal(hydrated.paddockFillsEnabled, false);
});

sourceContractTest("MapaPotreros consume el controlador y ya no posee hidratación ni persistencia", async () => {
  const [map, controller] = await Promise.all([
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("src/modules/potreros/workspace/useMapViewPreferences.ts"),
  ]);

  assert.match(map, /useMapViewPreferences\(\)/u);
  assert.match(map, /showPaddockLabelsAtZoom\(mapWorkspace\.viewport\.zoom\)/u);
  assert.match(map, /onClick=\{toggleLabels\}/u);
  assert.match(map, /onClick=\{togglePaddockFills\}/u);
  assert.doesNotMatch(map, /\bloadMapPreferences\b|\bsaveMapPreferences\b/u);
  assert.doesNotMatch(map, /\bsetMapPreferencesLoaded\b|\bsetBasemapId\b|\bsetLabelsEnabled\b|\bsetPaddockFillsEnabled\b/u);

  assert.match(controller, /window\.setTimeout\(\(\) => \{[\s\S]+loadMapPreferences\(\)/u);
  assert.match(controller, /const preferences = persistableMapViewPreferences\(state\);[\s\S]+if \(preferences\) saveMapPreferences\(preferences\)/u);
  assert.match(controller, /from "\.\/map-preferences\.ts"/u);
  assert.doesNotMatch(controller, /leaflet|react-leaflet/iu);
  assert.doesNotMatch(controller, /components\/map-preferences/iu);
});

function source(path) {
  return readFile(new URL(path, root), "utf8");
}
