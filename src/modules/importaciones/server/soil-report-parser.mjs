const PROFILE_HEADER = "LABORATORIO ANÁLISIS DE SUELO Y FORRAJE";
const PROFILE_SCHEMA = "fundosmart.cooprinsem.soil-report.v1";

const RESULT_DEFINITIONS = [
  {
    analyteCode: "ph_h2o",
    analyteName: "pH H2O",
    unit: "pH",
    methodKey: "ph_water_cacl2_ratio_1_2_5",
    methodLabel: "pH en agua y CaCl2, relación 1:2,5",
  },
  {
    analyteCode: "phosphorus_olsen",
    analyteName: "Fósforo Olsen",
    unit: "mg/kg",
    methodKey: "nahco3_0_5mol_l_ph_8_5",
    methodLabel: "Extracto NaHCO3 0,5 mol/l a pH 8,5",
  },
  {
    analyteCode: "available_potassium",
    analyteName: "Potasio disponible",
    unit: "mg/kg",
    methodKey: "ammonium_acetate_1mol_l_ph_7",
    methodLabel: "Extracto CH3COONH4 1 mol/l a pH 7,0",
  },
  {
    analyteCode: "exchangeable_potassium",
    analyteName: "Potasio",
    unit: "cmol+/kg",
    methodKey: "ammonium_acetate_1mol_l_ph_7",
    methodLabel: "Extracto CH3COONH4 1 mol/l a pH 7,0",
  },
  {
    analyteCode: "exchangeable_calcium",
    analyteName: "Calcio",
    unit: "cmol+/kg",
    methodKey: "ammonium_acetate_1mol_l_ph_7",
    methodLabel: "Extracto CH3COONH4 1 mol/l a pH 7,0",
  },
  {
    analyteCode: "exchangeable_magnesium",
    analyteName: "Magnesio",
    unit: "cmol+/kg",
    methodKey: "ammonium_acetate_1mol_l_ph_7",
    methodLabel: "Extracto CH3COONH4 1 mol/l a pH 7,0",
  },
  {
    analyteCode: "exchangeable_sodium",
    analyteName: "Sodio",
    unit: "cmol+/kg",
    methodKey: "ammonium_acetate_1mol_l_ph_7",
    methodLabel: "Extracto CH3COONH4 1 mol/l a pH 7,0",
  },
  {
    analyteCode: "sum_of_bases",
    analyteName: "Suma de bases",
    unit: "cmol+/kg",
    methodKey: null,
    methodLabel: null,
  },
  {
    analyteCode: "exchangeable_aluminum",
    analyteName: "Aluminio",
    unit: "cmol+/kg",
    methodKey: "kcl_1m",
    methodLabel: "Extracto KCl 1 M",
  },
  {
    analyteCode: "effective_cation_exchange_capacity",
    analyteName: "CICE",
    unit: "cmol+/kg",
    methodKey: null,
    methodLabel: null,
  },
  {
    analyteCode: "aluminum_saturation",
    analyteName: "Saturación de Aluminio",
    unit: "%",
    methodKey: null,
    methodLabel: null,
  },
];

const FEATURED_ANALYTES = new Set([
  "pH H2O",
  "Fósforo Olsen",
  "Potasio disponible",
  "Suma de bases",
  "Saturación de Aluminio",
]);

const CLASSIFICATION_VALUES = new Set([
  "Bajo",
  "Inadecuado",
  "Bajo - Inadecuado",
  "Medio",
  "Insuficiente",
  "Medio - Insuficiente",
  "Moderado",
  "Adecuado",
  "Adecuado a Alto",
  "Óptimo",
  "Alto",
  "Óptimo - Alto",
]);

export class SoilReportParseError extends Error {
  constructor(message, code = "SOIL_REPORT_INVALID") {
    super(message);
    this.name = "SoilReportParseError";
    this.code = code;
  }
}

