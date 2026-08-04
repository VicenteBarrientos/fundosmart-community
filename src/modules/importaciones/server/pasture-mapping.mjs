import { parseLocaleNumber } from "./watts-visit-parser.mjs";

export class PastureMappingError extends Error {
  constructor(message, code = "PASTURE_MAPPING_INVALID") {
    super(message);
    this.name = "PastureMappingError";
    this.code = code;
  }
}

export function validatePastureMapping(headers, input) {
  const available = new Set(headers);
  const mapping = {
    externalPaddockKey: text(input?.externalPaddockKey),
    biomassKgDmHa: text(input?.biomassKgDmHa),
    observedDate: optionalText(input?.observedDate),
    areaHa: optionalText(input?.areaHa),
    notes: optionalText(input?.notes),
  };
  if (!mapping.externalPaddockKey || !mapping.biomassKgDmHa) {
    throw new PastureMappingError("Selecciona las columnas de potrero y biomasa.", "PASTURE_MAPPING_REQUIRED");
  }
  for (const [key, column] of Object.entries(mapping)) {
    if (column && !available.has(column)) {
      throw new PastureMappingError(`La columna seleccionada para ${key} no existe en la planilla.`, "PASTURE_MAPPING_COLUMN_MISSING");
    }
  }
  const selected = Object.values(mapping).filter(Boolean);
  if (new Set(selected).size !== selected.length) {
    throw new PastureMappingError("Cada destino debe usar una columna distinta.", "PASTURE_MAPPING_DUPLICATE_COLUMN");
  }
  return mapping;
}

export function mapPastureRows(rows, mapping, defaultObservedDate) {
  return rows.map((row, index) => {
    const externalPaddockKey = text(row.rawRecord?.[mapping.externalPaddockKey]);
    const biomass = parseLocaleNumber(row.rawRecord?.[mapping.biomassKgDmHa]);
    const observedAt = parseDateValue(
      mapping.observedDate ? row.rawRecord?.[mapping.observedDate] : null,
      defaultObservedDate,
    );
    const area = mapping.areaHa ? parseLocaleNumber(row.rawRecord?.[mapping.areaHa]) : null;
    const notes = mapping.notes ? text(row.rawRecord?.[mapping.notes]) || null : null;
    const issues = [];

    if (!externalPaddockKey) {
      issues.push(issue("externalPaddockKey", "PADDOCK_KEY_REQUIRED", "error", "La fila no identifica el potrero externo.", row.rawRecord?.[mapping.externalPaddockKey]));
    }
    if (biomass === null || biomass < 0 || biomass > 20_000) {
      issues.push(issue("currentBiomassKgDmHa", "BIOMASS_INVALID", "error", "La biomasa debe ser un número entre 0 y 20.000 kg MS/ha.", row.rawRecord?.[mapping.biomassKgDmHa]));
    }
    if (!observedAt) {
      issues.push(issue("observedAt", "OBSERVED_DATE_REQUIRED", "error", "La fila necesita una fecha válida o una fecha general de medición.", mapping.observedDate ? row.rawRecord?.[mapping.observedDate] : defaultObservedDate));
    }
    if (mapping.areaHa && (area === null || area <= 0)) {
      issues.push(issue("areaHa", "AREA_INVALID", "warning", "La superficie no es válida y se conservará vacía.", row.rawRecord?.[mapping.areaHa]));
    }

    const errorCount = issues.filter((entry) => entry.severity === "error").length;
    const warningCount = issues.length - errorCount;
    return {
      recordNumber: row.recordNumber ?? index + 1,
      rawRecord: row.rawRecord,
      normalizedRecord: {
        externalPaddockKey: externalPaddockKey || null,
        paddockId: null,
        observedAt,
        plannedEntryDate: null,
        currentBiomassKgDmHa: biomass !== null && biomass >= 0 && biomass <= 20_000 ? biomass : null,
        projectedBiomassKgDmHa: null,
        areaHa: area !== null && area > 0 ? area : null,
        dailyAreaHa: null,
        calculatedDays: null,
        adjustedDays: null,
        adjustedIntakeKgDmCowDay: null,
        notes,
      },
      status: errorCount > 0 ? "error" : warningCount > 0 ? "warning" : "valid",
      warningCount,
      errorCount,
      issues,
    };
  });
}

export function mappingSummary(rows) {
  return {
    rowCount: rows.length,
    validRowCount: rows.filter((row) => row.status === "valid").length,
    warningRowCount: rows.filter((row) => row.status === "warning").length,
    errorRowCount: rows.filter((row) => row.status === "error").length,
    skippedRowCount: rows.filter((row) => row.status === "skipped").length,
    fileIssueCount: 0,
  };
}

export function parseDateValue(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 200_000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86_400_000);
    return date.toISOString().slice(0, 10);
  }
  const source = text(value);
  if (!source) return validIsoDate(fallback) ? fallback : null;
  if (validIsoDate(source)) return source;
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(source);
  if (!match) return validIsoDate(fallback) ? fallback : null;
  const iso = `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}`;
  return validIsoDate(iso) ? iso : validIsoDate(fallback) ? fallback : null;
}

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value ?? ""))) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function issue(fieldName, ruleCode, severity, message, sourceValue) {
  return { fieldName, ruleCode, severity, message, sourceValue: sourceValue ?? null };
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function optionalText(value) {
  const normalized = text(value);
  return normalized || null;
}
