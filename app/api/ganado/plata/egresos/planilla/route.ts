import {
  authorizeApiAccess,
  isAccessResponse,
  requireContextField,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  LIVESTOCK_EXPENSE_CATEGORY_LABELS,
  LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS,
  type LivestockExpense,
  type LivestockFinanceAuditEntry,
} from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { roleHasGlobalFieldAccess } from "@/src/modules/access/domain/access-rules.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import { upsertLivestockExpense } from "@/src/modules/ganado/server/livestock-finance-repository";

export const dynamic = "force-dynamic";

const MAX_SPREADSHEET_ROWS = 500;

type SpreadsheetPayload = {
  expenses?: Partial<LivestockExpense>[];
};

/**
 * Confirma una planilla de egresos.
 *
 * Mismo contrato que la planilla de animales: se valida todo antes de escribir nada, se
 * escribe fila por fila reusando `upsertLivestockExpense` para no tener una segunda copia
 * de las reglas de plata, y si una fila choca se detiene informando cuáles quedaron
 * guardadas. Cada egreso deja su entrada de auditoría, y todas vuelven juntas para que la
 * pantalla las muestre sin recargar.
 */
export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("manage_finance");
    if (isAccessResponse(access)) return access;

    const payload = await readJsonObject<SpreadsheetPayload>(request);
    if (payload instanceof Response) return payload;

    const expenses = payload.expenses;
    if (!Array.isArray(expenses) || expenses.length === 0) {
      return Response.json({ error: "La planilla no trae cambios que guardar." }, { status: 400 });
    }
    if (expenses.length > MAX_SPREADSHEET_ROWS) {
      return Response.json(
        { error: `La planilla no puede confirmar más de ${MAX_SPREADSHEET_ROWS} egresos de una vez.` },
        { status: 400 },
      );
    }
    if (new Set(expenses.map((expense) => expense.id?.trim())).size !== expenses.length) {
      return Response.json({ error: "La planilla trae el mismo egreso repetido." }, { status: 400 });
    }

    for (const expense of expenses) {
      const invalid = validateExpensePayload(expense);
      if (invalid) {
        return Response.json(
          { error: `${expense.description ? `"${expense.description}": ` : ""}${invalid}`, failedExpenseId: expense.id ?? null, savedIds: [] },
          { status: 400 },
        );
      }
    }

    for (const expense of expenses) {
      if (expense.fieldId) {
        const fieldForbidden = requireContextField(access, expense.fieldId);
        if (fieldForbidden) return fieldForbidden;
      }
      if (expense.lotId) {
        const lotForbidden = await requireResourceField(access, "lot", expense.lotId);
        if (lotForbidden) return lotForbidden;
      }
      const existingFieldId = await resolveResourceFieldId("expense", expense.id!.trim());
      if (existingFieldId) {
        const existingForbidden = requireContextField(access, existingFieldId);
        if (existingForbidden) return existingForbidden;
      }
    }

    const scope = {
      organizationId: access.organizationId,
      fieldIds: access.fieldIds,
      allowOrganizationWide: roleHasGlobalFieldAccess(access.role),
      actorEmail: access.email,
    };

    const savedIds: string[] = [];
    const saved: LivestockExpense[] = [];
    const auditEntries: LivestockFinanceAuditEntry[] = [];

    for (const expense of expenses) {
      try {
        const result = await upsertLivestockExpense({
          id: expense.id!.trim(),
          fieldId: expense.fieldId?.trim() || null,
          date: expense.date ?? null,
          description: expense.description!.trim(),
          category: expense.category!,
          amountClp: expense.amountClp!,
          paymentSource: expense.paymentSource!,
          paidById: expense.paymentSource === "partner" ? expense.paidById?.trim() || null : null,
          lotId: expense.lotId?.trim() || null,
          createdAt: expense.createdAt || new Date().toISOString(),
        }, scope);
        savedIds.push(expense.id!.trim());
        saved.push(result.value);
        auditEntries.push(result.auditEntry);
      } catch (cause) {
        const prefix = expense.description ? `"${expense.description}": ` : "";
        if (cause instanceof DomainRuleError) {
          return Response.json(
            {
              auditEntries,
              code: cause.code,
              error: `${prefix}${cause.message}`,
              expenses: saved,
              failedExpenseId: expense.id ?? null,
              savedIds,
            },
            { status: cause.code === "FIELD_SCOPE_CONFLICT" ? 409 : 422 },
          );
        }
        return unexpectedApiFailure(
          "livestock.expense.spreadsheet",
          `${prefix}No fue posible guardar el egreso.`,
          cause,
        );
      }
    }

    return Response.json({ auditEntries, expenses: saved, savedIds }, { status: 200 });
  } catch (cause) {
    return unexpectedApiFailure(
      "livestock.expense.spreadsheet",
      "No fue posible confirmar la planilla de egresos.",
      cause,
    );
  }
}

function validateExpensePayload(payload: Partial<LivestockExpense>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del egreso.";
  if (!payload.description?.trim()) return "Ingresa la descripción del egreso.";
  if (!payload.category || !(payload.category in LIVESTOCK_EXPENSE_CATEGORY_LABELS)) return "La categoría no es válida.";
  if (!Number.isInteger(payload.amountClp) || (payload.amountClp as number) <= 0) return "El monto debe ser un CLP entero mayor que cero.";
  if (!payload.paymentSource || !(payload.paymentSource in LIVESTOCK_EXPENSE_PAYMENT_SOURCE_LABELS)) return "El origen del pago no es válido.";
  if (payload.paymentSource === "partner" && !payload.paidById?.trim()) return "Selecciona el socio que pagó.";
  if (payload.date && !/^\d{4}-\d{2}-\d{2}$/.test(payload.date)) return "La fecha del egreso no es válida.";
  return null;
}