export function parseCooprinsemSoilReportText(input) {
  const tokens = normalizeTokens(input);
  const joined = tokens.join("\n");
  if (
    tokens[0] !== PROFILE_HEADER
    || !tokens.includes("Datos Muestra")
    || !tokens.includes("INFORME DE RESULTADOS")
  ) {
    throw new SoilReportParseError(
      "El PDF no coincide con el perfil Cooprinsem Análisis Básico de Suelo v1.",
      "SOIL_PROFILE_MISMATCH",
    );
  }

  const sampleId = requiredValue(tokens, "ID Muestra", "SOIL_SAMPLE_ID_MISSING");
  const folio = requiredValue(tokens, "Folio", "SOIL_FOLIO_MISSING");
  if (!/^[\p{L}\d][\p{L}\d._/-]{0,79}$/u.test(sampleId)) {
    throw new SoilReportParseError("El identificador de muestra no es válido.", "SOIL_SAMPLE_ID_INVALID");
  }
  if (!/^\d{2,12}-\d{1,6}$/.test(folio)) {
    throw new SoilReportParseError("El folio del informe no es válido.", "SOIL_FOLIO_INVALID");
  }

  const receivedDate = sourceDate(
    requiredValue(tokens, "Fecha Recepción", "SOIL_RECEIVED_DATE_MISSING"),
    "SOIL_RECEIVED_DATE_INVALID",
  );
  const reportDate = sourceDate(
    requiredValue(tokens, "Fecha Informe", "SOIL_REPORT_DATE_MISSING"),
    "SOIL_REPORT_DATE_INVALID",
  );
  if (reportDate < receivedDate) {
    throw new SoilReportParseError(
      "La fecha del informe es anterior a la recepción de la muestra.",
      "SOIL_DATE_ORDER_INVALID",
    );
  }

  assertBasicSoilAnalysis(tokens);
  const tableStart = findTableStart(tokens);
  const headlineSection = tokens.slice(tokens.indexOf("INFORME DE RESULTADOS") + 1, tableStart);
  const classifications = parseHeadlineClassifications(headlineSection);
  const results = RESULT_DEFINITIONS.map((definition, index) => {
    const offset = tableStart + 4 + index * 4;
    const [analyteName, unit, rawValue, rawRange] = tokens.slice(offset, offset + 4);
    if (analyteName !== definition.analyteName || unit !== definition.unit) {
      throw new SoilReportParseError(
        `La fila ${index + 1} no coincide con el perfil básico de suelo esperado.`,
        "SOIL_RESULT_LAYOUT_INVALID",
      );
    }
    const value = strictNumber(rawValue, "SOIL_RESULT_VALUE_INVALID");
    const range = idealRange(rawRange);
    const reportedClassification = classifications.get(analyteName) ?? null;
    return {
      sequenceNumber: index + 1,
      ...definition,
      value,
      idealMin: range.min,
      idealMax: range.max,
      idealRangeText: range.text,
      reportedClassification,
      rangeAssessment: value < range.min ? "below" : value > range.max ? "above" : "within",
    };
  });

  if (classifications.size !== FEATURED_ANALYTES.size) {
    throw new SoilReportParseError(
      "El resumen de clasificaciones del informe está incompleto.",
      "SOIL_CLASSIFICATION_LAYOUT_INVALID",
    );
  }
  for (const result of results.filter((row) => FEATURED_ANALYTES.has(row.analyteName))) {
    const headline = headlineResult(headlineSection, result.analyteName);
    if (!headline || headline.unit !== result.unit || !approximatelyEqual(headline.value, result.value)) {
      throw new SoilReportParseError(
        `El resumen y la tabla no coinciden para ${result.analyteName}.`,
        "SOIL_RESULT_SUMMARY_MISMATCH",
      );
    }
  }

  const analyticalMethodsText = collectSection(tokens, "Técnicas analíticas:", "Referencias:");
  if (
    analyticalMethodsText.length < 80
    || analyticalMethodsText.length > 8_000
    || !analyticalMethodsText.includes("NaHCO3")
    || !analyticalMethodsText.includes("CH3COONH4")
  ) {
    throw new SoilReportParseError(
      "No fue posible verificar la sección de técnicas analíticas.",
      "SOIL_METHODS_INVALID",
    );
  }
  const idealDepthMatch = joined.match(/muestra de suelo tomada a (\d{1,3}) cm de profundidad/i);
  const idealRangeReferenceDepthCm = idealDepthMatch ? Number(idealDepthMatch[1]) : null;
  if (
    idealRangeReferenceDepthCm !== null
    && (idealRangeReferenceDepthCm <= 0 || idealRangeReferenceDepthCm > 200)
  ) {
    throw new SoilReportParseError(
      "La profundidad de referencia del rango no es válida.",
      "SOIL_REFERENCE_DEPTH_INVALID",
    );
  }

  return {
    kind: "cooprinsem_soil_report",
    schemaVersion: PROFILE_SCHEMA,
    provider: {
      key: "cooprinsem",
      laboratoryName: "Laboratorio Análisis de Suelo y Forraje",
    },
    sampleId,
    folio,
    receivedDate,
    reportDate,
    analysisType: "ANÁLISIS BÁSICO SUELO",
    sampledBy: optionalValue(tokens, "Muestreado Por"),
    reportedSamplingDepthCm: null,
    idealRangeReferenceDepthCm,
    analyticalMethodsText,
    results,
    accreditationClaim: {
      presentInDocument: /Laboratorio acreditado por el Servicio Agricola y Ganadero \(SAG\)/i.test(joined),
      verificationStatus: "reported_unverified",
    },
    documentaryVerification: {
      signatureStatus: "not_checked",
      qrStatus: "not_checked",
      use: "technical_result_only",
      originalRequired: true,
    },
    limitations: [
      "La importación conserva resultados técnicos y no genera recomendaciones, dosis, fertilizaciones ni actividades.",
      "La firma, el sello, la acreditación y cualquier QR deben verificarse en el PDF original privado.",
      "La profundidad de 20 cm, cuando aparece, describe la referencia de los rangos y no la profundidad efectiva informada para esta muestra.",
      "Los datos personales del cliente permanecen solo en el original privado y no se copian al registro normalizado.",
    ],
  };
}

