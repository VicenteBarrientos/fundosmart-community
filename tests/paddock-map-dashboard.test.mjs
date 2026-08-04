import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { landmarkBelongsToPaddock, paddockLandmarks } from "../src/modules/potreros/utils/paddock-landmarks.ts";

const root = process.cwd();
const source = (relativePath) => readFile(path.join(root, relativePath), "utf8");
const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;

const SQUARE = [[0, 0], [0, 1], [1, 1], [1, 0]];
const PADDOCK = { coordinates: SQUARE, geometry: { outer: SQUARE, holes: [] } };
const PADDOCK_WITH_HOLE = {
  coordinates: SQUARE,
  geometry: { outer: SQUARE, holes: [[[0.4, 0.4], [0.4, 0.6], [0.6, 0.6], [0.6, 0.4]]] },
};

function landmark(overrides) {
  return {
    id: "landmark-1",
    fieldId: "field-1",
    kind: "bebedero",
    geometryType: "point",
    geometry: [[0.5, 0.5]],
    name: "Bebedero",
    notes: "",
    lengthMeters: 0,
    createdAt: "2026-07-01",
    updatedAt: "2026-07-01",
    deletedAt: null,
    version: 1,
    lastOperationId: "op-1",
    ...overrides,
  };
}

test("un hito pertenece al potrero que lo contiene y nunca a una exclusión", () => {
  assert.equal(landmarkBelongsToPaddock(landmark(), PADDOCK), true);
  assert.equal(landmarkBelongsToPaddock(landmark({ geometry: [[2, 2]] }), PADDOCK), false);
  assert.equal(landmarkBelongsToPaddock(landmark(), PADDOCK_WITH_HOLE), false);
  assert.equal(landmarkBelongsToPaddock(landmark({ geometry: [[0.2, 0.2]] }), PADDOCK_WITH_HOLE), true);
});

test("una línea pertenece al potrero si lo cruza aunque sus extremos queden fuera", () => {
  const crossing = landmark({ id: "fence", geometryType: "line", kind: "cerco_electrico", geometry: [[-1, 0.5], [2, 0.5]] });
  const inside = landmark({ id: "callejon", geometryType: "line", kind: "callejon", geometry: [[0.2, 0.2], [0.8, 0.8]] });
  const outside = landmark({ id: "lejano", geometryType: "line", kind: "callejon", geometry: [[5, 5], [6, 6]] });

  assert.equal(landmarkBelongsToPaddock(crossing, PADDOCK), true);
  assert.equal(landmarkBelongsToPaddock(inside, PADDOCK), true);
  assert.equal(landmarkBelongsToPaddock(outside, PADDOCK), false);
  assert.deepEqual(paddockLandmarks([crossing, inside, outside], PADDOCK).map(({ id }) => id), ["fence", "callejon"]);
  assert.deepEqual(paddockLandmarks([crossing, inside, outside], null), []);
});

sourceContractTest("el dashboard del mapa reúne los comandos del fundo y del potrero en un solo panel", async () => {
  const [map, panel] = await Promise.all([
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("src/modules/potreros/components/MapPotreroPanel.tsx"),
  ]);

  // El panel del potrero vive dentro del dashboard del mapa, no en una segunda tarjeta.
  assert.match(map, /<MapPotreroPanel/u);
  assert.match(map, /!boundaryEditing && !potreroBoundaryEditingId && !subdivisionMode && !exclusionMode && !measurementMode && \(/u);
  for (const command of ["Editar", "Editar bordes", "Dibujar exclusión", "Subdividir potrero", "Crear franjas"]) {
    assert.match(panel, new RegExp(command, "u"));
  }
});

sourceContractTest("el panel del potrero nace colapsado y trabaja sobre el potrero seleccionado en el mapa", async () => {
  const panel = await source("src/modules/potreros/components/MapPotreroPanel.tsx");

  assert.match(panel, /useState\(false\)/u);
  assert.match(panel, /aria-expanded=\{expanded\}/u);
  assert.match(panel, /aria-controls="map-potrero-panel"/u);
  assert.match(panel, /id="map-potrero-panel"/u);
  // El contenido expandido siempre refleja la selección vigente del mapa.
  assert.match(panel, /selectedPotrero \? paddockAreaMetrics\(selectedPotrero\) : null/u);
  assert.match(panel, /value=\{selectedPotrero\?\.id \?\? ""\}/u);
  assert.match(panel, /onChange=\{\(event\) => onSelect\(event\.target\.value \|\| null\)\}/u);
});

sourceContractTest("los hitos se crean desde el potrero y se editan dentro del mapa", async () => {
  const [panel, form, map, landmarks, page] = await Promise.all([
    source("src/modules/potreros/components/MapPotreroPanel.tsx"),
    source("src/modules/potreros/components/MapLandmarkForm.tsx"),
    source("src/modules/potreros/components/MapaPotreros.tsx"),
    source("src/modules/potreros/components/FieldLandmarksPanel.tsx"),
    source("src/modules/potreros/PotrerosPage.tsx"),
  ]);

  assert.match(panel, /Hitos del potrero \(\{ownLandmarks\.length\}\)/u);
  assert.match(panel, /onAddLandmark\("point"\)/u);
  assert.match(panel, /onAddLandmark\("line"\)/u);
  assert.match(panel, /paddockLandmarks\(landmarks, selectedPotrero\)/u);
  assert.match(map, /<MapLandmarkForm/u);
  assert.match(form, /Guardar hito/u);
  assert.match(form, /aria-label="Nombre del hito"/u);
  assert.match(page, /onPaddockLandmarkStart=\{startFieldLandmark\}/u);
  assert.match(page, /onLandmarkSave=\{saveFieldLandmarkDraft\}/u);
  // El inventario del fundo ya no duplica el formulario: sólo lista y deriva el potrero.
  assert.doesNotMatch(landmarks, /FieldLandmarkForm/u);
  assert.match(landmarks, /landmarkBelongsToPaddock\(landmark, paddock\)/u);
});

sourceContractTest("crear un potrero ocurre en el mapa y abre su ficha para completarla", async () => {
  const page = await source("src/modules/potreros/PotrerosPage.tsx");
  const create = page.slice(
    page.indexOf("async function createPaddockFromDraft"),
    page.indexOf("async function persistImportedPaddock"),
  );

  assert.match(create, /nextAvailablePaddockName\(visiblePotreros\)/u);
  assert.match(create, /await savePotrero\(/u);
  assert.match(create, /setManageMode\("edit"\)/u);
  assert.match(page, /onCreateSaveRequest=\{\(\) => \{ void createPaddockFromDraft\(\); \}\}/u);
  assert.match(page, /function nextAvailablePaddockName/u);
});
