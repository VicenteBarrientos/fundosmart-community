import { getDb } from "@/db";
import { fields } from "@/db/schema";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { OrganizationFieldScope } from "../domain/types";
import { and, eq, inArray } from "drizzle-orm";

export async function assertFieldInScope(
  fieldId: string,
  scope: OrganizationFieldScope,
  message = "El fundo seleccionado no existe o no está disponible.",
): Promise<void> {
  if (!scope.fieldIds.includes(fieldId)) throwFieldScopeConflict(message);
  const [field] = await getDb()
    .select({ id: fields.id })
    .from(fields)
    .where(and(
      eq(fields.id, fieldId),
      eq(fields.organizationId, scope.organizationId),
      inArray(fields.id, scope.fieldIds),
    ))
    .limit(1);
  if (!field) throwFieldScopeConflict(message);
}

export function throwFieldScopeConflict(message: string): never {
  throw new DomainRuleError(message, "FIELD_SCOPE_CONFLICT");
}