export function soilReportPreviewRows(document) {
  if (document?.kind !== "cooprinsem_soil_report" || !Array.isArray(document.results)) {
    throw new SoilReportParseError("El documento de suelo no está normalizado.", "SOIL_DOCUMENT_INVALID");
  }
  return document.results.map((result) => ({
    recordNumber: result.sequenceNumber,
    rawRecord: {
      analyteName: result.analyteName,
      unit: result.unit,
      value: result.value,
      idealRangeText: result.idealRangeText,
      reportedClassification: result.reportedClassification,
    },
    normalizedRecord: { ...result },
    status: "valid",
    issues: [],
  }));
}

function normalizeTokens(input) {
  return (Array.isArray(input) ? input : String(input).split(/\r?\n/))
    .map((value) => String(value).normalize("NFC").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function requiredValue(tokens, label, code) {
  const value = optionalValue(tokens, label);
  if (!value) throw new SoilReportParseError(`Falta ${label} en el informe.`, code);
  return value;
}

function optionalValue(tokens, label) {
  const index = tokens.indexOf(label);
  if (index < 0) return null;
  const value = tokens[index + 1] ?? "";
  if (!value || isKnownLabel(value)) return null;
  return value;
}

function isKnownLabel(value) {
  return [
    "ID Muestra",
    "Folio",
    "Localidad",
    "Fecha Recepción",
    "Fecha Informe",
    "Tipo Suelo",
    "Tipo Análisis",
    "Muestreado Por",
    "Predio",
    "Prof. Muestreo (cm)",
  ].includes(value);
}

function sourceDate(value, code) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new SoilReportParseError("Una fecha del informe no es válida.", code);
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new SoilReportParseError("Una fecha del informe no es válida.", code);
  }
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function assertBasicSoilAnalysis(tokens) {
  const index = tokens.indexOf("Tipo Análisis");
  const normalized = tokens
    .slice(index + 1, index + 7)
    .map((value) => fold(value));
  if (
    index < 0
    || !normalized.includes("analisis")
    || !normalized.includes("basico")
    || !normalized.includes("suelo")
  ) {
    throw new SoilReportParseError(
      "El informe no declara un Análisis Básico de Suelo compatible.",
      "SOIL_ANALYSIS_TYPE_INVALID",
    );
  }
}

function findTableStart(tokens) {
  const index = tokens.indexOf("Resultado");
  if (
    index < 0
    || tokens[index + 1] !== "Unidad"
    || tokens[index + 2] !== "Valor"
    || tokens[index + 3] !== "Rango Ideal"
    || tokens.length < index + 4 + RESULT_DEFINITIONS.length * 4
  ) {
    throw new SoilReportParseError(
      "La tabla de resultados no coincide con el perfil esperado.",
      "SOIL_RESULT_TABLE_INVALID",
    );
  }
  return index;
}

function parseHeadlineClassifications(tokens) {
  const classifications = new Map();
  for (const analyteName of FEATURED_ANALYTES) {
    const index = tokens.indexOf(analyteName);
    const classification = index >= 0 ? tokens[index + 2] : null;
    if (!classification || !CLASSIFICATION_VALUES.has(classification)) {
      throw new SoilReportParseError(
        `La clasificación de ${analyteName} no coincide con el perfil esperado.`,
        "SOIL_CLASSIFICATION_LAYOUT_INVALID",
      );
    }
    classifications.set(analyteName, classification);
  }
  return classifications;
}

function headlineResult(tokens, analyteName) {
  const index = tokens.indexOf(analyteName);
  if (index < 0) return null;
  const match = /^(-?\d+(?:[.,]\d+)?)\s+(.+)$/.exec(tokens[index + 1] ?? "");
  if (!match) return null;
  return {
    value: strictNumber(match[1], "SOIL_RESULT_SUMMARY_INVALID"),
    unit: match[2],
  };
}

function strictNumber(value, code) {
  const compact = String(value ?? "").trim().replace(",", ".");
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(compact)) {
    throw new SoilReportParseError("Un resultado numérico no es válido.", code);
  }
  const parsed = Number(compact);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > 1e12) {
    throw new SoilReportParseError("Un resultado numérico no es válido.", code);
  }
  return parsed;
}

