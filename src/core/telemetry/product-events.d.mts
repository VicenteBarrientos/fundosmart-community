export const PRODUCT_EVENT_SCHEMA_VERSION: "1";

export type ProductEventName =
  | "signup_started"
  | "signup_completed"
  | "workspace_created"
  | "field_created"
  | "first_import_completed"
  | "first_action_completed"
  | "sync_completed"
  | "upgrade_intent"
  | "account_closed";

export type ProductEventAudience = "customer" | "demo" | "staff" | "synthetic";
export type ProductEventEnvironment = "production" | "staging" | "local";
export type OrganizationPseudonym = `org:v1:${string}`;
export type JourneyPseudonym = `journey:v1:${string}`;
export type ProductEventId = `pe_${string}`;

type ProductEventBase<
  Name extends ProductEventName,
  Source extends string,
  Variant extends string,
  Detail extends string,
> = {
  eventId: ProductEventId;
  eventName: Name;
  schemaVersion: "1";
  occurredAt: string;
  environment: ProductEventEnvironment;
  release: string;
  audience: ProductEventAudience;
  source: Source;
  variant: Variant;
  detail: Detail;
  count: number;
  secondaryCount: number;
};

type JourneyProductEvent = {
  partitionKey: JourneyPseudonym;
  organizationPseudonym: null;
  journeyPseudonym: JourneyPseudonym;
  cohortWeek: null;
  organizationAgeHours: null;
};

type OrganizationProductEvent = {
  partitionKey: OrganizationPseudonym;
  organizationPseudonym: OrganizationPseudonym;
  journeyPseudonym: JourneyPseudonym | null;
  cohortWeek: string;
  organizationAgeHours: number;
};

export type ProductEventV1 =
  | (
    ProductEventBase<
      "signup_started",
      "account",
      "landing" | "demo" | "direct_product",
      "google_oidc"
    >
    & JourneyProductEvent
  )
  | (
    ProductEventBase<
      "signup_completed",
      "account",
      "google_oidc",
      "verified"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "workspace_created",
      "access",
      "self_service" | "staff",
      "free" | "pro" | "legacy"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "field_created",
      "fields",
      "manual" | "import",
      "first" | "additional"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "first_import_completed",
      "imports",
      | "cooprinsem"
      | "survet"
      | "soil_analysis"
      | "agronomic_visit"
      | "paddock_boundaries"
      | "generic_spreadsheet"
      | "traceability",
      "clean" | "with_warnings"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "first_action_completed",
      "domain",
      | "import"
      | "animal_event"
      | "milk_record"
      | "cost_update"
      | "paddock_edit"
      | "task_completed"
      | "alert_reviewed",
      "direct" | "offline"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "sync_completed",
      "sync",
      "direct" | "offline",
      "applied" | "conflict_visible"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "upgrade_intent",
      "commercial",
      "field_limit" | "paddock_limit" | "feature_gate" | "settings" | "support",
      "pro"
    >
    & OrganizationProductEvent
  )
  | (
    ProductEventBase<
      "account_closed",
      "lifecycle",
      "self_service" | "support" | "staff",
      "closed"
    >
    & OrganizationProductEvent
  );

export type ProductEventCatalogRule = Readonly<{
  source: string;
  partition: "journey" | "organization";
  variants: readonly string[];
  details: readonly string[];
  cardinality: string;
}>;

export const PRODUCT_EVENT_CATALOG: Readonly<
  Record<ProductEventName, ProductEventCatalogRule>
>;
export const PRODUCT_EVENT_NAMES: readonly ProductEventName[];

export class ProductEventValidationError extends TypeError {
  readonly code: string;
}

export type ProductEventDataPoint = {
  indexes: [string];
  blobs: [
    ProductEventName,
    "1",
    ProductEventEnvironment,
    string,
    ProductEventAudience,
    string,
    ProductEventId,
    string,
    string,
    string,
    string,
  ];
  doubles: [number, number, number, number];
};

export type ProductEventWriter = {
  writeDataPoint(point: ProductEventDataPoint): void;
};

export type ProductEventLogger = {
  warn?(value: string): void;
};

export function pseudonymizeOrganization(
  secret: string,
  organizationId: string,
): Promise<OrganizationPseudonym>;

export function deriveProductEventId(
  secret: string,
  transition: {
    eventName: ProductEventName;
    sourceType: string;
    sourceId: string;
  },
): Promise<ProductEventId>;

export function createJourneyPseudonym(
  cryptoImpl?: Pick<Crypto, "getRandomValues">,
): JourneyPseudonym;

export function createRandomProductEventId(
  cryptoImpl?: Pick<Crypto, "getRandomValues">,
): ProductEventId;

export function assertProductEventV1(event: unknown): asserts event is ProductEventV1;
export function toProductEventDataPoint(event: unknown): ProductEventDataPoint;

export function emitProductEvent(
  dataset: ProductEventWriter | null | undefined,
  event: unknown,
  options?: { logger?: ProductEventLogger },
): boolean;
