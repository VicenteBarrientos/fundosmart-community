import { normalizeAuthEmail } from "@/app/auth-core.mjs";
import {
  PORTABLE_WORKSPACE_V2_CONTRACT_VERSION,
  PORTABLE_WORKSPACE_V2_FORMAT,
  PORTABLE_WORKSPACE_V2_INTEGRITY,
  PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES,
  PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS,
  PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS,
  PORTABLE_WORKSPACE_V2_POLICY,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTION,
  PORTABLE_WORKSPACE_V2_SCHEMA_VERSION,
  PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
  canonicalPortableWorkspaceJson,
  type PortableWorkspaceV2Sections,
} from "@/src/core/portability/workspace-portable-v2.mjs";
import {
  PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT,
  PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
} from "@/src/core/portability/workspace-portable-v2-projections.mjs";
import type { AccessContext } from "@/src/modules/access/domain/types";

type ExportActor = Readonly<{
  subject: string;
  email: string;
}>;

type SnapshotMetadataRow = {
  organizationId: string;
  organizationName: string;
  membershipId: string;
  role: string;
  fieldIdsJson: string;
};

export type PortableWorkspaceSnapshot = Readonly<{
  organization: Readonly<{ id: string; name: string }>;
  fieldIds: readonly string[];
  sections: PortableWorkspaceV2Sections;
}>;

export class WorkspaceExportPersistenceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 409, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceExportPersistenceError";
    this.code = code;
    this.status = status;
  }
}

const WORKSPACE_EXPORT_SELECTION_PLAN = Object.freeze({
  projectionPolicyFingerprint: "ffd34ac6856f0feb",
  importSections: Object.freeze([
    "import_errors",
    "import_jobs",
    "import_rows",
    "source_records",
  ]),
  importSourceSystem: "cooprinsem",
  sourceRecordExcludedTargetEntities: Object.freeze(["milk_quality_sample"]),
  auditImportEntityType: "import_job",
});

const EMPTY_WORKSPACE_DATA_CANONICAL_BYTES = new TextEncoder().encode(
  canonicalPortableWorkspaceJson(
    Object.fromEntries(
      PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map((section) => [section, []]),
    ),
  ),
).byteLength;
const D1_MAX_STATEMENT_BYTES = 100_000;
const D1_MAX_JSON_OBJECT_PAIRS = 16;
const MAX_PORTABLE_ORGANIZATION_NAME = "\ud800".repeat(300);
const SHA256_PLACEHOLDER = "f".repeat(64);

assertWorkspaceExportSelectionPlan();

export async function loadPortableWorkspaceSnapshot(
  database: D1Database,
  input: {
    actor: ExportActor;
    access: AccessContext;
  },
): Promise<PortableWorkspaceSnapshot> {
  const session = database.withSession("first-primary");
  const statements = [
    workspacePreflightStatement(session, input),
    workspaceMetadataStatement(session, input),
    ...PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map((section) =>
      workspaceSectionStatement(
        session,
        section,
        input,
      )),
  ];
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>(statements);
  } catch (cause) {
    if (
      cause instanceof Error
      && /integer overflow/iu.test(cause.message)
    ) {
      throw new WorkspaceExportPersistenceError(
        "WORKSPACE_EXPORT_SECTION_TOO_LARGE",
        "El espacio supera los límites de la exportación autoservicio.",
        413,
        { cause },
      );
    }
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SNAPSHOT_INCOMPLETE",
      "No fue posible obtener un snapshot completo del espacio.",
      500,
      { cause },
    );
  }
  if (
    results.length !== statements.length
    || results.some(
      (result) => result.success !== true || !Array.isArray(result.results),
    )
  ) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SNAPSHOT_INCOMPLETE",
      "La base de datos no devolvió todas las secciones del espacio.",
      500,
    );
  }
  const preflight = results[0].results[0];
  if (
    Number(preflight?.complete) !== 1
    || Number(preflight?.totalRecordCount) > PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS
    || Number(preflight?.canonicalBytes) > PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES
  ) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SECTION_TOO_LARGE",
      "El espacio supera los límites de la exportación autoservicio.",
      413,
    );
  }
  const metadataRows = results[1].results;
  const metadata = metadataRows.length === 1
    ? metadataRows[0] as SnapshotMetadataRow
    : undefined;
  if (
    !metadata
    || metadata.organizationId !== input.access.organizationId
    || metadata.membershipId !== input.access.membershipId
    || (metadata.role !== "owner" && metadata.role !== "admin")
  ) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_FORBIDDEN",
      "Tu membresía ya no permite exportar este espacio.",
      403,
    );
  }
  const fieldIds = parseFieldIds(metadata.fieldIdsJson);
  const sections: Record<string, readonly Readonly<Record<string, unknown>>[]> = {};
  for (let index = 0; index < PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.length; index += 1) {
    const section = PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES[index];
    const rows = results[index + 2].results;
    if (rows.length > PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS) {
      throw new WorkspaceExportPersistenceError(
        "WORKSPACE_EXPORT_SECTION_TOO_LARGE",
        `La sección ${section} supera el límite autoservicio.`,
        413,
      );
    }
    sections[section] = rows;
  }
  return Object.freeze({
    organization: Object.freeze({
      id: metadata.organizationId,
      name: metadata.organizationName,
    }),
    fieldIds: Object.freeze(fieldIds),
    sections: Object.freeze(sections) as PortableWorkspaceV2Sections,
  });
}

