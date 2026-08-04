import {
  authorizeApiAccess,
  isAccessResponse,
  requireContextField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  listPabcoNotificationPreferences,
  savePabcoNotificationPreferences,
} from "@/src/modules/leche/server/pabco-notification-repository";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const preferences = await listPabcoNotificationPreferences(
      access.organizationId,
      access.email,
      access.fieldIds,
    );
    return Response.json(
      { preferences },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (cause) {
    return unexpectedApiFailure(
      "milk.notifications.list",
      "No fue posible cargar las preferencias de recordatorios.",
      cause,
    );
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    let payload: {
      fieldIds?: unknown;
      emailEnabled?: unknown;
      browserEnabled?: unknown;
      reminderDays?: unknown;
    };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return Response.json(
        { error: "La solicitud no contiene datos válidos." },
        { status: 400 },
      );
    }

    const fieldIds = Array.isArray(payload.fieldIds)
      ? [
          ...new Set(
            payload.fieldIds.filter(
              (entry): entry is string =>
                typeof entry === "string" && entry.trim().length > 0,
            ),
          ),
        ]
      : [];
    if (fieldIds.length === 0) {
      return Response.json(
        { error: "Selecciona al menos un fundo para los recordatorios." },
        { status: 400 },
      );
    }
    for (const fieldId of fieldIds) {
      const forbidden = requireContextField(access, fieldId);
      if (forbidden) return forbidden;
    }
    const reminderDays = Number(payload.reminderDays ?? 14);
    if (!Number.isFinite(reminderDays) || reminderDays < 0 || reminderDays > 60) {
      return Response.json(
        { error: "La anticipación debe estar entre 0 y 60 días." },
        { status: 400 },
      );
    }

    const preferences = await savePabcoNotificationPreferences({
      organizationId: access.organizationId,
      userEmail: access.email,
      fieldIds,
      emailEnabled: payload.emailEnabled === true,
      browserEnabled: payload.browserEnabled === true,
      reminderDays,
    });
    return Response.json({ preferences });
  } catch (cause) {
    if (
      cause instanceof DomainRuleError
      && cause.code === "FIELD_SCOPE_CONFLICT"
    ) {
      return Response.json(
        { error: cause.message, code: cause.code },
        { status: 409 },
      );
    }
    return unexpectedApiFailure(
      "milk.notifications.save",
      "No fue posible guardar las preferencias de recordatorios.",
      cause,
    );
  }
}
