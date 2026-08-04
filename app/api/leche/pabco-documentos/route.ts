import {
  authorizeApiAccess,
  isAccessResponse,
  requireContextField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import {
  abandonPabcoEvidence,
  compensatePabcoEvidenceObject,
  completePabcoEvidence,
  createPendingPabcoEvidence,
  getPabcoEvidenceLifecycleState,
  getPabcoEvidenceReference,
  markPabcoEvidenceCompensationPending,
  matchesPabcoEvidenceObject,
  PabcoEvidenceCompensationError,
  PabcoEvidenceScopeError,
  type PabcoEvidenceReference,
  type PendingPabcoEvidence,
} from "@/src/modules/leche/server/pabco-evidence-repository";
import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const contentLength = Number(request.headers.get("content-length"));
    if (!Number.isFinite(contentLength) || contentLength <= 0) {
      return Response.json(
        { error: "El documento debe informar su tamaño antes de cargarse." },
        { status: 411 },
      );
    }
    if (contentLength > MAX_FILE_BYTES + 64 * 1024) {
      return Response.json(
        { error: "El documento supera el máximo de 10 MB." },
        { status: 413 },
      );
    }
    const form = await request.formData();
    const fieldId =
      typeof form.get("fieldId") === "string"
        ? String(form.get("fieldId")).trim()
        : "";
    const forbidden = requireContextField(access, fieldId);
    if (forbidden) return forbidden;
    const file = form.get("file");
    if (!(file instanceof File) || file.size <= 0)
      return Response.json(
        { error: "Selecciona un documento PABCO." },
        { status: 400 },
      );
    if (file.size > MAX_FILE_BYTES)
      return Response.json(
        { error: "El documento supera el máximo de 10 MB." },
        { status: 413 },
      );
    if (!ALLOWED_CONTENT_TYPES.has(file.type))
      return Response.json(
        { error: "Usa PDF, DOCX, XLSX, JPG, PNG o WEBP." },
        { status: 415 },
      );
    if (!env.FILES)
      return Response.json(
        { error: "El almacenamiento privado no está disponible." },
        { status: 503 },
      );

    const bytes = await file.arrayBuffer();
    const sha256 = await sha256Hex(bytes);
    const createdAt = new Date().toISOString();
    const pending = await createPendingPabcoEvidence({
      organizationId: access.organizationId,
      fieldId,
      actor: access.email,
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
      sha256,
      createdAt,
    });
    const safeName = sanitizeFilename(file.name);
    let storedEtag: string | null = null;
    let conditionalCollision = false;
    let recoveredCommittedFinalization = false;
    try {
      const stored = await env.FILES.put(pending.objectKey, bytes, {
        onlyIf: { etagDoesNotMatch: "*" },
        sha256,
        httpMetadata: {
          contentType: file.type,
          contentDisposition: `attachment; filename="${safeName}"`,
        },
        customMetadata: {
          documentId: pending.id,
          organizationId: access.organizationId,
          fieldId,
          requestedBy: access.email,
          originalFilename: file.name.slice(0, 200),
          sha256,
          sizeBytes: String(file.size),
        },
      });
      if (!stored) {
        conditionalCollision = true;
        throw new Error("La clave privada del documento ya estaba ocupada.");
      }
      storedEtag = stored.httpEtag;
      const head = await env.FILES.head(pending.objectKey);
      const reference = {
        id: pending.id,
        objectKey: pending.objectKey,
        organizationId: pending.organizationId,
        fieldId: pending.fieldId,
        filename: pending.filename,
        contentType: pending.contentType,
        sizeBytes: pending.sizeBytes,
        sha256: pending.sha256,
        etag: storedEtag,
        legacy: false,
      };
      if (!head || !matchesPabcoEvidenceObject(reference, head)) {
        throw new Error("La verificación del documento privado no coincide con la carga.");
      }
      await completePabcoEvidence(pending, storedEtag, new Date().toISOString());
    } catch (cause) {
      if (!storedEtag) {
        if (conditionalCollision) {
          await abandonPabcoEvidenceSafely(pending, null);
          throw cause;
        }
        let uncertainObject: R2Object | null;
        try {
          uncertainObject = await env.FILES.head(pending.objectKey);
        } catch (headCause) {
          console.error(JSON.stringify({ event: "pabco.evidence.storage_state_uncertain" }));
          throw headCause;
        }
        if (uncertainObject?.httpEtag) {
          const uncertainReference = {
            id: pending.id,
            objectKey: pending.objectKey,
            organizationId: pending.organizationId,
            fieldId: pending.fieldId,
            filename: pending.filename,
            contentType: pending.contentType,
            sizeBytes: pending.sizeBytes,
            sha256: pending.sha256,
            etag: uncertainObject.httpEtag,
            legacy: false,
          };
          if (!matchesPabcoEvidenceObject(uncertainReference, uncertainObject)) {
            console.error(JSON.stringify({ event: "pabco.evidence.storage_identity_uncertain" }));
            throw cause;
          }
          storedEtag = uncertainObject.httpEtag;
        } else if (!uncertainObject) {
          await abandonPabcoEvidenceSafely(pending, null);
          throw cause;
        } else {
          console.error(JSON.stringify({ event: "pabco.evidence.storage_identity_uncertain" }));
          throw cause;
        }
      }
      if (storedEtag) {
        let lifecycleState;
        try {
          lifecycleState = await getPabcoEvidenceLifecycleState(pending, storedEtag);
        } catch {
          console.error(JSON.stringify({ event: "pabco.evidence.database_state_uncertain" }));
          throw cause;
        }
        if (lifecycleState === "stored") {
          recoveredCommittedFinalization = true;
        } else if (lifecycleState === "pending" || lifecycleState === "missing") {
          await compensateRejectedUpload(pending, storedEtag, cause);
        } else if (lifecycleState === "compensation_pending") {
          throw new PabcoEvidenceCompensationError({ cause });
        } else {
          console.error(JSON.stringify({ event: "pabco.evidence.database_identity_uncertain" }));
          throw cause;
        }
      }
      if (!recoveredCommittedFinalization) throw cause;
    }
    return Response.json(
      {
        document: { id: pending.id, filename: file.name, etag: storedEtag },
      },
      { status: 201 },
    );
  } catch (cause) {
    if (cause instanceof PabcoEvidenceScopeError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: 409 });
    }
    if (cause instanceof PabcoEvidenceCompensationError) {
      console.error(JSON.stringify({ event: "pabco.evidence.compensation_pending" }));
      return Response.json(
        { error: "La carga fue rechazada y requiere una conciliación segura." },
        { status: 503 },
      );
    }
    return unexpectedApiFailure(
      "milk.pabco.evidence.upload",
      "No fue posible guardar el documento PABCO.",
      cause,
    );
  }
}

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess();
    if (isAccessResponse(access)) return access;
    const documentId = new URL(request.url).searchParams.get("id")?.trim() ?? "";
    if (!documentId) return notFoundResponse();
    if (!env.FILES)
      return Response.json(
        { error: "El almacenamiento privado no está disponible." },
        { status: 503 },
      );
    const referenceAccess = {
      id: documentId,
      membershipId: access.membershipId,
      organizationId: access.organizationId,
      actor: access.email,
    };
    const reference = await getPabcoEvidenceReference(referenceAccess);
    if (!reference || !access.fieldIds.includes(reference.fieldId)) {
      return notFoundResponse();
    }
    const object = await env.FILES.get(reference.objectKey);
    if (!object || !matchesPabcoEvidenceObject(reference, object)) {
      return notFoundResponse();
    }
    const currentReference = await getPabcoEvidenceReference(referenceAccess);
    if (!currentReference || !samePabcoEvidenceReference(reference, currentReference)) {
      return notFoundResponse();
    }
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("Cache-Control", "private, no-store");
    return new Response(object.body, { headers });
  } catch (cause) {
    return unexpectedApiFailure(
      "milk.pabco.evidence.download",
      "No fue posible cargar el documento PABCO.",
      cause,
    );
  }
}

