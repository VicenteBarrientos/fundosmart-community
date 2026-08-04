import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type {
  ActivityType,
  Coordinate,
  LivestockAnimalStatus,
  LivestockCategory,
  LivestockExpenseCategory,
  LivestockExpensePaymentSource,
  MilkBacterialCountUnit,
  MilkBulkProductionKind,
  MilkBulkProductionSource,
  MilkQualitySampleKind,
  MilkQualitySampleSource,
  MilkQualitySanitaryFlags,
  MilkSettlementLineItem,
  MilkSomaticCellCountUnit,
  PabcoComplianceRequirement,
  PabcoComplianceSource,
  PabcoComplianceStatus,
  LivestockSex,
  LivestockStatus,
  LivestockTrackingMode,
  PaddockArchiveReason,
  PaddockOperationKind,
  PaddockOperationPlanRequest,
  PaddockOperationResult,
  PolygonRings,
  ExclusionKind,
  PaddockLandUse,
  Potrero,
  ScopedSubdivisionDraft,
  SubdivisionScopeKind,
  StoredPolygon,
} from "../src/core/domain/types";
import type {
  CooprinsemIntegrityIncidentStatus,
  CooprinsemIntegrityIncidentType,
  CooprinsemIntegritySweepStatus,
  CooprinsemIntegritySweepTrigger,
  FundoSmartRecoveryEventType,
  FundoSmartRecoveryJobStatus,
  FundoSmartRecoveryObjectStatus,
} from "../src/modules/integraciones/cooprinsem/domain/types";
import type {
  CooprinsemSoilReportDocument,
  ImportColumnMapping,
  ImportDocumentSnapshot,
  ImportErrorSeverity,
  ImportErrorStatus,
  ImportFormat,
  ImportJobStatus,
  ImportRecord,
  ImportRowStatus,
  SoilAnalysisRangeAssessment,
} from "../src/modules/importaciones/domain/types";
import type {
  FeedbackCategory,
  FeedbackImpact,
  FeedbackPriority,
  FeedbackStatus,
} from "../src/modules/feedback/domain/types";
import type {
  AgendaTaskAction,
  AgendaTaskSource,
  AgendaTaskState,
  AgendaTaskStatus,
} from "../src/modules/dashboard/agenda-management.mjs";
import type {
  LivestockBirthOutcome,
  LivestockCalvingDifficulty,
  LivestockCalvingType,
  LivestockHealthEventStatus,
  LivestockHealthEventType,
  LivestockLactationStatus,
  LivestockOffspringOutcome,
  LivestockReproductiveEventType,
} from "../src/modules/ganado/ficha/domain/types";
import type {
  FeatureKey,
  OrganizationKind,
  OrganizationMembershipRole,
  OrganizationMembershipStatus,
  OrganizationPlanCode,
} from "../src/modules/access/domain/types";
import type {
  PaddockCellOperationKind,
  PaddockCellOperationRequest,
  PaddockCellOperationResult,
  PaddockRotationSettings,
} from "../src/modules/potreros/domain/cells-rotation";
import type {
  FieldLandmarkGeometryType,
  FieldLandmarkKind,
  FieldLandmarkOperationKind,
  FieldLandmarkOperationRequest,
  FieldLandmarkOperationResult,
} from "../src/modules/potreros/domain/field-landmarks";
import type {
  PaddockNdviNoDataReason,
  PaddockNdviPaddockSnapshot,
  PaddockNdviStatus,
} from "../src/modules/potreros/domain/paddock-ndvi";
import type {
  ScheduledJobStatus,
  SyncEntity,
  SyncJsonValue,
  SyncMutationOperation,
  SyncMutationStatus,
} from "../src/modules/sync/domain/types";
import type {
  DiioDeviceType,
  DiioStatus,
  EstablishmentStatus,
  EstablishmentType,
  TraceabilityDeclarationStatus,
  TraceabilityDocumentStorageStatus,
  TraceabilityImportSourceKind,
  TraceabilityImportStageStatus,
  TraceabilityMovementStatus,
} from "../src/modules/trazabilidad/domain/types";
import type {
  PastureBiomassMethod,
  PastureCalibrationStatus,
  PastureObservationSourceKind,
  PastureObservationStorageStatus,
  PastureProviderMode,
  PastureRotationPlanStatus,
} from "../src/modules/praderas/domain/types";
import type {
  BenchmarkAggregateStatus,
  BenchmarkConsentStatus,
  BenchmarkHerdSizeBand,
  BenchmarkMetricKey,
  BenchmarkProductionSystem,
  BenchmarkZone,
} from "../src/modules/benchmarking/domain/benchmarking-rules.mjs";
import type {
  AnalyticsAlertSeverity,
  AnalyticsAlertStatus,
  AnalyticsMetricStatus,
  AnalyticsProjection,
  AnalyticsThresholds,
} from "../src/modules/analytics/domain/analytics-projection.mjs";

