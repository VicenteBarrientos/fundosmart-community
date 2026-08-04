import type {
  Fundo,
  LivestockAnimal,
  LivestockCategory,
  LivestockFeedingPlan,
  LivestockLot,
  Potrero,
} from "@/src/core/domain/types";

export type ForageObservationSource = "manual" | "imported";

export type ForageObservation = {
  id: string;
  paddockId: string;
  observedAt: string;
  ndvi: number | null;
  biomassKgDmHa: number | null;
  utilizationPct: number;
  source: ForageObservationSource;
  notes: string;
  createdAt: string;
};

export type ParsedForageObservation = Omit<ForageObservation, "id" | "paddockId" | "createdAt"> & {
  paddockRef: string;
  line: number;
};

export type RejectedForageRow = {
  line: number;
  reason: string;
};

export type ForageAssumptions = {
  intakePctLiveWeight: number;
  supplementDryMatterPct: number;
  defaultUtilizationPct: number;
  bareSoilNdvi: number;
  kgDmHaPerNdviUnit: number;
};

export const DEFAULT_FORAGE_ASSUMPTIONS: ForageAssumptions = Object.freeze({
  intakePctLiveWeight: 2.5,
  supplementDryMatterPct: 90,
  defaultUtilizationPct: 70,
  bareSoilNdvi: 0.2,
  kgDmHaPerNdviUnit: 4_000,
});

export type LotForageDemand = {
  lotId: string;
  lotName: string;
  paddockId: string | null;
  headCount: number;
  averageWeightKg: number;
  grossDemandKgDmDay: number;
  supplementKgDay: number;
  supplementKgDmDay: number;
  pastureDemandKgDmDay: number;
};

export type PotreroForageBudget = {
  paddockId: string;
  paddockName: string;
  fieldId: string;
  fieldName: string;
  areaHectares: number;
  observation: ForageObservation | null;
  biomassKgDmHa: number | null;
  biomassBasis: "observed_biomass" | "ndvi_estimate" | "unavailable";
  grossOfferKgDm: number | null;
  usableOfferKgDm: number | null;
  dailyDemandKgDm: number;
  coverageDays: number | null;
  lots: LotForageDemand[];
};

export type ForageBudget = {
  potreros: PotreroForageBudget[];
  lots: LotForageDemand[];
  totalOfferKgDm: number;
  totalDemandKgDmDay: number;
  assignedDemandKgDmDay: number;
  unassignedDemandKgDmDay: number;
  coverageDays: number | null;
  observedPaddocks: number;
};

type ParseForageOptions = {
  defaultObservedAt?: string;
  defaultUtilizationPct?: number;
};

type BuildForageBudgetInput = {
  fundos: Fundo[];
  potreros: Potrero[];
  lots: LivestockLot[];
  animals: LivestockAnimal[];
  feedingPlans: LivestockFeedingPlan[];
  observations: ForageObservation[];
  assumptions?: Partial<ForageAssumptions>;
};

const DEFAULT_WEIGHT_BY_CATEGORY: Record<LivestockCategory, number> = {
  dairy_cow: 550,
  dry_cow: 600,
  heifer: 350,
  calf: 120,
  steer: 420,
  bull: 800,
  sheep: 60,
  other: 350,
};

const HEADER_ALIASES = {
  paddock: ["potrero", "potreroid", "nombrepotrero", "paddock", "paddockid"],
  date: ["fecha", "observadoen", "fechamedicion", "observedat", "date"],
  ndvi: ["ndvi", "indicendvi"],
  biomass: ["biomasa", "biomasakgmsha", "kgmsha", "kgmshectarea", "drymatterkgha", "biomass", "biomasskgdmha"],
  utilization: ["aprovechamiento", "utilizacion", "utilizacionpct", "porcentajeaprovechamiento", "utilization", "utilizationpct"],
  notes: ["nota", "notas", "observacion", "observaciones", "notes"],
} as const;

