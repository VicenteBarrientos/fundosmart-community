import {
  LIVESTOCK_EXPENSE_CATEGORY_LABELS,
  LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS,
  type LivestockExpense,
} from "@/src/core/domain/types";
import { authorizeApiAccess, isAccessResponse, requireContextField, requireResourceField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import { roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import {
  deleteLivestockExpense,
  upsertLivestockExpense,
} from "@/src/modules/ganado/server/livestock-finance-repository";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<LivestockExpense>>(request);
    if (payload instanceof Response) return payload;
    const error = validateExpense(payload);
    if (error) return Response.json({ error }, { status: 400 });
    if (payload.fieldId) {
      const fieldForbidden = requireContextField(access, payload.fieldId);
      if (fieldForbidden) return fieldForbidden;
    }
    if (payload.lotId) {
      const lotForbidden = await requireResourceField(access, "lot", payload.lotId);
      if (lotForbidden) return lotForbidden;
    }
    const existingFieldId = await resolveResourceFieldId("expense", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
    }

    const result = await upsertLivestockExpense({
      id: payload.id!.trim(),
      fieldId: payload.fieldId?.trim() || null,
      date: payload.date ?? null,
      description: payload.description!.trim(),
      category: payload.category!,
      amountClp: payload.amountClp!,
      paymentSource: payload.paymentSource!,
      paidById: payload.paymentSource === "partner" ? payload.paidById?.trim() || null : null,
      lotId: payload.lotId?.trim() || null,
      createdAt: payload.createdAt ?? new Date().toISOString(),
    }, {
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      allowOrganizationWide: roleHasGlobalFieldAccess(access.role),
      actorEmail: access.email,
    });
    return Response.json({ expense: result.value, auditEntry: result.auditEntry }, { status: 201 });
  } catch (cause) {
    if (cause instanceof DomainRuleError) return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
    return unexpectedApiFailure("livestock.expense.save", "No fue posible guardar el egreso.", cause);
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del egreso." }, { status: 400 });
    const existingFieldId = await resolveResourceFieldId("expense", id);
    if (existingFieldId) {
      const forbidden = requireContextField(access, existingFieldId);
      if (forbidden) return forbidden;
    }
    const result = await deleteLivestockExpense(id, {
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      allowOrganizationWide: roleHasGlobalFieldAccess(access.role),
      actorEmail: access.email,
    });
    if (!result.deleted) return Response.json({ error: "El egreso no existe." }, { status: 404 });
    return Response.json(result);
  } catch (cause) {
    if (cause instanceof DomainRuleError) return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
    return unexpectedApiFailure("livestock.expense.delete", "No fue posible eliminar el egreso.", cause);
  }
}

function validateExpense(payload: Partial<LivestockExpense>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del egreso.";
  if (!payload.description?.trim()) return "Ingresa la descripción del egreso.";
  if (!payload.category || !(payload.category in LIVESTOCK_EXPENSE_CATEGORY_LABELS)) return "La categoría no es válida.";
  if (!Number.isInteger(payload.amountClp) || (payload.amountClp as number) <= 0) return "El monto debe ser un CLP entero mayor que cero.";
  if (!payload.paymentSource || !(payload.paymentSource in LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS)) return "El origen del pago no es válido.";
  if (payload.paymentSource === "partner" && !payload.paidById?.trim()) return "Selecciona el socio que pagó.";
  if (payload.date && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return "La fecha del egreso no es válida.";
  return null;
}
