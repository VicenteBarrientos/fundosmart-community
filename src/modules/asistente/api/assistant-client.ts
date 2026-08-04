import type {
  AssistantConfirmationRequest,
  AssistantReply,
  AssistantTurnRequest,
} from "../domain/types";

const ASSISTANT_ENDPOINT = "/api/asistente";

export async function sendAssistantTurn(
  request: AssistantTurnRequest,
  signal?: AbortSignal,
): Promise<AssistantReply> {
  const response = await fetch(ASSISTANT_ENDPOINT, {
    cache: "no-store",
    headers: { "X-FundoSmart-Assistant-Message": encodeURIComponent(request.message) },
    method: "GET",
    signal,
  });
  return readAssistantReply(response);
}

export async function resolveAssistantConfirmation(
  request: AssistantConfirmationRequest,
  signal?: AbortSignal,
): Promise<AssistantReply> {
  return postAssistantRequest(request, signal);
}

async function postAssistantRequest(
  request: AssistantConfirmationRequest,
  signal?: AbortSignal,
): Promise<AssistantReply> {
  const response = await fetch(ASSISTANT_ENDPOINT, {
    body: JSON.stringify(request),
    headers: { "Content-Type": "application/json" },
    method: "POST",
    signal,
  });

  return readAssistantReply(response);
}

async function readAssistantReply(response: Response): Promise<AssistantReply> {
  const payload = await readPayload(response);
  if (!response.ok || !payload.reply) {
    throw new Error(payload.error ?? "No fue posible consultar al asistente.");
  }
  return payload.reply;
}

async function readPayload(
  response: Response,
): Promise<{ error?: string; reply?: AssistantReply }> {
  try {
    return (await response.json()) as {
      error?: string;
      reply?: AssistantReply;
    };
  } catch {
    return {};
  }
}
