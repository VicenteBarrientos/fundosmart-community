import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { FEATURE_KEYS, type FeatureKey } from "@/src/modules/access/domain/types";
import {
  FeatureFlagAccessError,
  listOrganizationFeatureFlags,
  setOrganizationFeatureFlag,
} from "@/src/modules/access/server/feature-flag-repository";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const access = await authorizeApiAccess("manage_members");
  if (isAccessResponse(access)) return access;
  return privateJson({ flags: await listOrganizationFeatureFlags(access) });
}

export async function PUT(request: Request): Promise<Response> {
  try {
    const access = await authorizeApiAccess("manage_members");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<{ feature?: unknown; fieldId?: unknown; enabled?: unknown }>(request);
    if (payload instanceof Response) return payload;
    if (!isFeatureKey(payload.feature) || (payload.fieldId !== null && typeof payload.fieldId !== "string") || typeof payload.enabled !== "boolean") {
      return privateJson({ error: "La configuración de la función no es válida." }, 400);
    }
    const flags = await setOrganizationFeatureFlag({
      actor: access,
      feature: payload.feature,
      fieldId: payload.fieldId?.trim() || null,
      enabled: payload.enabled,
    });
    return privateJson({ flags });
  } catch (cause) {
    if (cause instanceof FeatureFlagAccessError) {
      return privateJson({ error: cause.message, code: cause.code }, 409);
    }
    if (cause instanceof Error && cause.message === "FIELD_SCOPE_CONFLICT") {
      return privateJson({ error: "El fundo no está disponible para esta organización." }, 404);
    }
    return privateJson({ error: "No fue posible actualizar la función." }, 500);
  }
}

function isFeatureKey(value: unknown): value is FeatureKey {
  return typeof value === "string" && (FEATURE_KEYS as readonly string[]).includes(value);
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
