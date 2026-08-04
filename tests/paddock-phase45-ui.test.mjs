import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("thematic map uses the shared classifier, versioned scope and accessible operational controls", async () => {
  const map = await source("src/modules/potreros/components/MapaPotreros.tsx");
  assert.match(map, /getPaddockStyle\(potrero, activeThematicMode/u);
  assert.match(map, /getPaddockLegend\(activeThematicMode/u);
  assert.match(map, /\.\.\.style\.pathOptions/u);
  assert.match(map, /fillOpacity:\s*paddockFillsEnabled\s*\?\s*style\.pathOptions\.fillOpacity\s*:\s*0/u);
  assert.doesNotMatch(map, /fillColor:\s*selected\s*\?/u);
  assert.match(map, /\["status", "sector", "land_use", "ph", "rotation"\]/u);
  assert.match(map, /map-thematic-mode:v1/u);
  assert.match(map, /aria-label="Tema de color de los potreros"/u);
  assert.match(map, /<option disabled=\{!hasKnownNdvi\} value="ndvi">/u);
  assert.match(map, /iconSize: \[44, 44\]/u);
  assert.match(map, /className="min-h-11 max-w-28/u);
  assert.match(map, /pointer-events-auto absolute bottom-4 right-4/u);
  assert.match(map, /activeCells\.map/u);
  assert.match(map, /cellPreview\?\.cells\.map/u);
  assert.match(map, /draggable/u);
});

test("rotation and cell UI keep scoped offline snapshots and idempotent mutation identities", async () => {
  const [page, list, panel, cells, rotation] = await Promise.all([
    source("src/modules/potreros/PotrerosPage.tsx"),
    source("src/modules/potreros/components/ListaPotreros.tsx"),
    source("src/modules/potreros/components/MapPotreroPanel.tsx"),
    source("src/modules/potreros/components/PaddockCellsDialog.tsx"),
    source("src/modules/potreros/components/RotationOverviewPanel.tsx"),
  ]);
  assert.match(page, /fetchPaddockRotation\(selectedFundoId\)/u);
  assert.match(page, /fieldFeatureCacheKey\("rotation-v1", offlineScope, selectedFundoId\)/u);
  assert.match(page, /fieldFeatureCacheKey\("active-cells-v1", offlineScope, selectedFundoId\)/u);
  assert.match(page, /fetchFieldActivePaddockCells\(selectedFundoId\)/u);
  assert.match(page, /saveCachedSnapshot\(fieldFeatureCacheKey\("active-cells-v1"/u);
  assert.match(page, /saveCachedSnapshot\(paddockCellsCacheKey/u);
  assert.match(page, /setCellOperationIds\(\(current\) => current\[scopeKey\] \? current/u);
  assert.match(page, /\[operationScopeKey\]: \{ create: crypto\.randomUUID\(\), close:/u);
  assert.match(page, /\[operationScopeKey\]: \{ create: current\[operationScopeKey\]\?\.create \?\? crypto\.randomUUID\(\), close: crypto\.randomUUID\(\) \}/u);
  assert.match(rotation, /operationFieldId === snapshot\.fieldId \? current \?\? crypto\.randomUUID\(\) : crypto\.randomUUID\(\)/u);
  assert.match(rotation, /expectedVersion: snapshot\.settings\.version/u);
  assert.match(rotation, /recent < longRest/u);
  assert.match(list, /firstRank - secondRank/u);
  for (const badge of ["occupied", "recent", "ready", "long_rest", "no_history"]) assert.match(list, new RegExp(`${badge}:`, "u"));
  assert.match(panel, /Crear franjas/u);
  assert.match(cells, /El backend bloquea explícitamente las franjas V1/u);
  assert.match(cells, /pointer-events-none fixed inset-0/u);
  assert.match(cells, /Historial cerrado/u);
  assert.match(cells, /window\.confirm/u);
});
