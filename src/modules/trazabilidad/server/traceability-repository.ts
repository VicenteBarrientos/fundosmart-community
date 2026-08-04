import { getDb } from "@/db";
import type { AccessContext } from "@/src/modules/access/domain/types";
import {
  buildDeaDocumentProjection,
  buildFmaDocumentProjections,
  decideDiioTransition,
  normalizeDiio,
  normalizeEstablishmentIdentity,
  reconcileDiioInventory,
  stableStringify,
  stageDiioImport,
  validateDiioDevice,
} from "../domain/traceability-rules.mjs";
import type {
  DiioDevice,
  DiioDeviceType,
  DiioTransitionAction,
  LivestockEstablishment,
  OfficialDocumentProjection,
  TraceabilityEstablishmentGeoref,
  TraceabilityImportCommitReceipt,
  TraceabilityInventoryEntry,
} from "../domain/types";
import {
  renderTraceabilityDocumentPdf,
  sha256Hex,
  traceabilityDocumentObjectKey,
} from "./official-document-pdf.mjs";
import { adaptCliexDbfForTraceability } from "./traceability-import-adapter.mjs";
import { DbfParseError } from "../../integraciones/cooprinsem/server/dbf-parser.mjs";
import {
  describeSipecAdapter,
  importSipecFile,
  SIPEC_ADAPTER_VERSION,
  SipecAdapterError,
} from "./sipec-adapter.mjs";
import { env } from "cloudflare:workers";

const IMPORT_LIMIT = 250;
const IMPORT_TTL_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_INTERVAL_SECONDS = 6 * 60 * 60;
const STALE_FMA_DRAFT_MS = 7 * 24 * 60 * 60 * 1000;

type SqlBinding = string | number | null;
type Row = Record<string, unknown>;

export type TraceabilityDashboard = {
  field: { id: string; name: string; location: string; isDemo: boolean };
  dataMode: "real" | "demo";
  establishment: (LivestockEstablishment & {
    holderRut: string;
    holderName: string;
    commune: string;
    address: string;
  }) | null;
  devices: DiioDevice[];
  inventory: TraceabilityInventoryEntry[];
  reconciliation: {
    healthy: boolean;
    findings: ReturnType<typeof reconcileDiioInventory>["findings"];
    staleDrafts: number;
    currentYearDeaStored: boolean;
    lastScheduledState: Row | null;
  };
  movements: Row[];
  declarations: Row[];
  imports: Row[];
  readOnly: boolean;
  officialFormatDecision: "pending_confirmation";
  sipecAdapter: ReturnType<typeof describeSipecAdapter>;
};

export class TraceabilityRequestError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = "TRACEABILITY_REQUEST_INVALID",
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = "TraceabilityRequestError";
  }
}

export async function getTraceabilityDashboard(
  actor: AccessContext,
  fieldId: string,
): Promise<TraceabilityDashboard> {
  const access = traceabilityAccess(actor, fieldId, false);
  const client = getDb().$client;
  const field = await client.prepare(`
    SELECT id, name, location, is_demo AS isDemo
    FROM fields
    WHERE id = ? AND organization_id = ? AND ${access.sql}
  `).bind(fieldId, actor.organizationId, ...access.bindings).first<Row>();
  if (!field) throw new TraceabilityRequestError("El fundo no existe o ya no está disponible para tu membresía.", 404, "FIELD_SCOPE_CONFLICT");

  const [establishment, deviceResult, inventory, movementResult, declarationResult, importResult, lastScheduledResult] = await Promise.all([
    client.prepare(`
      SELECT * FROM traceability_establishments
      WHERE organization_id = ? AND field_id = ? AND status = 'active'
      ORDER BY created_at DESC LIMIT 1
    `).bind(actor.organizationId, fieldId).first<Row>(),
    client.prepare(`
      SELECT * FROM traceability_diios
      WHERE organization_id = ? AND field_id = ?
      ORDER BY normalized_number, id
    `).bind(actor.organizationId, fieldId).all<Row>(),
    loadInventory(actor.organizationId, fieldId),
    client.prepare(`
      SELECT id, destination_rup AS destinationRup, departure_at AS departureAt,
        expected_arrival_at AS expectedArrivalAt, reason, status, form_version AS formVersion,
        folio, issued_at AS issuedAt, annulled_at AS annulledAt,
        annulment_reason AS annulmentReason, supersedes_movement_id AS supersedesMovementId, version,
        document_status AS documentStatus, document_sha256 AS documentSha256,
        document_size_bytes AS documentSizeBytes, created_at AS createdAt
      FROM traceability_movements
      WHERE organization_id = ? AND field_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 50
    `).bind(actor.organizationId, fieldId).all<Row>(),
    client.prepare(`
      SELECT id, period, revision, as_of_date AS asOfDate, total_animals AS totalAnimals,
        status, form_version AS formVersion, document_status AS documentStatus,
        document_sha256 AS documentSha256, document_size_bytes AS documentSizeBytes,
        created_at AS createdAt
      FROM traceability_declarations
      WHERE organization_id = ? AND field_id = ?
      ORDER BY period DESC, revision DESC LIMIT 20
    `).bind(actor.organizationId, fieldId).all<Row>(),
    client.prepare(`
      SELECT id, source_kind AS sourceKind, status, row_count AS rowCount,
        result, expires_at AS expiresAt, committed_at AS committedAt, created_at AS createdAt
      FROM traceability_import_stages
      WHERE organization_id = ? AND field_id = ?
      ORDER BY created_at DESC LIMIT 20
    `).bind(actor.organizationId, fieldId).all<Row>(),
    client.prepare(`
      SELECT payload, occurred_at AS occurredAt
      FROM traceability_events
      WHERE organization_id = ? AND field_id = ?
        AND type = 'reconciliation.completed'
        AND entity_type = 'traceability_reconciliation'
      ORDER BY occurred_at DESC, id DESC LIMIT 1
    `).bind(actor.organizationId, fieldId).first<Row>(),
  ]);

  const devices = deviceResult.results.map(toDevice);
  const reconciliation = reconcileDiioInventory({
    organizationId: actor.organizationId,
    fieldId,
    entries: inventory,
    devices,
  });
  const movements = movementResult.results.map(normalizeResultJson);
  const declarations = declarationResult.results.map(normalizeResultJson);
  const imports = importResult.results.map(normalizeResultJson);
  const currentYear = new Date().getUTCFullYear();
  const staleBefore = new Date(Date.now() - STALE_FMA_DRAFT_MS).toISOString();
  const staleDrafts = movements.filter((row) => row.status === "draft" && String(row.createdAt) <= staleBefore).length;
  const lastScheduledState = lastScheduledResult
    ? { ...parseJsonObject(lastScheduledResult.payload), occurredAt: lastScheduledResult.occurredAt }
    : null;
  const isDemo = Boolean(field.isDemo);

  return {
    field: { id: String(field.id), name: String(field.name), location: String(field.location), isDemo },
    dataMode: isDemo ? "demo" : "real",
    establishment: establishment ? toEstablishment(establishment, isDemo) : null,
    devices,
    inventory,
    reconciliation: {
      healthy: reconciliation.validation.valid && reconciliation.findings.length === 0,
      findings: reconciliation.findings,
      staleDrafts,
      currentYearDeaStored: declarations.some((row) => Number(row.period) === currentYear && row.documentStatus === "stored"),
      lastScheduledState,
    },
    movements,
    declarations,
    imports,
    readOnly: actor.role === "viewer",
    officialFormatDecision: "pending_confirmation",
    sipecAdapter: describeSipecAdapter(),
  };
}

