import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCooprinsemPreview,
  COOPRINSEM_SOURCE_TABLES,
  DbfParseError,
  parseDbf,
} from "../src/modules/integraciones/cooprinsem/server/dbf-parser.mjs";

const fields = [
  { name: "NUMPREDIO", type: "C", length: 8 },
  { name: "FCONTROL", type: "D", length: 8 },
  { name: "NUMVACA", type: "N", length: 8 },
  { name: "NOMBRE", type: "C", length: 12 },
  { name: "RP", type: "C", length: 10 },
  { name: "LECHE", type: "N", length: 8, decimals: 1 },
  { name: "CODBARRA", type: "C", length: 13 },
  { name: "LECHEPM", type: "N", length: 8, decimals: 2 },
  { name: "LECHEAM", type: "N", length: 8, decimals: 2 },
  { name: "LECHE3RA", type: "N", length: 8, decimals: 2 },
];

test("parses priority DBF values and classifies preview rows", () => {
  const bytes = buildDbf(fields, [
    {
      NUMPREDIO: "000123",
      FCONTROL: "20260717",
      NUMVACA: 12345,
      NOMBRE: "VACA-1",
      RP: "RP-1",
      LECHE: 10,
      CODBARRA: "7800000000001",
      LECHEPM: 4,
      LECHEAM: 6,
      LECHE3RA: 0,
    },
    {
      NUMPREDIO: "000123",
      FCONTROL: "20261340",
      NUMVACA: 12346,
      NOMBRE: "VACA-2",
      RP: "RP-2",
      LECHE: -1,
      CODBARRA: "7800000000002",
      LECHEPM: 0,
      LECHEAM: 0,
      LECHE3RA: 0,
    },
    {
      NUMPREDIO: "000123",
      FCONTROL: "20260717",
      NUMVACA: 12347,
      NOMBRE: "VACA-3",
      RP: "RP-3",
      LECHE: 8,
      CODBARRA: "7800000000003",
      LECHEPM: 4,
      LECHEAM: 4,
      LECHE3RA: 0,
      __deleted: true,
    },
  ]);

  const parsed = parseDbf(bytes);
  const preview = buildCooprinsemPreview(parsed, {
    sourceTable: COOPRINSEM_SOURCE_TABLES.preDetImp.name,
  });

  assert.equal(parsed.fields.length, fields.length);
  assert.equal(parsed.parsedRecordCount, 3);
  assert.equal(preview.rows[0].normalizedRecord.FCONTROL, "2026-07-17");
  assert.deepEqual(preview.rows.map((row) => row.status), ["valid", "error", "skipped"]);
  assert.deepEqual(preview.summary, {
    rowCount: 3,
    validRowCount: 1,
    warningRowCount: 0,
    errorRowCount: 1,
    skippedRowCount: 1,
    fileIssueCount: 0,
  });
  assert.ok(preview.rows[1].issues.some((entry) => entry.ruleCode === "DBF_DATE_INVALID"));
  assert.ok(preview.rows[1].issues.some((entry) => entry.ruleCode === "MILK_NEGATIVE"));
  assert.ok(preview.rows[2].issues.some((entry) => entry.ruleCode === "DBF_ROW_DELETED"));
});

test("requires an explicit effective date for _Traspasos.DBF", () => {
  const parsed = parseDbf(buildDbf(fields, []));
  const preview = buildCooprinsemPreview(parsed, {
    sourceTable: COOPRINSEM_SOURCE_TABLES.traspasos.name,
  });

  assert.equal(preview.rows[0].recordNumber, 0);
  assert.equal(preview.rows[0].status, "error");
  assert.ok(preview.rows[0].issues.some((entry) => entry.ruleCode === "EFFECTIVE_DATE_REQUIRED"));
});

test("validates the canonical laboratory DBF with explicit count units", () => {
  const laboratoryFields = [
    { name: "NUMPREDIO", type: "C", length: 8 },
    { name: "FECHA", type: "D", length: 8 },
    { name: "GRASA", type: "N", length: 6, decimals: 2 },
    { name: "PROTEINA", type: "N", length: 6, decimals: 2 },
    { name: "SOLIDOS", type: "N", length: 6, decimals: 2 },
    { name: "RCS", type: "N", length: 9 },
    { name: "UNIRCS", type: "C", length: 12 },
    { name: "UFC", type: "N", length: 9 },
    { name: "UNIUFC", type: "C", length: 12 },
  ];
  const parsed = parseDbf(buildDbf(laboratoryFields, [
    { NUMPREDIO: "000123", FECHA: "20260719", GRASA: 4.1, PROTEINA: 3.5, SOLIDOS: 12.8, RCS: 230000, UNIRCS: "CEL_ML", UFC: 14000, UNIUFC: "UFC_ML" },
    { NUMPREDIO: "000123", FECHA: "20260720", GRASA: 4, RCS: 230, UNIRCS: "DESCONOCIDA" },
  ]));
  const preview = buildCooprinsemPreview(parsed, { sourceTable: COOPRINSEM_SOURCE_TABLES.laboratory.name });

  assert.deepEqual(preview.rows.map((row) => row.status), ["valid", "error"]);
  assert.ok(preview.rows[1].issues.some((entry) => entry.ruleCode === "LAB_SAMPLE_INVALID"));
});

test("rejects truncated DBF headers", () => {
  assert.throws(
    () => parseDbf(new Uint8Array(16)),
    (error) => error instanceof DbfParseError && error.code === "DBF_HEADER_TRUNCATED",
  );
});

function buildDbf(fieldDefinitions, records) {
  const encoder = new TextEncoder();
  const headerLength = 32 + fieldDefinitions.length * 32 + 1;
  const recordLength = 1 + fieldDefinitions.reduce((total, field) => total + field.length, 0);
  const bytes = new Uint8Array(headerLength + recordLength * records.length + 1);
  const view = new DataView(bytes.buffer);

  bytes.fill(0x20);
  bytes[0] = 0x30;
  view.setUint32(4, records.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);

  fieldDefinitions.forEach((field, index) => {
    const offset = 32 + index * 32;
    bytes.fill(0, offset, offset + 32);
    bytes.set(encoder.encode(field.name).subarray(0, 11), offset);
    bytes[offset + 11] = field.type.charCodeAt(0);
    bytes[offset + 16] = field.length;
    bytes[offset + 17] = field.decimals ?? 0;
  });
  bytes[headerLength - 1] = 0x0d;

  records.forEach((record, recordIndex) => {
    const rowOffset = headerLength + recordIndex * recordLength;
    bytes[rowOffset] = record.__deleted ? 0x2a : 0x20;
    let fieldOffset = rowOffset + 1;
    for (const field of fieldDefinitions) {
      const value = formatValue(record[field.name], field);
      bytes.set(encoder.encode(value), fieldOffset);
      fieldOffset += field.length;
    }
  });
  bytes[bytes.length - 1] = 0x1a;
  return bytes;
}

function formatValue(value, field) {
  if (value === undefined || value === null) return "".padEnd(field.length, " ");
  if (field.type === "N" || field.type === "F") {
    const formatted = field.decimals ? Number(value).toFixed(field.decimals) : String(value);
    return formatted.padStart(field.length, " ").slice(-field.length);
  }
  return String(value).padEnd(field.length, " ").slice(0, field.length);
}
