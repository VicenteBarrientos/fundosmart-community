import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  compareTableSortValues,
  detectTableSortKind,
  parseTableDate,
  parseTableNumber,
  tableSortValueIsMissing,
} from "../src/ui/table-explorer.mjs";

const root = process.cwd();

test("interpreta fechas cronológicas y números chilenos sin ordenar por el texto formateado", () => {
  assert.equal(parseTableDate("15 jul 2026"), Date.UTC(2026, 6, 15));
  assert.equal(parseTableDate("2025-12"), Date.UTC(2025, 11, 1));
  assert.equal(parseTableDate("31/01/26"), Date.UTC(2026, 0, 31));
  assert.equal(parseTableDate("31 feb 2026"), null);
  assert.equal(parseTableDate("Sin fecha"), null);

  assert.equal(parseTableNumber("$316.838"), 316838);
  assert.equal(parseTableNumber("$1.234.567,89"), 1234567.89);
  assert.equal(parseTableNumber("12,5 kg MS"), 12.5);
  assert.equal(parseTableNumber("-3,25 %"), -3.25);
  assert.equal(parseTableNumber("No disponible"), null);
});

test("detecta el tipo de cada columna a partir del encabezado y sus valores", () => {
  assert.equal(detectTableSortKind("Fecha", ["15 jul 2026", "10 jul 2026", "Sin fecha"]), "date");
  assert.equal(detectTableSortKind("Período", ["2025-12", "2026-01"]), "date");
  assert.equal(detectTableSortKind("Costo", ["$316.838", "$20.000", "No disponible"]), "number");
  assert.equal(detectTableSortKind("Peso", ["450 kg", "512,5 kg"]), "number");
  assert.equal(detectTableSortKind("Origen", ["Ganado", "Agrícola"]), "text");
  assert.equal(detectTableSortKind("Descripción", ["cooprinsem 20 kg", "semilla 5 kg"]), "text");
});

test("alterna ascendente y descendente sin sacar los valores ausentes del final", () => {
  assert.ok(compareTableSortValues("10 jul 2026", "15 jul 2026", "date", "ascending") < 0);
  assert.ok(compareTableSortValues("10 jul 2026", "15 jul 2026", "date", "descending") > 0);
  assert.ok(compareTableSortValues("$20.000", "$316.838", "number", "ascending") < 0);
  assert.ok(compareTableSortValues("Álamo 2", "alamo 10", "text", "ascending") < 0);
  assert.ok(compareTableSortValues("Álamo 2", "alamo 10", "text", "descending") > 0);

  for (const direction of ["ascending", "descending"]) {
    assert.ok(compareTableSortValues("Sin fecha", "10 jul 2026", "date", direction) > 0);
    assert.ok(compareTableSortValues("No disponible", "15 kg", "number", direction) > 0);
    assert.ok(compareTableSortValues("—", "Ganado", "text", direction) > 0);
  }

  assert.equal(tableSortValueIsMissing("Sin observación"), true);
  assert.equal(tableSortValueIsMissing("Ganado"), false);
});

test("el explorador común hace ordenables todos los encabezados de datos con ratón y teclado", () => {
  const component = readFileSync(join(root, "src/ui/TableExplorer.tsx"), "utf8");

  assert.match(component, /data-table-sort-disabled/u);
  assert.match(component, /tableSortIndicator/u);
  assert.match(component, /setAttribute\("aria-sort", sort\.direction\)/u);
  assert.match(component, /event\.key !== "Enter" && event\.key !== " "/u);
  assert.match(component, /compareTableSortValues/u);
  assert.match(component, /body\.appendChild\(row\)/u);
});
