import { getDb } from "@/db";
import {
  organizations,
  organizationMemberships,
  fields,
  membershipFieldAccess,
  organizationFeatureFlags,
  auditLog,
} from "@/db/schema";
import { authorizeApiLegalAcceptance } from "@/app/legal-access";
import {
  authorizeStaffCapability,
  hasStaffCapability,
  isStaffAccountOpen,
  PLATFORM_STAFF_V2_REQUIRED_KEY,
  reauthorizeStaffCapability,
  type StaffCapabilityAccess,
} from "@/app/staff-access";
import type { StaffCapability } from "@/src/modules/staff/domain/staff-authorization.mjs";
import { eq, asc, desc } from "drizzle-orm";
import {
  isSameOriginMutation,
  readBoundedJsonObject,
} from "@/app/mutation-request.mjs";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  commitLegacyStaffMembership,
  LegacyStaffMembershipError,
  prepareLegacyStaffMembership,
} from "@/src/modules/staff/server/staff-membership-repository";
import {
  commitLegacyStaffFeatureFlag,
  commitLegacyStaffField,
  commitLegacyStaffWorkspace,
  LegacyStaffResourceError,
  type LegacyStaffFeatureFlagSnapshot,
} from "@/src/modules/staff/server/staff-resource-repository";

export const dynamic = "force-dynamic";

/**
 * Autoridad persistida por capacidad. Cada operación declara la capacidad
 * concreta que exige; pertenecer a un tenant nunca la concede.
 */
async function verifyStaff(capability: StaffCapability): Promise<StaffCapabilityAccess | Response | null> {
  const access = await authorizeStaffCapability(capability);
  if (!access || !access.resolution.granted) {
    return null;
  }
  const legalResponse = await authorizeApiLegalAcceptance(access.user);
  if (legalResponse) return legalResponse;
  if (!(await isStaffAccountOpen(access.user.subject))) {
    return Response.json({
      error: "La cuenta está suspendida durante una ventana de gracia.",
      code: "ACCOUNT_CLOSURE_ACTIVE",
    }, {
      status: 423,
      headers: { "Cache-Control": "private, no-store" },
    });
  }
  return access;
}

/**
 * Capacidad exigida por cada acción de actualización. Una acción desconocida
 * exige la capacidad más restrictiva, de modo que un actor sin privilegios
 * reciba 403 y no descubra qué acciones existen.
 */
const UPDATE_ACTION_CAPABILITIES: Readonly<Record<string, StaffCapability>> = Object.freeze({
  save_membership: "tenants:manage",
  save_feature_flags: "flags:manage",
});
const UNKNOWN_ACTION_CAPABILITY: StaffCapability = "staff:manage";

function updateActionCapability(action: string): StaffCapability {
  return Object.hasOwn(UPDATE_ACTION_CAPABILITIES, action)
    ? UPDATE_ACTION_CAPABILITIES[action]
    : UNKNOWN_ACTION_CAPABILITY;
}

async function withStaffApiFailure(
  operation: string,
  publicMessage: string,
  handler: () => Promise<Response>,
) {
  try {
    return await handler();
  } catch (cause) {
    return unexpectedApiFailure(operation, publicMessage, cause);
  }
}

export async function GET() {
  return withStaffApiFailure(
    "staff.console.read",
    "No fue posible cargar la administración global.",
    readStaffConsole,
  );
}

async function readStaffConsole() {
  const staffAccess = await verifyStaff("support:read");
  if (staffAccess instanceof Response) return staffAccess;
  if (!staffAccess) {
    return Response.json({ error: "No autorizado" }, { status: 403 });
  }
  const canReadAudit = await hasStaffCapability(staffAccess, "audit:read");

  const db = getDb();
  const orgsList = await db.select().from(organizations).orderBy(asc(organizations.name));
  const fieldsList = await db.select().from(fields).orderBy(asc(fields.name));
  const membershipsList = await db.select().from(organizationMemberships).orderBy(asc(organizationMemberships.userEmail));
  const fieldAccessList = await db.select().from(membershipFieldAccess);
  const featureFlagsList = await db.select().from(organizationFeatureFlags).orderBy(asc(organizationFeatureFlags.organizationId));
  const auditLogsList = canReadAudit
    ? await db.select().from(auditLog).orderBy(desc(auditLog.occurredAt)).limit(50)
    : [];

  const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);
  if (!currentStaffAccess) return staffAccessChangedResponse();

  return Response.json({
    organizations: orgsList,
    fields: fieldsList,
    memberships: membershipsList,
    fieldAccess: fieldAccessList,
    featureFlags: featureFlagsList,
    auditLog: auditLogsList,
  });
}

