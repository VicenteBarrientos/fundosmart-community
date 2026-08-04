import { parseDbf } from "../../integraciones/cooprinsem/server/dbf-parser.mjs";
import {
  buildProjectionCandidate,
  resolveProjectionMatches,
} from "../../integraciones/cooprinsem/server/projection-rules.mjs";
import { normalizeDiio } from "../domain/traceability-rules.mjs";

const DIIO_FIELDS = ["DIIO", "NUMDIIO", "NUMERO_DIIO", "NRO_DIIO", "ARETE", "CODBARRA"];
const RFID_FIELDS = ["RFID", "RFID_ID", "EID"];

export function adaptCliexDbfForTraceability(input, options) {
  const parsed = parseDbf(input, { maxRows: options.maxRows });
  const fatalFileIssue = parsed.fileIssues.find((issue) => issue.severity === "error");
  if (fatalFileIssue) throw new TypeError(fatalFileIssue.message);

  const rows = parsed.records.map((record) => adaptRecord(record, options));
  return {
    rows,
    source: {
      filename: options.filename,
      declaredRows: parsed.recordCount,
      parsedRows: parsed.parsedRecordCount,
      activeRows: rows.filter((row) => !row.adapter_issue_code).length,
      skippedRows: rows.filter((row) => row.adapter_issue_code).length,
      warnings: parsed.fileIssues.filter((issue) => issue.severity === "warning").map((issue) => issue.message),
      parser: "cooprinsem-dbf",
    },
  };
}

function adaptRecord(record, options) {
  const values = record.normalizedRecord ?? {};
  const keyed = new Map(Object.entries(values).map(([key, value]) => [normalizeColumn(key), value]));
  const candidate = buildProjectionCandidate(values);
  const explicitAnimalId = textFrom(keyed, ["ANIMAL_ID", "ID_ANIMAL"]);
  const matches = explicitAnimalId && options.animalIds.has(explicitAnimalId)
    ? [explicitAnimalId]
    : resolveProjectionMatches(candidate.identifiers, options.animalIdsByIdentity).animalIds;
  const diio = firstValidDiio(keyed);
  const parserIssue = record.issues.find((issue) => issue.severity === "error");
  const adapterIssue = record.deleted
    ? { code: "CLIEX_DBF_ROW_DELETED", message: "La fila está marcada como eliminada en el DBF y no se importará." }
    : parserIssue
      ? { code: "CLIEX_DBF_ROW_INVALID", message: parserIssue.message }
      : !diio
        ? { code: "CLIEX_DBF_DIIO_REQUIRED", message: "La fila DBF no contiene un DIIO válido de nueve dígitos." }
        : matches.length === 0
          ? { code: "CLIEX_ANIMAL_NOT_RESOLVED", message: "Los identificadores Cooprinsem/Cliex no resuelven a un animal del fundo." }
          : matches.length > 1
            ? { code: "CLIEX_ANIMAL_AMBIGUOUS", message: "Los identificadores Cooprinsem/Cliex apuntan a más de un animal del fundo." }
            : null;

  return {
    fila: record.recordNumber,
    id_origen: `cliex:${safeToken(options.filename)}:${record.recordNumber}`,
    diio: diio || "",
    animal_id: matches.length === 1 ? matches[0] : "",
    tipo_dispositivo: deviceType(textFrom(keyed, ["TIPO_DISPOSITIVO", "TIPO_DIIO", "TIPOARETE"])),
    rfid: textFrom(keyed, RFID_FIELDS) || null,
    adapter_issue_code: adapterIssue?.code ?? null,
    adapter_issue_message: adapterIssue?.message ?? null,
  };
}

function firstValidDiio(keyed) {
  for (const field of DIIO_FIELDS) {
    const normalized = normalizeDiio(textFrom(keyed, [field]));
    if (/^\d{9}$/u.test(normalized)) return normalized;
  }
  return "";
}

function deviceType(value) {
  const normalized = normalizeColumn(value);
  if (normalized.includes("BOLO")) return "bolo_ruminal";
  if (normalized.includes("BOTON")) return "boton";
  return "arete";
}

function textFrom(keyed, names) {
  for (const name of names) {
    const value = keyed.get(normalizeColumn(name));
    if (value !== null && value !== undefined && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeColumn(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/gu, "").trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "_").replace(/^_|_$/gu, "");
}

function safeToken(value) {
  const token = normalizeColumn(value).toLowerCase().slice(0, 80);
  return token || "archivo-dbf";
}
