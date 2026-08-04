import { getDb } from "@/db";
import type { AccessContext, OrganizationMembershipRole } from "@/src/modules/access/domain/types";
import { PastureDomainError } from "@/src/modules/praderas/domain/pasture-planning.mjs";
import {
  PASTURE_CDSE_PROVIDER_KEY,
  type NdviCanonicalObservation,
  type PastureObservationResult,
} from "@/src/modules/praderas/domain/types";
import { createCdseNdviClient } from "@/src/modules/potreros/ndvi/cdse-client";
import type { NdviStatisticalNoData } from "@/src/modules/potreros/ndvi/sentinel";
import { listPaddockNdviCandidates } from "@/src/modules/potreros/server/paddock-ndvi-repository";
import type { ScheduledJobRecord } from "@/src/modules/sync/domain/types";
import {
  getActiveNdviCalibration,
  getPastureProviderDecision,
  getStoredPastureNdviNoDataReplay,
  getStoredPastureObservationReplay,
  type PastureNdviNoDataRecord,
  recordPastureNdviNoData,
  recordNdviPastureObservation,
} from "./pasture-repository";

export type NdviConnectorRequest = {
  organizationId: string;
  fieldId: string;
  paddockId: string;
  from: string;
  to: string;
  expectedGeometrySnapshotToken?: string;
};

export type NdviConnectorObservation = {
  status: "ok";
  capturedAt: string;
  meanNdvi: number;
  usablePixelPercent: number;
  rawDocument: unknown;
} | NdviStatisticalNoData;

export interface NdviConnector {
  readonly providerKey: string;
  fetchPaddockObservation(request: NdviConnectorRequest): Promise<NdviConnectorObservation>;
}

type CdsePastureConnectorDependencies = {
  createClient?: typeof createCdseNdviClient;
  listCandidates?: typeof listPaddockNdviCandidates;
};

export function createCdsePastureNdviConnector(
  actor: AccessContext,
  credentials: { clientId?: string; clientSecret?: string },
  dependencies: CdsePastureConnectorDependencies = {},
): NdviConnector {
  const clientId = credentials.clientId?.trim() ?? "";
  const clientSecret = credentials.clientSecret?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new PastureDomainError("La ingesta NDVI no tiene credenciales CDSE configuradas.", "CDSE_NOT_CONFIGURED");
  }
  const client = (dependencies.createClient ?? createCdseNdviClient)({ clientId, clientSecret });
  return Object.freeze({
    providerKey: PASTURE_CDSE_PROVIDER_KEY,
    async fetchPaddockObservation(request: NdviConnectorRequest): Promise<NdviConnectorObservation> {
      if (request.organizationId !== actor.organizationId || !actor.fieldIds.includes(request.fieldId)) {
        throw new PastureDomainError("El potrero NDVI queda fuera del alcance autorizado.", "FIELD_SCOPE_CONFLICT");
      }
      const candidates = await (dependencies.listCandidates ?? listPaddockNdviCandidates)(request.fieldId, actor);
      const candidate = candidates.find((item) => item.paddockId === request.paddockId);
      if (!candidate) throw new PastureDomainError("El potrero NDVI no existe o quedó fuera de alcance.", "FIELD_SCOPE_CONFLICT");
      if (
        request.expectedGeometrySnapshotToken
        && candidate.geometrySnapshotToken !== request.expectedGeometrySnapshotToken
      ) {
        throw new PastureDomainError("La geometría del potrero cambió antes de consultar CDSE.", "FIELD_SCOPE_CONFLICT");
      }
      const result = await client.fetchNdvi({ rings: candidate.rings, from: request.from, to: request.to });
      if (result.status === "no_data") return result;
      return {
        status: "ok",
        capturedAt: result.observedAt,
        meanNdvi: result.meanNdvi,
        usablePixelPercent: roundPercent(100 - result.cloudPct),
        rawDocument: {
          schemaVersion: "fundosmart.pasture.cdse-statistics.v1",
          contentKind: "statistics_json",
          providerKey: PASTURE_CDSE_PROVIDER_KEY,
          request: {
            fieldId: request.fieldId,
            paddockId: request.paddockId,
            from: request.from,
            to: request.to,
            geometrySnapshotToken: candidate.geometrySnapshotToken,
          },
          response: result,
          rasterObject: null,
        },
      };
    },
  });
}