export async function saveTraceabilityEstablishment(actor: AccessContext, input: {
  fieldId: string;
  rup: string;
  kind: "dairy" | "beef" | "mixed" | "other";
  holderRut: string;
  holderName: string;
  commune: string;
  address: string;
  idempotencyKey: string;
}): Promise<TraceabilityDashboard> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const client = getDb().$client;
  const field = await client.prepare(`
    SELECT id, is_demo AS isDemo, coordinates FROM fields
    WHERE id = ? AND organization_id = ? AND ${access.sql}
  `).bind(input.fieldId, actor.organizationId, ...access.bindings).first<Row>();
  if (!field) throw scopeConflict();
  if (Boolean(field.isDemo)) throw new TraceabilityRequestError("La cuenta demo usa una identidad ficticia de solo lectura.", 403, "DEMO_WRITE_FORBIDDEN");

  const normalized = normalizeEstablishmentIdentity({
    id: "pending",
    organizationId: actor.organizationId,
    fieldId: input.fieldId,
    rup: input.rup,
    type: input.kind,
    status: "active",
    dataMode: "real",
  });
  if (!normalized.validation.valid || !normalized.establishment) throw validationError("Corrige la identidad del establecimiento.", normalized.validation.errors);
  assertProfile(input);
  const georef = await deriveAuthorizedEstablishmentGeoref(client, actor.organizationId, input.fieldId, field.coordinates);

  const key = requireIdempotencyKey(input.idempotencyKey);
  const operationHash = await sha256Hex(new TextEncoder().encode(stableStringify({
    key,
    organizationId: actor.organizationId,
    fieldId: input.fieldId,
  })));
  const requestHash = await sha256Hex(new TextEncoder().encode(stableStringify({
    operationHash,
    rup: normalized.establishment.displayRup,
    kind: normalized.establishment.type,
    holderRut: input.holderRut.trim(),
    holderName: input.holderName.trim(),
    commune: input.commune.trim(),
    address: input.address.trim(),
    georef,
  })));
  const auditId = `traceability:establishment:saved:audit:${operationHash}`;
  const replay = await client.prepare(`
    SELECT after FROM audit_log
    WHERE id = ? AND organization_id = ? AND field_id = ?
      AND action = 'traceability.establishment.saved'
    LIMIT 1
  `).bind(auditId, actor.organizationId, input.fieldId).first<Row>();
  if (replay) {
    if (parseJsonObject(replay.after).requestHash !== requestHash) {
      throw new TraceabilityRequestError("La clave de idempotencia ya fue usada con otros datos.", 409, "IDEMPOTENCY_COLLISION");
    }
    return getTraceabilityDashboard(actor, input.fieldId);
  }

  const previous = await client.prepare(`
    SELECT * FROM traceability_establishments
    WHERE organization_id = ? AND field_id = ? AND status = 'active' LIMIT 1
  `).bind(actor.organizationId, input.fieldId).first<Row>();
  const id = previous ? String(previous.id) : `traceability-establishment-${operationHash}`;
  const now = new Date().toISOString();
  const domainEventId = `traceability:establishment:saved:domain:${operationHash}`;
  const traceEventId = `traceability:establishment:saved:event:${operationHash}`;
  const establishmentAfter = {
    id,
    rup: normalized.establishment.displayRup,
    type: normalized.establishment.type,
    status: "active",
    holderRut: input.holderRut.trim(),
    holderName: input.holderName.trim(),
    commune: input.commune.trim(),
    address: input.address.trim(),
    georef,
  };
  const auditAfter = { ...establishmentAfter, requestHash };
  const writeGuard = auditGuard(auditId, actor, input.fieldId, "traceability.establishment.saved", id);
  const statements = [
    client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability.establishment.saved', 'traceability_establishment', ?, ?, ?, ?
      WHERE ${access.sql}
    `).bind(
      auditId, actor.organizationId, input.fieldId, actor.email, id,
      previous ? JSON.stringify(normalizeResultJson(previous)) : null,
      JSON.stringify(auditAfter), now, ...access.bindings,
    ),
    previous
      ? client.prepare(`
          UPDATE traceability_establishments
          SET rup = ?, normalized_rup = ?, kind = ?, georef = ?, holder_rut = ?, holder_name = ?, commune = ?, address = ?,
            updated_at = ?, version = version + 1
          WHERE id = ? AND organization_id = ? AND field_id = ? AND status = 'active' AND ${writeGuard.sql}
        `).bind(
          normalized.establishment.displayRup, normalized.establishment.displayRup, normalized.establishment.type, JSON.stringify(georef),
          input.holderRut.trim(), input.holderName.trim(), input.commune.trim(), input.address.trim(), now,
          id, actor.organizationId, input.fieldId, ...writeGuard.bindings,
        )
      : client.prepare(`
          INSERT INTO traceability_establishments (
            id, organization_id, field_id, rup, normalized_rup, kind, status, georef,
            holder_rut, holder_name, commune, address, created_by, created_at, updated_at, version
          ) SELECT ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, 1
          WHERE ${writeGuard.sql}
        `).bind(
          id, actor.organizationId, input.fieldId, normalized.establishment.displayRup,
          normalized.establishment.displayRup, normalized.establishment.type, JSON.stringify(georef), input.holderRut.trim(),
          input.holderName.trim(), input.commune.trim(), input.address.trim(), actor.email, now, now,
          ...writeGuard.bindings,
        ),
    client.prepare(`
      INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
      SELECT ?, ?, ?, 'traceability.establishment.saved.v1', 'traceability_establishment', ?, ?, ?, ?
      WHERE ${writeGuard.sql}
    `).bind(domainEventId, actor.organizationId, input.fieldId, id, JSON.stringify(auditAfter), actor.email, now, ...writeGuard.bindings),
    client.prepare(`
      INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
      SELECT ?, ?, ?, 'establishment.saved', 'traceability_establishment', ?, ?, ?, ?, ?
      WHERE ${writeGuard.sql}
    `).bind(traceEventId, actor.organizationId, input.fieldId, id, JSON.stringify(auditAfter), domainEventId, actor.email, now, ...writeGuard.bindings),
    client.prepare(`
      INSERT INTO scheduled_jobs (
        id, organization_id, field_id, type, payload, status, due_at, interval_seconds,
        attempt_count, created_at, updated_at
      ) SELECT ?, ?, ?, 'traceability.reconcile.v1', ?, 'active', ?, ?, 0, ?, ?
      WHERE ${writeGuard.sql}
      ON CONFLICT(id) DO UPDATE SET status = 'active', payload = excluded.payload, updated_at = excluded.updated_at
    `).bind(
      `traceability-reconcile:${actor.organizationId}:${input.fieldId}`, actor.organizationId, input.fieldId,
      JSON.stringify({ establishmentId: id }), now, RECONCILIATION_INTERVAL_SECONDS, now, now,
      ...writeGuard.bindings,
    ),
  ];
  let results: D1Result<unknown>[];
  try {
    results = await client.batch(statements);
  } catch (cause) {
    const concurrent = await client.prepare(`
      SELECT after FROM audit_log
      WHERE id = ? AND organization_id = ? AND field_id = ?
        AND action = 'traceability.establishment.saved'
      LIMIT 1
    `).bind(auditId, actor.organizationId, input.fieldId).first<Row>();
    if (concurrent && parseJsonObject(concurrent.after).requestHash === requestHash) {
      return getTraceabilityDashboard(actor, input.fieldId);
    }
    if (concurrent) {
      throw new TraceabilityRequestError(
        "La clave de idempotencia ya fue usada con otros datos.",
        409,
        "IDEMPOTENCY_COLLISION",
      );
    }
    throw cause;
  }
  if (results.some((result) => result.meta.changes !== 1)) throw scopeConflict();
  return getTraceabilityDashboard(actor, input.fieldId);
}

export async function addTraceabilityDiio(actor: AccessContext, input: {
  fieldId: string;
  officialNumber: string;
  deviceType: DiioDeviceType;
  rfidId?: string | null;
  idempotencyKey: string;
}): Promise<TraceabilityDashboard> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const establishment = await requireEstablishment(actor, input.fieldId, true);
  const officialNumber = normalizeDiio(input.officialNumber);
  const id = `traceability-diio-${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  const candidate: DiioDevice = {
    id,
    organizationId: actor.organizationId,
    fieldId: input.fieldId,
    officialNumber,
    deviceType: input.deviceType,
    rfidId: input.rfidId?.trim() || null,
    animalId: null,
    status: "available",
    assignedAt: null,
    endedAt: null,
    replacesDeviceId: null,
    replacedByDeviceId: null,
    lastTransitionKey: null,
    version: 1,
  };
  const validation = validateDiioDevice(candidate);
  if (!validation.valid) throw validationError("Corrige el DIIO antes de guardarlo.", validation.errors);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const client = getDb().$client;
  const replay = await client.prepare(`
    SELECT id FROM traceability_diios
    WHERE organization_id = ? AND field_id = ? AND last_transition_key = ?
    LIMIT 1
  `).bind(actor.organizationId, input.fieldId, key).first<Row>();
  if (replay) return getTraceabilityDashboard(actor, input.fieldId);

  const auditId = crypto.randomUUID();
  const domainEventId = crypto.randomUUID();
  const writeGuard = auditGuard(auditId, actor, input.fieldId, "traceability.diio.created", id);
  const payload = { officialNumber, deviceType: input.deviceType, rfidId: candidate.rfidId, status: "available" };
  const results = await client.batch([
    client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability.diio.created', 'traceability_diio', ?, ?, ? WHERE ${access.sql}
    `).bind(auditId, actor.organizationId, input.fieldId, actor.email, id, JSON.stringify(payload), now, ...access.bindings),
    client.prepare(`
      INSERT INTO traceability_diios (
        id, organization_id, field_id, establishment_id, official_number, normalized_number, device_type,
        rfid_id, animal_id, status, assigned_at, ended_at, replaces_device_id, replaced_by_device_id,
        last_transition_key, effective_at, replacement_for_id, status_reason, created_by, created_at, updated_at, version
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'available', NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, ?, ?, ?, 1
      WHERE ${writeGuard.sql}
    `).bind(
      id, actor.organizationId, input.fieldId, establishment.id, officialNumber, officialNumber,
      input.deviceType, candidate.rfidId, key, now, actor.email, now, now, ...writeGuard.bindings,
    ),
    client.prepare(`
      INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
      SELECT ?, ?, ?, 'traceability.diio.created.v1', 'traceability_diio', ?, ?, ?, ? WHERE ${writeGuard.sql}
    `).bind(domainEventId, actor.organizationId, input.fieldId, id, JSON.stringify(payload), actor.email, now, ...writeGuard.bindings),
    client.prepare(`
      INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, diio_id, payload, domain_event_id, actor, occurred_at)
      SELECT ?, ?, ?, 'diio.created', 'traceability_diio', ?, ?, ?, ?, ?, ? WHERE ${writeGuard.sql}
    `).bind(crypto.randomUUID(), actor.organizationId, input.fieldId, id, id, JSON.stringify(payload), domainEventId, actor.email, now, ...writeGuard.bindings),
  ]);
  if (results.some((result) => result.meta.changes !== 1)) throw scopeConflict();
  return getTraceabilityDashboard(actor, input.fieldId);
}

export async function transitionTraceabilityDiio(actor: AccessContext, input: {
  fieldId: string;
  deviceId: string;
  replacementDeviceId?: string;
  action: DiioTransitionAction;
  animalId?: string;
  occurredAt: string;
  idempotencyKey: string;
}): Promise<TraceabilityDashboard> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const client = getDb().$client;
  const currentRow = await client.prepare(`
    SELECT * FROM traceability_diios
    WHERE id = ? AND organization_id = ? AND field_id = ? AND ${access.sql}
  `).bind(input.deviceId, actor.organizationId, input.fieldId, ...access.bindings).first<Row>();
  if (!currentRow) throw new TraceabilityRequestError("El DIIO no existe o no está disponible.", 404, "DIIO_NOT_FOUND");
  const replacementRow = input.replacementDeviceId
    ? await client.prepare(`
        SELECT * FROM traceability_diios
        WHERE id = ? AND organization_id = ? AND field_id = ?
      `).bind(input.replacementDeviceId, actor.organizationId, input.fieldId).first<Row>()
    : null;
  if (input.action === "assign") await requireAnimalScope(actor.organizationId, input.fieldId, input.animalId);
  const current = toDevice(currentRow);
  const replacement = replacementRow ? toDevice(replacementRow) : null;
  const decision = decideDiioTransition({
    current,
    replacement,
    command: {
      action: input.action,
      idempotencyKey: key,
      occurredAt: input.occurredAt,
      actorId: actor.membershipId,
      ...(input.animalId ? { animalId: input.animalId } : {}),
    },
  });
  if (!decision.validation.valid) throw validationError("La transición del DIIO no es válida.", decision.validation.errors);
  if (decision.replay) return getTraceabilityDashboard(actor, input.fieldId);

  const now = new Date().toISOString();
  const auditId = crypto.randomUUID();
  const domainEventId = crypto.randomUUID();
  const writeGuard = auditGuard(auditId, actor, input.fieldId, "traceability.diio.transitioned", input.deviceId);
  const statements = [
    client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability.diio.transitioned', 'traceability_diio', ?, ?, ?, ? WHERE ${access.sql}
    `).bind(
      auditId, actor.organizationId, input.fieldId, actor.email, input.deviceId,
      JSON.stringify(current), JSON.stringify(decision.updates), now, ...access.bindings,
    ),
    ...decision.updates.map((update) => client.prepare(`
      UPDATE traceability_diios
      SET animal_id = ?, status = ?, assigned_at = ?, ended_at = ?, replaces_device_id = ?,
        replaced_by_device_id = ?, last_transition_key = ?, effective_at = ?, replacement_for_id = ?,
        updated_at = ?, version = ?
      WHERE id = ? AND organization_id = ? AND field_id = ? AND version = ? AND ${writeGuard.sql}
    `).bind(
      update.animalId, update.status, update.assignedAt, update.endedAt, update.replacesDeviceId,
      update.replacedByDeviceId, update.lastTransitionKey, input.occurredAt, update.replacesDeviceId,
      now, update.version, update.id, actor.organizationId, input.fieldId, update.version - 1, ...writeGuard.bindings,
    )),
    client.prepare(`
      INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
      SELECT ?, ?, ?, 'traceability.diio.transitioned.v1', 'traceability_diio', ?, ?, ?, ? WHERE ${writeGuard.sql}
    `).bind(domainEventId, actor.organizationId, input.fieldId, input.deviceId, JSON.stringify(decision.event), actor.email, input.occurredAt, ...writeGuard.bindings),
    client.prepare(`
      INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, animal_id, diio_id, payload, domain_event_id, actor, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability_diio', ?, ?, ?, ?, ?, ?, ? WHERE ${writeGuard.sql}
    `).bind(
      crypto.randomUUID(), actor.organizationId, input.fieldId, `diio.${input.action}`, input.deviceId,
      decision.updates[0]?.animalId ?? current.animalId, input.deviceId, JSON.stringify(decision.event), domainEventId,
      actor.email, input.occurredAt, ...writeGuard.bindings,
    ),
  ];
  const results = await client.batch(statements);
  if (results.some((result) => result.meta.changes !== 1)) throw new TraceabilityRequestError("El DIIO cambió mientras se aplicaba la transición. Actualiza e inténtalo nuevamente.", 409, "DIIO_VERSION_CONFLICT");
  return getTraceabilityDashboard(actor, input.fieldId);
}

export async function stageTraceabilityImport(actor: AccessContext, input: {
  fieldId: string;
  sourceKind: "sipec_file" | "cliex_dbf" | "manual_template";
  rows: Array<Record<string, unknown>>;
  idempotencyKey: string;
  sipecAdapterVersion?: string;
  sipecFormatVersion?: string | null;
}): Promise<{ stageId: string; result: Row }> {
  if (!Array.isArray(input.rows) || input.rows.length > IMPORT_LIMIT) {
    throw new TraceabilityRequestError(`Cada etapa admite entre 0 y ${IMPORT_LIMIT} filas.`, 413, "IMPORT_LIMIT_EXCEEDED");
  }
  const access = traceabilityAccess(actor, input.fieldId, true);
  const establishment = await requireEstablishment(actor, input.fieldId, true);
  const key = requireIdempotencyKey(input.idempotencyKey);
  if (input.sourceKind === "sipec_file") {
    try {
      importSipecFile({
        adapterVersion: input.sipecAdapterVersion ?? SIPEC_ADAPTER_VERSION,
        formatVersion: input.sipecFormatVersion,
        rows: input.rows,
      });
    } catch (cause) {
      if (cause instanceof SipecAdapterError) {
        throw new TraceabilityRequestError(cause.message, 409, cause.code, cause.details);
      }
      throw cause;
    }
  }
  const existing = await getDb().$client.prepare(`
    SELECT * FROM traceability_diios WHERE organization_id = ? AND field_id = ?
  `).bind(actor.organizationId, input.fieldId).all<Row>();
  const staged = stageDiioImport({
    organizationId: actor.organizationId,
    fieldId: input.fieldId,
    rup: establishment.displayRup,
    sourceKind: input.sourceKind,
    rows: input.rows,
    existingDevices: existing.results.map(toDevice),
  });
  if (!staged.validation.valid) throw validationError("La importación no pertenece al alcance solicitado.", staged.validation.errors);
  const stageHash = await sha256Hex(new TextEncoder().encode(staged.canonicalStage));
  const client = getDb().$client;
  const idempotencyKeyHash = await importIdempotencyKeyHash("stage", actor.organizationId, input.fieldId, key);
  const requestHash = await sha256Hex(new TextEncoder().encode(stableStringify({
    idempotencyKeyHash,
    sourceKind: input.sourceKind,
    stageHash,
  })));
  const auditId = `traceability:import:staged:audit:${idempotencyKeyHash}`;
  const replay = await loadImportAuditReplay(client, auditId, actor.organizationId, input.fieldId, "traceability.import.staged");
  if (replay) return resolveStagedImportReplay(replay, requestHash, actor.organizationId, input.fieldId, client);

  const existingStage = await loadImportStageByHash(client, actor.organizationId, input.fieldId, stageHash);
  if (existingStage) {
    return bindExistingStagedImport(actor, input.fieldId, access, auditId, requestHash, idempotencyKeyHash, existingStage);
  }

  const id = `traceability-import-${stageHash}`;
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.parse(now) + IMPORT_TTL_MS).toISOString();
  const result = JSON.parse(JSON.stringify(staged)) as Row;
  const auditAfter = {
    schemaVersion: "fundosmart.traceability.import-stage-receipt.v1",
    stageId: id,
    stageHash,
    sourceKind: input.sourceKind,
    requestHash,
    idempotencyKeyHash,
  };
  const writeGuard = auditGuard(auditId, actor, input.fieldId, "traceability.import.staged", id);
  try {
    const results = await client.batch([
      client.prepare(`
        INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
        SELECT ?, ?, ?, ?, 'traceability.import.staged', 'traceability_import_stage', ?, ?, ? WHERE ${access.sql}
      `).bind(auditId, actor.organizationId, input.fieldId, actor.email, id, JSON.stringify(auditAfter), now, ...access.bindings),
      client.prepare(`
        INSERT INTO traceability_import_stages (
          id, organization_id, field_id, establishment_id, source_kind, canonical_stage, stage_hash,
          result, status, row_count, expires_at, committed_at, created_by, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'staged', ?, ?, NULL, ?, ? WHERE ${writeGuard.sql}
      `).bind(
        id, actor.organizationId, input.fieldId, establishment.id, input.sourceKind, staged.canonicalStage,
        stageHash, JSON.stringify(result), staged.summary.total, expiresAt, actor.email, now, ...writeGuard.bindings,
      ),
    ]);
    if (results.some((entry) => entry.meta.changes !== 1)) throw scopeConflict();
    return { stageId: id, result };
  } catch (cause) {
    const concurrentReplay = await loadImportAuditReplay(client, auditId, actor.organizationId, input.fieldId, "traceability.import.staged");
    if (concurrentReplay) return resolveStagedImportReplay(concurrentReplay, requestHash, actor.organizationId, input.fieldId, client);
    const concurrentStage = await loadImportStageByHash(client, actor.organizationId, input.fieldId, stageHash);
    if (concurrentStage) {
      return bindExistingStagedImport(actor, input.fieldId, access, auditId, requestHash, idempotencyKeyHash, concurrentStage);
    }
    throw cause;
  }
}

