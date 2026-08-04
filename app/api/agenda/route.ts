import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  AgendaRequestError,
  validateAgendaTaskMutation,
} from "@/src/modules/dashboard/agenda-management.mjs";
import {
  isSameOriginAgendaMutation,
  privateAgendaJson,
  privateAgendaResponse,
  readAgendaJsonObject,
} from "@/src/modules/dashboard/agenda-http";
import {
  listAgendaManagement,
  mutateAgendaTask,
} from "@/src/modules/dashboard/agenda-repository";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return privateAgendaResponse(access);
    const management = await listAgendaManagement(access);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return privateAgendaResponse(currentAccess);
    return privateAgendaJson({ management });
  } catch (cause) {
    return unexpectedApiFailure(
      "agenda.list",
      "No fue posible actualizar la gestión de la agenda.",
      cause,
    );
  }
}
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginAgendaMutation(request)) {
    return privateAgendaJson({
      error: "La solicitud no proviene de FundoSmart.",
      code: "CSRF_REJECTED",
    }, 403);
  }
  try {
    const payload = await readAgendaJsonObject(request);
    if (payload instanceof Response) return payload;

    if (payload && typeof payload === "object" && Array.isArray((payload as { batch?: unknown }).batch)) {
      const batchRaw = (payload as { batch: unknown[] }).batch;
      if (batchRaw.length === 0) {
        return privateAgendaJson({
          error: "La lista de mutaciones en lote no puede estar vacía.",
          code: "AGENDA_BATCH_EMPTY",
        }, 400);
      }
      const mutations = batchRaw.map((item) => validateAgendaTaskMutation(item));
      const fieldIds = [...new Set(mutations.map((m) => m.fieldId))];
      const access = await authorizeApiAccess("operate", fieldIds[0]);
      if (isAccessResponse(access)) return privateAgendaResponse(access);
      for (const fieldId of fieldIds) {
        if (!access.fieldIds.includes(fieldId)) {
          return privateAgendaJson({
            error: "Acceso denegado a uno o más fundos de las mutaciones.",
            code: "AGENDA_FIELD_FORBIDDEN",
          }, 403);
        }
      }
      const { batchMutateAgendaTasks } = await import("@/src/modules/dashboard/agenda-repository");
      const results = await batchMutateAgendaTasks({ actor: access, mutations });
      const currentAccess = await reauthorizeApiSnapshotAccess(access, {
        capability: "operate",
        fieldIds,
      });
      if (isAccessResponse(currentAccess)) return privateAgendaResponse(currentAccess);
      return privateAgendaJson({
        results: results.map((r) => ({ state: r.state, replay: r.replay })),
      });
    }

    const mutation = validateAgendaTaskMutation(payload);
    const access = await authorizeApiAccess("operate", mutation.fieldId);
    if (isAccessResponse(access)) return privateAgendaResponse(access);
    const result = await mutateAgendaTask({ actor: access, mutation });
    const currentAccess = await reauthorizeApiAccess(
      access,
      "operate",
      mutation.fieldId,
    );
    if (isAccessResponse(currentAccess)) return privateAgendaResponse(currentAccess);
    return privateAgendaJson({
      state: result.state,
      replay: result.replay,
    });
  } catch (cause) {
    if (cause instanceof AgendaRequestError) {
      return privateAgendaJson({
        error: cause.message,
        code: cause.code,
      }, cause.status);
    }
    return unexpectedApiFailure(
      "agenda.mutate",
      "No fue posible guardar la acción de agenda.",
      cause,
    );
  }
}
