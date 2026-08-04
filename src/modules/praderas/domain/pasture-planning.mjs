const DAY_MS = 86_400_000;

export class PastureDomainError extends Error {
  constructor(message, code = "PASTURE_INVALID") {
    super(message);
    this.name = "PastureDomainError";
    this.code = code;
  }
}

export function decideNdviProvider(input) {
  if (input?.mode === "unconfigured") {
    return Object.freeze({ mode: "unconfigured", providerKey: null, decidedAt: isoInstant(input.decidedAt, "Fecha de decisión") });
  }
  if (input?.mode !== "configured" || !cleanToken(input.providerKey)) {
    throw new PastureDomainError(
      "Selecciona explícitamente un proveedor NDVI antes de solicitar observaciones.",
      "NDVI_PROVIDER_UNCONFIGURED",
    );
  }
  return Object.freeze({
    mode: "configured",
    providerKey: cleanToken(input.providerKey),
    decidedAt: isoInstant(input.decidedAt, "Fecha de decisión"),
  });
}

export function calculateManualDryMatter(input) {
  if (input?.sampleKind === "direct") {
    return Object.freeze({
      method: "manual_direct",
      kgDmPerHectare: positive(input.kgDmPerHectare, "kg MS/ha"),
      evidence: Object.freeze({ sampleKind: "direct" }),
    });
  }
  if (input?.sampleKind !== "quadrat") {
    throw new PastureDomainError("Indica si la muestra es directa o de cuadrante.");
  }
  const freshWeightGrams = positive(input.freshWeightGrams, "Peso fresco");
  const dryMatterPercent = bounded(input.dryMatterPercent, 0, 100, "Porcentaje de materia seca", false);
  const quadratAreaSquareMeters = positive(input.quadratAreaSquareMeters, "Área del cuadrante");
  const dryWeightKg = (freshWeightGrams / 1000) * (dryMatterPercent / 100);
  return Object.freeze({
    method: "manual_quadrat",
    kgDmPerHectare: round((dryWeightKg / quadratAreaSquareMeters) * 10_000, 1),
    evidence: Object.freeze({ freshWeightGrams, dryMatterPercent, quadratAreaSquareMeters }),
  });
}

export function deriveBiomassObservation(raw, calibration = null) {
  const common = {
    observationId: requiredText(raw?.id, "Identificador de observación"),
    paddockId: requiredText(raw?.paddockId, "Potrero"),
    capturedAt: isoInstant(raw?.capturedAt, "Fecha de observación"),
  };
  if (raw?.kind === "manual") {
    const result = calculateManualDryMatter(raw.measurement);
    return Object.freeze({ ...common, ...result, calibrationId: null, sourceKind: "manual" });
  }
  if (raw?.kind !== "ndvi") throw new PastureDomainError("El origen de la observación no es válido.");
  const providerKey = cleanToken(raw.providerKey);
  if (!providerKey) throw new PastureDomainError("La observación NDVI no identifica su proveedor.", "NDVI_PROVIDER_UNCONFIGURED");
  const meanNdvi = bounded(raw.meanNdvi, -1, 1, "NDVI medio", true);
  const usablePixelPercent = bounded(raw.usablePixelPercent, 0, 100, "Cobertura útil", true);
  if (!calibration || cleanToken(calibration.providerKey) !== providerKey) {
    throw new PastureDomainError("Falta una calibración explícita para este proveedor NDVI.", "NDVI_CALIBRATION_REQUIRED");
  }
  const minNdvi = bounded(calibration.minNdvi, -1, 1, "NDVI mínimo de calibración", true);
  const maxNdvi = bounded(calibration.maxNdvi, -1, 1, "NDVI máximo de calibración", true);
  if (minNdvi >= maxNdvi || meanNdvi < minNdvi || meanNdvi > maxNdvi) {
    throw new PastureDomainError("El NDVI queda fuera del rango validado por la calibración.", "NDVI_OUTSIDE_CALIBRATION");
  }
  const slope = finite(calibration.slopeKgDmPerHa, "Pendiente de calibración");
  const intercept = finite(calibration.interceptKgDmPerHa, "Intercepto de calibración");
  return Object.freeze({
    ...common,
    sourceKind: "ndvi",
    method: "ndvi_linear_calibration",
    kgDmPerHectare: round(Math.max(0, intercept + (slope * meanNdvi)), 1),
    calibrationId: requiredText(calibration.id, "Calibración"),
    evidence: Object.freeze({ providerKey, meanNdvi, usablePixelPercent }),
  });
}