export const authIdentities = sqliteTable(
  "auth_identities",
  {
    id: text("id").primaryKey(),
    provider: text("provider").$type<"google">().notNull(),
    providerSubject: text("provider_subject").notNull(),
    email: text("email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("auth_identities_provider_subject_unique").on(table.provider, table.providerSubject),
    uniqueIndex("auth_identities_normalized_email_unique").on(table.normalizedEmail),
    check("auth_identities_provider_check", sql`${table.provider} = 'google'`),
    check("auth_identities_subject_check", sql`length(${table.providerSubject}) BETWEEN 1 AND 255`),
    check("auth_identities_email_check", sql`length(${table.email}) BETWEEN 3 AND 320`),
    check("auth_identities_timestamps_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    tokenHash: text("token_hash").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => authIdentities.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("auth_sessions_identity_idx").on(table.identityId),
    index("auth_sessions_expiry_idx").on(table.expiresAt),
    check("auth_sessions_token_hash_check", sql`length(${table.tokenHash}) = 64`),
    check("auth_sessions_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const authOauthAttempts = sqliteTable(
  "auth_oauth_attempts",
  {
    stateHash: text("state_hash").primaryKey(),
    nonce: text("nonce").notNull(),
    codeVerifier: text("code_verifier").notNull(),
    returnTo: text("return_to").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("auth_oauth_attempts_expiry_idx").on(table.expiresAt),
    check("auth_oauth_attempts_state_hash_check", sql`length(${table.stateHash}) = 64`),
    check("auth_oauth_attempts_nonce_check", sql`length(${table.nonce}) BETWEEN 32 AND 256`),
    check("auth_oauth_attempts_verifier_check", sql`length(${table.codeVerifier}) BETWEEN 43 AND 128`),
    check("auth_oauth_attempts_return_check", sql`length(${table.returnTo}) BETWEEN 1 AND 2048`),
    check("auth_oauth_attempts_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    kind: text("kind").$type<OrganizationKind>().notNull().default("shared"),
    planCode: text("plan_code").$type<OrganizationPlanCode>().notNull().default("legacy"),
    fieldLimit: integer("field_limit"),
    paddockLimit: integer("paddock_limit"),
    selfServiceOwnerEmail: text("self_service_owner_email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("organizations_self_service_owner_unique").on(table.selfServiceOwnerEmail),
    check("organizations_plan_code_check", sql`${table.planCode} IN ('legacy', 'free', 'pro')`),
    check("organizations_field_limit_check", sql`${table.fieldLimit} IS NULL OR ${table.fieldLimit} > 0`),
    check("organizations_paddock_limit_check", sql`${table.paddockLimit} IS NULL OR ${table.paddockLimit} > 0`),
    check(
      "organizations_free_plan_limits_check",
      sql`${table.planCode} <> 'free' OR (${table.fieldLimit} = 2 AND ${table.paddockLimit} = 200 AND ${table.selfServiceOwnerEmail} IS NOT NULL)`,
    ),
  ],
);

export const platformStaffPrincipals = sqliteTable(
  "platform_staff_principals",
  {
    id: text("id").primaryKey(),
    authIdentityId: text("auth_identity_id")
      .notNull()
      .references(() => authIdentities.id),
    normalizedEmailSnapshot: text("normalized_email_snapshot").notNull(),
    displayName: text("display_name").notNull(),
    kind: text("kind").$type<"owner" | "staff">().notNull(),
    status: text("status").$type<"active" | "suspended">().notNull(),
    version: integer("version").notNull().default(1),
    createdByPrincipalId: text("created_by_principal_id"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    suspendedAt: integer("suspended_at"),
  },
  (table) => [
    uniqueIndex("platform_staff_principals_auth_identity_unique").on(table.authIdentityId),
    index("platform_staff_principals_status_kind_idx").on(table.status, table.kind, table.id),
    index("platform_staff_principals_creator_idx").on(table.createdByPrincipalId),
    foreignKey({
      columns: [table.createdByPrincipalId],
      foreignColumns: [table.id],
      name: "platform_staff_principals_created_by_fk",
    }),
    check(
      "platform_staff_principals_id_check",
      sql`typeof(${table.id}) = 'text'
      AND (
        (
          length(${table.id}) = 26
          AND substr(${table.id}, 1, 1) GLOB '[0-7]'
          AND ${table.id} = upper(${table.id})
          AND ${table.id} NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
        )
        OR (
          length(${table.id}) = 36
          AND substr(${table.id}, 9, 1) = '-'
          AND substr(${table.id}, 14, 1) = '-'
          AND substr(${table.id}, 19, 1) = '-'
          AND substr(${table.id}, 24, 1) = '-'
          AND ${table.id} = lower(${table.id})
          AND length(replace(${table.id}, '-', '')) = 32
          AND replace(${table.id}, '-', '') NOT GLOB '*[^0-9a-f]*'
        )
      )`,
    ),
    check(
      "platform_staff_principals_email_check",
      sql`typeof(${table.normalizedEmailSnapshot}) = 'text'
        AND length(${table.normalizedEmailSnapshot}) BETWEEN 3 AND 320
        AND ${table.normalizedEmailSnapshot} = lower(trim(${table.normalizedEmailSnapshot}))
        AND instr(${table.normalizedEmailSnapshot}, '@') > 1
        AND instr(${table.normalizedEmailSnapshot}, '@') < length(${table.normalizedEmailSnapshot})
        AND instr(
          substr(${table.normalizedEmailSnapshot}, instr(${table.normalizedEmailSnapshot}, '@') + 1),
          '@'
        ) = 0`,
    ),
    check(
      "platform_staff_principals_display_name_check",
      sql`typeof(${table.displayName}) = 'text'
        AND length(trim(${table.displayName})) BETWEEN 1 AND 160`,
    ),
    check(
      "platform_staff_principals_kind_check",
      sql`typeof(${table.kind}) = 'text' AND ${table.kind} IN ('owner', 'staff')`,
    ),
    check(
      "platform_staff_principals_status_check",
      sql`typeof(${table.status}) = 'text' AND ${table.status} IN ('active', 'suspended')`,
    ),
    check(
      "platform_staff_principals_version_check",
      sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`,
    ),
    check(
      "platform_staff_principals_timestamps_check",
      sql`typeof(${table.createdAt}) = 'integer'
        AND typeof(${table.updatedAt}) = 'integer'
        AND (${table.suspendedAt} IS NULL OR typeof(${table.suspendedAt}) = 'integer')
        AND ${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}
        AND (
          (${table.status} = 'active' AND ${table.suspendedAt} IS NULL)
          OR (
            ${table.status} = 'suspended'
            AND ${table.suspendedAt} IS NOT NULL
            AND ${table.suspendedAt} >= ${table.createdAt}
            AND ${table.suspendedAt} <= ${table.updatedAt}
          )
        )`,
    ),
  ],
);

export const platformStaffCapabilityGrants = sqliteTable(
  "platform_staff_capability_grants",
  {
    id: text("id").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => platformStaffPrincipals.id),
    capability: text("capability")
      .$type<
        | "support:read"
        | "tenants:manage"
        | "flags:manage"
        | "audit:read"
        | "operations:sensitive"
        | "staff:manage"
      >()
      .notNull(),
    status: text("status").$type<"active" | "revoked">().notNull(),
    reason: text("reason").notNull(),
    grantedByPrincipalId: text("granted_by_principal_id")
      .notNull()
      .references(() => platformStaffPrincipals.id),
    grantedAt: integer("granted_at").notNull(),
    revokedByPrincipalId: text("revoked_by_principal_id")
      .references(() => platformStaffPrincipals.id),
    revokedAt: integer("revoked_at"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("platform_staff_capability_grants_active_unique")
      .on(table.principalId, table.capability)
      .where(sql`${table.status} = 'active'`),
    index("platform_staff_capability_grants_principal_status_idx")
      .on(table.principalId, table.status),
    index("platform_staff_capability_grants_capability_status_idx")
      .on(table.capability, table.status),
    index("platform_staff_capability_grants_granted_by_idx")
      .on(table.grantedByPrincipalId),
    index("platform_staff_capability_grants_revoked_by_idx")
      .on(table.revokedByPrincipalId),
    check(
      "platform_staff_capability_grants_id_check",
      sql`typeof(${table.id}) = 'text' AND length(trim(${table.id})) BETWEEN 1 AND 160`,
    ),
    check(
      "platform_staff_capability_grants_capability_check",
      sql`typeof(${table.capability}) = 'text'
      AND ${table.capability} IN (
        'support:read',
        'tenants:manage',
        'flags:manage',
        'audit:read',
        'operations:sensitive',
        'staff:manage'
      )`,
    ),
    check(
      "platform_staff_capability_grants_status_check",
      sql`typeof(${table.status}) = 'text' AND ${table.status} IN ('active', 'revoked')`,
    ),
    check(
      "platform_staff_capability_grants_reason_check",
      sql`typeof(${table.reason}) = 'text'
        AND length(trim(${table.reason})) BETWEEN 3 AND 1000`,
    ),
    check(
      "platform_staff_capability_grants_version_check",
      sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`,
    ),
    check(
      "platform_staff_capability_grants_lifecycle_check",
      sql`typeof(${table.grantedAt}) = 'integer'
        AND (${table.revokedAt} IS NULL OR typeof(${table.revokedAt}) = 'integer')
        AND ${table.grantedAt} >= 0
        AND (
          (
            ${table.status} = 'active'
            AND ${table.revokedByPrincipalId} IS NULL
            AND ${table.revokedAt} IS NULL
          )
          OR (
            ${table.status} = 'revoked'
            AND ${table.revokedByPrincipalId} IS NOT NULL
            AND ${table.revokedAt} IS NOT NULL
            AND ${table.revokedAt} >= ${table.grantedAt}
          )
        )`,
    ),
  ],
);

export const platformStaffBootstrapClaims = sqliteTable(
  "platform_staff_bootstrap_claims",
  {
    id: text("id").primaryKey(),
    normalizedEmail: text("normalized_email").notNull(),
    status: text("status")
      .$type<"pending" | "claimed" | "disabled">()
      .notNull()
      .default("pending"),
    principalId: text("principal_id")
      .references(() => platformStaffPrincipals.id),
    createdAt: integer("created_at").notNull(),
    claimedAt: integer("claimed_at"),
    disabledAt: integer("disabled_at"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("platform_staff_bootstrap_claims_email_unique").on(table.normalizedEmail),
    index("platform_staff_bootstrap_claims_status_idx").on(table.status, table.createdAt),
    uniqueIndex("platform_staff_bootstrap_claims_principal_idx").on(table.principalId),
    check(
      "platform_staff_bootstrap_claims_id_check",
      sql`typeof(${table.id}) = 'text' AND length(trim(${table.id})) BETWEEN 1 AND 160`,
    ),
    check(
      "platform_staff_bootstrap_claims_email_check",
      sql`typeof(${table.normalizedEmail}) = 'text'
        AND length(${table.normalizedEmail}) BETWEEN 3 AND 320
        AND ${table.normalizedEmail} = lower(trim(${table.normalizedEmail}))
        AND instr(${table.normalizedEmail}, '@') > 1
        AND instr(${table.normalizedEmail}, '@') < length(${table.normalizedEmail})
        AND instr(
          substr(${table.normalizedEmail}, instr(${table.normalizedEmail}, '@') + 1),
          '@'
        ) = 0`,
    ),
    check(
      "platform_staff_bootstrap_claims_status_check",
      sql`typeof(${table.status}) = 'text'
        AND ${table.status} IN ('pending', 'claimed', 'disabled')`,
    ),
    check(
      "platform_staff_bootstrap_claims_version_check",
      sql`typeof(${table.version}) = 'integer' AND ${table.version} > 0`,
    ),
    check(
      "platform_staff_bootstrap_claims_lifecycle_check",
      sql`typeof(${table.createdAt}) = 'integer'
        AND (${table.claimedAt} IS NULL OR typeof(${table.claimedAt}) = 'integer')
        AND (${table.disabledAt} IS NULL OR typeof(${table.disabledAt}) = 'integer')
        AND ${table.createdAt} >= 0
        AND (
          (
            ${table.status} = 'pending'
            AND ${table.principalId} IS NULL
            AND ${table.claimedAt} IS NULL
            AND ${table.disabledAt} IS NULL
          )
          OR (
            ${table.status} = 'claimed'
            AND ${table.principalId} IS NOT NULL
            AND ${table.claimedAt} IS NOT NULL
            AND ${table.claimedAt} >= ${table.createdAt}
            AND ${table.disabledAt} IS NULL
          )
          OR (
            ${table.status} = 'disabled'
            AND ${table.principalId} IS NULL
            AND ${table.claimedAt} IS NULL
            AND ${table.disabledAt} IS NOT NULL
            AND ${table.disabledAt} >= ${table.createdAt}
          )
        )`,
    ),
  ],
);

export const platformStaffElevations = sqliteTable(
  "platform_staff_elevations",
  {
    tokenHash: text("token_hash").primaryKey(),
    principalId: text("principal_id")
      .notNull()
      .references(() => platformStaffPrincipals.id),
    authSessionTokenHash: text("auth_session_token_hash")
      .notNull()
      .references(() => authSessions.tokenHash, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    index("platform_staff_elevations_principal_expiry_idx")
      .on(table.principalId, table.expiresAt),
    index("platform_staff_elevations_session_idx").on(table.authSessionTokenHash),
    index("platform_staff_elevations_expiry_idx").on(table.expiresAt, table.revokedAt),
    check(
      "platform_staff_elevations_token_hash_check",
      sql`typeof(${table.tokenHash}) = 'text'
        AND length(${table.tokenHash}) = 64
        AND ${table.tokenHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "platform_staff_elevations_session_hash_check",
      sql`typeof(${table.authSessionTokenHash}) = 'text'
        AND length(${table.authSessionTokenHash}) = 64
        AND ${table.authSessionTokenHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "platform_staff_elevations_lifetime_check",
      sql`typeof(${table.createdAt}) = 'integer'
        AND typeof(${table.expiresAt}) = 'integer'
        AND (${table.revokedAt} IS NULL OR typeof(${table.revokedAt}) = 'integer')
        AND ${table.createdAt} >= 0
        AND ${table.expiresAt} > ${table.createdAt}
        AND ${table.expiresAt} <= ${table.createdAt} + 900
        AND (
          ${table.revokedAt} IS NULL
          OR (
            ${table.revokedAt} >= ${table.createdAt}
            AND ${table.revokedAt} <= ${table.expiresAt}
          )
        )`,
    ),
  ],
);

export const platformStaffEvents = sqliteTable(
  "platform_staff_events",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type").$type<"system" | "staff">().notNull(),
    actorPrincipalId: text("actor_principal_id")
      .references(() => platformStaffPrincipals.id),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    organizationId: text("organization_id")
      .references(() => organizations.id),
    reason: text("reason"),
    beforeJson: text("before_json", { mode: "json" }).$type<Record<string, unknown>>(),
    afterJson: text("after_json", { mode: "json" }).$type<Record<string, unknown>>(),
    requestId: text("request_id").notNull(),
    idempotencyKeyHash: text("idempotency_key_hash"),
    occurredAt: integer("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("platform_staff_events_staff_idempotency_unique")
      .on(table.actorPrincipalId, table.idempotencyKeyHash)
      .where(sql`${table.actorType} = 'staff'`),
    index("platform_staff_events_occurred_idx").on(table.occurredAt, table.id),
    index("platform_staff_events_actor_occurred_idx")
      .on(table.actorPrincipalId, table.occurredAt),
    index("platform_staff_events_target_occurred_idx")
      .on(table.targetType, table.targetId, table.occurredAt),
    index("platform_staff_events_organization_occurred_idx")
      .on(table.organizationId, table.occurredAt),
    check(
      "platform_staff_events_id_check",
      sql`typeof(${table.id}) = 'text' AND length(trim(${table.id})) BETWEEN 1 AND 160`,
    ),
    check(
      "platform_staff_events_actor_check",
      sql`typeof(${table.actorType}) = 'text'
      AND (
          ${table.actorType} = 'system'
          AND ${table.actorPrincipalId} IS NULL
          AND ${table.idempotencyKeyHash} IS NULL
          AND (
            ${table.reason} IS NULL
            OR (
              typeof(${table.reason}) = 'text'
              AND length(trim(${table.reason})) BETWEEN 3 AND 1000
            )
          )
        )
        OR (
          ${table.actorType} = 'staff'
          AND ${table.actorPrincipalId} IS NOT NULL
          AND ${table.reason} IS NOT NULL
          AND typeof(${table.reason}) = 'text'
          AND length(trim(${table.reason})) BETWEEN 3 AND 1000
          AND ${table.idempotencyKeyHash} IS NOT NULL
        )`,
    ),
    check(
      "platform_staff_events_action_check",
      sql`typeof(${table.action}) = 'text'
        AND length(trim(${table.action})) BETWEEN 5 AND 160
        AND ${table.action} = trim(${table.action})
        AND instr(${table.action}, '.v') > 1
        AND length(substr(${table.action}, instr(${table.action}, '.v') + 2)) >= 1
        AND substr(${table.action}, instr(${table.action}, '.v') + 2, 1) BETWEEN '1' AND '9'
        AND substr(${table.action}, instr(${table.action}, '.v') + 2) NOT GLOB '*[^0-9]*'`,
    ),
    check(
      "platform_staff_events_target_check",
      sql`typeof(${table.targetType}) = 'text'
        AND typeof(${table.targetId}) = 'text'
        AND length(trim(${table.targetType})) BETWEEN 1 AND 80
        AND length(trim(${table.targetId})) BETWEEN 1 AND 160`,
    ),
    check(
      "platform_staff_events_json_check",
      sql`(${table.beforeJson} IS NULL OR (
          typeof(${table.beforeJson}) = 'text'
          AND json_valid(${table.beforeJson})
          AND json_type(${table.beforeJson}) = 'object'
        ))
        AND (${table.afterJson} IS NULL OR (
          typeof(${table.afterJson}) = 'text'
          AND json_valid(${table.afterJson})
          AND json_type(${table.afterJson}) = 'object'
        ))
        AND (${table.beforeJson} IS NOT NULL OR ${table.afterJson} IS NOT NULL)`,
    ),
    check(
      "platform_staff_events_request_check",
      sql`typeof(${table.requestId}) = 'text'
        AND length(trim(${table.requestId})) BETWEEN 1 AND 180`,
    ),
    check(
      "platform_staff_events_idempotency_check",
      sql`${table.idempotencyKeyHash} IS NULL
        OR (
          typeof(${table.idempotencyKeyHash}) = 'text'
          AND length(${table.idempotencyKeyHash}) = 64
          AND ${table.idempotencyKeyHash} NOT GLOB '*[^0-9a-f]*'
        )`,
    ),
    check(
      "platform_staff_events_occurred_at_check",
      sql`typeof(${table.occurredAt}) = 'integer' AND ${table.occurredAt} >= 0`,
    ),
  ],
);

export const fields = sqliteTable(
  "fields",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    location: text("location").notNull().default(""),
    isDemo: integer("is_demo", { mode: "boolean" }).notNull().default(true),
    areaHectares: real("area_hectares").notNull().default(0),
    coordinates: text("coordinates", { mode: "json" }).$type<Coordinate[]>().notNull().default(sql`'[]'`),
    soilReportFilename: text("soil_report_filename"),
    soilReportFolio: text("soil_report_folio"),
    soilSampleId: text("soil_sample_id"),
    soilReportDate: text("soil_report_date"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("fields_organization_id_unique").on(table.organizationId, table.id)],
);

export const organizationMemberships = sqliteTable(
  "organization_memberships",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    userEmail: text("user_email").notNull(),
    normalizedEmail: text("normalized_email").notNull(),
    displayName: text("display_name").notNull(),
    role: text("role").$type<OrganizationMembershipRole>().notNull(),
    status: text("status").$type<OrganizationMembershipStatus>().notNull().default("active"),
    closureRequestId: text("closure_request_id")
      .references(() => accountClosureRequests.id),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("organization_memberships_email_unique").on(table.organizationId, table.normalizedEmail),
    uniqueIndex("organization_memberships_organization_id_unique").on(table.organizationId, table.id),
    index("organization_memberships_status_role_idx").on(table.organizationId, table.status, table.role),
    index("organization_memberships_closure_request_idx")
      .on(table.closureRequestId)
      .where(sql`${table.closureRequestId} IS NOT NULL`),
    check("organization_memberships_role_check", sql`${table.role} IN ('owner', 'admin', 'manager', 'operator', 'viewer')`),
    check("organization_memberships_status_check", sql`${table.status} IN ('active', 'suspended')`),
  ],
);

export const membershipFieldAccess = sqliteTable(
  "membership_field_access",
  {
    id: text("id").primaryKey(),
    membershipId: text("membership_id")
      .notNull()
      .references(() => organizationMemberships.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("membership_field_access_unique").on(table.membershipId, table.fieldId),
    index("membership_field_access_field_idx").on(table.fieldId),
  ],
);

export const legalAcceptances = sqliteTable(
  "legal_acceptances",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => authIdentities.id),
    documentKind: text("document_kind").$type<"privacy" | "terms">().notNull(),
    documentVersion: text("document_version").notNull(),
    documentPublishedOn: text("document_published_on").notNull(),
    documentContentSha256: text("document_content_sha256").notNull(),
    acceptedAt: text("accepted_at").notNull(),
    evidenceVersion: integer("evidence_version").notNull(),
    evidenceJson: text("evidence_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    requestId: text("request_id").notNull(),
  },
  (table) => [
    uniqueIndex("legal_acceptances_identity_document_unique")
      .on(table.identityId, table.documentKind, table.documentVersion),
    index("legal_acceptances_identity_time_idx").on(table.identityId, table.acceptedAt),
    check("legal_acceptances_kind_check", sql`${table.documentKind} IN ('privacy', 'terms')`),
    check("legal_acceptances_version_check", sql`length(${table.documentVersion}) BETWEEN 1 AND 80`),
    check(
      "legal_acceptances_published_on_check",
      sql`date(${table.documentPublishedOn}) IS NOT NULL`,
    ),
    check(
      "legal_acceptances_content_hash_check",
      sql`length(${table.documentContentSha256}) = 64
        AND ${table.documentContentSha256} NOT GLOB '*[^a-f0-9]*'`,
    ),
    check("legal_acceptances_time_check", sql`datetime(${table.acceptedAt}) IS NOT NULL`),
    check("legal_acceptances_evidence_version_check", sql`${table.evidenceVersion} = 1`),
    check(
      "legal_acceptances_evidence_json_check",
      sql`json_valid(${table.evidenceJson}) AND json_type(${table.evidenceJson}) = 'object'`,
    ),
    check("legal_acceptances_request_check", sql`length(${table.requestId}) BETWEEN 1 AND 160`),
  ],
);

export const accountClosureRequests = sqliteTable(
  "account_closure_requests",
  {
    id: text("id").primaryKey(),
    scope: text("scope").$type<"account" | "organization">().notNull(),
    targetId: text("target_id").notNull(),
    actorIdentityId: text("actor_identity_id")
      .notNull()
      .references(() => authIdentities.id),
    requestId: text("request_id").notNull(),
    status: text("status").$type<"grace" | "revoked">().notNull(),
    requestedAt: text("requested_at").notNull(),
    graceEndsAt: text("grace_ends_at").notNull(),
    revokedAt: text("revoked_at"),
    version: integer("version").notNull(),
    snapshotVersion: integer("snapshot_version").notNull(),
    snapshotJson: text("snapshot_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
  },
  (table) => [
    uniqueIndex("account_closure_requests_actor_request_unique")
      .on(table.actorIdentityId, table.requestId),
    uniqueIndex("account_closure_requests_active_target_unique")
      .on(table.scope, table.targetId)
      .where(sql`${table.status} = 'grace'`),
    index("account_closure_requests_target_status_idx")
      .on(table.scope, table.targetId, table.status),
    index("account_closure_requests_grace_idx").on(table.status, table.graceEndsAt),
    check("account_closure_requests_scope_check", sql`${table.scope} IN ('account', 'organization')`),
    check("account_closure_requests_target_check", sql`length(${table.targetId}) BETWEEN 1 AND 320`),
    check("account_closure_requests_request_check", sql`length(${table.requestId}) BETWEEN 1 AND 160`),
    check("account_closure_requests_status_check", sql`${table.status} IN ('grace', 'revoked')`),
    check(
      "account_closure_requests_time_check",
      sql`datetime(${table.requestedAt}) IS NOT NULL
        AND datetime(${table.graceEndsAt}) IS NOT NULL
        AND ${table.graceEndsAt} > ${table.requestedAt}
        AND (${table.revokedAt} IS NULL OR datetime(${table.revokedAt}) IS NOT NULL)`,
    ),
    check(
      "account_closure_requests_revocation_check",
      sql`(${table.status} = 'grace' AND ${table.revokedAt} IS NULL AND ${table.version} = 1)
        OR (${table.status} = 'revoked' AND ${table.revokedAt} IS NOT NULL AND ${table.version} > 1)`,
    ),
    check("account_closure_requests_snapshot_version_check", sql`${table.snapshotVersion} = 1`),
    check(
      "account_closure_requests_snapshot_json_check",
      sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`,
    ),
  ],
);

export const personalDataEvents = sqliteTable(
  "personal_data_events",
  {
    id: text("id").primaryKey(),
    identityId: text("identity_id")
      .notNull()
      .references(() => authIdentities.id),
    organizationId: text("organization_id").references(() => organizations.id),
    requestId: text("request_id").notNull(),
    eventType: text("event_type")
      .$type<
        | "legal.acceptance.recorded"
        | "account.closure.requested"
        | "account.closure.revoked"
        | "workspace.exported"
      >()
      .notNull(),
    entityType: text("entity_type")
      .$type<"legal_acceptance" | "account_closure" | "workspace_export">()
      .notNull(),
    entityId: text("entity_id").notNull(),
    payloadJson: text("payload_json", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    uniqueIndex("personal_data_events_identity_request_type_unique")
      .on(table.identityId, table.requestId, table.eventType),
    index("personal_data_events_identity_time_idx").on(table.identityId, table.occurredAt),
    index("personal_data_events_organization_time_idx")
      .on(table.organizationId, table.occurredAt),
    index("personal_data_events_entity_idx").on(table.entityType, table.entityId),
    check(
      "personal_data_events_type_check",
      sql`${table.eventType} IN (
        'legal.acceptance.recorded',
        'account.closure.requested',
        'account.closure.revoked',
        'workspace.exported'
      )`,
    ),
    check(
      "personal_data_events_entity_type_check",
      sql`${table.entityType} IN ('legal_acceptance', 'account_closure', 'workspace_export')`,
    ),
    check("personal_data_events_request_check", sql`length(${table.requestId}) BETWEEN 1 AND 160`),
    check(
      "personal_data_events_payload_check",
      sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`,
    ),
    check("personal_data_events_time_check", sql`datetime(${table.occurredAt}) IS NOT NULL`),
  ],
);

export const organizationAccessBootstrap = sqliteTable("organization_access_bootstrap", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organizations.id),
  ownerEmail: text("owner_email").notNull(),
  claimedAt: text("claimed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const appState = sqliteTable("app_state", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const organizationFeatureFlags = sqliteTable(
  "organization_feature_flags",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id").references(() => fields.id),
    feature: text("feature").$type<FeatureKey>().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("organization_feature_flags_global_unique")
      .on(table.organizationId, table.feature)
      .where(sql`${table.fieldId} IS NULL`),
    uniqueIndex("organization_feature_flags_field_unique")
      .on(table.organizationId, table.fieldId, table.feature)
      .where(sql`${table.fieldId} IS NOT NULL`),
    index("organization_feature_flags_lookup_idx").on(table.organizationId, table.feature, table.fieldId, table.enabled),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "organization_feature_flags_organization_field_fk",
    }),
    check("organization_feature_flags_feature_check", sql`${table.feature} IN ('trazabilidad', 'pastoreo', 'analitica', 'benchmarking')`),
  ],
);

export type AiProviderKey = "gemini" | "openai" | "anthropic";

export const organizationAiConfigs = sqliteTable(
  "organization_ai_configs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    provider: text("provider").$type<AiProviderKey>().notNull(),
    encryptedApiKey: text("encrypted_api_key").notNull(),
    encryptedKeyIv: text("encrypted_key_iv").notNull(),
    defaultModel: text("default_model").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("organization_ai_configs_org_provider_idx").on(
      table.organizationId,
      table.provider,
    ),
    index("organization_ai_configs_lookup_idx").on(
      table.organizationId,
      table.isActive,
    ),
  ],
);

export const syncMutations = sqliteTable(
  "sync_mutations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    actor: text("actor").notNull(),
    entity: text("entity").$type<SyncEntity>().notNull(),
    entityId: text("entity_id").notNull(),
    op: text("op").$type<SyncMutationOperation>().notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, SyncJsonValue>>().notNull(),
    clientTs: text("client_ts").notNull(),
    expectedVersion: text("expected_version"),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    appliedAt: text("applied_at"),
    status: text("status").$type<SyncMutationStatus>().notNull().default("pending"),
    conflictReason: text("conflict_reason"),
    eventId: text("event_id"),
    serverVersion: text("server_version"),
  },
  (table) => [
    index("sync_mutations_scope_received_idx").on(table.organizationId, table.fieldId, table.receivedAt, table.id),
    index("sync_mutations_actor_status_idx").on(table.organizationId, table.actor, table.status),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "sync_mutations_organization_field_fk",
    }),
    check("sync_mutations_status_check", sql`${table.status} IN ('pending', 'applied', 'conflict', 'rejected')`),
    check("sync_mutations_op_check", sql`${table.op} IN ('create', 'update', 'append')`),
    check("sync_mutations_payload_check", sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`),
    check("sync_mutations_terminal_check", sql`(${table.status} = 'pending' AND ${table.appliedAt} IS NULL) OR (${table.status} <> 'pending' AND ${table.appliedAt} IS NOT NULL)`),
  ],
);

export const domainEvents = sqliteTable(
  "domain_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    type: text("type").notNull(),
    entity: text("entity").notNull(),
    entityId: text("entity_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, SyncJsonValue>>().notNull(),
    sourceMutationId: text("source_mutation_id").references(() => syncMutations.id),
    actor: text("actor").notNull(),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("domain_events_source_mutation_unique").on(table.sourceMutationId),
    index("domain_events_scope_cursor_idx").on(table.organizationId, table.fieldId, table.sequence),
    index("domain_events_entity_cursor_idx").on(table.organizationId, table.fieldId, table.entity, table.entityId, table.sequence),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "domain_events_organization_field_fk",
    }),
    check("domain_events_payload_check", sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`),
  ],
);

export const scheduledJobs = sqliteTable(
  "scheduled_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(() => organizations.id),
    fieldId: text("field_id").references(() => fields.id),
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, SyncJsonValue>>().notNull().default(sql`'{}'`),
    status: text("status").$type<ScheduledJobStatus>().notNull().default("active"),
    dueAt: text("due_at").notNull(),
    intervalSeconds: integer("interval_seconds").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: text("lease_expires_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastStartedAt: text("last_started_at"),
    lastCompletedAt: text("last_completed_at"),
    lastErrorType: text("last_error_type"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("scheduled_jobs_due_idx").on(table.status, table.dueAt, table.leaseExpiresAt),
    index("scheduled_jobs_scope_type_idx").on(table.organizationId, table.fieldId, table.type),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "scheduled_jobs_organization_field_fk",
    }),
    check("scheduled_jobs_status_check", sql`${table.status} IN ('active', 'paused')`),
    check("scheduled_jobs_interval_check", sql`${table.intervalSeconds} BETWEEN 60 AND 31536000`),
    check("scheduled_jobs_attempt_check", sql`${table.attemptCount} >= 0`),
    check("scheduled_jobs_scope_check", sql`${table.fieldId} IS NULL OR ${table.organizationId} IS NOT NULL`),
    check("scheduled_jobs_payload_check", sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`),
  ],
);

export const paddockOperations = sqliteTable(
  "paddock_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    kind: text("kind").$type<PaddockOperationKind>().notNull(),
    requestHash: text("request_hash").notNull(),
    snapshotToken: text("snapshot_token").notNull(),
    sourceOperationId: text("source_operation_id"),
    request: text("request", { mode: "json" }).$type<PaddockOperationPlanRequest>().notNull(),
    result: text("result", { mode: "json" }).$type<PaddockOperationResult>().notNull(),
    actor: text("actor").notNull(),
    committedAt: text("committed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    revertedAt: text("reverted_at"),
    revertedByOperationId: text("reverted_by_operation_id"),
  },
  (table) => [
    index("paddock_operations_organization_time_idx").on(table.organizationId, table.committedAt),
    index("paddock_operations_field_time_idx").on(table.fieldId, table.committedAt),
    index("paddock_operations_source_idx").on(table.sourceOperationId),
    check("paddock_operations_kind_check", sql`${table.kind} IN ('split', 'merge', 'redesign', 'undo')`),
  ],
);

export const paddocks = sqliteTable("potreros", {
  id: text("id").primaryKey(),
  fieldId: text("field_id")
    .notNull()
    .references(() => fields.id),
  name: text("name").notNull(),
  sector: text("sector").notNull(),
  areaHectares: real("area_hectares").notNull(),
  coordinates: text("coordinates", { mode: "json" }).$type<StoredPolygon>().notNull(),
  grazeableAreaHectares: real("grazeable_area_hectares"),
  landUse: text("land_use").$type<PaddockLandUse>().notNull().default("pradera_permanente"),
  holeKinds: text("hole_kinds", { mode: "json" }).$type<ExclusionKind[]>().notNull().default(sql`'[]'`),
  soilPh: real("soil_ph"),
  soilNitrogen: real("soil_nitrogen"),
  soilPhosphorus: real("soil_phosphorus"),
  soilPotassium: real("soil_potassium"),
  lastActivity: text("last_activity").notNull().default("Creado · ahora"),
  status: text("status").$type<Potrero["status"]>().notNull().default("Disponible"),
  createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  deletedAt: text("deleted_at"),
  archivedAt: text("archived_at"),
  archiveReason: text("archive_reason").$type<PaddockArchiveReason>(),
  createdByOperationId: text("created_by_operation_id"),
  archivedByOperationId: text("archived_by_operation_id"),
}, (table) => [
  index("potreros_field_active_idx").on(table.fieldId, table.archivedAt, table.deletedAt),
  index("potreros_created_operation_idx").on(table.createdByOperationId),
  index("potreros_archived_operation_idx").on(table.archivedByOperationId),
  uniqueIndex("potreros_field_id_unique").on(table.fieldId, table.id),
  check("potreros_grazeable_area_check", sql`${table.grazeableAreaHectares} IS NULL OR ${table.grazeableAreaHectares} >= 0`),
  check("potreros_land_use_check", sql`${table.landUse} IN ('pradera_permanente', 'pradera_rotacion', 'cultivo_forrajero', 'cultivo', 'bosque', 'infraestructura', 'otro')`),
]);

export const paddockNdvi = sqliteTable(
  "paddock_ndvi",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    month: text("month").notNull(),
    status: text("status").$type<PaddockNdviStatus>().notNull(),
    meanNdvi: real("mean_ndvi"),
    noDataReason: text("no_data_reason").$type<PaddockNdviNoDataReason>(),
    cloudPct: real("cloud_pct"),
    cloudPctIsApproximate: integer("cloud_pct_is_approximate", { mode: "boolean" }).notNull().default(false),
    intervalFrom: text("interval_from").notNull(),
    intervalTo: text("interval_to").notNull(),
    observedAt: text("observed_at"),
    sampleCount: integer("sample_count").notNull(),
    noDataCount: integer("no_data_count").notNull(),
    validSampleCount: integer("valid_sample_count").notNull(),
    computedAt: text("computed_at").notNull(),
    geometrySnapshot: text("geometry_snapshot", { mode: "json" }).$type<StoredPolygon>().notNull(),
    paddockSnapshot: text("paddock_snapshot", { mode: "json" }).$type<PaddockNdviPaddockSnapshot>().notNull(),
    geometrySnapshotToken: text("geometry_snapshot_token").notNull(),
  },
  (table) => [
    uniqueIndex("paddock_ndvi_scope_month_unique").on(
      table.organizationId,
      table.fieldId,
      table.paddockId,
      table.month,
    ),
    index("paddock_ndvi_field_month_idx").on(table.organizationId, table.fieldId, table.month),
    index("paddock_ndvi_paddock_computed_idx").on(table.paddockId, table.computedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "paddock_ndvi_organization_field_fk",
    }),
    foreignKey({
      columns: [table.fieldId, table.paddockId],
      foreignColumns: [paddocks.fieldId, paddocks.id],
      name: "paddock_ndvi_field_paddock_fk",
    }),
    check("paddock_ndvi_month_check", sql`${table.month} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01'`),
    check("paddock_ndvi_status_check", sql`${table.status} IN ('ok', 'no_data')`),
    check("paddock_ndvi_interval_check", sql`${table.intervalFrom} < ${table.intervalTo} AND substr(${table.intervalFrom}, 1, 10) = ${table.month}`),
    check("paddock_ndvi_counts_check", sql`${table.sampleCount} >= 0 AND ${table.noDataCount} >= 0 AND ${table.validSampleCount} >= 0 AND ${table.sampleCount} = ${table.noDataCount} + ${table.validSampleCount}`),
    check("paddock_ndvi_result_check", sql`(
      ${table.status} = 'ok'
      AND ${table.meanNdvi} BETWEEN -1 AND 1
      AND ${table.noDataReason} IS NULL
      AND ${table.cloudPct} BETWEEN 0 AND 100
      AND ${table.cloudPctIsApproximate} = 1
      AND ${table.observedAt} IS NOT NULL
      AND ${table.validSampleCount} > 0
    ) OR (
      ${table.status} = 'no_data'
      AND ${table.meanNdvi} IS NULL
      AND ${table.noDataReason} IN ('no_intervals', 'no_valid_samples')
      AND ${table.cloudPct} IS NULL
      AND ${table.cloudPctIsApproximate} = 0
      AND ${table.validSampleCount} = 0
      AND (${table.noDataReason} = 'no_valid_samples' OR ${table.observedAt} IS NULL)
    )`),
    check("paddock_ndvi_geometry_snapshot_check", sql`json_valid(${table.geometrySnapshot}) AND json_type(${table.geometrySnapshot}) IN ('array', 'object')`),
    check("paddock_ndvi_paddock_snapshot_check", sql`json_valid(${table.paddockSnapshot}) AND json_type(${table.paddockSnapshot}) = 'object'`),
  ],
);

export const paddockLineageEdges = sqliteTable(
  "paddock_lineage_edges",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => paddockOperations.id),
    parentPaddockId: text("parent_paddock_id")
      .notNull()
      .references(() => paddocks.id),
    childPaddockId: text("child_paddock_id")
      .notNull()
      .references(() => paddocks.id),
    overlapSquareMeters: real("overlap_square_meters").notNull(),
    parentOverlapRatio: real("parent_overlap_ratio").notNull(),
    childOverlapRatio: real("child_overlap_ratio").notNull(),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("paddock_lineage_edges_operation_pair_unique").on(table.operationId, table.parentPaddockId, table.childPaddockId),
    index("paddock_lineage_edges_parent_idx").on(table.parentPaddockId),
    index("paddock_lineage_edges_child_idx").on(table.childPaddockId),
    check("paddock_lineage_edges_distinct_check", sql`${table.parentPaddockId} <> ${table.childPaddockId}`),
  ],
);

export const activities = sqliteTable(
  "activities",
  {
    id: text("id").primaryKey(),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    type: text("type").$type<ActivityType>().notNull(),
    occurredAt: text("occurred_at").notNull(),
    description: text("description").notNull(),
    quantity: real("quantity"),
    unit: text("unit"),
    costClp: real("cost_clp"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
  },
  (table) => [
    index("activities_paddock_idx").on(table.paddockId),
    index("activities_occurred_at_idx").on(table.occurredAt),
  ],
);

export const subdivisionDrafts = sqliteTable("subdivision_drafts", {
  fieldId: text("field_id")
    .primaryKey()
    .references(() => fields.id),
  history: text("history", { mode: "json" }).$type<Coordinate[][][]>().notNull(),
  line: text("line", { mode: "json" }).$type<Coordinate[]>().notNull().default(sql`'[]'`),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const scopedSubdivisionDrafts = sqliteTable(
  "paddock_subdivision_drafts",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    scopeKind: text("scope_kind").$type<SubdivisionScopeKind>().notNull(),
    scopeId: text("scope_id").notNull(),
    history: text("history", { mode: "json" }).$type<ScopedSubdivisionDraft["history"]>().notNull(),
    line: text("line", { mode: "json" }).$type<ScopedSubdivisionDraft["line"]>().notNull().default(sql`'[]'`),
    baseSnapshotToken: text("base_snapshot_token").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("paddock_subdivision_drafts_scope_unique").on(table.fieldId, table.scopeKind, table.scopeId),
    index("paddock_subdivision_drafts_field_idx").on(table.fieldId),
    check("paddock_subdivision_drafts_scope_kind_check", sql`${table.scopeKind} IN ('field', 'paddock')`),
  ],
);

export const livestockLots = sqliteTable(
  "livestock_lots",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id").references(() => paddocks.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    category: text("category").$type<LivestockCategory>().notNull(),
    animalCount: integer("animal_count").notNull(),
    averageWeightKg: real("average_weight_kg"),
    entryDate: text("entry_date").notNull(),
    status: text("status").$type<LivestockStatus>().notNull().default("active"),
    ownerName: text("owner_name"),
    trackingMode: text("tracking_mode").$type<LivestockTrackingMode>().notNull().default("summary"),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_lots_field_idx").on(table.fieldId),
    index("livestock_lots_paddock_idx").on(table.paddockId),
    index("livestock_lots_status_idx").on(table.status),
  ],
);

export const paddockCellOperations = sqliteTable(
  "paddock_cell_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    kind: text("kind").$type<PaddockCellOperationKind>().notNull(),
    requestHash: text("request_hash").notNull(),
    snapshotToken: text("snapshot_token").notNull(),
    request: text("request", { mode: "json" }).$type<PaddockCellOperationRequest>().notNull(),
    result: text("result", { mode: "json" }).$type<PaddockCellOperationResult>().notNull(),
    actor: text("actor").notNull(),
    committedAt: text("committed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("paddock_cell_operations_organization_time_idx").on(table.organizationId, table.committedAt),
    index("paddock_cell_operations_field_time_idx").on(table.fieldId, table.committedAt),
    index("paddock_cell_operations_paddock_time_idx").on(table.paddockId, table.committedAt),
    check("paddock_cell_operations_kind_check", sql`${table.kind} IN ('create', 'close')`),
  ],
);

export const paddockCells = sqliteTable(
  "paddock_cells",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    name: text("name").notNull(),
    cellIndex: integer("cell_index").notNull(),
    coordinates: text("coordinates", { mode: "json" }).$type<PolygonRings>().notNull(),
    areaSquareMeters: real("area_square_meters").notNull(),
    startDistanceMeters: real("start_distance_meters").notNull(),
    endDistanceMeters: real("end_distance_meters").notNull(),
    activeFrom: text("active_from").notNull(),
    activeTo: text("active_to"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
    createdByOperationId: text("created_by_operation_id")
      .notNull()
      .references(() => paddockCellOperations.id),
    closedByOperationId: text("closed_by_operation_id")
      .references(() => paddockCellOperations.id),
  },
  (table) => [
    uniqueIndex("paddock_cells_operation_index_unique").on(table.createdByOperationId, table.cellIndex),
    index("paddock_cells_field_active_idx").on(table.fieldId, table.activeTo),
    index("paddock_cells_paddock_active_idx").on(table.paddockId, table.activeTo),
    check("paddock_cells_index_check", sql`${table.cellIndex} > 0`),
    check("paddock_cells_area_check", sql`${table.areaSquareMeters} > 0`),
    check("paddock_cells_distances_check", sql`${table.startDistanceMeters} >= 0 AND ${table.endDistanceMeters} > ${table.startDistanceMeters}`),
    check("paddock_cells_geometry_check", sql`json_valid(${table.coordinates}) AND json_type(${table.coordinates}) = 'object'`),
    check("paddock_cells_active_dates_check", sql`${table.activeTo} IS NULL OR ${table.activeTo} >= ${table.activeFrom}`),
    check("paddock_cells_version_check", sql`${table.version} >= 1`),
  ],
);

export const paddockRotationSettings = sqliteTable(
  "paddock_rotation_settings",
  {
    fieldId: text("field_id")
      .primaryKey()
      .references(() => fields.id),
    recentDays: integer("recent_days").notNull().default(15),
    longRestDays: integer("long_rest_days").notNull().default(30),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    check("paddock_rotation_settings_thresholds_check", sql`${table.recentDays} >= 0 AND ${table.recentDays} < ${table.longRestDays}`),
    check("paddock_rotation_settings_version_check", sql`${table.version} >= 1`),
  ],
);

export const paddockRotationSettingOperations = sqliteTable(
  "paddock_rotation_setting_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    requestHash: text("request_hash").notNull(),
    expectedVersion: integer("expected_version"),
    result: text("result", { mode: "json" }).$type<PaddockRotationSettings>().notNull(),
    actor: text("actor").notNull(),
    committedAt: text("committed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("paddock_rotation_setting_operations_organization_time_idx").on(table.organizationId, table.committedAt),
    index("paddock_rotation_setting_operations_field_time_idx").on(table.fieldId, table.committedAt),
    check("paddock_rotation_setting_operations_version_check", sql`${table.expectedVersion} IS NULL OR ${table.expectedVersion} >= 1`),
  ],
);

export const fieldLandmarkOperations = sqliteTable(
  "field_landmark_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    landmarkId: text("landmark_id").notNull(),
    kind: text("kind").$type<FieldLandmarkOperationKind>().notNull(),
    requestHash: text("request_hash").notNull(),
    expectedVersion: integer("expected_version"),
    request: text("request", { mode: "json" }).$type<FieldLandmarkOperationRequest>().notNull(),
    result: text("result", { mode: "json" }).$type<FieldLandmarkOperationResult>().notNull(),
    actor: text("actor").notNull(),
    committedAt: text("committed_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("field_landmark_operations_organization_time_idx").on(table.organizationId, table.committedAt),
    index("field_landmark_operations_field_time_idx").on(table.fieldId, table.committedAt),
    index("field_landmark_operations_landmark_time_idx").on(table.landmarkId, table.committedAt),
    check("field_landmark_operations_kind_check", sql`${table.kind} IN ('create', 'update', 'delete')`),
    check("field_landmark_operations_version_check", sql`${table.expectedVersion} IS NULL OR ${table.expectedVersion} >= 1`),
  ],
);

export const fieldLandmarks = sqliteTable(
  "field_landmarks",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    kind: text("kind").$type<FieldLandmarkKind>().notNull(),
    geometryType: text("geometry_type").$type<FieldLandmarkGeometryType>().notNull(),
    geometry: text("geometry", { mode: "json" }).$type<Coordinate[]>().notNull(),
    name: text("name").notNull(),
    notes: text("notes").notNull().default(""),
    lengthMeters: real("length_meters").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    deletedAt: text("deleted_at"),
    version: integer("version").notNull().default(1),
    lastOperationId: text("last_operation_id")
      .notNull()
      .references(() => fieldLandmarkOperations.id),
  },
  (table) => [
    index("field_landmarks_field_active_idx").on(table.fieldId, table.deletedAt),
    index("field_landmarks_field_kind_active_idx").on(table.fieldId, table.kind, table.deletedAt),
    index("field_landmarks_last_operation_idx").on(table.lastOperationId),
    check("field_landmarks_kind_check", sql`${table.kind} IN ('bebedero', 'porton', 'sala_ordena', 'bodega', 'manga', 'cerco_electrico', 'callejon', 'linea_agua', 'otro')`),
    check("field_landmarks_geometry_type_check", sql`${table.geometryType} IN ('point', 'line')`),
    check("field_landmarks_geometry_json_check", sql`json_valid(${table.geometry}) AND json_type(${table.geometry}) = 'array'`),
    check("field_landmarks_geometry_shape_check", sql`(${table.geometryType} = 'point' AND json_array_length(${table.geometry}) = 1) OR (${table.geometryType} = 'line' AND json_array_length(${table.geometry}) BETWEEN 2 AND 2000)`),
    check("field_landmarks_length_check", sql`(${table.geometryType} = 'point' AND ${table.lengthMeters} = 0) OR (${table.geometryType} = 'line' AND ${table.lengthMeters} > 0)`),
    check("field_landmarks_name_check", sql`length(trim(${table.name})) BETWEEN 1 AND 160`),
    check("field_landmarks_notes_check", sql`length(${table.notes}) <= 2000`),
    check("field_landmarks_deleted_date_check", sql`${table.deletedAt} IS NULL OR ${table.deletedAt} >= ${table.createdAt}`),
    check("field_landmarks_version_check", sql`${table.version} >= 1`),
  ],
);

export const paddockOperationLotMoves = sqliteTable(
  "paddock_operation_lot_moves",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => paddockOperations.id),
    lotId: text("lot_id").notNull(),
    fromPaddockId: text("from_paddock_id"),
    toPaddockId: text("to_paddock_id"),
    overlapSquareMeters: real("overlap_square_meters").notNull().default(0),
    overlapRatio: real("overlap_ratio").notNull().default(0),
    reason: text("reason").notNull(),
    warning: text("warning"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("paddock_operation_lot_moves_operation_lot_unique").on(table.operationId, table.lotId),
    index("paddock_operation_lot_moves_lot_idx").on(table.lotId),
  ],
);

