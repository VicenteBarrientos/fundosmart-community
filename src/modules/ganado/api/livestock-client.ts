import type {
  LivestockAnimal,
  LivestockContribution,
  LivestockExpense,
  LivestockFeedConsumption,
  LivestockFeedInventory,
  LivestockFinanceAuditEntry,
  LivestockFeedingPlan,
  LivestockLot,
  LivestockPartner,
  LivestockWeighing,
} from "@/src/core/domain/types";
import type { HerdOperations } from "../domain/operations";
import type { HealthEventInput } from "../ficha/domain/types";

export type FinanceMutationResult<T> = { value: T; auditEntry: LivestockFinanceAuditEntry };
export type FinanceDeleteResult = { deleted: boolean; auditEntry: LivestockFinanceAuditEntry | null };

export async function persistLivestockLot(lot: LivestockLot): Promise<LivestockLot> {
  const response = await fetch("/api/ganado", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(lot),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar el lote ganadero."));
  const payload = (await response.json()) as { lot: LivestockLot };
  return payload.lot;
}

export async function removeLivestockLot(id: string, updatedAt: string): Promise<void> {
  const query = new URLSearchParams({ id, updatedAt });
  const response = await fetch(`/api/ganado?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el lote ganadero."));
}

export async function persistLivestockAnimal(animal: LivestockAnimal): Promise<{ animal: LivestockAnimal; lots: LivestockLot[] }> {
  const response = await fetch("/api/ganado/animales", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(animal),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar el animal."));
  return response.json() as Promise<{ animal: LivestockAnimal; lots: LivestockLot[] }>;
}

export type AnimalSpreadsheetResult = {
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  savedIds: string[];
  weighings: LivestockWeighing[];
};

/**
 * Error de una confirmación que alcanzó a guardar parte de la planilla.
 *
 * Lleva `savedIds` para que el borrador se pode y el reintento no repita lo ya escrito,
 * y el snapshot para que la pantalla no siga mostrando datos viejos tras el choque.
 */
export class AnimalSpreadsheetError extends Error {
  readonly failedAnimalId: string | null;
  readonly savedIds: string[];
  readonly snapshot: Omit<AnimalSpreadsheetResult, "savedIds"> | null;

  constructor(
    message: string,
    failedAnimalId: string | null,
    savedIds: string[],
    snapshot: Omit<AnimalSpreadsheetResult, "savedIds"> | null,
  ) {
    super(message);
    this.name = "AnimalSpreadsheetError";
    this.failedAnimalId = failedAnimalId;
    this.savedIds = savedIds;
    this.snapshot = snapshot;
  }
}

export async function persistAnimalSpreadsheet(animals: LivestockAnimal[]): Promise<AnimalSpreadsheetResult> {
  const response = await fetch("/api/ganado/animales/planilla", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ animals }),
  });
  const payload = await response.json().catch(() => null) as
    | (Partial<AnimalSpreadsheetResult> & { error?: string; failedAnimalId?: string | null })
    | null;

  if (!response.ok) {
    throw new AnimalSpreadsheetError(
      payload?.error ?? "No fue posible confirmar la planilla.",
      payload?.failedAnimalId ?? null,
      payload?.savedIds ?? [],
      payload?.animals && payload.lots && payload.weighings
        ? { animals: payload.animals, lots: payload.lots, weighings: payload.weighings }
        : null,
    );
  }
  return {
    animals: payload?.animals ?? [],
    lots: payload?.lots ?? [],
    savedIds: payload?.savedIds ?? [],
    weighings: payload?.weighings ?? [],
  };
}

export async function removeLivestockAnimal(id: string, snapshotToken: string): Promise<LivestockLot[]> {
  const query = new URLSearchParams({ id, snapshotToken });
  const response = await fetch(`/api/ganado/animales?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el animal."));
  const payload = (await response.json()) as { lots: LivestockLot[] };
  return payload.lots;
}

export type WeighingSessionInput = {
  lotId: string;
  recordedAt: string;
  notes: string;
  entries: { animalId: string; weightKg: number; snapshotToken: string | null }[];
};

export type WeighingSessionResult = {
  weighings: LivestockWeighing[];
  lots: LivestockLot[];
  animals: LivestockAnimal[];
};

export async function persistWeighingSession(session: WeighingSessionInput): Promise<WeighingSessionResult> {
  const response = await fetch("/api/ganado/pesajes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(session),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible registrar la sesión de pesaje."));
  return response.json() as Promise<WeighingSessionResult>;
}

export async function removeWeighing(id: string, snapshotToken: string): Promise<WeighingSessionResult> {
  const query = new URLSearchParams({ id, snapshotToken });
  const response = await fetch(`/api/ganado/pesajes?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el pesaje."));
  return response.json() as Promise<WeighingSessionResult>;
}

export async function persistLivestockPartner(partner: LivestockPartner): Promise<FinanceMutationResult<LivestockPartner>> {
  const response = await fetch("/api/ganado/plata/socios", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partner),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar el socio."));
  const payload = (await response.json()) as { partner: LivestockPartner; auditEntry: LivestockFinanceAuditEntry };
  return { value: payload.partner, auditEntry: payload.auditEntry };
}

export async function removeLivestockPartner(id: string, snapshotToken: string): Promise<FinanceDeleteResult> {
  const query = new URLSearchParams({ id, snapshotToken });
  const response = await fetch(`/api/ganado/plata/socios?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el socio."));
  return response.json() as Promise<FinanceDeleteResult>;
}

export async function persistLivestockContribution(contribution: LivestockContribution): Promise<FinanceMutationResult<LivestockContribution>> {
  const response = await fetch("/api/ganado/plata/aportes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(contribution),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar el aporte."));
  const payload = (await response.json()) as { contribution: LivestockContribution; auditEntry: LivestockFinanceAuditEntry };
  return { value: payload.contribution, auditEntry: payload.auditEntry };
}

export async function removeLivestockContribution(id: string, snapshotToken: string): Promise<FinanceDeleteResult> {
  const query = new URLSearchParams({ id, snapshotToken });
  const response = await fetch(`/api/ganado/plata/aportes?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el aporte."));
  return response.json() as Promise<FinanceDeleteResult>;
}

export async function persistLivestockExpense(expense: LivestockExpense): Promise<FinanceMutationResult<LivestockExpense>> {
  const response = await fetch("/api/ganado/plata/egresos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(expense),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar el egreso."));
  const payload = (await response.json()) as { expense: LivestockExpense; auditEntry: LivestockFinanceAuditEntry };
  return { value: payload.expense, auditEntry: payload.auditEntry };
}

export type ExpenseSpreadsheetResult = {
  auditEntries: LivestockFinanceAuditEntry[];
  expenses: LivestockExpense[];
  savedIds: string[];
};

/** Igual que en animales: el error lleva lo que alcanzó a guardarse para poder reintentar. */
export class ExpenseSpreadsheetError extends Error {
  readonly auditEntries: LivestockFinanceAuditEntry[];
  readonly expenses: LivestockExpense[];
  readonly failedExpenseId: string | null;
  readonly savedIds: string[];

  constructor(
    message: string,
    failedExpenseId: string | null,
    savedIds: string[],
    expenses: LivestockExpense[],
    auditEntries: LivestockFinanceAuditEntry[],
  ) {
    super(message);
    this.name = "ExpenseSpreadsheetError";
    this.auditEntries = auditEntries;
    this.expenses = expenses;
    this.failedExpenseId = failedExpenseId;
    this.savedIds = savedIds;
  }
}

export async function persistExpenseSpreadsheet(expenses: LivestockExpense[]): Promise<ExpenseSpreadsheetResult> {
  const response = await fetch("/api/ganado/plata/egresos/planilla", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expenses }),
  });
  const payload = await response.json().catch(() => null) as
    | (Partial<ExpenseSpreadsheetResult> & { error?: string; failedExpenseId?: string | null })
    | null;

  if (!response.ok) {
    throw new ExpenseSpreadsheetError(
      payload?.error ?? "No fue posible confirmar la planilla de egresos.",
      payload?.failedExpenseId ?? null,
      payload?.savedIds ?? [],
      payload?.expenses ?? [],
      payload?.auditEntries ?? [],
    );
  }
  return {
    auditEntries: payload?.auditEntries ?? [],
    expenses: payload?.expenses ?? [],
    savedIds: payload?.savedIds ?? [],
  };
}

export async function removeLivestockExpense(id: string): Promise<FinanceDeleteResult> {
  const response = await fetch(`/api/ganado/plata/egresos?id=${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el egreso."));
  return response.json() as Promise<FinanceDeleteResult>;
}

export async function persistLivestockFeedingPlan(plan: LivestockFeedingPlan): Promise<LivestockFeedingPlan> {
  const response = await fetch("/api/ganado/racion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(plan),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar el plan de alimentación."));
  const payload = (await response.json()) as { plan: LivestockFeedingPlan };
  return payload.plan;
}

export async function removeLivestockFeedingPlan(id: string, updatedAt: string): Promise<void> {
  const query = new URLSearchParams({ id, updatedAt });
  const response = await fetch(`/api/ganado/racion?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar el plan de alimentación."));
}

export async function fetchHerdOperations(): Promise<HerdOperations> {
  const response = await fetch("/api/ganado/operaciones", { cache: "no-store" });
  const payload = await response.json() as { error?: string; operations?: HerdOperations };
  if (!response.ok || !payload.operations) throw new Error(payload.error ?? "No fue posible actualizar la agenda del rebaño.");
  return payload.operations;
}

export async function fetchLivestockFeedingPlans(): Promise<LivestockFeedingPlan[]> {
  const response = await fetch("/api/ganado/racion", { cache: "no-store" });
  const payload = await response.json() as { plans?: LivestockFeedingPlan[]; error?: string };
  if (!response.ok || !payload.plans) throw new Error(payload.error ?? "No fue posible cargar el plan de alimentación.");
  return payload.plans;
}

export async function fetchLivestockFeedData(): Promise<{ inventory: LivestockFeedInventory[]; consumptions: LivestockFeedConsumption[] }> {
  const response = await fetch("/api/ganado/alimentacion", { cache: "no-store" });
  const payload = await response.json() as { inventory?: LivestockFeedInventory[]; consumptions?: LivestockFeedConsumption[]; error?: string };
  if (!response.ok || !payload.inventory || !payload.consumptions) throw new Error(payload.error ?? "No fue posible cargar el inventario de alimento.");
  return { inventory: payload.inventory, consumptions: payload.consumptions };
}

export async function fetchLivestockSnapshot(): Promise<{ lots: LivestockLot[]; animals: LivestockAnimal[]; weighings: LivestockWeighing[] }> {
  const [lotsResponse, animalsResponse, weighingsResponse] = await Promise.all([
    fetch("/api/ganado", { cache: "no-store" }),
    fetch("/api/ganado/animales", { cache: "no-store" }),
    fetch("/api/ganado/pesajes", { cache: "no-store" }),
  ]);
  const [lotsPayload, animalsPayload, weighingsPayload] = await Promise.all([lotsResponse.json(), animalsResponse.json(), weighingsResponse.json()]) as [
    { lots?: LivestockLot[]; error?: string }, { animals?: LivestockAnimal[]; error?: string }, { weighings?: LivestockWeighing[]; error?: string },
  ];
  if (!lotsResponse.ok || !lotsPayload.lots) throw new Error(lotsPayload.error ?? "No fue posible actualizar los lotes.");
  if (!animalsResponse.ok || !animalsPayload.animals) throw new Error(animalsPayload.error ?? "No fue posible actualizar los animales.");
  if (!weighingsResponse.ok || !weighingsPayload.weighings) throw new Error(weighingsPayload.error ?? "No fue posible actualizar los pesajes.");
  return { lots: lotsPayload.lots, animals: animalsPayload.animals, weighings: weighingsPayload.weighings };
}

export async function persistBatchHealth(animalIds: string[], event: Omit<HealthEventInput, "animalId">): Promise<{ created: number; operations: HerdOperations }> {
  const response = await fetch("/api/ganado/operaciones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "batch_health", batchId: crypto.randomUUID(), animalIds, event }),
  });
  const payload = await response.json() as { error?: string; created?: number; operations?: HerdOperations };
  if (!response.ok || payload.created === undefined || !payload.operations) throw new Error(payload.error ?? "No fue posible registrar el tratamiento grupal.");
  return { created: payload.created, operations: payload.operations };
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}