export async function stageTraceabilityDbfImport(actor: AccessContext, input: {
  fieldId: string;
  filename: string;
  bytes: ArrayBuffer;
  idempotencyKey: string;
}): Promise<{ stageId: string; result: Row; source: Row }> {
  const animalIndex = await loadCliexAnimalIndex(actor.organizationId, input.fieldId);
  let adapted;
  try {
    adapted = adaptCliexDbfForTraceability(input.bytes, {
      ...animalIndex,
      filename: input.filename,
      maxRows: IMPORT_LIMIT,
    });
  } catch (cause) {
    if (cause instanceof DbfParseError || cause instanceof TypeError) {
      throw new TraceabilityRequestError(cause.message, 422, "CLIEX_DBF_INVALID");
    }
    throw cause;
  }
  const staged = await stageTraceabilityImport(actor, {
    fieldId: input.fieldId,
    sourceKind: "cliex_dbf",
    rows: adapted.rows,
    idempotencyKey: input.idempotencyKey,
  });
  return { ...staged, source: adapted.source };
}

export async function commitTraceabilityImport(actor: AccessContext, input: {
  fieldId: string;
  stageId: string;
  idempotencyKey: string;
}): Promise<TraceabilityImportCommitReceipt> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const client = getDb().$client;
  const stage = await client.prepare(`
    SELECT * FROM traceability_import_stages
    WHERE id = ? AND organization_id = ? AND field_id = ? AND ${access.sql}
  `).bind(input.stageId, actor.organizationId, input.fieldId, ...access.bindings).first<Row>();
  if (!stage) throw new TraceabilityRequestError("La etapa de importación no existe.", 404, "IMPORT_STAGE_NOT_FOUND");
  const idempotencyKeyHash = await importIdempotencyKeyHash("commit", actor.organizationId, input.fieldId, key);
  const requestHash = await sha256Hex(new TextEncoder().encode(stableStringify({
    idempotencyKeyHash,
    stageId: input.stageId,
    stageHash: String(stage.stage_hash),
  })));
  const auditId = `traceability:import:committed:audit:${idempotencyKeyHash}`;
  const replay = await loadImportAuditReplay(client, auditId, actor.organizationId, input.fieldId, "traceability.import.committed");
  if (replay) return resolveCommittedImportReplay(replay, requestHash);
  if (stage.status !== "staged" || String(stage.expires_at) <= new Date().toISOString()) {
    if (stage.status === "committed") {
      return bindCommittedImportReplay(actor, input.fieldId, access, auditId, requestHash, idempotencyKeyHash, stage);
    }
    throw new TraceabilityRequestError("La etapa de importación venció; vuelve a conciliar el archivo.", 409, "IMPORT_STAGE_EXPIRED");
  }
  const result = parseJsonObject(stage.result);
  const accepted = Array.isArray(result.accepted) ? result.accepted as Row[] : [];
  for (const row of accepted) await requireAnimalScope(actor.organizationId, input.fieldId, String(row.animalExternalId));
  const now = new Date().toISOString();
  const domainEventId = crypto.randomUUID();
  const receipt: TraceabilityImportCommitReceipt = {
    schemaVersion: "fundosmart.traceability.import-commit-receipt.v1",
    stageId: input.stageId,
    status: "committed",
    accepted: accepted.length,
    committedAt: now,
    requestHash,
    idempotencyKeyHash,
  };
  const writeGuard = auditGuard(auditId, actor, input.fieldId, "traceability.import.committed", input.stageId);
  const statements = [
    client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability.import.committed', 'traceability_import_stage', ?, ?, ? WHERE ${access.sql}
    `).bind(auditId, actor.organizationId, input.fieldId, actor.email, input.stageId, JSON.stringify(receipt), now, ...access.bindings),
    ...accepted.map((row) => {
      const id = `traceability-diio-${crypto.randomUUID()}`;
      return client.prepare(`
        INSERT INTO traceability_diios (
          id, organization_id, field_id, establishment_id, official_number, normalized_number, device_type,
          rfid_id, animal_id, status, assigned_at, ended_at, replaces_device_id, replaced_by_device_id,
          last_transition_key, effective_at, replacement_for_id, status_reason, created_by, created_at, updated_at, version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'assigned', ?, NULL, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?, 1
        WHERE ${writeGuard.sql}
      `).bind(
        id, actor.organizationId, input.fieldId, String(stage.establishment_id), String(row.officialNumber),
        String(row.officialNumber), String(row.deviceType), row.rfidId ? String(row.rfidId) : null,
        String(row.animalExternalId), now, `import:${idempotencyKeyHash}:${String(row.sourceRecordId)}`, now,
        `Importación ${String(stage.source_kind)}`, actor.email, now, now, ...writeGuard.bindings,
      );
    }),
    client.prepare(`
      UPDATE traceability_import_stages SET status = 'committed', committed_at = ?
      WHERE id = ? AND organization_id = ? AND field_id = ? AND status = 'staged' AND expires_at > ? AND ${writeGuard.sql}
    `).bind(now, input.stageId, actor.organizationId, input.fieldId, now, ...writeGuard.bindings),
    client.prepare(`
      INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
      SELECT ?, ?, ?, 'traceability.import.committed.v1', 'traceability_import_stage', ?, ?, ?, ? WHERE ${writeGuard.sql}
    `).bind(domainEventId, actor.organizationId, input.fieldId, input.stageId, JSON.stringify({ accepted: accepted.length }), actor.email, now, ...writeGuard.bindings),
    client.prepare(`
      INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
      SELECT ?, ?, ?, 'import.committed', 'traceability_import_stage', ?, ?, ?, ?, ? WHERE ${writeGuard.sql}
    `).bind(crypto.randomUUID(), actor.organizationId, input.fieldId, input.stageId, JSON.stringify({ accepted: accepted.length }), domainEventId, actor.email, now, ...writeGuard.bindings),
  ];
  try {
    const writes = await client.batch(statements);
    if (writes.some((entry) => entry.meta.changes !== 1)) throw new Error("IMPORT_COMMIT_BATCH_INCOMPLETE");
    return receipt;
  } catch (cause) {
    const concurrentReplay = await loadImportAuditReplay(client, auditId, actor.organizationId, input.fieldId, "traceability.import.committed");
    if (concurrentReplay) return resolveCommittedImportReplay(concurrentReplay, requestHash);
    const concurrentStage = await client.prepare(`
      SELECT * FROM traceability_import_stages
      WHERE id = ? AND organization_id = ? AND field_id = ? AND ${access.sql}
    `).bind(input.stageId, actor.organizationId, input.fieldId, ...access.bindings).first<Row>();
    if (concurrentStage?.status === "committed") {
      return bindCommittedImportReplay(actor, input.fieldId, access, auditId, requestHash, idempotencyKeyHash, concurrentStage);
    }
    throw new TraceabilityRequestError("Los DIIO cambiaron durante la confirmación. Vuelve a conciliar el archivo.", 409, "IMPORT_COMMIT_CONFLICT", cause);
  }
}

export async function generateFmaDrafts(actor: AccessContext, input: {
  fieldId: string;
  animalIds: string[];
  idempotencyKey: string;
  movement: Record<string, unknown>;
}): Promise<{ documents: Row[] }> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const establishment = await requireEstablishment(actor, input.fieldId, true);
  const animalIds = [...new Set((input.animalIds ?? []).map(String).filter(Boolean))];
  if (animalIds.length === 0 || animalIds.length > 450) throw new TraceabilityRequestError("Selecciona entre 1 y 450 animales.");
  const animals = await loadFmaAnimals(actor.organizationId, input.fieldId, animalIds, establishment.displayRup);
  if (animals.length !== animalIds.length) throw new TraceabilityRequestError("Uno o más animales no pertenecen al fundo o no tienen un DIIO activo.", 422, "FMA_INVENTORY_CONFLICT");
  const key = requireIdempotencyKey(input.idempotencyKey);
  const generatedAt = String(input.movement.generatedAt ?? new Date().toISOString());
  const movementId = `fma-${crypto.randomUUID()}`;
  const projectionResult = buildFmaDocumentProjections({
    establishment,
    profile: sagProfile(establishment),
    movement: { ...input.movement, id: movementId, sourceRup: establishment.displayRup },
    animals,
    withdrawals: await loadWithdrawals(animalIds),
    document: { documentId: movementId, revision: 1, generatedAt },
  });
  if (!projectionResult.validation.valid) throw validationError("El borrador FMA tiene datos pendientes.", projectionResult.validation.errors);
  const requestBase = await sha256Hex(new TextEncoder().encode(stableStringify({ key, fieldId: input.fieldId, animalIds: [...animalIds].sort(), movement: input.movement })));
  const documents: Row[] = [];
  for (const [index, projection] of projectionResult.projections.entries()) {
    const requestHash = await sha256Hex(new TextEncoder().encode(`${requestBase}:${index + 1}`));
    documents.push(await storeFmaProjection(actor, input.fieldId, establishment, projection, requestHash, access));
  }
  return { documents };
}

export async function issueFmaDocuments(actor: AccessContext, input: {
  fieldId: string;
  animalIds: string[];
  idempotencyKey: string;
  movement: Record<string, unknown>;
  supersedesDocumentId?: string | null;
}): Promise<{ documents: Row[] }> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const establishment = await requireEstablishment(actor, input.fieldId, true);
  const animalIds = [...new Set((input.animalIds ?? []).map(String).filter(Boolean))];
  if (animalIds.length === 0 || animalIds.length > 450) throw new TraceabilityRequestError("Selecciona entre 1 y 450 animales.");
  if (input.movement.referenceFolio) throw new TraceabilityRequestError("El folio interno lo asigna el servidor.", 400, "FMA_FOLIO_SERVER_ASSIGNED");
  const supersedesDocumentId = input.supersedesDocumentId?.trim() || null;
  if (supersedesDocumentId) await requireAnnulledFma(actor, input.fieldId, supersedesDocumentId);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const requestBase = await sha256Hex(new TextEncoder().encode(stableStringify({
    key,
    fieldId: input.fieldId,
    animalIds: [...animalIds].sort(),
    movement: input.movement,
    supersedesDocumentId,
  })));
  const expectedRequestHashes = await Promise.all(Array.from(
    { length: Math.ceil(animalIds.length / 45) },
    (_, index) => sha256Hex(new TextEncoder().encode(`${requestBase}:${index + 1}`)),
  ));
  const priorDocuments = await Promise.all(expectedRequestHashes.map((requestHash) => loadFmaByRequestHash(actor.organizationId, input.fieldId, requestHash)));
  if (priorDocuments.every((document) => document?.status === "issued" || document?.status === "annulled")) {
    return { documents: priorDocuments as Row[] };
  }
  const animals = await loadFmaAnimals(actor.organizationId, input.fieldId, animalIds, establishment.displayRup);
  if (animals.length !== animalIds.length) throw new TraceabilityRequestError("Uno o más animales no pertenecen al fundo o no tienen un DIIO activo.", 422, "FMA_INVENTORY_CONFLICT");
  const issuedAt = new Date().toISOString();
  const documentId = `fma-${requestBase.slice(0, 32)}`;
  const projectionResult = buildFmaDocumentProjections({
    establishment,
    profile: sagProfile(establishment),
    movement: { ...input.movement, id: documentId, sourceRup: establishment.displayRup, referenceFolio: null },
    animals,
    withdrawals: await loadWithdrawals(animalIds),
    document: { documentId, revision: 1, generatedAt: issuedAt, supersedesDocumentId },
  });
  if (!projectionResult.validation.valid) throw validationError("El FMA no cumple las condiciones de emisión.", projectionResult.validation.errors);

  const documents: Row[] = [];
  for (const [index, draftProjection] of projectionResult.projections.entries()) {
    const requestHash = expectedRequestHashes[index];
    const folio = `FS-FMA-${requestHash.slice(0, 16).toUpperCase()}`;
    const projection = issueProjection(draftProjection, folio);
    documents.push(await storeIssuedFmaProjection(actor, input.fieldId, establishment, projection, requestHash, folio, issuedAt, access));
  }
  return { documents };
}

export async function annulFmaDocument(actor: AccessContext, input: {
  fieldId: string;
  documentId: string;
  reason: string;
  idempotencyKey: string;
  expectedVersion: number;
}): Promise<TraceabilityDashboard> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  await requireEstablishment(actor, input.fieldId, true);
  const documentId = input.documentId.trim();
  const reason = input.reason.trim();
  if (!documentId) throw new TraceabilityRequestError("Selecciona el FMA que deseas anular.");
  if (reason.length < 5 || reason.length > 500) throw new TraceabilityRequestError("La razón de anulación debe tener entre 5 y 500 caracteres.", 400, "FMA_ANNULMENT_REASON_INVALID");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) throw new TraceabilityRequestError("Actualiza el FMA antes de anularlo.", 409, "FMA_VERSION_REQUIRED");
  const key = requireIdempotencyKey(input.idempotencyKey);
  const row = await loadScopedFma(actor, input.fieldId, documentId, true);
  if (!row) throw new TraceabilityRequestError("El FMA no existe o pertenece a otro fundo.", 404, "FMA_NOT_FOUND");
  if (row.status === "annulled") {
    if (String(row.annulmentReason) === reason) return getTraceabilityDashboard(actor, input.fieldId);
    throw new TraceabilityRequestError("El FMA ya fue anulado y su razón es inmutable.", 409, "FMA_ALREADY_ANNULLED");
  }
  if (row.status !== "issued" || row.documentStatus !== "stored") throw new TraceabilityRequestError("Solo se puede anular un FMA emitido y preservado.", 409, "FMA_NOT_ISSUED");
  if (Number(row.version) !== input.expectedVersion) throw new TraceabilityRequestError("El FMA cambió; actualiza antes de anular.", 409, "FMA_VERSION_CONFLICT");

  const requestHash = await sha256Hex(new TextEncoder().encode(stableStringify({ key, fieldId: input.fieldId, documentId, reason })));
  const now = new Date().toISOString();
  const auditId = `traceability:fma:annulled:audit:${requestHash}`;
  const domainEventId = `traceability:fma:annulled:domain:${requestHash}`;
  const traceEventId = `traceability:fma:annulled:event:${requestHash}`;
  const payload = JSON.stringify({ requestHash, reason, folio: row.folio, documentSha256: row.documentSha256 });
  const client = getDb().$client;
  try {
    await client.batch([
      client.prepare(`
        UPDATE traceability_movements
        SET status = 'annulled', annulled_at = ?, annulment_reason = ?, updated_by = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND organization_id = ? AND field_id = ? AND status = 'issued' AND version = ?
          AND document_status = 'stored' AND folio = ? AND document_sha256 = ? AND document_object_key = ?
          AND ${access.sql}
      `).bind(now, reason, actor.email, now, documentId, actor.organizationId, input.fieldId, input.expectedVersion,
        String(row.folio), String(row.documentSha256), String(row.documentObjectKey), ...access.bindings),
      client.prepare(`
        INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
        SELECT ?, ?, ?, ?, 'traceability.fma.annulled', 'traceability_movement', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM traceability_movements WHERE id = ? AND organization_id = ? AND field_id = ?
          AND status = 'annulled' AND version = ? AND annulment_reason = ?)
      `).bind(auditId, actor.organizationId, input.fieldId, actor.email, documentId,
        JSON.stringify({ status: "issued", version: input.expectedVersion }), payload, now,
        documentId, actor.organizationId, input.fieldId, input.expectedVersion + 1, reason),
      client.prepare(`
        INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
        SELECT ?, ?, ?, 'traceability.fma.annulled.v1', 'traceability_movement', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      `).bind(domainEventId, actor.organizationId, input.fieldId, documentId, payload, actor.email, now, auditId),
      client.prepare(`
        INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
        SELECT ?, ?, ?, 'fma.annulled', 'traceability_movement', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM domain_events WHERE id = ?)
      `).bind(traceEventId, actor.organizationId, input.fieldId, documentId, payload, domainEventId, actor.email, now, domainEventId),
      client.prepare(`
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM traceability_movements WHERE id = ? AND organization_id = ? AND field_id = ?
            AND status = 'annulled' AND version = ? AND annulment_reason = ?
        ) AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
          AND EXISTS (SELECT 1 FROM domain_events WHERE id = ?)
          AND EXISTS (SELECT 1 FROM traceability_events WHERE id = ?)
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
      `).bind(documentId, actor.organizationId, input.fieldId, input.expectedVersion + 1, reason, auditId, domainEventId, traceEventId),
    ]);
  } catch (cause) {
    const replay = await loadScopedFma(actor, input.fieldId, documentId, true);
    if (replay?.status === "annulled" && String(replay.annulmentReason) === reason) return getTraceabilityDashboard(actor, input.fieldId);
    throw new TraceabilityRequestError("El FMA cambió durante la anulación. Actualiza e inténtalo nuevamente.", 409, "FMA_VERSION_CONFLICT", cause);
  }
  return getTraceabilityDashboard(actor, input.fieldId);
}

export async function generateDeaDraft(actor: AccessContext, input: {
  fieldId: string;
  period: number;
  asOfDate: string;
  idempotencyKey: string;
}): Promise<{ document: Row }> {
  const access = traceabilityAccess(actor, input.fieldId, true);
  const establishment = await requireEstablishment(actor, input.fieldId, true);
  const inventory = await loadInventory(actor.organizationId, input.fieldId);
  const key = requireIdempotencyKey(input.idempotencyKey);
  const generatedAt = new Date().toISOString();
  const documentId = `dea-${input.period}-${crypto.randomUUID()}`;
  const projectionResult = buildDeaDocumentProjection({
    establishment,
    profile: sagProfile(establishment),
    period: input.period,
    asOfDate: input.asOfDate,
    inventoryEntries: inventory,
    document: { documentId, revision: 1, generatedAt },
  });
  if (!projectionResult.validation.valid || !projectionResult.projection) throw validationError("La DEA no cuadra con el inventario actual.", projectionResult.validation.errors);
  const requestHash = await sha256Hex(new TextEncoder().encode(stableStringify({ key, fieldId: input.fieldId, period: input.period, asOfDate: input.asOfDate })));
  return { document: await storeDeaProjection(actor, input.fieldId, establishment, projectionResult.projection, requestHash, access) };
}

export async function getTraceabilityDocument(actor: AccessContext, input: {
  fieldId: string;
  kind: "fma" | "dea";
  documentId: string;
}): Promise<{ bytes: ArrayBuffer; filename: string }> {
  const access = traceabilityAccess(actor, input.fieldId, false);
  const table = input.kind === "fma" ? "traceability_movements" : "traceability_declarations";
  const issuanceCondition = input.kind === "fma" ? "AND (status <> 'draft' OR folio IS NULL)" : "";
  const row = await getDb().$client.prepare(`
    SELECT status, folio, document_object_key AS objectKey, document_sha256 AS sha256,
      document_size_bytes AS sizeBytes, document_etag AS etag
    FROM ${table}
    WHERE id = ? AND organization_id = ? AND field_id = ? AND document_status = 'stored' ${issuanceCondition} AND ${access.sql}
  `).bind(input.documentId, actor.organizationId, input.fieldId, ...access.bindings).first<Row>();
  if (!row) throw new TraceabilityRequestError("El documento no existe o no está disponible.", 404, "DOCUMENT_NOT_FOUND");
  if (!env.FILES) throw new TraceabilityRequestError("El almacenamiento privado no está disponible.", 503, "STORAGE_UNAVAILABLE");
  const object = await env.FILES.get(String(row.objectKey));
  if (!object || !matchesStoredObject({
    ...row,
    documentId: input.documentId,
    organizationId: actor.organizationId,
    fieldId: input.fieldId,
    state: input.kind === "fma" && (row.status === "issued" || row.status === "annulled") ? "issued_internal_not_sag" : "draft_not_declared",
  }, object)) throw new TraceabilityRequestError("La copia privada del documento no superó la verificación de integridad.", 503, "DOCUMENT_INTEGRITY_MISMATCH");
  const bytes = await object.arrayBuffer();
  if (!(await hasCurrentTraceabilityDocumentAccess(actor, input.fieldId))) {
    throw new TraceabilityRequestError("El documento no existe o no está disponible.", 404, "DOCUMENT_NOT_FOUND");
  }
  return { bytes, filename: `${input.kind}-${input.documentId}.pdf` };
}

async function hasCurrentTraceabilityDocumentAccess(actor: AccessContext, fieldId: string): Promise<boolean> {
  const access = traceabilityAccess(actor, fieldId, false);
  const row = await getDb().$client.prepare(`
    SELECT CASE WHEN EXISTS (
      SELECT 1 FROM fields AS current_field
      WHERE current_field.id = ?
        AND current_field.organization_id = ?
        AND current_field.is_demo = 0
        AND ${access.sql}
    ) THEN 1 ELSE 0 END AS authorized
  `).bind(fieldId, actor.organizationId, ...access.bindings).first<{ authorized: number }>();
  return Number(row?.authorized) === 1;
}

export async function runTraceabilityReconciliationJob(job: {
  organizationId: string | null;
  fieldId: string | null;
  payload: Record<string, unknown>;
}): Promise<void> {
  if (!job.organizationId || !job.fieldId) throw new Error("TRACEABILITY_JOB_SCOPE_REQUIRED");
  const client = getDb().$client;
  const field = await client.prepare(`
    SELECT field.id,
      COALESCE(
        (SELECT enabled FROM organization_feature_flags
          WHERE organization_id = field.organization_id AND field_id = field.id
            AND feature = 'trazabilidad' LIMIT 1),
        (SELECT enabled FROM organization_feature_flags
          WHERE organization_id = field.organization_id AND field_id IS NULL
            AND feature = 'trazabilidad' LIMIT 1),
        0
      ) AS featureEnabled
    FROM fields AS field WHERE field.id = ? AND field.organization_id = ?
  `).bind(job.fieldId, job.organizationId).first<Row>();
  if (!field) throw new Error("TRACEABILITY_JOB_SCOPE_INVALID");
  if (Number(field.featureEnabled) !== 1) return;
  const now = new Date().toISOString();
  const staleBefore = new Date(Date.parse(now) - STALE_FMA_DRAFT_MS).toISOString();
  const currentYear = new Date(now).getUTCFullYear();
  const [inventory, devices, staleFmaResult, deaResult] = await Promise.all([
    loadInventory(job.organizationId, job.fieldId),
    client.prepare(`SELECT * FROM traceability_diios WHERE organization_id = ? AND field_id = ?`)
      .bind(job.organizationId, job.fieldId).all<Row>(),
    client.prepare(`
      SELECT id, created_at AS createdAt, document_status AS documentStatus
      FROM traceability_movements
      WHERE organization_id = ? AND field_id = ? AND status = 'draft' AND created_at <= ?
      ORDER BY created_at, id
      LIMIT 250
    `).bind(job.organizationId, job.fieldId, staleBefore).all<Row>(),
    client.prepare(`
      SELECT id, period, status, document_status AS documentStatus
      FROM traceability_declarations
      WHERE organization_id = ? AND field_id = ? AND (period = ? OR (period < ? AND status = 'draft'))
      ORDER BY period, revision, id
      LIMIT 250
    `).bind(job.organizationId, job.fieldId, currentYear, currentYear).all<Row>(),
  ]);
  const reconciliation = reconcileDiioInventory({
    organizationId: job.organizationId,
    fieldId: job.fieldId,
    entries: inventory,
    devices: devices.results.map(toDevice),
  });
  const eventId = crypto.randomUUID();
  const traceEventId = crypto.randomUUID();
  const currentYearDeaStored = deaResult.results.some((row) => Number(row.period) === currentYear && row.documentStatus === "stored");
  const overdueDeaDrafts = deaResult.results.filter((row) => Number(row.period) < currentYear && row.status === "draft");
  const payload = {
    schemaVersion: "fundosmart.traceability.reconciliation-state.v2",
    findings: reconciliation.findings,
    healthy: reconciliation.validation.valid && reconciliation.findings.length === 0,
    establishmentId: job.payload.establishmentId ?? null,
    fmaDrafts: {
      thresholdDays: STALE_FMA_DRAFT_MS / (24 * 60 * 60 * 1000),
      staleCount: staleFmaResult.results.length,
      staleIds: staleFmaResult.results.map((row) => String(row.id)),
      state: staleFmaResult.results.length > 0 ? "attention_required" : "clear",
    },
    dea: {
      currentPeriod: currentYear,
      currentPeriodState: currentYearDeaStored ? "stored" : "not_generated_or_unstored",
      overdueDraftCount: overdueDeaDrafts.length,
      overdueDraftIds: overdueDeaDrafts.map((row) => String(row.id)),
      overdueBasis: "prior_calendar_period_draft_only",
      officialDeadlineAssumed: false,
      officiallySubmittable: false,
    },
  };
  const serializedPayload = JSON.stringify(payload);
  const enabledFeatureSql = `
    COALESCE(
      (SELECT enabled FROM organization_feature_flags
        WHERE organization_id = ? AND field_id = ? AND feature = 'trazabilidad' LIMIT 1),
      (SELECT enabled FROM organization_feature_flags
        WHERE organization_id = ? AND field_id IS NULL AND feature = 'trazabilidad' LIMIT 1),
      0
    ) = 1
  `;
  const enabledFeatureBindings = [job.organizationId, job.fieldId, job.organizationId];
  await client.batch([
    client.prepare(`
      UPDATE traceability_import_stages SET status = 'expired'
      WHERE organization_id = ? AND field_id = ? AND status = 'staged' AND expires_at <= ?
        AND ${enabledFeatureSql}
    `).bind(job.organizationId, job.fieldId, now, ...enabledFeatureBindings),
    client.prepare(`
      INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
      SELECT ?, ?, ?, 'traceability.reconciliation.completed.v1', 'traceability_reconciliation', ?, ?, 'system:dispatcher', ?
      WHERE ${enabledFeatureSql}
    `).bind(
      eventId, job.organizationId, job.fieldId, `${job.fieldId}:${now.slice(0, 13)}`,
      serializedPayload, now, ...enabledFeatureBindings,
    ),
    client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
      SELECT ?, ?, ?, 'system:dispatcher', 'traceability.reconciliation.completed', 'traceability_reconciliation', ?, ?, ?
      WHERE ${enabledFeatureSql}
    `).bind(
      crypto.randomUUID(), job.organizationId, job.fieldId, eventId, serializedPayload, now,
      ...enabledFeatureBindings,
    ),
    client.prepare(`
      INSERT INTO traceability_events (
        id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at
      ) SELECT ?, ?, ?, 'reconciliation.completed', 'traceability_reconciliation', ?, ?, ?, 'system:dispatcher', ?
      WHERE ${enabledFeatureSql} AND EXISTS (
        SELECT 1 FROM domain_events WHERE id = ? AND organization_id = ? AND field_id = ?
      )
    `).bind(
      traceEventId, job.organizationId, job.fieldId, eventId, serializedPayload, eventId, now,
      ...enabledFeatureBindings, eventId, job.organizationId, job.fieldId,
    ),
  ]);
}

