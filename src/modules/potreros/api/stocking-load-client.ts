import type { FieldStockingLoad } from "../types";

export async function fetchFieldStockingLoad(fieldId: string): Promise<FieldStockingLoad> {
  const response = await fetch(`/api/potreros/carga?fundoId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  const payload = (await response.json()) as { load?: FieldStockingLoad; error?: string };
  if (!response.ok || !payload.load) throw new Error(payload.error ?? "No fue posible calcular la carga animal.");
  return payload.load;
}
