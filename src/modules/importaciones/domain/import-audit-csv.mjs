const STATUS_PRESENTATION = Object.freeze({
  pending: Object.freeze({
    label: "Pendiente",
    action: "Espera a que termine el análisis antes de confirmar.",
  }),
  valid: Object.freeze({
    label: "Válida",
    action: "Sin acción: la fila está lista para confirmar.",
  }),
  warning: Object.freeze({
    label: "Aviso",
    action: "Revisa los avisos antes de confirmar.",
  }),
  error: Object.freeze({
    label: "Error",
    action: "Corrige la fila según las reglas indicadas y vuelve a cargar o mapear el archivo.",
  }),
  imported: Object.freeze({
    label: "Importada",
    action: "Sin acción: la fila fue confirmada.",
  }),
  skipped: Object.freeze({
    label: "Omitida",
    action: "Corrige o concilia la referencia y vuelve a cargar un archivo nuevo si deseas incorporarla.",
  }),
});

const UNKNOWN_STATUS_PRESENTATION = Object.freeze({
  label: "No reconocida",
  action: "Vuelve a abrir la importación y contacta a soporte si el estado persiste.",
});

export const IMPORT_VALIDATION_CSV_HEADERS = Object.freeze([
  "Fila",
  "Estado",
  "Fundo",
  "Referencia",
  "Códigos de regla",
  "Mensajes y errores",
  "Acción sugerida",
]);

export function buildImportValidationCsv(preview) {
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];
  return {
    filename: `fundosmart-import-validacion-${safeFilenameStem(preview?.originalFilename)}.csv`,
    headers: [...IMPORT_VALIDATION_CSV_HEADERS],
    rows: rows.map((row) => validationRow(preview, row)),
  };
}

function validationRow(preview, row) {
  const issues = Array.isArray(row?.issues)
    ? [...row.issues].sort(compareIssues)
    : [];
  const presentation = typeof row?.status === "string"
    && Object.hasOwn(STATUS_PRESENTATION, row.status)
    ? STATUS_PRESENTATION[row.status]
    : UNKNOWN_STATUS_PRESENTATION;
  const ruleCodes = [...new Set(issues
    .map((issue) => normalizedText(issue?.ruleCode))
    .filter(Boolean))];

  return [
    Number.isSafeInteger(row?.recordNumber) ? row.recordNumber : "",
    presentation.label,
    normalizedText(preview?.fieldName) || "Fundo no disponible",
    rowReference(row),
    ruleCodes.join(" | ") || "Sin regla",
    issues
      .map((issue) => issueMessage(issue))
      .filter(Boolean)
      .join(" | ") || "Sin observaciones",
    presentation.action,
  ];
}

function issueMessage(issue) {
  const message = normalizedText(issue?.message);
  if (!message) return "";
  const severity = normalizedText(issue?.severity).toLocaleUpperCase("es-CL");
  return severity ? `${severity}: ${message}` : message;
}

function compareIssues(left, right) {
  const leftKey = issueSortKey(left);
  const rightKey = issueSortKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function issueSortKey(issue) {
  return [
    normalizedText(issue?.ruleCode),
    normalizedText(issue?.severity),
    normalizedText(issue?.message),
  ].join("\u0000");
}

function rowReference(row) {
  const normalizedRecord = row?.normalizedRecord && typeof row.normalizedRecord === "object"
    ? row.normalizedRecord
    : {};
  const rawRecord = row?.rawRecord && typeof row.rawRecord === "object"
    ? row.rawRecord
    : {};
  const candidates = [
    normalizedRecord.externalPaddockKey,
    normalizedRecord.externalAnimalId,
    normalizedRecord.animalTag,
    normalizedRecord.analyteCode,
    normalizedRecord.sampleNumber,
    rawRecord.externalPaddockKey,
    rawRecord.animalIdentifier,
    rawRecord.DIIO,
    rawRecord.paddockName,
    rawRecord.analyteName,
    rawRecord.sampleNumber,
  ];
  for (const candidate of candidates) {
    const value = normalizedText(candidate);
    if (value) return value;
  }
  return normalizedText(row?.id) || "Sin referencia";
}

function safeFilenameStem(filename) {
  const raw = normalizedText(filename) || "archivo";
  const stem = raw.replace(/\.[^./\\]+$/, "");
  const safe = stem
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return safe || "archivo";
}

function normalizedText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}
