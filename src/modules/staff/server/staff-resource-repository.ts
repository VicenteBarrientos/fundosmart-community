import { getDb } from "@/db";
import { normalizeAccessEmail } from "@/src/modules/access/domain/access-rules.mjs";

const STAFF_CUTOVER_MARKER_KEY = "platform-staff-v2-required";

type D1Binding = string | number | null;
type LegacyStaffActor = Readonly<{
  subject: string;
  email: string;
}>;
type OrganizationKind = "shared" | "personal" | "demo";
type FeatureKey = "trazabilidad" | "pastoreo" | "analitica" | "benchmarking";

export type LegacyStaffFeatureFlagSnapshot = Readonly<{
  id: string;
  organizationId: string;
  fieldId: string | null;
  feature: FeatureKey;
  enabled: boolean;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}>;

export class LegacyStaffResourceError extends Error {
  constructor(
    message: string,
    public readonly code = "STAFF_RESOURCE_CONFLICT",
    public readonly status = 409,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LegacyStaffResourceError";
  }
}

export async function commitLegacyStaffWorkspace(input: {
  actor: LegacyStaffActor;
  staffCutoverMarkerKey: string;
  workspaceId: string;
  name: string;
  kind: OrganizationKind;
  now: string;
  auditId: string;
}): Promise<void> {
  assertStaffActor(input.actor);
  assertStaffCutoverMarker(input.staffCutoverMarkerKey);
  const client = getDb().$client.withSession("first-primary");
  const authority = legacyStaffAuthority(input);
  const afterJson = JSON.stringify({
    id: input.workspaceId,
    name: input.name,
    kind: input.kind,
  });
  const organization = [
    input.workspaceId,
    input.name,
    input.kind,
    input.now,
  ] as const;
  const audit = [
    input.auditId,
    input.workspaceId,
    input.actor.email,
    input.workspaceId,
    afterJson,
    input.now,
  ] as const;
  const statements = [
    client.prepare(`
      INSERT INTO organizations (id, name, kind, created_at)
      SELECT ?, ?, ?, ?
      WHERE ${authority.sql}
    `).bind(...organization, ...authority.bindings),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type,
        entity_id, before, after, occurred_at
      )
      SELECT
        ?, ?, NULL, ?, 'organization.created', 'organization',
        ?, NULL, ?, ?
      WHERE ${authority.sql}
        AND EXISTS (
          SELECT 1 FROM organizations AS organization
          WHERE organization.id = ?
            AND organization.name = ?
            AND organization.kind = ?
            AND organization.created_at = ?
        )
    `).bind(
      ...audit,
      ...authority.bindings,
      ...organization,
    ),
    client.prepare(`
      SELECT
        CASE WHEN
          ${authority.sql}
          AND EXISTS (
            SELECT 1 FROM organizations AS organization
            WHERE organization.id = ?
              AND organization.name = ?
              AND organization.kind = ?
              AND organization.created_at = ?
          )
          AND EXISTS (
            SELECT 1 FROM audit_log AS audit
            WHERE audit.id = ?
              AND audit.organization_id = ?
              AND audit.field_id IS NULL
              AND audit.actor = ?
              AND audit.action = 'organization.created'
              AND audit.entity_type = 'organization'
              AND audit.entity_id = ?
              AND audit.before IS NULL
              AND audit.after = ?
              AND audit.occurred_at = ?
          )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
        ? AS resourceId
    `).bind(
      ...authority.bindings,
      ...organization,
      ...audit,
      input.workspaceId,
    ),
  ];
  await commitBatch(client, statements, input.workspaceId);
}

export async function commitLegacyStaffField(input: {
  actor: LegacyStaffActor;
  staffCutoverMarkerKey: string;
  fieldId: string;
  organizationId: string;
  expectedOrganizationKind: OrganizationKind;
  name: string;
  location: string;
  now: string;
  auditId: string;
}): Promise<void> {
  assertStaffActor(input.actor);
  assertStaffCutoverMarker(input.staffCutoverMarkerKey);
  const client = getDb().$client.withSession("first-primary");
  const authority = legacyStaffAuthority(input, input.organizationId);
  const isDemo = input.expectedOrganizationKind === "demo" ? 1 : 0;
  const afterJson = JSON.stringify({
    id: input.fieldId,
    organizationId: input.organizationId,
    name: input.name,
    location: input.location,
  });
  const field = [
    input.fieldId,
    input.organizationId,
    input.name,
    input.location,
    isDemo,
    input.now,
  ] as const;
  const audit = [
    input.auditId,
    input.organizationId,
    input.fieldId,
    input.actor.email,
    input.fieldId,
    afterJson,
    input.now,
  ] as const;
  const statements = [
    client.prepare(`
      INSERT INTO fields (
        id, organization_id, name, location, is_demo, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?
      FROM organizations AS organization
      WHERE organization.id = ?
        AND organization.kind = ?
        AND ${authority.sql}
    `).bind(
      ...field,
      input.organizationId,
      input.expectedOrganizationKind,
      ...authority.bindings,
    ),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type,
        entity_id, before, after, occurred_at
      )
      SELECT
        ?, ?, ?, ?, 'fundo.created', 'fields',
        ?, NULL, ?, ?
      WHERE ${authority.sql}
        AND EXISTS (
          SELECT 1 FROM fields AS field
          INNER JOIN organizations AS organization
            ON organization.id = field.organization_id
          WHERE field.id = ?
            AND field.organization_id = ?
            AND field.name = ?
            AND field.location = ?
            AND field.is_demo = ?
            AND field.created_at = ?
            AND organization.kind = ?
        )
    `).bind(
      ...audit,
      ...authority.bindings,
      ...field,
      input.expectedOrganizationKind,
    ),
    client.prepare(`
      SELECT
        CASE WHEN
          ${authority.sql}
          AND EXISTS (
            SELECT 1 FROM fields AS field
            INNER JOIN organizations AS organization
              ON organization.id = field.organization_id
            WHERE field.id = ?
              AND field.organization_id = ?
              AND field.name = ?
              AND field.location = ?
              AND field.is_demo = ?
              AND field.created_at = ?
              AND organization.kind = ?
          )
          AND EXISTS (
            SELECT 1 FROM audit_log AS audit
            WHERE audit.id = ?
              AND audit.organization_id = ?
              AND audit.field_id = ?
              AND audit.actor = ?
              AND audit.action = 'fundo.created'
              AND audit.entity_type = 'fields'
              AND audit.entity_id = ?
              AND audit.before IS NULL
              AND audit.after = ?
              AND audit.occurred_at = ?
          )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
        ? AS resourceId
    `).bind(
      ...authority.bindings,
      ...field,
      input.expectedOrganizationKind,
      ...audit,
      input.fieldId,
    ),
  ];
  await commitBatch(client, statements, input.fieldId);
}

