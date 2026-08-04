import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import type {
  MilkBulkProduction,
  MilkQualitySample,
  MilkQualitySanitaryFlags,
  PabcoComplianceItem,
} from "@/src/core/domain/types";
import type {
  BulkMilkControlRowInput,
  MilkOperationResource,
} from "@/src/modules/leche/domain/types";
import {
  deleteMilkOperation,
  listMilkBulkProduction,
  listMilkQualitySamples,
  listPabcoComplianceItems,
  MilkOperationConflictError,
  MilkOperationInputError,
  saveBulkMilkControls,
  upsertMilkBulkProduction,
  upsertMilkQualitySample,
  upsertPabcoComplianceItem,
} from "@/src/modules/leche/server/milk-operations-repository";
import {
  AnimalRecordRuleError,
  normalizeMilkControlInput,
} from "@/src/modules/ganado/ficha/server/animal-record-rules.mjs";

export const dynamic = "force-dynamic";

const BULK_KINDS = new Set(["tank_total", "delivery", "milk_meter_rollup"]);
const QUALITY_KINDS = new Set(["bulk_tank", "settlement", "laboratory"]);
const SCC_UNITS = new Set(["cells_per_ml", "thousand_cells_per_ml"]);
const BACTERIAL_UNITS = new Set(["cfu_per_ml", "thousand_cfu_per_ml"]);
const PABCO_REQUIREMENTS = new Set([
  "veterinary_advisory",
  "medicine_prescriptions",
  "withdrawal_management",
  "annual_water_analysis",
  "animal_traceability",
]);
const PABCO_STATUSES = new Set([
  "pending",
  "compliant",
  "expiring",
  "expired",
  "not_applicable",
]);
const SANITARY_STATUSES = new Set([
  "compliant",
  "non_compliant",
  "pending",
  "not_reported",
]);

class MilkOperationRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MilkOperationRequestError";
  }
}

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const [bulkProduction, qualitySamples, pabcoItems] = await Promise.all([
      listMilkBulkProduction(access),
      listMilkQualitySamples(access),
      listPabcoComplianceItems(access),
    ]);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { bulkProduction, qualitySamples, pabcoItems },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return unexpectedApiFailure(
      "milk.operations.list",
      "No fue posible cargar la operación lechera.",
      cause,
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    let payload: unknown;
    try {
      payload = await request.json();
    } catch {
      return Response.json(
        { error: "La solicitud no contiene datos válidos." },
        { status: 400 },
      );
    }
    if (!isRecord(payload))
      return Response.json(
        { error: "La solicitud no contiene datos válidos." },
        { status: 400 },
      );

    const resource = readResource(payload.resource);
    if (resource === "milk_controls") {
      const rows = normalizeBulkControls(payload.rows);
      const result = await saveBulkMilkControls(rows, {
        organizationId: access.organizationId,
        actor: access.email,
        fieldIds: access.fieldIds,
      });
      const currentAccess = await reauthorizeApiSnapshotAccess(access, {
        capability: "operate",
        fieldIds: access.fieldIds,
      });
      if (isAccessResponse(currentAccess)) return currentAccess;
      return Response.json({ resource, result }, { status: 201 });
    }

    const record = isRecord(payload.record) ? payload.record : null;
    if (!record)
      return Response.json(
        { error: "Falta el registro que deseas guardar." },
        { status: 400 },
      );
    const fieldId = requiredText(record.fieldId, "Selecciona el fundo.");
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const context = {
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      actor: access.email,
    };
    if (resource === "bulk_production") {
      const saved = await upsertMilkBulkProduction(
        normalizeBulkProduction(record, access),
        context,
      );
      const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return Response.json({ resource, record: saved }, { status: 201 });
    }
    if (resource === "quality_sample") {
      const saved = await upsertMilkQualitySample(
        normalizeQualitySample(record, access),
        context,
      );
      const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return Response.json({ resource, record: saved }, { status: 201 });
    }
    const saved = await upsertPabcoComplianceItem(
      normalizePabcoItem(record, access),
      context,
    );
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ resource, record: saved }, { status: 201 });
  } catch (cause) {
    if (cause instanceof MilkOperationConflictError)
      return Response.json(
        { error: cause.message, code: "MILK_OPERATION_STALE" },
        { status: 409 },
      );
    if (cause instanceof AnimalRecordRuleError)
      return Response.json(
        { error: cause.message, code: cause.code },
        { status: 400 },
      );
    if (
      cause instanceof MilkOperationRequestError
      || cause instanceof MilkOperationInputError
    ) {
      return Response.json({ error: cause.message }, { status: 400 });
    }
    if (
      cause instanceof Error &&
      cause.message.includes("UNIQUE constraint failed")
    ) {
      return Response.json(
        {
          error:
            "Ya existe un registro de la misma fuente, tipo y fecha. Elimínalo o actualiza los datos existentes.",
        },
        { status: 409 },
      );
    }
    return unexpectedApiFailure(
      "milk.operations.save",
      "No fue posible guardar la operación lechera.",
      cause,
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const url = new URL(request.url);
    const resource = readDeletableResource(url.searchParams.get("resource"));
    const id = requiredText(
      url.searchParams.get("id"),
      "Falta el identificador del registro.",
    );
    const expectedUpdatedAt = url.searchParams.get("updatedAt")?.trim();
    if (!expectedUpdatedAt) {
      throw new MilkOperationConflictError(
        "Falta la versión del registro. Recarga la sección e inténtalo nuevamente.",
      );
    }
    const fieldId = await resolveMilkOperationFieldId(resource, id, access);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const deleted = await deleteMilkOperation(resource, id, expectedUpdatedAt, {
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      actor: access.email,
    });
    if (!deleted)
      return Response.json(
        {
          error:
            "El registro no existe o no está disponible para tu membresía.",
        },
        { status: 404 },
      );
    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true });
  } catch (cause) {
    if (cause instanceof MilkOperationConflictError)
      return Response.json(
        { error: cause.message, code: "MILK_OPERATION_STALE" },
        { status: 409 },
      );
    if (
      cause instanceof MilkOperationRequestError
      || cause instanceof MilkOperationInputError
    ) {
      return Response.json({ error: cause.message }, { status: 400 });
    }
    return unexpectedApiFailure(
      "milk.operations.delete",
      "No fue posible eliminar el registro.",
      cause,
    );
  }
}

async function resolveMilkOperationFieldId(
  resource: "bulk_production" | "quality_sample" | "pabco_item",
  id: string,
  scope: { organizationId: string; fieldIds: string[] },
): Promise<string | null> {
  const records = resource === "bulk_production"
    ? await listMilkBulkProduction(scope)
    : resource === "quality_sample"
      ? await listMilkQualitySamples(scope)
      : await listPabcoComplianceItems(scope);
  return records.find((record) => record.id === id)?.fieldId ?? null;
}

function normalizeBulkProduction(
  record: Record<string, unknown>,
  access: { organizationId: string; email: string },
): MilkBulkProduction {
  const now = new Date().toISOString();
  const kind = enumText(
    record.kind,
    BULK_KINDS,
    "Selecciona el tipo de registro de producción.",
  );
  return {
    id: optionalText(record.id) || `milk-bulk-${crypto.randomUUID()}`,
    organizationId: access.organizationId,
    fieldId: requiredText(record.fieldId, "Selecciona el fundo."),
    recordedAt: isoDate(
      record.recordedAt,
      "Ingresa una fecha de producción válida.",
    ),
    kind: kind as MilkBulkProduction["kind"],
    volumeLiters: positiveNumber(
      record.volumeLiters,
      "Los litros producidos deben ser mayores que cero.",
    ),
    source: "manual",
    sourceRecordId: null,
    notes: optionalText(record.notes).slice(0, 1_000),
    createdBy: access.email,
    createdAt: optionalText(record.createdAt) || now,
    updatedAt: optionalText(record.updatedAt) || now,
  };
}

