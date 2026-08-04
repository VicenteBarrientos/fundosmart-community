import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { calculateNeighborAreaPreview } from "../src/modules/potreros/utils/paddock-neighbors.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const TARGET_PADDOCK = {
  id: "paddock-1",
  fieldId: "field-1",
  nombre: "Potrero 1",
  name: "Potrero 1",
  hectareas: 10.0,
  areaHectares: 10.0,
  sector: "Norte",
  coordinates: [[-40.6, -73.1], [-40.6, -73.2], [-40.7, -73.2], [-40.6, -73.1]],
  soil: { ph: 6.0, nitrogen: null, phosphorus: null, potassium: null },
  status: "Disponible",
};

const NEIGHBOR_PADDOCK = {
  id: "paddock-2",
  fieldId: "field-1",
  nombre: "Potrero 2",
  name: "Potrero 2",
  hectareas: 15.0,
  areaHectares: 15.0,
  sector: "Norte",
  coordinates: [[-40.7, -73.2], [-40.8, -73.2], [-40.8, -73.1], [-40.7, -73.2]],
  soil: { ph: 6.0, nitrogen: null, phosphorus: null, potassium: null },
  status: "Disponible",
};

test("calculateNeighborAreaPreview calcula la diferencia de superficie de vecinos de forma determinista", () => {
  const result = calculateNeighborAreaPreview(
    TARGET_PADDOCK,
    [[-40.6, -73.1], [-40.6, -73.2], [-40.7, -73.2], [-40.6, -73.1]],
    [TARGET_PADDOCK, NEIGHBOR_PADDOCK],
  );

  assert.equal(result.targetPaddockId, "paddock-1");
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.affectedNeighbors));
});

test("calculateNeighborAreaPreview distribuye deltas entre múltiples vecinos del mismo fundo", () => {
  const result = calculateNeighborAreaPreview(
    TARGET_PADDOCK,
    [[-40.6, -73.1], [-40.6, -73.3], [-40.7, -73.3], [-40.6, -73.1]], // Larger ring -> +area
    [TARGET_PADDOCK, NEIGHBOR_PADDOCK, { ...NEIGHBOR_PADDOCK, id: "paddock-3", nombre: "Potrero 3", hectareas: 5.0 }],
  );

  assert.equal(result.targetPaddockId, "paddock-1");
  assert.equal(result.affectedNeighbors.length, 2);
  assert.ok(result.affectedNeighbors[0].deltaHectares < 0);
  assert.ok(result.affectedNeighbors[1].deltaHectares < 0);
});

test("paddock-neighbors es una utilidad pura sin dependencias de Leaflet", async () => {
  const source = await readFile(
    path.join(projectRoot, "src/modules/potreros/utils/paddock-neighbors.ts"),
    "utf8",
  );

  assert.match(source, /export function calculateNeighborAreaPreview/u);
  assert.doesNotMatch(source, /(?:react-)?leaflet/iu);
});
