import type { MilkSettlement } from "@/src/core/domain/types";

export async function fetchMilkSettlements(): Promise<MilkSettlement[]> {
  const response = await fetch("/api/leche", { cache: "no-store" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible actualizar las liquidaciones."));
  const payload = (await response.json()) as { settlements: MilkSettlement[] };
  return payload.settlements;
}

export async function persistMilkSettlement(settlement: MilkSettlement): Promise<MilkSettlement> {
  const response = await fetch("/api/leche", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settlement),
  });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible guardar la liquidación."));
  const payload = (await response.json()) as { settlement: MilkSettlement };
  return payload.settlement;
}

export async function removeMilkSettlement(id: string, updatedAt: string): Promise<void> {
  const query = new URLSearchParams({ id, updatedAt });
  const response = await fetch(`/api/leche?${query.toString()}`, { method: "DELETE" });
  if (!response.ok) throw new Error(await responseError(response, "No fue posible eliminar la liquidación."));
}

async function responseError(response: Response, fallback: string) {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}