export function parseForageObservations(content: string, options: ParseForageOptions = {}): {
  observations: ParsedForageObservation[];
  rejected: RejectedForageRow[];
} {
  const physicalLines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  const firstLineIndex = physicalLines.findIndex((line) => line.trim().length > 0);
  if (firstLineIndex < 0) return { observations: [], rejected: [] };

  const delimiter = detectDelimiter(physicalLines[firstLineIndex]);
  const firstCells = splitDelimitedLine(physicalLines[firstLineIndex], delimiter);
  const normalizedHeaders = firstCells.map(normalizeHeader);
  const indexes = {
    paddock: findHeader(normalizedHeaders, HEADER_ALIASES.paddock),
    date: findHeader(normalizedHeaders, HEADER_ALIASES.date),
    ndvi: findHeader(normalizedHeaders, HEADER_ALIASES.ndvi),
    biomass: findHeader(normalizedHeaders, HEADER_ALIASES.biomass),
    utilization: findHeader(normalizedHeaders, HEADER_ALIASES.utilization),
    notes: findHeader(normalizedHeaders, HEADER_ALIASES.notes),
  };
  const hasHeader = Object.values(indexes).some((index) => index >= 0);
  const observations: ParsedForageObservation[] = [];
  const rejected: RejectedForageRow[] = [];
  const start = hasHeader ? firstLineIndex + 1 : firstLineIndex;
  const defaultUtilizationPct = finiteOr(options.defaultUtilizationPct, DEFAULT_FORAGE_ASSUMPTIONS.defaultUtilizationPct);

  for (let index = start; index < physicalLines.length; index += 1) {
    const rawLine = physicalLines[index];
    if (!rawLine.trim()) continue;
    const line = index + 1;
    const cells = splitDelimitedLine(rawLine, delimiter);
    const paddockRef = cell(cells, indexes.paddock, hasHeader ? -1 : 0);
    const observedAt = cell(cells, indexes.date, hasHeader ? -1 : 1) || options.defaultObservedAt || "";
    const rawNdvi = cell(cells, indexes.ndvi, hasHeader ? -1 : 2);
    const rawBiomass = cell(cells, indexes.biomass, hasHeader ? -1 : 3);
    const rawUtilization = cell(cells, indexes.utilization, hasHeader ? -1 : 4);
    const notes = cell(cells, indexes.notes, hasHeader ? -1 : 5);
    const ndvi = rawNdvi ? parseLocaleNumber(rawNdvi) : null;
    const biomassKgDmHa = rawBiomass ? parseLocaleNumber(rawBiomass) : null;
    const utilizationPct = rawUtilization ? parseLocaleNumber(rawUtilization.replace(/%$/, "")) : defaultUtilizationPct;

    if (!paddockRef) {
      rejected.push({ line, reason: "Falta el potrero." });
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(observedAt)) {
      rejected.push({ line, reason: "La fecha debe usar formato AAAA-MM-DD." });
      continue;
    }
    if (rawNdvi && (ndvi === null || ndvi < 0 || ndvi > 1)) {
      rejected.push({ line, reason: "NDVI debe estar entre 0 y 1." });
      continue;
    }
    if (rawBiomass && (biomassKgDmHa === null || biomassKgDmHa <= 0)) {
      rejected.push({ line, reason: "La biomasa debe ser mayor que cero kg MS/ha." });
      continue;
    }
    if (ndvi === null && biomassKgDmHa === null) {
      rejected.push({ line, reason: "Ingresa NDVI o biomasa." });
      continue;
    }
    if (utilizationPct === null || utilizationPct <= 0 || utilizationPct > 100) {
      rejected.push({ line, reason: "El aprovechamiento debe estar entre 0 y 100%." });
      continue;
    }

    observations.push({
      paddockRef,
      observedAt,
      ndvi,
      biomassKgDmHa,
      utilizationPct,
      source: "imported",
      notes,
      line,
    });
  }

  return { observations, rejected };
}

export function calculateLotForageDemand(input: {
  lot: LivestockLot;
  animals: LivestockAnimal[];
  feedingPlan?: LivestockFeedingPlan;
  assumptions?: Partial<ForageAssumptions>;
}): LotForageDemand {
  const assumptions = resolveAssumptions(input.assumptions);
  const activeAnimals = input.animals.filter((animal) => animal.lotId === input.lot.id && animal.status === "active");
  const headCount = Math.max(0, input.lot.trackingMode === "individual" && activeAnimals.length > 0
    ? activeAnimals.length
    : input.lot.animalCount);
  const measuredWeights = activeAnimals
    .map((animal) => animal.latestWeightKg)
    .filter((weight): weight is number => weight !== null && Number.isFinite(weight) && weight > 0);
  const averageWeightKg = measuredWeights.length > 0
    ? measuredWeights.reduce((sum, weight) => sum + weight, 0) / measuredWeights.length
    : positiveOr(input.lot.averageWeightKg, DEFAULT_WEIGHT_BY_CATEGORY[input.lot.category]);
  const grossDemandKgDmDay = headCount * averageWeightKg * (assumptions.intakePctLiveWeight / 100);
  const supplementKgDay = headCount * Math.max(0, finiteOr(input.feedingPlan?.kgPerAnimalDay, 0));
  const supplementKgDmDay = supplementKgDay * (assumptions.supplementDryMatterPct / 100);

  return {
    lotId: input.lot.id,
    lotName: input.lot.name,
    paddockId: input.lot.paddockId,
    headCount,
    averageWeightKg: round(averageWeightKg),
    grossDemandKgDmDay: round(grossDemandKgDmDay),
    supplementKgDay: round(supplementKgDay),
    supplementKgDmDay: round(supplementKgDmDay),
    pastureDemandKgDmDay: round(Math.max(0, grossDemandKgDmDay - supplementKgDmDay)),
  };
}

