export function unexpectedApiFailure(operation, publicMessage, cause, details = {}) {
  const diagnostic = {
    event: "fundosmart.api_failure",
    operation,
    errorType: diagnosticToken(cause instanceof Error ? cause.name : typeof cause, "unknown"),
  };
  const errorCode = readErrorCode(cause);
  if (errorCode) diagnostic.errorCode = errorCode;
  console.error(diagnostic);

  return Response.json({ ...details, error: publicMessage }, {
    status: 500,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function readErrorCode(cause) {
  if (!cause || typeof cause !== "object" || !("code" in cause)) return null;
  return diagnosticToken(cause.code, null);
}

function diagnosticToken(value, fallback) {
  if (typeof value !== "string") return fallback;
  const token = value.trim();
  return /^[a-z][a-z0-9_.:-]{0,79}$/i.test(token) ? token : fallback;
}