export function calculateGrowthRate(previous, current) {
  if (requiredText(previous?.paddockId, "Potrero anterior") !== requiredText(current?.paddockId, "Potrero actual")) {
    throw new PastureDomainError("Las observaciones de crecimiento deben pertenecer al mismo potrero.");
  }
  const from = Date.parse(isoInstant(previous.capturedAt, "Fecha anterior"));
  const to = Date.parse(isoInstant(current.capturedAt, "Fecha actual"));
  const elapsedDays = (to - from) / DAY_MS;
  if (elapsedDays <= 0) throw new PastureDomainError("La observación actual debe ser posterior a la anterior.");
  const delta = nonNegative(current.kgDmPerHectare, "Biomasa actual") - nonNegative(previous.kgDmPerHectare, "Biomasa anterior");
  return Object.freeze({
    paddockId: previous.paddockId,
    from: previous.capturedAt,
    to: current.capturedAt,
    elapsedDays: round(elapsedDays, 3),
    kgDmPerHaPerDay: round(delta / elapsedDays, 2),
  });
}

export function calculatePastureBudget(input) {
  const animalCount = positiveInteger(input?.herd?.animalCount, "Número de animales");
  const averageLiveWeightKg = positive(input?.herd?.averageLiveWeightKg, "Peso vivo promedio");
  const intakePercentLiveWeight = bounded(input?.herd?.intakePercentLiveWeight, 0, 10, "Consumo sobre peso vivo", false);
  const dailyDemandKgDm = round(animalCount * averageLiveWeightKg * (intakePercentLiveWeight / 100), 2);
  const paddocks = ensureArray(input?.paddocks, "potreros").map((paddock) => {
    const current = nonNegative(paddock.currentKgDmPerHectare, "Biomasa actual");
    const residual = nonNegative(paddock.residualKgDmPerHectare, "Residuo objetivo");
    const area = positive(paddock.areaHectares, "Superficie");
    const utilization = bounded(paddock.utilizationPercent, 0, 100, "Utilización", false) / 100;
    const availableKgDm = round(Math.max(0, current - residual) * area * utilization, 2);
    return Object.freeze({
      paddockId: requiredText(paddock.id, "Potrero"),
      paddockName: requiredText(paddock.name, "Nombre de potrero"),
      currentKgDmPerHectare: current,
      residualKgDmPerHectare: residual,
      areaHectares: area,
      utilizationPercent: round(utilization * 100, 2),
      availableKgDm,
      availableDays: round(availableKgDm / dailyDemandKgDm, 2),
    });
  });
  const totalSupplyKgDm = round(paddocks.reduce((sum, paddock) => sum + paddock.availableKgDm, 0), 2);
  return Object.freeze({
    dailyDemandKgDm,
    totalSupplyKgDm,
    availableDays: round(totalSupplyKgDm / dailyDemandKgDm, 2),
    paddocks: Object.freeze(paddocks),
  });
}

export function buildFeedWedge(input) {
  const paddocks = ensureArray(input?.paddocks, "potreros")
    .map((paddock) => ({
      paddockId: requiredText(paddock.id, "Potrero"),
      paddockName: requiredText(paddock.name, "Nombre de potrero"),
      kgDmPerHectare: nonNegative(paddock.currentKgDmPerHectare, "Biomasa actual"),
    }))
    .sort((left, right) => right.kgDmPerHectare - left.kgDmPerHectare || left.paddockName.localeCompare(right.paddockName, "es"));
  const entryTarget = positive(input?.entryTargetKgDmPerHectare, "Meta de entrada");
  const residualTarget = nonNegative(input?.residualTargetKgDmPerHectare, "Meta de residuo");
  if (entryTarget <= residualTarget) throw new PastureDomainError("La meta de entrada debe superar el residuo objetivo.");
  return Object.freeze(paddocks.map((paddock, index) => {
    const progress = paddocks.length <= 1 ? 0 : index / (paddocks.length - 1);
    const target = round(entryTarget - ((entryTarget - residualTarget) * progress), 1);
    return Object.freeze({ rank: index + 1, ...paddock, targetKgDmPerHectare: target, deviationKgDmPerHectare: round(paddock.kgDmPerHectare - target, 1) });
  }));
}

