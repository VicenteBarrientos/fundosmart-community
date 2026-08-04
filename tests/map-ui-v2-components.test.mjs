import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("MapModeHeader y MapContextualInspector son componentes neutrales sin Leaflet", async () => {
  const [headerSource, inspectorSource] = await Promise.all([
    readFile(
      path.join(projectRoot, "src/modules/potreros/components/map/MapModeHeader.tsx"),
      "utf8",
    ),
    readFile(
      path.join(projectRoot, "src/modules/potreros/components/map/MapContextualInspector.tsx"),
      "utf8",
    ),
  ]);

  assert.match(headerSource, /export function MapModeHeader/u);
  assert.match(headerSource, /mode === "operar"/u);
  assert.match(headerSource, /mode === "editar"/u);
  assert.doesNotMatch(headerSource, /(?:react-)?leaflet/iu);

  assert.match(inspectorSource, /export function MapContextualInspector/u);
  assert.match(inspectorSource, /selectedPaddock/u);
  assert.match(inspectorSource, /isExpandedMobile/u);
  assert.doesNotMatch(inspectorSource, /(?:react-)?leaflet/iu);
});
