const MILK_FIELDS = {
  totalLiters: ["LECHE"],
  morningLiters: ["LECHEAM"],
  afternoonLiters: ["LECHEPM"],
  thirdMilkingLiters: ["LECHE3RA"],
};

const QUALITY_ALIASES = {
  fatPercent: ["MGX100", "GRASA", "FAT", "FATPCT", "FAT_PCT"],
  proteinPercent: ["PTX100", "PROTEINA", "PROTEIN", "PROTPCT", "PROTEIN_PCT"],
  totalSolidsPercent: ["SOLIDOS", "SOLIDOST", "SOLIDOSTOT", "TOTALSOL", "TOTAL_SOL"],
  somaticCellCount: ["RCS", "SCC"],
  bacterialCount: ["UFC"],
};

export function mapCooprinsemMilkControl(record, options = {}) {
  const normalized = normalizeRecord(record);
  const issues = [];
  const matchedFields = [];
  const volumes = {};

  for (const [property, aliases] of Object.entries(MILK_FIELDS)) {
    const match = firstValue(normalized, aliases);
    if (!match) {
      volumes[property] = null;
      continue;
    }
    matchedFields.push(match.field);
    const value = finiteNumber(match.value);
    if (value === null || value < 0) {
      issues.push(`${match.field} no contiene un volumen no negativo proyectable.`);
      volumes[property] = null;
    } else {
      volumes[property] = value;
    }
  }

  if (matchedFields.length === 0) return { control: null, matchedFields, issues };
  const controlDate = isoDate(normalized.FCONTROL) ?? isoDate(options.effectiveAt);
  if (!controlDate) {
    issues.push("El control lechero necesita FCONTROL o una fecha efectiva valida.");
    return { control: null, matchedFields, issues };
  }

  const componentValues = [volumes.morningLiters, volumes.afternoonLiters, volumes.thirdMilkingLiters]
    .filter((value) => value !== null);
  const totalLiters = volumes.totalLiters ?? (componentValues.length > 0
    ? componentValues.reduce((sum, value) => sum + value, 0)
    : null);
  if (totalLiters === null || totalLiters <= 0) {
    issues.push("El control lechero no tiene un total positivo proyectable.");
    return { control: null, matchedFields, issues };
  }

  const fat = percentage(normalized, ["MGX100"], "materia grasa", issues, matchedFields, 15);
  const protein = percentage(normalized, ["PTX100"], "proteina", issues, matchedFields, 15);
  const somatic = integerCount(normalized, ["RCS", "SCC"], "recuento de celulas somaticas", issues, matchedFields);
  return {
    control: {
      controlDate,
      morningLiters: volumes.morningLiters,
      afternoonLiters: volumes.afternoonLiters,
      thirdMilkingLiters: volumes.thirdMilkingLiters,
      totalLiters,
      fatPct: fat,
      proteinPct: protein,
      somaticCellCount: somatic,
    },
    matchedFields: [...new Set(matchedFields)],
    issues,
  };
}