export function estimateBiomassFromNdvi(ndvi: number, assumptions: Partial<ForageAssumptions> = {}): number {
  const resolved = resolveAssumptions(assumptions);
  if (!Number.isFinite(ndvi) || ndvi < 0 || ndvi > 1) return 0;
  return round(Math.max(0, ndvi - resolved.bareSoilNdvi) * resolved.kgDmHaPerNdviUnit);
}

export function buildForageBudget(input: BuildForageBudgetInput): ForageBudget {
  const assumptions = resolveAssumptions(input.assumptions);
  const planByLot = new Map(input.feedingPlans.map((plan) => [plan.lotId, plan]));
  const lots = input.lots
    .filter((lot) => lot.status === "active")
    .map((lot) => calculateLotForageDemand({ lot, animals: input.animals, feedingPlan: planByLot.get(lot.id), assumptions }));
  const lotsByPaddock = new Map<string, LotForageDemand[]>();
  for (const lot of lots) {
    if (!lot.paddockId) continue;
    lotsByPaddock.set(lot.paddockId, [...(lotsByPaddock.get(lot.paddockId) ?? []), lot]);
  }
  const fieldById = new Map(input.fundos.map((fundo) => [fundo.id, fundo]));
  const observationsByPaddock = new Map<string, ForageObservation[]>();
  for (const observation of input.observations) {
    observationsByPaddock.set(observation.paddockId, [...(observationsByPaddock.get(observation.paddockId) ?? []), observation]);
  }

  const potreros = input.potreros.map((potrero): PotreroForageBudget => {
    const observation = latestObservation(observationsByPaddock.get(potrero.id) ?? []);
    const paddockLots = lotsByPaddock.get(potrero.id) ?? [];
    const dailyDemandKgDm = paddockLots.reduce((sum, lot) => sum + lot.pastureDemandKgDmDay, 0);
    const biomassKgDmHa = observation?.biomassKgDmHa !== null && observation?.biomassKgDmHa !== undefined
      ? observation.biomassKgDmHa
      : observation?.ndvi !== null && observation?.ndvi !== undefined
        ? estimateBiomassFromNdvi(observation.ndvi, assumptions)
        : null;
    const biomassBasis = observation?.biomassKgDmHa !== null && observation?.biomassKgDmHa !== undefined
      ? "observed_biomass"
      : observation?.ndvi !== null && observation?.ndvi !== undefined
        ? "ndvi_estimate"
        : "unavailable";
    const grossOfferKgDm = biomassKgDmHa === null ? null : biomassKgDmHa * Math.max(0, potrero.areaHectares);
    const usableOfferKgDm = grossOfferKgDm === null
      ? null
      : grossOfferKgDm * ((observation?.utilizationPct ?? assumptions.defaultUtilizationPct) / 100);

    return {
      paddockId: potrero.id,
      paddockName: potrero.name,
      fieldId: potrero.fieldId,
      fieldName: fieldById.get(potrero.fieldId)?.name ?? "Fundo sin identificar",
      areaHectares: potrero.areaHectares,
      observation,
      biomassKgDmHa: biomassKgDmHa === null ? null : round(biomassKgDmHa),
      biomassBasis,
      grossOfferKgDm: grossOfferKgDm === null ? null : round(grossOfferKgDm),
      usableOfferKgDm: usableOfferKgDm === null ? null : round(usableOfferKgDm),
      dailyDemandKgDm: round(dailyDemandKgDm),
      coverageDays: usableOfferKgDm === null || dailyDemandKgDm <= 0 ? null : round(usableOfferKgDm / dailyDemandKgDm, 1),
      lots: paddockLots,
    };
  });

  const totalOfferKgDm = potreros.reduce((sum, potrero) => sum + (potrero.usableOfferKgDm ?? 0), 0);
  const assignedDemandKgDmDay = lots.filter((lot) => lot.paddockId !== null).reduce((sum, lot) => sum + lot.pastureDemandKgDmDay, 0);
  const unassignedDemandKgDmDay = lots.filter((lot) => lot.paddockId === null).reduce((sum, lot) => sum + lot.pastureDemandKgDmDay, 0);
  const totalDemandKgDmDay = assignedDemandKgDmDay + unassignedDemandKgDmDay;
  const observedPaddocks = potreros.filter((potrero) => potrero.observation !== null).length;

  return {
    potreros,
    lots,
    totalOfferKgDm: round(totalOfferKgDm),
    totalDemandKgDmDay: round(totalDemandKgDmDay),
    assignedDemandKgDmDay: round(assignedDemandKgDmDay),
    unassignedDemandKgDmDay: round(unassignedDemandKgDmDay),
    coverageDays: observedPaddocks === 0 || totalDemandKgDmDay <= 0 ? null : round(totalOfferKgDm / totalDemandKgDmDay, 1),
    observedPaddocks,
  };
}