export async function recordPortableWorkspaceExport(
  database: D1Database,
  input: {
    actor: ExportActor;
    access: AccessContext;
    requestId: string;
    generatedAt: string;
    organization: Readonly<{ id: string; name: string }>;
    fieldIds: readonly string[];
    filename: string;
    workspaceSha256: string;
    recordCounts: Readonly<Record<string, number>>;
    totalRecordCount: number;
    beforeCommit?: () => Promise<void>;
    idFactory?: () => string;
  },
): Promise<void> {
  const session = database.withSession("first-primary");
  const fieldIdsJson = canonicalPortableWorkspaceJson(input.fieldIds);
  const payloadJson = canonicalPortableWorkspaceJson({
    filename: input.filename,
    format: PORTABLE_WORKSPACE_V2_FORMAT,
    recordCounts: input.recordCounts,
    schemaVersion: PORTABLE_WORKSPACE_V2_SCHEMA_VERSION,
    totalRecordCount: input.totalRecordCount,
    workspaceSha256: input.workspaceSha256,
  });
  const bindings = [
    input.actor.subject,
    normalizeAuthEmail(input.actor.email),
    input.access.membershipId,
    input.organization.id,
    input.organization.name,
    fieldIdsJson,
    input.idFactory?.() ?? crypto.randomUUID(),
    input.requestId,
    input.workspaceSha256,
    payloadJson,
    input.generatedAt,
  ] as const;
  const stateCondition = currentExportAuthorityCondition();
  const statements = [
    session.prepare(`
      INSERT OR IGNORE INTO personal_data_events (
        id, identity_id, organization_id, request_id, event_type,
        entity_type, entity_id, payload_json, occurred_at
      )
      SELECT
        ?7, ?1, ?4, ?8, 'workspace.exported',
        'workspace_export', ?9, ?10, ?11
      WHERE ${stateCondition}
    `).bind(...bindings),
    session.prepare(`
      SELECT
        CASE WHEN
          ${stateCondition}
          AND EXISTS (
            SELECT 1
            FROM personal_data_events AS event
            WHERE event.identity_id = ?1
              AND event.organization_id = ?4
              AND event.request_id = ?8
              AND event.event_type = 'workspace.exported'
              AND event.entity_type = 'workspace_export'
              AND event.entity_id = ?9
              AND event.payload_json = ?10
              AND event.occurred_at = ?11
          )
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
        ?9 AS workspaceSha256
    `).bind(...bindings),
  ];

  if (input.beforeCommit) await input.beforeCommit();
  let results: D1Result<Record<string, unknown>>[];
  try {
    results = await session.batch<Record<string, unknown>>(statements);
  } catch (cause) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_NOT_RECORDED",
      "El alcance cambió antes de completar la exportación.",
      409,
      { cause },
    );
  }
  const sentinel = results.at(-1)?.results?.[0];
  if (
    Number(sentinel?.complete) !== 1
    || sentinel?.workspaceSha256 !== input.workspaceSha256
  ) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_NOT_RECORDED",
      "No fue posible confirmar la auditoría de la exportación.",
    );
  }
}

