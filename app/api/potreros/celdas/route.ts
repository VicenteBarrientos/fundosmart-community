import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import type {
  PaddockCellCloseRequest,
  PaddockCellGenerationCommitRequest,
  PaddockCellGenerationPlanRequest,
} from "@/src/modules/potreros/domain/cells-rotation";
import {
  closePaddockCells,
  commitPaddockCellGeneration,
  listFieldActivePaddockCells,
  listPaddockCells,
  previewPaddockCellGeneration,
} from "@/src/modules/potreros/server/paddock-cell-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;
    const url = new URL(request.url);
    const fieldId = url.searchParams.get("fundoId")?.trim();
    const paddockId = url.searchParams.get("potreroId")?.trim();
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const cells = paddockId
      ? await listPaddockCells(fieldId, paddockId, access)
      : await listFieldActivePaddockCells(fieldId, access);
    const currentAccess = await reauthorizeApiAccess(access, "view", fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ cells });
  } catch (cause) {
    return cellError(cause);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockCellGenerationPlanRequest>>(request);
    if (payload instanceof Response) return payload;
    const error = validateGenerationPlan(payload);
    if (error) return privateJson({ error }, 400);
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;
    const preview = await previewPaddockCellGeneration(payload as PaddockCellGenerationPlanRequest, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ preview });
  } catch (cause) {
    return cellError(cause);
  }
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockCellGenerationCommitRequest>>(request);
    if (payload instanceof Response) return payload;
    const error = validateGenerationPlan(payload)
      ?? (!payload.operationId?.trim() ? "Falta el identificador estable de la operación." : null)
      ?? (!payload.requestHash?.trim() ? "Falta el hash de la previsualización." : null)
      ?? (!payload.expectedSnapshotToken?.trim() ? "Actualiza la previsualización antes de confirmar." : null);
    if (error) return privateJson({ error }, 400);
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;
    const result = await commitPaddockCellGeneration(payload as PaddockCellGenerationCommitRequest, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result }, 201);
  } catch (cause) {
    return cellError(cause);
  }
}

export async function DELETE(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<PaddockCellCloseRequest>>(request);
    if (payload instanceof Response) return payload;
    const error = !payload.fieldId?.trim()
      ? "Selecciona un fundo."
      : !payload.paddockId?.trim()
        ? "Selecciona un potrero."
        : !payload.operationId?.trim()
          ? "Falta el identificador estable del cierre."
          : !payload.expectedSnapshotToken?.trim()
            ? "Actualiza las celdas antes de confirmar el cierre."
            : null;
    if (error) return privateJson({ error }, 400);
    const forbidden = requireContextField(access, payload.fieldId);
    if (forbidden) return forbidden;
    const result = await closePaddockCells(payload as PaddockCellCloseRequest, access);
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ result });
  } catch (cause) {
    return cellError(cause);
  }
}

function validateGenerationPlan(payload: Partial<PaddockCellGenerationPlanRequest>): string | null {
  if (!payload.fieldId?.trim()) return "Selecciona un fundo.";
  if (!payload.paddockId?.trim()) return "Selecciona un potrero.";
  if (!Number.isInteger(payload.count)) return "La cantidad de franjas debe ser un número entero.";
  if (!Number.isFinite(payload.bearingDegrees)) return "La orientación de las franjas no es válida.";
  return null;
}

function cellError(cause: unknown): Response {
  if (cause instanceof DomainRuleError) {
    const status = cause.code === "PADDOCK_CELL_INVALID" ? 422 : 409;
    return privateJson({ error: cause.message, code: cause.code }, status);
  }
  if (cause instanceof Error && cause.message.includes("no such table")) {
    return privateJson({ error: "La base de datos todavía no está preparada." }, 503);
  }
  return privateJson({ error: "No fue posible procesar las celdas temporales." }, 500);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