export function forageStorageKey(offlineScope: string): string {
  const scope = offlineScope.trim();
  if (!scope) throw new Error("offlineScope es obligatorio para aislar las observaciones forrajeras.");
  return `fundosmart:forage-observations:v1:${encodeURIComponent(scope)}`;
}

function latestObservation(observations: ForageObservation[]): ForageObservation | null {
  return [...observations].sort((left, right) => {
    const byDate = right.observedAt.localeCompare(left.observedAt);
    return byDate || right.createdAt.localeCompare(left.createdAt);
  })[0] ?? null;
}

function resolveAssumptions(input: Partial<ForageAssumptions> = {}): ForageAssumptions {
  return {
    intakePctLiveWeight: positiveOr(input.intakePctLiveWeight, DEFAULT_FORAGE_ASSUMPTIONS.intakePctLiveWeight),
    supplementDryMatterPct: clamp(finiteOr(input.supplementDryMatterPct, DEFAULT_FORAGE_ASSUMPTIONS.supplementDryMatterPct), 0, 100),
    defaultUtilizationPct: clamp(positiveOr(input.defaultUtilizationPct, DEFAULT_FORAGE_ASSUMPTIONS.defaultUtilizationPct), 0, 100),
    bareSoilNdvi: clamp(finiteOr(input.bareSoilNdvi, DEFAULT_FORAGE_ASSUMPTIONS.bareSoilNdvi), 0, 1),
    kgDmHaPerNdviUnit: positiveOr(input.kgDmHaPerNdviUnit, DEFAULT_FORAGE_ASSUMPTIONS.kgDmHaPerNdviUnit),
  };
}

function detectDelimiter(line: string): string {
  const candidates = [";", "\t", ","];
  return candidates
    .map((delimiter, order) => ({ delimiter, order, count: countOutsideQuotes(line, delimiter) }))
    .sort((left, right) => right.count - left.count || left.order - right.order)[0].delimiter;
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) count += 1;
  }
  return count;
}

function splitDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === delimiter && !quoted) {
      cells.push(value.trim());
      value = "";
    } else value += character;
  }
  cells.push(value.trim());
  return cells;
}

function findHeader(headers: string[], aliases: readonly string[]): number {
  return headers.findIndex((header) => aliases.includes(header));
}

function normalizeHeader(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cell(cells: string[], headerIndex: number, fallbackIndex: number): string {
  return String(cells[headerIndex >= 0 ? headerIndex : fallbackIndex] ?? "").trim();
}

function parseLocaleNumber(value: string): number | null {
  const compactValue = value.trim().replace(/\s/g, "");
  if (!compactValue) return null;
  const comma = compactValue.lastIndexOf(",");
  const dot = compactValue.lastIndexOf(".");
  let normalized = compactValue;
  if (comma >= 0 && dot >= 0) {
    const decimalSeparator = comma > dot ? "," : ".";
    const thousandsSeparator = decimalSeparator === "," ? "." : ",";
    normalized = normalized.replaceAll(thousandsSeparator, "").replace(decimalSeparator, ".");
  } else if (comma >= 0) normalized = normalized.replace(",", ".");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