async function storeIssuedFmaProjection(
  actor: AccessContext,
  fieldId: string,
  establishment: LivestockEstablishment & Row,
  inputProjection: OfficialDocumentProjection,
  requestHash: string,
  folio: string,
  issuedAt: string,
  access: SqlCondition,
): Promise<Row> {
  const client = getDb().$client;
  let replay = await loadFmaByRequestHash(actor.organizationId, fieldId, requestHash);
  if (replay?.status === "issued" || replay?.status === "annulled") return replay;
  const projection = replay?.issuedAt
    ? issueProjection({ ...inputProjection, metadata: { ...inputProjection.metadata, generatedAt: String(replay.issuedAt) } }, folio)
    : inputProjection;
  const content = projection.content as Row;
  const movementId = projection.metadata.documentId;
  const bytes = renderTraceabilityDocumentPdf(projection);
  const sha256 = await sha256Hex(bytes);
  const objectKey = traceabilityDocumentObjectKey(projection);
  const animals = Array.isArray(content.animals) ? content.animals as Row[] : [];

  if (!replay) {
    const now = projection.metadata.generatedAt;
    const auditId = `traceability:fma:issue-requested:audit:${requestHash}`;
    const domainEventId = `traceability:fma:issue-requested:domain:${requestHash}`;
    const traceEventId = `traceability:fma:issue-requested:event:${requestHash}`;
    const writeGuard = auditGuard(auditId, actor, fieldId, "traceability.fma.issue_requested", movementId);
    const departure = content.departure as Row;
    const arrival = content.expectedArrival as Row;
    const transport = content.transport as Row;
    const destination = content.destination as Row;
    const payload = JSON.stringify({ requestHash, folio, sha256, objectKey, animalCount: animals.length, state: "issue_requested" });
    const statements = [
      client.prepare(`
        INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
        SELECT ?, ?, ?, ?, 'traceability.fma.issue_requested', 'traceability_movement', ?, ?, ? WHERE ${access.sql}
      `).bind(auditId, actor.organizationId, fieldId, actor.email, movementId, payload, now, ...access.bindings),
      client.prepare(`
        INSERT INTO traceability_movements (
          id, organization_id, field_id, establishment_id, origin_rup, destination_rup,
          departure_at, expected_arrival_at, carrier, carrier_rut, vehicle_plate, trailer_plate,
          reason, status, folio, form_version, request_hash, document_object_key, document_sha256,
          document_etag, document_size_bytes, document_status, supersedes_movement_id, issued_at,
          annulled_at, annulment_reason, created_by, updated_by, created_at, updated_at, version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, NULL, NULL, ?, ?, ?, ?, 1
        WHERE ${writeGuard.sql}
      `).bind(
        movementId, actor.organizationId, fieldId, establishment.id, establishment.displayRup,
        String(destination.rup), `${String(departure.date)}T${String(departure.time)}:00.000Z`,
        `${String(arrival.date)}T${String(arrival.time)}:00.000Z`, String(transport.carrierName),
        String(transport.carrierRut), String(transport.vehiclePlate), transport.trailerPlate ? String(transport.trailerPlate) : null,
        String(content.observations || "Movimiento animal"), folio, projection.metadata.formVersion, requestHash,
        objectKey, sha256, bytes.byteLength, projection.metadata.supersedesDocumentId, issuedAt,
        actor.email, actor.email, now, now, ...writeGuard.bindings,
      ),
      ...animals.map((animal) => client.prepare(`
        INSERT INTO traceability_movement_items (id, organization_id, field_id, movement_id, diio_id, animal_id, created_at)
        SELECT ?, ?, ?, ?, device.id, ?, ?
        FROM traceability_diios AS device
        INNER JOIN livestock_animals AS current_animal ON current_animal.id = device.animal_id AND current_animal.status = 'active'
        INNER JOIN livestock_lots AS current_lot ON current_lot.id = current_animal.lot_id AND current_lot.field_id = ?
        WHERE device.organization_id = ? AND device.field_id = ? AND device.animal_id = ?
          AND device.normalized_number = ? AND device.status = 'assigned' AND ${writeGuard.sql}
      `).bind(
        `traceability-movement-item-${crypto.randomUUID()}`, actor.organizationId, fieldId, movementId,
        String(animal.animalId), now, fieldId, actor.organizationId, fieldId, String(animal.animalId), String(animal.diio),
        ...writeGuard.bindings,
      )),
      client.prepare(`
        INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
        SELECT ?, ?, ?, 'traceability.fma.issue_requested.v1', 'traceability_movement', ?, ?, ?, ? WHERE ${writeGuard.sql}
      `).bind(domainEventId, actor.organizationId, fieldId, movementId, payload, actor.email, now, ...writeGuard.bindings),
      client.prepare(`
        INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
        SELECT ?, ?, ?, 'fma.issue_requested', 'traceability_movement', ?, ?, ?, ?, ? WHERE ${writeGuard.sql}
      `).bind(traceEventId, actor.organizationId, fieldId, movementId, payload, domainEventId, actor.email, now, ...writeGuard.bindings),
    ];
    try {
      const results = await client.batch(statements);
      if (results.some((result) => result.meta.changes !== 1)) throw scopeConflict();
    } catch (cause) {
      replay = await loadFmaByRequestHash(actor.organizationId, fieldId, requestHash);
      if (replay?.status === "issued" || replay?.status === "annulled") return replay;
      if (replay) throw new TraceabilityRequestError("La misma emisión ya está en curso. Reintenta para obtener el resultado inmutable.", 409, "FMA_ISSUE_IN_PROGRESS");
      throw cause;
    }
  }

  await finalizeStoredDocument({ actor, fieldId, table: "traceability_movements", id: movementId, projection, bytes, sha256, objectKey });
  return completeFmaIssuance(actor, fieldId, movementId, requestHash, folio, issuedAt, sha256, objectKey, access);
}

