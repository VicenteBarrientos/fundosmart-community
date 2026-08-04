import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMapWorkspaceState,
  reduceMapWorkspace,
  selectMapWorkspaceViewport,
} from "../src/modules/potreros/workspace/useMapWorkspace.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;
const FIELD_ONE = {
  fieldId: "field-1",
  viewport: { center: [-40.61, -73.12], zoom: 14 },
};

test("el workspace observa el viewport sin alterar búsqueda ni foco", () => {
  const initial = createMapWorkspaceState(FIELD_ONE);
  const focused = reduceMapWorkspace(initial, {
    type: "focus-paddock",
    id: "paddock-a",
    ...FIELD_ONE,
  });
  const searched = reduceMapWorkspace(focused, {
    type: "set-search",
    search: "Norte",
    ...FIELD_ONE,
  });
  const observedViewport = { center: [-40.615, -73.125], zoom: 17 };
  const moved = reduceMapWorkspace(searched, {
    type: "observe-viewport",
    expectedFieldId: FIELD_ONE.fieldId,
    fieldId: FIELD_ONE.fieldId,
    viewport: observedViewport,
  });
  const duplicate = reduceMapWorkspace(moved, {
    type: "observe-viewport",
    expectedFieldId: FIELD_ONE.fieldId,
    fieldId: FIELD_ONE.fieldId,
    viewport: observedViewport,
  });

  assert.deepEqual(moved.viewport, observedViewport);
  assert.equal(moved.search, "Norte");
  assert.equal(moved.focusedPaddockId, "paddock-a");
  assert.deepEqual(searched.viewport, FIELD_ONE.viewport, "el snapshot anterior permanece intacto");
  assert.notStrictEqual(moved.viewport, observedViewport, "el workspace clona el viewport observado");
  assert.ok(Object.isFrozen(moved.viewport));
  assert.ok(Object.isFrozen(moved.viewport.center));
  assert.strictEqual(duplicate, moved, "eventos moveend/zoomend duplicados no crean otro snapshot");
});

test("la primera observación de otro fundo instala su viewport real de forma atómica", () => {
  const initial = createMapWorkspaceState(FIELD_ONE);
  const focused = reduceMapWorkspace(initial, {
    type: "focus-paddock",
    id: "paddock-a",
    ...FIELD_ONE,
  });
  const searched = reduceMapWorkspace(focused, {
    type: "set-search",
    search: "Sur",
    ...FIELD_ONE,
  });
  const observedNextField = {
    fieldId: "field-2",
    viewport: { center: [-40.7, -73.2], zoom: 15 },
  };
  const reconciled = reduceMapWorkspace(searched, {
    type: "observe-viewport",
    expectedFieldId: FIELD_ONE.fieldId,
    ...observedNextField,
  });

  assert.equal(reconciled.fieldId, observedNextField.fieldId);
  assert.deepEqual(reconciled.viewport, observedNextField.viewport);
  assert.equal(reconciled.search, "Sur");
  assert.equal(reconciled.focusedPaddockId, null);
});

test("una observación tardía del fundo anterior no revierte el workspace vigente", () => {
  const fieldTwo = {
    fieldId: "field-2",
    viewport: { center: [-40.7, -73.2], zoom: 15 },
  };
  const current = createMapWorkspaceState(fieldTwo);
  const stale = reduceMapWorkspace(current, {
    type: "observe-viewport",
    expectedFieldId: FIELD_ONE.fieldId,
    fieldId: FIELD_ONE.fieldId,
    viewport: FIELD_ONE.viewport,
  });

  assert.strictEqual(stale, current);
  assert.equal(stale.fieldId, fieldTwo.fieldId);
  assert.deepEqual(stale.viewport, fieldTwo.viewport);
});

test("el viewport expuesto nunca pertenece al fundo anterior", () => {
  const oldWorkspace = createMapWorkspaceState(FIELD_ONE);
  const nextContext = {
    fieldId: "field-2",
    viewport: { center: [-40.7, -73.2], zoom: 14 },
  };
  const sameFieldViewport = selectMapWorkspaceViewport(oldWorkspace, FIELD_ONE);
  const nextFieldViewport = selectMapWorkspaceViewport(oldWorkspace, nextContext);

  assert.strictEqual(sameFieldViewport, oldWorkspace.viewport);
  assert.deepEqual(nextFieldViewport, nextContext.viewport);
  assert.ok(Object.isFrozen(nextFieldViewport));
  assert.ok(Object.isFrozen(nextFieldViewport.center));
});

sourceContractTest("MapaPotreros delega el viewport observado y conserva el umbral de etiquetas", async () => {
  const [mapSource, controllerSource, viewPreferencesSource] = await Promise.all([
    readFile(path.join(projectRoot, "src/modules/potreros/components/MapaPotreros.tsx"), "utf8"),
    readFile(path.join(projectRoot, "src/modules/potreros/workspace/useMapWorkspace.ts"), "utf8"),
    readFile(path.join(projectRoot, "src/modules/potreros/workspace/useMapViewPreferences.ts"), "utf8"),
  ]);

  assert.doesNotMatch(mapSource, /const \[zoomLevel,\s*setZoomLevel\]\s*=\s*useState/u);
  assert.match(
    mapSource,
    /showPaddockLabels\s*=\s*showPaddockLabelsAtZoom\(mapWorkspace\.viewport\.zoom\)/u,
  );
  assert.match(
    viewPreferencesSource,
    /state\.hydrated[\s\S]*state\.labelsEnabled[\s\S]*zoom\s*>=\s*PADDOCK_LABEL_MIN_ZOOM/u,
  );
  assert.match(
    mapSource,
    /<MapViewportObserver onViewportChange=\{mapWorkspace\.observeViewport\} \/>/u,
  );
  assert.match(mapSource, /moveend:\s*publishViewport/u);
  assert.match(mapSource, /zoomend:\s*publishViewport/u);
  assert.match(mapSource, /useMemo\(\(\)\s*=>\s*\(\{[\s\S]*moveend:\s*publishViewport[\s\S]*\}\),\s*\[publishViewport\]\)/u);
  assert.match(mapSource, /useMapEvents\(viewportEventHandlers\)/u);
  assert.match(mapSource, /map\.getCenter\(\)/u);
  assert.match(mapSource, /center:\s*\[center\.lat,\s*center\.lng\]/u);
  assert.match(mapSource, /zoom:\s*map\.getZoom\(\)/u);
  assert.match(
    mapSource,
    /useEffect\(\(\)\s*=>\s*\{\s*publishViewport\(\);\s*\},\s*\[publishViewport\]\)/u,
  );
  assert.match(mapSource, /<MapContainer[\s\S]*center=\{fundo\?\.coordinates\[0\] \?\? MAP_CENTER\}[\s\S]*zoom=\{14\}/u);
  assert.doesNotMatch(mapSource, /(?:center|zoom)=\{mapWorkspace\.viewport/u);
  assert.match(controllerSource, /viewport:\s*MapViewport/u);
  assert.match(controllerSource, /observeViewport:\s*\(viewport:\s*MapViewport\)\s*=>\s*void/u);
  assert.match(controllerSource, /expectedFieldId:\s*observedWorkspaceFieldId/u);
  assert.match(controllerSource, /\[fieldId,\s*observedWorkspaceFieldId\]/u);
  assert.doesNotMatch(controllerSource, /(?:react-)?leaflet/iu);
});
