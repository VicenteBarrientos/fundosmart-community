import { authorizeApiAccess, isAccessResponse, requireContextField, requireResourceField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  createStoredImportJob,
  ImportFileCompensationError,
} from "@/src/modules/integraciones/cooprinsem/server/intake-repository";
import { ImportFileStorageError } from "@/src/modules/integraciones/cooprinsem/server/file-storage";
import {
  findImportJobByFingerprint,
  hasCurrentImportActorAccess,
  ImportAccessChangedError,
  ImportJobScopeError,
  ImportPreviewLimitError,
  markImportFailed,
  markImportParsing,
  resolveImportField,
  saveImportPreview,
} from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import {
  IMPORT_PROFILE_KEYS,
  type AgronomicVisitSnapshot,
  type CooprinsemSoilReportDocument,
  type ImportCenterSummary,
  type ImportDocumentSnapshot,
  type ImportFormat,
  type ImportProfileKey,
  type ImportRecord,
  type SurvetMilkControlDocument,
  type WattsVisitSnapshot,
} from "@/src/modules/importaciones/domain/types";
import type { StagedPreviewRow } from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import {
  AgronomicVisitParseError,
  agronomicVisitPreviewRows,
  parseAgronomicVisitText,
} from "@/src/modules/importaciones/server/agronomic-visit-parser.mjs";
import { extractPdfText, PdfTextExtractionError } from "@/src/modules/importaciones/server/pdf-text.mjs";
import { parseTabularFile, TabularParseError } from "@/src/modules/importaciones/server/tabular-parser.mjs";
import {
  parseCooprinsemSoilReportText,
  SoilReportParseError,
  soilReportPreviewRows,
} from "@/src/modules/importaciones/server/soil-report-parser.mjs";
import {
  parseSurvetControlWorkbook,
  SurvetControlParseError,
} from "@/src/modules/importaciones/server/survet-control-parser.mjs";
import {
  parseWattsVisitText,
  WattsVisitParseError,
  wattsPreviewRows,
} from "@/src/modules/importaciones/server/watts-visit-parser.mjs";
import {
  confirmationReceiptIntegrityError,
  confirmImportVisit,
  getImportCenterDashboard,
  getImportCenterPreview,
  ImportCenterError,
  reconcileAgronomicPaddocks,
  reconcileSurvetImportRows,
  remapGenericImport,
  saveImportJobSpec,
} from "@/src/modules/importaciones/server/import-center-repository";

export const dynamic = "force-dynamic";

