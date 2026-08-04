import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_PADDOCK_FILLS_ENABLED,
  loadMapPreferences,
  saveMapPreferences,
} from "../src/modules/potreros/workspace/map-preferences.ts";

const root = new URL("../", import.meta.url);
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;
const [map, preferences, viewPreferences, policy] = await Promise.all([
  source("src/modules/potreros/components/MapaPotreros.tsx"),
  source("src/modules/potreros/workspace/map-preferences.ts"),
  source("src/modules/potreros/workspace/useMapViewPreferences.ts"),
  source("src/core/maps/tile-policy.mjs"),
]);

test("map preferences default to the online-only OSM fallback with paddock borders only", () => {
  assert.equal(DEFAULT_PADDOCK_FILLS_ENABLED, false);
  const preferences = withBrowserStorage({}, () => loadMapPreferences());
  assert.deepEqual(preferences, {
    basemapId: "osm",
    labelsEnabled: true,
    paddockFillsEnabled: false,
  });
});

test("legacy provider preferences migrate to OSM while view preferences persist", () => {
  const loaded = withBrowserStorage({
    "fundosmart:potreros:basemap:v1": "topographic",
    "fundosmart:potreros:labels:v1": "hidden",
    "fundosmart:potreros:paddock-fills:v1": "visible",
  }, () => loadMapPreferences());
  assert.deepEqual(loaded, {
    basemapId: "osm",
    labelsEnabled: false,
    paddockFillsEnabled: true,
  });

  const stored = withBrowserStorage({}, (values) => {
    saveMapPreferences({
      basemapId: "osm",
      labelsEnabled: false,
      paddockFillsEnabled: false,
    });
    return Object.fromEntries(values);
  });
  assert.deepEqual(stored, {
    "fundosmart:potreros:basemap:v1": "osm",
    "fundosmart:potreros:labels:v1": "hidden",
    "fundosmart:potreros:paddock-fills:v1": "hidden",
  });
});

sourceContractTest("the basemap selector derives its four entries from the central catalog", () => {
  assert.match(preferences, /MAP_BASEMAP_CATALOG\.providers\.map/);
  assert.match(preferences, /DEFAULT_BASEMAP_ID: BasemapId = "osm"/);
  assert.match(preferences, /styleName: provider\.styleName/);
  assert.match(policy, /interactive_online_only/);
  assert.match(policy, /tile\.openstreetmap\.org\/\{z\}\/\{x\}\/\{y\}\.png/);
  assert.match(policy, /openstreetmap\.org\/copyright/);
  assert.match(policy, /arcgis\/imagery/);
  assert.match(policy, /arcgis\/topographic/);
  assert.match(policy, /arcgis\/terrain/);
  assert.doesNotMatch(preferences, /https:\/\/[a-z0-9.-]+\/\{z\}/i);

  assert.match(map, /activeBasemap\.id === "osm"[\s\S]+<TileLayer/);
  assert.match(map, /attribution=\{activeBasemap\.attribution\}/);
  assert.match(map, /vectorBasemapLayer\(styleName, \{ token \}\)/);
  assert.match(map, /styleName=\{activeBasemap\.styleName\}/);
  assert.match(map, /maxNativeZoom=\{activeBasemap\.maxNativeZoom\}/);
});

