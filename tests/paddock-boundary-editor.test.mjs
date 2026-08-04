import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  boundaryRingsEqual,
  changedBoundaryDraftIds,
  insertBoundaryVertex,
  moveBoundaryVertex,
  removeBoundaryVertex,
} from "../src/modules/potreros/utils/boundary-editor.ts";

const sourceContractTest = process.env.FUNDOSMART_SOURCE_CONTRACTS === "1" ? test : test.skip;
const LEFT = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
];
const RIGHT = [
  [0, 1],
  [0, 2],
  [1, 2],
  [1, 1],
];

test("insertar un vértice en un cerco compartido actualiza ambos potreros", () => {
  const inserted = insertBoundaryVertex({ left: LEFT, right: RIGHT }, "left", 1, [0.5, 1]);

  assert.deepEqual(inserted.affectedIds.sort(), ["left", "right"]);
  assert.deepEqual(inserted.drafts.left, [[0, 0], [0, 1], [0.5, 1], [1, 1], [1, 0]]);
  assert.deepEqual(inserted.drafts.right, [[0, 1], [0, 2], [1, 2], [1, 1], [0.5, 1]]);
  assert.deepEqual(LEFT, [[0, 0], [0, 1], [1, 1], [1, 0]], "la operación no muta el borrador anterior");
});

test("mover un vértice compartido mantiene el cerco enlazado", () => {
  const inserted = insertBoundaryVertex({ left: LEFT, right: RIGHT }, "left", 1, [0.5, 1]);
  const moved = moveBoundaryVertex(inserted.drafts, "left", 2, [0.55, 1.04]);

  assert.deepEqual(moved.affectedIds.sort(), ["left", "right"]);
  assert.deepEqual(moved.drafts.left[2], [0.55, 1.04]);
  assert.deepEqual(moved.drafts.right.at(-1), [0.55, 1.04]);
});

test("eliminar un vértice intermedio compartido simplifica ambos polígonos", () => {
  const inserted = insertBoundaryVertex({ left: LEFT, right: RIGHT }, "left", 1, [0.5, 1]);
  const removed = removeBoundaryVertex(inserted.drafts, "left", 2);

  assert.equal(removed.ok, true);
  assert.deepEqual(removed.affectedIds.sort(), ["left", "right"]);
  assert.equal(boundaryRingsEqual(removed.drafts.left, LEFT), true);
  assert.equal(boundaryRingsEqual(removed.drafts.right, RIGHT), true);
});

test("un vértice de unión no se elimina si abriría un hueco con un vecino", () => {
  const removed = removeBoundaryVertex({ left: LEFT, right: RIGHT }, "left", 1);

  assert.equal(removed.ok, false);
  assert.match(removed.message, /unión entre varios potreros/u);
});

test("el editor identifica solamente los polígonos realmente modificados", () => {
  const inserted = insertBoundaryVertex({ left: LEFT, right: RIGHT }, "left", 1, [0.5, 1]);
  const changed = changedBoundaryDraftIds(inserted.drafts, [
    { id: "left", coordinates: LEFT },
    { id: "right", coordinates: RIGHT },
    { id: "other", coordinates: [[2, 2], [2, 3], [3, 2]] },
  ]);

  assert.deepEqual(changed.sort(), ["left", "right"]);
});

sourceContractTest("la superficie UI expone un workspace completo y herramientas de edición claras", async () => {
  const [page, map] = await Promise.all([
    readFile(new URL("../src/modules/potreros/PotrerosPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/MapaPotreros.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /fixed inset-0 z-\[2000\]/u);
  assert.match(page, /Editor de mapa en pantalla completa/u);
  assert.match(map, /Abrir mapa en pantalla completa/u);
  assert.match(map, /MapLayoutObserver/u);
  assert.match(map, /invalidateSize/u);
  assert.match(map, /<span>Agregar punto<\/span>/u);
  assert.match(map, /<span>Eliminar punto<\/span>/u);
  assert.match(map, /aria-label="Deshacer cambio"/u);
  assert.match(map, /aria-label="Rehacer cambio"/u);
  assert.match(map, /<span>Guardar potrero<\/span>/u);
  assert.match(map, /Guardar límite del fundo/u);
  assert.match(map, /Cambios sin guardar/u);
  assert.match(map, /También ajusta/u);
  assert.match(map, /Dashboard de comandos del mapa/u);
  assert.match(map, /map-command-dashboard/u);
  assert.match(map, /data-map-help="Muestra puntos sobre cada lado para agregar un nuevo vértice\."/u);
  assert.doesNotMatch(map, /overflow-x-auto|map-mobile-controls/u);
  assert.match(map, /map-label-secondary/u);

  // El mapa ocupa todo el ancho: ya no hay columna lateral de creación ni hoja móvil.
  assert.doesNotMatch(page, /FormPotrero|form-potrero|nuevo-potrero|Datos y guardar|max-lg:h-\[72dvh\]/u);
  assert.doesNotMatch(page, /xl:grid-cols-\[minmax\(0,1fr\)_340px\]|lg:grid-cols-\[minmax\(0,1fr\)_380px\]/u);
  assert.match(page, /className=\{mapFullscreen\s*\n\s*\? "fixed inset-0 z-\[2000\] grid min-h-0 grid-rows-1 bg-ink p-2 sm:p-3"\s*\n\s*: "mt-5 grid items-stretch"\}/u);

  const potreroToolbar = map.slice(
    map.indexOf(") : potreroBoundaryEditingId ? ("),
    map.indexOf(") : subdivisionMode ? ("),
  );
  assert.ok(
    potreroToolbar.indexOf("Guardar potrero") < potreroToolbar.indexOf("Agregar punto"),
    "Guardar debe quedar visible antes de las herramientas secundarias",
  );
});
