import type { LivestockAnimal, LivestockExpense, LivestockLot, LivestockWeighing } from "@/src/core/domain/types";
import type { LivestockBirth, LivestockHealthEvent, LivestockReproductiveEvent } from "../ficha/domain/types";
import type { AnimalMargin, CalvingProjection, HerdOperations, HerdWorkItem, LotMargin, PedigreeNode, ReproductiveKpis } from "../domain/operations";

const DAY_MS = 86_400_000;
const GESTATION_DAYS = 283;
const DRY_PERIOD_DAYS = 60;
const DIAGNOSIS_DAYS = 35;

type OperationsInput = {
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  weighings: LivestockWeighing[];
  reproductiveEvents: LivestockReproductiveEvent[];
  births: LivestockBirth[];
  healthEvents: LivestockHealthEvent[];
  expenses: LivestockExpense[];
  now?: string;
};

type ProjectionEvent = Pick<
  LivestockReproductiveEvent,
  "animalId" | "eventType" | "occurredAt" | "result" | "sireIdentifier"
>;
type ProjectionBirth = Pick<LivestockBirth, "damAnimalId" | "occurredAt">;
type WorkItemHealthEvent = Pick<
  LivestockHealthEvent,
  | "animalId"
  | "status"
  | "occurredAt"
  | "withdrawalMilkUntil"
  | "withdrawalMeatUntil"
  | "productName"
  | "condition"
>;

type HerdWorkItemsInput = {
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  reproductiveEvents: ProjectionEvent[];
  births: ProjectionBirth[];
  healthEvents: WorkItemHealthEvent[];
  now?: string;
};

export function buildHerdOperations(input: OperationsInput): HerdOperations {
  const now = input.now ?? new Date().toISOString();
  const lots = new Map(input.lots.map((lot) => [lot.id, lot]));
  const animals = new Map(input.animals.map((animal) => [animal.id, animal]));
  const eventsByAnimal = groupBy(input.reproductiveEvents, (entry) => entry.animalId);
  const healthByAnimal = groupBy(input.healthEvents, (entry) => entry.animalId);
  const weighingsByAnimal = groupBy(input.weighings, (entry) => entry.animalId);
  const latestWeighingDateByAnimal = new Map(
    [...weighingsByAnimal].flatMap(([animalId, weighings]) => {
      const latest = [...weighings].sort(byDate("recordedAt")).at(-1);
      return latest ? [[animalId, latest.recordedAt] as const] : [];
    }),
  );
  const birthsByDam = groupBy(input.births, (entry) => entry.damAnimalId);
  const projections = buildProjections(input.animals, lots, eventsByAnimal, birthsByDam);
  const workItems = buildWorkItems(input.animals, lots, projections, healthByAnimal, latestWeighingDateByAnimal, now);
  const kpis = buildReproductiveKpis(input.animals, input.reproductiveEvents, input.births, now);
  const { animalMargins, lotMargins } = buildMargins(input.animals, input.lots, input.expenses);
  const pedigree = buildPedigree(input.animals, input.births, animals);
  return { generatedAt: now, workItems, projections, kpis, animalMargins, lotMargins, pedigree };
}

/** Builds only the operational queue consumed by the dashboard. */
export function buildDashboardHerdWorkItems(input: HerdWorkItemsInput): HerdWorkItem[] {
  const now = input.now ?? new Date().toISOString();
  const lots = new Map(input.lots.map((lot) => [lot.id, lot]));
  const eventsByAnimal = groupBy(input.reproductiveEvents, (entry) => entry.animalId);
  const birthsByDam = groupBy(input.births, (entry) => entry.damAnimalId);
  const healthByAnimal = groupBy(input.healthEvents, (entry) => entry.animalId);
  const latestWeighingDateByAnimal = new Map(
    input.animals.flatMap((animal) =>
      animal.latestWeightDate ? [[animal.id, animal.latestWeightDate] as const] : []),
  );
  const projections = buildProjections(input.animals, lots, eventsByAnimal, birthsByDam);
  return buildWorkItems(
    input.animals,
    lots,
    projections,
    healthByAnimal,
    latestWeighingDateByAnimal,
    now,
  );
}