async function completeFmaIssuance(
  actor: AccessContext,
  fieldId: string,
  movementId: string,
  requestHash: string,
  folio: string,
  issuedAt: string,
  sha256: string,
  objectKey: string,
  access: SqlCondition,
): Promise<Row> {
  const current = await loadFmaByRequestHash(actor.organizationId, fieldId, requestHash);
  if (current?.status === "issued" || current?.status === "annulled") return current;
  const auditId = `traceability:fma:issued:audit:${requestHash}`;
  const domainEventId = `traceability:fma:issued:domain:${requestHash}`;
  const traceEventId = `traceability:fma:issued:event:${requestHash}`;
  const payload = JSON.stringify({ requestHash, folio, sha256, objectKey, state: "issued_internal_not_sag" });
  const client = getDb().$client;
  try {
    await client.batch([
      client.prepare(`
        UPDATE traceability_movements
        SET status = 'issued', updated_by = ?, updated_at = ?, version = version + 1
        WHERE id = ? AND organization_id = ? AND field_id = ? AND status = 'draft' AND version = 1
          AND folio = ? AND issued_at = ? AND request_hash = ? AND document_status = 'stored'
          AND document_sha256 = ? AND document_object_key = ? AND ${access.sql}
      `).bind(actor.email, issuedAt, movementId, actor.organizationId, fieldId, folio, issuedAt, requestHash, sha256, objectKey, ...access.bindings),
      client.prepare(`
        INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, occurred_at)
        SELECT ?, ?, ?, ?, 'traceability.fma.issued', 'traceability_movement', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM traceability_movements WHERE id = ? AND organization_id = ? AND field_id = ?
          AND status = 'issued' AND version = 2 AND folio = ? AND issued_at = ?)
      `).bind(auditId, actor.organizationId, fieldId, actor.email, movementId,
        JSON.stringify({ status: "draft", version: 1 }), payload, issuedAt,
        movementId, actor.organizationId, fieldId, folio, issuedAt),
      client.prepare(`
        INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
        SELECT ?, ?, ?, 'traceability.fma.issued.v1', 'traceability_movement', ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      `).bind(domainEventId, actor.organizationId, fieldId, movementId, payload, actor.email, issuedAt, auditId),
      client.prepare(`
        INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
        SELECT ?, ?, ?, 'fma.issued', 'traceability_movement', ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM domain_events WHERE id = ?)
      `).bind(traceEventId, actor.organizationId, fieldId, movementId, payload, domainEventId, actor.email, issuedAt, domainEventId),
      client.prepare(`
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM traceability_movements WHERE id = ? AND organization_id = ? AND field_id = ?
            AND status = 'issued' AND version = 2 AND folio = ? AND issued_at = ?
            AND document_status = 'stored' AND document_sha256 = ? AND document_object_key = ?
        ) AND EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
          AND EXISTS (SELECT 1 FROM domain_events WHERE id = ?)
          AND EXISTS (SELECT 1 FROM traceability_events WHERE id = ?)
        THEN 1 ELSE abs(-9223372036854775807 - 1) END AS complete
      `).bind(movementId, actor.organizationId, fieldId, folio, issuedAt, sha256, objectKey, auditId, domainEventId, traceEventId),
    ]);
  } catch {
    const replay = await loadFmaByRequestHash(actor.organizationId, fieldId, requestHash);
    if (replay?.status === "issued" || replay?.status === "annulled") return replay;
    throw new TraceabilityRequestError("La emisión no pudo completar su transición atómica. Reintenta con la misma clave.", 409, "FMA_ISSUE_CONFLICT");
  }
  const issued = await loadFmaByRequestHash(actor.organizationId, fieldId, requestHash);
  if (!issued) throw scopeConflict();
  return issued;
}

function issueProjection(projection: OfficialDocumentProjection, folio: string): OfficialDocumentProjection {
  const metadata = { ...projection.metadata, state: "issued", folio };
  const content = { ...projection.content, internalFolio: folio, issuanceScope: "fundosmart_internal_not_sag" };
  return { metadata, content, sha256Input: stableStringify({ metadata, content }) } as unknown as OfficialDocumentProjection;
}

