import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
} from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import { deleteActivity, listActivities, listActivitiesWithLineage, upsertActivity } from "@/src/modules/potreros/server/activity-repository";
import { ACTIVITY_TYPE_LABELS, type Activity } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const searchParams = new URL(request.url).searchParams;
    const potreroId = searchParams.get("potreroId") ?? undefined;
    const includeLineage = searchParams.get("includeLineage") === "1";
    const fieldId = potreroId ? await resolveResourceFieldId("paddock", potreroId) : null;
    const forbidden = potreroId ? requireContextField(access, fieldId) : null;
    if (forbidden) return forbidden;
    if (includeLineage && !potreroId) return Response.json({ error: "Selecciona un potrero." }, { status: 400 });
    const activities = includeLineage
      ? await listActivitiesWithLineage(access, potreroId!)
      : await listActivities(access, potreroId);
    const currentAccess = fieldId
      ? await reauthorizeApiAccess(access, "view", fieldId)
      : await reauthorizeApiSnapshotAccess(access, {
        capability: "view",
        fieldIds: access.fieldIds,
      });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(
      { activities },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "No fue posible cargar el historial." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Partial<Activity>>(request);
    if (payload instanceof Response) return payload;
    const error = validateActivity(payload);
    if (error) return Response.json({ error }, { status: 400 });

    const targetFieldId = await resolveResourceFieldId("paddock", payload.potreroId!);
    const targetForbidden = requireContextField(access, targetFieldId);
    if (targetForbidden) return targetForbidden;
    const existingFieldId = await resolveResourceFieldId("activity", payload.id!);
    if (existingFieldId) {
      const existingForbidden = requireContextField(access, existingFieldId);
      if (existingForbidden) return existingForbidden;
    }
    const saved = await upsertActivity(payload as Activity, access, access.email);
    const currentAccess = await reauthorizeApiAccess(access, "operate", targetFieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ activity: saved }, { status: 201 });
  } catch (error) {
    return activityError(error, "No fue posible guardar el manejo.");
  }
}

export async function DELETE(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const id = new URL(request.url).searchParams.get("id")?.trim();
    if (!id) return Response.json({ error: "Falta el identificador del manejo." }, { status: 400 });
    const expectedUpdatedAt = new URL(request.url).searchParams.get("updatedAt")?.trim();
    if (!expectedUpdatedAt) {
      return Response.json({ error: "Actualiza el historial antes de eliminar el manejo." }, { status: 409 });
    }

    const fieldId = await resolveResourceFieldId("activity", id);
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const deleted = await deleteActivity(id, access, expectedUpdatedAt, access.email);
    if (!deleted) return Response.json({ error: "El manejo no existe." }, { status: 404 });

    const currentAccess = await reauthorizeApiAccess(access, "operate", fieldId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ deleted: true });
  } catch (error) {
    return activityError(error, "No fue posible eliminar el manejo.");
  }
}

function activityError(error: unknown, fallback: string) {
  if (error instanceof Error && "code" in error && error.code === "FIELD_SCOPE_CONFLICT") {
    return Response.json({ error: error.message }, { status: 409 });
  }
  return Response.json({ error: fallback }, { status: 500 });
}

function validateActivity(payload: Partial<Activity>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador del manejo.";
  if (!payload.potreroId?.trim()) return "Selecciona un potrero.";
  if (!payload.type || !(payload.type in ACTIVITY_TYPE_LABELS)) return "El tipo de manejo no es válido.";
  if (!payload.occurredAt) return "Indica la fecha del manejo.";
  if (!payload.description?.trim()) return "Agrega una descripción breve.";
  return null;
}
