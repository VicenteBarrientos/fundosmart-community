const DATE_TOKEN = /^\d{2}-\d{2}-\d{4}$/;

export class WattsVisitParseError extends Error {
  constructor(message, code = "WATTS_REPORT_INVALID") {
    super(message);
    this.name = "WattsVisitParseError";
    this.code = code;
  }
}

export function parseWattsVisitText(input) {
  const tokens = (Array.isArray(input) ? input : String(input).split(/\r?\n/))
    .map((value) => String(value).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const joined = tokens.join("\n");
  if (!joined.includes("Reporte de Visita") || !joined.includes("Plan Sugerido")) {
    throw new WattsVisitParseError(
      "El PDF no coincide con el perfil Watt's Reporte de Visita v1.",
      "WATTS_PROFILE_MISMATCH",
    );
  }

  const producerIndex = findToken(tokens, "Lechería");
  const producerName = nextMeaningful(tokens, producerIndex + 1);
  const producerCode = joined.match(/\((\d{3,})\)/)?.[1] ?? null;
  const visitDate = spanishDate(nextMeaningful(tokens, findToken(tokens, "Fecha") + 1));
  const nextVisitLabel = findToken(tokens, "Próxima Visita");
  const nextVisitDate = nextVisitLabel >= 0 ? spanishDate(nextMeaningful(tokens, nextVisitLabel + 1), false) : null;

  const criteriaIndex = findToken(tokens, "Criterios de Pastoreo");
  const massCows = numberAfter(tokens, criteriaIndex);
  const availabilityIndex = findToken(tokens, "Disponibilidad");
  const residueIndex = findToken(tokens, "Residuo", availabilityIndex + 1);
  const dryMatterIndex = findToken(tokens, "Consumo de Materia Seca");
  const dayIndex = findToken(tokens, "Día", dryMatterIndex + 1);
  const nightIndex = findToken(tokens, "Noche", dayIndex + 1);
  const milkingIndex = findToken(tokens, "Vaca Ordeña", nightIndex + 1);
  const averageMilkIndex = findToken(tokens, "Litros Promedio", milkingIndex + 1, true);
  const totalConsumptionIndex = findToken(tokens, "Total kg MS / Vaca / Día:", averageMilkIndex + 1);

  const foodIndex = findToken(tokens, "Pradera Naturalizada");
  const pastureKgDmCowDay = numberAfter(tokens, foodIndex);
  const pastureParticipationPercent = numberAfter(tokens, foodIndex + 1);
  const reportedTotalPrice = numberAfter(tokens, foodIndex + 2);
  const bodyIndex = findToken(tokens, "Condición Corporal");
  const bodyCondition = numberAfter(tokens, findToken(tokens, "Lote 1", bodyIndex + 1));

  const planIndex = findToken(tokens, "Plan Sugerido");
  const planStartTokenIndex = findNextDate(tokens, planIndex + 1);
  if (planStartTokenIndex < 0) {
    throw new WattsVisitParseError("El reporte Watt's no contiene la fecha inicial del plan.", "WATTS_PLAN_DATE_MISSING");
  }
  const planValues = numericValues(tokens, planStartTokenIndex + 1, 4);
  if (planValues.length !== 4) {
    throw new WattsVisitParseError("El encabezado del plan Watt's está incompleto.", "WATTS_PLAN_HEADER_INVALID");
  }

  const paddocks = [];
  for (let index = planStartTokenIndex + 1; index + 7 < tokens.length; index += 1) {
    if (!/^\d+$/.test(tokens[index]) || !DATE_TOKEN.test(tokens[index + 1])) continue;
    const values = tokens.slice(index + 2, index + 8).map(parseLocaleNumber);
    if (values.some((value) => value === null)) continue;
    paddocks.push({
      sequenceNumber: paddocks.length + 1,
      externalPaddockKey: tokens[index],
      plannedEntryDate: sourceDate(tokens[index + 1]),
      projectedBiomassKgDmHa: values[0],
      areaHa: values[1],
      dailyAreaHa: values[2],
      calculatedDays: values[3],
      adjustedDays: values[4],
      adjustedIntakeKgDmCowDay: values[5],
    });
    index += 7;
  }
  if (paddocks.length === 0) {
    throw new WattsVisitParseError("No se encontraron filas del plan de potreros Watt's.", "WATTS_PADDOCK_ROWS_MISSING");
  }

  const totalAreaHa = round(paddocks.reduce((total, row) => total + row.areaHa, 0), 2);
  const totalAdjustedDays = round(paddocks.reduce((total, row) => total + row.adjustedDays, 0), 2);
  const generated = joined.match(/\b(\d{2})-(\d{2})-(\d{4})\s+(\d{2}:\d{2}:\d{2})\b/);

  return {
    kind: "watts_visit_report",
    schemaVersion: "fundosmart.watts.visit-report.v1",
    producer: {
      name: producerName || "Productor sin identificar",
      code: producerCode || "sin-código",
    },
    visitDate,
    nextVisitDate,
    reportGeneratedLocal: generated ? `${generated[3]}-${generated[2]}-${generated[1]}T${generated[4]}` : null,
    herd: {
      massCows,
      milkingCows: numberAfter(tokens, milkingIndex),
      averageLitersPerCowDay: numberAfter(tokens, averageMilkIndex),
      bodyCondition,
    },
    grazing: {
      dayAvailabilityKgDmHa: numberAfter(tokens, availabilityIndex),
      nightAvailabilityKgDmHa: numberAfter(tokens, availabilityIndex + 1),
      dayResidueKgDmHa: numberAfter(tokens, residueIndex),
      nightResidueKgDmHa: numberAfter(tokens, residueIndex + 1),
      dayConsumptionKgDm: numberAfter(tokens, dayIndex),
      dayStripHa: numberAfter(tokens, dayIndex + 1),
      dayKgDmCowDay: numberAfter(tokens, dayIndex + 2),
      nightConsumptionKgDm: numberAfter(tokens, nightIndex),
      nightStripHa: numberAfter(tokens, nightIndex + 1),
      nightKgDmCowDay: numberAfter(tokens, nightIndex + 2),
      totalKgDmCowDay: numberAfter(tokens, totalConsumptionIndex),
    },
    diet: {
      pastureParticipationPercent,
      pastureKgDmCowDay,
      reportedTotalPrice,
    },
    plan: {
      startDate: sourceDate(tokens[planStartTokenIndex]),
      targetKgDmCowDay: planValues[0],
      growthRateKgDmHaDay: planValues[1],
      cowCount: planValues[2],
      residueKgDmHa: planValues[3],
      totalAreaHa,
      totalAdjustedDays,
      paddocks,
    },
    notes: collectObservations(tokens),
    limitations: [
      "Las etiquetas de potrero son externas y no se enlazan automáticamente con potreros de FundoSmart.",
      "El gráfico de disponibilidad actual está embebido como imagen; esta versión importa la tabla numérica del plan.",
    ],
  };
}

export function wattsPreviewRows(snapshot) {
  return snapshot.plan.paddocks.map((row) => ({
    recordNumber: row.sequenceNumber,
    rawRecord: { ...row },
    normalizedRecord: {
      externalPaddockKey: row.externalPaddockKey,
      paddockId: null,
      observedAt: snapshot.visitDate,
      plannedEntryDate: row.plannedEntryDate,
      currentBiomassKgDmHa: null,
      projectedBiomassKgDmHa: row.projectedBiomassKgDmHa,
      areaHa: row.areaHa,
      dailyAreaHa: row.dailyAreaHa,
      calculatedDays: row.calculatedDays,
      adjustedDays: row.adjustedDays,
      adjustedIntakeKgDmCowDay: row.adjustedIntakeKgDmCowDay,
      notes: null,
    },
    status: "warning",
    issues: [{
      fieldName: "externalPaddockKey",
      ruleCode: "PADDOCK_RECONCILIATION_PENDING",
      severity: "warning",
      message: "La etiqueta externa debe conciliarse antes de usar esta fila como observación canónica del potrero.",
      sourceValue: row.externalPaddockKey,
    }],
  }));
}

function findToken(tokens, expected, start = 0, prefix = false) {
  for (let index = Math.max(0, start); index < tokens.length; index += 1) {
    if (prefix ? tokens[index].startsWith(expected) : tokens[index] === expected) return index;
  }
  return -1;
}

function nextMeaningful(tokens, start) {
  return start >= 0 ? tokens[start] ?? "" : "";
}

function numberAfter(tokens, start) {
  if (start < 0) return null;
  for (let index = start + 1; index < Math.min(tokens.length, start + 8); index += 1) {
    const value = parseLocaleNumber(tokens[index]);
    if (value !== null) return value;
  }
  return null;
}

function numericValues(tokens, start, count) {
  const values = [];
  for (let index = start; index < tokens.length && values.length < count; index += 1) {
    const value = parseLocaleNumber(tokens[index]);
    if (value !== null) values.push(value);
  }
  return values;
}

function findNextDate(tokens, start) {
  for (let index = start; index < tokens.length; index += 1) {
    if (DATE_TOKEN.test(tokens[index])) return index;
  }
  return -1;
}

function spanishDate(value, required = true) {
  const normalized = String(value ?? "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  const match = /(\d{1,2}) de ([a-z]+) de (\d{4})/.exec(normalized);
  const months = {
    enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
    julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  };
  const month = match ? months[match[2]] : null;
  if (!match || !month) {
    if (required) throw new WattsVisitParseError("No fue posible leer la fecha de visita Watt's.", "WATTS_VISIT_DATE_INVALID");
    return null;
  }
  return `${match[3]}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`;
}

function sourceDate(value) {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) throw new WattsVisitParseError("Una fecha del plan Watt's no es válida.", "WATTS_PLAN_DATE_INVALID");
  return `${match[3]}-${match[2]}-${match[1]}`;
}

export function parseLocaleNumber(value) {
  const compact = String(value ?? "").trim().replace(/[$%\s]/g, "");
  if (!compact || !/^-?[\d.,]+$/.test(compact)) return null;
  let normalized = compact;
  if (compact.includes(",") && compact.includes(".")) {
    normalized = compact.replace(/\./g, "").replace(",", ".");
  } else if (compact.includes(",")) {
    normalized = compact.replace(",", ".");
  } else if (/^-?\d{1,3}(?:\.\d{3})+$/.test(compact)) {
    normalized = compact.replace(/\./g, "");
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function collectObservations(tokens) {
  const notes = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!tokens[index].startsWith("Observaciones")) continue;
    const value = tokens[index + 1];
    if (!value || value === "Lote 1" || /^\d+$/.test(value)) continue;
    notes.push(value);
  }
  return [...new Set(notes)].slice(0, 12);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
