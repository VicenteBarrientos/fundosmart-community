export const HISTORY_PROJECTION_FORMAT = "fundosmart.cooprinsem-history-assessment.v2";
export const COOPRINSEM_MILK_UNIT_CONTRACT_VERSION = "cooprinsem-leche-litros.v1";
export const COOPRINSEM_MILK_CANONICAL_UNIT = "liters";
export const COOPRINSEM_MILK_SOURCE_FIELDS = ["LECHE", "LECHEAM", "LECHEPM", "LECHE3RA"];

const MILK_UNIT_BLOCKER = "Los campos LECHE* requieren el contrato explícito cooprinsem-leche-litros.v1.";
const CONTROL_DATE_BLOCKER = "La historia productiva requiere una fecha de control válida.";
const SERVICE_FIELDS = [
  { date: "FECCUBANT", sire: "NOMTORO2", role: "previous_month_service" },
  { date: "FECCUB3", sire: "NOMTORO3", role: "prior_control_month_service" },
  { date: "FECULTCUB", sire: "NOMTORO", role: "latest_service" },
];

export function assessCooprinsemHistoricalRecord(record, context = {}) {
  const controlDate = isoDate(record?.FCONTROL) ?? isoDate(context.effectiveAt);
  const milkControl = assessMilkControl(record, controlDate, context.milkUnitContractVersion);
  const reproductiveServices = assessReproductiveServices(record, controlDate);
  return { controlDate, milkControl, reproductiveServices };
}

export function buildCooprinsemHistoryAssessment(entries, options = {}) {
  const workset = buildCooprinsemHistoryWorkset(entries, options);
  const blockers = new Set();
  for (const candidate of [...workset.milkControls, ...workset.reproductiveServices]) {
    candidate.blockers.forEach((blocker) => blockers.add(blocker));
  }
  const milkReady = workset.milkControls.filter((candidate) => candidate.state === "ready").length;
  const serviceReady = workset.reproductiveServices.filter((candidate) => candidate.state === "ready").length;
  const contractConfirmed = options.milkUnitContractVersion === COOPRINSEM_MILK_UNIT_CONTRACT_VERSION;
  return {
    format: HISTORY_PROJECTION_FORMAT,
    writeEnabled: false,
    eligibleRowCount: entries.length,
    milkUnitContract: {
      requiredVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
      confirmed: contractConfirmed,
      canonicalUnit: contractConfirmed ? COOPRINSEM_MILK_CANONICAL_UNIT : null,
    },
    milkControlCandidateCount: workset.milkControls.length,
    milkControlReadyCount: milkReady,
    milkControlBlockedCount: workset.milkControls.length - milkReady,
    reproductiveServiceCandidateCount: workset.reproductiveServices.length,
    reproductiveServiceReadyCount: serviceReady,
    reproductiveServiceBlockedCount: workset.reproductiveServices.length - serviceReady,
    blockers: [...blockers].sort(),
  };
}

export function buildCooprinsemHistoryWorkset(entries, options = {}) {
  const milkByAnimalDate = new Map();
  const servicesByAnimalDate = new Map();

  entries.forEach((entry, index) => {
    const assessment = assessCooprinsemHistoricalRecord(entry.record, {
      effectiveAt: entry.effectiveAt,
      milkUnitContractVersion: options.milkUnitContractVersion,
    });
    const source = provenance(entry);
    if (assessment.milkControl) {
      const key = assessment.controlDate
        ? `${entry.animalId}:${assessment.controlDate}`
        : `${entry.animalId}:row:${entry.importRowId ?? index}`;
      const current = milkByAnimalDate.get(key) ?? { animalId: entry.animalId, candidates: [], sources: [] };
      current.candidates.push(assessment.milkControl);
      addSource(current.sources, source);
      milkByAnimalDate.set(key, current);
    }

    for (const service of assessment.reproductiveServices) {
      const key = service.occurredAt
        ? `${entry.animalId}:${service.occurredAt}`
        : `${entry.animalId}:row:${entry.importRowId ?? index}:${service.roles.join("+")}`;
      const current = servicesByAnimalDate.get(key) ?? { animalId: entry.animalId, candidates: [], sources: [] };
      current.candidates.push(service);
      addSource(current.sources, source);
      servicesByAnimalDate.set(key, current);
    }
  });

  const milkControls = [...milkByAnimalDate.entries()].map(([key, group]) => {
    const blockers = new Set(group.candidates.flatMap((candidate) => candidate.blockers));
    const fingerprints = new Set(group.candidates.map(milkFingerprint));
    if (fingerprints.size > 1) blockers.add("El mismo control lechero contiene valores distintos y requiere resolución.");
    const selected = group.candidates[0];
    return {
      key,
      animalId: group.animalId,
      controlDate: selected.controlDate,
      morningLiters: selected.morningLiters,
      afternoonLiters: selected.afternoonLiters,
      thirdMilkingLiters: selected.thirdMilkingLiters,
      totalLiters: selected.totalLiters,
      fatPct: selected.fatPct,
      proteinPct: selected.proteinPct,
      state: blockers.size === 0 ? "ready" : "blocked",
      blockers: [...blockers].sort(),
      sources: group.sources,
    };
  }).sort((left, right) => left.key.localeCompare(right.key));

  const reproductiveServices = [...servicesByAnimalDate.entries()].map(([key, group]) => {
    const blockers = new Set(group.candidates.flatMap((candidate) => candidate.blockers));
    const sires = new Set(group.candidates.map((candidate) => normalizedSire(candidate.sireIdentifier)).filter(Boolean));
    if (sires.size > 1) blockers.add("La misma cubierta tiene reproductores distintos y requiere resolución.");
    const roles = [...new Set(group.candidates.flatMap((candidate) => candidate.roles))].sort();
    const occurredAt = group.candidates.find((candidate) => candidate.occurredAt)?.occurredAt ?? null;
    const sireIdentifier = sires.size === 1
      ? group.candidates.map((candidate) => candidate.sireIdentifier).find((value) => normalizedSire(value) === [...sires][0]) ?? null
      : null;
    return {
      key,
      animalId: group.animalId,
      occurredAt,
      sireIdentifier,
      roles,
      state: blockers.size === 0 ? "ready" : "blocked",
      blockers: [...blockers].sort(),
      sources: group.sources,
    };
  }).sort((left, right) => left.key.localeCompare(right.key));

  return { milkControls, reproductiveServices };
}