async function loadFmaByRequestHash(organizationId: string, fieldId: string, requestHash: string): Promise<Row | null> {
  const row = await getDb().$client.prepare(`
    SELECT id, status, folio, issued_at AS issuedAt, annulled_at AS annulledAt,
      annulment_reason AS annulmentReason, version, request_hash AS requestHash,
      document_status AS documentStatus, document_object_key AS documentObjectKey,
      document_sha256 AS documentSha256, document_size_bytes AS documentSizeBytes,
      document_etag AS documentEtag
    FROM traceability_movements
    WHERE organization_id = ? AND field_id = ? AND request_hash = ?
  `).bind(organizationId, fieldId, requestHash).first<Row>();
  return row ?? null;
}

async function loadScopedFma(actor: AccessContext, fieldId: string, documentId: string, write: boolean): Promise<Row | null> {
  const access = traceabilityAccess(actor, fieldId, write);
  const row = await getDb().$client.prepare(`
    SELECT id, status, folio, issued_at AS issuedAt, annulled_at AS annulledAt,
      annulment_reason AS annulmentReason, version, request_hash AS requestHash,
      document_status AS documentStatus, document_object_key AS documentObjectKey,
      document_sha256 AS documentSha256, document_size_bytes AS documentSizeBytes,
      document_etag AS documentEtag
    FROM traceability_movements
    WHERE id = ? AND organization_id = ? AND field_id = ? AND ${access.sql}
  `).bind(documentId, actor.organizationId, fieldId, ...access.bindings).first<Row>();
  return row ?? null;
}

async function requireAnnulledFma(actor: AccessContext, fieldId: string, documentId: string): Promise<void> {
  const row = await loadScopedFma(actor, fieldId, documentId, true);
  if (!row || row.status !== "annulled") {
    throw new TraceabilityRequestError("La corrección debe referenciar un FMA anulado del mismo fundo.", 409, "FMA_SUPERSEDES_INVALID");
  }
}

async function storeFmaProjection(
  actor: AccessContext,
  fieldId: string,
  establishment: LivestockEstablishment & Row,
  projection: OfficialDocumentProjection,
  requestHash: string,
  access: SqlCondition,
): Promise<Row> {
  const client = getDb().$client;
  const replay = await client.prepare(`
    SELECT id, document_status AS documentStatus, document_object_key AS objectKey,
      document_sha256 AS sha256, document_size_bytes AS sizeBytes, document_etag AS etag
    FROM traceability_movements WHERE organization_id = ? AND field_id = ? AND request_hash = ?
  `).bind(actor.organizationId, fieldId, requestHash).first<Row>();
  if (replay?.documentStatus === "stored") return replay;
  const content = projection.content as Row;
  const movementId = replay ? String(replay.id) : projection.metadata.documentId;
  const bytes = renderTraceabilityDocumentPdf(projection);
  const sha256 = await sha256Hex(bytes);
  const objectKey = traceabilityDocumentObjectKey(projection);
  const animals = Array.isArray(content.animals) ? content.animals as Row[] : [];
  if (!replay) {
    const now = projection.metadata.generatedAt;
    const auditId = crypto.randomUUID();
    const domainEventId = crypto.randomUUID();
    const writeGuard = auditGuard(auditId, actor, fieldId, "traceability.fma.draft_created", movementId);
    const departure = content.departure as Row;
    const arrival = content.expectedArrival as Row;
    const transport = content.transport as Row;
    const destination = content.destination as Row;
    const statements = [
      client.prepare(`
        INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
        SELECT ?, ?, ?, ?, 'traceability.fma.draft_created', 'traceability_movement', ?, ?, ? WHERE ${access.sql}
      `).bind(auditId, actor.organizationId, fieldId, actor.email, movementId, JSON.stringify({ requestHash, sha256, objectKey, state: "draft" }), now, ...access.bindings),
      client.prepare(`
        INSERT INTO traceability_movements (
          id, organization_id, field_id, establishment_id, origin_rup, destination_rup,
          departure_at, expected_arrival_at, carrier, carrier_rut, vehicle_plate, trailer_plate,
          reason, status, folio, form_version, request_hash, document_object_key, document_sha256,
          document_etag, document_size_bytes, document_status, supersedes_movement_id, issued_at,
          annulled_at, annulment_reason, created_by, updated_by, created_at, updated_at, version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, ?, NULL, ?, 'pending', NULL, NULL, NULL, NULL, ?, ?, ?, ?, 1
        WHERE ${writeGuard.sql}
      `).bind(
        movementId, actor.organizationId, fieldId, establishment.id, establishment.displayRup,
        String(destination.rup), `${String(departure.date)}T${String(departure.time)}:00.000Z`,
        `${String(arrival.date)}T${String(arrival.time)}:00.000Z`, String(transport.carrierName),
        String(transport.carrierRut), String(transport.vehiclePlate), transport.trailerPlate ? String(transport.trailerPlate) : null,
        String(content.observations || "Movimiento animal"), projection.metadata.formVersion, requestHash,
        objectKey, sha256, bytes.byteLength, actor.email, actor.email, now, now, ...writeGuard.bindings,
      ),
      ...animals.map((animal) => client.prepare(`
        INSERT INTO traceability_movement_items (id, organization_id, field_id, movement_id, diio_id, animal_id, created_at)
        SELECT ?, ?, ?, ?, device.id, ?, ?
        FROM traceability_diios AS device
        WHERE device.organization_id = ? AND device.field_id = ? AND device.animal_id = ?
          AND device.normalized_number = ? AND device.status = 'assigned' AND ${writeGuard.sql}
      `).bind(
        `traceability-movement-item-${crypto.randomUUID()}`, actor.organizationId, fieldId, movementId,
        String(animal.animalId), now, actor.organizationId, fieldId, String(animal.animalId), String(animal.diio),
        ...writeGuard.bindings,
      )),
      client.prepare(`
        INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
        SELECT ?, ?, ?, 'traceability.fma.draft_created.v1', 'traceability_movement', ?, ?, ?, ? WHERE ${writeGuard.sql}
      `).bind(domainEventId, actor.organizationId, fieldId, movementId, JSON.stringify({ requestHash, sha256, animalCount: animals.length }), actor.email, now, ...writeGuard.bindings),
      client.prepare(`
        INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
        SELECT ?, ?, ?, 'fma.draft_created', 'traceability_movement', ?, ?, ?, ?, ? WHERE ${writeGuard.sql}
      `).bind(crypto.randomUUID(), actor.organizationId, fieldId, movementId, JSON.stringify({ requestHash, sha256, animalCount: animals.length }), domainEventId, actor.email, now, ...writeGuard.bindings),
    ];
    const results = await client.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) throw scopeConflict();
  }
  return finalizeStoredDocument({ actor, fieldId, table: "traceability_movements", id: movementId, projection, bytes, sha256, objectKey });
}

async function storeDeaProjection(
  actor: AccessContext,
  fieldId: string,
  establishment: LivestockEstablishment & Row,
  projection: OfficialDocumentProjection,
  requestHash: string,
  access: SqlCondition,
): Promise<Row> {
  const client = getDb().$client;
  const replay = await client.prepare(`
    SELECT id, document_status AS documentStatus, document_object_key AS objectKey,
      document_sha256 AS sha256, document_size_bytes AS sizeBytes, document_etag AS etag
    FROM traceability_declarations WHERE organization_id = ? AND field_id = ? AND request_hash = ?
  `).bind(actor.organizationId, fieldId, requestHash).first<Row>();
  if (replay?.documentStatus === "stored") return replay;
  const content = projection.content as Row;
  const id = replay ? String(replay.id) : projection.metadata.documentId;
  const bytes = renderTraceabilityDocumentPdf(projection);
  const sha256 = await sha256Hex(bytes);
  const objectKey = traceabilityDocumentObjectKey(projection);
  if (!replay) {
    const now = projection.metadata.generatedAt;
    const auditId = crypto.randomUUID();
    const domainEventId = crypto.randomUUID();
    const writeGuard = auditGuard(auditId, actor, fieldId, "traceability.dea.draft_created", id);
    const counts = Object.fromEntries((Array.isArray(content.rows) ? content.rows as Row[] : []).map((row) => [`${row.speciesCode}:${row.categoryCode}`, Number(row.quantity)]));
    const inventoryHash = await sha256Hex(new TextEncoder().encode(stableStringify(counts)));
    const statements = [
      client.prepare(`
        INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
        SELECT ?, ?, ?, ?, 'traceability.dea.draft_created', 'traceability_declaration', ?, ?, ? WHERE ${access.sql}
      `).bind(auditId, actor.organizationId, fieldId, actor.email, id, JSON.stringify({ requestHash, sha256, objectKey, state: "draft" }), now, ...access.bindings),
      client.prepare(`
        INSERT INTO traceability_declarations (
          id, organization_id, field_id, establishment_id, period, revision, as_of_date, counts,
          total_animals, inventory_hash, request_hash, status, folio, form_version, document_object_key,
          document_sha256, document_etag, document_size_bytes, document_status, declared_at, annulled_at,
          annulment_reason, created_by, updated_by, created_at, updated_at, version
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?, ?, NULL, ?, 'pending', NULL, NULL, NULL, ?, ?, ?, ?, 1
        WHERE ${writeGuard.sql}
      `).bind(
        id, actor.organizationId, fieldId, establishment.id, Number(content.period), projection.metadata.revision,
        String(content.asOfDate), JSON.stringify(counts), Number(content.totalAnimals), inventoryHash, requestHash,
        projection.metadata.formVersion, objectKey, sha256, bytes.byteLength, actor.email, actor.email, now, now,
        ...writeGuard.bindings,
      ),
      client.prepare(`
        INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor, occurred_at)
        SELECT ?, ?, ?, 'traceability.dea.draft_created.v1', 'traceability_declaration', ?, ?, ?, ? WHERE ${writeGuard.sql}
      `).bind(domainEventId, actor.organizationId, fieldId, id, JSON.stringify({ requestHash, sha256, totalAnimals: Number(content.totalAnimals) }), actor.email, now, ...writeGuard.bindings),
      client.prepare(`
        INSERT INTO traceability_events (id, organization_id, field_id, type, entity_type, entity_id, payload, domain_event_id, actor, occurred_at)
        SELECT ?, ?, ?, 'dea.draft_created', 'traceability_declaration', ?, ?, ?, ?, ? WHERE ${writeGuard.sql}
      `).bind(crypto.randomUUID(), actor.organizationId, fieldId, id, JSON.stringify({ requestHash, sha256, totalAnimals: Number(content.totalAnimals) }), domainEventId, actor.email, now, ...writeGuard.bindings),
    ];
    const results = await client.batch(statements);
    if (results.some((result) => result.meta.changes !== 1)) throw scopeConflict();
  }
  return finalizeStoredDocument({ actor, fieldId, table: "traceability_declarations", id, projection, bytes, sha256, objectKey });
}

async function finalizeStoredDocument(input: {
  actor: AccessContext;
  fieldId: string;
  table: "traceability_movements" | "traceability_declarations";
  id: string;
  projection: OfficialDocumentProjection;
  bytes: Uint8Array;
  sha256: string;
  objectKey: string;
}): Promise<Row> {
  if (!env.FILES) throw new TraceabilityRequestError("El almacenamiento privado no está disponible.", 503, "STORAGE_UNAVAILABLE");
  let object = await env.FILES.head(input.objectKey);
  if (!object) {
    await env.FILES.put(input.objectKey, input.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      sha256: input.sha256,
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: `attachment; filename="${input.projection.metadata.kind.toLowerCase()}-${input.id}.pdf"`,
      },
      customMetadata: {
        documentId: input.id,
        documentKind: input.projection.metadata.kind,
        organizationId: input.actor.organizationId,
        fieldId: input.fieldId,
        requestedBy: input.actor.email,
        sha256: input.sha256,
        sizeBytes: String(input.bytes.byteLength),
        state: input.projection.metadata.state === "issued" ? "issued_internal_not_sag" : "draft_not_declared",
        folio: "folio" in input.projection.metadata ? String(input.projection.metadata.folio) : "",
        fakeData: String(input.projection.metadata.fakeData),
      },
    });
    object = await env.FILES.head(input.objectKey);
  }
  const expected = {
    objectKey: input.objectKey,
    documentId: input.id,
    organizationId: input.actor.organizationId,
    fieldId: input.fieldId,
    sha256: input.sha256,
    sizeBytes: input.bytes.byteLength,
    state: input.projection.metadata.state === "issued" ? "issued_internal_not_sag" : "draft_not_declared",
    folio: "folio" in input.projection.metadata ? String(input.projection.metadata.folio) : null,
  };
  if (!object || !matchesStoredObject(expected, object)) {
    throw new TraceabilityRequestError("No fue posible verificar la copia privada inmutable del documento.", 503, "DOCUMENT_INTEGRITY_MISMATCH");
  }
  const access = traceabilityAccess(input.actor, input.fieldId, true);
  const result = await getDb().$client.prepare(`
    UPDATE ${input.table}
    SET document_status = 'stored', document_etag = ?, updated_at = ?
    WHERE id = ? AND organization_id = ? AND field_id = ?
      AND document_status IN ('pending', 'compensation_pending')
      AND document_object_key = ? AND document_sha256 = ? AND document_size_bytes = ?
      AND ${access.sql}
  `).bind(
    object.httpEtag, new Date().toISOString(), input.id, input.actor.organizationId, input.fieldId,
    input.objectKey, input.sha256, input.bytes.byteLength, ...access.bindings,
  ).run();
  if (result.meta.changes !== 1) {
    const replay = await getDb().$client.prepare(`
      SELECT id, document_status AS documentStatus, document_object_key AS objectKey,
        document_sha256 AS sha256, document_size_bytes AS sizeBytes, document_etag AS etag
      FROM ${input.table}
      WHERE id = ? AND organization_id = ? AND field_id = ? AND document_status = 'stored'
    `).bind(input.id, input.actor.organizationId, input.fieldId).first<Row>();
    if (!replay) throw scopeConflict();
    return replay;
  }
  return { id: input.id, documentStatus: "stored", objectKey: input.objectKey, sha256: input.sha256, sizeBytes: input.bytes.byteLength, etag: object.httpEtag };
}

