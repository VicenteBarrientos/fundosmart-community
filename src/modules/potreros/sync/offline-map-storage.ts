import type { Potrero } from "../types";

export type OfflineStorageQuota = Readonly<{
  usageBytes: number;
  quotaBytes: number;
  usagePercent: number;
}>;

export type OfflineMapPartition = Readonly<{
  organizationId: string;
  fieldId: string;
  paddockDrafts: readonly Potrero[];
  updatedAt: string;
}>;

export function buildStorageKey(organizationId: string, fieldId: string): string {
  const cleanOrg = organizationId.trim();
  const cleanField = fieldId.trim();
  if (!cleanOrg || !cleanField) {
    throw new TypeError("Id de organización y fundo requeridos para aislar almacenamiento.");
  }
  return `fundosmart-map-offline:${encodeURIComponent(cleanOrg)}:${encodeURIComponent(cleanField)}`;
}

export function serializeOfflinePartition(partition: OfflineMapPartition): string {
  return JSON.stringify({
    organizationId: partition.organizationId,
    fieldId: partition.fieldId,
    paddockDrafts: partition.paddockDrafts,
    updatedAt: partition.updatedAt,
  });
}

export function deserializeOfflinePartition(raw: string): OfflineMapPartition | null {
  try {
    const data = JSON.parse(raw);
    if (
      typeof data !== "object" ||
      data === null ||
      typeof data.organizationId !== "string" ||
      typeof data.fieldId !== "string" ||
      !Array.isArray(data.paddockDrafts)
    ) {
      return null;
    }
    const validDrafts = data.paddockDrafts.filter(
      (item: unknown) => typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string",
    );
    return Object.freeze({
      organizationId: data.organizationId,
      fieldId: data.fieldId,
      paddockDrafts: Object.freeze(validDrafts),
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    });
  } catch {
    return null;
  }
}
