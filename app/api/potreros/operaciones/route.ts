import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type { PaddockOperationCommitRequest, PaddockOperationPlanRequest } from "@/src/modules/potreros/types";
import {
  commitPaddockOperation,
  getPaddockOperation,
  previewPaddockOperation,
} from "@/src/modules/potreros/server/paddock-operation-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const operationId = new URL(request.url).searchParams.get("operationId")?.trim();
    if (!operationId) return privateJson({ error: "Falta el identificador de la operación." }, 400);
    const result = await getPaddockOperation(operationId, access);
    if (!result) return privateJson({ error: "La operación no existe." }, 404);
    const currentAccess = await reauthorizeApiAccess(access, "view", result.fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result });
  } catch (cause) {
    return operationError(cause);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockOperationPlanRequest>>(request);
    if (payload instanceof Response) return payload;
    const error = validatePlanRequest(payload);
    if (error) return privateJson({ error }, 400);
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;
    const preview = await previewPaddockOperation(payload as PaddockOperationPlanRequest, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ preview });
  } catch (cause) {
    return operationError(cause);
  }
}

export async function PUT(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockOperationCommitRequest>>(request);
    if (payload instanceof Response) return payload;
    const error = validatePlanRequest(payload)
      ?? (!payload.operationId?.trim() ? "Falta el identificador estable de la operación." : null)
      ?? (!payload.requestHash?.trim() ? "Falta el hash de la operación previsualizada." : null)
      ?? (!payload.expectedSnapshotToken?.trim() ? "Actualiza la previsualización antes de confirmar." : null);
    if (error) return privateJson({ error }, 400);
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;
    const result = await commitPaddockOperation(payload as PaddockOperationCommitRequest, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", result.fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result }, 201);
  } catch (cause) {
    return operationError(cause);
  }
}

function validatePlanRequest(payload: Partial<PaddockOperationPlanRequest>): string | null {
  if (!payload.fieldId?.trim()) return "Selecciona un fundo.";
  if (!payload.kind || !["split", "merge", "redesign", "undo"].includes(payload.kind)) return "El tipo de operación no es válido.";
  if (!Array.isArray(payload.parentPaddockIds)) return "La lista de potreros de origen no es válida.";
  if (!Array.isArray(payload.proposedPaddocks)) return "La lista de potreros resultantes no es válida.";
  if (payload.kind === "undo" && !payload.sourceOperationId?.trim()) return "Selecciona la operación que quieres revertir.";
  for (const paddock of payload.proposedPaddocks) {
    if (!paddock?.id?.trim() || !paddock.name?.trim() || !paddock.sector?.trim()) return "Cada potrero resultante necesita identificación, nombre y sector.";
    if (!Array.isArray(paddock.coordinates) || paddock.coordinates.length < 3) return "Cada potrero resultante necesita al menos tres vértices.";
  }
  return null;
}

function operationError(cause: unknown) {
  if (cause instanceof DomainRuleError) {
    const status = cause.code === "PADDOCK_OPERATION_INVALID" ? 422 : 409;
    return privateJson({ error: cause.message, code: cause.code }, status);
  }
  return privateJson({ error: "No fue posible procesar la operación de potreros." }, 500);
}

function privateJson(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