async function importIdempotencyKeyHash(
  operation: "stage" | "commit",
  organizationId: string,
  fieldId: string,
  key: string,
): Promise<string> {
  return sha256Hex(new TextEncoder().encode(stableStringify({
    contract: "fundosmart.traceability.import-idempotency.v1",
    operation,
    organizationId,
    fieldId,
    key,
  })));
}

async function loadImportAuditReplay(
  client: D1Database,
  auditId: string,
  organizationId: string,
  fieldId: string,
  action: "traceability.import.staged" | "traceability.import.committed",
): Promise<Row | null> {
  return client.prepare(`
    SELECT after FROM audit_log
    WHERE id = ? AND organization_id = ? AND field_id = ? AND action = ?
    LIMIT 1
  `).bind(auditId, organizationId, fieldId, action).first<Row>();
}

async function loadImportStageByHash(
  client: D1Database,
  organizationId: string,
  fieldId: string,
  stageHash: string,
): Promise<Row | null> {
  return client.prepare(`
    SELECT * FROM traceability_import_stages
    WHERE organization_id = ? AND field_id = ? AND stage_hash = ?
    LIMIT 1
  `).bind(organizationId, fieldId, stageHash).first<Row>();
}

async function resolveStagedImportReplay(
  replay: Row,
  requestHash: string,
  organizationId: string,
  fieldId: string,
  client: D1Database,
): Promise<{ stageId: string; result: Row }> {
  const receipt = parseJsonObject(replay.after);
  if (receipt.requestHash !== requestHash) throw importIdempotencyCollision();
  const stageId = String(receipt.stageId ?? "");
  const stage = stageId
    ? await client.prepare(`
        SELECT id, result FROM traceability_import_stages
        WHERE id = ? AND organization_id = ? AND field_id = ?
        LIMIT 1
      `).bind(stageId, organizationId, fieldId).first<Row>()
    : null;
  if (!stage) {
    throw new TraceabilityRequestError(
      "La respuesta idempotente de la importación no está disponible.",
      409,
      "IMPORT_IDEMPOTENCY_STATE_MISSING",
    );
  }
  return { stageId, result: parseJsonObject(stage.result) };
}

