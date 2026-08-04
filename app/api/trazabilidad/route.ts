import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  addTraceabilityDiio,
  annulFmaDocument,
  commitTraceabilityImport,
  generateDeaDraft,
  generateFmaDrafts,
  getTraceabilityDashboard,
  issueFmaDocuments,
  saveTraceabilityEstablishment,
  stageTraceabilityImport,
  stageTraceabilityDbfImport,
  TraceabilityRequestError,
  transitionTraceabilityDiio,
} from "@/src/modules/trazabilidad/server/traceability-repository";

export const dynamic = "force-dynamic";
const MAX_TRACEABILITY_DBF_BYTES = 1024 * 1024;

type MutationPayload = {
  action?: unknown;
  fieldId?: unknown;
  [key: string]: unknown;
};

export async function GET(request: Request): Promise<Response> {
  try {
    const fieldId = new URL(request.url).searchParams.get("fieldId")?.trim() || "";
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const access = await authorizeApiAccess("trazabilidad:read", fieldId);
    if (isAccessResponse(access)) return access;
    const dashboard = await getTraceabilityDashboard(access, fieldId);
    const currentAccess = await reauthorizeApiAccess(access, "trazabilidad:read", dashboard.field.id);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson(dashboard);
  } catch (cause) {
    return traceabilityFailure("trazabilidad.dashboard", "No fue posible cargar la trazabilidad.", cause);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const identity = await authorizeApiAccess("operate");
    if (isAccessResponse(identity)) return identity;
    if (request.headers.get("content-type")?.toLowerCase().includes("multipart/form-data")) {
      const response = await handleTraceabilityFileUpload(request);
      return response;
    }
    const payload = await readJsonObject<MutationPayload>(request);
    if (payload instanceof Response) return payload;
    const fieldId = text(payload.fieldId);
    if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
    const access = await authorizeApiAccess("trazabilidad:write", fieldId);
    if (isAccessResponse(access)) return access;

    switch (payload.action) {
      case "save_establishment":
        return privateJson(await saveTraceabilityEstablishment(access, {
          fieldId,
          rup: text(payload.rup),
          kind: establishmentKind(payload.kind),
          holderRut: text(payload.holderRut),
          holderName: text(payload.holderName),
          commune: text(payload.commune),
          address: text(payload.address),
          idempotencyKey: text(payload.idempotencyKey),
        }));
      case "add_diio":
        return privateJson(await addTraceabilityDiio(access, {
          fieldId,
          officialNumber: text(payload.officialNumber),
          deviceType: deviceType(payload.deviceType),
          rfidId: nullableText(payload.rfidId),
          idempotencyKey: text(payload.idempotencyKey),
        }));
      case "transition_diio":
        return privateJson(await transitionTraceabilityDiio(access, {
          fieldId,
          deviceId: text(payload.deviceId),
          replacementDeviceId: nullableText(payload.replacementDeviceId) ?? undefined,
          action: transitionAction(payload.transition),
          animalId: nullableText(payload.animalId) ?? undefined,
          occurredAt: text(payload.occurredAt),
          idempotencyKey: text(payload.idempotencyKey),
        }));
      case "stage_import":
        return privateJson(await stageTraceabilityImport(access, {
          fieldId,
          sourceKind: sourceKind(payload.sourceKind),
          rows: recordArray(payload.rows),
          idempotencyKey: text(payload.idempotencyKey),
          sipecAdapterVersion: nullableText(payload.sipecAdapterVersion) ?? undefined,
          sipecFormatVersion: nullableText(payload.sipecFormatVersion),
        }));
      case "commit_import":
        return privateJson(await commitTraceabilityImport(access, {
          fieldId,
          stageId: text(payload.stageId),
          idempotencyKey: text(payload.idempotencyKey),
        }));
      case "generate_fma":
        return privateJson(await generateFmaDrafts(access, {
          fieldId,
          animalIds: stringArray(payload.animalIds),
          idempotencyKey: text(payload.idempotencyKey),
          movement: record(payload.movement),
        }));
      case "issue_fma":
        return privateJson(await issueFmaDocuments(access, {
          fieldId,
          animalIds: stringArray(payload.animalIds),
          idempotencyKey: text(payload.idempotencyKey),
          movement: record(payload.movement),
          supersedesDocumentId: nullableText(payload.supersedesDocumentId),
        }));
      case "annul_fma":
        return privateJson(await annulFmaDocument(access, {
          fieldId,
          documentId: text(payload.documentId),
          reason: text(payload.reason),
          idempotencyKey: text(payload.idempotencyKey),
          expectedVersion: integer(payload.expectedVersion),
        }));
      case "generate_dea":
        return privateJson(await generateDeaDraft(access, {
          fieldId,
          period: integer(payload.period),
          asOfDate: text(payload.asOfDate),
          idempotencyKey: text(payload.idempotencyKey),
        }));
      default:
        return privateJson({ error: "Selecciona una operación de trazabilidad válida." }, 400);
    }
  } catch (cause) {
    return traceabilityFailure("trazabilidad.mutation", "No fue posible completar la operación de trazabilidad.", cause);
  }
}