const WATTS_MAX_BYTES = 10 * 1024 * 1024;
const TABLE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_VERSION = "1.0.0";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  const actor = actorAccess(access);
  try {
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return privateJson({ dashboard: await getImportCenterDashboard(actor) });
    const forbidden = await requireResourceField(access, "import_job", id);
    if (forbidden) return forbidden;
    const preview = await getImportCenterPreview(id, actor);
    if (!preview) return privateJson({ error: "La importación no existe o pertenece a otro proveedor." }, 404);
    return privateJson({ preview });
  } catch (cause) {
    if (cause instanceof ImportAccessChangedError) return privateJson({ error: cause.message, code: cause.code }, 409);
    return unexpectedApiFailure("importaciones.read", "No fue posible leer el centro de importaciones.", cause);
  }
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return privateJson({ error: "La solicitud no contiene un formulario de archivo válido." }, 400);
  }
  const file = formData.get("file");
  const fieldId = textValue(formData.get("fieldId"));
  const profileKey = textValue(formData.get("profileKey"));
  const requestedDate = textValue(formData.get("effectiveAt"));
  if (!(file instanceof File)) return privateJson({ error: "Selecciona un archivo." }, 400);
  if (!fieldId) return privateJson({ error: "Selecciona el fundo de destino." }, 400);
  const fieldForbidden = requireContextField(access, fieldId);
  if (fieldForbidden) return fieldForbidden;
  if (!IMPORT_PROFILE_KEYS.includes(profileKey as ImportProfileKey)) {
    return privateJson({ error: "Selecciona un perfil de importación soportado." }, 400);
  }

  const profile = profileDefinition(profileKey as ImportProfileKey, file.name, requestedDate);
  if (!profile.ok) return privateJson({ error: profile.error }, 400);
  if (file.size <= 0 || file.size > profile.maxBytes) {
    return privateJson({ error: `El archivo debe tener contenido y no superar ${profile.maxBytes / 1024 / 1024} MB.` }, 400);
  }

  const field = await resolveImportField(fieldId, {
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  });
  if (!field) return privateJson({ error: "El fundo seleccionado no existe." }, 404);
  const actor = actorAccess(access);
  const actorField = {
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    fieldId: field.fieldId,
    fieldIds: access.fieldIds,
    actorEmail: access.email,
  };
  const bytes = await file.arrayBuffer();
  const sha256 = await sha256Hex(bytes);
  const mappingVersion = `${profile.profileKey}:parser.${PROFILE_VERSION}`;
  const fingerprint = {
    organizationId: access.organizationId,
    fieldId: field.fieldId,
    fieldIds: access.fieldIds,
    sha256,
    mappingVersion,
    sourceSystem: profile.sourceSystem,
  };
  const existing = await findImportJobByFingerprint(fingerprint);
  if (existing) {
    const preview = await getImportCenterPreview(existing.id, actor, true);
    if (preview) return currentPreviewResponse(preview, actorField);
    const message = existing.status === "failed"
      ? existing.failureMessage || "Este archivo ya fue analizado y falló la validación."
      : "La importación existente todavía no tiene una vista previa disponible.";
    return privateJson({ error: message, importId: existing.id }, existing.status === "failed" ? 422 : 409);
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
      sourceSystem: profile.sourceSystem,
      sourceFormat: profile.sourceFormat,
      sourceTable: profile.sourceTable,
      originalFilename: file.name,
      contentType: file.type || null,
      fileSizeBytes: file.size,
      sha256,
      mappingVersion,
      effectiveAt: profile.initialEffectiveAt,
      requestedBy: access.email,
    });
  } catch (cause) {
    if (cause instanceof ImportJobScopeError) return privateJson({ error: cause.message, code: cause.code }, 409);
    if (cause instanceof ImportFileStorageError || cause instanceof ImportFileCompensationError) {
      return privateJson({ error: cause.message, code: cause.code }, 503);
    }
    return unexpectedApiFailure("importaciones.store", "No fue posible conservar el archivo original.", cause, { importId });
  }
  if (!created.created) {
    const preview = await getImportCenterPreview(created.job.id, actor, true);
    if (preview) return currentPreviewResponse(preview, actorField);
    return privateJson({ error: "Otra carga del mismo archivo está en curso.", importId: created.job.id }, 409);
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
    if (cause instanceof ImportJobScopeError) return privateJson({ error: cause.message, code: cause.code }, 409);
    return unexpectedApiFailure("importaciones.claim", "No fue posible iniciar el análisis.", cause, { importId });
  }
  const parsingLifecycle = { ...lifecycle, parsingStartedAt };
  try {
    const parsed = await parseProfile(bytes, file.name, profile.profileKey, {
      access: actor,
      fieldId: field.fieldId,
    });
    const effectiveAt = parsed.effectiveAt || profile.initialEffectiveAt;
    if (!effectiveAt) throw new ImportCenterError("El documento no contiene una fecha efectiva.", "IMPORT_DATE_REQUIRED");
    await saveImportJobSpec({
      ...parsingLifecycle,
      sourceSystem: profile.sourceSystem,
      profileKey: profile.profileKey,
      profileVersion: PROFILE_VERSION,
      document: parsed.document,
      effectiveAt,
      updatedBy: access.email,
    });
    await saveImportPreview({
      ...parsingLifecycle,
      rows: parsed.rows,
      summary: parsed.summary,
    });
    const preview = await getImportCenterPreview(importId, actor);
    if (!preview) throw new ImportCenterError("La vista previa no quedó disponible.", "IMPORT_PREVIEW_MISSING");
    return currentPreviewResponse(preview, actorField, 201);
  } catch (cause) {
    const publicFailure = knownParseFailure(cause)
      ? cause.message
      : "No fue posible procesar el archivo importado.";
    try {
      await markImportFailed({ ...parsingLifecycle, message: publicFailure });
    } catch (failure) {
      if (failure instanceof ImportJobScopeError) return privateJson({ error: failure.message, code: failure.code }, 409);
      return unexpectedApiFailure("importaciones.preview", publicFailure, failure, { importId });
    }
    if (knownParseFailure(cause)) return privateJson({ error: publicFailure, code: cause.code, importId }, 422);
    return unexpectedApiFailure("importaciones.preview", publicFailure, cause, { importId });
  }
}