function assertWorkspaceExportSelectionPlan(): void {
  if (
    PORTABLE_WORKSPACE_V2_PROJECTION_POLICY_FINGERPRINT
    !== WORKSPACE_EXPORT_SELECTION_PLAN.projectionPolicyFingerprint
  ) {
    selectionPlanMismatch("cambió la huella del catálogo de proyecciones");
  }

  const filteredSections = Object.entries(PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS)
    .filter(([, descriptor]) => descriptor.scope.filters.length > 0)
    .map(([section]) => section)
    .sort();
  if (!sameStringArray(filteredSections, WORKSPACE_EXPORT_SELECTION_PLAN.importSections)) {
    selectionPlanMismatch("cambió el conjunto de secciones filtradas");
  }
  for (const section of WORKSPACE_EXPORT_SELECTION_PLAN.importSections) {
    const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
    const filter = descriptor?.scope.filters[0];
    if (
      !descriptor
      || descriptor.scope.filters.length !== 1
      || !filter
      || filter.table !== "import_jobs"
      || filter.column !== "source_system"
      || filter.operator !== "equals"
      || filter.value !== WORKSPACE_EXPORT_SELECTION_PLAN.importSourceSystem
    ) {
      selectionPlanMismatch(`el filtro declarado de ${section} no está soportado`);
    }
  }

  const polymorphicSections = Object.entries(PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS)
    .filter(([, descriptor]) => descriptor.scope.polymorphicReferences.length > 0)
    .map(([section]) => section)
    .sort();
  if (!sameStringArray(polymorphicSections, ["audit_log", "source_records"])) {
    selectionPlanMismatch("cambió el conjunto de referencias polimórficas");
  }

  const sourceReferences =
    PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS.source_records
      ?.scope.polymorphicReferences;
  const sourceReference = sourceReferences?.[0];
  const excludedSourceTargets = sourceReference
    ? Object.entries(sourceReference.targets)
        .filter(([, target]) => target.disposition === "excluded_target_section")
        .map(([entity]) => entity)
        .sort()
    : [];
  if (
    sourceReferences?.length !== 1
    || !sourceReference
    || sourceReference.discriminatorColumn !== "target_entity"
    || sourceReference.idColumn !== "target_id"
    || sourceReference.unknownHandling !== "reject_unknown"
    || !sameStringArray(
      excludedSourceTargets,
      WORKSPACE_EXPORT_SELECTION_PLAN.sourceRecordExcludedTargetEntities,
    )
  ) {
    selectionPlanMismatch("cambió la política de objetivos de source_records");
  }

  const auditReferences =
    PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS.audit_log
      ?.scope.polymorphicReferences;
  const auditReference = auditReferences?.[0];
  const auditTargets = auditReference
    ? Object.entries(auditReference.targets)
    : [];
  const [auditEntityType, auditTarget] = auditTargets[0] ?? [];
  if (
    auditReferences?.length !== 1
    || !auditReference
    || auditReference.discriminatorColumn !== "entity_type"
    || auditReference.idColumn !== "entity_id"
    || auditReference.unknownHandling
      !== "require_direct_field_or_source_record_for_unknown"
    || auditTargets.length !== 1
    || auditEntityType !== WORKSPACE_EXPORT_SELECTION_PLAN.auditImportEntityType
    || auditTarget?.table !== "import_jobs"
    || auditTarget?.column !== "id"
    || auditTarget?.disposition !== "projected"
  ) {
    selectionPlanMismatch("cambió la política de objetivos de audit_log");
  }
}

