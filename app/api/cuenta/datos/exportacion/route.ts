import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiSnapshotAccess,
} from "@/app/access";
import { getAppUser } from "@/app/auth";
import { normalizeAuthEmail } from "@/app/auth-core.mjs";
import {
  authorizeApiLegalAcceptance,
  reauthorizeLegalApi,
} from "@/app/legal-access";
import {
  isSameOriginMutation,
  readBoundedUrlEncodedForm,
} from "@/app/mutation-request.mjs";
import {
  PortableWorkspaceV2Error,
  canonicalPortableWorkspaceJson,
  createPortableWorkspaceV2,
  portableWorkspaceSha256,
} from "@/src/core/portability/workspace-portable-v2.mjs";
import {
  WorkspaceExportPersistenceError,
  loadPortableWorkspaceSnapshot,
  recordPortableWorkspaceExport,
} from "@/src/modules/account-lifecycle/server/workspace-export-repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginMutation(request)) {
    return privateJson({
      code: "CSRF_REJECTED",
      error: "La solicitud no proviene de FundoSmart.",
    }, 403);
  }
  const user = await getAppUser();
  if (!user) return privateJson({ error: "Debes iniciar sesión." }, 401);
  const legalResponse = await authorizeApiLegalAcceptance(user);
  if (legalResponse) return asPrivateResponse(legalResponse);

  const formData = await readBoundedUrlEncodedForm(request);
  if (formData instanceof Response) return formData;
  const organizationId = stringValue(formData.get("organizationId"));
  const requestId = stringValue(formData.get("requestId"));
  if (
    !organizationId
    || organizationId.length > 200
    || !isUuidV4(requestId)
  ) {
    return privateJson({
      code: "INVALID_EXPORT_REQUEST",
      error: "La solicitud de exportación no es válida.",
    }, 400);
  }

  const access = await authorizeApiAccess(
    "export_data",
    undefined,
    organizationId,
  );
  if (isAccessResponse(access)) return asPrivateResponse(access);
  if (access.organizationId !== organizationId) {
    return privateJson({
      code: "ACCESS_CONTEXT_CHANGED",
      error: "El espacio autorizado no coincide con el solicitado.",
    }, 409);
  }
  if (normalizeAuthEmail(user.email) !== access.email) {
    return privateJson({
      code: "ACCESS_CONTEXT_CHANGED",
      error: "La identidad y la membresía activa no coinciden.",
    }, 409);
  }

  try {
    const snapshot = await loadPortableWorkspaceSnapshot(env.DB, {
      actor: user,
      access,
    });
    const generatedAt = new Date().toISOString();
    const identityNonce = crypto.randomUUID();
    const identityDigest = await portableWorkspaceSha256(
      `fundosmart:portable-workspace-v2:identity:${snapshot.organization.id}:${identityNonce}:${user.subject}`,
    );
    const verified = await createPortableWorkspaceV2({
      generatedAt,
      generatedBy: `identity-sha256:${identityDigest}`,
      organization: snapshot.organization,
      fieldIds: [...snapshot.fieldIds],
      sections: snapshot.sections,
    });
    const bodySha256 = await portableWorkspaceSha256(verified);
    const filename = portableFilename(
      snapshot.organization.name,
      generatedAt.slice(0, 10),
    );

    await recordPortableWorkspaceExport(env.DB, {
      actor: user,
      access,
      requestId,
      generatedAt,
      organization: snapshot.organization,
      fieldIds: snapshot.fieldIds,
      filename,
      workspaceSha256: verified.manifest.workspaceSha256,
      recordCounts: verified.manifest.recordCounts,
      totalRecordCount: verified.manifest.totalRecordCount,
      beforeCommit: async () => {
        const currentIdentity = await reauthorizeLegalApi(user);
        if (currentIdentity instanceof Response) throw currentIdentity;
        const currentAccess = await reauthorizeApiSnapshotAccess(access, {
          capability: "export_data",
          fieldIds: snapshot.fieldIds,
          organizationId,
        });
        if (isAccessResponse(currentAccess)) throw currentAccess;
        if (
          currentIdentity.subject !== user.subject
          || normalizeAuthEmail(currentIdentity.email)
            !== normalizeAuthEmail(user.email)
          || !sameStringSet(currentAccess.fieldIds, snapshot.fieldIds)
        ) {
          throw privateJson({
            code: "EXPORT_AUTHORITY_CHANGED",
            error: "La identidad o el alcance cambió durante la exportación.",
          }, 409);
        }
      },
    });
    const body = canonicalPortableWorkspaceJson(verified);
    const bodyBytes = new TextEncoder().encode(body);
    const headers = new Headers({
      "Cache-Control": "private, no-store",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bodyBytes.byteLength),
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      "X-FundoSmart-SHA256": bodySha256,
      "X-FundoSmart-Workspace-SHA256": verified.manifest.workspaceSha256,
    });
    return new Response(body, { status: 200, headers });
  } catch (cause) {
    if (cause instanceof Response) return asPrivateResponse(cause);
    if (cause instanceof WorkspaceExportPersistenceError) {
      return privateJson({ code: cause.code, error: cause.message }, cause.status);
    }
    if (cause instanceof PortableWorkspaceV2Error) {
      const status = cause.code.includes("TOO_LARGE") ? 413 : 422;
      return privateJson({ code: cause.code, error: cause.message }, status);
    }
    throw cause;
  }
}

function portableFilename(organizationName: string, date: string): string {
  const slug = organizationName
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 72) || "espacio";
  return `fundosmart-${slug}-${date}.portable-v2.json`;
}

function sameStringSet(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort(compareCodePoint);
  const sortedRight = [...right].sort(compareCodePoint);
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function stringValue(value: FormDataEntryValue | string | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(value);
}

function privateJson(payload: unknown, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function asPrivateResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
