import assert from "node:assert/strict";
import test from "node:test";

import {
  ANIMAL_SPREADSHEET_COLUMNS,
  animalSpreadsheetColumns,
  buildAnimalSpreadsheetRow,
  compactSpreadsheetDraft,
  createAnimalDraftRow,
  formatAnimalCell,
  formatSpreadsheetDate,
  normalizeLookupText,
  parseAnimalCell,
  parseSpreadsheetDate,
  parseSpreadsheetNumber,
  planAnimalSpreadsheet,
  pruneSpreadsheetDraft,
  spreadsheetColumnOptions,
  weighingColumnDate,
  weighingColumnKey,
  weighingDatesFromEdits,
} from "../src/modules/ganado/domain/animal-spreadsheet.mjs";
import {
  parseClipboardMatrix,
  serializeClipboardMatrix,
} from "../src/ui/spreadsheet-clipboard.mjs";

const CONTEXT = {
  lots: [
    { id: "lot-engorda", name: "Engorda", trackingMode: "individual" },
    { id: "lot-recria", name: "Recría", trackingMode: "individual" },
    { id: "lot-resumen", name: "Vientres", trackingMode: "summary" },
  ],
  sexLabels: { female: "Hembra", male: "Macho", unknown: "Sin dato" },
  statusLabels: { active: "Activo", dead: "Fallecido", sold: "Vendido", departed: "Salió" },
};

/**
 * La misma planilla, pero abierta con historia de pesajes a la vista.
 *
 * Las fechas llegan desordenadas a propósito: quien la abre no tiene por qué ordenarlas,
 * y si el dominio no lo hiciera, dos pantallas pegarían la misma columna de Excel en
 * fechas distintas.
 */
const WEIGHINGS_CONTEXT = {
  ...CONTEXT,
  weighingDates: ["2026-03-01", "2026-06-01", "2026-07-15"],
  weighingsByAnimal: { "animal-1": { "2026-03-01": 280, "2026-06-01": 300 } },
};

const MARZO = weighingColumnKey("2026-03-01");
const JUNIO = weighingColumnKey("2026-06-01");
const JULIO = weighingColumnKey("2026-07-15");

function animal(overrides = {}) {
  return {
    id: "animal-1",
    lotId: "lot-engorda",
    tag: "0123",
    sex: "female",
    status: "active",
    statusDate: null,
    statusReason: null,
    birthDate: "2024-03-10",
    purchasePriceClp: 250000,
    purchaseDate: "2025-01-15",
    salePriceClp: null,
    saleBuyer: null,
    saleWeightKg: null,
    origin: "Feria Osorno",
    notes: "",
    source: "Registro manual",
    latestWeightKg: 300,
    latestWeightDate: "2026-06-01",
    createdAt: "2025-01-15T12:00:00.000Z",
    snapshotToken: "token-1",
    ...overrides,
  };
}

test("interpreta números con el separador decimal chileno y con el inglés", () => {
  assert.deepEqual(parseSpreadsheetNumber("312,5"), { value: 312.5, error: null });
  assert.deepEqual(parseSpreadsheetNumber("1.234,5"), { value: 1234.5, error: null });
  assert.deepEqual(parseSpreadsheetNumber("312.5"), { value: 312.5, error: null });
  assert.deepEqual(parseSpreadsheetNumber("$ 1.250.000"), { value: 1250000, error: null });
  assert.deepEqual(parseSpreadsheetNumber(""), { value: null, error: null });
  assert.equal(parseSpreadsheetNumber("trescientos").error, "No es un número.");
});

test("un punto seguido de tres dígitos es separador de miles, como lo muestra la app", () => {
  assert.equal(parseSpreadsheetNumber("1.234").value, 1234);
  assert.equal(parseSpreadsheetNumber("1.23").value, 1.23);
});

test("lee fechas en orden chileno y rechaza las que no existen", () => {
  assert.equal(parseSpreadsheetDate("17/07/2026").value, "2026-07-17");
  assert.equal(parseSpreadsheetDate("17-07-2026").value, "2026-07-17");
  assert.equal(parseSpreadsheetDate("2026-07-17").value, "2026-07-17");
  assert.equal(parseSpreadsheetDate("1/7/26").value, "2026-07-01");
  assert.equal(parseSpreadsheetDate("31/02/2026").value, null);
  assert.match(parseSpreadsheetDate("31/02/2026").error, /no existe/);
});