export const livestockAnimals = sqliteTable(
  "livestock_animals",
  {
    id: text("id").primaryKey(),
    lotId: text("lot_id")
      .notNull()
      .references(() => livestockLots.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
    sex: text("sex").$type<LivestockSex>().notNull().default("unknown"),
    status: text("status").$type<LivestockAnimalStatus>().notNull().default("active"),
    statusDate: text("status_date"),
    statusReason: text("status_reason"),
    birthDate: text("birth_date"),
    purchasePriceClp: integer("purchase_price_clp"),
    purchaseDate: text("purchase_date"),
    salePriceClp: integer("sale_price_clp"),
    saleBuyer: text("sale_buyer"),
    saleWeightKg: real("sale_weight_kg"),
    origin: text("origin"),
    notes: text("notes").notNull().default(""),
    source: text("source").notNull().default("Registro manual"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_animals_tag_idx").on(table.tag),
    index("livestock_animals_lot_idx").on(table.lotId),
    index("livestock_animals_status_idx").on(table.status),
    check("livestock_animals_sale_price_check", sql`${table.salePriceClp} IS NULL OR ${table.salePriceClp} >= 0`),
    check("livestock_animals_sale_weight_check", sql`${table.saleWeightKg} IS NULL OR ${table.saleWeightKg} > 0`),
  ],
);
export const livestockSaleDocuments = sqliteTable(
  "livestock_sale_documents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    documentType: text("document_type").notNull().default("liquidacion_feria"),
    documentNumber: text("document_number"),
    buyerOrSupplierName: text("buyer_or_supplier_name").notNull(),
    documentDate: text("document_date").notNull(),
    totalAmountClp: integer("total_amount_clp").notNull().default(0),
    objectKey: text("object_key"),
    sha256: text("sha256"),
    status: text("status").notNull().default("pending"),
    createdByEmail: text("created_by_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_sale_docs_org_field_idx").on(table.organizationId, table.fieldId),
    index("livestock_sale_docs_date_idx").on(table.documentDate),
  ],
);

export const livestockSaleDocumentLinks = sqliteTable(
  "livestock_sale_document_links",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => livestockSaleDocuments.id, { onDelete: "cascade" }),
    animalId: text("animal_id").references(() => livestockAnimals.id, { onDelete: "set null" }),
    lotId: text("lot_id").references(() => livestockLots.id, { onDelete: "set null" }),
    allocatedAmountClp: integer("allocated_amount_clp").notNull().default(0),
    allocatedWeightKg: real("allocated_weight_kg"),
    notes: text("notes"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_sale_doc_links_doc_idx").on(table.documentId),
    index("livestock_sale_doc_links_animal_idx").on(table.animalId),
    index("livestock_sale_doc_links_lot_idx").on(table.lotId),
  ],
);

export const livestockWeighings = sqliteTable(
  "livestock_weighings",
  {
    id: text("id").primaryKey(),
    lotId: text("lot_id").references(() => livestockLots.id, { onDelete: "set null" }),
    animalId: text("animal_id")
      .notNull()
      .references(() => livestockAnimals.id, { onDelete: "cascade" }),
    recordedAt: text("recorded_at").notNull(),
    weightKg: real("weight_kg").notNull(),
    notes: text("notes").notNull().default(""),
    source: text("source").notNull().default("Registro manual"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_weighings_animal_date_unique").on(table.animalId, table.recordedAt),
    index("livestock_weighings_lot_date_idx").on(table.lotId, table.recordedAt),
    index("livestock_weighings_animal_idx").on(table.animalId),
    index("livestock_weighings_date_idx").on(table.recordedAt),
  ],
);

export const livestockPartners = sqliteTable(
  "livestock_partners",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    name: text("name").notNull(),
    email: text("email"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_partners_organization_name_unique").on(table.organizationId, table.name),
    index("livestock_partners_organization_idx").on(table.organizationId),
  ],
);

export const livestockContributions = sqliteTable(
  "livestock_contributions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    partnerId: text("partner_id")
      .notNull()
      .references(() => livestockPartners.id, { onDelete: "cascade" }),
    amountClp: integer("amount_clp").notNull(),
    date: text("date"),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_contributions_organization_idx").on(table.organizationId),
    index("livestock_contributions_partner_idx").on(table.partnerId),
  ],
);

export const livestockExpenses = sqliteTable(
  "livestock_expenses",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id").references(() => fields.id, { onDelete: "set null" }),
    date: text("date"),
    description: text("description").notNull(),
    category: text("category").$type<LivestockExpenseCategory>().notNull().default("otro"),
    amountClp: integer("amount_clp").notNull(),
    paymentSource: text("payment_source").$type<LivestockExpensePaymentSource>().notNull().default("unassigned"),
    paidById: text("paid_by_id").references(() => livestockPartners.id, { onDelete: "set null" }),
    lotId: text("lot_id").references(() => livestockLots.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_expenses_organization_idx").on(table.organizationId),
    index("livestock_expenses_field_idx").on(table.fieldId),
    index("livestock_expenses_category_idx").on(table.category),
    index("livestock_expenses_paid_by_idx").on(table.paidById),
    index("livestock_expenses_lot_idx").on(table.lotId),
  ],
);

export const milkSettlements = sqliteTable(
  "milk_settlements",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    period: text("period").notNull(),
    generatedAt: text("generated_at"),
    plant: text("plant").notNull().default(""),
    purchaseOrder: text("purchase_order").notNull(),
    producerCode: text("producer_code").notNull().default(""),
    producerName: text("producer_name").notNull(),
    buyerName: text("buyer_name").notNull(),
    litersFirstHalf: real("liters_first_half"),
    litersSecondHalf: real("liters_second_half"),
    totalLiters: real("total_liters").notNull(),
    netAmountClp: integer("net_amount_clp").notNull(),
    taxAmountClp: integer("tax_amount_clp").notNull().default(0),
    grossAmountClp: integer("gross_amount_clp").notNull(),
    netPricePerLiterClp: real("net_price_per_liter_clp").notNull(),
    grossPricePerLiterClp: real("gross_price_per_liter_clp"),
    sourceDocumentName: text("source_document_name"),
    notes: text("notes").notNull().default(""),
    lineItems: text("line_items", { mode: "json" }).$type<MilkSettlementLineItem[]>().notNull().default(sql`'[]'`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("milk_settlements_field_idx").on(table.fieldId),
    index("milk_settlements_period_idx").on(table.period),
    uniqueIndex("milk_settlements_field_order_unique").on(table.fieldId, table.purchaseOrder),
  ],
);

export const livestockFeedingPlans = sqliteTable(
  "livestock_feeding_plans",
  {
    id: text("id").primaryKey(),
    lotId: text("lot_id")
      .notNull()
      .references(() => livestockLots.id, { onDelete: "cascade" }),
    productName: text("product_name").notNull().default("Concentrado"),
    kgPerAnimalDay: real("kg_per_animal_day").notNull().default(0),
    sackWeightKg: real("sack_weight_kg").notNull().default(25),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("livestock_feeding_plans_lot_unique").on(table.lotId)],
);

export const livestockFeedInventory = sqliteTable(
  "livestock_feed_inventory",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id").notNull().references(() => fields.id),
    productName: text("product_name").notNull(),
    quantityKg: real("quantity_kg").notNull().default(0),
    unitCostClp: real("unit_cost_clp").notNull().default(0),
    reorderLevelKg: real("reorder_level_kg").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_feed_inventory_field_product_unique").on(table.fieldId, table.productName),
    index("livestock_feed_inventory_field_idx").on(table.fieldId),
    check("livestock_feed_inventory_quantity_check", sql`${table.quantityKg} >= 0`),
    check("livestock_feed_inventory_cost_check", sql`${table.unitCostClp} >= 0`),
    check("livestock_feed_inventory_reorder_check", sql`${table.reorderLevelKg} >= 0`),
  ],
);

export const livestockFeedConsumptions = sqliteTable(
  "livestock_feed_consumptions",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id").notNull().references(() => fields.id),
    lotId: text("lot_id").notNull().references(() => livestockLots.id, { onDelete: "cascade" }),
    inventoryItemId: text("inventory_item_id").notNull().references(() => livestockFeedInventory.id),
    planId: text("plan_id").references(() => livestockFeedingPlans.id, { onDelete: "set null" }),
    occurredAt: text("occurred_at").notNull(),
    quantityKg: real("quantity_kg").notNull(),
    costClp: integer("cost_clp").notNull(),
    source: text("source").notNull().default("Registro manual"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_feed_consumptions_field_date_idx").on(table.fieldId, table.occurredAt),
    index("livestock_feed_consumptions_lot_date_idx").on(table.lotId, table.occurredAt),
    index("livestock_feed_consumptions_inventory_date_idx").on(table.inventoryItemId, table.occurredAt),
    check("livestock_feed_consumptions_quantity_check", sql`${table.quantityKg} > 0`),
    check("livestock_feed_consumptions_cost_check", sql`${table.costClp} >= 0`),
  ],
);

export const livestockNotificationPreferences = sqliteTable(
  "livestock_notification_preferences",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id),
    fieldId: text("field_id").notNull().references(() => fields.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    emailEnabled: integer("email_enabled", { mode: "boolean" }).notNull().default(false),
    browserEnabled: integer("browser_enabled", { mode: "boolean" }).notNull().default(false),
    reminderDays: integer("reminder_days").notNull().default(14),
    timezone: text("timezone").notNull().default("America/Santiago"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_notification_preferences_scope_unique").on(table.organizationId, table.fieldId, table.userEmail),
    index("livestock_notification_preferences_field_idx").on(table.fieldId),
    check("livestock_notification_preferences_days_check", sql`${table.reminderDays} BETWEEN 0 AND 60`),
  ],
);

export const livestockNotificationDeliveries = sqliteTable(
  "livestock_notification_deliveries",
  {
    id: text("id").primaryKey(),
    preferenceId: text("preference_id").notNull().references(() => livestockNotificationPreferences.id, { onDelete: "cascade" }),
    workItemId: text("work_item_id").notNull(),
    dueDate: text("due_date").notNull(),
    channel: text("channel").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    sentAt: text("sent_at"),
  },
  (table) => [
    uniqueIndex("livestock_notification_delivery_dedupe_unique").on(table.preferenceId, table.workItemId, table.dueDate, table.channel),
    index("livestock_notification_delivery_status_idx").on(table.status, table.createdAt),
    index("livestock_notification_delivery_lease_idx").on(table.status, table.leaseExpiresAt),
    check("livestock_notification_delivery_channel_check", sql`${table.channel} IN ('email', 'browser')`),
    check("livestock_notification_delivery_status_check", sql`${table.status} IN ('sent', 'failed')`),
    check("livestock_notification_delivery_lease_check", sql`
      (${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL)
      OR (${table.status} = 'failed' AND ${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)
    `),
  ],
);

export const importJobs = sqliteTable(
  "import_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    sourceSystem: text("source_system").notNull().default("cooprinsem"),
    sourceFormat: text("source_format").$type<ImportFormat>().notNull(),
    sourceTable: text("source_table").notNull(),
    originalFilename: text("original_filename").notNull(),
    contentType: text("content_type"),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    mappingVersion: text("mapping_version").notNull(),
    effectiveAt: text("effective_at"),
    status: text("status").$type<ImportJobStatus>().notNull().default("uploaded"),
    isDryRun: integer("is_dry_run", { mode: "boolean" }).notNull().default(true),
    requestedBy: text("requested_by").notNull(),
    rowCount: integer("row_count").notNull().default(0),
    validRowCount: integer("valid_row_count").notNull().default(0),
    warningRowCount: integer("warning_row_count").notNull().default(0),
    errorRowCount: integer("error_row_count").notNull().default(0),
    skippedRowCount: integer("skipped_row_count").notNull().default(0),
    fileIssueCount: integer("file_issue_count").notNull().default(0),
    failureMessage: text("failure_message"),
    startedAt: text("started_at"),
    previewedAt: text("previewed_at"),
    confirmedAt: text("confirmed_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("import_jobs_idempotency_unique").on(
      table.organizationId,
      table.fieldId,
      table.sha256,
      table.mappingVersion,
    ),
    uniqueIndex("import_jobs_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    index("import_jobs_field_created_idx").on(table.fieldId, table.createdAt),
    index("import_jobs_status_idx").on(table.status),
  ],
);

export const importJobSpecs = sqliteTable(
  "import_job_specs",
  {
    importJobId: text("import_job_id")
      .primaryKey()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    profileKey: text("profile_key").notNull(),
    profileVersion: text("profile_version").notNull(),
    mappingJson: text("mapping_json", { mode: "json" }).$type<ImportColumnMapping>(),
    documentJson: text("document_json", { mode: "json" }).$type<ImportDocumentSnapshot>().notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("import_job_specs_field_profile_idx").on(table.fieldId, table.profileKey, table.updatedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.importJobId],
      foreignColumns: [importJobs.organizationId, importJobs.fieldId, importJobs.id],
      name: "import_job_specs_scope_job_fk",
    }),
    check("import_job_specs_profile_check", sql`length(trim(${table.profileKey})) > 0 AND length(trim(${table.profileVersion})) > 0`),
    check("import_job_specs_mapping_json_check", sql`${table.mappingJson} IS NULL OR (json_valid(${table.mappingJson}) AND json_type(${table.mappingJson}) = 'object')`),
    check("import_job_specs_document_json_check", sql`json_valid(${table.documentJson}) AND json_type(${table.documentJson}) = 'object'`),
  ],
);

export const inboxAddresses = sqliteTable(
  "inbox_addresses",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    addressToken: text("address_token").notNull(),
    emailAddress: text("email_address").notNull(),
    status: text("status").$type<"active" | "revoked">().notNull().default("active"),
    createdByEmail: text("created_by_email").notNull(),
    revokedByEmail: text("revoked_by_email"),
    revokedAt: text("revoked_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("inbox_addresses_address_token_unique").on(table.addressToken),
    uniqueIndex("inbox_addresses_email_address_unique").on(table.emailAddress),
    index("inbox_addresses_field_status_idx").on(table.fieldId, table.status),
    index("inbox_addresses_org_status_idx").on(table.organizationId, table.status),
  ],
);

export const inboxSenderWhitelists = sqliteTable(
  "inbox_sender_whitelists",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    senderEmail: text("sender_email").notNull(),
    normalizedSenderEmail: text("normalized_sender_email").notNull(),
    label: text("label"),
    createdByEmail: text("created_by_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("inbox_sender_whitelists_org_email_unique").on(
      table.organizationId,
      table.normalizedSenderEmail,
    ),
    index("inbox_sender_whitelists_org_idx").on(table.organizationId),
  ],
);