async function handleTraceabilityFileUpload(request: Request): Promise<Response> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return privateJson({ error: "La solicitud no contiene un archivo válido." }, 400);
  }
  const action = text(formData.get("action"));
  const fieldId = text(formData.get("fieldId"));
  const sourceKind = text(formData.get("sourceKind"));
  const idempotencyKey = text(formData.get("idempotencyKey"));
  const file = formData.get("file");
  if (action !== "stage_import_file" || sourceKind !== "cliex_dbf") return privateJson({ error: "La carga de archivo solo admite DBF Cliex/Cooprinsem." }, 400);
  if (!fieldId) return privateJson({ error: "Selecciona un fundo." }, 400);
  if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".dbf")) return privateJson({ error: "Selecciona un archivo .DBF." }, 400);
  if (file.size <= 0 || file.size > MAX_TRACEABILITY_DBF_BYTES) return privateJson({ error: "El DBF debe tener contenido y no superar 1 MB." }, 400);
  const access = await authorizeApiAccess("trazabilidad:write", fieldId);
  if (isAccessResponse(access)) return access;
  return privateJson(await stageTraceabilityDbfImport(access, {
    fieldId,
    filename: file.name,
    bytes: await file.arrayBuffer(),
    idempotencyKey,
  }));
}

function traceabilityFailure(operation: string, message: string, cause: unknown): Response {
  if (cause instanceof TraceabilityRequestError) {
    return privateJson({ error: cause.message, code: cause.code, ...(cause.issues ? { issues: cause.issues } : {}) }, cause.status);
  }
  return unexpectedApiFailure(operation, message, cause);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableText(value: unknown): string | null {
  const valueText = text(value);
  return valueText || null;
}

function integer(value: unknown): number {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : Number.NaN;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry)) : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()).filter(Boolean) : [];
}

function establishmentKind(value: unknown): "dairy" | "beef" | "mixed" | "other" {
  if (value === "dairy" || value === "beef" || value === "mixed" || value === "other") return value;
  return "other";
}

function deviceType(value: unknown): "double_ear_tag" | "ear_button" | "ruminal_bolus" {
  if (value === "double_ear_tag" || value === "ear_button" || value === "ruminal_bolus") return value;
  return "double_ear_tag";
}

function transitionAction(value: unknown): "assign" | "report_lost" | "replace" | "retire" {
  if (value === "assign" || value === "report_lost" || value === "replace" || value === "retire") return value;
  throw new TraceabilityRequestError("Selecciona una transición DIIO válida.");
}

function sourceKind(value: unknown): "sipec_file" | "cliex_dbf" | "manual_template" {
  if (value === "sipec_file" || value === "cliex_dbf" || value === "manual_template") return value;
  throw new TraceabilityRequestError("Selecciona el origen de la importación.");
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