export async function PATCH(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;
  let body: {
    action?: unknown;
    importId?: unknown;
    mapping?: unknown;
    mappings?: unknown;
    confirmation?: unknown;
    paddockId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return privateJson({ error: "La solicitud JSON no es válida." }, 400);
  }
  const importId = textValue(body.importId);
  const action = textValue(body.action);
  if (!importId) return privateJson({ error: "Falta la importación." }, 400);
  const forbidden = await requireResourceField(access, "import_job", importId);
  if (forbidden) return forbidden;

  try {
    if (action === "map") {
      const preview = await remapGenericImport({
        importJobId: importId,
        membershipId: access.membershipId,
        organizationId: access.organizationId,
        fieldIds: access.fieldIds,
        email: access.email,
        mapping: body.mapping,
      });
      return privateJson({ preview });
    }
    if (action === "reconcile_paddocks") {
      const preview = await reconcileAgronomicPaddocks({
        importJobId: importId,
        membershipId: access.membershipId,
        organizationId: access.organizationId,
        fieldIds: access.fieldIds,
        email: access.email,
        mappings: body.mappings,
      });
      return privateJson({ preview });
    }
    if (action === "confirm") {
      const paddockId = textValue(body.paddockId);
      if (paddockId) {
        const paddockForbidden = await requireResourceField(access, "paddock", paddockId);
        if (paddockForbidden) return paddockForbidden;
      }
      const confirmation = await confirmImportVisit({
        importJobId: importId,
        membershipId: access.membershipId,
        organizationId: access.organizationId,
        fieldIds: access.fieldIds,
        email: access.email,
        confirmation: textValue(body.confirmation),
        paddockId,
      });
      try {
        const [preview, dashboard] = await Promise.all([
          getImportCenterPreview(importId, actorAccess(access)),
          getImportCenterDashboard(actorAccess(access)),
        ]);
        if (!preview) throw confirmationReceiptIntegrityError();
        return privateJson({ confirmation, dashboard, preview });
      } catch (cause) {
        console.error({
          event: "fundosmart.import_receipt_response_failure",
          operation: "importaciones.confirm.response",
          errorType: cause instanceof Error ? cause.name : typeof cause,
        });
        throw confirmationReceiptIntegrityError();
      }
    }
    return privateJson({ error: "La acción solicitada no está soportada." }, 400);
  } catch (cause) {
    if (cause instanceof ImportCenterError) return privateJson({ error: cause.message, code: cause.code }, centerStatus(cause.code));
    if (cause instanceof ImportAccessChangedError) return privateJson({ error: cause.message, code: cause.code }, 409);
    return unexpectedApiFailure("importaciones.mutate", "No fue posible actualizar la importación.", cause, { importId, action });
  }
}

type ParsedProfile = {
  document: ImportDocumentSnapshot;
  effectiveAt: string | null;
  rows: StagedPreviewRow[];
  summary: ImportCenterSummary;
};

