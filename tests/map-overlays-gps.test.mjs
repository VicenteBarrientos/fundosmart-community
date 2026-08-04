import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("MapOverlaysManager y MapGpsTracker son neutrales a Leaflet", async () => {
  const [overlaysSource, gpsSource] = await Promise.all([
    readFile(
      path.join(projectRoot, "src/modules/potreros/components/map/MapOverlaysManager.tsx"),
      "utf8",
    ),
    readFile(
      path.join(projectRoot, "src/modules/potreros/components/map/MapGpsTracker.tsx"),
      "utf8",
    ),
  ]);

  assert.match(overlaysSource, /export function MapOverlaysManager/u);
  assert.match(overlaysSource, /onToggleOverlay/u);
  assert.doesNotMatch(overlaysSource, /(?:react-)?leaflet/iu);

  assert.match(gpsSource, /export function MapGpsTracker/u);
  assert.match(gpsSource, /navigator.geolocation.watchPosition/u);
  assert.doesNotMatch(gpsSource, /(?:react-)?leaflet/iu);
});
