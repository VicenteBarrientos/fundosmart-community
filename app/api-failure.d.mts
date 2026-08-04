export function unexpectedApiFailure(
  operation: string,
  publicMessage: string,
  cause: unknown,
  details?: Record<string, unknown>,
): Response;