async function parseProfile(
  bytes: ArrayBuffer,
  filename: string,
  profileKey: ImportProfileKey,
  context: {
    access: ReturnType<typeof actorAccess>;
    fieldId: string;
  },
): Promise<ParsedProfile> {
  if (profileKey === "cooprinsem.soil_report.pdf.v1") {
    const extracted = await extractPdfText(bytes);
    const document = parseCooprinsemSoilReportText(extracted.strings) as CooprinsemSoilReportDocument;
    const rows = soilReportPreviewRows(document) as StagedPreviewRow[];
    return {
      document,
      effectiveAt: document.reportDate,
      rows,
      summary: {
        rowCount: rows.length,
        validRowCount: rows.length,
        warningRowCount: 0,
        errorRowCount: 0,
        skippedRowCount: 0,
        fileIssueCount: 0,
      },
    };
  }
  if (profileKey === "watts.visit_report.pdf.v1") {
    const extracted = await extractPdfText(bytes);
    const document = parseWattsVisitText(extracted.strings) as WattsVisitSnapshot;
    const rows = wattsPreviewRows(document) as StagedPreviewRow[];
    return {
      document,
      effectiveAt: document.visitDate,
      rows,
      summary: {
        rowCount: rows.length,
        validRowCount: 0,
        warningRowCount: rows.length,
        errorRowCount: 0,
        skippedRowCount: 0,
        fileIssueCount: 0,
      },
    };
  }
  if (profileKey === "agronomic.visit_report.pdf.v1") {
    const extracted = await extractPdfText(bytes);
    const document = parseAgronomicVisitText(extracted.lines) as AgronomicVisitSnapshot;
    const rows = agronomicVisitPreviewRows(document) as StagedPreviewRow[];
    return {
      document,
      effectiveAt: document.visitDate,
      rows,
      summary: {
        rowCount: rows.length,
        validRowCount: 0,
        warningRowCount: rows.length,
        errorRowCount: 0,
        skippedRowCount: 0,
        fileIssueCount: 0,
      },
    };
  }
  if (profileKey === "survet.milk_control.xlsx.v1") {
    const parsed = await parseSurvetControlWorkbook(bytes);
    const document = parsed.document as SurvetMilkControlDocument;
    const reconciled = await reconcileSurvetImportRows({
      access: context.access,
      fieldId: context.fieldId,
      controlDate: document.controlDate,
      rows: parsed.rows as StagedPreviewRow[],
    });
    return {
      document,
      effectiveAt: document.controlDate,
      rows: reconciled.rows,
      summary: reconciled.summary,
    };
  }
  const parsed = await parseTabularFile(bytes, { filename, maxRows: 100 });
  if (parsed.truncated) {
    throw new TabularParseError(
      "Esta primera versión admite hasta 100 filas por archivo. Divide la planilla antes de importarla.",
      "TABULAR_ROW_LIMIT",
    );
  }
  const document = {
    kind: "tabular_pasture_measurements" as const,
    schemaVersion: "fundosmart.tabular-pasture-measurements.v1" as const,
    headers: parsed.headers,
    sheetName: parsed.sheetName,
    sourceRowCount: parsed.sourceRowCount,
    truncated: false,
  };
  const rows: StagedPreviewRow[] = parsed.rows.map((rawRecord: ImportRecord, index: number) => ({
    recordNumber: index + 1,
    rawRecord,
    normalizedRecord: null,
    status: "pending" as const,
    issues: [],
  }));
  return {
    document,
    effectiveAt: null,
    rows,
    summary: {
      rowCount: rows.length,
      validRowCount: 0,
      warningRowCount: 0,
      errorRowCount: 0,
      skippedRowCount: 0,
      fileIssueCount: 0,
    },
  };
}

type ProfileDefinition =
  | {
    ok: true;
    profileKey: ImportProfileKey;
    sourceSystem: "cooprinsem_soil" | "watts" | "agronomic_advisor" | "survet" | "generic";
    sourceFormat: ImportFormat;
    sourceTable: string;
    maxBytes: number;
    initialEffectiveAt: string | null;
  }
  | { ok: false; error: string; maxBytes: number };