test("el texto de una fecha vuelve a la misma fecha al re-interpretarse", () => {
  const iso = "2026-07-17";
  assert.equal(parseSpreadsheetDate(formatSpreadsheetDate(iso)).value, iso);
});

test("separa columnas por tabulación y respeta las celdas con comillas", () => {
  assert.deepEqual(parseClipboardMatrix("310\t17/07/2026\n312\t17/07/2026\n"), [
    ["310", "17/07/2026"],
    ["312", "17/07/2026"],
  ]);
  assert.deepEqual(parseClipboardMatrix('a\t"nota con\nsalto"\tb'), [["a", "nota con\nsalto", "b"]]);
  assert.equal(serializeClipboardMatrix([["a", "nota con\tsalto"]]), 'a\t"nota con\tsalto"');
});

test("normaliza texto para comparar opciones sin acentos ni mayúsculas", () => {
  assert.equal(normalizeLookupText("  HÉMBRA  "), "hembra");
  assert.equal(normalizeLookupText("Recría"), "recria");
});

test("acepta una opción escrita con cualquier acentuación y rechaza una desconocida", () => {
  assert.equal(parseAnimalCell("sex", "hembra", CONTEXT).value, "female");
  assert.equal(parseAnimalCell("sex", "HEMBRA", CONTEXT).value, "female");
  assert.equal(parseAnimalCell("lotId", "recria", CONTEXT).value, "lot-recria");
  assert.match(parseAnimalCell("sex", "hembrita", CONTEXT).error, /Opciones/);
});

test("un lote en modo resumen no es un destino válido de la planilla", () => {
  assert.match(parseAnimalCell("lotId", "Vientres", CONTEXT).error, /trazabilidad individual/);
  const options = spreadsheetColumnOptions("lotId", CONTEXT).map((option) => option.label);
  assert.deepEqual(options, ["Engorda", "Recría"]);
});

test("el DIIO conserva los ceros a la izquierda y rechaza caracteres inválidos", () => {
  const row = buildAnimalSpreadsheetRow(animal(), CONTEXT);
  assert.equal(row.cells.tag, "0123");
  assert.equal(parseAnimalCell("tag", "0123", CONTEXT).value, "0123");
  assert.match(parseAnimalCell("tag", "12 34", CONTEXT).error, /letras, números/);
  assert.match(parseAnimalCell("tag", "", CONTEXT).error, /no puede quedar vacío/);
});

test("el dinero se registra en pesos enteros", () => {
  assert.equal(parseAnimalCell("purchasePriceClp", "1.250.000", CONTEXT).value, 1250000);
  assert.match(parseAnimalCell("purchasePriceClp", "1250,50", CONTEXT).error, /pesos enteros/);
  assert.match(parseAnimalCell("purchasePriceClp", "-100", CONTEXT).error, /negativo/);
});

test("un peso imposible se detiene en la celda y no llega al servidor", () => {
  assert.equal(parseAnimalCell(JUNIO, "312,54", WEIGHINGS_CONTEXT).value, 312.5);
  assert.match(parseAnimalCell(JUNIO, "0", WEIGHINGS_CONTEXT).error, /mayor que cero/);
  assert.match(parseAnimalCell(JUNIO, "5000", WEIGHINGS_CONTEXT).error, /error de tipeo/);
});

test("cada celda del animal se puede volver a leer desde su propio texto", () => {
  const source = animal();
  const row = buildAnimalSpreadsheetRow(source, CONTEXT);
  for (const column of ANIMAL_SPREADSHEET_COLUMNS) {
    const parsed = parseAnimalCell(column.key, row.cells[column.key], CONTEXT);
    assert.equal(parsed.error, null, `${column.key} no se pudo re-interpretar`);
    assert.equal(
      formatAnimalCell(column.key, { ...source, [column.key]: parsed.value }, CONTEXT),
      row.cells[column.key],
      `${column.key} no sobrevive la ida y vuelta`,
    );
  }
});

