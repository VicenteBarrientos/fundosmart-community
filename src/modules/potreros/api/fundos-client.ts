import type { OrganizationPlanUsage } from "@/src/modules/access/domain/types";
import type { Fundo } from "../types";

export type FundosResponse = {
  fundos: Fundo[];
  plan: OrganizationPlanUsage;
};

export async function fetchFundos(): Promise<FundosResponse> {
  const response = await fetch("/api/fundos", { cache: "no-store" });
  if (!response.ok) throw new Error("No fue posible cargar los fundos.");
  return response.json() as Promise<FundosResponse>;
}

export async function persistFundo(fundo: Fundo): Promise<Fundo> {
  const response = await fetch("/api/fundos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fundo),
  });
  const payload = (await response.json()) as { fundo?: Fundo; error?: string };
  if (!response.ok || !payload.fundo) throw new Error(payload.error ?? "No fue posible guardar el fundo.");
  return payload.fundo;
}