function profileDefinition(profileKey: ImportProfileKey, filename: string, effectiveAt: string): ProfileDefinition {
  const extension = filename.toLowerCase().split(".").pop() ?? "";
  if (profileKey === "agronomic.visit_report.pdf.v1") {
    return extension === "pdf"
      ? {
        ok: true,
        profileKey,
        sourceSystem: "agronomic_advisor" as const,
        sourceFormat: "pdf" as const,
        sourceTable: "agronomic_visit_report",
        maxBytes: WATTS_MAX_BYTES,
        initialEffectiveAt: null,
      }
      : {
        ok: false,
        error: "El perfil de visita agronómica admite únicamente archivos .pdf.",
        maxBytes: WATTS_MAX_BYTES,
      };
  }
  if (profileKey === "cooprinsem.soil_report.pdf.v1") {
    return extension === "pdf"
      ? {
        ok: true,
        profileKey,
        sourceSystem: "cooprinsem_soil" as const,
        sourceFormat: "pdf" as const,
        sourceTable: "soil_report",
        maxBytes: WATTS_MAX_BYTES,
        initialEffectiveAt: null,
      }
      : {
        ok: false,
        error: "El perfil de análisis de suelo Cooprinsem admite únicamente archivos .pdf.",
        maxBytes: WATTS_MAX_BYTES,
      };
  }
  if (profileKey === "watts.visit_report.pdf.v1") {
    return extension === "pdf"
      ? {
        ok: true,
        profileKey,
        sourceSystem: "watts" as const,
        sourceFormat: "pdf" as const,
        sourceTable: "visit_report",
        maxBytes: WATTS_MAX_BYTES,
        initialEffectiveAt: null,
      }
      : { ok: false, error: "El perfil Watt's admite únicamente archivos .pdf.", maxBytes: WATTS_MAX_BYTES };
  }
  if (profileKey === "survet.milk_control.xlsx.v1") {
    return extension === "xlsx"
      ? {
        ok: true,
        profileKey,
        sourceSystem: "survet" as const,
        sourceFormat: "xlsx" as const,
        sourceTable: "milk_control",
        maxBytes: TABLE_MAX_BYTES,
        initialEffectiveAt: null,
      }
      : { ok: false, error: "El perfil Survet admite únicamente archivos .xlsx.", maxBytes: TABLE_MAX_BYTES };
  }
  if (!["csv", "xlsx", "xls"].includes(extension)) {
    return { ok: false, error: "El importador de mediciones admite .csv y .xlsx.", maxBytes: TABLE_MAX_BYTES };
  }
  if (!validIsoDate(effectiveAt)) {
    return { ok: false, error: "Selecciona la fecha general de las mediciones.", maxBytes: TABLE_MAX_BYTES };
  }
  return {
    ok: true,
    profileKey,
    sourceSystem: "generic" as const,
    sourceFormat: extension as ImportFormat,
    sourceTable: "pasture_measurements",
    maxBytes: TABLE_MAX_BYTES,
    initialEffectiveAt: effectiveAt,
  };
}

function actorAccess(access: {
  membershipId: string;
  email: string;
  organizationId: string;
  fieldIds: string[];
}) {
  return {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
}

async function currentPreviewResponse(
  preview: unknown,
  access: Parameters<typeof hasCurrentImportActorAccess>[0],
  status = 200,
) {
  if (!(await hasCurrentImportActorAccess(access))) {
    return privateJson({
      error: "La membresía o el alcance cambió durante la carga; vuelve a iniciar la importación.",
      code: "IMPORT_SCOPE_CHANGED",
    }, 409);
  }
  return privateJson({ preview }, status);
}

function knownParseFailure(cause: unknown): cause is
  | PdfTextExtractionError
  | AgronomicVisitParseError
  | SoilReportParseError
  | WattsVisitParseError
  | SurvetControlParseError
  | TabularParseError
  | ImportCenterError
  | ImportPreviewLimitError {
  return cause instanceof PdfTextExtractionError
    || cause instanceof AgronomicVisitParseError
    || cause instanceof SoilReportParseError
    || cause instanceof WattsVisitParseError
    || cause instanceof SurvetControlParseError
    || cause instanceof TabularParseError
    || cause instanceof ImportCenterError
    || cause instanceof ImportPreviewLimitError;
}

function centerStatus(code: string) {
  if (code === "IMPORT_NOT_FOUND") return 404;
  if (code === "IMPORT_CONFIRMATION_MISMATCH" || code.includes("MAPPING") || code.includes("REQUIRED")) return 400;
  return 409;
}

function validIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function privateJson(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
