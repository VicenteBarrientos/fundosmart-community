import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { buildPaddockNdviMonthSeries } from "../src/modules/potreros/ndvi/paddock-ndvi-history.ts";

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");

test("hitos acumulan respuestas CAS en un ref y descartan respuestas de otro fundo o scope", async () => {
  const page = await source("src/modules/potreros/PotrerosPage.tsx");
  assert.match(page, /fieldLandmarksRef = useRef<FieldLandmarkListing \| null>/u);
  assert.match(page, /fieldLandmarksRef\.current\?\.fieldId === fieldId/u);
  assert.match(page, /activeFieldIdRef\.current !== listing\.fieldId/u);
  assert.match(page, /activeOfflineScopeRef\.current !== offlineScope \|\| activeFieldIdRef\.current !== listing\.fieldId/u);
  assert.match(page, /request\.fieldId !== activeFieldIdRef\.current/u);
  assert.match(page, /window\.confirm\(`/u);
  assert.match(page, /expectedVersion: landmark\.version/u);
});

test("mapa activa NDVI sólo con valor real y el resumen no recorta potreros", async () => {
  const [map, panel] = await Promise.all([
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("src/modules/potreros/components/PaddockNdviPanel.tsx"),
  ]);
  assert.match(map, /ndviSnapshot: ndviByPaddock\.get\(potrero\.id\)\?\.value \?\? null/u);
  assert.match(map, /ALWAYS_AVAILABLE_THEMATIC_MODES\.map/u);
  assert.match(map, /<option disabled=\{!hasKnownNdvi\} value="ndvi">/u);
  assert.match(map, /landmarksVisible && !subdivisionMode && landmarks\.map/u);
  assert.match(map, /enabled=\{Boolean\(landmarkDraft\)\}/u);
  assert.match(panel, /items\.map\(\(item\)/u);
  assert.doesNotMatch(panel, /items\.slice/u);
  assert.match(panel, /pendingRefresh = items\.filter\(\(\{ cacheState \}\) => cacheState !== "current"\)/u);
  assert.match(panel, /\{pendingRefresh\} por actualizar/u);
});

test("refresh lazy respeta demo, tope, progreso acumulado y errores públicos", async () => {
  const page = await source("src/modules/potreros/PotrerosPage.tsx");
  assert.match(page, /if \(!selectedFundoId \|\| isDemo \|\| !canMutate \|\| !networkOnline \|\| ndviRefreshing\) return/u);
  assert.match(page, /Math\.ceil\(visiblePotreros\.length \/ PADDOCK_NDVI_REFRESH_MAX_PADDOCKS\) \+ 1/u);
  assert.match(page, /for \(let attempt = 0; attempt < maximumBatches; attempt \+= 1\)/u);
  assert.match(page, /completedPaddockIds = new Set<string>/u);
  assert.match(page, /completedPaddockIds\.size <= completedBefore/u);
  assert.match(page, /value\.state === "unavailable" \|\| value\.state === "error" \|\| value\.state === "stale"/u);
  assert.match(page, /batchIssues\[0\]\?\.error\?\.message/u);
  assert.match(page, /ndviAutoRefreshFieldsRef\.current\.add\(selectedFundoId\)/u);
});

test("serie NDVI conserva cache legacy y representa meses ausentes o no_data como brechas", () => {
  const legacyValue = { month: "2026-07-01", status: "ok", meanNdvi: 0.61 };
  const legacySeries = buildPaddockNdviMonthSeries({ paddockId: "p-1", paddockName: "Norte", cacheState: "current", value: legacyValue });
  assert.equal(legacySeries.length, 6);
  assert.equal(legacySeries.at(-1).value, legacyValue);
  assert.ok(legacySeries.slice(0, -1).every(({ value }) => value === null));

  const noData = { month: "2026-06-01", status: "no_data", meanNdvi: null };
  const known = { month: "2026-04-01", status: "ok", meanNdvi: 0.48 };
  const series = buildPaddockNdviMonthSeries({ paddockId: "p-1", paddockName: "Norte", cacheState: "current", value: noData, history: [noData, known] });
  assert.equal(series.at(-1).value.status, "no_data");
  assert.equal(series.at(-3).value.meanNdvi, 0.48);
  assert.equal(series.at(-2).value, null);
});
