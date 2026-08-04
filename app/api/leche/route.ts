import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import type { MilkSettlement, MilkSettlementLineItem } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  deriveMilkSettlementPrices,
  MILK_SETTLEMENT_LIMITS,
} from "@/src/modules/leche/server/milk-settlement-integrity.mjs";
import {
  deleteMilkSettlement,
  listMilkSettlements,
  upsertMilkSettlement,
} from "@/src/modules/leche/server/milk-settlement-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    const settlements = await listMilkSettlements(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "manage_finance",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { settlements },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return unexpectedApiFailure(
      "milk.settlement.list",
      "No fue posible cargar las liquidaciones de leche.",
      cause,
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<MilkSettlement>>(request);
    if (payload instanceof Response) return payload;
    const error = validateSettlement(payload);
    if (error) return Response.json({ error }, { status: 400 });
    const targetForbidden = requireContextField(access, payload.fieldId);
    if (targetForbidden) return targetForbidden;
    const existingFieldId = await resolveResourceFieldId("milk_settlement", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
      if (!payload.updatedAt?.trim()) {
        return Response.json({ error: "Actualiza las liquidaciones antes de editar." }, { status: 409 });
      }
    }

    const now = new Date().toISOString();
    const settlement = await upsertMilkSettlement(deriveMilkSettlementPrices({
      id: payload.id!.trim(),
      fieldId: payload.fieldId!.trim(),
      period: payload.period!,
      generatedAt: payload.generatedAt?.trim() || null,
      plant: payload.plant?.trim() ?? "",
      purchaseOrder: payload.purchaseOrder!.trim(),
      producerCode: payload.producerCode?.trim() ?? "",
      producerName: payload.producerName!.trim(),
      buyerName: payload.buyerName!.trim(),
      litersFirstHalf: finiteOrNull(payload.litersFirstHalf),
      litersSecondHalf: finiteOrNull(payload.litersSecondHalf),
      totalLiters: payload.totalLiters!,
      netAmountClp: payload.netAmountClp!,
      taxAmountClp: payload.taxAmountClp!,
      grossAmountClp: payload.grossAmountClp!,
      netPricePerLiterClp: 0,
      grossPricePerLiterClp: null,
      sourceDocumentName: payload.sourceDocumentName?.trim() || null,
      notes: payload.notes?.trim() ?? "",
      lineItems: sanitizeLineItems(payload.lineItems),
      createdAt: now,
      updatedAt: existingFieldId ? payload.updatedAt!.trim() : now,
    }), access);
    const currentAccess = await reauthorizeApiAccess(
      access,
      "manage_finance",
      settlement.fieldId,
    );
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ settlement }, { status: 201 });
  } catch (cause) {
    return milkSettlementMutationError(cause, "milk.settlement.save", "No fue posible guardar la liquidación.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    const url = new URL(request.url);
    const id = url.searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador de la liquidación." }, { status: 400 });
    const expectedUpdatedAt = url.searchParams.get("updatedAt")?.trim();
    if (!expectedUpdatedAt) {
      return Response.json({ error: "Actualiza las liquidaciones antes de eliminar." }, { status: 409 });
    }
    const forbidden = await requireResourceField(access, "milk_settlement", id);
    if (forbidden) return forbidden;
    const deleted = await deleteMilkSettlement(id, access, expectedUpdatedAt);
    if (!deleted) return Response.json({ error: "La liquidación no existe." }, { status: 404 });
    return Response.json({ deleted: true });
  } catch (cause) {
    return milkSettlementMutationError(cause, "milk.settlement.delete", "No fue posible eliminar la liquidación.");
  }
}

function milkSettlementMutationError(cause: unknown, operation: string, fallback: string): Response {
  if (cause instanceof DomainRuleError) {
    if (cause.code === "FIELD_SCOPE_CONFLICT") return Response.json({ error: cause.message }, { status: 409 });
    return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
  }
  return unexpectedApiFailure(operation, fallback, cause);
}

