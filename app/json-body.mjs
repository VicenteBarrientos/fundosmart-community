export async function readJsonObject(request) {
  let value;
  try {
    value = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return invalidJsonResponse();
  }
  return value;
}

function invalidJsonResponse() {
  return Response.json({
    error: "La solicitud no contiene un objeto JSON válido.",
    code: "INVALID_JSON_BODY",
  }, {
    status: 400,
    headers: { "Cache-Control": "private, no-store" },
  });
}