export async function collectNdviWithConnector(
  input: {
    operationId: string;
    fieldId: string;
    paddockId: string;
    from: string;
    to: string;
    geometrySnapshotToken?: string;
  },
  actor: AccessContext,
  connector: NdviConnector,
): Promise<{
  status: "stored";
  observation: PastureObservationResult;
  calibrationId: string;
} | {
  status: "no_data";
  result: NdviStatisticalNoData;
  calibrationId: string;
}> {
  const decision = await getPastureProviderDecision(input.fieldId, actor);
  if (decision.mode !== "configured" || decision.providerKey !== connector.providerKey) {
    throw new PastureDomainError(
      "El conector recibido no coincide con la decisión explícita de proveedor del fundo.",
      "NDVI_PROVIDER_UNCONFIGURED",
    );
  }
  const calibration = await getActiveNdviCalibration(input.fieldId, connector.providerKey, actor);
  if (!calibration) {
    throw new PastureDomainError("No existe una calibración NDVI activa para este fundo.", "NDVI_CALIBRATION_REQUIRED");
  }
  const observation = await connector.fetchPaddockObservation({
    organizationId: actor.organizationId,
    fieldId: input.fieldId,
    paddockId: input.paddockId,
    from: input.from,
    to: input.to,
    expectedGeometrySnapshotToken: input.geometrySnapshotToken,
  });
  if (observation.status === "no_data") {
    return { status: "no_data", result: observation, calibrationId: calibration.id };
  }
  const canonical: NdviCanonicalObservation = {
    operationId: input.operationId,
    fieldId: input.fieldId,
    paddockId: input.paddockId,
    providerKey: connector.providerKey,
    capturedAt: observation.capturedAt,
    meanNdvi: observation.meanNdvi,
    usablePixelPercent: observation.usablePixelPercent,
    rawDocument: observation.rawDocument,
  };
  return {
    status: "stored",
    observation: await recordNdviPastureObservation(canonical, calibration, actor),
    calibrationId: calibration.id,
  };
}

export type PastureNdviCollectionJobResult = {
  status: "stored";
  observation: PastureObservationResult;
  noData: null;
  idempotentReplay: boolean;
} | {
  status: "no_data";
  observation: null;
  noData: PastureNdviNoDataRecord;
  idempotentReplay: boolean;
};

export async function runPastureNdviCollectionJob(
  job: ScheduledJobRecord,
  credentials: { clientId?: string; clientSecret?: string },
  options: { now?: Date; connector?: NdviConnector } = {},
): Promise<PastureNdviCollectionJobResult> {
  const scope = parseCollectionJob(job);
  const actor = await resolveCollectionActor(scope);
  const interval = previousCompleteMonth(options.now ?? new Date());
  const operationId = await collectionOperationId(job.id, scope.paddockId, interval.from);
  const decision = await getPastureProviderDecision(scope.fieldId, actor);
  if (decision.mode !== "configured" || decision.providerKey !== PASTURE_CDSE_PROVIDER_KEY) {
    throw new PastureDomainError(
      `La ingesta programada requiere el proveedor ${PASTURE_CDSE_PROVIDER_KEY}.`,
      "NDVI_PROVIDER_UNCONFIGURED",
    );
  }
  const calibration = await getActiveNdviCalibration(scope.fieldId, PASTURE_CDSE_PROVIDER_KEY, actor);
  if (!calibration) {
    throw new PastureDomainError("No existe una calibración NDVI activa para este fundo.", "NDVI_CALIBRATION_REQUIRED");
  }
  const replay = await getStoredPastureObservationReplay(scope.fieldId, operationId, actor);
  if (replay) {
    return { status: "stored", observation: replay, noData: null, idempotentReplay: true };
  }
  const month = interval.from.slice(0, 10);
  const candidates = await listPaddockNdviCandidates(scope.fieldId, actor, month);
  const candidate = candidates.find((item) => item.paddockId === scope.paddockId);
  if (!candidate) {
    throw new PastureDomainError("El potrero NDVI no existe o quedó fuera de alcance.", "FIELD_SCOPE_CONFLICT");
  }
  const noDataReplay = await getStoredPastureNdviNoDataReplay({
    fieldId: scope.fieldId,
    providerKey: PASTURE_CDSE_PROVIDER_KEY,
    calibrationId: calibration.id,
    interval,
    candidate,
  }, actor);
  if (noDataReplay) {
    return { status: "no_data", observation: null, noData: noDataReplay, idempotentReplay: true };
  }
  const connector = options.connector ?? createCdsePastureNdviConnector(actor, credentials);
  const collected = await collectNdviWithConnector({
    operationId,
    fieldId: scope.fieldId,
    paddockId: scope.paddockId,
    from: interval.from,
    to: interval.to,
    geometrySnapshotToken: candidate.geometrySnapshotToken,
  }, actor, connector);
  if (collected.status === "stored") {
    return {
      status: "stored",
      observation: collected.observation,
      noData: null,
      idempotentReplay: collected.observation.idempotentReplay,
    };
  }
  const noData = await recordPastureNdviNoData({
    fieldId: scope.fieldId,
    providerKey: connector.providerKey,
    calibrationId: collected.calibrationId,
    interval,
    candidate,
    result: collected.result,
  }, actor);
  return { status: "no_data", observation: null, noData, idempotentReplay: false };
}