export const inboxQuarantine = sqliteTable(
  "inbox_quarantine",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    inboxAddressId: text("inbox_address_id")
      .notNull()
      .references(() => inboxAddresses.id, { onDelete: "cascade" }),
    senderEmail: text("sender_email").notNull(),
    subject: text("subject"),
    messageId: text("message_id"),
    attachmentCount: integer("attachment_count").notNull().default(0),
    reason: text("reason").$type<"unauthorized_sender" | "no_valid_attachments" | "attachment_too_large" | "processing_error">().notNull(),
    status: text("status").$type<"quarantined" | "resolved" | "dismissed">().notNull().default("quarantined"),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("inbox_quarantine_org_status_idx").on(table.organizationId, table.status),
    index("inbox_quarantine_field_status_idx").on(table.fieldId, table.status),
  ],
);

export const inboxIncomingMessages = sqliteTable(
  "inbox_incoming_messages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    inboxAddressId: text("inbox_address_id")
      .notNull()
      .references(() => inboxAddresses.id, { onDelete: "cascade" }),
    messageId: text("message_id").notNull(),
    attachmentSha256: text("attachment_sha256").notNull(),
    importJobId: text("import_job_id")
      .references(() => importJobs.id, { onDelete: "set null" }),
    senderEmail: text("sender_email").notNull(),
    subject: text("subject"),
    receivedAt: text("received_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("inbox_incoming_messages_dedupe_unique").on(
      table.organizationId,
      table.messageId,
      table.attachmentSha256,
    ),
    index("inbox_incoming_messages_field_created_idx").on(table.fieldId, table.createdAt),
  ],
);

export const fieldVisits = sqliteTable(
  "field_visits",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    visitKind: text("visit_kind").$type<"technical_visit" | "pasture_measurement_batch">().notNull(),
    providerKey: text("provider_key").notNull(),
    profileKey: text("profile_key").notNull(),
    profileVersion: text("profile_version").notNull(),
    visitDate: text("visit_date").notNull(),
    nextVisitDate: text("next_visit_date"),
    reportGeneratedAt: text("report_generated_at"),
    externalProducerName: text("external_producer_name"),
    externalProducerCode: text("external_producer_code"),
    snapshotJson: text("snapshot_json", { mode: "json" }).$type<ImportDocumentSnapshot>().notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("field_visits_import_job_unique").on(table.importJobId),
    uniqueIndex("field_visits_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    index("field_visits_field_date_idx").on(table.fieldId, table.visitDate, table.confirmedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "field_visits_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.importJobId],
      foreignColumns: [importJobs.organizationId, importJobs.fieldId, importJobs.id],
      name: "field_visits_scope_job_fk",
    }),
    check("field_visits_kind_check", sql`${table.visitKind} IN ('technical_visit', 'pasture_measurement_batch')`),
    check("field_visits_provider_check", sql`length(trim(${table.providerKey})) > 0`),
    check("field_visits_profile_check", sql`length(trim(${table.profileKey})) > 0 AND length(trim(${table.profileVersion})) > 0`),
    check("field_visits_visit_date_check", sql`${table.visitDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("field_visits_next_date_check", sql`${table.nextVisitDate} IS NULL OR ${table.nextVisitDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("field_visits_snapshot_check", sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`),
  ],
);

export const originalIntegritySweepStates = sqliteTable(
  "original_integrity_sweep_states",
  {
    fieldId: text("field_id")
      .primaryKey()
      .references(() => fields.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    cycleId: text("cycle_id").notNull(),
    status: text("status").$type<CooprinsemIntegritySweepStatus>().notNull().default("pending"),
    lastTrigger: text("last_trigger").$type<CooprinsemIntegritySweepTrigger>().notNull().default("request_heartbeat"),
    cursorCreatedAt: text("cursor_created_at"),
    cursorImportJobId: text("cursor_import_job_id"),
    checkedCount: integer("checked_count").notNull().default(0),
    healthyCount: integer("healthy_count").notNull().default(0),
    missingCount: integer("missing_count").notNull().default(0),
    mismatchCount: integer("mismatch_count").notNull().default(0),
    readBytes: integer("read_bytes").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    lastStartedAt: text("last_started_at"),
    lastBatchAt: text("last_batch_at"),
    completedAt: text("completed_at"),
    nextRunAt: text("next_run_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    lastError: text("last_error"),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("original_integrity_sweep_due_idx").on(table.nextRunAt, table.leaseExpiresAt),
    check("original_integrity_sweep_status_check", sql`${table.status} IN ('pending', 'running', 'completed', 'completed_with_issues', 'failed')`),
    check("original_integrity_sweep_trigger_check", sql`${table.lastTrigger} IN ('manual', 'scheduled', 'request_heartbeat')`),
    check("original_integrity_sweep_counts_check", sql`${table.checkedCount} >= 0 AND ${table.healthyCount} >= 0 AND ${table.missingCount} >= 0 AND ${table.mismatchCount} >= 0 AND ${table.readBytes} >= 0`),
  ],
);

export const originalIntegrityIncidents = sqliteTable(
  "original_integrity_incidents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    status: text("status").$type<CooprinsemIntegrityIncidentStatus>().notNull().default("open"),
    issueType: text("issue_type").$type<CooprinsemIntegrityIncidentType>().notNull(),
    summary: text("summary").notNull(),
    expectedSizeBytes: integer("expected_size_bytes").notNull(),
    storedSizeBytes: integer("stored_size_bytes"),
    expectedSha256: text("expected_sha256").notNull(),
    calculatedSha256: text("calculated_sha256"),
    firstDetectedAt: text("first_detected_at").notNull(),
    lastDetectedAt: text("last_detected_at").notNull(),
    resolvedAt: text("resolved_at"),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("original_integrity_incidents_import_unique").on(table.importJobId),
    index("original_integrity_incidents_field_status_idx").on(table.fieldId, table.status, table.lastDetectedAt),
    check("original_integrity_incidents_status_check", sql`${table.status} IN ('open', 'resolved')`),
    check("original_integrity_incidents_type_check", sql`${table.issueType} IN ('missing', 'size_mismatch', 'content_mismatch', 'metadata_mismatch', 'size_limit')`),
    check("original_integrity_incidents_size_check", sql`${table.expectedSizeBytes} >= 0 AND (${table.storedSizeBytes} IS NULL OR ${table.storedSizeBytes} >= 0)`),
  ],
);

export const restoreConfirmationTokens = sqliteTable(
  "restore_confirmation_tokens",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull(),
    tokenSha256: text("token_sha256").notNull(),
    backupSha256: text("backup_sha256").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    planSha256: text("plan_sha256").notNull(),
    status: text("status").$type<"active" | "consumed" | "expired" | "revoked">().notNull().default("active"),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("restore_confirmation_tokens_hash_unique").on(table.tokenSha256),
    index("restore_confirmation_tokens_field_status_idx").on(table.fieldId, table.status, table.expiresAt),
    index("restore_confirmation_tokens_actor_idx").on(table.organizationId, table.actorEmail, table.createdAt),
    check("restore_confirmation_tokens_status_check", sql`${table.status} IN ('active', 'consumed', 'expired', 'revoked')`),
    check("restore_confirmation_tokens_hashes_check", sql`length(${table.tokenSha256}) = 64 AND length(${table.backupSha256}) = 64 AND length(${table.snapshotSha256}) = 64 AND length(${table.planSha256}) = 64`),
  ],
);

export const restoreRecoveryJobs = sqliteTable(
  "restore_recovery_jobs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    fieldId: text("field_id").notNull().references(() => fields.id, { onDelete: "cascade" }),
    confirmationTokenId: text("confirmation_token_id").notNull().references(() => restoreConfirmationTokens.id),
    actorEmail: text("actor_email").notNull(),
    backupSha256: text("backup_sha256").notNull(),
    snapshotSha256: text("snapshot_sha256").notNull(),
    planSha256: text("plan_sha256").notNull(),
    status: text("status").$type<FundoSmartRecoveryJobStatus>().notNull().default("prepared"),
    executionEnabled: integer("execution_enabled", { mode: "boolean" }).notNull().default(false),
    expectedRowCount: integer("expected_row_count").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    objectCursorImportJobId: text("object_cursor_import_job_id"),
    copiedObjectCount: integer("copied_object_count").notNull().default(0),
    compensationCursorImportJobId: text("compensation_cursor_import_job_id"),
    compensatedObjectCount: integer("compensated_object_count").notNull().default(0),
    appliedRowCount: integer("applied_row_count").notNull().default(0),
    verifiedRowCount: integer("verified_row_count").notNull().default(0),
    preRestoreBackupObjectKey: text("pre_restore_backup_object_key"),
    preRestoreBackupSha256: text("pre_restore_backup_sha256"),
    postRestoreSha256: text("post_restore_sha256"),
    failureCode: text("failure_code"),
    preparedAt: text("prepared_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("restore_recovery_jobs_confirmation_unique").on(table.confirmationTokenId),
    index("restore_recovery_jobs_status_lease_idx").on(table.status, table.leaseExpiresAt, table.updatedAt),
    index("restore_recovery_jobs_field_created_idx").on(table.fieldId, table.createdAt),
    check("restore_recovery_jobs_status_check", sql`${table.status} IN ('prepared', 'copying', 'applying', 'verifying', 'succeeded', 'compensating', 'failed')`),
    check("restore_recovery_jobs_execution_disabled_check", sql`${table.executionEnabled} = 0`),
    check("restore_recovery_jobs_counts_check", sql`${table.expectedRowCount} >= 0 AND ${table.attemptCount} >= 0 AND ${table.copiedObjectCount} >= 0 AND ${table.compensatedObjectCount} >= 0 AND ${table.appliedRowCount} >= 0 AND ${table.verifiedRowCount} >= 0`),
    check("restore_recovery_jobs_hashes_check", sql`length(${table.backupSha256}) = 64 AND length(${table.snapshotSha256}) = 64 AND length(${table.planSha256}) = 64 AND (${table.preRestoreBackupSha256} IS NULL OR length(${table.preRestoreBackupSha256}) = 64) AND (${table.postRestoreSha256} IS NULL OR length(${table.postRestoreSha256}) = 64)`),
    check("restore_recovery_jobs_lease_check", sql`(${table.leaseToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.leaseToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)`),
  ],
);

export const restoreRecoveryObjects = sqliteTable(
  "restore_recovery_objects",
  {
    id: text("id").primaryKey(),
    recoveryJobId: text("recovery_job_id").notNull().references(() => restoreRecoveryJobs.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id").notNull(),
    sequenceNumber: integer("sequence_number").notNull(),
    sha256: text("sha256").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status").$type<FundoSmartRecoveryObjectStatus>().notNull().default("pending"),
    destinationObjectKey: text("destination_object_key"),
    wasPreexisting: integer("was_preexisting", { mode: "boolean" }).notNull().default(false),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    copiedAt: text("copied_at"),
    verifiedAt: text("verified_at"),
    compensatedAt: text("compensated_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("restore_recovery_objects_job_import_unique").on(table.recoveryJobId, table.importJobId),
    uniqueIndex("restore_recovery_objects_job_sequence_unique").on(table.recoveryJobId, table.sequenceNumber),
    index("restore_recovery_objects_job_status_idx").on(table.recoveryJobId, table.status, table.sequenceNumber),
    check("restore_recovery_objects_status_check", sql`${table.status} IN ('pending', 'copied', 'verified', 'compensated', 'failed')`),
    check("restore_recovery_objects_values_check", sql`${table.sequenceNumber} >= 0 AND ${table.sizeBytes} >= 0 AND ${table.attemptCount} >= 0 AND length(${table.sha256}) = 64`),
    check("restore_recovery_objects_key_check", sql`${table.status} IN ('pending', 'failed') OR ${table.destinationObjectKey} IS NOT NULL`),
  ],
);

export const restoreRecoveryEvents = sqliteTable(
  "restore_recovery_events",
  {
    id: text("id").primaryKey(),
    recoveryJobId: text("recovery_job_id").notNull().references(() => restoreRecoveryJobs.id),
    sequenceNumber: integer("sequence_number").notNull(),
    eventType: text("event_type").$type<FundoSmartRecoveryEventType>().notNull(),
    jobStatus: text("job_status").$type<FundoSmartRecoveryJobStatus>().notNull(),
    jobAttemptCount: integer("job_attempt_count").notNull(),
    importJobId: text("import_job_id"),
    objectStatus: text("object_status").$type<FundoSmartRecoveryObjectStatus>(),
    failureCode: text("failure_code"),
    copiedObjectCount: integer("copied_object_count").notNull(),
    compensatedObjectCount: integer("compensated_object_count").notNull(),
    appliedRowCount: integer("applied_row_count").notNull(),
    verifiedRowCount: integer("verified_row_count").notNull(),
    evidenceVersion: integer("evidence_version").notNull().default(1),
    preRestoreBackupSha256: text("pre_restore_backup_sha256"),
    postRestoreSha256: text("post_restore_sha256"),
    occurredAt: text("occurred_at").notNull(),
    previousEventSha256: text("previous_event_sha256"),
    eventSha256: text("event_sha256").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("restore_recovery_events_job_sequence_unique").on(table.recoveryJobId, table.sequenceNumber),
    index("restore_recovery_events_job_occurred_idx").on(table.recoveryJobId, table.occurredAt),
    check("restore_recovery_events_type_check", sql`${table.eventType} IN ('prepared', 'lease_claimed', 'lease_renewed', 'lease_recovered', 'lease_released', 'checkpoint_advanced', 'object_copied', 'object_verified', 'object_failed', 'compensation_started', 'object_compensated', 'succeeded', 'failed')`),
    check("restore_recovery_events_job_status_check", sql`${table.jobStatus} IN ('prepared', 'copying', 'applying', 'verifying', 'succeeded', 'compensating', 'failed')`),
    check("restore_recovery_events_counts_check", sql`${table.sequenceNumber} >= 0 AND ${table.jobAttemptCount} >= 0 AND ${table.copiedObjectCount} >= 0 AND ${table.compensatedObjectCount} >= 0 AND ${table.appliedRowCount} >= 0 AND ${table.verifiedRowCount} >= 0`),
    check("restore_recovery_events_hashes_check", sql`${table.id} = ${table.eventSha256} AND length(${table.eventSha256}) = 64 AND ((${table.sequenceNumber} = 0 AND ${table.previousEventSha256} IS NULL) OR (${table.sequenceNumber} > 0 AND length(${table.previousEventSha256}) = 64))`),
    check("restore_recovery_events_failure_check", sql`(${table.failureCode} IS NULL AND ${table.eventType} NOT IN ('object_failed', 'compensation_started', 'failed')) OR (${table.failureCode} IN ('original_missing', 'original_hash_mismatch', 'schema_drift', 'snapshot_changed', 'plan_changed', 'foreign_key_violation', 'lease_lost', 'unknown_failure') AND ${table.eventType} IN ('object_failed', 'compensation_started', 'failed'))`),
    check("restore_recovery_events_object_check", sql`
      (${table.eventType} = 'object_copied' AND ${table.importJobId} IS NOT NULL AND ${table.objectStatus} = 'copied') OR
      (${table.eventType} = 'object_verified' AND ${table.importJobId} IS NOT NULL AND ${table.objectStatus} = 'verified') OR
      (${table.eventType} = 'object_failed' AND ${table.importJobId} IS NOT NULL AND ${table.objectStatus} = 'failed') OR
      (${table.eventType} = 'object_compensated' AND ${table.importJobId} IS NOT NULL AND ${table.objectStatus} = 'compensated') OR
      (${table.eventType} NOT IN ('object_copied', 'object_verified', 'object_failed', 'object_compensated') AND ${table.importJobId} IS NULL AND ${table.objectStatus} IS NULL)
    `),
  ],
);

export const importRows = sqliteTable(
  "import_rows",
  {
    id: text("id").primaryKey(),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    recordNumber: integer("record_number").notNull(),
    sourceKey: text("source_key"),
    rawRecord: text("raw_record", { mode: "json" }).$type<ImportRecord>().notNull(),
    normalizedRecord: text("normalized_record", { mode: "json" }).$type<ImportRecord>(),
    status: text("status").$type<ImportRowStatus>().notNull().default("pending"),
    warningCount: integer("warning_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("import_rows_job_record_unique").on(table.importJobId, table.recordNumber),
    uniqueIndex("import_rows_job_id_unique").on(table.importJobId, table.id),
    index("import_rows_job_status_idx").on(table.importJobId, table.status),
  ],
);

export const importErrors = sqliteTable(
  "import_errors",
  {
    id: text("id").primaryKey(),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id, { onDelete: "cascade" }),
    importRowId: text("import_row_id")
      .notNull()
      .references(() => importRows.id, { onDelete: "cascade" }),
    fieldName: text("field_name"),
    ruleCode: text("rule_code").notNull(),
    severity: text("severity").$type<ImportErrorSeverity>().notNull(),
    message: text("message").notNull(),
    sourceValue: text("source_value", { mode: "json" }).$type<unknown>(),
    status: text("status").$type<ImportErrorStatus>().notNull().default("open"),
    resolutionNotes: text("resolution_notes"),
    resolvedBy: text("resolved_by"),
    resolvedAt: text("resolved_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("import_errors_job_status_idx").on(table.importJobId, table.status),
    index("import_errors_row_idx").on(table.importRowId),
    index("import_errors_rule_idx").on(table.ruleCode),
  ],
);

export const sourceRecords = sqliteTable(
  "source_records",
  {
    id: text("id").primaryKey(),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    importRowId: text("import_row_id")
      .notNull()
      .references(() => importRows.id),
    sourceSystem: text("source_system").notNull().default("cooprinsem"),
    sourceTable: text("source_table").notNull(),
    sourceKey: text("source_key"),
    targetEntity: text("target_entity").notNull(),
    targetId: text("target_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("source_records_row_target_unique").on(
      table.importRowId,
      table.targetEntity,
      table.targetId,
    ),
    index("source_records_target_idx").on(table.targetEntity, table.targetId),
    index("source_records_job_idx").on(table.importJobId),
  ],
);

export const fieldVisitPaddocks = sqliteTable(
  "field_visit_paddocks",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    visitId: text("visit_id")
      .notNull()
      .references(() => fieldVisits.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    importRowId: text("import_row_id")
      .notNull()
      .references(() => importRows.id),
    sequenceNumber: integer("sequence_number").notNull(),
    externalPaddockKey: text("external_paddock_key").notNull(),
    paddockId: text("paddock_id").references(() => paddocks.id, { onDelete: "set null" }),
    observedAt: text("observed_at"),
    plannedEntryDate: text("planned_entry_date"),
    currentBiomassKgDmHa: real("current_biomass_kg_dm_ha"),
    projectedBiomassKgDmHa: real("projected_biomass_kg_dm_ha"),
    areaHa: real("area_ha"),
    dailyAreaHa: real("daily_area_ha"),
    calculatedDays: real("calculated_days"),
    adjustedDays: real("adjusted_days"),
    adjustedIntakeKgDmCowDay: real("adjusted_intake_kg_dm_cow_day"),
    notes: text("notes"),
    snapshotJson: text("snapshot_json", { mode: "json" }).$type<ImportRecord>().notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("field_visit_paddocks_visit_sequence_unique").on(table.visitId, table.sequenceNumber),
    uniqueIndex("field_visit_paddocks_import_row_unique").on(table.importRowId),
    index("field_visit_paddocks_field_external_idx").on(table.fieldId, table.externalPaddockKey, table.observedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.visitId],
      foreignColumns: [fieldVisits.organizationId, fieldVisits.fieldId, fieldVisits.id],
      name: "field_visit_paddocks_scope_visit_fk",
    }),
    foreignKey({
      columns: [table.importJobId, table.importRowId],
      foreignColumns: [importRows.importJobId, importRows.id],
      name: "field_visit_paddocks_job_row_fk",
    }),
    foreignKey({
      columns: [table.fieldId, table.paddockId],
      foreignColumns: [paddocks.fieldId, paddocks.id],
      name: "field_visit_paddocks_field_paddock_fk",
    }),
    check("field_visit_paddocks_sequence_check", sql`${table.sequenceNumber} > 0`),
    check("field_visit_paddocks_external_key_check", sql`length(trim(${table.externalPaddockKey})) > 0`),
    check("field_visit_paddocks_observed_date_check", sql`${table.observedAt} IS NULL OR ${table.observedAt} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("field_visit_paddocks_planned_date_check", sql`${table.plannedEntryDate} IS NULL OR ${table.plannedEntryDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("field_visit_paddocks_biomass_check", sql`(${table.currentBiomassKgDmHa} IS NOT NULL AND ${table.currentBiomassKgDmHa} >= 0) OR (${table.projectedBiomassKgDmHa} IS NOT NULL AND ${table.projectedBiomassKgDmHa} >= 0)`),
    check("field_visit_paddocks_positive_values_check", sql`
      (${table.areaHa} IS NULL OR ${table.areaHa} > 0)
      AND (${table.dailyAreaHa} IS NULL OR ${table.dailyAreaHa} > 0)
      AND (${table.calculatedDays} IS NULL OR ${table.calculatedDays} > 0)
      AND (${table.adjustedDays} IS NULL OR ${table.adjustedDays} > 0)
      AND (${table.adjustedIntakeKgDmCowDay} IS NULL OR ${table.adjustedIntakeKgDmCowDay} > 0)
    `),
    check("field_visit_paddocks_snapshot_check", sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`),
  ],
);

export const fieldVisitRecommendations = sqliteTable(
  "field_visit_recommendations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    visitId: text("visit_id")
      .notNull()
      .references(() => fieldVisits.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    importRowId: text("import_row_id")
      .notNull()
      .references(() => importRows.id),
    sequenceNumber: integer("sequence_number").notNull(),
    actionGroupNumber: integer("action_group_number").notNull(),
    externalPaddockKey: text("external_paddock_key").notNull(),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    visitDate: text("visit_date").notNull(),
    actionHeading: text("action_heading").notNull(),
    recommendationText: text("recommendation_text").notNull(),
    reportedGroupAreaHa: real("reported_group_area_ha"),
    snapshotJson: text("snapshot_json", { mode: "json" }).$type<ImportRecord>().notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("field_visit_recommendations_visit_sequence_unique").on(table.visitId, table.sequenceNumber),
    uniqueIndex("field_visit_recommendations_import_row_unique").on(table.importRowId),
    index("field_visit_recommendations_paddock_date_idx").on(table.fieldId, table.paddockId, table.visitDate),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.visitId],
      foreignColumns: [fieldVisits.organizationId, fieldVisits.fieldId, fieldVisits.id],
      name: "field_visit_recommendations_scope_visit_fk",
    }),
    foreignKey({
      columns: [table.importJobId, table.importRowId],
      foreignColumns: [importRows.importJobId, importRows.id],
      name: "field_visit_recommendations_job_row_fk",
    }),
    foreignKey({
      columns: [table.fieldId, table.paddockId],
      foreignColumns: [paddocks.fieldId, paddocks.id],
      name: "field_visit_recommendations_field_paddock_fk",
    }),
    check("field_visit_recommendations_sequence_check", sql`${table.sequenceNumber} > 0 AND ${table.actionGroupNumber} > 0`),
    check("field_visit_recommendations_external_key_check", sql`length(trim(${table.externalPaddockKey})) BETWEEN 1 AND 80`),
    check("field_visit_recommendations_visit_date_check", sql`${table.visitDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    check("field_visit_recommendations_text_check", sql`
      length(trim(${table.actionHeading})) BETWEEN 3 AND 500
      AND length(trim(${table.recommendationText})) BETWEEN 3 AND 8000
    `),
    check("field_visit_recommendations_area_check", sql`${table.reportedGroupAreaHa} IS NULL OR ${table.reportedGroupAreaHa} > 0`),
    check("field_visit_recommendations_snapshot_check", sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`),
  ],
);

