const DEFAULT_MAXIMUM_BYTES = 8 * 1024;

export function isSameOriginMutation(request) {
  const origin = request.headers.get("Origin");
  if (origin) return origin === new URL(request.url).origin;
  return request.headers.get("Sec-Fetch-Site") === "same-origin";
}

export async function readBoundedUrlEncodedForm(
  request,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
) {
  if (mediaType(request) !== "application/x-www-form-urlencoded") {
    return privateJson({
      error: "La solicitud debe usar un formulario codificado.",
      code: "UNSUPPORTED_MEDIA_TYPE",
    }, 415);
  }
  const body = await readBoundedBody(request, maximumBytes);
  if (body instanceof Response) return body;
  try {
    return new URLSearchParams(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
  } catch {
    return invalidBodyResponse();
  }
}

export async function readBoundedJsonObject(
  request,
  maximumBytes = DEFAULT_MAXIMUM_BYTES,
) {
  if (mediaType(request) !== "application/json") {
    return privateJson({
      error: "La solicitud debe usar JSON.",
      code: "UNSUPPORTED_MEDIA_TYPE",
    }, 415);
  }
  const body = await readBoundedBody(request, maximumBytes);
  if (body instanceof Response) return body;
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(body),
    );
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return invalidBodyResponse();
    }
    return value;
  } catch {
    return invalidBodyResponse();
  }
}

async function readBoundedBody(request, maximumBytes) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }
  const declared = request.headers.get("Content-Length");
  if (declared !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(declared)) {
      return invalidBodyResponse();
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) return requestTooLargeResponse();
    if (declaredBytes > maximumBytes) return requestTooLargeResponse();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > maximumBytes) {
        await reader.cancel("request body limit exceeded");
        return requestTooLargeResponse();
      }
      chunks.push(chunk.value);
    }
  } catch {
    return invalidBodyResponse();
  }

  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function mediaType(request) {
  return (request.headers.get("Content-Type") ?? "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function requestTooLargeResponse() {
  return privateJson({
    error: "La solicitud es demasiado grande.",
    code: "REQUEST_TOO_LARGE",
  }, 413);
}

function invalidBodyResponse() {
  return privateJson({
    error: "El cuerpo de la solicitud no es válido.",
    code: "INVALID_REQUEST_BODY",
  }, 400);
}

function privateJson(payload, status) {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