export function planRotation(input) {
  const startDate = isoDate(input?.startDate, "Fecha de inicio");
  const horizonDays = positiveInteger(input?.horizonDays, "Horizonte");
  const maxPaddockDays = positiveInteger(input?.maxPaddockDays, "Máximo de días por potrero");
  const herdId = requiredText(input?.herd?.id, "Rebaño");
  const budget = calculatePastureBudget({ herd: input.herd, paddocks: input.paddocks });
  const wedge = buildFeedWedge({
    paddocks: input.paddocks,
    entryTargetKgDmPerHectare: input.entryTargetKgDmPerHectare,
    residualTargetKgDmPerHectare: input.residualTargetKgDmPerHectare,
  });
  const byId = new Map(budget.paddocks.map((paddock) => [paddock.paddockId, paddock]));
  let coveredDays = 0;
  const visits = [];
  for (const item of wedge) {
    if (coveredDays >= horizonDays) break;
    const paddock = byId.get(item.paddockId);
    if (!paddock) continue;
    const remaining = horizonDays - coveredDays;
    const fullDays = Math.floor((paddock.availableKgDm + 1e-9) / budget.dailyDemandKgDm);
    const durationDays = Math.min(fullDays, remaining, maxPaddockDays);
    if (durationDays < 1) continue;
    const visitStart = addUtcDays(startDate, coveredDays);
    const visitEnd = addUtcDays(startDate, coveredDays + durationDays);
    visits.push(Object.freeze({
      herdId,
      paddockId: paddock.paddockId,
      paddockName: paddock.paddockName,
      startsOn: visitStart,
      endsOn: visitEnd,
      durationDays,
      allocatedKgDm: round(durationDays * budget.dailyDemandKgDm, 2),
    }));
    coveredDays += durationDays;
  }
  const overlapErrors = findRotationOverlaps(visits);
  const shortageDays = horizonDays - coveredDays;
  const blockers = [...overlapErrors];
  if (shortageDays > 0) blockers.push(`Faltan ${shortageDays} día${shortageDays === 1 ? "" : "s"} de oferta para cubrir el horizonte.`);
  return Object.freeze({
    startDate,
    horizonDays,
    coveredDays,
    shortageDays,
    feasible: blockers.length === 0,
    dailyDemandKgDm: budget.dailyDemandKgDm,
    visits: Object.freeze(visits),
    blockers: Object.freeze(blockers),
    feedWedge: wedge,
  });
}

