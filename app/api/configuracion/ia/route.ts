import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import type { AiProviderKey } from "@/db/schema";
import {
  deleteOrganizationAiConfig,
  getOrganizationAiConfigSummary,
  saveOrganizationAiConfig,
} from "@/src/modules/asistente/server/ai-config-repository";
import { verifyLlmApiKey } from "@/src/modules/asistente/server/llm-provider";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await authorizeApiAccess("view");
    if (isAccessResponse(access)) return access;

    const summary = await getOrganizationAiConfigSummary(access.organizationId);
    return privateJson({ config: summary });
  } catch (cause) {
    return unexpectedApiFailure("ai_config.get", "No fue posible consultar la configuración de IA.", cause);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;

    const payload = await readJsonObject<Record<string, unknown>>(request);
    if (payload instanceof Response) return payload;

    const action = typeof payload.action === "string" ? payload.action : "save";
    const provider = payload.provider as AiProviderKey;
    const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
    const defaultModel = typeof payload.defaultModel === "string" ? payload.defaultModel.trim() : "";

    if (action === "test") {
      if (!provider || !apiKey) {
        return privateJson({ error: "Selecciona un proveedor e ingresa una API Key para probar." }, 400);
      }
      const testResult = await verifyLlmApiKey(provider, apiKey, defaultModel);
      return privateJson(testResult, testResult.ok ? 200 : 400);
    }

    if (action === "save") {
      if (!provider || !apiKey || !defaultModel) {
        return privateJson({ error: "Debes ingresar proveedor, API Key y modelo por defecto." }, 400);
      }

      // Verify connection before saving
      const verification = await verifyLlmApiKey(provider, apiKey, defaultModel);
      if (!verification.ok) {
        return privateJson({ error: `Falló la verificación de la llave: ${verification.message}` }, 400);
      }

      const saved = await saveOrganizationAiConfig({
        organizationId: access.organizationId,
        provider,
        apiKey,
        defaultModel,
        updatedBy: access.email,
      });

      return privateJson({
        message: "Configuración de IA guardada exitosamente.",
        config: saved,
      }, 200);
    }

    return privateJson({ error: "Acción no válida." }, 400);
  } catch (cause) {
    return unexpectedApiFailure("ai_config.post", "No fue posible actualizar la configuración de IA.", cause);
  }
}

export async function DELETE() {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;

    await deleteOrganizationAiConfig(access.organizationId);
    return privateJson({ message: "Configuración de IA eliminada exitosamente." });
  } catch (cause) {
    return unexpectedApiFailure("ai_config.delete", "No fue posible eliminar la configuración de IA.", cause);
  }
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}
