const DEFAULT_MAXIMUM_BYTES = 16 * 1024;

export async function readBoundedJsonObject(
  request: Request,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
): Promise<Record<string, unknown> | Response> {
  const declaredLength = Number(request.headers.get("Content-Length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    return privateJson({ error: "La solicitud es demasiado grande.", code: "REQUEST_TOO_LARGE" }, 413);
  }
  if (!request.body) {
    return invalidJsonResponse();
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel("request body limit exceeded");
        return privateJson({ error: "La solicitud es demasiado grande.", code: "REQUEST_TOO_LARGE" }, 413);
      }
      chunks.push(chunk.value);
    }
  } catch {
    return invalidJsonResponse();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return invalidJsonResponse();
    return parsed as Record<string, unknown>;
  } catch {
    return invalidJsonResponse();
  }
}

export function isSameOriginFeedbackMutation(request: Request): boolean {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export function privateFeedbackJson(
  body: unknown,
  status = 200,
  headers: HeadersInit = {},
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "private, no-store");
  responseHeaders.set("X-Content-Type-Options", "nosniff");
  return Response.json(body, {
    status,
    headers: responseHeaders,
  });
}

function invalidJsonResponse(): Response {
  return privateJson({
    error: "La solicitud no contiene un objeto JSON válido.",
    code: "INVALID_JSON_BODY",
  }, 400);
}

function privateJson(body: unknown, status: number): Response {
  return privateFeedbackJson(body, status);
}
