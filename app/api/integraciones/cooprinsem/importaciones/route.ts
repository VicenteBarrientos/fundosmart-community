import { authorizeApiAccess, isAccessResponse, requireContextField, requireResourceField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { COOPRINSEM_SOURCE_TABLE_NAMES, type CooprinsemSourceTable } from "@/src/modules/integraciones/cooprinsem/domain/types";
import { buildCooprinsemPreview, DbfParseError, parseDbf } from "@/src/modules/integraciones/cooprinsem/server/dbf-parser.mjs";
import { ImportFileStorageError } from "@/src/modules/integraciones/cooprinsem/server/file-storage";
import {
  createStoredImportJob,
  ImportFileCompensationError,
} from "@/src/modules/integraciones/cooprinsem/server/intake-repository";
import {
  findImportJobByFingerprint,
  getImportDashboard,
  getImportPreview,
  getImportPreviewForUpload,
  hasCurrentImportActorAccess,
  ImportAccessChangedError,
  ImportJobScopeError,
  ImportPreviewLimitError,
  markImportFailed,
  markImportParsing,
  resolveImportField,
  saveImportPreview,
} from "@/src/modules/integraciones/cooprinsem/server/import-repository";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAPPING_VERSION = "0.1-draft";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const importAccess = {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };

  try {
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) {
      const dashboard = await getImportDashboard(importAccess);
      return Response.json({ dashboard }, { headers: { "Cache-Control": "no-store" } });
    }
    const forbidden = await requireResourceField(access, "import_job", id);
    if (forbidden) return forbidden;
    const preview = await getImportPreview(id, importAccess);
    if (!preview) return Response.json({ error: "La importación no existe o no está disponible para este usuario." }, { status: 404 });
    return Response.json({ preview }, { headers: { "Cache-Control": "no-store" } });
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) return importAccessChanged(cause);
    throw cause;
  }
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: "La solicitud no contiene un formulario de archivo válido." }, { status: 400 });
  }

  const file = formData.get("file");
  const fieldId = textValue(formData.get("fieldId"));
  const sourceTableValue = textValue(formData.get("sourceTable"));
  const effectiveAt = textValue(formData.get("effectiveAt")) || null;
  if (!(file instanceof File)) return Response.json({ error: "Selecciona un archivo DBF." }, { status: 400 });
  if (!fieldId) return Response.json({ error: "Selecciona el fundo de destino." }, { status: 400 });
  const fieldForbidden = requireContextField(access, fieldId);
  if (fieldForbidden) return fieldForbidden;
  if (!COOPRINSEM_SOURCE_TABLE_NAMES.includes(sourceTableValue as CooprinsemSourceTable)) {
    return Response.json({ error: "Selecciona una tabla Cooprinsem soportada." }, { status: 400 });
  }
  const sourceTable = sourceTableValue as CooprinsemSourceTable;
  if (!file.name.toLowerCase().endsWith(".dbf")) return Response.json({ error: "Esta etapa admite únicamente archivos .DBF." }, { status: 400 });
  if (file.size <= 0 || file.size > MAX_FILE_BYTES) {
    return Response.json({ error: "El archivo debe tener contenido y no superar 20 MB." }, { status: 400 });
  }

  const importAccess = { organizationId: access.organizationId, fieldIds: access.fieldIds };
  const field = await resolveImportField(fieldId, importAccess);
  if (!field) return Response.json({ error: "El fundo seleccionado no existe." }, { status: 404 });
  const actorAccess = {
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: field.fieldId,
    fieldIds: access.fieldIds,
    actorEmail: access.email,
  };

  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const fingerprint = {
    organizationId: access.organizationId,
    fieldId: field.fieldId,
    fieldIds: access.fieldIds,
    sha256,
    mappingVersion: MAPPING_VERSION,
  };
  const existing = await findImportJobByFingerprint(fingerprint);
  if (existing) {
    if (existing.status === "preview_ready") {
      const preview = await getImportPreviewForUpload(existing.id, importAccess, true);
      if (preview) return currentPreviewResponse(preview, actorAccess);
    }
    const message = existing.status === "failed"
      ? existing.failureMessage || "Este archivo ya fue analizado y falló la validación."
      : "La importación existente todavía no tiene una vista previa disponible.";
    return Response.json({ error: message, importId: existing.id }, { status: existing.status === "failed" ? 422 : 409 });
  }

  const importId = crypto.randomUUID();
  let created;
  try {
    created = await createStoredImportJob({
      bytes,
      id: importId,
      membershipId: access.membershipId,
      organizationId: access.organizationId,
      fieldId: field.fieldId,
      fieldIds: access.fieldIds,
      sourceTable,
      originalFilename: file.name,
      contentType: file.type || null,
      fileSizeBytes: file.size,
      sha256,
      mappingVersion: MAPPING_VERSION,
      effectiveAt,
      requestedBy: access.email,
    });
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    if (cause instanceof ImportFileStorageError || cause instanceof ImportFileCompensationError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 503 });
    }
    throw cause;
  }
  if (!created.created) {
    if (created.job.status === "preview_ready") {
      const preview = await getImportPreviewForUpload(created.job.id, importAccess, true);
      if (preview) return currentPreviewResponse(preview, actorAccess);
    }
    return Response.json({ error: "Otra carga del mismo archivo está en curso.", importId: created.job.id }, { status: 409 });
  }

  const lifecycle = {
    importJobId: importId,
    organizationId: access.organizationId,
    fieldId: field.fieldId,
    fieldIds: access.fieldIds,
  };
  let parsingStartedAt: string;
  try {
    parsingStartedAt = await markImportParsing(lifecycle);
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) return importScopeChanged(cause);
    throw cause;
  }
  const parsingLifecycle = { ...lifecycle, parsingStartedAt };
  try {
    const parsed = parseDbf(bytes);
    const staged = buildCooprinsemPreview(parsed, { sourceTable, effectiveAt });
    await saveImportPreview({ ...parsingLifecycle, rows: staged.rows, summary: staged.summary });
    const preview = await getImportPreviewForUpload(importId, importAccess);
    if (!preview) throw new Error("La vista previa no quedó disponible después de guardar el archivo.");
    return currentPreviewResponse(preview, actorAccess, 201);
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) return importScopeChanged(cause);
    const parseFailure = cause instanceof DbfParseError;
    const previewLimitFailure = cause instanceof ImportPreviewLimitError;
    const publicMessage = parseFailure || previewLimitFailure
      ? cause.message
      : "No fue posible procesar el archivo importado.";
    try {
      await markImportFailed({ ...parsingLifecycle, message: publicMessage });
    } catch (failure) {
      if (failure instanceof ImportJobScopeError) return importScopeChanged(failure);
      return unexpectedApiFailure("cooprinsem.import.preview", publicMessage, failure, { importId });
    }
    if (parseFailure || previewLimitFailure) return Response.json({ error: publicMessage, importId }, { status: 422 });
    return unexpectedApiFailure("cooprinsem.import.preview", publicMessage, cause, { importId });
  }
}

async function currentPreviewResponse(
  preview: unknown,
  access: Parameters<typeof hasCurrentImportActorAccess>[0],
  status = 200,
): Promise<Response> {
  if (!(await hasCurrentImportActorAccess(access))) {
    return Response.json({
      error: "La membresia o el alcance cambio durante la carga; vuelve a iniciar la importacion.",
      code: "IMPORT_SCOPE_CHANGED",
    }, { status: 409 });
  }
  return Response.json({ preview }, { status });
}

function importScopeChanged(cause: ImportJobScopeError): Response {
  return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
}

function importAccessChanged(cause: ImportAccessChangedError): Response {
  return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
}

function textValue(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