function samePabcoEvidenceReference(
  expected: PabcoEvidenceReference,
  current: PabcoEvidenceReference,
): boolean {
  return expected.id === current.id
    && expected.objectKey === current.objectKey
    && expected.organizationId === current.organizationId
    && expected.fieldId === current.fieldId
    && expected.sizeBytes === current.sizeBytes
    && expected.sha256 === current.sha256
    && expected.etag === current.etag
    && expected.legacy === current.legacy;
}

async function compensateRejectedUpload(
  pending: PendingPabcoEvidence,
  etag: string,
  cause: unknown,
): Promise<void> {
  try {
    await markPabcoEvidenceCompensationPending(pending, etag, new Date().toISOString());
  } catch {
    console.error(JSON.stringify({ event: "pabco.evidence.compensation_tracking_failed" }));
  }
  await compensatePabcoEvidenceObject(pending.objectKey, cause);
  await abandonPabcoEvidenceSafely(pending, etag);
}

async function abandonPabcoEvidenceSafely(
  pending: PendingPabcoEvidence,
  etag: string | null,
): Promise<void> {
  try {
    await abandonPabcoEvidence(pending, etag);
  } catch {
    console.error(JSON.stringify({ event: "pabco.evidence.cleanup_tracking_failed" }));
  }
}

function notFoundResponse(): Response {
  return Response.json(
    { error: "El documento no existe o no está disponible para tu membresía." },
    { status: 404 },
  );
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeFilename(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "evidencia"
  );
}