export const soilAnalysisReports = sqliteTable(
  "soil_analysis_reports",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    providerKey: text("provider_key").notNull(),
    profileKey: text("profile_key").notNull(),
    profileVersion: text("profile_version").notNull(),
    folio: text("folio").notNull(),
    sampleId: text("sample_id").notNull(),
    receivedDate: text("received_date").notNull(),
    reportDate: text("report_date").notNull(),
    analysisType: text("analysis_type").notNull(),
    sampledBy: text("sampled_by"),
    reportedSamplingDepthCm: real("reported_sampling_depth_cm"),
    idealRangeReferenceDepthCm: real("ideal_range_reference_depth_cm"),
    analyticalMethodsText: text("analytical_methods_text").notNull(),
    accreditationClaimStatus: text("accreditation_claim_status")
      .$type<"reported_unverified" | "not_reported">()
      .notNull(),
    signatureStatus: text("signature_status")
      .$type<"not_checked" | "present_unverified" | "verified" | "absent">()
      .notNull(),
    qrStatus: text("qr_status")
      .$type<"not_checked" | "present_unverified" | "verified" | "absent">()
      .notNull(),
    documentaryUse: text("documentary_use").$type<"technical_result_only">().notNull(),
    snapshotJson: text("snapshot_json", { mode: "json" }).$type<CooprinsemSoilReportDocument>().notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("soil_analysis_reports_import_job_unique").on(table.importJobId),
    uniqueIndex("soil_analysis_reports_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("soil_analysis_reports_field_folio_unique").on(
      table.organizationId,
      table.fieldId,
      table.providerKey,
      table.folio,
    ),
    index("soil_analysis_reports_paddock_date_idx").on(table.fieldId, table.paddockId, table.reportDate),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "soil_analysis_reports_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.importJobId],
      foreignColumns: [importJobs.organizationId, importJobs.fieldId, importJobs.id],
      name: "soil_analysis_reports_scope_job_fk",
    }),
    foreignKey({
      columns: [table.fieldId, table.paddockId],
      foreignColumns: [paddocks.fieldId, paddocks.id],
      name: "soil_analysis_reports_field_paddock_fk",
    }),
    check("soil_analysis_reports_provider_check", sql`${table.providerKey} = 'cooprinsem'`),
    check("soil_analysis_reports_profile_check", sql`length(trim(${table.profileKey})) > 0 AND length(trim(${table.profileVersion})) > 0`),
    check("soil_analysis_reports_identity_check", sql`length(trim(${table.folio})) BETWEEN 3 AND 80 AND length(trim(${table.sampleId})) BETWEEN 1 AND 80`),
    check("soil_analysis_reports_dates_check", sql`
      ${table.receivedDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND ${table.reportDate} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND ${table.receivedDate} <= ${table.reportDate}
    `),
    check("soil_analysis_reports_depth_check", sql`
      (${table.reportedSamplingDepthCm} IS NULL OR ${table.reportedSamplingDepthCm} BETWEEN 0.1 AND 200)
      AND (${table.idealRangeReferenceDepthCm} IS NULL OR ${table.idealRangeReferenceDepthCm} BETWEEN 0.1 AND 200)
    `),
    check("soil_analysis_reports_methods_check", sql`length(trim(${table.analyticalMethodsText})) BETWEEN 80 AND 8000`),
    check("soil_analysis_reports_accreditation_check", sql`${table.accreditationClaimStatus} IN ('reported_unverified', 'not_reported')`),
    check("soil_analysis_reports_signature_check", sql`${table.signatureStatus} IN ('not_checked', 'present_unverified', 'verified', 'absent')`),
    check("soil_analysis_reports_qr_check", sql`${table.qrStatus} IN ('not_checked', 'present_unverified', 'verified', 'absent')`),
    check("soil_analysis_reports_use_check", sql`${table.documentaryUse} = 'technical_result_only'`),
    check("soil_analysis_reports_snapshot_check", sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`),
  ],
);

export const soilAnalysisResults = sqliteTable(
  "soil_analysis_results",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    reportId: text("report_id")
      .notNull()
      .references(() => soilAnalysisReports.id, { onDelete: "cascade" }),
    importJobId: text("import_job_id")
      .notNull()
      .references(() => importJobs.id),
    importRowId: text("import_row_id")
      .notNull()
      .references(() => importRows.id),
    sequenceNumber: integer("sequence_number").notNull(),
    analyteCode: text("analyte_code").notNull(),
    analyteName: text("analyte_name").notNull(),
    unit: text("unit").notNull(),
    value: real("value").notNull(),
    idealMin: real("ideal_min").notNull(),
    idealMax: real("ideal_max").notNull(),
    idealRangeText: text("ideal_range_text").notNull(),
    reportedClassification: text("reported_classification"),
    rangeAssessment: text("range_assessment").$type<SoilAnalysisRangeAssessment>().notNull(),
    methodKey: text("method_key"),
    methodLabel: text("method_label"),
    snapshotJson: text("snapshot_json", { mode: "json" }).$type<ImportRecord>().notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("soil_analysis_results_report_sequence_unique").on(table.reportId, table.sequenceNumber),
    uniqueIndex("soil_analysis_results_report_analyte_unique").on(table.reportId, table.analyteCode),
    uniqueIndex("soil_analysis_results_import_row_unique").on(table.importRowId),
    index("soil_analysis_results_field_analyte_idx").on(table.fieldId, table.analyteCode, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.reportId],
      foreignColumns: [
        soilAnalysisReports.organizationId,
        soilAnalysisReports.fieldId,
        soilAnalysisReports.id,
      ],
      name: "soil_analysis_results_scope_report_fk",
    }),
    foreignKey({
      columns: [table.importJobId, table.importRowId],
      foreignColumns: [importRows.importJobId, importRows.id],
      name: "soil_analysis_results_job_row_fk",
    }),
    check("soil_analysis_results_sequence_check", sql`${table.sequenceNumber} > 0`),
    check("soil_analysis_results_identity_check", sql`
      length(trim(${table.analyteCode})) BETWEEN 1 AND 80
      AND length(trim(${table.analyteName})) BETWEEN 1 AND 120
      AND length(trim(${table.unit})) BETWEEN 1 AND 40
    `),
    check("soil_analysis_results_range_check", sql`${table.idealMin} <= ${table.idealMax}`),
    check("soil_analysis_results_assessment_check", sql`${table.rangeAssessment} IN ('below', 'within', 'above')`),
    check("soil_analysis_results_method_check", sql`
      (${table.methodKey} IS NULL AND ${table.methodLabel} IS NULL)
      OR (
        length(trim(${table.methodKey})) BETWEEN 1 AND 120
        AND length(trim(${table.methodLabel})) BETWEEN 1 AND 240
      )
    `),
    check("soil_analysis_results_snapshot_check", sql`json_valid(${table.snapshotJson}) AND json_type(${table.snapshotJson}) = 'object'`),
  ],
);

export const cooprinsemHistoryUnitContracts = sqliteTable(
  "cooprinsem_history_unit_contracts",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    sourceSystem: text("source_system").notNull().default("cooprinsem"),
    contractVersion: text("contract_version").notNull(),
    canonicalUnit: text("canonical_unit").$type<"liters">().notNull(),
    sourceFields: text("source_fields", { mode: "json" }).$type<string[]>().notNull(),
    evidenceSha256: text("evidence_sha256").notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("cooprinsem_history_unit_contracts_field_version_unique").on(table.fieldId, table.contractVersion),
    index("cooprinsem_history_unit_contracts_organization_idx").on(table.organizationId, table.confirmedAt),
    check("cooprinsem_history_unit_contracts_source_check", sql`${table.sourceSystem} = 'cooprinsem'`),
    check("cooprinsem_history_unit_contracts_unit_check", sql`${table.canonicalUnit} = 'liters'`),
    check(
      "cooprinsem_history_unit_contracts_evidence_check",
      sql`length(${table.evidenceSha256}) = 64 AND ${table.evidenceSha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
  ],
);

export const milkBulkProduction = sqliteTable(
  "milk_bulk_production",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    recordedAt: text("recorded_at").notNull(),
    kind: text("kind").$type<MilkBulkProductionKind>().notNull().default("tank_total"),
    volumeLiters: real("volume_liters").notNull(),
    source: text("source").$type<MilkBulkProductionSource>().notNull().default("manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("milk_bulk_production_field_recorded_source_unique").on(
      table.fieldId,
      table.recordedAt,
      table.kind,
      table.source,
    ),
    uniqueIndex("milk_bulk_production_source_record_unique")
      .on(table.fieldId, table.source, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} IS NOT NULL`),
    index("milk_bulk_production_field_recorded_idx").on(table.fieldId, table.recordedAt),
    index("milk_bulk_production_organization_recorded_idx").on(table.organizationId, table.recordedAt),
    check("milk_bulk_production_kind_check", sql`${table.kind} IN ('tank_total', 'delivery', 'milk_meter_rollup')`),
    check("milk_bulk_production_volume_check", sql`${table.volumeLiters} > 0`),
    check("milk_bulk_production_source_check", sql`${table.source} IN ('manual', 'cooprinsem_clo', 'equipment')`),
  ],
);

export const milkQualitySamples = sqliteTable(
  "milk_quality_samples",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    sampledAt: text("sampled_at").notNull(),
    period: text("period").notNull(),
    kind: text("kind").$type<MilkQualitySampleKind>().notNull().default("bulk_tank"),
    fatPercent: real("fat_percent"),
    proteinPercent: real("protein_percent"),
    totalSolidsPercent: real("total_solids_percent"),
    somaticCellCount: integer("somatic_cell_count"),
    somaticCellCountUnit: text("somatic_cell_count_unit").$type<MilkSomaticCellCountUnit>(),
    bacterialCount: integer("bacterial_count"),
    bacterialCountUnit: text("bacterial_count_unit").$type<MilkBacterialCountUnit>(),
    sanitaryFlags: text("sanitary_flags", { mode: "json" }).$type<MilkQualitySanitaryFlags>().notNull().default(sql`'{}'`),
    source: text("source").$type<MilkQualitySampleSource>().notNull().default("manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("milk_quality_samples_field_sampled_source_unique").on(
      table.fieldId,
      table.sampledAt,
      table.kind,
      table.source,
    ),
    uniqueIndex("milk_quality_samples_source_record_unique")
      .on(table.fieldId, table.source, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} IS NOT NULL`),
    index("milk_quality_samples_field_sampled_idx").on(table.fieldId, table.sampledAt),
    index("milk_quality_samples_field_period_idx").on(table.fieldId, table.period),
    index("milk_quality_samples_organization_sampled_idx").on(table.organizationId, table.sampledAt),
    check("milk_quality_samples_kind_check", sql`${table.kind} IN ('bulk_tank', 'settlement', 'laboratory')`),
    check(
      "milk_quality_samples_period_check",
      sql`length(${table.period}) = 7 AND ${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(${table.period}, 6, 2) BETWEEN '01' AND '12'`,
    ),
    check("milk_quality_samples_fat_check", sql`${table.fatPercent} IS NULL OR (${table.fatPercent} >= 0 AND ${table.fatPercent} <= 15)`),
    check("milk_quality_samples_protein_check", sql`${table.proteinPercent} IS NULL OR (${table.proteinPercent} >= 0 AND ${table.proteinPercent} <= 15)`),
    check("milk_quality_samples_solids_check", sql`${table.totalSolidsPercent} IS NULL OR (${table.totalSolidsPercent} >= 0 AND ${table.totalSolidsPercent} <= 100)`),
    check(
      "milk_quality_samples_somatic_count_check",
      sql`(${table.somaticCellCount} IS NULL AND ${table.somaticCellCountUnit} IS NULL) OR (${table.somaticCellCount} IS NOT NULL AND ${table.somaticCellCount} >= 0 AND ${table.somaticCellCountUnit} IS NOT NULL AND ${table.somaticCellCountUnit} IN ('cells_per_ml', 'thousand_cells_per_ml'))`,
    ),
    check(
      "milk_quality_samples_bacterial_count_check",
      sql`(${table.bacterialCount} IS NULL AND ${table.bacterialCountUnit} IS NULL) OR (${table.bacterialCount} IS NOT NULL AND ${table.bacterialCount} >= 0 AND ${table.bacterialCountUnit} IS NOT NULL AND ${table.bacterialCountUnit} IN ('cfu_per_ml', 'thousand_cfu_per_ml'))`,
    ),
    check("milk_quality_samples_sanitary_flags_check", sql`json_valid(${table.sanitaryFlags})`),
    check(
      "milk_quality_samples_measurement_check",
      sql`${table.fatPercent} IS NOT NULL OR ${table.proteinPercent} IS NOT NULL OR ${table.totalSolidsPercent} IS NOT NULL OR ${table.somaticCellCount} IS NOT NULL OR ${table.bacterialCount} IS NOT NULL OR ${table.sanitaryFlags} <> '{}'`,
    ),
    check("milk_quality_samples_source_check", sql`${table.source} IN ('manual', 'settlement', 'cooprinsem_laboratory', 'equipment')`),
  ],
);

export const pabcoComplianceItems = sqliteTable(
  "pabco_compliance_items",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    requirement: text("requirement").$type<PabcoComplianceRequirement>().notNull(),
    status: text("status").$type<PabcoComplianceStatus>().notNull().default("pending"),
    evidenceDocumentId: text("evidence_document_id"),
    validFrom: text("valid_from"),
    validUntil: text("valid_until"),
    reminderAt: text("reminder_at"),
    source: text("source").$type<PabcoComplianceSource>().notNull().default("manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("pabco_compliance_items_field_requirement_unique").on(table.fieldId, table.requirement),
    uniqueIndex("pabco_compliance_items_source_record_unique")
      .on(table.fieldId, table.source, table.sourceRecordId)
      .where(sql`${table.sourceRecordId} IS NOT NULL`),
    index("pabco_compliance_items_field_status_idx").on(table.fieldId, table.status, table.validUntil),
    index("pabco_compliance_items_organization_status_idx").on(table.organizationId, table.status),
    index("pabco_compliance_items_reminder_idx").on(table.reminderAt, table.status),
    check(
      "pabco_compliance_items_requirement_check",
      sql`${table.requirement} IN ('veterinary_advisory', 'medicine_prescriptions', 'withdrawal_management', 'annual_water_analysis', 'animal_traceability')`,
    ),
    check("pabco_compliance_items_status_check", sql`${table.status} IN ('pending', 'compliant', 'expiring', 'expired', 'not_applicable')`),
    check("pabco_compliance_items_source_check", sql`${table.source} IN ('manual', 'sag', 'cooprinsem')`),
    check("pabco_compliance_items_validity_check", sql`${table.validUntil} IS NULL OR ${table.validFrom} IS NULL OR ${table.validUntil} >= ${table.validFrom}`),
    check("pabco_compliance_items_reminder_check", sql`${table.reminderAt} IS NULL OR ${table.validUntil} IS NULL OR ${table.reminderAt} <= ${table.validUntil}`),
  ],
);

export const pabcoEvidenceDocuments = sqliteTable(
  "pabco_evidence_documents",
  {
    id: text("id").primaryKey(),
    objectKey: text("object_key").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    etag: text("etag"),
    status: text("status")
      .$type<"pending" | "stored" | "compensation_pending">()
      .notNull()
      .default("pending"),
    requestedBy: text("requested_by").notNull(),
    compensationAttempts: integer("compensation_attempts").notNull().default(0),
    lastError: text("last_error"),
    nextRetryAt: text("next_retry_at"),
    storedAt: text("stored_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("pabco_evidence_documents_object_key_unique").on(table.objectKey),
    index("pabco_evidence_documents_field_status_idx").on(table.fieldId, table.status),
    index("pabco_evidence_documents_retry_idx").on(table.status, table.nextRetryAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "pabco_evidence_documents_organization_field_fk",
    }),
    check("pabco_evidence_documents_size_check", sql`${table.sizeBytes} > 0 AND ${table.sizeBytes} <= 10485760`),
    check("pabco_evidence_documents_sha256_check", sql`length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`),
    check("pabco_evidence_documents_status_check", sql`${table.status} IN ('pending', 'stored', 'compensation_pending')`),
    check(
      "pabco_evidence_documents_storage_check",
      sql`(${table.status} = 'pending' AND ${table.etag} IS NULL AND ${table.storedAt} IS NULL)
        OR (${table.status} IN ('stored', 'compensation_pending') AND ${table.etag} IS NOT NULL)`,
    ),
    check("pabco_evidence_documents_compensation_check", sql`${table.compensationAttempts} >= 0`),
  ],
);