function selectionPlanMismatch(detail: string): never {
  throw new WorkspaceExportPersistenceError(
    "WORKSPACE_EXPORT_SCHEMA_MISSING",
    `El selector de exportación no soporta el catálogo vigente: ${detail}.`,
    500,
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function workspacePreflightStatement(
  session: D1DatabaseSession,
  input: {
    actor: ExportActor;
    access: AccessContext;
  },
): D1PreparedStatement {
  const authority = workspaceSnapshotAuthorityCondition();
  const envelopeReserveBytes = maximumPortableEnvelopeReserveBytes(input.access);
  const maxDataCanonicalBytes = Math.max(
    0,
    PORTABLE_WORKSPACE_V2_MAX_CANONICAL_BYTES - envelopeReserveBytes,
  );
  const bindings: (string | number)[] = [
    ...authority.bindings(input),
  ];
  const sectionStats = PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map(
    (section) => {
      const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
      if (!descriptor) {
        throw new WorkspaceExportPersistenceError(
          "WORKSPACE_EXPORT_SCHEMA_MISSING",
          `La sección ${section} no tiene proyección sellada.`,
          500,
        );
      }
      const scope = sectionScopePredicate(section, descriptor.scope.strategy);
      bindings.push(...scope.bindings(input.access.organizationId));
      const rowChunks = portableSqliteRowChunksJson(descriptor);
      return `
        SELECT
          COUNT(*) AS section_record_count,
          COALESCE(SUM(
            length(CAST(scoped_row.row_chunks_json AS BLOB))
            - ${rowChunks.structuralBytes}
            + COALESCE((
              SELECT SUM(
                ${portableSqliteNumericJsonExpansion("portable_node.atom", "portable_node.type")}
              )
              FROM json_tree(scoped_row.row_chunks_json) AS portable_node
              WHERE portable_node.type IN ('integer', 'real')
            ), 0)
          ), 0)
            + CASE WHEN COUNT(*) > 0 THEN COUNT(*) - 1 ELSE 0 END
            AS section_canonical_row_bytes
        FROM (
          SELECT ${rowChunks.sql} AS row_chunks_json
          FROM ${quotedIdentifier(section)} AS root
          WHERE EXISTS (SELECT 1 FROM authorized_workspace)
            AND (${scope.sql})
          LIMIT ${PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS + 1}
        ) AS scoped_row
      `;
    },
  );
  const preflightSql = `
    WITH authorized_workspace AS (
      SELECT 1 AS allowed
      WHERE ${authority.sql}
    ),
    section_stats AS (
      ${sectionStats.join("\nUNION ALL\n")}
    )
    SELECT
      CASE WHEN
        NOT EXISTS (SELECT 1 FROM authorized_workspace)
        OR (
          MAX(section_record_count) <= ${PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS}
          AND SUM(section_record_count) <= ${PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS}
          AND ${EMPTY_WORKSPACE_DATA_CANONICAL_BYTES}
            + SUM(section_canonical_row_bytes)
            <= ${maxDataCanonicalBytes}
        )
      THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete,
      COALESCE(SUM(section_record_count), 0) AS totalRecordCount,
      ${EMPTY_WORKSPACE_DATA_CANONICAL_BYTES}
        + COALESCE(SUM(section_canonical_row_bytes), 0) AS canonicalBytes,
      ${maxDataCanonicalBytes} AS maxDataCanonicalBytes,
      ${envelopeReserveBytes} AS envelopeReserveBytes
    FROM section_stats
  `;
  const statementBytes = utf8ByteLength(preflightSql);
  if (statementBytes > D1_MAX_STATEMENT_BYTES) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCHEMA_MISSING",
      `El preflight portable supera el límite D1: ${statementBytes} bytes.`,
      500,
    );
  }
  return session.prepare(preflightSql).bind(...bindings);
}

function portableSqliteRowChunksJson(
  descriptor: (typeof PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS)[string],
): Readonly<{ sql: string; structuralBytes: number }> {
  const chunks: string[] = [];
  for (
    let offset = 0;
    offset < descriptor.columns.length;
    offset += D1_MAX_JSON_OBJECT_PAIRS
  ) {
    const entries = descriptor.columns
      .slice(offset, offset + D1_MAX_JSON_OBJECT_PAIRS)
      .flatMap((column) => [
        sqliteStringLiteral(column),
        portableSqliteColumnValue(descriptor, column),
      ]);
    chunks.push(`json_object(${entries.join(", ")})`);
  }
  return Object.freeze({
    sql: `json_array(${chunks.join(", ")})`,
    structuralBytes: 2 * chunks.length,
  });
}

function portableSqliteColumnValue(
  descriptor: (typeof PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS)[string],
  column: string,
): string {
  const value = `root.${quotedIdentifier(column)}`;
  if (descriptor.booleanColumns.includes(column)) {
    return `CASE ${value}
      WHEN 0 THEN json('false')
      WHEN 1 THEN json('true')
      ELSE json('invalid-portable-boolean')
    END`;
  }
  if (descriptor.jsonColumns.known.includes(column)) {
    return `CASE WHEN ${value} IS NULL THEN NULL ELSE json(${value}) END`;
  }
  return value;
}

function portableSqliteNumericJsonExpansion(value: string, type: string): string {
  return `(
    ${portableSqliteDynamicNumberByteUpperBound(value, type)}
    - length(CAST(json(${value}) AS BLOB))
  )`;
}

function portableSqliteDynamicNumberByteUpperBound(
  value: string,
  type: string,
): string {
  return `CASE ${type}
    WHEN 'integer' THEN ${portableSqliteNumberByteUpperBound(value, "integer")}
    ELSE ${portableSqliteNumberByteUpperBound(value, "real")}
  END`;
}