function buildProjections(
  animals: LivestockAnimal[],
  lots: Map<string, LivestockLot>,
  eventsByAnimal: Map<string, ProjectionEvent[]>,
  birthsByDam: Map<string, ProjectionBirth[]>,
): CalvingProjection[] {
  const projections: CalvingProjection[] = [];
  for (const animal of animals) {
    if (animal.status !== "active" || animal.sex !== "female") continue;
    const events = [...(eventsByAnimal.get(animal.id) ?? [])].sort(byDate("occurredAt"));
    const service = [...events].reverse().find((entry) => entry.eventType === "service" || entry.eventType === "insemination");
    if (!service) continue;
    const laterEvents = events.filter((entry) => entry.occurredAt > service.occurredAt);
    if (laterEvents.some((entry) => entry.eventType === "calving" || entry.eventType === "abortion")) continue;
    if ((birthsByDam.get(animal.id) ?? []).some((entry) => entry.occurredAt > service.occurredAt)) continue;
    const diagnosis = [...laterEvents].reverse().find((entry) => entry.eventType === "pregnancy_diagnosis");
    if (diagnosis && !positiveResult(diagnosis.result)) continue;
    const confirmedPregnant = diagnosis ? positiveResult(diagnosis.result) : false;
    const lot = lots.get(animal.lotId);
    if (!lot) continue;
    const gestationDays = lot.category === "sheep" ? 147 : GESTATION_DAYS;
    projections.push({
      animalId: animal.id,
      animalTag: animal.tag,
      lotName: lot.name,
      fieldId: lot.fieldId,
      serviceDate: service.occurredAt,
      diagnosisDueDate: addDays(service.occurredAt, DIAGNOSIS_DAYS),
      dryOffDueDate: addDays(service.occurredAt, gestationDays - DRY_PERIOD_DAYS),
      calvingDueDate: addDays(service.occurredAt, gestationDays),
      confirmedPregnant,
      sireIdentifier: service.sireIdentifier,
    });
  }
  return projections.sort((left, right) => left.calvingDueDate.localeCompare(right.calvingDueDate));
}

function buildWorkItems(
  animals: LivestockAnimal[],
  lots: Map<string, LivestockLot>,
  projections: CalvingProjection[],
  healthByAnimal: Map<string, WorkItemHealthEvent[]>,
  latestWeighingDateByAnimal: Map<string, string>,
  now: string,
): HerdWorkItem[] {
  const today = now.slice(0, 10);
  const items: HerdWorkItem[] = [];
  const byId = new Map(animals.map((entry) => [entry.id, entry]));
  for (const projection of projections) {
    const animal = byId.get(projection.animalId);
    const lot = animal ? lots.get(animal.lotId) : null;
    if (!animal || !lot) continue;
    if (!projection.confirmedPregnant) {
      items.push(workItem(animal, lot, "pregnancy_check", projection.diagnosisDueDate, today, "Diagnóstico de preñez", `Servicio ${shortDate(projection.serviceDate)} sin confirmación registrada.`));
    } else {
      if (lot.category === "dairy_cow") items.push(workItem(animal, lot, "dry_off", projection.dryOffDueDate, today, "Preparar secado", `Parto estimado ${shortDate(projection.calvingDueDate)}.`));
      items.push(workItem(animal, lot, "calving", projection.calvingDueDate, today, "Parto próximo", `Gestación calculada desde ${shortDate(projection.serviceDate)}.`));
    }
  }
  for (const animal of animals) {
    if (animal.status !== "active") continue;
    const lot = lots.get(animal.lotId);
    if (!lot) continue;
    const health = healthByAnimal.get(animal.id) ?? [];
    const withdrawals: { until: string; detail: string }[] = [];
    for (const entry of health) {
      if (entry.status === "cancelled") continue;
      const withdrawal = [entry.withdrawalMilkUntil, entry.withdrawalMeatUntil].filter((value): value is string => Boolean(value)).sort().at(-1);
      if (withdrawal && withdrawal >= today) withdrawals.push({ until: withdrawal, detail: entry.productName || entry.condition || "Tratamiento" });
      if (entry.status === "open" && daysBetween(entry.occurredAt, today) > 7) items.push(workItem(animal, lot, "health_follow_up", addDays(entry.occurredAt, 7), today, "Seguimiento sanitario", `${entry.condition || "Evento abierto"} sigue pendiente.`));
    }
    const activeWithdrawal = withdrawals.sort((left, right) => right.until.localeCompare(left.until))[0];
    if (activeWithdrawal) items.push(workItem(animal, lot, "withdrawal", activeWithdrawal.until, today, "Resguardo activo", `${activeWithdrawal.detail}: no liberar antes de ${shortDate(activeWithdrawal.until)}.`));
    const latestWeighingDate = latestWeighingDateByAnimal.get(animal.id) ?? null;
    const due = latestWeighingDate ? addDays(latestWeighingDate, 120) : today;
    if (!latestWeighingDate || due <= addDays(today, 14)) items.push(workItem(animal, lot, "weighing", due, today, "Pesaje pendiente", latestWeighingDate ? `Último pesaje ${shortDate(latestWeighingDate)}.` : "Sin pesajes registrados."));
  }
  const rank = { overdue: 0, today: 1, soon: 2, watch: 3 } as const;
  return items.sort((left, right) => rank[left.priority] - rank[right.priority] || left.dueDate.localeCompare(right.dueDate) || left.animalTag.localeCompare(right.animalTag, "es"));
}

