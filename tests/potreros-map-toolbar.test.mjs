import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("PotrerosMapToolbar es neutral a Leaflet y orquesta los diálogos de mapa", async () => {
  const source = await readFile(
    path.join(projectRoot, "src/modules/potreros/components/map/PotrerosMapToolbar.tsx"),
    "utf8",
  );

  assert.match(source, /export function PotrerosMapToolbar/u);
  assert.match(source, /MapWizardDialog/u);
  assert.match(source, /MapExportDialog/u);
  assert.match(source, /MapOverlaysManager/u);
  assert.match(source, /MapAccessibilityCoordinateEditor/u);
  assert.doesNotMatch(source, /(?:react-)?leaflet/iu);
});