export function planLotRotations(input) {
  const startDate = isoDate(input?.startDate, "Fecha de inicio");
  const horizonDays = positiveInteger(input?.horizonDays, "Horizonte");
  const maxPaddockDays = positiveInteger(input?.maxPaddockDays, "Máximo de días por potrero");
  const restDays = nonNegativeInteger(input?.restDays ?? 0, "Descanso del potrero");
  const lots = ensureArray(input?.lots, "lotes").map((lot) => {
    const id = requiredText(lot?.id, "Lote");
    const name = requiredText(lot?.name, "Nombre del lote");
    const animalCount = positiveInteger(lot?.animalCount, "Número de animales");
    const averageLiveWeightKg = positive(lot?.averageLiveWeightKg, "Peso vivo promedio");
    const intakePercentLiveWeight = bounded(lot?.intakePercentLiveWeight, 0, 10, "Consumo sobre peso vivo", false);
    return Object.freeze({
      id,
      name,
      animalCount,
      averageLiveWeightKg,
      intakePercentLiveWeight,
      dailyDemandKgDm: round(animalCount * averageLiveWeightKg * (intakePercentLiveWeight / 100), 2),
    });
  });
  const totalDailyDemandKgDm = round(lots.reduce((sum, lot) => sum + lot.dailyDemandKgDm, 0), 2);
  const budget = calculatePastureBudget({
    herd: { animalCount: 1, averageLiveWeightKg: totalDailyDemandKgDm * 10, intakePercentLiveWeight: 10 },
    paddocks: input.paddocks,
  });
  const wedge = buildFeedWedge({
    paddocks: input.paddocks,
    entryTargetKgDmPerHectare: input.entryTargetKgDmPerHectare,
    residualTargetKgDmPerHectare: input.residualTargetKgDmPerHectare,
  });
  const wedgeRank = new Map(wedge.map((item, index) => [item.paddockId, index]));
  const inputPaddocks = new Map(input.paddocks.map((paddock) => [paddock.id, paddock]));
  const paddockStates = new Map(budget.paddocks.map((paddock) => {
    const source = inputPaddocks.get(paddock.paddockId);
    const cells = Array.isArray(source?.cells)
      ? source.cells.map((cell) => ({
        id: requiredText(cell?.id, "Celda"),
        name: requiredText(cell?.name, "Nombre de celda"),
      }))
      : [];
    return [paddock.paddockId, {
      ...paddock,
      remainingKgDm: paddock.availableKgDm,
      nextAvailableDay: 0,
      visitCount: 0,
      cells,
    }];
  }));
  const visits = [];
  const lotCoverage = [];
  for (const lot of lots) {
    let cursorDay = 0;
    let coveredDays = 0;
    while (cursorDay < horizonDays) {
      const candidates = [...paddockStates.values()]
        .filter((paddock) => paddock.remainingKgDm + 1e-9 >= lot.dailyDemandKgDm)
        .map((paddock) => ({ paddock, startDay: Math.max(cursorDay, paddock.nextAvailableDay) }))
        .filter((candidate) => candidate.startDay < horizonDays)
        .sort((left, right) => left.startDay - right.startDay
          || (wedgeRank.get(left.paddock.paddockId) ?? Number.MAX_SAFE_INTEGER)
            - (wedgeRank.get(right.paddock.paddockId) ?? Number.MAX_SAFE_INTEGER)
          || left.paddock.paddockId.localeCompare(right.paddock.paddockId))[0];
      if (!candidates) break;
      const { paddock, startDay } = candidates;
      const fullDays = Math.floor((paddock.remainingKgDm + 1e-9) / lot.dailyDemandKgDm);
      const durationDays = Math.min(fullDays, horizonDays - startDay, maxPaddockDays);
      if (durationDays < 1) break;
      const endDay = startDay + durationDays;
      const cell = paddock.cells.length > 0 ? paddock.cells[paddock.visitCount % paddock.cells.length] : null;
      visits.push(Object.freeze({
        herdId: lot.id,
        lotId: lot.id,
        lotName: lot.name,
        paddockId: paddock.paddockId,
        paddockName: paddock.paddockName,
        cellId: cell?.id ?? null,
        cellName: cell?.name ?? null,
        startsOn: addUtcDays(startDate, startDay),
        endsOn: addUtcDays(startDate, endDay),
        durationDays,
        allocatedKgDm: round(durationDays * lot.dailyDemandKgDm, 2),
        restDays,
        restUntil: addUtcDays(startDate, endDay + restDays),
      }));
      paddock.remainingKgDm = round(Math.max(0, paddock.remainingKgDm - (durationDays * lot.dailyDemandKgDm)), 2);
      paddock.nextAvailableDay = endDay + restDays;
      paddock.visitCount += 1;
      cursorDay = endDay;
      coveredDays += durationDays;
    }
    lotCoverage.push(Object.freeze({
      lotId: lot.id,
      lotName: lot.name,
      dailyDemandKgDm: lot.dailyDemandKgDm,
      coveredDays,
      shortageDays: horizonDays - coveredDays,
    }));
  }
  const overlapErrors = findRotationOverlaps(visits);
  const shortageDays = lotCoverage.reduce((sum, lot) => sum + lot.shortageDays, 0);
  const blockers = [...overlapErrors];
  for (const lot of lotCoverage.filter((item) => item.shortageDays > 0)) {
    blockers.push(`Al lote ${lot.lotName} le faltan ${lot.shortageDays} día${lot.shortageDays === 1 ? "" : "s"} de oferta dentro del horizonte.`);
  }
  return Object.freeze({
    schemaVersion: "fundosmart.pasture.rotation-plan.v3",
    startDate,
    horizonDays,
    coveredDays: lotCoverage.reduce((sum, lot) => sum + lot.coveredDays, 0),
    shortageDays,
    feasible: blockers.length === 0,
    dailyDemandKgDm: totalDailyDemandKgDm,
    lots: Object.freeze(lotCoverage),
    visits: Object.freeze(visits),
    blockers: Object.freeze(blockers),
    feedWedge: wedge,
    restDays,
  });
}