function buildReproductiveKpis(animals: LivestockAnimal[], events: LivestockReproductiveEvent[], births: LivestockBirth[], now: string): ReproductiveKpis {
  const cutoff = addDays(now.slice(0, 10), -365);
  const females = animals.filter((entry) => entry.sex === "female" && entry.status === "active");
  const recent = events.filter((entry) => entry.occurredAt >= cutoff);
  const services = recent.filter((entry) => entry.eventType === "service" || entry.eventType === "insemination");
  const served = new Set(services.map((entry) => entry.animalId));
  const confirmed = new Set(recent.filter((entry) => entry.eventType === "pregnancy_diagnosis" && positiveResult(entry.result)).map((entry) => entry.animalId));
  const byDam = groupBy(births, (entry) => entry.damAnimalId);
  const intervals: number[] = [];
  for (const entries of byDam.values()) {
    const sorted = [...entries].sort(byDate("occurredAt"));
    for (let index = 1; index < sorted.length; index += 1) intervals.push(daysBetween(sorted[index - 1].occurredAt, sorted[index].occurredAt));
  }
  const recentBirths = births.filter((entry) => entry.occurredAt >= cutoff);
  const difficult = recentBirths.filter((entry) => entry.difficulty === "assisted" || entry.difficulty === "dystocia").length;
  return {
    eligibleFemales: females.length,
    servedFemales: served.size,
    confirmedPregnancies: confirmed.size,
    pregnancyRatePct: served.size ? round((confirmed.size / served.size) * 100, 1) : null,
    servicesPerConception: confirmed.size ? round(services.length / confirmed.size, 2) : null,
    averageCalvingIntervalDays: intervals.length ? Math.round(average(intervals)) : null,
    difficultBirthRatePct: recentBirths.length ? round((difficult / recentBirths.length) * 100, 1) : null,
  };
}

function buildMargins(animals: LivestockAnimal[], lots: LivestockLot[], expenses: LivestockExpense[]): { animalMargins: AnimalMargin[]; lotMargins: LotMargin[] } {
  const lotsById = new Map(lots.map((entry) => [entry.id, entry]));
  const animalCountByLot = new Map<string, number>();
  for (const animal of animals) animalCountByLot.set(animal.lotId, (animalCountByLot.get(animal.lotId) ?? 0) + 1);
  const animalMargins = animals.filter((entry) => entry.status === "sold" && entry.salePriceClp !== null).map((animal) => {
    const lot = lotsById.get(animal.lotId);
    const eligibleExpenses = expenses.filter((expense) => expense.lotId === animal.lotId && expense.category !== "compra_animales" && (!animal.statusDate || !expense.date || expense.date <= animal.statusDate));
    const allocatedExpenseClp = Math.round(sum(eligibleExpenses.map((entry) => entry.amountClp)) / Math.max(1, animalCountByLot.get(animal.lotId) ?? 1));
    const purchasePriceClp = animal.purchasePriceClp ?? 0;
    const marginClp = (animal.salePriceClp ?? 0) - purchasePriceClp - allocatedExpenseClp;
    return {
      animalId: animal.id, animalTag: animal.tag, lotId: animal.lotId, lotName: lot?.name ?? animal.lotId,
      salePriceClp: animal.salePriceClp ?? 0, purchasePriceClp, allocatedExpenseClp, marginClp,
      saleWeightKg: animal.saleWeightKg, marginPerKgClp: animal.saleWeightKg ? Math.round(marginClp / animal.saleWeightKg) : null,
      buyer: animal.saleBuyer,
    };
  }).sort((left, right) => right.marginClp - left.marginClp);
  const grouped = groupBy(animalMargins, (entry) => entry.lotId);
  const lotMargins: LotMargin[] = [...grouped].map(([lotId, entries]) => ({
    lotId, lotName: entries[0]?.lotName ?? lotId, soldAnimals: entries.length,
    revenueClp: sum(entries.map((entry) => entry.salePriceClp)), purchaseCostClp: sum(entries.map((entry) => entry.purchasePriceClp)),
    allocatedExpenseClp: sum(entries.map((entry) => entry.allocatedExpenseClp)), marginClp: sum(entries.map((entry) => entry.marginClp)),
  }));
  return { animalMargins, lotMargins };
}

