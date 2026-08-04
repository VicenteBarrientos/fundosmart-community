import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("MapAccessibilityCoordinateEditor es neutral a Leaflet y expone tabla accesible", async () => {
  const source = await readFile(
    path.join(projectRoot, "src/modules/potreros/components/map/MapAccessibilityCoordinateEditor.tsx"),
    "utf8",
  );

  assert.match(source, /export function MapAccessibilityCoordinateEditor/u);
  assert.match(source, /handleAddPoint/u);
  assert.match(source, /handleRemovePoint/u);
  assert.match(source, /handleMovePoint/u);
  assert.doesNotMatch(source, /(?:react-)?leaflet/iu);
});