function idealRange(value) {
  const match = /^(-?(?:\d+|\d*[.,]\d+))\s*-\s*(-?(?:\d+|\d*[.,]\d+))$/.exec(value);
  if (!match) {
    throw new SoilReportParseError("Un rango ideal no es válido.", "SOIL_IDEAL_RANGE_INVALID");
  }
  const min = strictNumber(match[1], "SOIL_IDEAL_RANGE_INVALID");
  const max = strictNumber(match[2], "SOIL_IDEAL_RANGE_INVALID");
  if (min > max) {
    throw new SoilReportParseError("Un rango ideal está invertido.", "SOIL_IDEAL_RANGE_INVALID");
  }
  return { min, max, text: value };
}

function collectSection(tokens, startPrefix, endPrefix) {
  const start = tokens.findIndex((value) => value.startsWith(startPrefix));
  const end = tokens.findIndex((value, index) => index > start && value.startsWith(endPrefix));
  if (start < 0 || end <= start) {
    throw new SoilReportParseError(
      "El informe no contiene la sección de técnicas analíticas esperada.",
      "SOIL_METHODS_MISSING",
    );
  }
  return tokens.slice(start, end).join(" ");
}

function approximatelyEqual(left, right) {
  return Math.abs(left - right) <= 1e-9;
}

function fold(value) {
  return String(value)
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}