function parseCollectionJob(job: ScheduledJobRecord): {
  organizationId: string;
  fieldId: string;
  membershipId: string;
  paddockId: string;
} {
  const organizationId = job.organizationId?.trim() ?? "";
  const fieldId = job.fieldId?.trim() ?? "";
  const membershipId = text(job.payload.membershipId);
  const paddockId = text(job.payload.paddockId);
  if (job.type !== "pasture.ndvi.collect.v1" || !organizationId || !fieldId || !membershipId || !paddockId) {
    throw new Error("PASTURE_NDVI_JOB_INVALID");
  }
  return { organizationId, fieldId, membershipId, paddockId };
}

async function resolveCollectionActor(scope: {
  organizationId: string;
  fieldId: string;
  membershipId: string;
}): Promise<AccessContext> {
  const row = await getDb().$client.prepare(`
    SELECT membership.id, membership.organization_id AS organizationId,
      (SELECT name FROM organizations WHERE id = membership.organization_id) AS organizationName,
      membership.user_email AS email, membership.display_name AS displayName, membership.role
    FROM organization_memberships AS membership
    JOIN fields AS field ON field.organization_id = membership.organization_id AND field.id = ?
    LEFT JOIN membership_field_access AS field_access
      ON field_access.membership_id = membership.id AND field_access.field_id = field.id
    WHERE membership.id = ? AND membership.organization_id = ? AND membership.status = 'active'
      AND field.is_demo = 0
      AND (
        membership.role IN ('owner', 'admin')
        OR (membership.role IN ('manager', 'operator') AND field_access.field_id IS NOT NULL)
      )
      AND COALESCE(
        (SELECT enabled FROM organization_feature_flags
          WHERE organization_id = membership.organization_id AND field_id = field.id AND feature = 'pastoreo' LIMIT 1),
        (SELECT enabled FROM organization_feature_flags
          WHERE organization_id = membership.organization_id AND field_id IS NULL AND feature = 'pastoreo' LIMIT 1),
        0
      ) = 1
    LIMIT 1
  `).bind(scope.fieldId, scope.membershipId, scope.organizationId).first<{
    id: string;
    organizationId: string;
    organizationName: string;
    email: string;
    displayName: string;
    role: OrganizationMembershipRole;
  }>();
  if (!row) throw new Error("PASTURE_NDVI_JOB_SCOPE_REVOKED");
  return { ...row, membershipId: row.id, fieldIds: [scope.fieldId] };
}

function previousCompleteMonth(now: Date): { from: string; to: string } {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error("PASTURE_NDVI_JOB_DATE_INVALID");
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    from: new Date(Date.UTC(year, month - 1, 1)).toISOString(),
    to: new Date(Date.UTC(year, month, 1)).toISOString(),
  };
}

async function collectionOperationId(jobId: string, paddockId: string, from: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${jobId}|${paddockId}|${from.slice(0, 10)}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `ndvi:${hash.slice(0, 48)}`;
}

function roundPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 100) / 100;
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