sourceContractTest("map preferences are versioned, validated, SSR-safe, and resilient to blocked storage", () => {
  assert.match(preferences, /fundosmart:potreros:basemap:v1/);
  assert.match(preferences, /fundosmart:potreros:labels:v1/);
  assert.match(preferences, /fundosmart:potreros:paddock-fills:v1/);
  assert.match(preferences, /DEFAULT_PADDOCK_FILLS_ENABLED = false/);
  assert.match(preferences, /typeof window === "undefined"/);
  assert.match(preferences, /isBasemapId\(storedBasemap\) \? storedBasemap : DEFAULT_BASEMAP_ID/);
  assert.match(preferences, /storedLabels === "hidden" \? false : DEFAULT_LABELS_ENABLED/);
  assert.match(preferences, /storedPaddockFills === "visible" \? true : DEFAULT_PADDOCK_FILLS_ENABLED/);
  assert.ok((preferences.match(/catch \{/g) ?? []).length >= 3);

  assert.match(viewPreferences, /window\.setTimeout\(\(\) => \{[\s\S]+loadMapPreferences\(\)/);
  assert.match(viewPreferences, /persistableMapViewPreferences\(state\)[\s\S]+if \(preferences\) saveMapPreferences\(preferences\)/);
  assert.doesNotMatch(map, /\bloadMapPreferences\b|\bsaveMapPreferences\b/);
});

sourceContractTest("permanent paddock labels require the persisted toggle and zoom 15", () => {
  assert.match(preferences, /PADDOCK_LABEL_MIN_ZOOM = 15/);
  assert.match(map, /moveend: publishViewport[\s\S]+zoomend: publishViewport[\s\S]+useMapEvents\(viewportEventHandlers\)/);
  assert.match(viewPreferences, /state\.hydrated[\s\S]+state\.labelsEnabled[\s\S]+zoom >= PADDOCK_LABEL_MIN_ZOOM/);
  assert.match(map, /showPaddockLabels = showPaddockLabelsAtZoom\(mapWorkspace\.viewport\.zoom\)/);
  assert.equal((map.match(/\{showPaddockLabels && \(\s*<Tooltip permanent/g) ?? []).length, 3);
  assert.match(map, /<MapViewportObserver onViewportChange=\{mapWorkspace\.observeViewport\} \/>/);
});

sourceContractTest("the basemap selector and labels toggle stay visible, keyboard accessible, and touch friendly", () => {
  assert.match(map, /aria-haspopup="menu"/);
  assert.match(map, /aria-expanded=\{basemapMenuOpen\}/);
  assert.match(map, /role="menuitemradio"/);
  assert.match(map, /aria-checked=\{basemap\.id === preferredBasemap\.id\}/);
  assert.match(map, /ArrowDown/);
  assert.match(map, /ArrowUp/);
  assert.match(map, /aria-pressed=\{labelsEnabled\}/);
  assert.match(map, /onClick=\{toggleLabels\}/);
  assert.match(map, /onClick=\{togglePaddockFills\}/);
  assert.match(map, /event\.key === "Escape"[\s\S]+setBasemapMenuOpen\(false\)/);
  assert.match(map, /h-11 min-w-11/);
  assert.match(map, /focus-visible:ring-2/);
  assert.match(map, /aria-label="Controles de vista del mapa"/);
  assert.match(map, /id="map-view-controls"/);
  assert.match(map, /flex w-full flex-wrap items-center justify-end/);
  assert.match(map, /aria-pressed=\{!paddockFillsEnabled\}/);
  assert.match(map, /<span>Solo bordes<\/span>/);
  assert.match(map, /<span>Hitos<\/span>/);
  assert.match(map, /preferredBasemap\.label/);
  assert.match(map, /<span>Etiquetas<\/span>/);
  assert.match(map, /<span>Mi ubicación<\/span>/);
  assert.match(map, /id="active-basemap-attribution"/);
  assert.match(map, /openstreetmap\.org\/copyright/);
  assert.match(map, /href="https:\/\/www\.esri\.com"/);
  assert.doesNotMatch(map, /mobileMapControlsOpen|map-mobile-controls/);
});

sourceContractTest("borders-only mode removes passive fills while preserving operational editing feedback", () => {
  assert.match(map, /fillOpacity: boundaryEditing \? 0\.12 : paddockFillsEnabled \? 0\.08 : 0/);
  assert.match(map, /fillOpacity: paddockFillsEnabled \? style\.pathOptions\.fillOpacity : 0/);
  assert.match(map, /fillOpacity: paddockFillsEnabled \? 0\.28 : 0/);
  assert.match(map, /fillOpacity: paddockFillsEnabled \? 0\.04 : 0/);
  assert.match(map, /\{paddockFillsEnabled && \(\s*<aside aria-label=\{`Leyenda temática:/);
  assert.match(map, /disabled=\{!paddockFillsEnabled\}/);
  assert.match(map, /pathOptions=\{\{ color: "#facc15", fillColor: "#c8ec74", fillOpacity: 0\.38, weight: 4 \}\}/);
});

function source(path) {
  return readFile(new URL(path, root), "utf8");
}

function withBrowserStorage(initialValues, callback) {
  const values = new Map(Object.entries(initialValues));
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem(key) {
          return values.get(key) ?? null;
        },
        setItem(key, value) {
          values.set(key, value);
        },
      },
    },
  });
  try {
    return callback(values);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else delete globalThis.window;
  }
}