function portableSqliteNumberByteUpperBound(
  value: string,
  type: "integer" | "real",
): string {
  if (type === "integer") {
    return `CASE
      WHEN ${value} BETWEEN -9007199254740991 AND 9007199254740991
        THEN length(CAST(${value} AS TEXT))
      ELSE 21
    END`;
  }
  return "24";
}

function maximumPortableEnvelopeReserveBytes(access: AccessContext): number {
  const recordCounts = Object.fromEntries(
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map((section) => [
      section,
      PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS,
    ]),
  );
  const sectionSha256 = Object.fromEntries(
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map((section) => [
      section,
      SHA256_PLACEHOLDER,
    ]),
  );
  const emptyData = Object.fromEntries(
    PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES.map((section) => [section, []]),
  );
  const maximumEnvelope = {
    manifest: {
      format: PORTABLE_WORKSPACE_V2_FORMAT,
      contractVersion: PORTABLE_WORKSPACE_V2_CONTRACT_VERSION,
      schemaVersion: PORTABLE_WORKSPACE_V2_SCHEMA_VERSION,
      generatedAt: "9999-12-31T23:59:59.999Z",
      generatedBy: `identity-sha256:${SHA256_PLACEHOLDER}`,
      encoding: "UTF-8 canonical JSON",
      scope: {
        type: "organization",
        organizationId: access.organizationId,
        organizationName: MAX_PORTABLE_ORGANIZATION_NAME,
        fieldIds: access.fieldIds,
      },
      policy: PORTABLE_WORKSPACE_V2_POLICY,
      rowProjection: PORTABLE_WORKSPACE_V2_ROW_PROJECTION,
      integrity: PORTABLE_WORKSPACE_V2_INTEGRITY,
      sectionOrder: PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES,
      recordCounts,
      sectionSha256,
      totalRecordCount: PORTABLE_WORKSPACE_V2_MAX_TOTAL_RECORDS,
      workspaceSha256: SHA256_PLACEHOLDER,
    },
    data: emptyData,
  };
  return utf8ByteLength(JSON.stringify(maximumEnvelope))
    - EMPTY_WORKSPACE_DATA_CANONICAL_BYTES;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function sqliteStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function workspaceMetadataStatement(
  session: D1DatabaseSession,
  input: {
    actor: ExportActor;
    access: AccessContext;
  },
): D1PreparedStatement {
  const authority = workspaceSnapshotAuthorityCondition();
  return session.prepare(`
    SELECT
      organization.id AS organizationId,
      organization.name AS organizationName,
      membership.id AS membershipId,
      membership.role,
      COALESCE((
        SELECT json_group_array(scoped_field.id)
        FROM (
          SELECT field.id
          FROM fields AS field
          WHERE field.organization_id = organization.id
          ORDER BY field.id
        ) AS scoped_field
      ), '[]') AS fieldIdsJson
    FROM organizations AS organization
    INNER JOIN auth_identities AS identity
      ON identity.id = ?
      AND identity.normalized_email = ?
    INNER JOIN organization_memberships AS membership
      ON membership.id = ?
      AND membership.organization_id = organization.id
      AND membership.normalized_email = identity.normalized_email
      AND membership.role IN ('owner', 'admin')
      AND membership.status = 'active'
      AND membership.closure_request_id IS NULL
    WHERE organization.id = ?
      AND organization.kind <> 'demo'
      AND NOT EXISTS (
        SELECT 1
        FROM account_closure_requests AS closure
        WHERE closure.status = 'grace'
          AND (
            (closure.scope = 'account' AND closure.target_id = identity.id)
            OR (
              closure.scope = 'organization'
              AND closure.target_id = organization.id
            )
          )
      )
      AND (${authority.sql})
    LIMIT 1
  `).bind(
    input.actor.subject,
    normalizeAuthEmail(input.actor.email),
    input.access.membershipId,
    input.access.organizationId,
    ...authority.bindings(input),
  );
}

function workspaceSectionStatement(
  session: D1DatabaseSession,
  section: string,
  input: {
    actor: ExportActor;
    access: AccessContext;
  },
): D1PreparedStatement {
  const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
  if (!descriptor) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCHEMA_MISSING",
      `La sección ${section} no tiene proyección sellada.`,
      500,
    );
  }
  const table = quotedIdentifier(section);
  const selectedColumns = descriptor.columns.map((column) => {
    const identifier = quotedIdentifier(column);
    return `root.${identifier} AS ${identifier}`;
  });
  const sourceSentinel = sourceScopeSentinel(section);
  if (sourceSentinel.sql) selectedColumns.push(sourceSentinel.sql);
  const scope = sectionScopePredicate(section, descriptor.scope.strategy);
  const authority = workspaceSnapshotAuthorityCondition();
  const orderBy = descriptor.orderBy
    .map((column) => `root.${quotedIdentifier(column)}`)
    .join(", ");
  return session.prepare(`
    SELECT ${selectedColumns.join(", ")}
    FROM ${table} AS root
    WHERE (${scope.sql})
      AND (${authority.sql})
    ORDER BY ${orderBy}
    LIMIT ?
  `).bind(
    ...sourceSentinel.bindings(input.access.organizationId),
    ...scope.bindings(input.access.organizationId),
    ...authority.bindings(input),
    PORTABLE_WORKSPACE_V2_MAX_SECTION_RECORDS + 1,
  );
}

