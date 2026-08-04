import { mapCooprinsemMilkQualitySample } from "./milk-control-rules.mjs";

const TARGET_DBF_VERSIONS = new Set([0x03, 0x30]);
const MAX_DBF_FIELDS = 256;
const DEFAULT_MAX_ROWS = 5_000;

export const COOPRINSEM_SOURCE_TABLES = {
  traspasos: {
    name: "_Traspasos.DBF",
    requiresEffectiveDate: true,
    requiredFields: ["NUMVACA", "NOMBRE", "LECHEPM", "LECHEAM", "CODBARRA"],
  },
  preDetImp: {
    name: "PreDetimp.dbf",
    requiresEffectiveDate: false,
    requiredFields: [
      "NUMPREDIO",
      "FCONTROL",
      "NUMVACA",
      "NOMBRE",
      "RP",
      "LECHE",
      "CODBARRA",
      "LECHEPM",
      "LECHEAM",
      "LECHE3RA",
    ],
  },
  laboratory: {
    name: "CalidadLeche.dbf",
    requiresEffectiveDate: false,
    requiredFields: ["NUMPREDIO"],
  },
};

export class DbfParseError extends Error {
  constructor(message, code = "DBF_INVALID") {
    super(message);
    this.name = "DbfParseError";
    this.code = code;
  }
}

export function parseDbf(input, options = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxRows = options.maxRows ?? DEFAULT_MAX_ROWS;
  if (bytes.byteLength < 32) throw new DbfParseError("El archivo DBF no contiene una cabecera completa.", "DBF_HEADER_TRUNCATED");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  const recordCount = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);

  if (headerLength < 33 || headerLength > bytes.byteLength) {
    throw new DbfParseError("El largo de cabecera declarado por el DBF no es válido.", "DBF_HEADER_LENGTH_INVALID");
  }
  if (recordLength < 2) {
    throw new DbfParseError("El largo de registro declarado por el DBF no es válido.", "DBF_RECORD_LENGTH_INVALID");
  }
  if (recordCount > maxRows) {
    throw new DbfParseError(`El archivo declara ${recordCount} registros y el máximo de vista previa es ${maxRows}.`, "DBF_ROW_LIMIT");
  }

  const decoder = createLegacyDecoder();
  const fields = [];
  let descriptorOffset = 32;
  let dataOffset = 1;
  while (descriptorOffset < headerLength && bytes[descriptorOffset] !== 0x0d) {
    if (descriptorOffset + 32 > headerLength || fields.length >= MAX_DBF_FIELDS) {
      throw new DbfParseError("La lista de campos DBF está dañada o excede el máximo permitido.", "DBF_FIELDS_INVALID");
    }

    const descriptor = bytes.subarray(descriptorOffset, descriptorOffset + 32);
    const zeroIndex = descriptor.subarray(0, 11).indexOf(0);
    const nameBytes = descriptor.subarray(0, zeroIndex >= 0 ? zeroIndex : 11);
    const name = decodeBytes(decoder, nameBytes).trim();
    const type = String.fromCharCode(descriptor[11]);
    const length = descriptor[16];
    const decimals = descriptor[17];
    if (!name || length === 0) {
      throw new DbfParseError("El DBF contiene una definición de campo vacía.", "DBF_FIELD_INVALID");
    }

    fields.push({ name, type, length, decimals, offset: dataOffset });
    dataOffset += length;
    descriptorOffset += 32;
  }

  if (fields.length === 0 || dataOffset > recordLength) {
    throw new DbfParseError("Los campos declarados no caben en el largo de registro DBF.", "DBF_LAYOUT_INVALID");
  }

  const availableRecords = Math.max(0, Math.floor((bytes.byteLength - headerLength) / recordLength));
  const parsedRecordCount = Math.min(recordCount, availableRecords);
  const fileIssues = [];
  if (!TARGET_DBF_VERSIONS.has(version)) {
    fileIssues.push(issue(null, "DBF_VERSION_UNTESTED", "warning", `La versión DBF 0x${version.toString(16).padStart(2, "0")} no está validada para este importador.`, version));
  }
  if (parsedRecordCount !== recordCount) {
    fileIssues.push(issue(null, "DBF_RECORDS_TRUNCATED", "error", `El archivo declara ${recordCount} registros, pero solo contiene ${availableRecords} completos.`, recordCount));
  }

  const records = [];
  for (let index = 0; index < parsedRecordCount; index += 1) {
    const start = headerLength + index * recordLength;
    const deleted = bytes[start] === 0x2a;
    const rawRecord = {};
    const normalizedRecord = {};
    const recordIssues = [];

    for (const field of fields) {
      const from = start + field.offset;
      const to = from + field.length;
      const raw = decodeBytes(decoder, bytes.subarray(from, to)).replaceAll("\0", "").trimEnd();
      rawRecord[field.name] = raw;
      const normalized = normalizeField(field, raw);
      normalizedRecord[field.name] = normalized.value;
      if (normalized.problem) {
        recordIssues.push(issue(field.name, normalized.problem.code, "error", normalized.problem.message, raw));
      }
    }

    records.push({
      recordNumber: index + 1,
      deleted,
      rawRecord,
      normalizedRecord,
      issues: recordIssues,
    });
  }

  return {
    version,
    recordCount,
    parsedRecordCount,
    headerLength,
    recordLength,
    fields,
    records,
    fileIssues,
  };
}