export async function commitLegacyStaffFeatureFlag(input: {
  actor: LegacyStaffActor;
  staffCutoverMarkerKey: string;
  flagId: string;
  organizationId: string;
  fieldId: string | null;
  feature: FeatureKey;
  enabled: boolean;
  previous: LegacyStaffFeatureFlagSnapshot | null;
  now: string;
  auditId: string;
}): Promise<void> {
  assertStaffActor(input.actor);
  assertStaffCutoverMarker(input.staffCutoverMarkerKey);
  assertFeatureFlagSnapshot(input);
  const client = getDb().$client.withSession("first-primary");
  const authority = legacyStaffAuthority(input, input.organizationId);
  const enabled = input.enabled ? 1 : 0;
  const beforeJson = input.previous
    ? JSON.stringify({
        feature: input.feature,
        fieldId: input.fieldId,
        enabled: input.previous.enabled,
      })
    : null;
  const afterJson = JSON.stringify({
    feature: input.feature,
    fieldId: input.fieldId,
    enabled: input.enabled,
  });
  const receipt = [
    input.auditId,
    input.organizationId,
    input.fieldId,
    input.actor.email,
    input.enabled ? "feature.enabled" : "feature.disabled",
    input.flagId,
    beforeJson,
    afterJson,
    input.now,
  ] as const;
  const previous = featureFlagPreimage(input.previous, input.flagId);
  const auditStatement = client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type,
      entity_id, before, after, occurred_at
    )
    SELECT
      ?, ?, ?, ?, ?, 'organization_feature_flag',
      ?, ?, ?, ?
    WHERE ${authority.sql}
      AND EXISTS (
        SELECT 1 FROM organizations AS organization
        WHERE organization.id = ?
      )
      AND (
        ? IS NULL
        OR EXISTS (
          SELECT 1 FROM fields AS field
          WHERE field.id = ?
            AND field.organization_id = ?
        )
      )
      AND ${previous.sql}
  `).bind(
    ...receipt,
    ...authority.bindings,
    input.organizationId,
    input.fieldId,
    input.fieldId,
    input.organizationId,
    ...previous.bindings,
  );
  const receiptCondition = {
    sql: `EXISTS (
      SELECT 1 FROM audit_log AS audit
      WHERE audit.id = ?
        AND audit.organization_id = ?
        AND audit.field_id IS ?
        AND audit.actor = ?
        AND audit.action = ?
        AND audit.entity_type = 'organization_feature_flag'
        AND audit.entity_id = ?
        AND audit.before IS ?
        AND audit.after = ?
        AND audit.occurred_at = ?
    )`,
    bindings: [...receipt] as D1Binding[],
  };
  const mutationStatement = input.previous
    ? client.prepare(`
        UPDATE organization_feature_flags
        SET enabled = ?, updated_by = ?, updated_at = ?
        WHERE id = ?
          AND organization_id = ?
          AND field_id IS ?
          AND feature = ?
          AND enabled = ?
          AND created_by = ?
          AND updated_by = ?
          AND created_at = ?
          AND updated_at = ?
          AND ${authority.sql}
          AND ${receiptCondition.sql}
      `).bind(
        enabled,
        input.actor.email,
        input.now,
        ...previous.bindings,
        ...authority.bindings,
        ...receiptCondition.bindings,
      )
    : client.prepare(`
        INSERT INTO organization_feature_flags (
          id, organization_id, field_id, feature, enabled,
          created_by, updated_by, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE ${previous.sql}
          AND ${authority.sql}
          AND ${receiptCondition.sql}
      `).bind(
        input.flagId,
        input.organizationId,
        input.fieldId,
        input.feature,
        enabled,
        input.actor.email,
        input.actor.email,
        input.now,
        input.now,
        ...previous.bindings,
        ...authority.bindings,
        ...receiptCondition.bindings,
      );
  const statements = [
    auditStatement,
    mutationStatement,
    client.prepare(`
      SELECT
        CASE WHEN
          ${authority.sql}
          AND EXISTS (
            SELECT 1 FROM organization_feature_flags AS flag
            WHERE flag.id = ?
              AND flag.organization_id = ?
              AND flag.field_id IS ?
              AND flag.feature = ?
              AND flag.enabled = ?
              AND flag.updated_by = ?
              AND flag.updated_at = ?
          )
          AND ${receiptCondition.sql}
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
        ? AS resourceId
    `).bind(
      ...authority.bindings,
      input.flagId,
      input.organizationId,
      input.fieldId,
      input.feature,
      enabled,
      input.actor.email,
      input.now,
      ...receiptCondition.bindings,
      input.flagId,
    ),
  ];
  await commitBatch(client, statements, input.flagId);
}

function legacyStaffAuthority(
  input: {
    actor: LegacyStaffActor;
    staffCutoverMarkerKey: string;
  },
  organizationId?: string,
): {
  sql: string;
  bindings: D1Binding[];
} {
  const normalizedEmail = normalizeAccessEmail(input.actor.email);
  const organizationCondition = organizationId
    ? `
      AND NOT EXISTS (
        SELECT 1 FROM account_closure_requests AS closure
        WHERE closure.scope = 'organization'
          AND closure.target_id = ?
          AND closure.status = 'grace'
      )
    `
    : "";
  return {
    sql: `
      (
        ? = 'dev:' || ?
        OR EXISTS (
          SELECT 1 FROM auth_identities AS identity
          WHERE identity.id = ?
            AND identity.normalized_email = ?
        )
      )
      AND NOT EXISTS (
        SELECT 1 FROM app_state AS staff_cutover
        WHERE staff_cutover.key = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM account_closure_requests AS closure
        WHERE closure.scope = 'account'
          AND closure.target_id = ?
          AND closure.status = 'grace'
      )
      ${organizationCondition}
    `,
    bindings: [
      input.actor.subject,
      normalizedEmail,
      input.actor.subject,
      normalizedEmail,
      input.staffCutoverMarkerKey,
      input.actor.subject,
      ...(organizationId ? [organizationId] : []),
    ],
  };
}

function assertStaffCutoverMarker(value: string): void {
  if (value !== STAFF_CUTOVER_MARKER_KEY) {
    throw conflict();
  }
}

function assertStaffActor(actor: LegacyStaffActor): void {
  const normalizedEmail = normalizeAccessEmail(actor.email);
  const atIndex = normalizedEmail.indexOf("@");
  if (
    !actor.subject
    || atIndex <= 0
    || atIndex === normalizedEmail.length - 1
    || normalizedEmail.indexOf("@", atIndex + 1) !== -1
    || (actor.subject.startsWith("dev:") && actor.subject !== `dev:${normalizedEmail}`)
  ) {
    throw conflict();
  }
}

function assertFeatureFlagSnapshot(input: {
  flagId: string;
  organizationId: string;
  fieldId: string | null;
  feature: FeatureKey;
  previous: LegacyStaffFeatureFlagSnapshot | null;
}): void {
  if (
    input.previous
    && (
      input.previous.id !== input.flagId
      || input.previous.organizationId !== input.organizationId
      || input.previous.fieldId !== input.fieldId
      || input.previous.feature !== input.feature
    )
  ) {
    throw conflict();
  }
}

function featureFlagPreimage(
  previous: LegacyStaffFeatureFlagSnapshot | null,
  flagId: string,
): {
  sql: string;
  bindings: D1Binding[];
} {
  if (!previous) {
    return {
      sql: `NOT EXISTS (
        SELECT 1 FROM organization_feature_flags AS previous
        WHERE previous.id = ?
      )`,
      bindings: [flagId],
    };
  }
  return {
    sql: `EXISTS (
      SELECT 1 FROM organization_feature_flags AS previous
      WHERE previous.id = ?
        AND previous.organization_id = ?
        AND previous.field_id IS ?
        AND previous.feature = ?
        AND previous.enabled = ?
        AND previous.created_by = ?
        AND previous.updated_by = ?
        AND previous.created_at = ?
        AND previous.updated_at = ?
    )`,
    bindings: [
      previous.id,
      previous.organizationId,
      previous.fieldId,
      previous.feature,
      previous.enabled ? 1 : 0,
      previous.createdBy,
      previous.updatedBy,
      previous.createdAt,
      previous.updatedAt,
    ],
  };
}

async function commitBatch(
  client: D1DatabaseSession,
  statements: readonly D1PreparedStatement[],
  expectedResourceId: string,
): Promise<void> {
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await client.batch<Record<string, unknown>>([...statements]);
  } catch (cause) {
    throw conflict(cause);
  }
  const sentinel = results.at(-1)?.results?.[0];
  if (
    results.length !== statements.length
    || results.some((result) => result.success !== true)
    || Number(sentinel?.complete) !== 1
    || sentinel?.resourceId !== expectedResourceId
  ) {
    throw conflict();
  }
}

function conflict(cause?: unknown): LegacyStaffResourceError {
  return new LegacyStaffResourceError(
    "El estado cambió antes de completar la actualización administrativa.",
    "STAFF_RESOURCE_CONFLICT",
    409,
    cause === undefined ? undefined : { cause },
  );
}