async function bindExistingStagedImport(
  actor: AccessContext,
  fieldId: string,
  access: SqlCondition,
  auditId: string,
  requestHash: string,
  idempotencyKeyHash: string,
  stage: Row,
): Promise<{ stageId: string; result: Row }> {
  const stageId = String(stage.id);
  const receipt = {
    schemaVersion: "fundosmart.traceability.import-stage-receipt.v1",
    stageId,
    stageHash: String(stage.stage_hash),
    sourceKind: String(stage.source_kind),
    requestHash,
    idempotencyKeyHash,
  };
  const now = new Date().toISOString();
  const client = getDb().$client;
  try {
    const result = await client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability.import.staged', 'traceability_import_stage', ?, ?, ?
      WHERE ${access.sql}
    `).bind(
      auditId, actor.organizationId, fieldId, actor.email, stageId, JSON.stringify(receipt), now,
      ...access.bindings,
    ).run();
    if (result.meta.changes !== 1) throw scopeConflict();
    return { stageId, result: parseJsonObject(stage.result) };
  } catch (cause) {
    const replay = await loadImportAuditReplay(client, auditId, actor.organizationId, fieldId, "traceability.import.staged");
    if (replay) return resolveStagedImportReplay(replay, requestHash, actor.organizationId, fieldId, client);
    throw cause;
  }
}

function resolveCommittedImportReplay(replay: Row, requestHash: string): TraceabilityImportCommitReceipt {
  const receipt = parseJsonObject(replay.after);
  if (receipt.requestHash !== requestHash) throw importIdempotencyCollision();
  if (
    receipt.schemaVersion !== "fundosmart.traceability.import-commit-receipt.v1"
    || receipt.status !== "committed"
    || typeof receipt.stageId !== "string"
    || typeof receipt.committedAt !== "string"
    || typeof receipt.requestHash !== "string"
    || typeof receipt.idempotencyKeyHash !== "string"
    || !Number.isInteger(receipt.accepted)
  ) {
    throw new TraceabilityRequestError(
      "La respuesta idempotente del commit no es válida.",
      409,
      "IMPORT_IDEMPOTENCY_STATE_INVALID",
    );
  }
  return receipt as TraceabilityImportCommitReceipt;
}

async function bindCommittedImportReplay(
  actor: AccessContext,
  fieldId: string,
  access: SqlCondition,
  auditId: string,
  requestHash: string,
  idempotencyKeyHash: string,
  stage: Row,
): Promise<TraceabilityImportCommitReceipt> {
  const stagedResult = parseJsonObject(stage.result);
  const accepted = Array.isArray(stagedResult.accepted) ? stagedResult.accepted.length : 0;
  const committedAt = String(stage.committed_at ?? "");
  if (!committedAt) {
    throw new TraceabilityRequestError("El commit de importación no tiene recibo persistido.", 409, "IMPORT_COMMIT_STATE_INVALID");
  }
  const receipt: TraceabilityImportCommitReceipt = {
    schemaVersion: "fundosmart.traceability.import-commit-receipt.v1",
    stageId: String(stage.id),
    status: "committed",
    accepted,
    committedAt,
    requestHash,
    idempotencyKeyHash,
  };
  const client = getDb().$client;
  try {
    const result = await client.prepare(`
      INSERT INTO audit_log (id, organization_id, field_id, actor, action, entity_type, entity_id, after, occurred_at)
      SELECT ?, ?, ?, ?, 'traceability.import.committed', 'traceability_import_stage', ?, ?, ?
      WHERE ${access.sql}
    `).bind(
      auditId, actor.organizationId, fieldId, actor.email, String(stage.id), JSON.stringify(receipt), committedAt,
      ...access.bindings,
    ).run();
    if (result.meta.changes !== 1) throw scopeConflict();
    return receipt;
  } catch (cause) {
    const replay = await loadImportAuditReplay(client, auditId, actor.organizationId, fieldId, "traceability.import.committed");
    if (replay) return resolveCommittedImportReplay(replay, requestHash);
    throw cause;
  }
}

function importIdempotencyCollision(): TraceabilityRequestError {
  return new TraceabilityRequestError(
    "La clave de idempotencia ya fue usada con otra importación o contenido.",
    409,
    "IDEMPOTENCY_COLLISION",
  );
}

async function deriveAuthorizedEstablishmentGeoref(
  client: D1Database,
  organizationId: string,
  fieldId: string,
  rawFieldBoundary: unknown,
): Promise<TraceabilityEstablishmentGeoref> {
  const fieldBoundary = parseCoordinateRing(rawFieldBoundary);
  const paddockResult = await client.prepare(`
    SELECT paddock.id, paddock.coordinates
    FROM potreros AS paddock
    INNER JOIN fields AS scoped_field
      ON scoped_field.id = paddock.field_id AND scoped_field.organization_id = ?
    WHERE paddock.field_id = ? AND paddock.deleted_at IS NULL AND paddock.archived_at IS NULL
    ORDER BY paddock.id
  `).bind(organizationId, fieldId).all<Row>();
  const activePaddocks = paddockResult.results.map((row) => {
    const geometry = parseStoredPolygon(row.coordinates);
    if (!geometry) {
      throw new TraceabilityRequestError(
        "Un potrero activo contiene una geometría inválida; corrígela antes de registrar el establecimiento.",
        422,
        "ESTABLISHMENT_GEOREF_INVALID",
      );
    }
    return { id: String(row.id), geometry };
  });
  if (!fieldBoundary && activePaddocks.length === 0) {
    throw new TraceabilityRequestError(
      "Registra primero un límite válido del fundo o de al menos un potrero.",
      422,
      "ESTABLISHMENT_GEOREF_REQUIRED",
    );
  }
  return {
    schemaVersion: "fundosmart.traceability.establishment-georef.v1",
    source: "authorized_field_and_active_paddocks",
    fieldId,
    fieldBoundary,
    activePaddocks,
  };
}

function parseStoredPolygon(value: unknown): TraceabilityEstablishmentGeoref["activePaddocks"][number]["geometry"] | null {
  const parsed = parseJsonValue(value);
  const ring = parseCoordinateRing(parsed);
  if (ring) return ring;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const polygon = parsed as Record<string, unknown>;
  const outer = parseCoordinateRing(polygon.outer);
  if (!outer || !Array.isArray(polygon.holes)) return null;
  const holes = polygon.holes.map(parseCoordinateRing);
  if (holes.some((hole) => !hole)) return null;
  return { outer, holes: holes as NonNullable<typeof holes[number]>[] };
}

function parseCoordinateRing(value: unknown): TraceabilityEstablishmentGeoref["fieldBoundary"] {
  const parsed = parseJsonValue(value);
  if (!Array.isArray(parsed) || parsed.length < 3) return null;
  const coordinates = parsed.map((coordinate) => {
    if (!Array.isArray(coordinate) || coordinate.length !== 2) return null;
    const latitude = Number(coordinate[0]);
    const longitude = Number(coordinate[1]);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? [latitude, longitude] as [number, number] : null;
  });
  return coordinates.every((coordinate): coordinate is [number, number] => coordinate !== null) ? coordinates : null;
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

type SqlCondition = { sql: string; bindings: SqlBinding[] };

function traceabilityAccess(actor: AccessContext, fieldId: string, write: boolean): SqlCondition {
  const roleCondition = write
    ? "current_actor.role IN ('owner', 'admin', 'manager', 'operator')"
    : "current_actor.role IN ('owner', 'admin', 'manager', 'operator', 'viewer')";
  return {
    sql: `
      EXISTS (
        SELECT 1 FROM organization_memberships AS current_actor
        WHERE current_actor.id = ?
          AND current_actor.organization_id = ?
          AND current_actor.normalized_email = ?
          AND current_actor.status = 'active'
          AND ${roleCondition}
          AND (
            current_actor.role IN ('owner', 'admin')
            OR EXISTS (
              SELECT 1 FROM membership_field_access AS current_scope
              WHERE current_scope.membership_id = current_actor.id AND current_scope.field_id = ?
            )
          )
      )
      AND EXISTS (SELECT 1 FROM fields AS current_field WHERE current_field.id = ? AND current_field.organization_id = ?)
      AND COALESCE(
        (SELECT enabled FROM organization_feature_flags WHERE organization_id = ? AND field_id = ? AND feature = 'trazabilidad' LIMIT 1),
        (SELECT enabled FROM organization_feature_flags WHERE organization_id = ? AND field_id IS NULL AND feature = 'trazabilidad' LIMIT 1),
        0
      ) = 1
    `,
    bindings: [
      actor.membershipId,
      actor.organizationId,
      actor.email,
      fieldId,
      fieldId,
      actor.organizationId,
      actor.organizationId,
      fieldId,
      actor.organizationId,
    ],
  };
}

function auditGuard(auditId: string, actor: AccessContext, fieldId: string, action: string, entityId: string): SqlCondition {
  return {
    sql: `EXISTS (
      SELECT 1 FROM audit_log AS traceability_guard
      WHERE traceability_guard.id = ? AND traceability_guard.organization_id = ?
        AND traceability_guard.field_id = ? AND traceability_guard.actor = ?
        AND traceability_guard.action = ? AND traceability_guard.entity_id = ?
    )`,
    bindings: [auditId, actor.organizationId, fieldId, actor.email, action, entityId],
  };
}

async function requireEstablishment(actor: AccessContext, fieldId: string, write: boolean) {
  const access = traceabilityAccess(actor, fieldId, write);
  const row = await getDb().$client.prepare(`
    SELECT establishment.*, field.is_demo AS isDemo
    FROM traceability_establishments AS establishment
    INNER JOIN fields AS field ON field.id = establishment.field_id AND field.organization_id = establishment.organization_id
    WHERE establishment.organization_id = ? AND establishment.field_id = ? AND establishment.status = 'active' AND ${access.sql}
    LIMIT 1
  `).bind(actor.organizationId, fieldId, ...access.bindings).first<Row>();
  if (!row) throw new TraceabilityRequestError("Registra primero el establecimiento pecuario del fundo.", 422, "ESTABLISHMENT_REQUIRED");
  if (write && Boolean(row.isDemo)) throw new TraceabilityRequestError("La cuenta demo es de solo lectura.", 403, "DEMO_WRITE_FORBIDDEN");
  return Object.assign(toEstablishment(row, Boolean(row.isDemo)), normalizeResultJson(row));
}

async function loadInventory(organizationId: string, fieldId: string): Promise<TraceabilityInventoryEntry[]> {
  const result = await getDb().$client.prepare(`
    SELECT lot.id AS lotId, lot.category, lot.tracking_mode AS trackingMode, lot.animal_count AS animalCount,
      lot.status AS lotStatus, animal.id AS animalId, animal.tag, animal.sex, animal.status AS animalStatus,
      device.normalized_number AS diio, establishment.normalized_rup AS locationRup
    FROM livestock_lots AS lot
    INNER JOIN fields AS field ON field.id = lot.field_id AND field.organization_id = ?
    LEFT JOIN livestock_animals AS animal ON animal.lot_id = lot.id
    LEFT JOIN traceability_diios AS device ON device.organization_id = ? AND device.field_id = lot.field_id
      AND device.animal_id = animal.id AND device.status = 'assigned'
    LEFT JOIN traceability_establishments AS establishment ON establishment.organization_id = ?
      AND establishment.field_id = lot.field_id AND establishment.status = 'active'
    WHERE lot.field_id = ? AND lot.status = 'active'
    ORDER BY lot.id, animal.id
  `).bind(organizationId, organizationId, organizationId, fieldId).all<Row>();
  const entries: TraceabilityInventoryEntry[] = [];
  const summaryLots = new Set<string>();
  for (const row of result.results) {
    const category = sagCategory(String(row.category), String(row.sex ?? "unknown"));
    if (!category) continue;
    if (row.trackingMode === "summary") {
      const lotId = String(row.lotId);
      if (summaryLots.has(lotId)) continue;
      summaryLots.add(lotId);
      entries.push({
        id: lotId,
        organizationId,
        fieldId,
        trackingMode: "summary",
        animalId: null,
        diio: null,
        speciesCode: category.speciesCode,
        categoryCode: category.categoryCode,
        quantity: Number(row.animalCount),
        status: "active",
        locationRup: row.locationRup ? String(row.locationRup) : null,
      });
    } else if (row.animalId && row.animalStatus === "active") {
      entries.push({
        id: String(row.animalId),
        organizationId,
        fieldId,
        trackingMode: "individual",
        animalId: String(row.animalId),
        diio: row.diio ? String(row.diio) : null,
        speciesCode: category.speciesCode,
        categoryCode: category.categoryCode,
        quantity: 1,
        status: "active",
        locationRup: row.locationRup ? String(row.locationRup) : null,
      });
    }
  }
  return entries;
}

async function loadCliexAnimalIndex(organizationId: string, fieldId: string) {
  const result = await getDb().$client.prepare(`
    SELECT animal.id AS animalId, animal.tag, identifier.kind, identifier.normalized_value AS normalizedValue
    FROM livestock_animals AS animal
    INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
    INNER JOIN fields AS field ON field.id = lot.field_id AND field.organization_id = ?
    LEFT JOIN livestock_animal_identifiers AS identifier
      ON identifier.animal_id = animal.id AND identifier.field_id = lot.field_id AND identifier.valid_to IS NULL
    WHERE lot.field_id = ? AND animal.status = 'active'
  `).bind(organizationId, fieldId).all<Row>();
  const animalIds = new Set<string>();
  const animalIdsByIdentity = new Map<string, Set<string>>();
  for (const row of result.results) {
    const animalId = String(row.animalId);
    animalIds.add(animalId);
    if (row.kind && row.normalizedValue) addAnimalIdentity(animalIdsByIdentity, String(row.kind), String(row.normalizedValue), animalId);
    const normalizedTag = String(row.tag ?? "").trim().normalize("NFKC").toLocaleUpperCase("es");
    if (!normalizedTag) continue;
    for (const kind of ["cooprinsem_numvaca_dv", "cooprinsem_numvaca", "rp", "cooprinsem_nombre", "barcode"]) {
      addAnimalIdentity(animalIdsByIdentity, kind, normalizedTag, animalId);
    }
  }
  return { animalIds, animalIdsByIdentity };
}

function addAnimalIdentity(index: Map<string, Set<string>>, kind: string, normalizedValue: string, animalId: string): void {
  const key = `${kind}:${normalizedValue}`;
  index.set(key, new Set([...(index.get(key) ?? []), animalId]));
}

async function loadFmaAnimals(organizationId: string, fieldId: string, animalIds: string[], locationRup: string): Promise<Row[]> {
  if (animalIds.length === 0) return [];
  const placeholders = animalIds.map(() => "?").join(",");
  const result = await getDb().$client.prepare(`
    SELECT animal.id, animal.status, animal.sex, lot.category, device.normalized_number AS diio
    FROM livestock_animals AS animal
    INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
    INNER JOIN fields AS field ON field.id = lot.field_id AND field.organization_id = ?
    INNER JOIN traceability_diios AS device ON device.organization_id = ? AND device.field_id = lot.field_id
      AND device.animal_id = animal.id AND device.status = 'assigned'
    WHERE lot.field_id = ? AND animal.id IN (${placeholders}) AND animal.status = 'active'
    ORDER BY device.normalized_number, animal.id
  `).bind(organizationId, organizationId, fieldId, ...animalIds).all<Row>();
  return result.results.flatMap((row) => {
    const category = sagCategory(String(row.category), String(row.sex));
    return category ? [{
      id: String(row.id),
      organizationId,
      fieldId,
      diio: String(row.diio),
      status: "active",
      locationRup,
      ...category,
    }] : [];
  });
}

async function loadWithdrawals(animalIds: string[]): Promise<Row[]> {
  if (animalIds.length === 0) return [];
  const placeholders = animalIds.map(() => "?").join(",");
  const result = await getDb().$client.prepare(`
    SELECT animal_id AS animalId, status, withdrawal_milk_until AS withdrawalMilkUntil,
      withdrawal_meat_until AS withdrawalMeatUntil
    FROM livestock_health_events WHERE animal_id IN (${placeholders})
  `).bind(...animalIds).all<Row>();
  return result.results;
}

async function requireAnimalScope(organizationId: string, fieldId: string, animalId: string | undefined): Promise<void> {
  if (!animalId) throw new TraceabilityRequestError("Selecciona un animal.", 400, "ANIMAL_REQUIRED");
  const row = await getDb().$client.prepare(`
    SELECT animal.id
    FROM livestock_animals AS animal
    INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
    INNER JOIN fields AS field ON field.id = lot.field_id
    WHERE animal.id = ? AND lot.field_id = ? AND field.organization_id = ?
  `).bind(animalId, fieldId, organizationId).first<Row>();
  if (!row) throw new TraceabilityRequestError("El animal no pertenece al fundo.", 404, "ANIMAL_SCOPE_CONFLICT");
}

function toEstablishment(row: Row, isDemo: boolean) {
  const identity = normalizeEstablishmentIdentity({
    id: String(row.id),
    organizationId: String(row.organization_id),
    fieldId: String(row.field_id),
    rup: String(row.normalized_rup),
    type: String(row.kind),
    status: String(row.status),
    dataMode: isDemo ? "demo" : "real",
  });
  if (!identity.establishment) throw new Error("TRACEABILITY_ESTABLISHMENT_INVALID");
  return {
    ...identity.establishment,
    georef: parseEstablishmentGeoref(row.georef),
    holderRut: String(row.holder_rut),
    holderName: String(row.holder_name),
    commune: String(row.commune),
    address: String(row.address),
  };
}

function parseEstablishmentGeoref(value: unknown): TraceabilityEstablishmentGeoref | null {
  const parsed = parseJsonValue(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.schemaVersion !== "fundosmart.traceability.establishment-georef.v1"
    || candidate.source !== "authorized_field_and_active_paddocks"
    || typeof candidate.fieldId !== "string"
    || !Array.isArray(candidate.activePaddocks)
  ) return null;
  return parsed as TraceabilityEstablishmentGeoref;
}

function toDevice(row: Row): DiioDevice {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    fieldId: String(row.field_id),
    officialNumber: String(row.normalized_number),
    deviceType: String(row.device_type) as DiioDeviceType,
    rfidId: row.rfid_id ? String(row.rfid_id) : null,
    animalId: row.animal_id ? String(row.animal_id) : null,
    status: String(row.status) as DiioDevice["status"],
    assignedAt: row.assigned_at ? String(row.assigned_at) : null,
    endedAt: row.ended_at ? String(row.ended_at) : null,
    replacesDeviceId: row.replaces_device_id ? String(row.replaces_device_id) : null,
    replacedByDeviceId: row.replaced_by_device_id ? String(row.replaced_by_device_id) : null,
    lastTransitionKey: row.last_transition_key ? String(row.last_transition_key) : null,
    version: Number(row.version),
  };
}

function sagProfile(establishment: LivestockEstablishment & Row) {
  return {
    fieldId: establishment.fieldId,
    rup: establishment.displayRup,
    holderRut: String(establishment.holderRut),
    holderName: String(establishment.holderName),
    commune: String(establishment.commune),
    address: String(establishment.address),
  };
}

function sagCategory(category: string, sex: string): { speciesCode: string; categoryCode: string } | null {
  if (category === "dairy_cow" || category === "dry_cow") return { speciesCode: "bovine", categoryCode: "cow" };
  if (category === "heifer") return { speciesCode: "bovine", categoryCode: "heifer" };
  if (category === "calf") return sex === "unknown" ? null : { speciesCode: "bovine", categoryCode: sex === "female" ? "female_calf" : "male_calf" };
  if (category === "steer") return { speciesCode: "bovine", categoryCode: "steer" };
  if (category === "bull") return { speciesCode: "bovine", categoryCode: "bull" };
  if (category === "sheep") return sex === "unknown" ? null : { speciesCode: "ovine", categoryCode: sex === "male" ? "ram" : "ewe" };
  return null;
}

function matchesStoredObject(expected: Row, object: {
  size: number;
  httpEtag?: string;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
}): boolean {
  const metadata = object.customMetadata;
  const checksum = object.checksums?.sha256 ? hexBytes(object.checksums.sha256) : null;
  return object.size === Number(expected.sizeBytes)
    && metadata?.documentId === String(expected.documentId)
    && metadata.organizationId === String(expected.organizationId)
    && metadata.fieldId === String(expected.fieldId)
    && metadata.sha256 === String(expected.sha256)
    && metadata.sizeBytes === String(expected.sizeBytes)
    && (!expected.state || metadata.state === String(expected.state))
    && (!expected.folio || metadata.folio === String(expected.folio))
    && (!expected.etag || object.httpEtag === String(expected.etag))
    && (!checksum || checksum === String(expected.sha256));
}

function hexBytes(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function assertProfile(input: { holderRut: string; holderName: string; commune: string; address: string }): void {
  const textFields = [input.holderName, input.commune, input.address];
  if (textFields.some((value) => typeof value !== "string" || value.trim().length < 2)) {
    throw new TraceabilityRequestError("Completa titular, comuna y dirección del establecimiento.");
  }
  const rut = input.holderRut.trim().toUpperCase().replace(/[.\s-]/gu, "");
  if (!/^\d{7,8}[0-9K]$/u.test(rut) || !validRut(rut)) throw new TraceabilityRequestError("Ingresa un RUT de titular válido.");
}

function validRut(compact: string): boolean {
  const body = compact.slice(0, -1);
  let factor = 2;
  let sum = 0;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return compact.slice(-1) === expected;
}

function requireIdempotencyKey(value: string): string {
  const key = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(key)) throw new TraceabilityRequestError("La operación requiere una clave de idempotencia válida.");
  return key;
}

function normalizeResultJson(row: Row): Row {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [
    key,
    key === "result" || key === "georef" ? parseJsonObject(value) : value,
  ]));
}

function parseJsonObject(value: unknown): Row {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Row;
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : {};
  } catch {
    return {};
  }
}

function validationError(message: string, issues: unknown): TraceabilityRequestError {
  return new TraceabilityRequestError(message, 422, "TRACEABILITY_VALIDATION_FAILED", issues);
}

function scopeConflict(): TraceabilityRequestError {
  return new TraceabilityRequestError("La membresía, el fundo o la funcionalidad cambió durante la operación.", 409, "FIELD_SCOPE_CONFLICT");
}
