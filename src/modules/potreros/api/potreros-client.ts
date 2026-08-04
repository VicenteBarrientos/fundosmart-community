import type { Activity, Fundo, Potrero } from "../types";
import { OfflineNetworkError, type PotreroOutboxOperation } from "../sync/offline-outbox";

export type PotreroReplacementPreview = {
  snapshotToken: string;
  fundo: Fundo;
  potreros: Potrero[];
  activities: Activity[];
  assignedLotCount: number;
};

export async function fetchPotreros(fundoId?: string): Promise<Potrero[]> {
  const query = fundoId ? `?fundoId=${encodeURIComponent(fundoId)}` : "";
  const response = await fetch(`/api/potreros${query}`, { cache: "no-store" });
  if (!response.ok) throw new Error("No fue posible cargar los potreros.");
  const payload = (await response.json()) as { potreros: Potrero[] };
  return payload.potreros;
}

export async function fetchArchivedPotreros(fieldId: string): Promise<Potrero[]> {
  const response = await fetch(`/api/potreros/archivados?fundoId=${encodeURIComponent(fieldId)}`, { cache: "no-store" });
  const payload = (await response.json()) as { potreros?: Potrero[]; error?: string };
  if (!response.ok || !payload.potreros) throw new Error(payload.error ?? "No fue posible cargar los potreros archivados.");
  return payload.potreros;
}

export async function persistPotrero(potrero: Potrero): Promise<Potrero> {
  const response = await mutationFetch(
    "/api/potreros",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(potrero),
    },
    "No fue posible guardar el potrero.",
  );

  const payload = (await response.json()) as { potrero?: Potrero; error?: string };
  if (!response.ok || !payload.potrero) {
    throw new Error(payload.error ?? "No fue posible guardar el potrero.");
  }
  return payload.potrero;
}

export async function removePotrero(potreroId: string, updatedAt: string): Promise<void> {
  const query = new URLSearchParams({ id: potreroId, updatedAt });
  const response = await mutationFetch(
    `/api/potreros?${query.toString()}`,
    { method: "DELETE" },
    "No fue posible eliminar el potrero.",
  );
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "No fue posible eliminar el potrero.");
}

export async function fetchPotreroReplacementPreview(fundoId: string): Promise<PotreroReplacementPreview> {
  const response = await fetch(`/api/potreros/lote?fundoId=${encodeURIComponent(fundoId)}`, { cache: "no-store" });
  const payload = (await response.json()) as { preview?: PotreroReplacementPreview; error?: string };
  if (!response.ok || !payload.preview) {
    throw new Error(payload.error ?? "No fue posible actualizar la previsualización.");
  }
  return payload.preview;
}

export async function replacePotreros(
  fundoId: string,
  potreros: Potrero[],
  expectedSnapshotToken: string,
): Promise<Potrero[]> {
  const response = await fetch("/api/potreros/lote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ fundoId, potreros, confirmReplace: true, expectedSnapshotToken }),
  });
  const payload = (await response.json()) as { potreros?: Potrero[]; error?: string };
  if (!response.ok || !payload.potreros) throw new Error(payload.error ?? "No fue posible crear las subdivisiones.");
  return payload.potreros;
}

export async function persistPotreroBoundaries(potreros: Potrero[]): Promise<Potrero[]> {
  const response = await fetch("/api/potreros/limites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ potreros }),
  });
  const payload = (await response.json()) as { potreros?: Potrero[]; error?: string };
  if (!response.ok || !payload.potreros) throw new Error(payload.error ?? "No fue posible actualizar los límites.");
  return payload.potreros;
}

export async function persistLinkedFieldBoundary(
  fundo: Fundo,
  potreros: Potrero[],
): Promise<{ fundo: Fundo; potreros: Potrero[] }> {
  const response = await mutationFetch(
    "/api/potreros/limites-fundo",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fundo, potreros }),
    },
    "No fue posible guardar el límite del fundo y sus potreros.",
  );
  const payload = (await response.json()) as { fundo?: Fundo; potreros?: Potrero[]; error?: string };
  if (!response.ok || !payload.fundo || !payload.potreros) {
    throw new Error(payload.error ?? "No fue posible guardar el límite del fundo y sus potreros.");
  }
  return { fundo: payload.fundo, potreros: payload.potreros };
}

export async function applyPotreroOutboxOperation(operation: PotreroOutboxOperation): Promise<void> {
  if (operation.op === "delete") {
    await removePotrero(operation.payload.id, operation.payload.updatedAt);
    return;
  }
  await persistPotrero(operation.payload);
}

async function mutationFetch(input: RequestInfo | URL, init: RequestInit, message: string) {
  try {
    return await fetch(input, init);
  } catch (cause) {
    throw new OfflineNetworkError(message, cause);
  }
}