export const livestockLactations = sqliteTable(
  "livestock_lactations",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    animalId: text("animal_id")
      .notNull()
      .references(() => livestockAnimals.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    calvingDate: text("calving_date"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    status: text("status").$type<LivestockLactationStatus>().notNull().default("active"),
    dryOffReason: text("dry_off_reason"),
    source: text("source").notNull().default("Registro manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_lactations_animal_sequence_unique").on(table.animalId, table.sequenceNumber),
    uniqueIndex("livestock_lactations_one_active_unique")
      .on(table.animalId)
      .where(sql`${table.status} = 'active'`),
    index("livestock_lactations_field_status_idx").on(table.fieldId, table.status),
    index("livestock_lactations_animal_dates_idx").on(table.animalId, table.startedAt),
    check("livestock_lactations_sequence_check", sql`${table.sequenceNumber} > 0`),
    check("livestock_lactations_dates_check", sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`),
  ],
);

export const livestockMilkControls = sqliteTable(
  "livestock_milk_controls",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    animalId: text("animal_id")
      .notNull()
      .references(() => livestockAnimals.id, { onDelete: "cascade" }),
    lactationId: text("lactation_id").references(() => livestockLactations.id, { onDelete: "set null" }),
    controlDate: text("control_date").notNull(),
    morningLiters: real("morning_liters"),
    afternoonLiters: real("afternoon_liters"),
    thirdMilkingLiters: real("third_milking_liters"),
    totalLiters: real("total_liters").notNull(),
    fatPct: real("fat_pct"),
    proteinPct: real("protein_pct"),
    somaticCellCount: integer("somatic_cell_count"),
    notes: text("notes").notNull().default(""),
    source: text("source").notNull().default("Registro manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_milk_controls_animal_date_unique").on(table.animalId, table.controlDate),
    index("livestock_milk_controls_field_date_idx").on(table.fieldId, table.controlDate),
    index("livestock_milk_controls_lactation_date_idx").on(table.lactationId, table.controlDate),
    check("livestock_milk_controls_total_check", sql`${table.totalLiters} > 0`),
    check("livestock_milk_controls_morning_check", sql`${table.morningLiters} IS NULL OR ${table.morningLiters} >= 0`),
    check("livestock_milk_controls_afternoon_check", sql`${table.afternoonLiters} IS NULL OR ${table.afternoonLiters} >= 0`),
    check("livestock_milk_controls_third_check", sql`${table.thirdMilkingLiters} IS NULL OR ${table.thirdMilkingLiters} >= 0`),
    check("livestock_milk_controls_fat_check", sql`${table.fatPct} IS NULL OR (${table.fatPct} >= 0 AND ${table.fatPct} <= 15)`),
    check("livestock_milk_controls_protein_check", sql`${table.proteinPct} IS NULL OR (${table.proteinPct} >= 0 AND ${table.proteinPct} <= 15)`),
    check("livestock_milk_controls_scc_check", sql`${table.somaticCellCount} IS NULL OR ${table.somaticCellCount} >= 0`),
  ],
);

export const livestockReproductiveEvents = sqliteTable(
  "livestock_reproductive_events",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    animalId: text("animal_id")
      .notNull()
      .references(() => livestockAnimals.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<LivestockReproductiveEventType>().notNull(),
    occurredAt: text("occurred_at").notNull(),
    method: text("method"),
    result: text("result"),
    sireIdentifier: text("sire_identifier"),
    sireAnimalId: text("sire_animal_id").references(() => livestockAnimals.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    metadata: text("metadata", { mode: "json" }).$type<ImportRecord>().notNull().default(sql`'{}'`),
    source: text("source").notNull().default("Registro manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_reproductive_events_field_date_idx").on(table.fieldId, table.occurredAt),
    index("livestock_reproductive_events_animal_date_idx").on(table.animalId, table.occurredAt),
    index("livestock_reproductive_events_type_idx").on(table.eventType),
    check(
      "livestock_reproductive_events_type_check",
      sql`${table.eventType} IN ('heat', 'service', 'insemination', 'pregnancy_diagnosis', 'calving', 'dry_off', 'abortion')`,
    ),
  ],
);

export const livestockBirths = sqliteTable(
  "livestock_births",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id").notNull().references(() => fields.id),
    damAnimalId: text("dam_animal_id").notNull().references(() => livestockAnimals.id, { onDelete: "cascade" }),
    reproductiveEventId: text("reproductive_event_id").references(() => livestockReproductiveEvents.id, { onDelete: "set null" }),
    occurredAt: text("occurred_at").notNull(),
    calvingType: text("calving_type").$type<LivestockCalvingType>().notNull().default("unknown"),
    difficulty: text("difficulty").$type<LivestockCalvingDifficulty>().notNull().default("unknown"),
    outcome: text("outcome").$type<LivestockBirthOutcome>().notNull().default("unknown"),
    sireIdentifier: text("sire_identifier"),
    sireAnimalId: text("sire_animal_id").references(() => livestockAnimals.id, { onDelete: "set null" }),
    notes: text("notes").notNull().default(""),
    source: text("source").notNull().default("Registro manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_births_dam_date_unique").on(table.damAnimalId, table.occurredAt),
    index("livestock_births_field_date_idx").on(table.fieldId, table.occurredAt),
    index("livestock_births_dam_date_idx").on(table.damAnimalId, table.occurredAt),
    check("livestock_births_calving_type_check", sql`${table.calvingType} IN ('single', 'twin', 'multiple', 'unknown')`),
    check("livestock_births_difficulty_check", sql`${table.difficulty} IN ('unassisted', 'assisted', 'dystocia', 'unknown')`),
    check("livestock_births_outcome_check", sql`${table.outcome} IN ('live', 'mixed', 'stillbirth', 'unknown')`),
  ],
);

export const livestockBirthOffspring = sqliteTable(
  "livestock_birth_offspring",
  {
    id: text("id").primaryKey(),
    birthId: text("birth_id").notNull().references(() => livestockBirths.id, { onDelete: "cascade" }),
    animalId: text("animal_id").references(() => livestockAnimals.id, { onDelete: "set null" }),
    temporaryIdentifier: text("temporary_identifier").notNull(),
    sex: text("sex").$type<LivestockSex>().notNull().default("unknown"),
    outcome: text("outcome").$type<LivestockOffspringOutcome>().notNull().default("unknown"),
    birthWeightKg: real("birth_weight_kg"),
    notes: text("notes").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_birth_offspring_identifier_unique").on(table.birthId, table.temporaryIdentifier),
    index("livestock_birth_offspring_animal_idx").on(table.animalId),
    check("livestock_birth_offspring_sex_check", sql`${table.sex} IN ('female', 'male', 'unknown')`),
    check("livestock_birth_offspring_outcome_check", sql`${table.outcome} IN ('alive', 'stillborn', 'deceased', 'unknown')`),
    check("livestock_birth_offspring_weight_check", sql`${table.birthWeightKg} IS NULL OR ${table.birthWeightKg} > 0`),
  ],
);

export const livestockHealthEvents = sqliteTable(
  "livestock_health_events",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id").notNull().references(() => fields.id),
    animalId: text("animal_id").notNull().references(() => livestockAnimals.id, { onDelete: "cascade" }),
    eventType: text("event_type").$type<LivestockHealthEventType>().notNull(),
    occurredAt: text("occurred_at").notNull(),
    status: text("status").$type<LivestockHealthEventStatus>().notNull().default("completed"),
    condition: text("condition"),
    productName: text("product_name"),
    activeIngredient: text("active_ingredient"),
    doseAmount: real("dose_amount"),
    doseUnit: text("dose_unit"),
    route: text("route"),
    withdrawalMilkUntil: text("withdrawal_milk_until"),
    withdrawalMeatUntil: text("withdrawal_meat_until"),
    professional: text("professional"),
    notes: text("notes").notNull().default(""),
    metadata: text("metadata", { mode: "json" }).$type<ImportRecord>().notNull().default(sql`'{}'`),
    source: text("source").notNull().default("Registro manual"),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("livestock_health_events_field_date_idx").on(table.fieldId, table.occurredAt),
    index("livestock_health_events_animal_date_idx").on(table.animalId, table.occurredAt),
    index("livestock_health_events_status_idx").on(table.status),
    check("livestock_health_events_type_check", sql`${table.eventType} IN ('observation', 'diagnosis', 'treatment', 'vaccination', 'withdrawal_clearance')`),
    check("livestock_health_events_status_check", sql`${table.status} IN ('open', 'completed', 'cancelled')`),
    check("livestock_health_events_dose_check", sql`${table.doseAmount} IS NULL OR ${table.doseAmount} >= 0`),
    check("livestock_health_events_milk_withdrawal_check", sql`${table.withdrawalMilkUntil} IS NULL OR ${table.withdrawalMilkUntil} >= ${table.occurredAt}`),
    check("livestock_health_events_meat_withdrawal_check", sql`${table.withdrawalMeatUntil} IS NULL OR ${table.withdrawalMeatUntil} >= ${table.occurredAt}`),
  ],
);

export const fieldExternalIdentifiers = sqliteTable(
  "field_external_identifiers",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    sourceSystem: text("source_system").notNull().default("cooprinsem"),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("field_external_identifiers_one_active_unique")
      .on(table.organizationId, table.sourceSystem, table.kind, table.normalizedValue)
      .where(sql`${table.validTo} IS NULL`),
    index("field_external_identifiers_lookup_idx").on(
      table.organizationId,
      table.sourceSystem,
      table.kind,
      table.normalizedValue,
    ),
    index("field_external_identifiers_field_idx").on(table.fieldId),
    check("field_external_identifiers_validity_check", sql`${table.validTo} IS NULL OR ${table.validFrom} IS NULL OR ${table.validTo} >= ${table.validFrom}`),
  ],
);

export const livestockLotExternalIdentifiers = sqliteTable(
  "livestock_lot_external_identifiers",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    lotId: text("lot_id")
      .notNull()
      .references(() => livestockLots.id),
    sourceSystem: text("source_system").notNull().default("cooprinsem"),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_lot_external_identifiers_one_active_unique")
      .on(table.fieldId, table.sourceSystem, table.kind, table.normalizedValue)
      .where(sql`${table.validTo} IS NULL`),
    index("livestock_lot_external_identifiers_lookup_idx").on(
      table.fieldId,
      table.sourceSystem,
      table.kind,
      table.normalizedValue,
    ),
    index("livestock_lot_external_identifiers_lot_idx").on(table.lotId),
    check("livestock_lot_external_identifiers_validity_check", sql`${table.validTo} IS NULL OR ${table.validFrom} IS NULL OR ${table.validTo} >= ${table.validFrom}`),
  ],
);

export const livestockAnimalIdentifiers = sqliteTable(
  "livestock_animal_identifiers",
  {
    id: text("id").primaryKey(),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    animalId: text("animal_id")
      .notNull()
      .references(() => livestockAnimals.id),
    sourceSystem: text("source_system").notNull().default("cooprinsem"),
    kind: text("kind").notNull(),
    value: text("value").notNull(),
    normalizedValue: text("normalized_value").notNull(),
    validFrom: text("valid_from"),
    validTo: text("valid_to"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_animal_identifiers_one_active_unique")
      .on(table.fieldId, table.sourceSystem, table.kind, table.normalizedValue)
      .where(sql`${table.validTo} IS NULL`),
    index("livestock_animal_identifiers_lookup_idx").on(
      table.fieldId,
      table.sourceSystem,
      table.kind,
      table.normalizedValue,
    ),
    index("livestock_animal_identifiers_animal_idx").on(table.animalId),
    check("livestock_animal_identifiers_validity_check", sql`${table.validTo} IS NULL OR ${table.validFrom} IS NULL OR ${table.validTo} >= ${table.validFrom}`),
  ],
);

export const livestockLotMemberships = sqliteTable(
  "livestock_lot_memberships",
  {
    id: text("id").primaryKey(),
    animalId: text("animal_id")
      .notNull()
      .references(() => livestockAnimals.id),
    lotId: text("lot_id")
      .notNull()
      .references(() => livestockLots.id),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    sourceSystem: text("source_system").notNull().default("manual"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("livestock_lot_memberships_one_active_unique")
      .on(table.animalId)
      .where(sql`${table.endedAt} IS NULL`),
    index("livestock_lot_memberships_animal_dates_idx").on(table.animalId, table.startedAt),
    index("livestock_lot_memberships_lot_dates_idx").on(table.lotId, table.startedAt),
    check("livestock_lot_memberships_dates_check", sql`${table.endedAt} IS NULL OR ${table.endedAt} >= ${table.startedAt}`),
  ],
);

export const traceabilityEstablishments = sqliteTable(
  "traceability_establishments",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    rup: text("rup").notNull(),
    normalizedRup: text("normalized_rup").notNull(),
    kind: text("kind").$type<EstablishmentType>().notNull().default("dairy"),
    status: text("status").$type<EstablishmentStatus>().notNull().default("active"),
    georef: text("georef", { mode: "json" }).$type<ImportRecord>(),
    holderRut: text("holder_rut").notNull(),
    holderName: text("holder_name").notNull(),
    commune: text("commune").notNull(),
    address: text("address").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("traceability_establishments_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("traceability_establishments_rup_unique").on(table.organizationId, table.normalizedRup),
    uniqueIndex("traceability_establishments_active_field_unique")
      .on(table.organizationId, table.fieldId)
      .where(sql`${table.status} = 'active'`),
    index("traceability_establishments_scope_status_idx").on(table.organizationId, table.fieldId, table.status),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_establishments_organization_field_fk",
    }),
    check("traceability_establishments_rup_check", sql`length(${table.normalizedRup}) BETWEEN 4 AND 32 AND ${table.normalizedRup} NOT GLOB '*[^0-9A-Z.-]*'`),
    check("traceability_establishments_kind_check", sql`${table.kind} IN ('dairy', 'beef', 'mixed', 'other')`),
    check("traceability_establishments_status_check", sql`${table.status} IN ('active', 'inactive')`),
    check("traceability_establishments_georef_check", sql`${table.georef} IS NULL OR (json_valid(${table.georef}) AND json_type(${table.georef}) = 'object')`),
    check("traceability_establishments_holder_check", sql`length(trim(${table.holderRut})) BETWEEN 9 AND 16 AND length(trim(${table.holderName})) BETWEEN 2 AND 200`),
    check("traceability_establishments_location_check", sql`length(trim(${table.commune})) BETWEEN 2 AND 120 AND length(trim(${table.address})) BETWEEN 2 AND 300`),
    check("traceability_establishments_version_check", sql`${table.version} >= 1`),
  ],
);

export const traceabilityDiios = sqliteTable(
  "traceability_diios",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    establishmentId: text("establishment_id").notNull(),
    officialNumber: text("official_number").notNull(),
    normalizedNumber: text("normalized_number").notNull(),
    deviceType: text("device_type").$type<DiioDeviceType>().notNull(),
    rfidId: text("rfid_id"),
    animalId: text("animal_id").references(() => livestockAnimals.id, { onDelete: "restrict" }),
    status: text("status").$type<DiioStatus>().notNull().default("available"),
    assignedAt: text("assigned_at"),
    endedAt: text("ended_at"),
    replacesDeviceId: text("replaces_device_id"),
    replacedByDeviceId: text("replaced_by_device_id"),
    lastTransitionKey: text("last_transition_key"),
    effectiveAt: text("effective_at").notNull(),
    replacementForId: text("replacement_for_id"),
    statusReason: text("status_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("traceability_diios_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("traceability_diios_number_unique").on(table.organizationId, table.normalizedNumber),
    uniqueIndex("traceability_diios_active_animal_unique")
      .on(table.organizationId, table.animalId)
      .where(sql`${table.status} = 'assigned' AND ${table.animalId} IS NOT NULL`),
    uniqueIndex("traceability_diios_active_rfid_unique")
      .on(table.organizationId, table.rfidId)
      .where(sql`${table.status} = 'assigned' AND ${table.rfidId} IS NOT NULL`),
    index("traceability_diios_scope_status_idx").on(table.organizationId, table.fieldId, table.status),
    index("traceability_diios_establishment_status_idx").on(table.establishmentId, table.status),
    index("traceability_diios_animal_idx").on(table.animalId),
    index("traceability_diios_transition_key_idx").on(table.organizationId, table.fieldId, table.lastTransitionKey),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_diios_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.establishmentId],
      foreignColumns: [traceabilityEstablishments.organizationId, traceabilityEstablishments.fieldId, traceabilityEstablishments.id],
      name: "traceability_diios_establishment_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.replacesDeviceId],
      foreignColumns: [table.organizationId, table.fieldId, table.id],
      name: "traceability_diios_replaces_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.replacedByDeviceId],
      foreignColumns: [table.organizationId, table.fieldId, table.id],
      name: "traceability_diios_replaced_by_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.replacementForId],
      foreignColumns: [table.organizationId, table.fieldId, table.id],
      name: "traceability_diios_replacement_fk",
    }),
    check("traceability_diios_number_check", sql`length(${table.normalizedNumber}) = 9 AND ${table.normalizedNumber} NOT GLOB '*[^0-9]*'`),
    check("traceability_diios_device_check", sql`${table.deviceType} IN ('double_ear_tag', 'ear_button', 'ruminal_bolus')`),
    check("traceability_diios_status_check", sql`${table.status} IN ('available', 'assigned', 'lost', 'replaced', 'retired')`),
    check("traceability_diios_assignment_check", sql`(${table.status} = 'available' AND ${table.animalId} IS NULL AND ${table.assignedAt} IS NULL AND ${table.endedAt} IS NULL) OR (${table.status} = 'assigned' AND ${table.animalId} IS NOT NULL AND ${table.assignedAt} IS NOT NULL AND ${table.endedAt} IS NULL) OR (${table.status} IN ('lost', 'replaced', 'retired') AND ${table.endedAt} IS NOT NULL)`),
    check("traceability_diios_lineage_check", sql`(${table.replacesDeviceId} IS NULL OR ${table.replacesDeviceId} <> ${table.id}) AND (${table.replacedByDeviceId} IS NULL OR ${table.replacedByDeviceId} <> ${table.id})`),
    check("traceability_diios_version_check", sql`${table.version} >= 1`),
  ],
);

export const traceabilityMovements = sqliteTable(
  "traceability_movements",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    establishmentId: text("establishment_id").notNull(),
    originRup: text("origin_rup").notNull(),
    destinationRup: text("destination_rup").notNull(),
    departureAt: text("departure_at").notNull(),
    expectedArrivalAt: text("expected_arrival_at").notNull(),
    carrier: text("carrier").notNull(),
    carrierRut: text("carrier_rut").notNull(),
    vehiclePlate: text("vehicle_plate").notNull(),
    trailerPlate: text("trailer_plate"),
    reason: text("reason").notNull(),
    status: text("status").$type<TraceabilityMovementStatus>().notNull().default("draft"),
    folio: text("folio"),
    formVersion: text("form_version").notNull(),
    requestHash: text("request_hash").notNull(),
    documentObjectKey: text("document_object_key"),
    documentSha256: text("document_sha256"),
    documentEtag: text("document_etag"),
    documentSizeBytes: integer("document_size_bytes"),
    documentStatus: text("document_status").$type<TraceabilityDocumentStorageStatus>(),
    supersedesMovementId: text("supersedes_movement_id"),
    issuedAt: text("issued_at"),
    annulledAt: text("annulled_at"),
    annulmentReason: text("annulment_reason"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("traceability_movements_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("traceability_movements_request_unique").on(table.organizationId, table.fieldId, table.requestHash),
    uniqueIndex("traceability_movements_folio_unique")
      .on(table.organizationId, table.fieldId, table.folio)
      .where(sql`${table.folio} IS NOT NULL`),
    uniqueIndex("traceability_movements_document_key_unique")
      .on(table.documentObjectKey)
      .where(sql`${table.documentObjectKey} IS NOT NULL`),
    index("traceability_movements_scope_status_date_idx").on(table.organizationId, table.fieldId, table.status, table.departureAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_movements_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.establishmentId],
      foreignColumns: [traceabilityEstablishments.organizationId, traceabilityEstablishments.fieldId, traceabilityEstablishments.id],
      name: "traceability_movements_establishment_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.supersedesMovementId],
      foreignColumns: [table.organizationId, table.fieldId, table.id],
      name: "traceability_movements_supersedes_fk",
    }),
    check("traceability_movements_status_check", sql`${table.status} IN ('draft', 'issued', 'annulled')`),
    check("traceability_movements_dates_check", sql`${table.expectedArrivalAt} >= ${table.departureAt}`),
    check("traceability_movements_request_hash_check", sql`length(${table.requestHash}) = 64 AND ${table.requestHash} NOT GLOB '*[^0-9a-f]*'`),
    check("traceability_movements_document_hash_check", sql`${table.documentSha256} IS NULL OR (length(${table.documentSha256}) = 64 AND ${table.documentSha256} NOT GLOB '*[^0-9a-f]*')`),
    check("traceability_movements_document_size_check", sql`${table.documentSizeBytes} IS NULL OR ${table.documentSizeBytes} BETWEEN 1 AND 10485760`),
    check("traceability_movements_document_status_check", sql`${table.documentStatus} IS NULL OR ${table.documentStatus} IN ('pending', 'stored', 'compensation_pending')`),
    check("traceability_movements_issued_check", sql`${table.status} = 'draft' OR (${table.folio} IS NOT NULL AND ${table.issuedAt} IS NOT NULL AND ${table.documentStatus} = 'stored' AND ${table.documentObjectKey} IS NOT NULL AND ${table.documentSha256} IS NOT NULL)`),
    check("traceability_movements_annulled_check", sql`${table.status} <> 'annulled' OR (${table.annulledAt} IS NOT NULL AND length(trim(${table.annulmentReason})) > 0)`),
    check("traceability_movements_version_check", sql`${table.version} >= 1`),
  ],
);

export const traceabilityMovementItems = sqliteTable(
  "traceability_movement_items",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    movementId: text("movement_id").notNull(),
    diioId: text("diio_id").notNull(),
    animalId: text("animal_id").notNull().references(() => livestockAnimals.id, { onDelete: "restrict" }),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("traceability_movement_items_movement_diio_unique").on(table.movementId, table.diioId),
    index("traceability_movement_items_scope_movement_idx").on(table.organizationId, table.fieldId, table.movementId),
    index("traceability_movement_items_animal_idx").on(table.animalId),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_movement_items_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.movementId],
      foreignColumns: [traceabilityMovements.organizationId, traceabilityMovements.fieldId, traceabilityMovements.id],
      name: "traceability_movement_items_movement_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.diioId],
      foreignColumns: [traceabilityDiios.organizationId, traceabilityDiios.fieldId, traceabilityDiios.id],
      name: "traceability_movement_items_diio_fk",
    }),
  ],
);

export const traceabilityDeclarations = sqliteTable(
  "traceability_declarations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    establishmentId: text("establishment_id").notNull(),
    period: integer("period").notNull(),
    revision: integer("revision").notNull().default(1),
    asOfDate: text("as_of_date").notNull(),
    counts: text("counts", { mode: "json" }).$type<ImportRecord>().notNull(),
    totalAnimals: integer("total_animals").notNull(),
    inventoryHash: text("inventory_hash").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").$type<TraceabilityDeclarationStatus>().notNull().default("draft"),
    folio: text("folio"),
    formVersion: text("form_version").notNull(),
    documentObjectKey: text("document_object_key"),
    documentSha256: text("document_sha256"),
    documentEtag: text("document_etag"),
    documentSizeBytes: integer("document_size_bytes"),
    documentStatus: text("document_status").$type<TraceabilityDocumentStorageStatus>(),
    declaredAt: text("declared_at"),
    annulledAt: text("annulled_at"),
    annulmentReason: text("annulment_reason"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("traceability_declarations_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("traceability_declarations_revision_unique").on(table.organizationId, table.establishmentId, table.period, table.revision),
    uniqueIndex("traceability_declarations_request_unique").on(table.organizationId, table.fieldId, table.requestHash),
    uniqueIndex("traceability_declarations_document_key_unique")
      .on(table.documentObjectKey)
      .where(sql`${table.documentObjectKey} IS NOT NULL`),
    index("traceability_declarations_scope_period_idx").on(table.organizationId, table.fieldId, table.period, table.status),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_declarations_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.establishmentId],
      foreignColumns: [traceabilityEstablishments.organizationId, traceabilityEstablishments.fieldId, traceabilityEstablishments.id],
      name: "traceability_declarations_establishment_fk",
    }),
    check("traceability_declarations_period_check", sql`${table.period} BETWEEN 2000 AND 2100`),
    check("traceability_declarations_revision_check", sql`${table.revision} >= 1`),
    check("traceability_declarations_counts_check", sql`json_valid(${table.counts}) AND json_type(${table.counts}) = 'object'`),
    check("traceability_declarations_total_check", sql`${table.totalAnimals} >= 0`),
    check("traceability_declarations_hashes_check", sql`length(${table.inventoryHash}) = 64 AND ${table.inventoryHash} NOT GLOB '*[^0-9a-f]*' AND length(${table.requestHash}) = 64 AND ${table.requestHash} NOT GLOB '*[^0-9a-f]*'`),
    check("traceability_declarations_status_check", sql`${table.status} IN ('draft', 'declared', 'annulled')`),
    check("traceability_declarations_document_hash_check", sql`${table.documentSha256} IS NULL OR (length(${table.documentSha256}) = 64 AND ${table.documentSha256} NOT GLOB '*[^0-9a-f]*')`),
    check("traceability_declarations_document_size_check", sql`${table.documentSizeBytes} IS NULL OR ${table.documentSizeBytes} BETWEEN 1 AND 10485760`),
    check("traceability_declarations_document_status_check", sql`${table.documentStatus} IS NULL OR ${table.documentStatus} IN ('pending', 'stored', 'compensation_pending')`),
    check("traceability_declarations_declared_check", sql`${table.status} = 'draft' OR (${table.folio} IS NOT NULL AND ${table.declaredAt} IS NOT NULL AND ${table.documentStatus} = 'stored' AND ${table.documentObjectKey} IS NOT NULL AND ${table.documentSha256} IS NOT NULL)`),
    check("traceability_declarations_annulled_check", sql`${table.status} <> 'annulled' OR (${table.annulledAt} IS NOT NULL AND length(trim(${table.annulmentReason})) > 0)`),
    check("traceability_declarations_version_check", sql`${table.version} >= 1`),
  ],
);

export const traceabilityImportStages = sqliteTable(
  "traceability_import_stages",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    establishmentId: text("establishment_id").notNull(),
    sourceKind: text("source_kind").$type<TraceabilityImportSourceKind>().notNull(),
    canonicalStage: text("canonical_stage").notNull(),
    stageHash: text("stage_hash").notNull(),
    result: text("result", { mode: "json" }).$type<ImportRecord>().notNull(),
    status: text("status").$type<TraceabilityImportStageStatus>().notNull().default("staged"),
    rowCount: integer("row_count").notNull(),
    expiresAt: text("expires_at").notNull(),
    committedAt: text("committed_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("traceability_import_stages_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("traceability_import_stages_scope_hash_unique").on(table.organizationId, table.fieldId, table.stageHash),
    index("traceability_import_stages_scope_status_expiry_idx").on(table.organizationId, table.fieldId, table.status, table.expiresAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_import_stages_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.establishmentId],
      foreignColumns: [traceabilityEstablishments.organizationId, traceabilityEstablishments.fieldId, traceabilityEstablishments.id],
      name: "traceability_import_stages_establishment_fk",
    }),
    check("traceability_import_stages_source_check", sql`${table.sourceKind} IN ('sipec_file', 'cliex_dbf', 'manual_template')`),
    check("traceability_import_stages_stage_hash_check", sql`length(${table.stageHash}) = 64 AND ${table.stageHash} NOT GLOB '*[^0-9a-f]*'`),
    check("traceability_import_stages_result_check", sql`json_valid(${table.result}) AND json_type(${table.result}) = 'object'`),
    check("traceability_import_stages_status_check", sql`${table.status} IN ('staged', 'committed', 'expired')`),
    check("traceability_import_stages_row_count_check", sql`${table.rowCount} BETWEEN 0 AND 5000`),
    check("traceability_import_stages_commit_check", sql`(${table.status} = 'committed') = (${table.committedAt} IS NOT NULL)`),
  ],
);

export const traceabilityEvents = sqliteTable(
  "traceability_events",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    id: text("id").notNull().unique(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    type: text("type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    animalId: text("animal_id").references(() => livestockAnimals.id, { onDelete: "restrict" }),
    diioId: text("diio_id"),
    payload: text("payload", { mode: "json" }).$type<ImportRecord>().notNull().default(sql`'{}'`),
    domainEventId: text("domain_event_id").notNull().unique().references(() => domainEvents.id),
    actor: text("actor").notNull(),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("traceability_events_scope_cursor_idx").on(table.organizationId, table.fieldId, table.sequence),
    index("traceability_events_entity_cursor_idx").on(table.organizationId, table.fieldId, table.entityType, table.entityId, table.sequence),
    index("traceability_events_animal_cursor_idx").on(table.animalId, table.sequence),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "traceability_events_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.diioId],
      foreignColumns: [traceabilityDiios.organizationId, traceabilityDiios.fieldId, traceabilityDiios.id],
      name: "traceability_events_diio_fk",
    }),
    check("traceability_events_payload_check", sql`json_valid(${table.payload}) AND json_type(${table.payload}) = 'object'`),
  ],
);

export const pastureProviderDecisions = sqliteTable(
  "pasture_provider_decisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    mode: text("mode").$type<PastureProviderMode>().notNull().default("unconfigured"),
    providerKey: text("provider_key"),
    decidedBy: text("decided_by").notNull(),
    decidedAt: text("decided_at").notNull(),
  },
  (table) => [
    uniqueIndex("pasture_provider_decisions_scope_unique").on(table.organizationId, table.fieldId),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "pasture_provider_decisions_organization_field_fk",
    }),
    check("pasture_provider_decisions_mode_check", sql`${table.mode} IN ('unconfigured', 'configured')`),
    check("pasture_provider_decisions_provider_check", sql`
      (${table.mode} = 'unconfigured' AND ${table.providerKey} IS NULL)
      OR (${table.mode} = 'configured' AND ${table.providerKey} IS NOT NULL AND length(trim(${table.providerKey})) BETWEEN 1 AND 80)
    `),
  ],
);

export const pastureNdviCalibrations = sqliteTable(
  "pasture_ndvi_calibrations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    providerKey: text("provider_key").notNull(),
    slopeKgDmPerHa: real("slope_kg_dm_per_ha").notNull(),
    interceptKgDmPerHa: real("intercept_kg_dm_per_ha").notNull(),
    minNdvi: real("min_ndvi").notNull(),
    maxNdvi: real("max_ndvi").notNull(),
    status: text("status").$type<PastureCalibrationStatus>().notNull().default("draft"),
    validFrom: text("valid_from").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("pasture_ndvi_calibrations_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("pasture_ndvi_calibrations_active_unique")
      .on(table.organizationId, table.fieldId, table.providerKey)
      .where(sql`${table.status} = 'active'`),
    index("pasture_ndvi_calibrations_scope_status_idx").on(table.organizationId, table.fieldId, table.providerKey, table.status, table.validFrom),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "pasture_ndvi_calibrations_organization_field_fk",
    }),
    check("pasture_ndvi_calibrations_provider_check", sql`length(trim(${table.providerKey})) BETWEEN 1 AND 80`),
    check("pasture_ndvi_calibrations_coefficients_check", sql`abs(${table.slopeKgDmPerHa}) <= 1.0e308 AND abs(${table.interceptKgDmPerHa}) <= 1.0e308`),
    check("pasture_ndvi_calibrations_range_check", sql`${table.minNdvi} >= -1 AND ${table.minNdvi} < ${table.maxNdvi} AND ${table.maxNdvi} <= 1`),
    check("pasture_ndvi_calibrations_status_check", sql`${table.status} IN ('draft', 'active', 'retired')`),
  ],
);

export const pastureRawObservations = sqliteTable(
  "pasture_raw_observations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    operationId: text("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    sourceKind: text("source_kind").$type<PastureObservationSourceKind>().notNull(),
    providerKey: text("provider_key"),
    capturedAt: text("captured_at").notNull(),
    objectKey: text("object_key").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    etag: text("etag"),
    storageStatus: text("storage_status").$type<PastureObservationStorageStatus>().notNull().default("pending"),
    createdBy: text("created_by").notNull(),
    storedAt: text("stored_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("pasture_raw_observations_scope_id_unique").on(table.organizationId, table.fieldId, table.paddockId, table.id),
    uniqueIndex("pasture_raw_observations_operation_unique").on(table.organizationId, table.fieldId, table.operationId),
    uniqueIndex("pasture_raw_observations_object_key_unique").on(table.objectKey),
    index("pasture_raw_observations_scope_captured_idx").on(table.organizationId, table.fieldId, table.capturedAt),
    index("pasture_raw_observations_paddock_captured_idx").on(table.fieldId, table.paddockId, table.capturedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "pasture_raw_observations_organization_field_fk",
    }),
    foreignKey({
      columns: [table.fieldId, table.paddockId],
      foreignColumns: [paddocks.fieldId, paddocks.id],
      name: "pasture_raw_observations_field_paddock_fk",
    }),
    check("pasture_raw_observations_operation_check", sql`length(trim(${table.operationId})) BETWEEN 8 AND 160`),
    check("pasture_raw_observations_request_hash_check", sql`length(${table.requestHash}) = 64 AND ${table.requestHash} NOT GLOB '*[^0-9a-f]*'`),
    check("pasture_raw_observations_source_check", sql`
      (${table.sourceKind} = 'manual' AND ${table.providerKey} IS NULL)
      OR (${table.sourceKind} = 'ndvi' AND ${table.providerKey} IS NOT NULL AND length(trim(${table.providerKey})) BETWEEN 1 AND 80)
    `),
    check("pasture_raw_observations_object_check", sql`length(trim(${table.objectKey})) BETWEEN 1 AND 512 AND ${table.objectKey} NOT LIKE '%..%'`),
    check("pasture_raw_observations_content_check", sql`${table.contentType} = 'application/json' AND ${table.sizeBytes} BETWEEN 1 AND 2000000`),
    check("pasture_raw_observations_sha_check", sql`length(${table.sha256}) = 64 AND ${table.sha256} NOT GLOB '*[^0-9a-f]*'`),
    check("pasture_raw_observations_storage_status_check", sql`${table.storageStatus} IN ('pending', 'stored')`),
    check("pasture_raw_observations_storage_check", sql`
      (${table.storageStatus} = 'pending' AND ${table.etag} IS NULL AND ${table.storedAt} IS NULL)
      OR (${table.storageStatus} = 'stored' AND ${table.etag} IS NOT NULL AND length(trim(${table.etag})) > 0 AND ${table.storedAt} IS NOT NULL)
    `),
  ],
);

export const pastureBiomassEstimates = sqliteTable(
  "pasture_biomass_estimates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    paddockId: text("paddock_id")
      .notNull()
      .references(() => paddocks.id),
    rawObservationId: text("raw_observation_id").notNull(),
    method: text("method").$type<PastureBiomassMethod>().notNull(),
    kgDmPerHectare: real("kg_dm_per_hectare").notNull(),
    calibrationId: text("calibration_id"),
    evidenceJson: text("evidence_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    computedAt: text("computed_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("pasture_biomass_estimates_raw_unique").on(table.rawObservationId),
    index("pasture_biomass_estimates_scope_computed_idx").on(table.organizationId, table.fieldId, table.computedAt),
    index("pasture_biomass_estimates_paddock_computed_idx").on(table.fieldId, table.paddockId, table.computedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "pasture_biomass_estimates_organization_field_fk",
    }),
    foreignKey({
      columns: [table.fieldId, table.paddockId],
      foreignColumns: [paddocks.fieldId, paddocks.id],
      name: "pasture_biomass_estimates_field_paddock_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.paddockId, table.rawObservationId],
      foreignColumns: [pastureRawObservations.organizationId, pastureRawObservations.fieldId, pastureRawObservations.paddockId, pastureRawObservations.id],
      name: "pasture_biomass_estimates_raw_observation_fk",
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.calibrationId],
      foreignColumns: [pastureNdviCalibrations.organizationId, pastureNdviCalibrations.fieldId, pastureNdviCalibrations.id],
      name: "pasture_biomass_estimates_calibration_fk",
    }),
    check("pasture_biomass_estimates_method_check", sql`${table.method} IN ('manual_direct', 'manual_quadrat', 'ndvi_linear_calibration')`),
    check("pasture_biomass_estimates_value_check", sql`${table.kgDmPerHectare} >= 0 AND ${table.kgDmPerHectare} <= 10000000`),
    check("pasture_biomass_estimates_calibration_check", sql`
      (${table.method} IN ('manual_direct', 'manual_quadrat') AND ${table.calibrationId} IS NULL)
      OR (${table.method} = 'ndvi_linear_calibration' AND ${table.calibrationId} IS NOT NULL)
    `),
    check("pasture_biomass_estimates_evidence_check", sql`json_valid(${table.evidenceJson}) AND json_type(${table.evidenceJson}) = 'object'`),
  ],
);

export const pastureRotationPlans = sqliteTable(
  "pasture_rotation_plans",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    herdId: text("herd_id").notNull(),
    operationId: text("operation_id").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status").$type<PastureRotationPlanStatus>().notNull(),
    inputSnapshotJson: text("input_snapshot_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    planJson: text("plan_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("pasture_rotation_plans_operation_unique").on(table.organizationId, table.fieldId, table.operationId),
    index("pasture_rotation_plans_scope_status_idx").on(table.organizationId, table.fieldId, table.status, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "pasture_rotation_plans_organization_field_fk",
    }),
    check("pasture_rotation_plans_herd_check", sql`length(trim(${table.herdId})) BETWEEN 1 AND 160`),
    check("pasture_rotation_plans_operation_check", sql`length(trim(${table.operationId})) BETWEEN 8 AND 160`),
    check("pasture_rotation_plans_request_hash_check", sql`length(${table.requestHash}) = 64 AND ${table.requestHash} NOT GLOB '*[^0-9a-f]*'`),
    check("pasture_rotation_plans_status_check", sql`${table.status} IN ('feasible', 'infeasible')`),
    check("pasture_rotation_plans_json_check", sql`
      json_valid(${table.inputSnapshotJson}) AND json_type(${table.inputSnapshotJson}) = 'object'
      AND json_valid(${table.planJson}) AND json_type(${table.planJson}) = 'object'
    `),
  ],
);

export const benchmarkConsents = sqliteTable(
  "benchmark_consents",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    status: text("status").$type<BenchmarkConsentStatus>().notNull(),
    termsRevision: text("terms_revision"),
    consentedBy: text("consented_by").notNull(),
    consentedAt: text("consented_at"),
    optedOutAt: text("opted_out_at"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("benchmark_consents_organization_unique").on(table.organizationId),
    index("benchmark_consents_organization_status_idx").on(table.organizationId, table.status, table.updatedAt),
    check("benchmark_consents_status_check", sql`${table.status} IN ('opted_in', 'opted_out')`),
    check("benchmark_consents_actor_check", sql`length(trim(${table.consentedBy})) BETWEEN 1 AND 320`),
    check("benchmark_consents_state_check", sql`
      (
        ${table.status} = 'opted_in'
        AND ${table.termsRevision} IS NOT NULL
        AND ${table.termsRevision} = 'fundosmart.benchmarking.consent.v1'
        AND ${table.consentedAt} IS NOT NULL
        AND ${table.optedOutAt} IS NULL
      ) OR (
        ${table.status} = 'opted_out'
        AND ${table.termsRevision} IS NULL
        AND ${table.consentedAt} IS NULL
        AND ${table.optedOutAt} IS NOT NULL
      )
    `),
  ],
);

export const benchmarkFieldProfiles = sqliteTable(
  "benchmark_field_profiles",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    zone: text("zone").$type<BenchmarkZone>().notNull(),
    herdSizeBand: text("herd_size_band").$type<BenchmarkHerdSizeBand>().notNull(),
    productionSystem: text("production_system").$type<BenchmarkProductionSystem>().notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("benchmark_field_profiles_scope_unique").on(table.organizationId, table.fieldId),
    index("benchmark_field_profiles_scope_idx").on(table.organizationId, table.fieldId, table.updatedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "benchmark_field_profiles_organization_field_fk",
    }),
    check("benchmark_field_profiles_zone_check", sql`${table.zone} IN ('los_lagos', 'los_rios', 'araucania', 'nuble_biobio', 'other_chile')`),
    check("benchmark_field_profiles_herd_check", sql`${table.herdSizeBand} IN ('lt_50', '50_99', '100_199', '200_plus')`),
    check("benchmark_field_profiles_system_check", sql`${table.productionSystem} IN ('pasture', 'mixed', 'confined')`),
  ],
);

export const benchmarkAggregates = sqliteTable(
  "benchmark_aggregates",
  {
    id: text("id").primaryKey(),
    cohortKey: text("cohort_key").notNull(),
    period: text("period").notNull(),
    zone: text("zone").$type<BenchmarkZone>().notNull(),
    herdSizeBand: text("herd_size_band").$type<BenchmarkHerdSizeBand>().notNull(),
    productionSystem: text("production_system").$type<BenchmarkProductionSystem>().notNull(),
    metricKey: text("metric_key").$type<BenchmarkMetricKey>().notNull(),
    unit: text("unit").notNull(),
    status: text("status").$type<BenchmarkAggregateStatus>().notNull(),
    participantCount: integer("participant_count").notNull(),
    kThreshold: integer("k_threshold").notNull(),
    p10: real("p10"),
    p25: real("p25"),
    p50: real("p50"),
    p75: real("p75"),
    p90: real("p90"),
    schemaVersion: text("schema_version").notNull(),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    uniqueIndex("benchmark_aggregates_identity_unique").on(table.cohortKey, table.period, table.metricKey, table.schemaVersion),
    index("benchmark_aggregates_period_cohort_metric_idx").on(table.period, table.cohortKey, table.metricKey, table.status),
    check("benchmark_aggregates_period_check", sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(${table.period}, 6, 2) BETWEEN '01' AND '12'`),
    check("benchmark_aggregates_cohort_check", sql`length(trim(${table.cohortKey})) BETWEEN 1 AND 240`),
    check("benchmark_aggregates_zone_check", sql`${table.zone} IN ('los_lagos', 'los_rios', 'araucania', 'nuble_biobio', 'other_chile')`),
    check("benchmark_aggregates_herd_check", sql`${table.herdSizeBand} IN ('lt_50', '50_99', '100_199', '200_plus')`),
    check("benchmark_aggregates_system_check", sql`${table.productionSystem} IN ('pasture', 'mixed', 'confined')`),
    check("benchmark_aggregates_metric_check", sql`${table.metricKey} IN (
      'milk.volume_liters',
      'milk.production_per_cow_day_liters',
      'milk.somatic_cell_count',
      'reproduction.pregnancy_rate_pct',
      'reproduction.days_open_average',
      'reproduction.calving_interval_days_average',
      'weight.average_daily_gain_kg',
      'health.mastitis_rate_pct',
      'outcomes.mortality_rate_pct',
      'outcomes.discard_rate_pct',
      'finance.iofc_clp',
      'finance.feed_cost_clp',
      'finance.cost_per_liter_clp'
    )`),
    check("benchmark_aggregates_unit_check", sql`length(trim(${table.unit})) BETWEEN 1 AND 80`),
    check("benchmark_aggregates_status_check", sql`${table.status} IN ('published', 'suppressed')`),
    check("benchmark_aggregates_counts_check", sql`${table.participantCount} >= 0 AND ${table.kThreshold} BETWEEN 3 AND 50`),
    check("benchmark_aggregates_privacy_check", sql`
      (
        ${table.status} = 'published'
        AND ${table.participantCount} >= ${table.kThreshold}
        AND ${table.p10} IS NOT NULL AND ${table.p25} IS NOT NULL AND ${table.p50} IS NOT NULL
        AND ${table.p75} IS NOT NULL AND ${table.p90} IS NOT NULL
        AND abs(${table.p10}) <= 1.0e308 AND abs(${table.p25}) <= 1.0e308
        AND abs(${table.p50}) <= 1.0e308 AND abs(${table.p75}) <= 1.0e308 AND abs(${table.p90}) <= 1.0e308
        AND ${table.p10} <= ${table.p25} AND ${table.p25} <= ${table.p50}
        AND ${table.p50} <= ${table.p75} AND ${table.p75} <= ${table.p90}
      ) OR (
        ${table.status} = 'suppressed'
        AND ${table.participantCount} < ${table.kThreshold}
        AND ${table.p10} IS NULL AND ${table.p25} IS NULL AND ${table.p50} IS NULL
        AND ${table.p75} IS NULL AND ${table.p90} IS NULL
      )
    `),
    check("benchmark_aggregates_schema_check", sql`${table.schemaVersion} = 'fundosmart.benchmarking.aggregate.v1'`),
  ],
);

export const benchmarkPositions = sqliteTable(
  "benchmark_positions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    cohortKey: text("cohort_key").notNull(),
    period: text("period").notNull(),
    metricKey: text("metric_key").$type<BenchmarkMetricKey>().notNull(),
    unit: text("unit").notNull(),
    ownValue: real("own_value").notNull(),
    percentileRank: real("percentile_rank").notNull(),
    schemaVersion: text("schema_version").notNull(),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    uniqueIndex("benchmark_positions_identity_unique").on(
      table.organizationId,
      table.fieldId,
      table.period,
      table.metricKey,
      table.schemaVersion,
    ),
    index("benchmark_positions_scope_period_metric_idx").on(table.organizationId, table.fieldId, table.period, table.metricKey),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "benchmark_positions_organization_field_fk",
    }),
    foreignKey({
      columns: [table.cohortKey, table.period, table.metricKey, table.schemaVersion],
      foreignColumns: [benchmarkAggregates.cohortKey, benchmarkAggregates.period, benchmarkAggregates.metricKey, benchmarkAggregates.schemaVersion],
      name: "benchmark_positions_aggregate_fk",
    }).onDelete("cascade"),
    check("benchmark_positions_period_check", sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(${table.period}, 6, 2) BETWEEN '01' AND '12'`),
    check("benchmark_positions_cohort_check", sql`length(trim(${table.cohortKey})) BETWEEN 1 AND 240`),
    check("benchmark_positions_metric_check", sql`length(trim(${table.metricKey})) BETWEEN 1 AND 100`),
    check("benchmark_positions_unit_check", sql`length(trim(${table.unit})) BETWEEN 1 AND 80`),
    check("benchmark_positions_value_check", sql`abs(${table.ownValue}) <= 1.0e308`),
    check("benchmark_positions_percentile_check", sql`${table.percentileRank} BETWEEN 0 AND 100`),
    check("benchmark_positions_schema_check", sql`${table.schemaVersion} = 'fundosmart.benchmarking.aggregate.v1'`),
  ],
);

export const analyticsThresholdRevisions = sqliteTable(
  "analytics_threshold_revisions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    revision: text("revision").notNull(),
    thresholdsJson: text("thresholds_json", { mode: "json" }).$type<AnalyticsThresholds>().notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(false),
  },
  (table) => [
    uniqueIndex("analytics_threshold_revisions_scope_revision_unique").on(table.organizationId, table.fieldId, table.revision),
    uniqueIndex("analytics_threshold_revisions_current_unique")
      .on(table.organizationId, table.fieldId)
      .where(sql`${table.isCurrent} = 1`),
    index("analytics_threshold_revisions_scope_history_idx").on(table.organizationId, table.fieldId, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "analytics_threshold_revisions_organization_field_fk",
    }),
    check("analytics_threshold_revisions_revision_check", sql`length(${table.revision}) = 64 AND ${table.revision} NOT GLOB '*[^0-9a-f]*'`),
    check("analytics_threshold_revisions_actor_check", sql`length(trim(${table.createdBy})) BETWEEN 1 AND 320`),
    check("analytics_threshold_revisions_current_check", sql`${table.isCurrent} IN (0, 1)`),
    check("analytics_threshold_revisions_json_check", sql`
      json_valid(${table.thresholdsJson}) AND json_type(${table.thresholdsJson}) = 'object'
      AND json_type(${table.thresholdsJson}, '$.milkDropPct') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.milkDropPct') BETWEEN -100 AND 0
      AND json_type(${table.thresholdsJson}, '$.somaticCellHigh') IN ('integer', 'real')
      AND json_type(${table.thresholdsJson}, '$.somaticCellCritical') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.somaticCellHigh') BETWEEN 0 AND 10000000
      AND json_extract(${table.thresholdsJson}, '$.somaticCellCritical') BETWEEN json_extract(${table.thresholdsJson}, '$.somaticCellHigh') AND 10000000
      AND json_type(${table.thresholdsJson}, '$.mastitisRatePct') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.mastitisRatePct') BETWEEN 0 AND 100
      AND json_type(${table.thresholdsJson}, '$.pregnancyRatePctMinimum') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.pregnancyRatePctMinimum') BETWEEN 0 AND 100
      AND json_type(${table.thresholdsJson}, '$.daysOpenMaximum') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.daysOpenMaximum') BETWEEN 0 AND 3650
      AND json_type(${table.thresholdsJson}, '$.calvingIntervalDaysMaximum') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.calvingIntervalDaysMaximum') BETWEEN 0 AND 3650
      AND json_type(${table.thresholdsJson}, '$.averageDailyGainKgMinimum') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.averageDailyGainKgMinimum') BETWEEN -100 AND 100
      AND json_type(${table.thresholdsJson}, '$.mortalityRatePctMaximum') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.mortalityRatePctMaximum') BETWEEN 0 AND 100
      AND json_type(${table.thresholdsJson}, '$.discardRatePctMaximum') IN ('integer', 'real')
      AND json_extract(${table.thresholdsJson}, '$.discardRatePctMaximum') BETWEEN 0 AND 100
      AND json_type(${table.thresholdsJson}, '$.iofcMinimumClp') IN ('integer', 'real')
      AND abs(json_extract(${table.thresholdsJson}, '$.iofcMinimumClp')) <= 1000000000000
    `),
  ],
);

export const analyticsProjectionRuns = sqliteTable(
  "analytics_projection_runs",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    period: text("period").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    comparisonStart: text("comparison_start").notNull(),
    comparisonEnd: text("comparison_end").notNull(),
    sourceRevision: text("source_revision").notNull(),
    thresholdRevision: text("threshold_revision").notNull().default("b90b053e8c0f99e6cae9a67c56c96c99bd152083bbc0b971158f85ce020a76bf"),
    thresholdsJson: text("thresholds_json", { mode: "json" })
      .$type<AnalyticsThresholds>()
      .notNull()
      .default(sql`'{"milkDropPct":-15,"somaticCellHigh":400000,"somaticCellCritical":700000,"mastitisRatePct":5,"pregnancyRatePctMinimum":20,"daysOpenMaximum":150,"calvingIntervalDaysMaximum":420,"averageDailyGainKgMinimum":0,"mortalityRatePctMaximum":3,"discardRatePctMaximum":10,"iofcMinimumClp":0}'`),
    schemaVersion: text("schema_version").notNull(),
    qualityState: text("quality_state").$type<AnalyticsProjection["quality"]["state"]>().notNull(),
    qualityIssuesJson: text("quality_issues_json", { mode: "json" }).$type<Array<{ code: string; count: number }>>().notNull(),
    qualityDomainsJson: text("quality_domains_json", { mode: "json" }).$type<Record<string, string>>().notNull(),
    sourceCountsJson: text("source_counts_json", { mode: "json" }).$type<Record<string, number>>().notNull(),
    sourceCoverageJson: text("source_coverage_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    computedAt: text("computed_at").notNull(),
    isCurrent: integer("is_current", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    uniqueIndex("analytics_projection_runs_scope_id_unique").on(table.organizationId, table.fieldId, table.id),
    uniqueIndex("analytics_projection_runs_revision_unique").on(
      table.organizationId,
      table.fieldId,
      table.windowStart,
      table.windowEnd,
      table.sourceRevision,
      table.thresholdRevision,
      table.schemaVersion,
    ),
    uniqueIndex("analytics_projection_runs_current_unique")
      .on(table.organizationId, table.fieldId, table.windowStart, table.windowEnd)
      .where(sql`${table.isCurrent} = 1`),
    index("analytics_projection_runs_scope_period_idx").on(table.organizationId, table.fieldId, table.period, table.computedAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "analytics_projection_runs_organization_field_fk",
    }),
    check("analytics_projection_runs_period_check", sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(${table.period}, 6, 2) BETWEEN '01' AND '12'`),
    check("analytics_projection_runs_window_check", sql`${table.windowStart} <= ${table.windowEnd} AND ${table.comparisonStart} <= ${table.comparisonEnd}`),
    check("analytics_projection_runs_revision_check", sql`length(${table.sourceRevision}) = 64 AND ${table.sourceRevision} NOT GLOB '*[^0-9a-f]*'`),
    check("analytics_projection_runs_threshold_revision_check", sql`length(${table.thresholdRevision}) = 64 AND ${table.thresholdRevision} NOT GLOB '*[^0-9a-f]*'`),
    check("analytics_projection_runs_thresholds_check", sql`json_valid(${table.thresholdsJson}) AND json_type(${table.thresholdsJson}) = 'object'`),
    check("analytics_projection_runs_schema_check", sql`${table.schemaVersion} = 'fundosmart.analytics.projection.v1'`),
    check("analytics_projection_runs_quality_check", sql`${table.qualityState} IN ('available', 'partial', 'unavailable')`),
    check("analytics_projection_runs_json_check", sql`
      json_valid(${table.qualityIssuesJson}) AND json_type(${table.qualityIssuesJson}) = 'array'
      AND json_valid(${table.qualityDomainsJson}) AND json_type(${table.qualityDomainsJson}) = 'object'
      AND json_valid(${table.sourceCountsJson}) AND json_type(${table.sourceCountsJson}) = 'object'
      AND json_valid(${table.sourceCoverageJson}) AND json_type(${table.sourceCoverageJson}) = 'object'
    `),
    check("analytics_projection_runs_current_check", sql`${table.isCurrent} IN (0, 1)`),
  ],
);