test("hay una columna por fecha de pesaje, de la más reciente a la más antigua", () => {
  const columns = animalSpreadsheetColumns(WEIGHINGS_CONTEXT);
  const pesajes = columns.filter((column) => column.kind === "weighing");

  assert.deepEqual(pesajes.map((column) => column.recordedAt), ["2026-07-15", "2026-06-01", "2026-03-01"]);
  assert.deepEqual(pesajes.map((column) => column.label), ["15/07/2026", "01/06/2026", "01/03/2026"]);
  // Van después de Nacimiento: primero quién es el animal, después cuánto pesó.
  assert.equal(columns[columns.indexOf(pesajes[0]) - 1].key, "birthDate");
  assert.equal(weighingColumnDate(pesajes[0].key), "2026-07-15");
  assert.equal(weighingColumnDate("origin"), null);
});

test("sin fechas de pesaje la planilla queda con sus columnas fijas", () => {
  assert.deepEqual(animalSpreadsheetColumns(CONTEXT), ANIMAL_SPREADSHEET_COLUMNS);
  assert.equal(ANIMAL_SPREADSHEET_COLUMNS.some((column) => column.kind === "weighing"), false);
});

test("cada celda de pesaje muestra el peso de su propio día", () => {
  const row = buildAnimalSpreadsheetRow(animal(), WEIGHINGS_CONTEXT);

  assert.equal(row.cells[MARZO], "280");
  assert.equal(row.cells[JUNIO], "300");
  assert.equal(row.cells[JULIO], "");
});

test("sin historia en el contexto, la celda del último pesaje igual muestra el peso vigente", () => {
  const contexto = { ...CONTEXT, weighingDates: ["2026-06-01"] };
  const row = buildAnimalSpreadsheetRow(animal(), contexto);

  assert.equal(row.cells[JUNIO], "300");
});

test("planifica solo las celdas que realmente cambian", () => {
  const animals = [animal(), animal({ id: "animal-2", tag: "0124", snapshotToken: "token-2" })];
  const plan = planAnimalSpreadsheet({
    animals,
    edits: {
      "animal-1": { [JULIO]: "312,5", origin: "Feria Osorno" },
      "animal-2": { lotId: "Recría" },
    },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.changedRowCount, 2);
  assert.equal(plan.changedCellCount, 2);
  assert.deepEqual(plan.changes[0].fields.map((field) => field.key), [JULIO]);
  assert.equal(plan.changes[0].animal.latestWeightKg, 312.5);
  assert.equal(plan.changes[1].animal.lotId, "lot-recria");
});

test("una celda ilegible bloquea la confirmación y apunta a su columna", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [JULIO]: "trescientos" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].key, JULIO);
  assert.equal(plan.errors[0].text, "trescientos");
});

test("un estado distinto de activo exige la fecha del cambio", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { status: "Fallecido" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.equal(plan.errors[0].key, "statusDate");
});

test("cerrar una venta no se hace desde la planilla", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { status: "Vendido", statusDate: "17/07/2026" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.match(plan.errors[0].message, /ficha del animal/);
});

test("el peso final de una venta se corrige desde la ficha y nunca se confirma en falso", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal({
      status: "sold",
      statusDate: "2026-06-01",
      salePriceClp: 450000,
      saleBuyer: "Feria Osorno",
      saleWeightKg: 300,
    })],
    edits: { "animal-1": { [JUNIO]: "305" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.errors[0].key, JUNIO);
  assert.match(plan.errors[0].message, /ficha del animal/);
});

test("reabrir una venta y tocar su pesaje en la misma fila tampoco evade la ficha", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal({
      status: "sold",
      statusDate: "2026-06-01",
      salePriceClp: 450000,
      saleBuyer: "Feria Osorno",
      saleWeightKg: 300,
    })],
    edits: { "animal-1": { status: "Activo", [JUNIO]: "305" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.equal(plan.changes.length, 0);
  assert.ok(plan.errors.some((error) => error.key === "status" && /ficha del animal/.test(error.message)));
  assert.ok(plan.errors.some((error) => error.key === JUNIO && /ficha del animal/.test(error.message)));
});

test("una fecha que sólo sobrevive en el borrador sigue formando parte de la planilla", () => {
  const edits = {
    "animal-2": {
      [weighingColumnKey("2026-02-15")]: "275",
      notes: "pendiente",
      "pesaje:no-es-fecha": "300",
    },
  };

  assert.deepEqual(weighingDatesFromEdits(edits), ["2026-02-15"]);
});

