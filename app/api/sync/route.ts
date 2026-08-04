import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  pullSyncEvents,
  pushSyncMutations,
  SyncRequestError,
} from "@/src/modules/sync/server/sync-repository";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;
    const params = new URL(request.url).searchParams;
    const cursor = parseBoundedInteger(params.get("cursor"), 0, Number.MAX_SAFE_INTEGER, 0);
    const limit = parseBoundedInteger(params.get("limit"), 1, 100, 50);
    const fieldId = params.get("fieldId")?.trim() || undefined;
    return privateJson(await pullSyncEvents({ actor: access, cursor, fieldId, limit }));
  } catch (cause) {
    return syncError(cause);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<{ mutations?: unknown }>(request);
    if (payload instanceof Response) return payload;
    return privateJson(await pushSyncMutations(access, payload.mutations));
  } catch (cause) {
    return syncError(cause);
  }
}

function syncError(cause: unknown): Response {
  if (cause instanceof SyncRequestError) return privateJson({ error: cause.message }, cause.status);
  return privateJson({ error: "No fue posible sincronizar los cambios." }, 500);
}

function parseBoundedInteger(value: string | null, minimum: number, maximum: number, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
