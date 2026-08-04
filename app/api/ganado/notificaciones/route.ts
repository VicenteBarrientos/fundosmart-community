import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import { listNotificationPreferences, saveNotificationPreferences } from "@/src/modules/ganado/server/livestock-notification-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await authorizeApiAccess();
  if (isAccessResponse(access)) return access;
  return Response.json({ preferences: await listNotificationPreferences(access.organizationId, access.email, access.fieldIds) }, { headers: { "Cache-Control": "no-store" } });
}
export async function POST(request: Request) {
  const access = await authorizeApiAccess("operate");
  if (isAccessResponse(access)) return access;
  let payload: { fieldIds?: unknown; emailEnabled?: unknown; browserEnabled?: unknown; reminderDays?: unknown };
  try { payload = await request.json() as typeof payload; } catch { return Response.json({ error: "La solicitud no contiene datos válidos." }, { status: 400 }); }
  const fieldIds = Array.isArray(payload.fieldIds) ? [...new Set(payload.fieldIds.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0))] : [];
  if (!fieldIds.length) return Response.json({ error: "Selecciona al menos un fundo para las alertas." }, { status: 400 });
  for (const fieldId of fieldIds) { const forbidden = requireContextField(access, fieldId); if (forbidden) return forbidden; }
  const reminderDays = Number(payload.reminderDays ?? 14);
  if (!Number.isFinite(reminderDays) || reminderDays < 0 || reminderDays > 60) return Response.json({ error: "La anticipación debe estar entre 0 y 60 días." }, { status: 400 });
  const preferences = await saveNotificationPreferences({ organizationId: access.organizationId, userEmail: access.email, fieldIds, emailEnabled: payload.emailEnabled === true, browserEnabled: payload.browserEnabled === true, reminderDays });
  return Response.json({ preferences });
}
