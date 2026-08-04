const MAXIMUM_AGENDA_BYTES = 8 * 1024;

export function isSameOriginAgendaMutation(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}
export async function readAgendaJsonObject(
  request: Request,
): Promise<Record<string, unknown> | Response> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_AGENDA_BYTES) {
    return privateAgendaJson({
      error: "La solicitud es demasiado grande.",
      code: "REQUEST_TOO_LARGE",
    }, 413);
  }
  if (!request.body) return invalidJson();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > MAXIMUM_AGENDA_BYTES) {
        await reader.cancel("agenda request body limit exceeded");
        return privateAgendaJson({
          error: "La solicitud es demasiado grande.",
          code: "REQUEST_TOO_LARGE",
        }, 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return invalidJson();
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) return invalidJson();
    return value as Record<string, unknown>;
  } catch {
    return invalidJson();
  }
}

export function privateAgendaJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, { status, headers: responseHeaders });
}

export function privateAgendaResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function invalidJson(): Response {
  return privateAgendaJson({
    error: "La solicitud no contiene un objeto JSON válido.",
    code: "INVALID_JSON_BODY",
  }, 400);
}