export function buildCooprinsemPreview(parsed, options) {
  const tableRule = Object.values(COOPRINSEM_SOURCE_TABLES).find((entry) => entry.name === options.sourceTable);
  if (!tableRule) throw new DbfParseError("La tabla Cooprinsem seleccionada no está soportada.", "SOURCE_TABLE_UNSUPPORTED");

  const fieldNames = new Set(parsed.fields.map((field) => field.name.toUpperCase()));
  const fileIssues = [...parsed.fileIssues];
  for (const requiredField of tableRule.requiredFields) {
    if (!fieldNames.has(requiredField)) {
      fileIssues.push(issue(requiredField, "DBF_REQUIRED_FIELD_MISSING", "error", `Falta el campo obligatorio ${requiredField} para ${tableRule.name}.`, null));
    }
  }
  if (tableRule.requiresEffectiveDate && !isIsoDate(options.effectiveAt)) {
    fileIssues.push(issue(null, "EFFECTIVE_DATE_REQUIRED", "error", "_Traspasos.DBF necesita una fecha efectiva de control indicada por el usuario.", options.effectiveAt ?? null));
  }

  const rows = [];
  if (fileIssues.length > 0) {
    rows.push({
      recordNumber: 0,
      rawRecord: {
        version: `0x${parsed.version.toString(16).padStart(2, "0")}`,
        declaredRecordCount: parsed.recordCount,
        parsedRecordCount: parsed.parsedRecordCount,
        fields: parsed.fields.map((field) => field.name),
      },
      normalizedRecord: null,
      status: fileIssues.some((entry) => entry.severity === "error") ? "error" : "warning",
      issues: fileIssues,
    });
  }

  for (const record of parsed.records) {
    const issues = [...record.issues];
    const values = record.normalizedRecord;
    if (record.deleted) {
      issues.push(issue(null, "DBF_ROW_DELETED", "warning", "El registro está marcado como eliminado en el DBF y no se proyectará.", true));
    }

    const isLaboratory = tableRule.name === COOPRINSEM_SOURCE_TABLES.laboratory.name;
    const identifiers = [values.NUMVACA, values.NOMBRE, values.RP, values.CODBARRA]
      .filter((value) => value !== null && value !== undefined && String(value).trim() !== "");
    if (!isLaboratory && identifiers.length === 0) {
      issues.push(issue("NUMVACA", "ANIMAL_IDENTIFIER_REQUIRED", "error", "La fila no contiene NUMVACA, NOMBRE, RP ni código de barras.", null));
    }

    if (tableRule.name === COOPRINSEM_SOURCE_TABLES.preDetImp.name) {
      if (!nonEmpty(values.NUMPREDIO)) {
        issues.push(issue("NUMPREDIO", "FIELD_IDENTIFIER_REQUIRED", "error", "La fila no identifica el predio Cooprinsem.", values.NUMPREDIO ?? null));
      }
      if (!isIsoDate(values.FCONTROL)) {
        issues.push(issue("FCONTROL", "CONTROL_DATE_REQUIRED", "error", "La fecha de control no es válida.", values.FCONTROL ?? null));
      }
    }

    if (isLaboratory) {
      if (!nonEmpty(values.NUMPREDIO)) {
        issues.push(issue("NUMPREDIO", "FIELD_IDENTIFIER_REQUIRED", "error", "La muestra no identifica el predio Cooprinsem.", values.NUMPREDIO ?? null));
      }
      const mapped = mapCooprinsemMilkQualitySample(values);
      for (const message of mapped.issues) {
        issues.push(issue(null, "LAB_SAMPLE_INVALID", "error", message, values));
      }
    }

    for (const fieldName of ["LECHE", "LECHEAM", "LECHEPM", "LECHE3RA"]) {
      const value = values[fieldName];
      if (typeof value === "number" && value < 0) {
        issues.push(issue(fieldName, "MILK_NEGATIVE", "error", `${fieldName} no puede ser negativo.`, value));
      }
    }
    for (const fieldName of ["MGX100", "PTX100"]) {
      const value = values[fieldName];
      if (typeof value === "number" && (value < 0 || value > 100)) {
        issues.push(issue(fieldName, "PERCENT_OUT_OF_RANGE", "error", `${fieldName} debe estar entre 0 y 100.`, value));
      }
    }

    const total = values.LECHE;
    const milkings = [values.LECHEAM, values.LECHEPM, values.LECHE3RA].filter((value) => typeof value === "number");
    if (typeof total === "number" && milkings.length > 0) {
      const measured = milkings.reduce((sum, value) => sum + value, 0);
      if (Math.abs(total - measured) > 0.2) {
        issues.push(issue("LECHE", "MILK_TOTAL_MISMATCH", "warning", "El total de leche no coincide con la suma de las ordeñas.", { total, measured }));
      }
    }

    const status = record.deleted
      ? "skipped"
      : issues.some((entry) => entry.severity === "error")
        ? "error"
        : issues.length > 0
          ? "warning"
          : "valid";
    rows.push({
      recordNumber: record.recordNumber,
      rawRecord: record.rawRecord,
      normalizedRecord: record.normalizedRecord,
      status,
      issues,
    });
  }

  return {
    sourceTable: tableRule.name,
    effectiveAt: options.effectiveAt ?? null,
    rows,
    summary: summarizeRows(rows),
  };
}

