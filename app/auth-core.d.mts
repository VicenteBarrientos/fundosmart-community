export const SESSION_COOKIE_NAMES: readonly string[];
export const OAUTH_STATE_COOKIE_NAMES: readonly string[];

export function randomToken(byteLength?: number): string;
export function sha256Hex(value: string): Promise<string>;
export function pkceChallenge(verifier: string): Promise<string>;
export function readCookie(cookieHeader: string | null, names: readonly string[]): string | null;
export function timingSafeEqual(left: string, right: string): Promise<boolean>;
export function normalizeAuthEmail(value: unknown): string;
export function safeRelativeReturnPath(value: unknown, fallback?: string): string;
export function resolveAuthOrigin(options: {
  requestUrl: string;
  configuredOrigin?: string;
  environment?: string;
}): string;