export const analyticsHerdMetrics = sqliteTable(
  "analytics_herd_metrics",
  {
    id: text("id").primaryKey(),
    projectionId: text("projection_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    period: text("period").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    metricKey: text("metric_key").notNull(),
    status: text("status").$type<AnalyticsMetricStatus>().notNull(),
    statusReason: text("status_reason"),
    value: real("value"),
    unit: text("unit").notNull(),
    numerator: real("numerator"),
    denominator: real("denominator"),
    sampleCount: integer("sample_count").notNull(),
    method: text("method").notNull(),
    referencesJson: text("references_json", { mode: "json" }).$type<unknown[]>().notNull(),
    sourceRevision: text("source_revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    uniqueIndex("analytics_herd_metrics_projection_metric_unique").on(table.projectionId, table.metricKey),
    index("analytics_herd_metrics_scope_period_idx").on(table.organizationId, table.fieldId, table.period, table.metricKey),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "analytics_herd_metrics_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.projectionId],
      foreignColumns: [analyticsProjectionRuns.organizationId, analyticsProjectionRuns.fieldId, analyticsProjectionRuns.id],
      name: "analytics_herd_metrics_projection_fk",
    }).onDelete("cascade"),
    check("analytics_herd_metrics_period_check", sql`${table.period} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(${table.period}, 6, 2) BETWEEN '01' AND '12'`),
    check("analytics_herd_metrics_window_check", sql`${table.windowStart} <= ${table.windowEnd}`),
    check("analytics_herd_metrics_status_check", sql`${table.status} IN ('available', 'partial', 'insufficient_data', 'unavailable')`),
    check("analytics_herd_metrics_numbers_check", sql`
      (${table.value} IS NULL OR abs(${table.value}) <= 1.0e308)
      AND (${table.numerator} IS NULL OR abs(${table.numerator}) <= 1.0e308)
      AND (${table.denominator} IS NULL OR abs(${table.denominator}) <= 1.0e308)
    `),
    check("analytics_herd_metrics_sample_check", sql`${table.sampleCount} >= 0`),
    check("analytics_herd_metrics_references_check", sql`json_valid(${table.referencesJson}) AND json_type(${table.referencesJson}) = 'array'`),
    check("analytics_herd_metrics_revision_check", sql`length(${table.sourceRevision}) = 64 AND ${table.sourceRevision} NOT GLOB '*[^0-9a-f]*'`),
    check("analytics_herd_metrics_schema_check", sql`${table.schemaVersion} = 'fundosmart.analytics.projection.v1'`),
  ],
);