function assessMilkControl(record, controlDate, milkUnitContractVersion) {
  const morningLiters = nonNegativeNumber(record?.LECHEAM);
  const afternoonLiters = nonNegativeNumber(record?.LECHEPM);
  const thirdMilkingLiters = nonNegativeNumber(record?.LECHE3RA);
  const sourceTotal = nonNegativeNumber(record?.LECHE);
  const measuredTotal = [morningLiters, afternoonLiters, thirdMilkingLiters]
    .filter((value) => value !== null)
    .reduce((sum, value) => sum + value, 0);
  const totalLiters = sourceTotal !== null && sourceTotal > 0 ? sourceTotal : measuredTotal;
  if (!(totalLiters > 0)) return null;

  const blockers = [];
  if (milkUnitContractVersion !== COOPRINSEM_MILK_UNIT_CONTRACT_VERSION) blockers.push(MILK_UNIT_BLOCKER);
  if (!controlDate) blockers.push(CONTROL_DATE_BLOCKER);
  return {
    state: blockers.length === 0 ? "ready" : "blocked",
    controlDate,
    morningLiters,
    afternoonLiters,
    thirdMilkingLiters,
    totalLiters,
    fatPct: percentage(record?.MGX100),
    proteinPct: percentage(record?.PTX100),
    blockers,
  };
}

function assessReproductiveServices(record, controlDate) {
  const dated = new Map();
  const undated = [];
  for (const fields of SERVICE_FIELDS) {
    const rawDate = text(record?.[fields.date]);
    const occurredAt = isoDate(rawDate);
    const sireIdentifier = text(record?.[fields.sire]) || null;
    if (!rawDate && !sireIdentifier) continue;
    if (!occurredAt) {
      undated.push({
        occurredAt: null,
        sireIdentifier,
        roles: [fields.role],
        state: "blocked",
        blockers: [`${fields.date} no contiene una fecha válida para la cubierta.`],
      });
      continue;
    }
    const current = dated.get(occurredAt) ?? { sires: new Map(), roles: [] };
    if (sireIdentifier) current.sires.set(normalizedSire(sireIdentifier), sireIdentifier);
    current.roles.push(fields.role);
    dated.set(occurredAt, current);
  }

  const services = [...dated.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([occurredAt, group]) => {
    const blockers = [];
    if (!controlDate) blockers.push(CONTROL_DATE_BLOCKER);
    else if (occurredAt > controlDate) blockers.push("La fecha de cubierta es posterior a la fecha de control.");
    if (group.sires.size > 1) blockers.push("La misma fecha de cubierta contiene reproductores distintos.");
    return {
      occurredAt,
      sireIdentifier: group.sires.size === 1 ? [...group.sires.values()][0] : null,
      roles: [...new Set(group.roles)].sort(),
      state: blockers.length === 0 ? "ready" : "blocked",
      blockers,
    };
  });
  return [...services, ...undated];
}

function provenance(entry) {
  return {
    importJobId: text(entry.importJobId) || null,
    importRowId: text(entry.importRowId) || null,
    sourceTable: text(entry.sourceTable) || null,
    sourceKey: text(entry.sourceKey) || null,
  };
}

function addSource(sources, candidate) {
  const key = `${candidate.importJobId ?? ""}:${candidate.importRowId ?? ""}`;
  if (!sources.some((source) => `${source.importJobId ?? ""}:${source.importRowId ?? ""}` === key)) sources.push(candidate);
}

function milkFingerprint(candidate) {
  return JSON.stringify([
    candidate.controlDate,
    candidate.morningLiters,
    candidate.afternoonLiters,
    candidate.thirdMilkingLiters,
    candidate.totalLiters,
    candidate.fatPct,
    candidate.proteinPct,
  ]);
}

function nonNegativeNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function percentage(value) {
  const number = nonNegativeNumber(value);
  return number !== null && number <= 15 ? number : null;
}

function normalizedSire(value) {
  return text(value).normalize("NFKC").toLocaleUpperCase("es");
}

function text(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function isoDate(value) {
  const candidate = text(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const date = new Date(`${candidate}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate ? candidate : null;
}
