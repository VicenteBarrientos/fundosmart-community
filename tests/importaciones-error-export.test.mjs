import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildImportValidationCsv,
  IMPORT_VALIDATION_CSV_HEADERS,
} from "../src/modules/importaciones/domain/import-audit-csv.mjs";

const root = process.cwd();
const ROW_STATUSES = [
  ["pending", "Pendiente"],
  ["valid", "Válida"],
  ["warning", "Aviso"],
  ["error", "Error"],
  ["imported", "Importada"],
  ["skipped", "Omitida"],
];

function row(status, recordNumber) {
  const hasIssue = status === "warning" || status === "error" || status === "skipped";
  return {
    id: `row-${recordNumber}`,
    recordNumber,
    status,
    rawRecord: recordNumber === 1
      ? { DIIO: "" }
      : { DIIO: `CL-${100 + recordNumber}` },
    normalizedRecord: null,
    issues: hasIssue
      ? [{
          severity: status === "error" ? "error" : "warning",
          ruleCode: `IMPORT_${status.toUpperCase()}`,
          message: `Detalle ${status}.`,
        }]
      : [],
  };
}

test("exports one validation row for every canonical import row status", () => {
  const preview = {
    fieldName: "Fundo Los Alerces",
    originalFilename: "control lechero julio.xlsx",
    rows: ROW_STATUSES.map(([status], index) => row(status, index + 1)),
  };

  const report = buildImportValidationCsv(preview);

  assert.deepEqual(report.headers, [...IMPORT_VALIDATION_CSV_HEADERS]);
  assert.equal(report.headers.length, 7);
  assert.equal(report.rows.length, preview.rows.length);
  assert.deepEqual(
    report.rows.map((entry) => entry[1]),
    ROW_STATUSES.map(([, label]) => label),
  );
  assert.equal(report.rows[0][3], "row-1");
  assert.equal(report.rows[3][4], "IMPORT_ERROR");
  assert.equal(report.rows[3][5], "ERROR: Detalle error.");
  assert.equal(report.rows[4][6], "Sin acción: la fila fue confirmada.");
  assert.equal(report.filename, "fundosmart-import-validacion-control_lechero_julio.csv");
});

test("builds a deterministic validation report without mislabeling imported rows", () => {
  const issues = [
    {
      severity: "warning",
      ruleCode: "PADDOCK_NOT_RECONCILED",
      message: "No se concilió el potrero.",
    },
    {
      severity: "error",
      ruleCode: "FIELD_REQUIRED",
      message: "Falta el identificador.",
    },
  ];
  const preview = {
    fieldName: "Fundo Ñuble",
    originalFilename: "medición pradera 2026.csv",
    rows: [
      {
        id: "row-imported",
        recordNumber: 1,
        status: "imported",
        rawRecord: { externalPaddockKey: "P-12" },
        normalizedRecord: { externalPaddockKey: "P-12" },
        issues: [],
      },
      {
        id: "row-skipped",
        recordNumber: 2,
        status: "skipped",
        rawRecord: {},
        normalizedRecord: null,
        issues,
      },
    ],
  };

  const first = buildImportValidationCsv(preview);
  const replay = buildImportValidationCsv({
    ...preview,
    rows: [
      preview.rows[0],
      { ...preview.rows[1], issues: [...issues].reverse() },
    ],
  });

  assert.deepEqual(replay, first);
  assert.equal(first.rows.length, 2);
  assert.equal(first.rows[0][1], "Importada");
  assert.notEqual(first.rows[0][1], "Omitida");
  assert.equal(first.rows[0][3], "P-12");
  assert.equal(first.rows[1][1], "Omitida");
  assert.match(String(first.rows[1][6]), /concilia la referencia/i);
  assert.equal(first.rows[1][4], "FIELD_REQUIRED | PADDOCK_NOT_RECONCILED");
  assert.equal(
    first.rows[1][5],
    "ERROR: Falta el identificador. | WARNING: No se concilió el potrero.",
  );
  assert.equal(first.filename, "fundosmart-import-validacion-medicion_pradera_2026.csv");
});

test("uses canonical references produced by the import profiles", () => {
  const report = buildImportValidationCsv({
    fieldName: "Fundo Productivo",
    originalFilename: "perfiles.xlsx",
    rows: [
      {
        id: "survet-row",
        recordNumber: 1,
        status: "valid",
        rawRecord: { animalIdentifier: "raw-animal" },
        normalizedRecord: { externalAnimalId: "DIIO-900" },
        issues: [],
      },
      {
        id: "generic-row",
        recordNumber: 2,
        status: "valid",
        rawRecord: { "Nombre libre": "Potrero 7" },
        normalizedRecord: { externalPaddockKey: "P-07" },
        issues: [],
      },
      {
        id: "soil-row",
        recordNumber: 3,
        status: "valid",
        rawRecord: { analyteName: "Fósforo" },
        normalizedRecord: { analyteCode: "phosphorus" },
        issues: [],
      },
    ],
  });

  assert.deepEqual(
    report.rows.map((entry) => entry[3]),
    ["DIIO-900", "P-07", "phosphorus"],
  );
});

test("keeps the validation snapshot separate and renders the returned durable receipt", {
  skip: process.env.FUNDOSMART_SOURCE_CONTRACTS !== "1",
}, async () => {
  const [page, route, types] = await Promise.all([
    readFile(path.join(root, "src", "modules", "importaciones", "ImportacionesPage.tsx"), "utf8"),
    readFile(path.join(root, "app", "api", "importaciones", "route.ts"), "utf8"),
    readFile(path.join(root, "src", "modules", "importaciones", "domain", "types.ts"), "utf8"),
  ]);

  assert.match(page, /Descargar informe de validaci/u);
  assert.match(page, /function showPreview[\s\S]+setConfirmationReceipt\(null\)/u);
  assert.match(page, /setConfirmationReceipt\(result\.confirmation\)/u);
  assert.match(page, /confirmationReceipt\?\.importJobId === preview\.id/u);
  assert.match(page, /Recibo durable de confirmaci/u);
  assert.match(page, /aria-live="polite"[\s\S]+role="status"/u);
  assert.match(page, /Ver resultado fila por fila/u);
  assert.match(page, /receipt\.reused \? "Replay" : "Original"/u);

  assert.match(
    route,
    /const confirmation = await confirmImportVisit[\s\S]+try \{[\s\S]+getImportCenterPreview[\s\S]+getImportCenterDashboard[\s\S]+catch \(cause\)[\s\S]+throw confirmationReceiptIntegrityError\(\)/u,
  );
  assert.match(types, /receiptVersion: "fundosmart\.import-confirmation-receipt\.v1"/u);
  assert.match(types, /insertedRowCount: number/u);
  assert.match(types, /updatedRowCount: number/u);
  assert.match(types, /unchangedRowCount: number/u);
  assert.match(types, /conflictRowCount: number/u);
  assert.match(types, /rejectedRowCount: number/u);
  assert.match(types, /rowOutcomes: ImportConfirmationRowOutcome\[\]/u);
});