function buildPedigree(animals: LivestockAnimal[], births: LivestockBirth[], animalsById: Map<string, LivestockAnimal>): PedigreeNode[] {
  const parentsByChild = new Map<string, { damAnimalId: string; sireAnimalId: string | null; sireIdentifier: string | null }>();
  for (const birth of births) for (const offspring of birth.offspring) if (offspring.animalId) parentsByChild.set(offspring.animalId, { damAnimalId: birth.damAnimalId, sireAnimalId: birth.sireAnimalId, sireIdentifier: birth.sireIdentifier });
  const tag = (id: string | null) => id ? animalsById.get(id)?.tag ?? id : null;
  return animals.map((animal) => {
    const parents = parentsByChild.get(animal.id);
    const maternal = parents ? parentsByChild.get(parents.damAnimalId) : null;
    const paternal = parents?.sireAnimalId ? parentsByChild.get(parents.sireAnimalId) : null;
    return {
      animalId: animal.id, animalTag: animal.tag,
      damAnimalId: parents?.damAnimalId ?? null, damTag: tag(parents?.damAnimalId ?? null),
      sireAnimalId: parents?.sireAnimalId ?? null, sireTag: tag(parents?.sireAnimalId ?? null) ?? parents?.sireIdentifier ?? null,
      maternalGranddamTag: tag(maternal?.damAnimalId ?? null), maternalGrandsireTag: tag(maternal?.sireAnimalId ?? null) ?? maternal?.sireIdentifier ?? null,
      paternalGranddamTag: tag(paternal?.damAnimalId ?? null), paternalGrandsireTag: tag(paternal?.sireAnimalId ?? null) ?? paternal?.sireIdentifier ?? null,
    };
  }).filter((entry) => entry.damTag || entry.sireTag);
}

function workItem(animal: LivestockAnimal, lot: LivestockLot, kind: HerdWorkItem["kind"], dueDate: string, today: string, title: string, detail: string): HerdWorkItem {
  const days = daysBetween(today, dueDate);
  const priority = dueDate < today ? "overdue" : dueDate === today ? "today" : days <= 14 ? "soon" : "watch";
  return { id: `${kind}:${animal.id}:${dueDate}`, kind, animalId: animal.id, animalTag: animal.tag, lotId: lot.id, lotName: lot.name, fieldId: lot.fieldId, dueDate, priority, title, detail };
}

function groupBy<T>(entries: T[], key: (entry: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) groups.set(key(entry), [...(groups.get(key(entry)) ?? []), entry]);
  return groups;
}
function positiveResult(value: string | null): boolean { return /positiv|preñ|pren|gestante|confirmad/i.test(value ?? ""); }
function byDate<T>(field: keyof T) { return (left: T, right: T) => String(left[field]).localeCompare(String(right[field])); }
function addDays(value: string, days: number): string { const date = new Date(`${value.slice(0, 10)}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function daysBetween(left: string, right: string): number { return Math.round((new Date(`${right.slice(0, 10)}T12:00:00Z`).getTime() - new Date(`${left.slice(0, 10)}T12:00:00Z`).getTime()) / DAY_MS); }
function shortDate(value: string): string { const [year, month, day] = value.slice(0, 10).split("-"); return `${day}-${month}-${year}`; }
function average(values: number[]): number { return sum(values) / Math.max(1, values.length); }
function sum(values: number[]): number { return values.reduce((total, value) => total + value, 0); }
function round(value: number, digits: number): number { const factor = 10 ** digits; return Math.round(value * factor) / factor; }