export function mapCooprinsemMilkQualitySample(record, options = {}) {
  const normalized = normalizeRecord(record);
  const issues = [];
  const matchedFields = [];
  const sampledAt = isoDate(normalized.FMUESTRA) ?? isoDate(normalized.FECHA) ?? isoDate(normalized.FCONTROL) ?? isoDate(options.sampledAt);
  const fatPercent = percentage(normalized, QUALITY_ALIASES.fatPercent, "materia grasa", issues, matchedFields, 15);
  const proteinPercent = percentage(normalized, QUALITY_ALIASES.proteinPercent, "proteina", issues, matchedFields, 15);
  const totalSolidsPercent = percentage(normalized, QUALITY_ALIASES.totalSolidsPercent, "solidos totales", issues, matchedFields, 100);
  const somaticCellCountUnit = normalizeLaboratoryUnit(
    options.somaticCellCountUnit ?? firstValue(normalized, ["UNIRCS", "RCSUNIDAD", "SCCUNIT"])?.value,
    "somatic",
  );
  const bacterialCountUnit = normalizeLaboratoryUnit(
    options.bacterialCountUnit ?? firstValue(normalized, ["UNIUFC", "UFCUNIDAD", "UFCUNIT"])?.value,
    "bacterial",
  );
  const somaticCellCount = laboratoryCount(
    normalized,
    QUALITY_ALIASES.somaticCellCount,
    "recuento de celulas somaticas",
    somaticCellCountUnit,
    ["cells_per_ml", "thousand_cells_per_ml"],
    issues,
    matchedFields,
  );
  const bacterialCount = laboratoryCount(
    normalized,
    QUALITY_ALIASES.bacterialCount,
    "recuento bacteriano",
    bacterialCountUnit,
    ["cfu_per_ml", "thousand_cfu_per_ml"],
    issues,
    matchedFields,
  );
  const hasMeasurement = [fatPercent, proteinPercent, totalSolidsPercent, somaticCellCount, bacterialCount]
    .some((value) => value !== null);
  if (!hasMeasurement) {
    if (issues.length === 0) issues.push("La fila no contiene una medicion de laboratorio reconocida.");
    return { sample: null, matchedFields: [...new Set(matchedFields)], issues };
  }
  if (!sampledAt) {
    issues.push("La muestra de laboratorio necesita una fecha explicita valida.");
    return { sample: null, matchedFields: [...new Set(matchedFields)], issues };
  }
  return {
    sample: {
      sampledAt,
      period: sampledAt.slice(0, 7),
      kind: "laboratory",
      fatPercent,
      proteinPercent,
      totalSolidsPercent,
      somaticCellCount,
      somaticCellCountUnit: somaticCellCount === null ? null : somaticCellCountUnit,
      bacterialCount,
      bacterialCountUnit: bacterialCount === null ? null : bacterialCountUnit,
      sanitaryFlags: {},
      source: "cooprinsem_laboratory",
    },
    matchedFields: [...new Set(matchedFields)],
    issues,
  };
}

function normalizeLaboratoryUnit(value, kind) {
  if (value === null || value === undefined) return null;
  const unit = normalizeFieldName(value).replaceAll(" ", "_");
  if (kind === "somatic") {
    if (["CELLS_PER_ML", "CEL_ML", "CELULAS/ML", "CELLS/ML"].includes(unit)) return "cells_per_ml";
    if (["THOUSAND_CELLS_PER_ML", "MIL_CEL_ML", "1000_CEL_ML", "MILES/ML"].includes(unit)) return "thousand_cells_per_ml";
  } else {
    if (["CFU_PER_ML", "UFC_ML", "UFC/ML", "CFU/ML"].includes(unit)) return "cfu_per_ml";
    if (["THOUSAND_CFU_PER_ML", "MIL_UFC_ML", "1000_UFC_ML", "MILES_UFC/ML"].includes(unit)) return "thousand_cfu_per_ml";
  }
  return null;
}

function normalizeRecord(record) {
  const result = {};
  if (!record || typeof record !== "object") return result;
  for (const [key, value] of Object.entries(record)) result[normalizeFieldName(key)] = value;
  return result;
}

function normalizeFieldName(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toUpperCase();
}

function firstValue(record, aliases) {
  for (const field of aliases) {
    const value = record[field];
    if (value !== null && value !== undefined && String(value).trim() !== "") return { field, value };
  }
  return null;
}

function finiteNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Number(value.trim().replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function percentage(record, aliases, label, issues, matchedFields, maximum) {
  const match = firstValue(record, aliases);
  if (!match) return null;
  matchedFields.push(match.field);
  const value = finiteNumber(match.value);
  if (value === null || value < 0 || value > maximum) {
    issues.push(`${match.field} no contiene un porcentaje de ${label} entre 0 y ${maximum}.`);
    return null;
  }
  return value;
}

function integerCount(record, aliases, label, issues, matchedFields) {
  const match = firstValue(record, aliases);
  if (!match) return null;
  matchedFields.push(match.field);
  const value = finiteNumber(match.value);
  if (value === null || value < 0 || !Number.isInteger(value)) {
    issues.push(`${match.field} no contiene un ${label} entero no negativo.`);
    return null;
  }
  return value;
}

function laboratoryCount(record, aliases, label, unit, allowedUnits, issues, matchedFields) {
  const match = firstValue(record, aliases);
  if (!match) return null;
  matchedFields.push(match.field);
  if (!allowedUnits.includes(unit)) {
    issues.push(`${match.field} necesita una unidad explicita para ${label}.`);
    return null;
  }
  return integerCount({ [match.field]: match.value }, [match.field], label, issues, []);
}

function isoDate(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? text : null;
}