function sourceScopeSentinel(section: string): {
  sql: string;
  bindings: (organizationId: string) => readonly string[];
} {
  const sections = new Set([
    "livestock_births",
    "livestock_health_events",
    "livestock_lactations",
    "livestock_milk_controls",
    "livestock_reproductive_events",
  ]);
  if (!sections.has(section)) {
    return { sql: "", bindings: () => [] };
  }
  const targetEntity = {
    livestock_births: "livestock_birth",
    livestock_health_events: "livestock_health_event",
    livestock_lactations: "livestock_lactation",
    livestock_milk_controls: "livestock_milk_control",
    livestock_reproductive_events: "livestock_reproductive_event",
  }[section];
  if (!targetEntity) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCHEMA_MISSING",
      `La sección ${section} no tiene objetivo de linaje sellado.`,
      500,
    );
  }
  return {
    sql: `
      CASE WHEN
        root.source_record_id IS NULL
        OR EXISTS (
          SELECT 1
          FROM source_records AS scoped_source
          INNER JOIN import_rows AS scoped_row
            ON scoped_row.id = scoped_source.import_row_id
            AND scoped_row.import_job_id = scoped_source.import_job_id
          INNER JOIN import_jobs AS scoped_job
            ON scoped_job.id = scoped_source.import_job_id
          WHERE scoped_source.id = root.source_record_id
            AND scoped_job.organization_id = ?
            AND scoped_job.field_id = root.field_id
            AND scoped_source.source_system = scoped_job.source_system
            AND scoped_source.source_table = scoped_job.source_table
            AND scoped_source.target_entity = ?
            AND scoped_source.target_id = root.id
        )
      THEN 1 ELSE 0 END AS "__scope_source_record_valid"
    `,
    bindings: (organizationId) => [organizationId, targetEntity],
  };
}

