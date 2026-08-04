export function isSameOriginMutation(request: Request): boolean;

export function readBoundedUrlEncodedForm(
  request: Request,
  maximumBytes?: number,
): Promise<URLSearchParams | Response>;

export function readBoundedJsonObject<T extends object>(
  request: Request,
  maximumBytes?: number,
): Promise<T | Response>;
