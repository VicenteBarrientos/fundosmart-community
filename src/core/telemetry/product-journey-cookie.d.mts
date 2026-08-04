import type {
  JourneyPseudonym,
  ProductEventId,
} from "./product-events.mjs";

export const PRODUCT_JOURNEY_TTL_SECONDS: 86400;
export const PRODUCT_JOURNEY_COOKIE_NAMES: readonly [
  "__Host-fundosmart_product_journey",
  "fundosmart_product_journey",
];

export type ProductJourneyVariant = "landing" | "demo" | "direct_product";

export type ProductJourney = Readonly<{
  version: "1";
  journeyPseudonym: JourneyPseudonym;
  signupStartedEventId: ProductEventId;
  startedAtEpochSeconds: number;
  variant: ProductJourneyVariant;
}>;

export class ProductJourneyCookieError extends TypeError {
  readonly code: string;
}

export function issueProductJourneyCookie(options: {
  secret: string;
  requestUrl: string;
  variant: ProductJourneyVariant;
  nowSeconds?: number;
  randomSource?: Pick<Crypto, "getRandomValues">;
}): Promise<{
  journey: ProductJourney;
  setCookie: string;
}>;

export function readProductJourneyCookie(options: {
  secret: string;
  cookieHeader: string | null | undefined;
  requestUrl: string;
  nowSeconds?: number;
}): Promise<ProductJourney | null>;

export function clearProductJourneyCookies(requestUrl: string): string[];
