export const FEEDBACK_CATEGORIES = ["bug", "improvement", "recommendation"] as const;
export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number];

export const FEEDBACK_IMPACTS = ["blocked", "difficult", "non_urgent"] as const;
export type FeedbackImpact = (typeof FEEDBACK_IMPACTS)[number];

export const FEEDBACK_STATUSES = ["new", "reviewing", "planned", "resolved", "closed"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type FeedbackPriority = (typeof FEEDBACK_PRIORITIES)[number];

export const FEEDBACK_CATEGORY_LABELS: Record<FeedbackCategory, string> = {
  bug: "Encontré un error",
  improvement: "Idea de mejora",
  recommendation: "Recomendación",
};

export const FEEDBACK_IMPACT_LABELS: Record<FeedbackImpact, string> = {
  blocked: "Me impide continuar",
  difficult: "Me dificulta el trabajo",
  non_urgent: "No es urgente",
};

export const FEEDBACK_STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "Nuevo",
  reviewing: "En revisión",
  planned: "Planificado",
  resolved: "Resuelto",
  closed: "Cerrado",
};

export const FEEDBACK_PRIORITY_LABELS: Record<FeedbackPriority, string> = {
  p0: "P0 · Crítica",
  p1: "P1 · Alta",
  p2: "P2 · Media",
  p3: "P3 · Baja",
};

export type ValidatedFeedbackSubmission = {
  category: FeedbackCategory;
  impact: FeedbackImpact;
  message: string;
  contactAllowed: boolean;
  submissionKey: string;
  pagePath: string;
  fieldId: string | null;
  viewportWidth: number | null;
  viewportHeight: number | null;
  online: boolean;
};

export type ProductFeedbackItem = {
  id: string;
  organizationId: string;
  organizationName: string;
  fieldId: string | null;
  fieldName: string | null;
  reporterMembershipId: string;
  reporterEmail: string;
  reporterName: string;
  planCode: "legacy" | "free" | "pro";
  category: FeedbackCategory;
  impact: FeedbackImpact;
  message: string;
  contactAllowed: boolean;
  pagePath: string;
  releaseSha: string;
  userAgent: string;
  viewportWidth: number | null;
  viewportHeight: number | null;
  online: boolean;
  status: FeedbackStatus;
  priority: FeedbackPriority | null;
  staffNote: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ProductFeedbackSummary = {
  total: number;
  new: number;
  reviewing: number;
  planned: number;
  resolved: number;
  closed: number;
};

export type StaffFeedbackFilters = {
  category?: FeedbackCategory;
  status?: FeedbackStatus;
  priority?: FeedbackPriority | "unassigned";
  organizationId?: string;
  search?: string;
  limit?: number;
};

export type StaffFeedbackUpdate = {
  feedbackId: string;
  expectedVersion: number;
  status: FeedbackStatus;
  priority: FeedbackPriority | null;
  staffNote: string | null;
};

export class FeedbackRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "FeedbackRequestError";
  }
}

export function validateFeedbackSubmission(value: unknown): ValidatedFeedbackSubmission {
  const record = objectRecord(value);
  const category = enumValue(record.category, FEEDBACK_CATEGORIES);
  const impact = enumValue(record.impact, FEEDBACK_IMPACTS);
  const message = text(record.message, 4000);
  const submissionKey = text(record.submissionKey, 36).toLowerCase();
  const pagePath = normalizePagePath(record.pagePath);
  const fieldId = optionalIdentifier(record.fieldId, 160);
  const viewportWidth = optionalInteger(record.viewportWidth, 240, 10000);
  const viewportHeight = optionalInteger(record.viewportHeight, 240, 10000);

  if (!category) {
    throw new FeedbackRequestError("Selecciona si encontraste un error, una mejora o una recomendación.", 400, "FEEDBACK_CATEGORY_INVALID");
  }
  if (!impact) {
    throw new FeedbackRequestError("Indica cuánto afecta este comentario a tu trabajo.", 400, "FEEDBACK_IMPACT_INVALID");
  }
  if (message.length < 10) {
    throw new FeedbackRequestError("Cuéntanos un poco más: escribe al menos 10 caracteres.", 400, "FEEDBACK_MESSAGE_TOO_SHORT");
  }
  if (!UUID_PATTERN.test(submissionKey)) {
    throw new FeedbackRequestError("No fue posible identificar este envío. Inténtalo nuevamente.", 400, "FEEDBACK_SUBMISSION_KEY_INVALID");
  }
  if (!pagePath) {
    throw new FeedbackRequestError("La pantalla desde la que envías el comentario no es válida.", 400, "FEEDBACK_PAGE_INVALID");
  }
  if (typeof record.contactAllowed !== "boolean" || typeof record.online !== "boolean") {
    throw new FeedbackRequestError("El contexto del comentario no es válido.", 400, "FEEDBACK_CONTEXT_INVALID");
  }
  if ((record.viewportWidth != null && viewportWidth === null) || (record.viewportHeight != null && viewportHeight === null)) {
    throw new FeedbackRequestError("El tamaño de pantalla informado no es válido.", 400, "FEEDBACK_VIEWPORT_INVALID");
  }

  return {
    category,
    impact,
    message,
    contactAllowed: record.contactAllowed,
    submissionKey,
    pagePath,
    fieldId,
    viewportWidth,
    viewportHeight,
    online: record.online,
  };
}

