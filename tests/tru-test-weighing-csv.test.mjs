import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  parseTruTestSessionCsv,
  reconcileTruTestRows,
  TruTestCsvError,
} from "../src/modules/ganado/domain/tru-test-session-csv.mjs";

test("parses a Data Link CSV with preamble, BOM, VID, EID, date and quoted values", () => {
  const result = parseTruTestSessionCsv([
    "\uFEFFTru-Test Data Link export",
    "Farm,Los Robles",
    "Session,VID,EID,Date,Weight",
    'July,"DIIO-001","0982000000123456",2026-07-27,"325.4"',
    'July,"DIIO-002","0982000000123457",2026-07-27,"301"',
  ].join("\r\n"));

  assert.equal(result.delimiter, ",");
  assert.equal(result.headerRowNumber, 3);
  assert.deepEqual(result.detectedColumns, {
    identifiers: ["VID", "EID"],
    weight: "Weight",
    date: "Date",
  });
  assert.deepEqual(result.dates, ["2026-07-27"]);
  assert.deepEqual(result.rows.map((row) => ({
    identifiers: row.identifiers.map((identifier) => identifier.value),
    weightKg: row.weightKg,
    recordedAt: row.recordedAt,
  })), [
    { identifiers: ["DIIO-001", "0982000000123456"], weightKg: 325.4, recordedAt: "2026-07-27" },
    { identifiers: ["DIIO-002", "0982000000123457"], weightKg: 301, recordedAt: "2026-07-27" },
  ]);
});

test("parses semicolon-delimited Chilean exports with decimal comma and localized headers", () => {
  const result = parseTruTestSessionCsv([
    "DIIO;Fecha de pesaje;Peso (kg)",
    "123-456-789;27/07/2026;325,4",
    "987-654-321;27/07/2026;301,75",
  ].join("\n"));

  assert.equal(result.delimiter, ";");
  assert.deepEqual(result.dates, ["2026-07-27"]);
  assert.deepEqual(result.rows.map((row) => row.weightKg), [325.4, 301.75]);
  assert.equal(result.issues.length, 0);
});

test("keeps valid rows while reporting invalid weights and missing identifiers", () => {
  const result = parseTruTestSessionCsv([
    "VID,Weight",
    "A-1,250",
    ",300",
    "A-3,not-a-weight",
    "A-4,2501",
  ].join("\n"));

  assert.deepEqual(result.rows.map((row) => row.identifiers[0].value), ["A-1"]);
  assert.deepEqual(result.issues.map((issue) => issue.code), [
    "DATE_COLUMN_MISSING",
    "IDENTIFIER_MISSING",
    "WEIGHT_INVALID",
    "WEIGHT_INVALID",
  ]);
});

test("normalizes ISO, day-first and unambiguous month-first dates", () => {
  const result = parseTruTestSessionCsv([
    "VID,Weight,Date",
    "A-1,250,2026-07-27 10:30",
    "A-2,251,27/07/2026",
    "A-3,252,07/27/2026",
    "A-4,253,07/08/2026",
  ].join("\n"));

  assert.deepEqual(result.rows.map((row) => row.recordedAt), [
    "2026-07-27",
    "2026-07-27",
    "2026-07-27",
    "2026-08-07",
  ]);
  assert.equal(result.issues.filter((issue) => issue.code === "DATE_AMBIGUOUS").length, 1);
});

test("rejects malformed or unsupported CSV contracts with explicit codes", () => {
  assert.throws(
    () => parseTruTestSessionCsv("Name,Color\nA-1,red"),
    (cause) => cause instanceof TruTestCsvError && cause.code === "CSV_HEADERS_MISSING",
  );
  assert.throws(
    () => parseTruTestSessionCsv('VID,Weight\n"A-1,250'),
    (cause) => cause instanceof TruTestCsvError && cause.code === "CSV_UNTERMINATED_QUOTE",
  );
  assert.throws(
    () => parseTruTestSessionCsv(" \r\n "),
    (cause) => cause instanceof TruTestCsvError && cause.code === "CSV_EMPTY",
  );
});

test("reconciles formatted VID/EID values only against a unique animal", () => {
  const parsed = parseTruTestSessionCsv([
    "VID,EID,Weight,Date",
    "123456789,,310,2026-07-27",
    ",0982000000123456,320,2026-07-27",
    "UNKNOWN,,330,2026-07-27",
  ].join("\n"));
  const result = reconcileTruTestRows(parsed.rows, [
    { id: "animal-a", tag: "123-456-789" },
    { id: "animal-b", tag: "982000000123456" },
  ]);

  assert.deepEqual(result.matches.map((match) => [match.animalId, match.weightKg]), [
    ["animal-a", 310],
    ["animal-b", 320],
  ]);
  assert.deepEqual(result.issues.map((issue) => issue.code), ["ANIMAL_NOT_FOUND"]);
});

test("deduplicates identical rows and rejects conflicting values for one animal", () => {
  const duplicate = parseTruTestSessionCsv([
    "VID,Weight,Date",
    "A-1,300,2026-07-27",
    "A-1,300,2026-07-27",
  ].join("\n"));
  const duplicateResult = reconcileTruTestRows(duplicate.rows, [{ id: "animal-a", tag: "A-1" }]);
  assert.equal(duplicateResult.matches.length, 1);
  assert.equal(duplicateResult.issues[0].code, "DUPLICATE_ROW_IGNORED");

  const conflicting = parseTruTestSessionCsv([
    "VID,Weight,Date",
    "A-1,300,2026-07-27",
    "A-1,305,2026-07-27",
  ].join("\n"));
  const conflictingResult = reconcileTruTestRows(conflicting.rows, [{ id: "animal-a", tag: "A-1" }]);
  assert.equal(conflictingResult.matches.length, 0);
  assert.equal(conflictingResult.issues[0].code, "ANIMAL_WEIGHT_CONFLICT");
});

test("rejects an identifier that remains ambiguous inside the selected lot", () => {
  const parsed = parseTruTestSessionCsv("VID,Weight\nA-1,300");
  const result = reconcileTruTestRows(parsed.rows, [
    { id: "animal-a", tag: "A-1" },
    { id: "animal-b", tag: "A1" },
  ]);

  assert.equal(result.matches.length, 0);
  assert.equal(result.issues.at(-1).code, "ANIMAL_AMBIGUOUS");
});

test("the weighing UI requires preview application and reuses the existing save flow", async () => {
  const [section, importer] = await Promise.all([
    readFile(new URL("../src/modules/ganado/components/PesajesSection.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/modules/ganado/components/TruTestCsvImport.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(section, /<TruTestCsvImport/);
  assert.match(section, /setWeights\(\(current\) => \(\{ \.\.\.current, \.\.\.proposal\.weights \}\)\)/);
  assert.match(section, /Revísalos antes de guardar/);
  assert.match(importer, /nada se guarda automáticamente/i);
  assert.match(importer, /type="button"/);
  assert.match(importer, /parsed\.dates\.length > 1/);
});