test("una fila puede cargar varios pesajes de una vez y el más nuevo queda vigente", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [JULIO]: "320", [JUNIO]: "305" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.changedCellCount, 2);
  assert.deepEqual(plan.changes[0].animal.weighings, [
    { recordedAt: "2026-06-01", weightKg: 305 },
    { recordedAt: "2026-07-15", weightKg: 320 },
  ]);
  assert.equal(plan.changes[0].animal.latestWeightKg, 320);
  assert.equal(plan.changes[0].animal.latestWeightDate, "2026-07-15");
});

test("solo viajan los días que se tocaron: la planilla no reemplaza la historia", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [JULIO]: "320" } },
    context: WEIGHINGS_CONTEXT,
  });

  // Marzo y junio siguen guardados y no se mencionan: una lista completa borraría lo que
  // la pantalla no alcanzó a mostrar.
  assert.deepEqual(plan.changes[0].animal.weighings, [{ recordedAt: "2026-07-15", weightKg: 320 }]);
});

test("vaciar la celda de un pesaje lo borra y devuelve el peso vigente al anterior", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [JUNIO]: "" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.changes[0].animal.weighings, [{ recordedAt: "2026-06-01", weightKg: null }]);
  assert.equal(plan.changes[0].animal.latestWeightKg, 280);
  assert.equal(plan.changes[0].animal.latestWeightDate, "2026-03-01");
  assert.match(plan.warnings[0].message, /borra el pesaje del 01\/06\/2026/);
});

test("avisa que un pesaje con fecha anterior no cambia el peso vigente", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [MARZO]: "270" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.warnings.length, 1);
  assert.match(plan.warnings[0].message, /seguirá siendo el del 01\/06\/2026/);
  assert.equal(plan.changes[0].animal.latestWeightKg, 300);
  assert.equal(plan.changes[0].animal.latestWeightDate, "2026-06-01");
});

test("el primer pesaje de un animal sin historia queda como su peso vigente", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal({ latestWeightKg: null, latestWeightDate: null })],
    edits: { "animal-1": { [JULIO]: "310" } },
    context: { ...WEIGHINGS_CONTEXT, weighingsByAnimal: {} },
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.warnings.length, 0);
  assert.equal(plan.changes[0].animal.latestWeightKg, 310);
  assert.equal(plan.changes[0].animal.latestWeightDate, "2026-07-15");
});

test("avisa que cambiar el DIIO puede necesitar la ficha", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { tag: "0999" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.match(plan.warnings[0].message, /historia de números/);
});

test("escribir el mismo valor que ya estaba guardado no es un cambio", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [JUNIO]: "300", origin: "Feria Osorno" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.changedCellCount, 0);
  assert.equal(plan.changes.length, 0);
});

test("vaciar una celda de pesaje que ya estaba vacía no borra nada", () => {
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { [JULIO]: "" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.changedCellCount, 0);
  assert.equal(plan.changes.length, 0);
});

test("el borrador se queda solo con lo que sigue sin guardarse", () => {
  const edits = { "animal-1": { origin: "Feria Temuco" }, "animal-2": { origin: "Feria Osorno" } };
  assert.deepEqual(pruneSpreadsheetDraft(edits, ["animal-1"]), { "animal-2": { origin: "Feria Osorno" } });
  assert.deepEqual(pruneSpreadsheetDraft(edits, []), edits);
});

test("el borrador suelta la celda cuyo valor ya coincide con lo guardado", () => {
  const animals = [animal({ origin: "Feria Temuco" })];
  const compacted = compactSpreadsheetDraft(
    { "animal-1": { origin: "Feria Temuco", notes: "revisar" } },
    animals,
    CONTEXT,
  );

  assert.deepEqual(compacted, { "animal-1": { notes: "revisar" } });
});

test("el borrador de un animal que ya no está en la planilla se descarta", () => {
  assert.deepEqual(compactSpreadsheetDraft({ "animal-fantasma": { notes: "x" } }, [animal()], CONTEXT), {});
});

test("una fila agregada y nunca llenada se ignora sola", () => {
  const nueva = createAnimalDraftRow("nuevo-1", "lot-engorda");
  const plan = planAnimalSpreadsheet({ animals: [animal(), nueva], edits: {}, context: CONTEXT });

  assert.equal(plan.blocked, false);
  assert.equal(plan.changes.length, 0);
  assert.equal(plan.createdRowCount, 0);
});

