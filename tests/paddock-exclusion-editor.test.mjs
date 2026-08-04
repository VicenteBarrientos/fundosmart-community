import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { buildExclusionEditPreview } from "../src/modules/potreros/utils/exclusions.ts";
import { metersToDegrees } from "../src/modules/potreros/utils/geometry.ts";

const ORIGIN_LATITUDE = -40;
const ORIGIN_LONGITUDE = -73;

test("editar una exclusión reemplaza sólo su anillo y conserva las demás", () => {
  const source = paddock({
    geometry: {
      outer: rectangle(0, 500, 0, 300),
      holes: [
        rectangle(50, 150, 50, 150),
        rectangle(300, 400, 100, 200),
      ],
    },
    holeKinds: ["laguna", "bosque"],
  });
  const replacement = rectangle(40, 180, 40, 170);
  const preview = buildExclusionEditPreview({
    paddock: source,
    exclusionIndex: 0,
    kind: "humedal",
    exclusion: replacement,
  });

  assert.equal(preview.operation, "edit");
  assert.deepEqual(preview.blockers, []);
  assert.equal(preview.affected.length, 1);
  assert.deepEqual(preview.affected[0].updatedPaddock.geometry.holes[0], replacement);
  assert.deepEqual(preview.affected[0].updatedPaddock.geometry.holes[1], source.geometry.holes[1]);
  assert.deepEqual(preview.affected[0].updatedPaddock.holeKinds, ["humedal", "bosque"]);
  assert.ok(preview.affected[0].nextNetAreaHectares < preview.affected[0].previousNetAreaHectares);
});

test("cambiar sólo el tipo de exclusión es una edición válida", () => {
  const source = paddock();
  const preview = buildExclusionEditPreview({
    paddock: source,
    exclusionIndex: 0,
    kind: "humedal",
    exclusion: source.geometry.holes[0],
  });

  assert.deepEqual(preview.blockers, []);
  assert.deepEqual(preview.affected[0].updatedPaddock.holeKinds, ["humedal"]);
  assert.equal(preview.affected[0].nextNetAreaHectares, preview.affected[0].previousNetAreaHectares);
});

test("una edición idéntica no genera una escritura artificial", () => {
  const source = paddock();
  const preview = buildExclusionEditPreview({
    paddock: source,
    exclusionIndex: 0,
    kind: "laguna",
    exclusion: source.geometry.holes[0],
  });

  assert.deepEqual(preview.affected, []);
  assert.match(preview.blockers[0], /No hay cambios/u);
});

test("la edición rechaza bordes fuera del potrero o sobre otra exclusión", () => {
  const source = paddock({
    geometry: {
      outer: rectangle(0, 500, 0, 300),
      holes: [
        rectangle(50, 150, 50, 150),
        rectangle(300, 400, 100, 200),
      ],
    },
    holeKinds: ["laguna", "bosque"],
  });
  const outside = buildExclusionEditPreview({
    paddock: source,
    exclusionIndex: 0,
    kind: "laguna",
    exclusion: rectangle(-10, 100, 50, 150),
  });
  const overlap = buildExclusionEditPreview({
    paddock: source,
    exclusionIndex: 0,
    kind: "laguna",
    exclusion: rectangle(250, 350, 100, 200),
  });

  assert.deepEqual(outside.affected, []);
  assert.match(outside.blockers[0], /dentro del anillo exterior|tocar su borde/iu);
  assert.deepEqual(overlap.affected, []);
  assert.match(overlap.blockers[0], /no pueden tocarse ni solaparse/iu);
});

test("el mapa y la ficha exponen la edición de exclusiones con confirmación", async () => {
  const [page, map, history, dialogs] = await Promise.all([
    readFile(new URL("../src/modules/potreros/PotrerosPage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/MapaPotreros.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/HistorialPotrero.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/potreros/components/ExclusionDialogs.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(page, /function startExclusionEditing/u);
  assert.match(page, /buildExclusionEditPreview/u);
  assert.match(map, /clic para editar/u);
  assert.match(map, /aria-label="Tipo de exclusión"/u);
  assert.match(map, /Revisar cambios/u);
  assert.match(history, /aria-label=\{`Editar /u);
  assert.match(dialogs, /preview\.operation === "edit"/u);
  assert.match(dialogs, /Guardar cambios/u);
});

function paddock(overrides = {}) {
  const geometry = overrides.geometry ?? {
    outer: rectangle(0, 500, 0, 300),
    holes: [rectangle(50, 150, 50, 150)],
  };
  return {
    id: "paddock-edit",
    fieldId: "field-edit",
    name: "Potrero editable",
    sector: "Norte",
    areaHectares: 15,
    coordinates: geometry.outer,
    geometry,
    grazeableAreaHectares: null,
    landUse: "pradera_permanente",
    holeKinds: overrides.holeKinds ?? ["laguna"],
    soil: { ph: null, nitrogen: null, phosphorus: null, potassium: null },
    lastActivity: "Creado",
    status: "Disponible",
    updatedAt: "2026-07-27T12:00:00.000Z",
    ...overrides,
  };
}

function coordinate(northMeters, eastMeters) {
  return [
    ORIGIN_LATITUDE + metersToDegrees(northMeters, ORIGIN_LATITUDE, "latitude"),
    ORIGIN_LONGITUDE + metersToDegrees(eastMeters, ORIGIN_LATITUDE, "longitude"),
  ];
}

function rectangle(westMeters, eastMeters, southMeters, northMeters) {
  return [
    coordinate(southMeters, westMeters),
    coordinate(southMeters, eastMeters),
    coordinate(northMeters, eastMeters),
    coordinate(northMeters, westMeters),
  ];
}
