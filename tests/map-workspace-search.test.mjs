import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMapWorkspaceState,
  filterMapWorkspacePaddocks,
  reduceMapWorkspace,
} from "../src/modules/potreros/workspace/useMapWorkspace.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const FIELD_ONE = {
  fieldId: "field-1",
  viewport: { center: [-40.61, -73.12], zoom: 15 },
};
const FIELD_TWO = {
  fieldId: "field-2",
  viewport: { center: [-40.72, -73.04], zoom: 14 },
};

test("la búsqueda conserva foco y viewport, y sobrevive al cambio de fundo", () => {
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
  const reset = reduceMapWorkspace(searched, {
    type: "reset-field",
    ...FIELD_TWO,
  });

  assert.equal(initial.search, "");
  assert.equal(searched.search, "Norte");
  assert.equal(searched.focusedPaddockId, "paddock-a");
  assert.deepEqual(searched.viewport, FIELD_ONE.viewport);
  assert.equal(reset.fieldId, FIELD_TWO.fieldId);
  assert.equal(reset.focusedPaddockId, null);
  assert.equal(reset.search, "Norte");
  assert.deepEqual(reset.viewport, FIELD_TWO.viewport);
  assert.equal(focused.search, "", "las transiciones no mutan snapshots previos");
  assert.ok(Object.isFrozen(searched));
});

test("el filtro conserva orden, identidad vacía y coincidencia parcial sin distinguir mayúsculas", () => {
  const paddocks = [
    { id: "paddock-1", name: "Loma Norte" },
    { id: "paddock-2", name: "Vega Sur" },
    { id: "paddock-3", name: "NORTE Chico" },
  ];

  assert.strictEqual(filterMapWorkspacePaddocks(paddocks, ""), paddocks);
  assert.deepEqual(
    filterMapWorkspacePaddocks(paddocks, "nOrTe").map((paddock) => paddock.id),
    ["paddock-1", "paddock-3"],
  );
  assert.deepEqual(paddocks.map((paddock) => paddock.id), [
    "paddock-1",
    "paddock-2",
    "paddock-3",
  ]);
});

test("MapaPotreros delega búsqueda completa y el workspace permanece neutral a Leaflet", async () => {
  const [mapSource, controllerSource] = await Promise.all([
    readFile(path.join(projectRoot, "src/modules/potreros/components/MapaPotreros.tsx"), "utf8"),
    readFile(path.join(projectRoot, "src/modules/potreros/workspace/useMapWorkspace.ts"), "utf8"),
  ]);

  assert.match(mapSource, /const filterPaddocks = mapWorkspace\.filterPaddocks/u);
  assert.match(mapSource, /\(\) => filterPaddocks\(potreros\)/u);
  assert.match(mapSource, /mapWorkspace\.setSearch\(event\.target\.value\)/u);
  assert.match(mapSource, /value=\{mapWorkspace\.search\}/u);
  assert.doesNotMatch(mapSource, /\bpaddockSearchQuery\b|\bsetPaddockSearchQuery\b/u);
  assert.doesNotMatch(mapSource, /potreros\.filter\(\(p\) => p\.name\.toLowerCase\(\)/u);
  assert.match(controllerSource, /export type MapWorkspaceFocusAction/u);
  assert.match(controllerSource, /export type MapWorkspaceFocusController/u);
  assert.doesNotMatch(controllerSource, /(?:react-)?leaflet/iu);
});
