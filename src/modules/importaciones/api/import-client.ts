import type {
  ImportCenterDashboard,
  ImportCenterPreview,
  ImportColumnMapping,
  ImportConfirmationReceipt,
  ImportPaddockReconciliation,
  ImportProfileKey,
} from "../domain/types";

export async function fetchImportDashboard(): Promise<ImportCenterDashboard> {
  const response = await fetch("/api/importaciones", {
    cache: "no-store",
    credentials: "same-origin",
  });
  return readPayload<{ dashboard: ImportCenterDashboard }>(response).then((payload) => payload.dashboard);
}

export async function fetchImportPreview(id: string): Promise<ImportCenterPreview> {
  const response = await fetch(`/api/importaciones?id=${encodeURIComponent(id)}`, {
    cache: "no-store",
    credentials: "same-origin",
  });
  return readPayload<{ preview: ImportCenterPreview }>(response).then((payload) => payload.preview);
}

export async function uploadImportPreview(input: {
  fieldId: string;
  profileKey: ImportProfileKey;
  effectiveAt: string;
  file: File;
}): Promise<ImportCenterPreview> {
  const formData = new FormData();
  formData.set("fieldId", input.fieldId);
  formData.set("profileKey", input.profileKey);
  if (input.effectiveAt) formData.set("effectiveAt", input.effectiveAt);
  formData.set("file", input.file);
  const response = await fetch("/api/importaciones", {
    method: "POST",
    body: formData,
    credentials: "same-origin",
  });
  return readPayload<{ preview: ImportCenterPreview }>(response).then((payload) => payload.preview);
}

export async function mapImportColumns(
  importId: string,
  mapping: ImportColumnMapping,
): Promise<ImportCenterPreview> {
  const response = await fetch("/api/importaciones", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "map", importId, mapping }),
  });
  return readPayload<{ preview: ImportCenterPreview }>(response).then((payload) => payload.preview);
}

export async function reconcileAgronomicPaddocks(
  importId: string,
  mappings: ImportPaddockReconciliation[],
): Promise<ImportCenterPreview> {
  const response = await fetch("/api/importaciones", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "reconcile_paddocks", importId, mappings }),
  });
  return readPayload<{ preview: ImportCenterPreview }>(response).then((payload) => payload.preview);
}

export async function confirmImport(
  importId: string,
  confirmation: string,
  paddockId?: string,
): Promise<{
  confirmation: ImportConfirmationReceipt;
  dashboard: ImportCenterDashboard;
  preview: ImportCenterPreview;
}> {
  const response = await fetch("/api/importaciones", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "confirm", importId, confirmation, paddockId }),
  });
  return readPayload(response);
}

async function readPayload<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || "La operación de importación no pudo completarse.");
  return payload;
}