test("una fila agregada y llenada se planifica como alta", () => {
  const nueva = createAnimalDraftRow("nuevo-1", "lot-engorda");
  const plan = planAnimalSpreadsheet({
    animals: [animal(), nueva],
    edits: { "nuevo-1": { tag: "0500", sex: "Macho", origin: "Feria Temuco" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.createdRowCount, 1);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].created, true);
  assert.equal(plan.changes[0].tag, "0500");
  assert.equal(plan.changes[0].animal.lotId, "lot-engorda");
  assert.equal(plan.changes[0].animal.sex, "male");
  assert.equal(plan.changes[0].animal.status, "active");
  assert.equal(plan.changes[0].animal.snapshotToken, undefined);
});

test("un animal nuevo puede nacer con su primer pesaje en la misma fila", () => {
  const plan = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-engorda")],
    edits: { "nuevo-1": { tag: "0500", [JULIO]: "245" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.createdRowCount, 1);
  assert.deepEqual(plan.changes[0].animal.weighings, [{ recordedAt: "2026-07-15", weightKg: 245 }]);
  assert.equal(plan.changes[0].animal.latestWeightKg, 245);
});

test("una fila nueva con solo un pesaje escrito ya no es un renglón de sobra", () => {
  const plan = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-engorda")],
    edits: { "nuevo-1": { [JULIO]: "245" } },
    context: WEIGHINGS_CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.errors.map((error) => error.key), ["tag"]);
});

test("una fila nueva a medio llenar exige DIIO y lote", () => {
  const sinDiio = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-engorda")],
    edits: { "nuevo-1": { origin: "Feria Temuco" } },
    context: CONTEXT,
  });
  assert.equal(sinDiio.blocked, true);
  assert.deepEqual(sinDiio.errors.map((error) => error.key), ["tag"]);

  const sinLote = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "")],
    edits: { "nuevo-1": { tag: "0500" } },
    context: CONTEXT,
  });
  assert.equal(sinLote.blocked, true);
  assert.deepEqual(sinLote.errors.map((error) => error.key), ["lotId"]);
});

test("un DIIO repetido contra el rebaño guardado se detiene antes de confirmar", () => {
  const contexto = { ...CONTEXT, knownAnimals: [{ id: "animal-1", tag: "0123", lotId: "lot-engorda" }] };
  const plan = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-recria")],
    edits: { "nuevo-1": { tag: "0123" } },
    context: contexto,
  });

  assert.equal(plan.blocked, true);
  assert.match(plan.errors[0].message, /Ya hay un animal con ese DIIO/);
});

test("dos filas nuevas con el mismo DIIO chocan entre ellas", () => {
  const plan = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-engorda"), createAnimalDraftRow("nuevo-2", "lot-engorda")],
    edits: { "nuevo-1": { tag: "0500" }, "nuevo-2": { tag: "0500" } },
    context: CONTEXT,
  });

  assert.equal(plan.blocked, true);
  assert.equal(plan.errors.length, 1);
  assert.equal(plan.errors[0].animalId, "nuevo-2");
});

test("el mismo DIIO en otro fundo no es un choque", () => {
  const contexto = {
    ...CONTEXT,
    lots: [
      { id: "lot-engorda", name: "Engorda", trackingMode: "individual", fieldId: "fundo-a" },
      { id: "lot-recria", name: "Recría", trackingMode: "individual", fieldId: "fundo-b" },
    ],
    knownAnimals: [{ id: "animal-1", tag: "0123", lotId: "lot-engorda" }],
  };
  const plan = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-recria")],
    edits: { "nuevo-1": { tag: "0123" } },
    context: contexto,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.createdRowCount, 1);
});

test("un animal guardado que conserva su DIIO no choca consigo mismo", () => {
  const contexto = { ...CONTEXT, knownAnimals: [{ id: "animal-1", tag: "0123", lotId: "lot-engorda" }] };
  const plan = planAnimalSpreadsheet({
    animals: [animal()],
    edits: { "animal-1": { origin: "Feria Temuco" } },
    context: contexto,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.changes.length, 1);
});

test("una fila nueva no arrastra las advertencias de una fila guardada", () => {
  const plan = planAnimalSpreadsheet({
    animals: [createAnimalDraftRow("nuevo-1", "lot-engorda")],
    edits: { "nuevo-1": { tag: "0500" } },
    context: CONTEXT,
  });

  assert.deepEqual(plan.warnings, []);
});
