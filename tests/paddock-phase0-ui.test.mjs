import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const page = read("src/modules/potreros/PotrerosPage.tsx");
const map = read("src/modules/potreros/components/MapaPotreros.tsx");
const panel = read("src/modules/potreros/components/MapPotreroPanel.tsx");
const history = read("src/modules/potreros/components/HistorialPotrero.tsx");
const fundoDialog = read("src/modules/potreros/components/ManageFundoDialog.tsx");
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(startIndex, -1, `No se encontró ${start}`);
  assert.notEqual(endIndex, -1, `No se encontró ${end}`);
  return source.slice(startIndex, endIndex);
}

sourceContractTest("el dibujo hace snap visual a vértices y luego aristas dentro de 12 px", () => {
  assert.match(map, /const SNAP_THRESHOLD_PX = 12;/);
  assert.match(map, /latLngToContainerPoint/);
  assert.match(map, /closestPointOnSegment\(raw,/);
  assert.ok(map.indexOf("let nearestVertex") < map.indexOf("let nearestEdge"), "los vértices deben tener prioridad");
  assert.match(map, /snap\?\.point \?\? \[event\.latlng\.lat, event\.latlng\.lng\]/);
  assert.match(map, /Vértice exacto/);
  assert.match(map, /Encajar en borde/);
});

sourceContractTest("la herramienta Medir mantiene una polilínea temporal y calcula perímetro y hectáreas al cerrar", () => {
  assert.match(map, /> Medir\s*</);
  assert.match(map, /calculatePathLengthMeters\(measurementPreview\)/);
  assert.match(map, /calculatePerimeterMeters\(measurementPoints\)/);
  assert.match(map, /calculateHectares\(measurementPoints\)/);
  assert.match(map, /Cerrar área/);
  assert.match(map, /closeOnFirst/);
  assert.doesNotMatch(map, /localStorage.*measurement|persist.*measurement/i);
});

sourceContractTest("los cuatro guardados validan, bloquean errores y confirman warnings", () => {
  const savePotrero = section(page, "async function savePotrero", "async function saveActivity");
  const saveBoundary = section(page, "async function saveBoundary", "function cancelBoundaryEditing");
  const confirmSubdivision = section(page, "async function confirmSubdivision", "function startPotreroBoundaryEditing");
  const savePotreroBoundary = section(page, "async function savePotreroBoundary", "return (");

  assert.match(savePotrero, /validatePotreroGeometry/);
  assert.match(savePotrero, /requireGeometryApproval/);
  assert.match(saveBoundary, /validateFundoBoundaryChange/);
  assert.match(saveBoundary, /requireGeometryApproval/);
  assert.match(confirmSubdivision, /validateGeometryCollection/);
  assert.match(confirmSubdivision, /requireGeometryApproval/);
  assert.match(savePotreroBoundary, /validatePotreroGeometry/);
  assert.match(savePotreroBoundary, /requireGeometryApproval/);
  assert.match(page, /if \(validation\.errors\.length > 0\)[\s\S]*throw new Error/);
  assert.match(page, /window\.confirm/);
  assert.match(page, /if \(!confirmed\) throw new Error/);
});

sourceContractTest("el dashboard del mapa muestra errores y advertencias geométricas de cada modo", () => {
  assert.match(map, /boundaryValidation/);
  assert.match(map, /draftValidation/);
  assert.match(map, /potreroBoundaryValidation/);
  assert.match(map, /subdivisionValidation/);
  assert.match(map, /function GeometryFeedback/);
  assert.match(map, /validation\.errors\.map/);
  assert.match(map, /validation\.warnings\.map/);
  assert.match(map, /draftValidation\.errors\.length > 0/);
  assert.match(map, /\{draftPoints\.length > 0 && <GeometryFeedback error=\{editorInteractionError\} validation=\{draftValidation\} wide \/>\}/);
});

sourceContractTest("el detalle del potrero y del fundo muestran perímetro métrico", () => {
  assert.match(history, /calculatePerimeterMeters\(potrero\.coordinates\)/);
  assert.match(history, /label="Perímetro"/);
  assert.match(panel, /calculatePerimeterMeters\(selectedPotrero\.coordinates\)/);
  assert.match(panel, /label="Perímetro"/);
  assert.match(fundoDialog, /calculatePerimeterMeters\(fundo\.coordinates\)/);
  assert.match(fundoDialog, /Perímetro/);
});