export function validateStaffFeedbackUpdate(value: unknown): StaffFeedbackUpdate {
  const record = objectRecord(value);
  const feedbackId = identifier(record.feedbackId, 160);
  const status = enumValue(record.status, FEEDBACK_STATUSES);
  const priority = record.priority === null ? null : enumValue(record.priority, FEEDBACK_PRIORITIES);
  const expectedVersion = Number(record.expectedVersion);
  const note = text(record.staffNote, 2000);

  if (!feedbackId || !status || (record.priority !== null && !priority)) {
    throw new FeedbackRequestError("La actualización de seguimiento no es válida.", 400, "FEEDBACK_TRIAGE_INVALID");
  }
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    throw new FeedbackRequestError("La versión del comentario no es válida.", 400, "FEEDBACK_VERSION_INVALID");
  }
  if (record.staffNote != null && typeof record.staffNote !== "string") {
    throw new FeedbackRequestError("La nota interna no es válida.", 400, "FEEDBACK_NOTE_INVALID");
  }

  return {
    feedbackId,
    expectedVersion,
    status,
    priority,
    staffNote: note || null,
  };
}

export function parseStaffFeedbackFilters(searchParams: URLSearchParams, limit = 200): StaffFeedbackFilters {
  const category = enumValue(searchParams.get("category"), FEEDBACK_CATEGORIES) ?? undefined;
  const status = enumValue(searchParams.get("status"), FEEDBACK_STATUSES) ?? undefined;
  const rawPriority = searchParams.get("priority");
  const priority = rawPriority === "unassigned"
    ? "unassigned"
    : enumValue(rawPriority, FEEDBACK_PRIORITIES) ?? undefined;
  const organizationId = optionalIdentifier(searchParams.get("organizationId"), 160) ?? undefined;
  const search = text(searchParams.get("search"), 120) || undefined;
  return {
    category,
    status,
    priority,
    organizationId,
    search,
    limit: Math.min(Math.max(limit, 1), 1000),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/u;

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FeedbackRequestError("La solicitud no contiene un comentario válido.", 400, "FEEDBACK_BODY_INVALID");
  }
  return value as Record<string, unknown>;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] | null {
  return typeof value === "string" && values.includes(value) ? value as Values[number] : null;
}

function text(value: unknown, maximum: number): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return normalized.length <= maximum ? normalized : "";
}

function identifier(value: unknown, maximum: number): string {
  const normalized = text(value, maximum);
  return normalized && IDENTIFIER_PATTERN.test(normalized) ? normalized : "";
}

function optionalIdentifier(value: unknown, maximum: number): string | null {
  if (value == null || value === "") return null;
  return identifier(value, maximum) || null;
}

function optionalInteger(value: unknown, minimum: number, maximum: number): number | null {
  if (value == null) return null;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= minimum && numeric <= maximum ? numeric : null;
}

function normalizePagePath(value: unknown): string {
  const raw = text(value, 1024);
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "";
  try {
    const parsed = new URL(raw, "https://fundosmart.local");
    if (parsed.origin !== "https://fundosmart.local") return "";
    if (parsed.pathname !== "/app" && !parsed.pathname.startsWith("/app/")) return "";
    return parsed.pathname;
  } catch {
    return "";
  }
}
