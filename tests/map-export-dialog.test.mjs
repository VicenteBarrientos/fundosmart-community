import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("MapExportDialog es neutral a Leaflet y expone formatos de exportación", async () => {
  const source = await readFile(
    path.join(projectRoot, "src/modules/potreros/components/map/MapExportDialog.tsx"),
    "utf8",
  );

  assert.match(source, /export function MapExportDialog/u);
  assert.match(source, /geojson/u);
  assert.match(source, /kml/u);
  assert.match(source, /print-a4/u);
  assert.doesNotMatch(source, /(?:react-)?leaflet/iu);
});