export async function POST(request: Request) {
  if (!isSameOriginMutation(request)) return staffCsrfResponse();
  return withStaffApiFailure(
    "staff.console.create",
    "No fue posible procesar la solicitud administrativa.",
    () => createStaffResource(request),
  );
}

async function createStaffResource(request: Request) {
  const staffAccess = await verifyStaff("tenants:manage");
  if (staffAccess instanceof Response) return staffAccess;
  if (!staffAccess) {
    return Response.json({ error: "No autorizado" }, { status: 403 });
  }

  const payload = await readBoundedJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;

  const action = String(payload.action ?? "");

  if (action === "create_workspace") {
    const name = String(payload.name ?? "").trim();
    const kind = String(payload.kind ?? "shared") as "shared" | "personal" | "demo";

    if (!name) {
      return Response.json({ error: "El nombre del espacio de trabajo es requerido." }, { status: 400 });
    }
    if (!["shared", "personal", "demo"].includes(kind)) {
      return Response.json({ error: "El tipo de espacio de trabajo no es válido." }, { status: 400 });
    }

    const workspaceId = `org-${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    const auditId = crypto.randomUUID();
    try {
      const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);
      if (!currentStaffAccess) return staffMutationAccessChangedResponse();
      await commitLegacyStaffWorkspace({
        actor: {
          subject: currentStaffAccess.user.subject,
          email: currentStaffAccess.user.email,
        },
        staffCutoverMarkerKey: PLATFORM_STAFF_V2_REQUIRED_KEY,
        workspaceId,
        name,
        kind,
        now,
        auditId,
      });
      return Response.json({ success: true, workspaceId });
    } catch (cause) {
      if (cause instanceof LegacyStaffResourceError) {
        return legacyStaffResourceResponse(cause);
      }
      return unexpectedApiFailure(
        "staff.workspace.create",
        "No fue posible crear el espacio de trabajo.",
        cause,
      );
    }
  }

  if (action === "create_fundo") {
    const name = String(payload.name ?? "").trim();
    const organizationId = String(payload.organizationId ?? "").trim();
    const location = String(payload.location ?? "").trim();

    if (!name) {
      return Response.json({ error: "El nombre del fundo es requerido." }, { status: 400 });
    }
    if (!organizationId) {
      return Response.json({ error: "El ID de la organización es requerido." }, { status: 400 });
    }

    try {
      const db = getDb();
      const fundoId = `fundo-${crypto.randomUUID()}`;
      const now = new Date().toISOString();
      const org = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
      const auditId = crypto.randomUUID();
      const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);
      if (!currentStaffAccess) return staffMutationAccessChangedResponse();
      if (org.length === 0) {
        return Response.json({ error: "La organización especificada no existe." }, { status: 400 });
      }
      await commitLegacyStaffField({
        actor: {
          subject: currentStaffAccess.user.subject,
          email: currentStaffAccess.user.email,
        },
        staffCutoverMarkerKey: PLATFORM_STAFF_V2_REQUIRED_KEY,
        fieldId: fundoId,
        organizationId,
        expectedOrganizationKind: org[0].kind,
        name,
        location,
        now,
        auditId,
      });
      return Response.json({ success: true, fundoId });
    } catch (cause) {
      if (cause instanceof LegacyStaffResourceError) {
        return legacyStaffResourceResponse(cause);
      }
      return unexpectedApiFailure(
        "staff.field.create",
        "No fue posible crear el fundo.",
        cause,
      );
    }
  }

  return Response.json({ error: "Acción no reconocida." }, { status: 400 });
}

export async function PUT(request: Request) {
  if (!isSameOriginMutation(request)) return staffCsrfResponse();
  return withStaffApiFailure(
    "staff.console.update",
    "No fue posible procesar la actualización administrativa.",
    () => updateStaffResource(request),
  );
}

async function updateStaffResource(request: Request) {
  const payload = await readBoundedJsonObject<Record<string, unknown>>(request);
  if (payload instanceof Response) return payload;

  const action = String(payload.action ?? "");
  const staffAccess = await verifyStaff(updateActionCapability(action));
  if (staffAccess instanceof Response) return staffAccess;
  if (!staffAccess) {
    return Response.json({ error: "No autorizado" }, { status: 403 });
  }

  if (action === "save_membership") {
    try {
      const preparation = await prepareLegacyStaffMembership({
        organizationId: payload.organizationId,
        email: payload.email,
        displayName: payload.displayName,
        role: payload.role,
        status: payload.status,
        fieldIds: payload.fieldIds,
      });

      const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);
      if (!currentStaffAccess) return staffMutationAccessChangedResponse();
      if (!preparation.ok) throw preparation.error;
      const { membershipId } = await commitLegacyStaffMembership({
        plan: preparation.plan,
        actorSubject: currentStaffAccess.user.subject,
        actorEmail: currentStaffAccess.user.email,
        staffCutoverMarkerKey: PLATFORM_STAFF_V2_REQUIRED_KEY,
      });
      return Response.json({ success: true, membershipId });
    } catch (cause) {
      if (cause instanceof LegacyStaffMembershipError) {
        const body = cause.status >= 409
          ? { error: cause.message, code: cause.code }
          : { error: cause.message };
        return Response.json(
          body,
          cause.status >= 409
            ? {
                status: cause.status,
                headers: { "Cache-Control": "private, no-store" },
              }
            : { status: cause.status },
        );
      }
      return unexpectedApiFailure(
        "staff.membership.save",
        "No fue posible guardar la membresía.",
        cause,
      );
    }
  }

  if (action === "save_feature_flags") {
    const organizationId = String(payload.organizationId ?? "").trim();
    const fieldId = payload.fieldId ? String(payload.fieldId).trim() : null;
    const feature = String(payload.feature ?? "") as "trazabilidad" | "pastoreo" | "analitica" | "benchmarking";
    const enabled = Boolean(payload.enabled);

    if (!organizationId) {
      return Response.json({ error: "La organización es requerida." }, { status: 400 });
    }
    if (!["trazabilidad", "pastoreo", "analitica", "benchmarking"].includes(feature)) {
      return Response.json({ error: "La funcionalidad no es válida." }, { status: 400 });
    }

    const flagId = `feature:${organizationId}:${fieldId ?? "*"}:${feature}`;

    try {
      const db = getDb();
      const now = new Date().toISOString();
      const [existing] = await db.select()
        .from(organizationFeatureFlags)
        .where(eq(organizationFeatureFlags.id, flagId))
        .limit(1);
      const previous = existing
        ? {
            id: existing.id,
            organizationId: existing.organizationId,
            fieldId: existing.fieldId,
            feature: existing.feature,
            enabled: existing.enabled,
            createdBy: existing.createdBy,
            updatedBy: existing.updatedBy,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
          } satisfies LegacyStaffFeatureFlagSnapshot
        : null;
      const auditId = crypto.randomUUID();
      const currentStaffAccess = await reauthorizeStaffCapability(staffAccess);
      if (!currentStaffAccess) return staffMutationAccessChangedResponse();
      await commitLegacyStaffFeatureFlag({
        actor: {
          subject: currentStaffAccess.user.subject,
          email: currentStaffAccess.user.email,
        },
        staffCutoverMarkerKey: PLATFORM_STAFF_V2_REQUIRED_KEY,
        flagId,
        organizationId,
        fieldId,
        feature,
        enabled,
        previous,
        now,
        auditId,
      });

      return Response.json({ success: true });
    } catch (cause) {
      if (cause instanceof LegacyStaffResourceError) {
        return legacyStaffResourceResponse(cause);
      }
      return unexpectedApiFailure(
        "staff.feature_flags.save",
        "No fue posible actualizar las banderas de funcionalidad.",
        cause,
      );
    }
  }

  return Response.json({ error: "Acción no reconocida." }, { status: 400 });
}

function legacyStaffResourceResponse(cause: LegacyStaffResourceError) {
  return Response.json({
    error: cause.message,
    code: cause.code,
  }, {
    status: cause.status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function staffAccessChangedResponse() {
  return Response.json({
    error: "Tu acceso staff cambió durante la lectura. Actualiza la página e inténtalo nuevamente.",
    code: "STAFF_ACCESS_CHANGED",
  }, {
    status: 409,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function staffMutationAccessChangedResponse() {
  return Response.json({
    error: "Tu acceso staff cambió durante la actualización. Actualiza la página e inténtalo nuevamente.",
    code: "STAFF_ACCESS_CHANGED",
  }, {
    status: 409,
    headers: { "Cache-Control": "private, no-store" },
  });
}

function staffCsrfResponse() {
  return Response.json({
    error: "La solicitud no proviene de FundoSmart.",
    code: "CSRF_REJECTED",
  }, {
    status: 403,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
