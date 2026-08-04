import { authorizeApiAccess, isAccessResponse, requireContextField, requireResourceField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  confirmGenealogyReconciliation,
  confirmCooprinsemHistoryServices,
  confirmCooprinsemMilkUnitContract,
  confirmGroupMapping,
  confirmQuarantineReassignment,
  CooprinsemConfigurationError,
  getCooprinsemConfiguration,
  simulateGroupMapping,
  simulateQuarantineReassignment,
} from "@/src/modules/integraciones/cooprinsem/server/configuration-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const fieldId = new URL(request.url).searchParams.get("fieldId")?.trim() ?? "";
  if (!fieldId) return Response.json({ error: "Falta el fundo que deseas configurar." }, { status: 400 });
  const forbidden = requireContextField(access, fieldId);
  if (forbidden) return forbidden;
  const repositoryAccess = {
    actorEmail: access.email,
    fieldIds: access.fieldIds,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
  };
  const configuration = await getCooprinsemConfiguration({ fieldId, ...repositoryAccess });
  if (!configuration) return Response.json({ error: "El fundo seleccionado no existe." }, { status: 404 });
  return Response.json({ configuration }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const payload = await readJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;
  const action = stringValue(payload.action);
  const fieldId = stringValue(payload.fieldId);
  const groupCode = stringValue(payload.groupCode);
  const lotId = stringValue(payload.lotId) || null;
  const confirmation = stringValue(payload.confirmation);
  const phrase = stringValue(payload.phrase);
  if (!fieldId) return Response.json({ error: "Falta el fundo que deseas configurar." }, { status: 400 });
  const forbidden = requireContextField(access, fieldId);
  if (forbidden) return forbidden;
  const repositoryAccess = {
    actorEmail: access.email,
    fieldIds: access.fieldIds,
    membershipId: access.membershipId,
    organizationId: access.organizationId,
  };
  if (lotId) {
    const lotForbidden = await requireResourceField(access, "lot", lotId);
    if (lotForbidden) return lotForbidden;
  }
  try {
    if (action === "simulate_group_mapping" || action === "simulate_group_deactivation") {
      const plan = await simulateGroupMapping({ fieldId, ...repositoryAccess, groupCode, lotId, deactivate: action.endsWith("deactivation") });
      return Response.json({ plan });
    }
    if (action === "confirm_group_mapping" || action === "confirm_group_deactivation") {
      const result = await confirmGroupMapping({ fieldId, ...repositoryAccess, groupCode, lotId, confirmation, deactivate: action.endsWith("deactivation") });
      const configuration = await getCooprinsemConfiguration({ fieldId, ...repositoryAccess });
      return Response.json({ result, configuration });
    }
    if (action === "simulate_quarantine_reassignment") {
      const plan = await simulateQuarantineReassignment({ fieldId, ...repositoryAccess, groupCode });
      return Response.json({ plan });
    }
    if (action === "confirm_quarantine_reassignment") {
      const result = await confirmQuarantineReassignment({ fieldId, ...repositoryAccess, groupCode, confirmation });
      const configuration = await getCooprinsemConfiguration({ fieldId, ...repositoryAccess });
      return Response.json({ result, configuration });
    }
    if (action === "confirm_genealogy_reconciliation") {
      const result = await confirmGenealogyReconciliation({ fieldId, ...repositoryAccess, confirmation });
      const configuration = await getCooprinsemConfiguration({ fieldId, ...repositoryAccess });
      return Response.json({ result, configuration });
    }
    if (action === "confirm_history_milk_unit_contract") {
      const result = await confirmCooprinsemMilkUnitContract({ fieldId, ...repositoryAccess, confirmation, phrase });
      const configuration = await getCooprinsemConfiguration({ fieldId, ...repositoryAccess });
      return Response.json({ result, configuration });
    }
    if (action === "confirm_history_services") {
      const result = await confirmCooprinsemHistoryServices({ fieldId, ...repositoryAccess, confirmation, phrase });
      const configuration = await getCooprinsemConfiguration({ fieldId, ...repositoryAccess });
      return Response.json({ result, configuration });
    }
    return Response.json({ error: "La operación de configuración no está soportada." }, { status: 400 });
  } catch (cause) {
    if (cause instanceof CooprinsemConfigurationError) return Response.json({ error: cause.message, code: cause.code }, { status: 422 });
    return unexpectedApiFailure(
      "cooprinsem.configuration.update",
      "No fue posible actualizar la configuración.",
      cause,
    );
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