function sectionScopePredicate(
  section: string,
  strategy: string,
): {
  sql: string;
  bindings: (organizationId: string) => readonly string[];
} {
  const directField = `
    EXISTS (
      SELECT 1 FROM fields AS scoped_field
      WHERE scoped_field.id = root.field_id
        AND scoped_field.organization_id = ?
    )
  `;
  const importJob = `
    EXISTS (
      SELECT 1
      FROM import_jobs AS scoped_job
      WHERE scoped_job.id = root.import_job_id
        AND scoped_job.organization_id = ?
        AND scoped_job.source_system = ?
    )
  `;
  if (strategy === "field_root") {
    return {
      sql: "root.organization_id = ?",
      bindings: (organizationId) => [organizationId],
    };
  }
  if (strategy === "direct_field") {
    return { sql: directField, bindings: (organizationId) => [organizationId] };
  }
  if (strategy === "organization_field_pair") {
    if (section === "import_jobs") {
      return {
        sql: "root.organization_id = ? AND root.source_system = ?",
        bindings: (organizationId) => [
          organizationId,
          WORKSPACE_EXPORT_SELECTION_PLAN.importSourceSystem,
        ],
      };
    }
    return {
      sql: "root.organization_id = ?",
      bindings: (organizationId) => [organizationId],
    };
  }
  if (strategy === "through_paddock") {
    return {
      sql: `
        EXISTS (
          SELECT 1
          FROM potreros AS scoped_paddock
          INNER JOIN fields AS scoped_field
            ON scoped_field.id = scoped_paddock.field_id
          WHERE scoped_paddock.id = root.paddock_id
            AND scoped_field.organization_id = ?
        )
      `,
      bindings: (organizationId) => [organizationId],
    };
  }
  if (strategy === "through_lot") {
    return throughLotScope("root.lot_id");
  }
  if (strategy === "through_animal") {
    return {
      sql: `
        EXISTS (
          SELECT 1
          FROM livestock_animals AS scoped_animal
          INNER JOIN livestock_lots AS scoped_lot
            ON scoped_lot.id = scoped_animal.lot_id
          INNER JOIN fields AS scoped_field
            ON scoped_field.id = scoped_lot.field_id
          WHERE scoped_animal.id = root.animal_id
            AND scoped_field.organization_id = ?
        )
      `,
      bindings: (organizationId) => [organizationId],
    };
  }
  if (strategy === "through_birth") {
    return {
      sql: `
        EXISTS (
          SELECT 1
          FROM livestock_births AS scoped_birth
          INNER JOIN fields AS scoped_field
            ON scoped_field.id = scoped_birth.field_id
          WHERE scoped_birth.id = root.birth_id
            AND scoped_field.organization_id = ?
        )
      `,
      bindings: (organizationId) => [organizationId],
    };
  }
  if (strategy === "through_import_job") {
    return {
      sql: importJob,
      bindings: (organizationId) => [
        organizationId,
        WORKSPACE_EXPORT_SELECTION_PLAN.importSourceSystem,
      ],
    };
  }
  if (strategy === "through_import_job_and_row") {
    return {
      sql: section === "source_records"
        ? `${importJob} AND root.target_entity <> ?`
        : importJob,
      bindings: (organizationId) => [
        organizationId,
        WORKSPACE_EXPORT_SELECTION_PLAN.importSourceSystem,
        ...(section === "source_records"
          ? WORKSPACE_EXPORT_SELECTION_PLAN.sourceRecordExcludedTargetEntities
          : []),
      ],
    };
  }
  if (strategy === "organization_expense") {
    return {
      sql: "root.organization_id = ?",
      bindings: (organizationId) => [organizationId],
    };
  }
  if (strategy === "organization_partner_reference") {
    return {
      sql: `
        root.organization_id = ?
        AND EXISTS (
          SELECT 1 FROM livestock_expenses AS scoped_expense
          WHERE scoped_expense.paid_by_id = root.id
            AND scoped_expense.organization_id = ?
        )
      `,
      bindings: (organizationId) => [organizationId, organizationId],
    };
  }
  if (strategy === "lot_membership") {
    return throughLotScope("root.lot_id");
  }
  if (strategy === "organization_audit") {
    return {
      sql: `
        root.organization_id = ?
        AND (
          (
            root.entity_type <> ?
            AND root.field_id IS NOT NULL
          )
          OR (
            root.entity_type = ?
            AND EXISTS (
              SELECT 1
              FROM import_jobs AS scoped_job
              WHERE scoped_job.id = root.entity_id
                AND scoped_job.organization_id = ?
                AND scoped_job.source_system = ?
                AND (
                  root.field_id IS NULL
                  OR root.field_id = scoped_job.field_id
                )
            )
          )
        )
      `,
      bindings: (organizationId) => [
        organizationId,
        WORKSPACE_EXPORT_SELECTION_PLAN.auditImportEntityType,
        WORKSPACE_EXPORT_SELECTION_PLAN.auditImportEntityType,
        organizationId,
        WORKSPACE_EXPORT_SELECTION_PLAN.importSourceSystem,
      ],
    };
  }
  throw new WorkspaceExportPersistenceError(
    "WORKSPACE_EXPORT_SCOPE_MISSING",
    `La estrategia ${strategy} de ${section} no está implementada.`,
    500,
  );
}