function validateSettlement(payload: Partial<MilkSettlement>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador de la liquidación.";
  if (!payload.fieldId?.trim()) return "Selecciona el fundo.";
  if (!payload.period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(payload.period)) return "El período debe identificar un mes válido en formato AAAA-MM.";
  if (payload.generatedAt && !Number.isFinite(Date.parse(payload.generatedAt))) return "La fecha de emisión no es válida.";
  if (!payload.purchaseOrder?.trim()) return "Ingresa la orden de compra.";
  if (!payload.producerName?.trim()) return "Ingresa el productor.";
  if (!payload.buyerName?.trim()) return "Ingresa la empresa compradora.";
  if (!Number.isFinite(payload.totalLiters) || (payload.totalLiters as number) <= 0) return "Los litros deben ser mayores que cero.";
  for (const value of [payload.litersFirstHalf, payload.litersSecondHalf]) {
    if (value !== null && value !== undefined && (!Number.isFinite(value) || value < 0)) return "Los litros por quincena no pueden ser negativos.";
  }
  if (
    (payload.litersFirstHalf !== null && payload.litersFirstHalf !== undefined)
    || (payload.litersSecondHalf !== null && payload.litersSecondHalf !== undefined)
  ) {
    const partsTotal = (payload.litersFirstHalf ?? 0) + (payload.litersSecondHalf ?? 0);
    const tolerance = Math.max(0.001, (payload.totalLiters as number) * 1e-9);
    if (Math.abs(partsTotal - (payload.totalLiters as number)) > tolerance) return "La suma de litros por quincena debe coincidir con el total.";
  }
  if (!isNonNegativeInteger(payload.netAmountClp)) return "El monto neto debe ser un CLP entero no negativo.";
  if (!isNonNegativeInteger(payload.taxAmountClp)) return "El IVA debe ser un CLP entero no negativo.";
  if (!isNonNegativeInteger(payload.grossAmountClp) || (payload.grossAmountClp as number) <= 0) return "El total debe ser un CLP entero mayor que cero.";
  if (payload.grossAmountClp !== (payload.netAmountClp as number) + (payload.taxAmountClp as number)) return "El total debe ser igual al neto más IVA.";
  return null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function sanitizeLineItems(value: unknown): MilkSettlementLineItem[] {
  if (!Array.isArray(value) || value.length > MILK_SETTLEMENT_LIMITS.lineItems) {
    throw new DomainRuleError(
      "La liquidación admite hasta 200 líneas de detalle.",
      "MILK_SETTLEMENT_INVALID",
    );
  }
  return value.map((item) => {
    if (!item || typeof item !== "object") {
      throw new DomainRuleError(
        "Cada línea de detalle debe ser un objeto válido.",
        "MILK_SETTLEMENT_INVALID",
      );
    }
    const candidate = item as Partial<MilkSettlementLineItem>;
    const expectedKeys = ["description", "measurement", "unitPriceClp", "amountClp"];
    const keys = Object.keys(candidate);
    const description = candidate.description?.trim() ?? "";
    const amountClp = candidate.amountClp;
    if (
      keys.length !== expectedKeys.length
      || !expectedKeys.every((key) => Object.hasOwn(candidate, key))
      || !description
      || description.length > MILK_SETTLEMENT_LIMITS.lineItemDescription
      || typeof amountClp !== "number"
      || !Number.isSafeInteger(amountClp)
      || (
        candidate.measurement !== null
        && (
          typeof candidate.measurement !== "string"
          || candidate.measurement.length > MILK_SETTLEMENT_LIMITS.lineItemMeasurement
        )
      )
      || (
        candidate.unitPriceClp !== null
        && (typeof candidate.unitPriceClp !== "number" || !Number.isFinite(candidate.unitPriceClp))
      )
    ) {
      throw new DomainRuleError(
        "Una línea de detalle contiene datos no válidos.",
        "MILK_SETTLEMENT_INVALID",
      );
    }
    return {
      description,
      measurement: candidate.measurement?.trim() || null,
      unitPriceClp: candidate.unitPriceClp ?? null,
      amountClp,
    };
  });
}