export const analyticsAlertEvaluations = sqliteTable(
  "analytics_alert_evaluations",
  {
    id: text("id").primaryKey(),
    projectionId: text("projection_id").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id")
      .notNull()
      .references(() => fields.id),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    code: text("code").notNull(),
    status: text("status").$type<AnalyticsAlertStatus>().notNull(),
    severity: text("severity").$type<AnalyticsAlertSeverity>().notNull(),
    explanation: text("explanation").notNull(),
    evidenceJson: text("evidence_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    thresholdRevision: text("threshold_revision").notNull(),
    thresholdsJson: text("thresholds_json", { mode: "json" })
      .$type<AnalyticsThresholds>()
      .notNull()
      .default(sql`'{"milkDropPct":-15,"somaticCellHigh":400000,"somaticCellCritical":700000,"mastitisRatePct":5,"pregnancyRatePctMinimum":20,"daysOpenMaximum":150,"calvingIntervalDaysMaximum":420,"averageDailyGainKgMinimum":0,"mortalityRatePctMaximum":3,"discardRatePctMaximum":10,"iofcMinimumClp":0}'`),
    sourceRevision: text("source_revision").notNull(),
    schemaVersion: text("schema_version").notNull(),
    computedAt: text("computed_at").notNull(),
  },
  (table) => [
    uniqueIndex("analytics_alert_evaluations_projection_code_unique").on(table.projectionId, table.code),
    index("analytics_alert_evaluations_scope_window_idx").on(table.organizationId, table.fieldId, table.windowStart, table.windowEnd),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "analytics_alert_evaluations_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.fieldId, table.projectionId],
      foreignColumns: [analyticsProjectionRuns.organizationId, analyticsProjectionRuns.fieldId, analyticsProjectionRuns.id],
      name: "analytics_alert_evaluations_projection_fk",
    }).onDelete("cascade"),
    check("analytics_alert_evaluations_window_check", sql`${table.windowStart} <= ${table.windowEnd}`),
    check("analytics_alert_evaluations_status_check", sql`${table.status} IN ('triggered', 'clear', 'unavailable')`),
    check("analytics_alert_evaluations_severity_check", sql`${table.severity} IN ('warning', 'critical')`),
    check("analytics_alert_evaluations_evidence_check", sql`json_valid(${table.evidenceJson}) AND json_type(${table.evidenceJson}) = 'object'`),
    check("analytics_alert_evaluations_threshold_check", sql`length(trim(${table.thresholdRevision})) > 0`),
    check("analytics_alert_evaluations_threshold_revision_check", sql`length(${table.thresholdRevision}) = 64 AND ${table.thresholdRevision} NOT GLOB '*[^0-9a-f]*'`),
    check("analytics_alert_evaluations_thresholds_check", sql`json_valid(${table.thresholdsJson}) AND json_type(${table.thresholdsJson}) = 'object'`),
    check("analytics_alert_evaluations_revision_check", sql`length(${table.sourceRevision}) = 64 AND ${table.sourceRevision} NOT GLOB '*[^0-9a-f]*'`),
    check("analytics_alert_evaluations_schema_check", sql`${table.schemaVersion} = 'fundosmart.analytics.projection.v1'`),
  ],
);

export const agendaTaskStates = sqliteTable(
  "agenda_task_states",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id").notNull(),
    itemKey: text("item_key").notNull(),
    signalRevision: text("signal_revision").notNull(),
    source: text("source").$type<AgendaTaskSource>().notNull(),
    status: text("status").$type<AgendaTaskStatus>().notNull().default("open"),
    assigneeMembershipId: text("assignee_membership_id"),
    scheduledFor: text("scheduled_for"),
    resolutionReason: text("resolution_reason"),
    version: integer("version").notNull().default(1),
    lastOperationId: text("last_operation_id").notNull(),
    createdByMembershipId: text("created_by_membership_id").notNull(),
    updatedByMembershipId: text("updated_by_membership_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("agenda_task_states_signal_unique").on(
      table.organizationId,
      table.fieldId,
      table.itemKey,
      table.signalRevision,
    ),
    index("agenda_task_states_scope_status_idx").on(
      table.organizationId,
      table.fieldId,
      table.status,
      table.scheduledFor,
    ),
    index("agenda_task_states_assignee_status_idx").on(
      table.organizationId,
      table.assigneeMembershipId,
      table.status,
    ),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "agenda_task_states_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.assigneeMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "agenda_task_states_assignee_organization_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.createdByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "agenda_task_states_creator_organization_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.updatedByMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "agenda_task_states_updater_organization_fk",
    }),
    check(
      "agenda_task_states_item_check",
      sql`length(${table.itemKey}) BETWEEN 1 AND 240`,
    ),
    check(
      "agenda_task_states_revision_check",
      sql`length(${table.signalRevision}) = 16 AND ${table.signalRevision} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "agenda_task_states_source_check",
      sql`${table.source} IN ('ganado', 'leche', 'costos', 'potreros', 'dashboard')`,
    ),
    check(
      "agenda_task_states_status_check",
      sql`${table.status} IN ('open', 'completed', 'postponed', 'dismissed')`,
    ),
    check(
      "agenda_task_states_schedule_check",
      sql`${table.scheduledFor} IS NULL OR (
        length(${table.scheduledFor}) = 10
        AND date(${table.scheduledFor}) = ${table.scheduledFor}
      )`,
    ),
    check(
      "agenda_task_states_reason_check",
      sql`${table.resolutionReason} IS NULL OR length(${table.resolutionReason}) BETWEEN 3 AND 500`,
    ),
    check(
      "agenda_task_states_lifecycle_check",
      sql`
        (
          ${table.status} = 'open'
          AND ${table.scheduledFor} IS NULL
          AND ${table.resolutionReason} IS NULL
        )
        OR (
          ${table.status} = 'postponed'
          AND ${table.scheduledFor} IS NOT NULL
          AND ${table.resolutionReason} IS NOT NULL
        )
        OR (
          ${table.status} IN ('completed', 'dismissed')
          AND ${table.scheduledFor} IS NULL
          AND ${table.resolutionReason} IS NOT NULL
        )
      `,
    ),
    check("agenda_task_states_version_check", sql`${table.version} >= 1`),
    check(
      "agenda_task_states_operation_check",
      sql`
        length(${table.lastOperationId}) = 36
        AND ${table.lastOperationId} = lower(${table.lastOperationId})
        AND substr(${table.lastOperationId}, 9, 1) = '-'
        AND substr(${table.lastOperationId}, 14, 1) = '-'
        AND substr(${table.lastOperationId}, 19, 1) = '-'
        AND substr(${table.lastOperationId}, 24, 1) = '-'
        AND length(replace(${table.lastOperationId}, '-', '')) = 32
        AND replace(${table.lastOperationId}, '-', '') NOT GLOB '*[^0-9a-f]*'
        AND substr(${table.lastOperationId}, 15, 1) GLOB '[1-5]'
        AND substr(${table.lastOperationId}, 20, 1) GLOB '[89ab]'
      `,
    ),
    check(
      "agenda_task_states_timestamp_check",
      sql`
        datetime(${table.createdAt}) IS NOT NULL
        AND datetime(${table.updatedAt}) IS NOT NULL
        AND ${table.updatedAt} >= ${table.createdAt}
      `,
    ),
  ],
);

export const agendaTaskOperations = sqliteTable(
  "agenda_task_operations",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    fieldId: text("field_id").notNull(),
    stateId: text("state_id")
      .notNull()
      .references(() => agendaTaskStates.id),
    actorMembershipId: text("actor_membership_id").notNull(),
    action: text("action").$type<AgendaTaskAction>().notNull(),
    requestHash: text("request_hash").notNull(),
    resultJson: text("result_json", { mode: "json" }).$type<AgendaTaskState>().notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("agenda_task_operations_scope_time_idx").on(
      table.organizationId,
      table.fieldId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "agenda_task_operations_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.actorMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "agenda_task_operations_actor_organization_fk",
    }),
    check(
      "agenda_task_operations_action_check",
      sql`${table.action} IN ('complete', 'postpone', 'dismiss', 'reopen', 'assign')`,
    ),
    check(
      "agenda_task_operations_hash_check",
      sql`length(${table.requestHash}) = 64 AND ${table.requestHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "agenda_task_operations_result_check",
      sql`json_valid(${table.resultJson}) AND json_type(${table.resultJson}) = 'object'`,
    ),
    check(
      "agenda_task_operations_time_check",
      sql`datetime(${table.createdAt}) IS NOT NULL`,
    ),
  ],
);

export const agendaTaskEvents = sqliteTable(
  "agenda_task_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull(),
    fieldId: text("field_id").notNull(),
    stateId: text("state_id")
      .notNull()
      .references(() => agendaTaskStates.id),
    operationId: text("operation_id")
      .notNull()
      .references(() => agendaTaskOperations.id),
    actorMembershipId: text("actor_membership_id").notNull(),
    actorEmail: text("actor_email").notNull(),
    eventType: text("event_type").$type<AgendaTaskAction>().notNull(),
    beforeJson: text("before_json", { mode: "json" }).$type<AgendaTaskState>(),
    afterJson: text("after_json", { mode: "json" }).$type<AgendaTaskState>().notNull(),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("agenda_task_events_operation_unique").on(table.operationId),
    index("agenda_task_events_state_time_idx").on(table.stateId, table.occurredAt, table.id),
    index("agenda_task_events_scope_time_idx").on(
      table.organizationId,
      table.fieldId,
      table.occurredAt,
    ),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "agenda_task_events_organization_field_fk",
    }),
    foreignKey({
      columns: [table.organizationId, table.actorMembershipId],
      foreignColumns: [organizationMemberships.organizationId, organizationMemberships.id],
      name: "agenda_task_events_actor_organization_fk",
    }),
    check(
      "agenda_task_events_actor_check",
      sql`length(${table.actorEmail}) BETWEEN 3 AND 320 AND ${table.actorEmail} = lower(trim(${table.actorEmail}))`,
    ),
    check(
      "agenda_task_events_type_check",
      sql`${table.eventType} IN ('complete', 'postpone', 'dismiss', 'reopen', 'assign')`,
    ),
    check(
      "agenda_task_events_before_check",
      sql`${table.beforeJson} IS NULL OR (
        json_valid(${table.beforeJson}) AND json_type(${table.beforeJson}) = 'object'
      )`,
    ),
    check(
      "agenda_task_events_after_check",
      sql`json_valid(${table.afterJson}) AND json_type(${table.afterJson}) = 'object'`,
    ),
    check(
      "agenda_task_events_time_check",
      sql`datetime(${table.occurredAt}) IS NOT NULL`,
    ),
  ],
);

export const productFeedback = sqliteTable(
  "product_feedback",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id"),
    reporterMembershipId: text("reporter_membership_id").notNull(),
    reporterEmail: text("reporter_email").notNull(),
    reporterName: text("reporter_name").notNull(),
    planCode: text("plan_code").$type<OrganizationPlanCode>().notNull(),
    category: text("category").$type<FeedbackCategory>().notNull(),
    impact: text("impact").$type<FeedbackImpact>().notNull(),
    message: text("message").notNull(),
    contactAllowed: integer("contact_allowed", { mode: "boolean" }).notNull().default(false),
    submissionKey: text("submission_key").notNull(),
    pagePath: text("page_path").notNull(),
    releaseSha: text("release_sha").notNull(),
    userAgent: text("user_agent").notNull().default(""),
    viewportWidth: integer("viewport_width"),
    viewportHeight: integer("viewport_height"),
    online: integer("online", { mode: "boolean" }).notNull().default(true),
    status: text("status").$type<FeedbackStatus>().notNull().default("new"),
    priority: text("priority").$type<FeedbackPriority>(),
    staffNote: text("staff_note"),
    version: integer("version").notNull().default(1),
    lastEventId: text("last_event_id").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("product_feedback_submission_unique").on(table.reporterMembershipId, table.submissionKey),
    index("product_feedback_status_time_idx").on(table.status, table.createdAt, table.id),
    index("product_feedback_category_status_time_idx").on(table.category, table.status, table.createdAt),
    index("product_feedback_organization_time_idx").on(table.organizationId, table.createdAt, table.id),
    index("product_feedback_reporter_time_idx").on(table.reporterMembershipId, table.createdAt),
    foreignKey({
      columns: [table.organizationId, table.fieldId],
      foreignColumns: [fields.organizationId, fields.id],
      name: "product_feedback_organization_field_fk",
    }),
    check(
      "product_feedback_reporter_email_check",
      sql`length(${table.reporterEmail}) BETWEEN 3 AND 320 AND ${table.reporterEmail} = lower(trim(${table.reporterEmail}))`,
    ),
    check(
      "product_feedback_reporter_name_check",
      sql`length(trim(${table.reporterName})) BETWEEN 1 AND 160`,
    ),
    check("product_feedback_plan_check", sql`${table.planCode} IN ('legacy', 'free', 'pro')`),
    check(
      "product_feedback_category_check",
      sql`${table.category} IN ('bug', 'improvement', 'recommendation')`,
    ),
    check(
      "product_feedback_impact_check",
      sql`${table.impact} IN ('blocked', 'difficult', 'non_urgent')`,
    ),
    check(
      "product_feedback_message_check",
      sql`length(${table.message}) BETWEEN 10 AND 4000 AND ${table.message} = trim(${table.message})`,
    ),
    check("product_feedback_contact_check", sql`${table.contactAllowed} IN (0, 1)`),
    check(
      "product_feedback_submission_key_check",
      sql`
        length(${table.submissionKey}) = 36
        AND ${table.submissionKey} = lower(${table.submissionKey})
        AND substr(${table.submissionKey}, 9, 1) = '-'
        AND substr(${table.submissionKey}, 14, 1) = '-'
        AND substr(${table.submissionKey}, 19, 1) = '-'
        AND substr(${table.submissionKey}, 24, 1) = '-'
        AND length(replace(${table.submissionKey}, '-', '')) = 32
        AND replace(${table.submissionKey}, '-', '') NOT GLOB '*[^0-9a-f]*'
        AND substr(${table.submissionKey}, 15, 1) GLOB '[1-5]'
        AND substr(${table.submissionKey}, 20, 1) GLOB '[89ab]'
      `,
    ),
    check(
      "product_feedback_page_path_check",
      sql`length(${table.pagePath}) BETWEEN 4 AND 1024 AND (${table.pagePath} = '/app' OR ${table.pagePath} GLOB '/app/*')`,
    ),
    check(
      "product_feedback_release_check",
      sql`length(${table.releaseSha}) BETWEEN 1 AND 128`,
    ),
    check("product_feedback_user_agent_check", sql`length(${table.userAgent}) <= 512`),
    check(
      "product_feedback_viewport_width_check",
      sql`${table.viewportWidth} IS NULL OR ${table.viewportWidth} BETWEEN 240 AND 10000`,
    ),
    check(
      "product_feedback_viewport_height_check",
      sql`${table.viewportHeight} IS NULL OR ${table.viewportHeight} BETWEEN 240 AND 10000`,
    ),
    check("product_feedback_online_check", sql`${table.online} IN (0, 1)`),
    check(
      "product_feedback_status_check",
      sql`${table.status} IN ('new', 'reviewing', 'planned', 'resolved', 'closed')`,
    ),
    check(
      "product_feedback_priority_check",
      sql`${table.priority} IS NULL OR ${table.priority} IN ('p0', 'p1', 'p2', 'p3')`,
    ),
    check(
      "product_feedback_staff_note_check",
      sql`${table.staffNote} IS NULL OR length(${table.staffNote}) BETWEEN 1 AND 2000`,
    ),
    check("product_feedback_version_check", sql`${table.version} >= 1`),
    check(
      "product_feedback_timestamp_check",
      sql`datetime(${table.createdAt}) IS NOT NULL AND datetime(${table.updatedAt}) IS NOT NULL AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const productFeedbackEvents = sqliteTable(
  "product_feedback_events",
  {
    id: text("id").primaryKey(),
    feedbackId: text("feedback_id")
      .notNull()
      .references(() => productFeedback.id, { onDelete: "cascade" }),
    actorEmail: text("actor_email").notNull(),
    eventType: text("event_type").$type<"created" | "triage_updated">().notNull(),
    beforeJson: text("before_json", { mode: "json" }).$type<Record<string, unknown>>(),
    afterJson: text("after_json", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("product_feedback_events_feedback_time_idx").on(table.feedbackId, table.occurredAt, table.id),
    check(
      "product_feedback_events_actor_check",
      sql`length(trim(${table.actorEmail})) BETWEEN 3 AND 320`,
    ),
    check(
      "product_feedback_events_type_check",
      sql`${table.eventType} IN ('created', 'triage_updated')`,
    ),
    check(
      "product_feedback_events_before_check",
      sql`${table.beforeJson} IS NULL OR (json_valid(${table.beforeJson}) AND json_type(${table.beforeJson}) = 'object')`,
    ),
    check(
      "product_feedback_events_after_check",
      sql`json_valid(${table.afterJson}) AND json_type(${table.afterJson}) = 'object'`,
    ),
    check(
      "product_feedback_events_time_check",
      sql`datetime(${table.occurredAt}) IS NOT NULL`,
    ),
  ],
);

export const auditLog = sqliteTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    fieldId: text("field_id").references(() => fields.id),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    before: text("before", { mode: "json" }).$type<ImportRecord>(),
    after: text("after", { mode: "json" }).$type<ImportRecord>(),
    sourceRecordId: text("source_record_id").references(() => sourceRecords.id),
    occurredAt: text("occurred_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("audit_log_organization_time_idx").on(table.organizationId, table.occurredAt),
    index("audit_log_field_time_idx").on(table.fieldId, table.occurredAt),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
  ],
);