function throughLotScope(lotExpression: string): {
  sql: string;
  bindings: (organizationId: string) => readonly string[];
} {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_lots AS scoped_lot
        INNER JOIN fields AS scoped_field
          ON scoped_field.id = scoped_lot.field_id
        WHERE scoped_lot.id = ${lotExpression}
          AND scoped_field.organization_id = ?
      )
    `,
    bindings: (organizationId) => [organizationId],
  };
}

function workspaceSnapshotAuthorityCondition(): {
  sql: string;
  bindings: (input: {
    actor: ExportActor;
    access: AccessContext;
  }) => readonly string[];
} {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM auth_identities AS identity
        WHERE identity.id = ?
          AND identity.normalized_email = ?
      )
      AND EXISTS (
        SELECT 1
        FROM organization_memberships AS membership
        WHERE membership.id = ?
          AND membership.organization_id = ?
          AND membership.normalized_email = ?
          AND membership.role IN ('owner', 'admin')
          AND membership.status = 'active'
          AND membership.closure_request_id IS NULL
      )
      AND EXISTS (
        SELECT 1
        FROM organizations AS organization
        WHERE organization.id = ?
          AND organization.kind <> 'demo'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM account_closure_requests AS closure
        WHERE closure.status = 'grace'
          AND (
            (closure.scope = 'account' AND closure.target_id = ?)
            OR (closure.scope = 'organization' AND closure.target_id = ?)
          )
      )
      AND (${exactWorkspaceFieldSetCondition("?", "?")})
    `,
    bindings: (input) => {
      const email = normalizeAuthEmail(input.actor.email);
      const fieldIdsJson = canonicalPortableWorkspaceJson(
        [...input.access.fieldIds].sort(),
      );
      return [
        input.actor.subject,
        email,
        input.access.membershipId,
        input.access.organizationId,
        email,
        input.access.organizationId,
        input.actor.subject,
        input.access.organizationId,
        fieldIdsJson,
        input.access.organizationId,
        fieldIdsJson,
        input.access.organizationId,
      ];
    },
  };
}

function currentExportAuthorityCondition(): string {
  return `
    EXISTS (
      SELECT 1
      FROM auth_identities AS identity
      WHERE identity.id = ?1
        AND identity.normalized_email = ?2
    )
    AND EXISTS (
      SELECT 1
      FROM organization_memberships AS membership
      INNER JOIN auth_identities AS identity
        ON identity.id = ?1
        AND identity.normalized_email = ?2
      WHERE membership.id = ?3
        AND membership.organization_id = ?4
        AND membership.normalized_email = identity.normalized_email
        AND membership.role IN ('owner', 'admin')
        AND membership.status = 'active'
        AND membership.closure_request_id IS NULL
    )
    AND EXISTS (
      SELECT 1
      FROM organizations AS organization
      WHERE organization.id = ?4
        AND organization.name = ?5
        AND organization.kind <> 'demo'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM account_closure_requests AS closure
      WHERE closure.status = 'grace'
        AND (
          (closure.scope = 'account' AND closure.target_id = ?1)
          OR (closure.scope = 'organization' AND closure.target_id = ?4)
      )
    )
    AND (${exactWorkspaceFieldSetCondition("?6", "?4")})
  `;
}

function exactWorkspaceFieldSetCondition(
  fieldIdsJsonExpression: string,
  organizationIdExpression: string,
): string {
  return `
    json_type(${fieldIdsJsonExpression}) = 'array'
    AND (
      SELECT
        COUNT(*) = (
          SELECT COUNT(*)
          FROM fields AS current_field
          WHERE current_field.organization_id = ${organizationIdExpression}
        )
        AND COUNT(*) = COUNT(
          DISTINCT CASE
            WHEN expected_field.type = 'text' THEN expected_field.value
          END
        )
        AND COUNT(*) = COUNT(current_field.id)
      FROM json_each(${fieldIdsJsonExpression}) AS expected_field
      LEFT JOIN fields AS current_field
        ON current_field.organization_id = ${organizationIdExpression}
        AND current_field.id = expected_field.value
    )
  `;
}

function parseFieldIds(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCOPE_INVALID",
      "El snapshot no devolvió un alcance de fundos válido.",
      500,
      { cause },
    );
  }
  if (
    !Array.isArray(parsed)
    || parsed.some((fieldId) => typeof fieldId !== "string")
    || new Set(parsed).size !== parsed.length
  ) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCOPE_INVALID",
      "El snapshot no devolvió un alcance de fundos válido.",
      500,
    );
  }
  const sorted = [...parsed].sort(compareCodePoint);
  if (!sorted.every((fieldId, index) => fieldId === parsed[index])) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCOPE_INVALID",
      "El snapshot de fundos no es canónico.",
      500,
    );
  }
  return sorted;
}

function quotedIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(value)) {
    throw new WorkspaceExportPersistenceError(
      "WORKSPACE_EXPORT_SCHEMA_INVALID",
      "El catálogo portable contiene un identificador SQL inválido.",
      500,
    );
  }
  return `"${value}"`;
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