function normalizeQualitySample(
  record: Record<string, unknown>,
  access: { organizationId: string; email: string },
): MilkQualitySample {
  const now = new Date().toISOString();
  const sampledAt = isoDate(
    record.sampledAt,
    "Ingresa una fecha de muestra válida.",
  );
  const somaticCellCount = optionalNonNegativeInteger(
    record.somaticCellCount,
    "El RCS debe ser un entero no negativo.",
  );
  const bacterialCount = optionalNonNegativeInteger(
    record.bacterialCount,
    "La UFC debe ser un entero no negativo.",
  );
  const kind = enumText(
    record.kind,
    QUALITY_KINDS,
    "Selecciona un tipo de muestra válido.",
  );
  const sccUnit = enumText(
    record.somaticCellCountUnit ?? "cells_per_ml",
    SCC_UNITS,
    "Selecciona una unidad de RCS válida.",
  );
  const bacterialUnit = enumText(
    record.bacterialCountUnit ?? "cfu_per_ml",
    BACTERIAL_UNITS,
    "Selecciona una unidad de UFC válida.",
  );
  const fatPercent = optionalPercentage(
    record.fatPercent,
    "La grasa debe estar entre 0 y 15%.",
  );
  const proteinPercent = optionalPercentage(
    record.proteinPercent,
    "La proteína debe estar entre 0 y 15%.",
  );
  const totalSolidsPercent = optionalPercentage(
    record.totalSolidsPercent,
    "Los sólidos totales deben estar entre 0 y 30%.",
    30,
  );
  if (
    [
      fatPercent,
      proteinPercent,
      totalSolidsPercent,
      somaticCellCount,
      bacterialCount,
    ].every((value) => value === null)
  ) {
    throw new MilkOperationRequestError("Registra al menos una medición de calidad.");
  }
  return {
    id: optionalText(record.id) || `milk-quality-${crypto.randomUUID()}`,
    organizationId: access.organizationId,
    fieldId: requiredText(record.fieldId, "Selecciona el fundo."),
    sampledAt,
    period: `${sampledAt.slice(0, 7)}`,
    kind: kind as MilkQualitySample["kind"],
    fatPercent,
    proteinPercent,
    totalSolidsPercent,
    somaticCellCount,
    somaticCellCountUnit:
      somaticCellCount === null
        ? null
        : (sccUnit as MilkQualitySample["somaticCellCountUnit"]),
    bacterialCount,
    bacterialCountUnit:
      bacterialCount === null
        ? null
        : (bacterialUnit as MilkQualitySample["bacterialCountUnit"]),
    sanitaryFlags: normalizeSanitaryFlags(record.sanitaryFlags),
    source: "manual",
    sourceRecordId: null,
    notes: optionalText(record.notes).slice(0, 1_000),
    createdBy: access.email,
    createdAt: optionalText(record.createdAt) || now,
    updatedAt: optionalText(record.updatedAt) || now,
  };
}

function normalizePabcoItem(
  record: Record<string, unknown>,
  access: { organizationId: string; email: string },
): PabcoComplianceItem {
  const now = new Date().toISOString();
  const requirement = enumText(
    record.requirement,
    PABCO_REQUIREMENTS,
    "Selecciona un requisito PABCO válido.",
  );
  const status = enumText(
    record.status,
    PABCO_STATUSES,
    "Selecciona un estado PABCO válido.",
  );
  return {
    id: optionalText(record.id) || `pabco-${crypto.randomUUID()}`,
    organizationId: access.organizationId,
    fieldId: requiredText(record.fieldId, "Selecciona el fundo."),
    requirement: requirement as PabcoComplianceItem["requirement"],
    status: status as PabcoComplianceItem["status"],
    evidenceDocumentId: nullableText(record.evidenceDocumentId),
    validFrom: nullableIsoDate(
      record.validFrom,
      "La fecha de inicio no es válida.",
    ),
    validUntil: nullableIsoDate(
      record.validUntil,
      "La fecha de vencimiento no es válida.",
    ),
    reminderAt: nullableIsoDate(
      record.reminderAt,
      "La fecha de recordatorio no es válida.",
    ),
    source: "manual",
    sourceRecordId: null,
    notes: optionalText(record.notes).slice(0, 1_000),
    createdBy: access.email,
    createdAt: optionalText(record.createdAt) || now,
    updatedAt: optionalText(record.updatedAt) || now,
  };
}