export function findRotationOverlaps(visits) {
  const errors = [];
  const sorted = ensureArray(visits, "visitas")
    .map((visit) => ({ ...visit, start: Date.parse(`${isoDate(visit.startsOn, "Inicio") }T00:00:00.000Z`), end: Date.parse(`${isoDate(visit.endsOn, "Término")}T00:00:00.000Z`) }))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 0; index < sorted.length; index += 1) {
    const current = sorted[index];
    if (current.end <= current.start) {
      errors.push(`La visita a ${current.paddockName ?? current.paddockId} no tiene una duración válida.`);
      continue;
    }
    for (let otherIndex = index + 1; otherIndex < sorted.length; otherIndex += 1) {
      const next = sorted[otherIndex];
      const currentLotId = current.lotId ?? current.herdId;
      const nextLotId = next.lotId ?? next.herdId;
      const intervalsOverlap = next.start < current.end;
      if (intervalsOverlap && (currentLotId === nextLotId || current.paddockId === next.paddockId)) {
        errors.push(`Las visitas a ${current.paddockName ?? current.paddockId} y ${next.paddockName ?? next.paddockId} se solapan.`);
        continue;
      }
      const restUntil = current.restUntil
        ? Date.parse(`${isoDate(current.restUntil, "Fin de descanso")}T00:00:00.000Z`)
        : current.end;
      if (current.paddockId === next.paddockId && next.start < restUntil) {
        errors.push(`El potrero ${current.paddockName ?? current.paddockId} no cumple su descanso antes de la siguiente visita.`);
      }
    }
  }
  return Object.freeze(errors);
}

function addUtcDays(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + (days * DAY_MS)).toISOString().slice(0, 10);
}

function ensureArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) throw new PastureDomainError(`Agrega al menos un elemento en ${label}.`);
  return value;
}

function isoInstant(value, label) {
  const time = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(time)) throw new PastureDomainError(`${label} no es válida.`);
  return new Date(time).toISOString();
}

function isoDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new PastureDomainError(`${label} no es válida.`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new PastureDomainError(`${label} no es válida.`);
  return value;
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new PastureDomainError(`${label} es obligatorio.`);
  return value.trim();
}

function cleanToken(value) {
  if (typeof value !== "string") return "";
  const token = value.trim().toLowerCase();
  return /^[a-z][a-z0-9._-]{0,63}$/.test(token) ? token : "";
}

function finite(value, label) {
  if (!Number.isFinite(value)) throw new PastureDomainError(`${label} debe ser un número válido.`);
  return Number(value);
}

function positive(value, label) {
  const number = finite(value, label);
  if (number <= 0) throw new PastureDomainError(`${label} debe ser mayor que cero.`);
  return number;
}

function nonNegative(value, label) {
  const number = finite(value, label);
  if (number < 0) throw new PastureDomainError(`${label} no puede ser negativo.`);
  return number;
}

function positiveInteger(value, label) {
  const number = positive(value, label);
  if (!Number.isInteger(number)) throw new PastureDomainError(`${label} debe ser entero.`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = nonNegative(value, label);
  if (!Number.isInteger(number)) throw new PastureDomainError(`${label} debe ser entero.`);
  return number;
}

function bounded(value, min, max, label, inclusiveMin) {
  const number = finite(value, label);
  if ((inclusiveMin ? number < min : number <= min) || number > max) {
    throw new PastureDomainError(`${label} debe estar entre ${min} y ${max}.`);
  }
  return number;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
