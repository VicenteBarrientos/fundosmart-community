import assert from "node:assert/strict";
import test from "node:test";

import { serializeCsv } from "../src/core/export/csv.mjs";

test("CSV portable usa BOM, punto y coma, CRLF y comillas deterministas", () => {
  const csv = serializeCsv(
    ["Fundo", "Litros", "Nota"],
    [["Los Robles", 1234.5, 'Línea "A"'], ["Sur", null, ""]],
  );

  assert.equal(
    csv,
    '\uFEFF"Fundo";"Litros";"Nota"\r\n"Los Robles";"1234.5";"Línea ""A"""\r\n"Sur";"";""',
  );
});

test("CSV neutraliza fórmulas de texto sin convertir números negativos en texto", () => {
  const csv = serializeCsv(["Valor"], [["=2+2"], ["  @SUM(A1:A2)"], ["-cmd"], [-42]]);
  const lines = csv.slice(1).split("\r\n");

  assert.equal(lines[1], '"\'=2+2"');
  assert.equal(lines[2], '"\'  @SUM(A1:A2)"');
  assert.equal(lines[3], '"\'-cmd"');
  assert.equal(lines[4], '"-42"');
});
