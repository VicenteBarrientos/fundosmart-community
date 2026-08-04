import type {
  MilkBulkProduction,
  MilkQualitySample,
  PabcoComplianceItem,
} from "@/src/core/domain/types";
import type { MilkModuleSnapshot } from "../domain/types";

export type PabcoNotificationPreference = {
  id: string;
  organizationId: string;
  fieldId: string;
  userEmail: string;
  emailEnabled: boolean;
  browserEnabled: boolean;
  reminderDays: number;
  timezone: string;
  createdAt: string;
  updatedAt: string;
};

export async function fetchMilkSnapshot(
  asOf?: string,
): Promise<MilkModuleSnapshot> {
  const query = asOf ? `?asOf=${encodeURIComponent(asOf)}` : "";
  const response = await fetch(`/api/leche/resumen${query}`, {
    cache: "no-store",
  });
  if (!response.ok)
    throw new Error(
      await responseError(
        response,
        "No fue posible actualizar el tablero lechero.",
      ),
    );
  const payload = (await response.json()) as { snapshot: MilkModuleSnapshot };
  return payload.snapshot;
}

export async function persistMilkBulkProduction(
  record: MilkBulkProduction,
): Promise<MilkBulkProduction> {
  return persistRecord("bulk_production", record);
}

export async function persistMilkQualitySample(
  record: MilkQualitySample,
): Promise<MilkQualitySample> {
  return persistRecord("quality_sample", record);
}

export async function persistPabcoComplianceItem(
  record: PabcoComplianceItem,
): Promise<PabcoComplianceItem> {
  return persistRecord("pabco_item", record);
}

export async function uploadPabcoEvidence(
  fieldId: string,
  file: File,
): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  form.set("fieldId", fieldId);
  form.set("file", file);
  const response = await fetch("/api/leche/pabco-documentos", {
    method: "POST",
    body: form,
  });
  if (!response.ok)
    throw new Error(
      await responseError(
        response,
        "No fue posible cargar la evidencia PABCO.",
      ),
    );
  const payload = (await response.json()) as {
    document: { id: string; filename: string };
  };
  return payload.document;
}

export async function fetchPabcoNotificationPreferences(): Promise<
  PabcoNotificationPreference[]
> {
  const response = await fetch("/api/leche/notificaciones", {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(
      await responseError(
        response,
        "No fue posible cargar los recordatorios PABCO.",
      ),
    );
  }
  const payload = (await response.json()) as {
    preferences: PabcoNotificationPreference[];
  };
  return payload.preferences;
}

export async function persistPabcoNotificationPreferences(input: {
  fieldIds: string[];
  emailEnabled: boolean;
  browserEnabled: boolean;
  reminderDays: number;
}): Promise<PabcoNotificationPreference[]> {
  const response = await fetch("/api/leche/notificaciones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new Error(
      await responseError(
        response,
        "No fue posible guardar los recordatorios PABCO.",
      ),
    );
  }
  const payload = (await response.json()) as {
    preferences: PabcoNotificationPreference[];
  };
  return payload.preferences;
}

export async function persistBulkMilkControls(
  rows: Array<{
    animalId: string;
    controlDate: string;
    morningLiters: number | null;
    afternoonLiters: number | null;
    thirdMilkingLiters: number | null;
    totalLiters: number;
    fatPct: number | null;
    proteinPct: number | null;
    somaticCellCount: number | null;
  }>,
): Promise<number> {
  const response = await fetch("/api/leche/operaciones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource: "milk_controls", rows }),
  });
  if (!response.ok)
    throw new Error(
      await responseError(
        response,
        "No fue posible guardar los controles lecheros.",
      ),
    );
  const payload = (await response.json()) as { result: { savedCount: number } };
  return payload.result.savedCount;
}

export async function removeMilkOperation(
  resource: "bulk_production" | "quality_sample" | "pabco_item",
  id: string,
  updatedAt: string,
): Promise<void> {
  const response = await fetch(
    `/api/leche/operaciones?resource=${encodeURIComponent(resource)}&id=${encodeURIComponent(id)}&updatedAt=${encodeURIComponent(updatedAt)}`,
    { method: "DELETE" },
  );
  if (!response.ok)
    throw new Error(
      await responseError(response, "No fue posible eliminar el registro."),
    );
}

async function persistRecord<T>(
  resource: "bulk_production" | "quality_sample" | "pabco_item",
  record: T,
): Promise<T> {
  const response = await fetch("/api/leche/operaciones", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ resource, record }),
  });
  if (!response.ok)
    throw new Error(
      await responseError(response, "No fue posible guardar el registro."),
    );
  const payload = (await response.json()) as { record: T };
  return payload.record;
}

async function responseError(
  response: Response,
  fallback: string,
): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}