function normalizeField(field, raw) {
  const value = raw.trim();
  if (value === "") return { value: null };

  if (field.type === "N" || field.type === "F") {
    const number = Number(value.replace(",", "."));
    if (!Number.isFinite(number)) {
      return { value, problem: { code: "DBF_NUMBER_INVALID", message: `${field.name} no contiene un número válido.` } };
    }
    return { value: number };
  }
  if (field.type === "D") {
    const date = parseDbfDate(value);
    if (!date) return { value, problem: { code: "DBF_DATE_INVALID", message: `${field.name} no contiene una fecha DBF válida.` } };
    return { value: date };
  }
  if (field.type === "L") {
    if (["Y", "T", "1"].includes(value.toUpperCase())) return { value: true };
    if (["N", "F", "0"].includes(value.toUpperCase())) return { value: false };
    if (value === "?") return { value: null };
    return { value, problem: { code: "DBF_LOGICAL_INVALID", message: `${field.name} no contiene un valor lógico válido.` } };
  }
  return { value };
}

function parseDbfDate(value) {
  if (!/^\d{8}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return parseDbfDate(value.replaceAll("-", "")) === value;
}

function nonEmpty(value) {
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function summarizeRows(rows) {
  const dataRows = rows.filter((row) => row.recordNumber > 0);
  return {
    rowCount: dataRows.length,
    validRowCount: dataRows.filter((row) => row.status === "valid").length,
    warningRowCount: dataRows.filter((row) => row.status === "warning").length,
    errorRowCount: dataRows.filter((row) => row.status === "error").length,
    skippedRowCount: dataRows.filter((row) => row.status === "skipped").length,
    fileIssueCount: rows.find((row) => row.recordNumber === 0)?.issues.length ?? 0,
  };
}

function issue(fieldName, ruleCode, severity, message, sourceValue) {
  return { fieldName, ruleCode, severity, message, sourceValue };
}

function createLegacyDecoder() {
  try {
    return new TextDecoder("windows-1252");
  } catch {
    return new TextDecoder("utf-8");
  }
}

function decodeBytes(decoder, bytes) {
  return decoder.decode(bytes);
}
