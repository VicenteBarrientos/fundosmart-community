const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MEBIBYTE = 1024 * 1024;

export const DEFAULT_API_BODY_LIMIT_BYTES = 2 * MEBIBYTE;
export const IMPORT_CENTER_BODY_LIMIT_BYTES = 11 * MEBIBYTE;
export const IMPORT_BODY_LIMIT_BYTES = 21 * MEBIBYTE;
export const RESTORE_BODY_LIMIT_BYTES = 26 * MEBIBYTE;

const ROUTE_LIMITS = new Map([
  ["/api/importaciones", IMPORT_CENTER_BODY_LIMIT_BYTES],
  ["/api/integraciones/cooprinsem/importaciones", IMPORT_BODY_LIMIT_BYTES],
  ["/api/integraciones/cooprinsem/restauracion", RESTORE_BODY_LIMIT_BYTES],
]);

export async function enforceApiMutationSize(request) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return allow(request);

  const pathname = new URL(request.url).pathname;
  if (pathname !== "/api" && !pathname.startsWith("/api/")) return allow(request);

  const declaredBytes = parseContentLength(request.headers.get("Content-Length"));
  const limitBytes = bodyLimitForPath(pathname);
  if (declaredBytes !== null) {
    return declaredBytes <= BigInt(limitBytes)
      ? allow(request)
      : reject(request, limitBytes);
  }

  if (request.body === null) return allow(request);

  return bufferUndeclaredBody(request, limitBytes);
}

async function bufferUndeclaredBody(request, limitBytes) {
  let reader;

  try {
    reader = request.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      totalBytes += value.byteLength;
      if (totalBytes > limitBytes) {
        await cancelQuietly(reader);
        return reject(request, limitBytes);
      }

      chunks.push(value);
    }

    const body = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const headers = new Headers(request.headers);
    headers.delete("Content-Length");

    return allow(new Request(request, { body, headers }));
  } catch {
    return {
      request,
      rejection: Response.json({
        error: "No fue posible leer el cuerpo de la solicitud.",
      }, {
        status: 400,
        headers: { "Cache-Control": "private, no-store" },
      }),
    };
  } finally {
    reader?.releaseLock();
  }
}

async function cancelQuietly(reader) {
  try {
    await reader.cancel();
  } catch {
    // The 413 response remains authoritative even when the source cannot cancel.
  }
}

function allow(request) {
  return { request, rejection: null };
}

function reject(request, limitBytes) {
  return {
    request,
    rejection: oversizedResponse(limitBytes),
  };
}

function oversizedResponse(limitBytes) {
  return Response.json({
    error: "La solicitud supera el tamaño máximo permitido.",
    maxBytes: limitBytes,
  }, {
    status: 413,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function bodyLimitForPath(pathname) {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return ROUTE_LIMITS.get(normalized) ?? DEFAULT_API_BODY_LIMIT_BYTES;
}

function parseContentLength(value) {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  return BigInt(normalized);
}
