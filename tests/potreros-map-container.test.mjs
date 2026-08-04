import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("PotrerosMapContainer es neutral a Leaflet y calcula metricas del fundo", async () => {
  const containerSource = await readFile(
    path.join(projectRoot, "src/modules/potreros/components/map/PotrerosMapContainer.tsx"),
    "utf8",
  );

  assert.match(containerSource, /export function PotrerosMapContainer/u);
  assert.match(containerSource, /MapWorkspaceLayout/u);
  assert.match(containerSource, /paddocks.reduce/u);
  assert.doesNotMatch(containerSource, /(?:react-)?leaflet/iu);
});