function normalizeBulkControls(value: unknown): BulkMilkControlRowInput[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new MilkOperationRequestError("Agrega al menos un control lechero.");
  if (value.length > 200)
    throw new MilkOperationRequestError(
      "La carga masiva admite hasta 200 controles por operación.",
    );
  return value.map((entry) => {
    const normalized = normalizeMilkControlInput(entry);
    return {
      animalId: normalized.animalId,
      controlDate: normalized.controlDate,
      morningLiters: normalized.morningLiters,
      afternoonLiters: normalized.afternoonLiters,
      thirdMilkingLiters: normalized.thirdMilkingLiters,
      totalLiters: normalized.totalLiters,
      fatPercent: normalized.fatPct,
      proteinPercent: normalized.proteinPct,
      somaticCellCount: normalized.somaticCellCount,
    };
  });
}

function normalizeSanitaryFlags(value: unknown): MilkQualitySanitaryFlags {
  const flags: MilkQualitySanitaryFlags = {
    tbc: "not_reported",
    brucellosis: "not_reported",
    leucosis: "not_reported",
    pabco: "not_reported",
  };
  if (!isRecord(value)) return flags;
  for (const key of ["tbc", "brucellosis", "leucosis", "pabco"] as const) {
    const candidate = optionalText(value[key]);
    if (SANITARY_STATUSES.has(candidate))
      flags[key] = candidate as MilkQualitySanitaryFlags[typeof key];
  }
  return flags;
}

function readResource(value: unknown): MilkOperationResource {
  const resource = optionalText(value);
  if (
    [
      "bulk_production",
      "quality_sample",
      "pabco_item",
      "milk_controls",
    ].includes(resource)
  )
    return resource as MilkOperationResource;
  throw new MilkOperationRequestError("Selecciona una operación lechera válida.");
}

function readDeletableResource(
  value: unknown,
): "bulk_production" | "quality_sample" | "pabco_item" {
  const resource = optionalText(value);
  if (
    resource === "bulk_production" ||
    resource === "quality_sample" ||
    resource === "pabco_item"
  )
    return resource;
  throw new MilkOperationRequestError("Selecciona un registro eliminable válido.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requiredText(value: unknown, message: string): string {
  const text = optionalText(value);
  if (!text) throw new MilkOperationRequestError(message);
  return text;
}

function optionalText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  return optionalText(value) || null;
}

function enumText(
  value: unknown,
  allowed: Set<string>,
  message: string,
): string {
  const text = optionalText(value);
  if (!allowed.has(text)) throw new MilkOperationRequestError(message);
  return text;
}

function positiveNumber(value: unknown, message: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new MilkOperationRequestError(message);
  return Math.round(value * 1_000) / 1_000;
}

function optionalPercentage(
  value: unknown,
  message: string,
  maximum = 15,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > maximum
  )
    throw new MilkOperationRequestError(message);
  return Math.round(value * 1_000) / 1_000;
}

function optionalNonNegativeInteger(
  value: unknown,
  message: string,
): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isInteger(value) || (value as number) < 0)
    throw new MilkOperationRequestError(message);
  return value as number;
}

function isoDate(value: unknown, message: string): string {
  const text = optionalText(value);
  const parsed = new Date(`${text}T12:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    Number.isNaN(parsed.valueOf()) ||
    parsed.toISOString().slice(0, 10) !== text
  )
    throw new MilkOperationRequestError(message);
  return text;
}

function nullableIsoDate(value: unknown, message: string): string | null {
  const text = optionalText(value);
  return text ? isoDate(text, message) : null;
}
