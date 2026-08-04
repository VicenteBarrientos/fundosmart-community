import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const source = (path) => readFile(new URL(path, root), "utf8");
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;

sourceContractTest("ubicación y captura GPS siguen disponibles offline con guards del navegador", async () => {
  const map = await source("src/modules/potreros/components/MapaPotreros.tsx");
  const unavailableGuard = section(map, "function gpsUnavailableReason", "function gpsDecisionLabel");
  const boundaryStart = section(map, "function startGpsBoundaryCapture", "function finishGpsBoundaryCapture");

  assert.match(map, /useGpsBoundaryCapture\(gpsBoundaryContext\)/u);
  assert.match(map, />Mi ubicación<\/span>/u);
  assert.match(map, /gpsCapture\.start\("location"\)/u);
  assert.match(map, /gpsCapture\.start\("boundary"\)/u);
  assert.match(unavailableGuard, /permission === "denied"/u);
  assert.match(unavailableGuard, /availability === "checking"/u);
  assert.match(unavailableGuard, /availability === "insecure_context"/u);
  assert.match(unavailableGuard, /availability === "unsupported"/u);
  assert.doesNotMatch(unavailableGuard, /networkOnline/u);
  assert.doesNotMatch(boundaryStart, /networkOnline/u);
});

sourceContractTest("los contextos GPS, el adaptador y el guardado normal respetan fundo y potrero", async () => {
  const [map, page] = await Promise.all([
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("src/modules/potreros/PotrerosPage.tsx"),
  ]);
  const finish = section(map, "function finishGpsBoundaryCapture", "function toggleGpsLocation");

  assert.match(map, /potrero\.id !== potreroBoundaryEditingId/u);
  assert.match(map, /siblings:[\s\S]+?map\(\(potrero\) => potrero\.coordinates\)/u);
  assert.match(map, /:\s*\{\},\s*\n\s*\[fundo\?\.coordinates/u, "el fundo se valida contra el propio recorrido");
  assert.match(finish, /gpsBoundaryCoordinatesToDraft\(completed\.coordinates\)/u);
  assert.match(finish, /commitEditorSnapshot\(\{ kind: "fundo", points: nextDraft \}\)/u);
  assert.match(finish, /onPotreroGpsBoundaryDraftApply\(nextDraft\)/u);
  assert.doesNotMatch(finish, /onBoundarySave|onPotreroBoundarySave/u);
  assert.match(map, /onClick=\{saveEditedBoundary\}/u);
  assert.match(map, /onClick=\{saveEditedPotreroBoundary\}/u);
  assert.match(page, /potreroBoundaryCapturedWithGps \? "gps" : "map"/u);
  assert.match(page, /setPotreroBoundaryCapturedWithGps\(true\)/u);
  assert.match(page, /onPotreroBoundaryDraftsChange=\{\(drafts\) => \{[\s\S]+?setPotreroBoundaryCapturedWithGps\(false\)/u);
  assert.doesNotMatch(page, /potreroBoundaryTopologyReplaced/u);
});

sourceContractTest("la captura muestra overlays, decisiones, validación y limpia target/runtime", async () => {
  const map = await source("src/modules/potreros/components/MapaPotreros.tsx");

  assert.match(map, /<Circle[\s\S]+?radius=\{gpsCapture\.currentFix\.accuracyMeters\}/u);
  assert.match(map, /gpsCapture\.mode === "boundary" && gpsCapture\.trace\.length > 1/u);
  assert.match(map, /<GpsMapFocus coordinate=\{gpsCapture\.currentFix\?\.coordinate \?\? null\}/u);
  assert.match(map, /acceptedFixes\.length < 3/u);
  assert.match(map, /capture\.result\.valid \? "Validación correcta\." : "Requiere corrección antes de guardar\."/u);
  assert.match(map, /<GeometryFeedback validation=\{capture\.result\.validation\} wide \/>/u);
  assert.match(map, /previousGpsTargetRef\.current !== gpsTarget\) cancelGpsCapture\(\)/u);
  assert.match(map, /previousGpsFundoRef\.current !== fundo\?\.id\) cancelGpsCapture\(\)/u);
  assert.match(map, /gpsDecisionLabel\(capture\)[\s\S]+?wakeLockLabel\(capture\.wakeLockStatus\)/u);
});

sourceContractTest("doble tap cierra sin duplicar puntos y restaura el zoom en todos los modos", async () => {
  const map = await source("src/modules/potreros/components/MapaPotreros.tsx");
  const drawing = section(map, "function DrawingEvents", "function DrawingInteractionController");
  const controller = section(map, "function DrawingInteractionController", "function GpsMapFocus");
  const modes = section(map, "const drawingInteractionActive", "useEffect(() =>");

  assert.match(drawing, /pendingClickRef/u);
  assert.match(drawing, /dblclick\(event\)/u);
  assert.match(drawing, /window\.clearTimeout\(pendingClickRef\.current\)/u);
  assert.match(drawing, /points\.length < 3/u);
  assert.match(controller, /doubleClickZoom\.disable\(\)/u);
  assert.match(controller, /restoreDoubleClickZoom/u);
  assert.match(controller, /doubleClickZoom\.enable\(\)/u);
  for (const mode of ["drawing", "redrawingBoundary", "subdivisionMode", "measurementMode", "exclusionMode", "landmarkDraft"]) {
    assert.match(modes, new RegExp(`\\b${mode}\\b`, "u"));
  }
});

sourceContractTest("toolbars y handles coarse cumplen objetivos táctiles de 44 px", async () => {
  const [map, styles] = await Promise.all([
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("app/globals.css"),
  ]);

  assert.doesNotMatch(map, /\b(?:h-10|size-10)\b/u);
  assert.match(map, /min-h-11/u);
  assert.match(map, /min-w-11/u);
  assert.match(styles, /@media \(pointer: coarse\)/u);
  assert.match(styles, /\.leaflet-control-zoom a[\s\S]+?width: 44px/u);
  assert.match(styles, /\.fundo-vertex-marker[\s\S]+?width: 30px/u);
  assert.match(styles, /\.potrero-vertex-marker[\s\S]+?width: 28px/u);
});

sourceContractTest("el dashboard mantiene todos los comandos visibles sin scrollbar y explica cada acción", async () => {
  const [map, styles] = await Promise.all([
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("app/globals.css"),
  ]);

  assert.match(map, /aria-label="Dashboard de comandos del mapa"/u);
  assert.match(map, /map-command-dashboard/u);
  assert.match(map, /h-\[720px\][\s\S]+sm:h-\[590px\]/u);
  assert.match(map, /flex w-full flex-wrap items-center/u);
  assert.match(map, /id="map-view-controls"/u);
  assert.doesNotMatch(map, /overflow-x-auto|mobileMapControlsOpen|map-mobile-controls/u);
  assert.ok((map.match(/data-map-help=/gu) ?? []).length >= 25, "los comandos principales deben explicar su función");
  assert.match(map, /aria-label="Deshacer cambio"[\s\S]+?<span>Deshacer<\/span>/u);
  assert.match(map, /aria-label="Rehacer cambio"[\s\S]+?<span>Rehacer<\/span>/u);
  assert.match(map, /<span>Recentrar<\/span>/u);
  assert.match(styles, /\.map-command-dashboard \[data-map-help\]::after/u);
  assert.match(styles, /\[data-map-help\]:hover::after/u);
  assert.match(styles, /\[data-map-help\]:focus-visible::after/u);
  assert.match(styles, /content: attr\(data-map-help\)/u);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]+\.map-command-dashboard \[data-map-help\]::after[\s\S]+display: none/u);
});

function section(sourceText, start, end) {
  const startIndex = sourceText.indexOf(start);
  const endIndex = sourceText.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `falta inicio: ${start}`);
  assert.notEqual(endIndex, -1, `falta fin: ${end}`);
  return sourceText.slice(startIndex, endIndex);
}
