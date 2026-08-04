import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import {
  buildAssistantReply,
  validateConfirmedActivity,
} from "@/src/modules/asistente/domain/assistant-engine.mjs";
import {
  AssistantConfirmationTokenError,
  openAssistantConfirmation,
  sealAssistantConfirmation,
} from "@/src/modules/asistente/server/assistant-confirmation-token";
import { loadAssistantData, todayInChile } from "@/src/modules/asistente/server/assistant-service";
import { upsertActivity } from "@/src/modules/potreros/server/activity-repository";
import { listFundos } from "@/src/modules/potreros/server/fundo-repository";
import { listPotreros } from "@/src/modules/potreros/server/potrero-repository";
import { env } from "cloudflare:workers";

import { getActiveOrganizationAiConfig } from "@/src/modules/asistente/server/ai-config-repository";
import { generateLlmAssistantResponse } from "@/src/modules/asistente/server/llm-provider";
import {
  buildOpenQuestionFallback,
  generateWorkersAiAssistantResponse,
} from "@/src/modules/asistente/server/workers-ai-provider";

export const dynamic = "force-dynamic";

const MESSAGE_HEADER = "x-fundosmart-assistant-message";

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const message = decodeMessageHeader(request.headers.get(MESSAGE_HEADER));
    if (!message || message.length > 600) {
      return privateJson({ error: "Escribe un mensaje de hasta 600 caracteres." }, 400);
    }
    const today = todayInChile();
    const data = await loadAssistantData(access, today);
    const engineReply = buildAssistantReply(message, data, {
      today,
      actionId: `assistant-activity-${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
    });

    const aiConfig = await getActiveOrganizationAiConfig(access.organizationId);
    let llmMessage: string | null = null;
    if (aiConfig) {
      try {
        llmMessage = await generateLlmAssistantResponse({
          provider: aiConfig.provider,
          apiKey: aiConfig.apiKey,
          model: aiConfig.defaultModel,
          userPrompt: message,
          contextData: data,
        });
      } catch (llmErr) {
        logAssistantAiFallback(aiConfig.provider, llmErr);
      }
    }

    if (!llmMessage && env.AI) {
      try {
        llmMessage = await generateWorkersAiAssistantResponse({
          ai: env.AI,
          userPrompt: message,
          verifiedReply: engineReply.message,
          contextData: data,
        });
      } catch (workersAiError) {
        logAssistantAiFallback("workers-ai", workersAiError);
      }
    }
    llmMessage = buildOpenQuestionFallback(message, llmMessage ?? engineReply.message) ?? llmMessage;
    if (llmMessage) engineReply.message = llmMessage;

    const confirmationToken = engineReply.action
      ? await sealAssistantConfirmation(
          engineReply.action,
          {
            membershipId: access.membershipId,
            organizationId: access.organizationId,
            actor: access.email,
          },
          requiredConfirmationSecret(),
        )
      : null;
    const reply = toClientReply(engineReply, confirmationToken);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: engineReply.action ? "operate" : "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return privateJson({ reply });
  } catch (cause) {
    return unexpectedApiFailure("assistant.query", "No fue posible responder en este momento.", cause);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<Record<string, unknown>>(request);
    if (payload instanceof Response) return payload;
    const confirmationId = typeof payload.confirmationId === "string" ? payload.confirmationId : "";
    if (!confirmationId) return privateJson({ error: "Falta la tarea por confirmar." }, 400);
    const action = await openAssistantConfirmation(
      confirmationId,
      {
        membershipId: access.membershipId,
        organizationId: access.organizationId,
        actor: access.email,
      },
      requiredConfirmationSecret(),
    );
    const error = validateConfirmedActivity(action, action.id);
    if (error) return privateJson({ error }, 400);
    if (action.occurredAt > todayInChile()) {
      return privateJson({ error: "El asistente solo registra manejos ya realizados." }, 400);
    }
    const forbidden = await requireResourceField(access, "paddock", action.paddockId);
    if (forbidden) return forbidden;
    const [paddocks, fields] = await Promise.all([listPotreros(access), listFundos(access)]);
    const paddock = paddocks.find((candidate) => candidate.id === action.paddockId);
    if (!paddock || paddock.fieldId !== action.fieldId) {
      return privateJson({ error: "El potrero cambió o ya no está disponible." }, 409);
    }
    const currentAccess = await reauthorizeApiAccess(access, "operate", paddock.fieldId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    const activity = await upsertActivity({
      id: action.id,
      potreroId: paddock.id,
      type: action.activityType,
      occurredAt: action.occurredAt,
      description: action.description,
      quantity: action.quantity,
      unit: action.unit,
      costClp: null,
      createdAt: action.createdAt,
    }, currentAccess, currentAccess.email, "assistant.activity");
    const field = fields.find((candidate) => candidate.id === paddock.fieldId);
    const responseAccess = await reauthorizeApiAccess(access, "operate", paddock.fieldId);
    if (isAccessResponse(responseAccess)) return responseAccess;
    return privateJson({
      reply: {
        message: `Listo: registré ${action.activityLabel.toLowerCase()} en ${field?.name ?? "el fundo"} › ${paddock.name}.`,
        suggestions: ["¿Qué requiere atención hoy?"],
        links: [{ label: "Ver historial", href: "/app/potreros" }],
        action: null,
      },
      result: { kind: "activity_created", activityId: activity.id },
    }, 201);
  } catch (cause) {
    if (cause instanceof AssistantConfirmationTokenError) {
      if (cause.code === "CONFIGURATION") {
        return unexpectedApiFailure("assistant.action.confirm", "La confirmación segura no está disponible.", cause);
      }
      return privateJson({ error: cause.message }, cause.code === "EXPIRED" ? 410 : cause.code === "SUBJECT_MISMATCH" ? 404 : 400);
    }
    if (cause instanceof Error && "code" in cause && cause.code === "FIELD_SCOPE_CONFLICT") {
      return privateJson({ error: cause.message }, 409);
    }
    return unexpectedApiFailure("assistant.action.confirm", "No fue posible completar la tarea.", cause);
  }
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function decodeMessageHeader(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return "";
  }
}

function requiredConfirmationSecret(): string {
  const secret = env.ASSISTANT_CONFIRMATION_SECRET?.trim();
  if (!secret) throw new AssistantConfirmationTokenError("La confirmación segura no está configurada.", "CONFIGURATION");
  return secret;
}

function logAssistantAiFallback(provider: string, cause: unknown): void {
  console.error(JSON.stringify({
    event: "assistant.ai_fallback",
    provider,
    errorType: cause instanceof Error ? cause.name : typeof cause,
  }));
}

function toClientReply(reply: ReturnType<typeof buildAssistantReply>, confirmationToken: string | null) {
  const action = reply.action;
  return {
    message: reply.message,
    suggestions: reply.suggestions,
    links: reply.links,
    proposedAction: action ? {
      confirmationId: confirmationToken!,
      kind: action.kind,
      title: `Registrar ${action.activityLabel.toLowerCase()}`,
      description: "Se guardará en el historial del potrero solo después de confirmar.",
      details: [
        { label: "Fundo", value: action.fieldName },
        { label: "Potrero", value: action.paddockName },
        { label: "Fecha", value: action.occurredAt },
        ...(action.quantity === null ? [] : [{ label: "Cantidad", value: `${action.quantity} ${action.unit}` }]),
      ],
      confirmLabel: "Registrar manejo",
      cancelLabel: "Cancelar",
    } : undefined,
  };
}
