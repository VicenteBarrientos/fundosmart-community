import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("MapWorkspaceLayout es neutral a Leaflet y expone estructura Operar/Editar", async () => {
  const layoutSource = await readFile(
    path.join(projectRoot, "src/modules/potreros/components/map/MapWorkspaceLayout.tsx"),
    "utf8",
  );

  assert.match(layoutSource, /export function MapWorkspaceLayout/u);
  assert.match(layoutSource, /MapModeHeader/u);
  assert.match(layoutSource, /MapContextualInspector/u);
  assert.match(layoutSource, /data-mode=\{modeState\}/u);
  assert.doesNotMatch(layoutSource, /(?:react-)?leaflet/iu);
});
