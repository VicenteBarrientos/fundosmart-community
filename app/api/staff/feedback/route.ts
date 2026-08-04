import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { authorizeApiLegalAcceptance } from "@/app/legal-access";
import {
  authorizeStaffCapability,
  isStaffAccountOpen,
  PLATFORM_STAFF_V2_REQUIRED_KEY,
  reauthorizeStaffCapability,
  type StaffCapabilityAccess,
} from "@/app/staff-access";
import {
  FeedbackRequestError,
  parseStaffFeedbackFilters,
  validateStaffFeedbackUpdate,
  type ProductFeedbackItem,
} from "@/src/modules/feedback/domain/types";
import {
  isSameOriginFeedbackMutation,
  privateFeedbackJson,
  readBoundedJsonObject,
} from "@/src/modules/feedback/server/feedback-http";
import {
  listProductFeedbackForStaff,
  updateProductFeedbackForStaff,
} from "@/src/modules/feedback/server/feedback-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  const staff = await verifyStaff();
  if (staff instanceof Response) return staff;
  if (!staff) return privateFeedbackJson({ error: "No autorizado." }, 403);

  try {
    const url = new URL(request.url);
    const format = url.searchParams.get("format");
    const exporting = format === "csv" || format === "json";
    const filters = parseStaffFeedbackFilters(url.searchParams, exporting ? 1000 : 200);
    const result = await listProductFeedbackForStaff(filters);
    const currentStaff = await reauthorizeStaffCapability(staff);
    if (!currentStaff) return staffAccessChangedResponse();

    if (format === "csv") {
      return new Response(feedbackCsv(result.items), {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": 'attachment; filename="fundosmart-feedback.csv"',
          "Content-Type": "text/csv; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    if (format === "json") {
      return new Response(JSON.stringify({
        exportedAt: new Date().toISOString(),
        count: result.items.length,
        filters,
        feedback: result.items,
      }, null, 2), {
        headers: {
          "Cache-Control": "private, no-store",
          "Content-Disposition": 'attachment; filename="fundosmart-feedback.json"',
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        },
      });
    }
    return privateFeedbackJson(result);
  } catch (cause) {
    return unexpectedApiFailure(
      "product_feedback.staff.list",
      "No fue posible cargar los comentarios.",
      cause,
    );
  }
}

export async function PATCH(request: Request): Promise<Response> {
  if (!isSameOriginFeedbackMutation(request)) {
    return privateFeedbackJson({
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }
  const staff = await verifyStaff();
  if (staff instanceof Response) return staff;
  if (!staff) return privateFeedbackJson({ error: "No autorizado." }, 403);

  try {
    const payload = await readBoundedJsonObject(request);
    if (payload instanceof Response) return payload;
    const update = validateStaffFeedbackUpdate(payload);
    const currentStaff = await reauthorizeStaffCapability(staff);
    if (!currentStaff) return staffAccessChangedResponse();
    const feedback = await updateProductFeedbackForStaff({
      actorSubject: currentStaff.user.subject,
      actorEmail: currentStaff.user.email,
      staffCutoverMarkerKey: PLATFORM_STAFF_V2_REQUIRED_KEY,
      update,
    });
    const responseStaff = await reauthorizeStaffCapability(staff);
    if (!responseStaff) return staffAccessChangedResponse();
    return privateFeedbackJson({ feedback });
  } catch (cause) {
    if (cause instanceof FeedbackRequestError) {
      return privateFeedbackJson({ error: cause.message, code: cause.code }, cause.status);
    }
    return unexpectedApiFailure(
      "product_feedback.staff.update",
      "No fue posible actualizar el comentario.",
      cause,
    );
  }
}

/**
 * La bandeja de feedback es trabajo de soporte: listar, exportar y triar el
 * estado exigen `support:read`. El catálogo cerrado actual no distingue
 * lectura de triage dentro de soporte; si esa separación se vuelve necesaria hay
 * que ampliar el catálogo y su restricción en D1, no inventarla aquí.
 */
async function verifyStaff(): Promise<StaffCapabilityAccess | Response | null> {
  const access = await authorizeStaffCapability("support:read");
  if (!access || !access.resolution.granted) return null;
  const legalResponse = await authorizeApiLegalAcceptance(access.user);
  if (legalResponse) return legalResponse;
  if (!(await isStaffAccountOpen(access.user.subject))) {
    return privateFeedbackJson({
      error: "La cuenta está suspendida durante una ventana de gracia.",
      code: "ACCOUNT_CLOSURE_ACTIVE",
    }, 423);
  }
  return access;
}

function staffAccessChangedResponse(): Response {
  return privateFeedbackJson({
    error: "Tu acceso staff cambió durante la solicitud. Actualiza la página e inténtalo nuevamente.",
    code: "FEEDBACK_STAFF_ACCESS_CHANGED",
  }, 409);
}

function feedbackCsv(items: ProductFeedbackItem[]): string {
  const headers = [
    "id",
    "fecha",
    "categoría",
    "impacto",
    "estado",
    "prioridad",
    "plan",
    "organización",
    "fundo",
    "nombre",
    "correo",
    "autoriza_contacto",
    "pantalla",
    "versión_app",
    "comentario",
    "nota_interna",
  ];
  const rows = items.map((item) => [
    item.id,
    item.createdAt,
    item.category,
    item.impact,
    item.status,
    item.priority ?? "",
    item.planCode,
    item.organizationName,
    item.fieldName ?? "",
    item.reporterName,
    item.reporterEmail,
    item.contactAllowed ? "sí" : "no",
    item.pagePath,
    item.releaseSha,
    item.message,
    item.staffNote ?? "",
  ]);
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

function csvCell(value: string): string {
  const formulaSafe = /^[=+\-@]/u.test(value.trimStart()) ? `'${value}` : value;
  return `"${formulaSafe.replaceAll('"', '""')}"`;
}
