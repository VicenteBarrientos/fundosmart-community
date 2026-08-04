import type { Activity, ActivityWithLineage } from "../types";
import { OfflineNetworkError, type ActivityOutboxOperation } from "../sync/offline-outbox";

export async function fetchActivities(): Promise<Activity[]> {
  const response = await fetch("/api/actividades", { cache: "no-store" });
  if (!response.ok) throw new Error("No fue posible cargar el historial.");
  const payload = (await response.json()) as { activities: Activity[] };
  return payload.activities;
}

export async function fetchActivitiesWithLineage(potreroId: string): Promise<ActivityWithLineage[]> {
  const query = new URLSearchParams({ potreroId, includeLineage: "1" });
  const response = await fetch(`/api/actividades?${query.toString()}`, { cache: "no-store" });
  const payload = (await response.json()) as { activities?: ActivityWithLineage[]; error?: string };
  if (!response.ok || !payload.activities) throw new Error(payload.error ?? "No fue posible cargar el historial con linaje.");
  return payload.activities;
}

export async function persistActivity(activity: Activity): Promise<Activity> {
  const response = await mutationFetch(
    "/api/actividades",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(activity),
    },
    "No fue posible guardar el manejo.",
  );
  const payload = (await response.json()) as { activity?: Activity; error?: string };
  if (!response.ok || !payload.activity) throw new Error(payload.error ?? "No fue posible guardar el manejo.");
  return payload.activity;
}

export async function removeActivity(activityId: string, updatedAt: string): Promise<void> {
  const query = new URLSearchParams({ id: activityId, updatedAt });
  const response = await mutationFetch(
    `/api/actividades?${query.toString()}`,
    { method: "DELETE" },
    "No fue posible eliminar el manejo.",
  );
  const payload = (await response.json()) as { error?: string };
  if (!response.ok) throw new Error(payload.error ?? "No fue posible eliminar el manejo.");
}

export async function applyActivityOutboxOperation(operation: ActivityOutboxOperation): Promise<void> {
  if (operation.op === "delete") {
    await removeActivity(operation.payload.id, operation.payload.updatedAt);
    return;
  }
  await persistActivity(operation.payload);
}

async function mutationFetch(input: RequestInfo | URL, init: RequestInit, message: string) {
  try {
    return await fetch(input, init);
  } catch (cause) {
    throw new OfflineNetworkError(message, cause);
  }
}
