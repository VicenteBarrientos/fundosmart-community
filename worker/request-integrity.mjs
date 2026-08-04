const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const REJECTION_BODY = Object.freeze({
  error: "La solicitud fue rechazada porque no proviene de este sitio.",
});

export function rejectCrossSiteMutation(request) {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return null;

  const fetchSite = request.headers.get("Sec-Fetch-Site")?.trim().toLowerCase();
  if (fetchSite === "cross-site") return rejectionResponse();

  const origin = request.headers.get("Origin");
  if (origin && !matchesRequestOrigin(origin, request.url)) return rejectionResponse();

  return null;
}

function matchesRequestOrigin(origin, requestUrl) {
  try {
    return new URL(origin).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

function rejectionResponse() {
  return Response.json(REJECTION_BODY, {
    status: 403,
    headers: { "Cache-Control": "private, no-store" },
  });
}
