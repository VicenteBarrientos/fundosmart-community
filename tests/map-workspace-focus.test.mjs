import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createMapWorkspaceFocusState,
  reduceMapWorkspaceFocus,
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

test("focus A → focus B → blur A conserva B", () => {
  const initial = createMapWorkspaceFocusState(FIELD_ONE);
  const focusedA = reduceMapWorkspaceFocus(initial, {
    type: "focus-paddock",
    id: "paddock-a",
    ...FIELD_ONE,
  });
  const focusedB = reduceMapWorkspaceFocus(focusedA, {
    type: "focus-paddock",
    id: "paddock-b",
    ...FIELD_ONE,
  });
  const staleBlur = reduceMapWorkspaceFocus(focusedB, {
    type: "blur-paddock",
    id: "paddock-a",
    ...FIELD_ONE,
  });

  assert.equal(initial.focusedPaddockId, null);
  assert.equal(focusedA.focusedPaddockId, "paddock-a");
  assert.equal(focusedB.focusedPaddockId, "paddock-b");
  assert.equal(staleBlur, focusedB);
  assert.ok(Object.isFrozen(focusedB));
});

test("cambiar de fundo descarta el foco anterior antes de aceptar otro", () => {
  const focused = reduceMapWorkspaceFocus(createMapWorkspaceFocusState(FIELD_ONE), {
    type: "focus-paddock",
    id: "paddock-a",
    ...FIELD_ONE,
  });
  const reset = reduceMapWorkspaceFocus(focused, { type: "reset-field", ...FIELD_TWO });
  const focusedOnNewField = reduceMapWorkspaceFocus(focused, {
    type: "focus-paddock",
    id: "paddock-z",
    ...FIELD_TWO,
  });

  assert.equal(reset.fieldId, FIELD_TWO.fieldId);
  assert.equal(reset.focusedPaddockId, null);
  assert.equal(focusedOnNewField.fieldId, FIELD_TWO.fieldId);
  assert.equal(focusedOnNewField.focusedPaddockId, "paddock-z");
  assert.equal(focused.focusedPaddockId, "paddock-a", "las transiciones no mutan snapshots previos");
});

test("MapaPotreros delega el foco y el controlador permanece neutral a Leaflet", async () => {
  const [mapSource, controllerSource] = await Promise.all([
    readFile(path.join(projectRoot, "src/modules/potreros/components/MapaPotreros.tsx"), "utf8"),
    readFile(path.join(projectRoot, "src/modules/potreros/workspace/useMapWorkspace.ts"), "utf8"),
  ]);

  assert.match(mapSource, /useMapWorkspace/u);
  assert.doesNotMatch(mapSource, /\bfocusedPaddockId\b|\bsetFocusedPaddockId\b/u);
  assert.doesNotMatch(controllerSource, /(?:react-)?leaflet/iu);
});
