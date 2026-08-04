import { authorizeApiAccess, isAccessResponse } from "@/app/access";
import { env } from "cloudflare:workers";
import {
  OfflineAttachmentError,
  preserveOfflineAttachment,
} from "@/src/modules/offline/server/offline-attachment-repository";

export const dynamic = "force-dynamic";

const MAX_ATTACHMENT_BYTES = 1_500_000;
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/heic"]);
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

export async function POST(request: Request): Promise<Response> {
  const identity = await authorizeApiAccess("operate");
  if (isAccessResponse(identity)) return identity;
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return privateJson({ error: "El adjunto no contiene datos válidos." }, 400);
  }
  const fieldId = text(form.get("fieldId"), 160);
  const attachmentId = text(form.get("attachmentId"), 26);
  const entityId = text(form.get("entityId"), 160);
  const file = form.get("file");
  if (!fieldId || !entityId || !ULID_PATTERN.test(attachmentId) || !(file instanceof File)) {
    return privateJson({ error: "Faltan el fundo, la captura o la fotografía." }, 400);
  }
  if (!IMAGE_TYPES.has(file.type) || file.size < 1 || file.size > MAX_ATTACHMENT_BYTES) {
    return privateJson({ error: "La fotografía debe ser JPEG, PNG, WebP o HEIC y no superar 1,5 MB." }, 413);
  }
  const access = await authorizeApiAccess("operate", fieldId);
  if (isAccessResponse(access)) return access;
  if (access.membershipId !== identity.membershipId || access.organizationId !== identity.organizationId) {
    return privateJson({ error: "La cuenta activa cambió durante la carga." }, 409);
  }
  if (!env.FILES) return privateJson({ error: "El almacenamiento privado no está disponible." }, 503);

  try {
    const attachment = await preserveOfflineAttachment({
      bucket: env.FILES,
      db: env.DB,
      actor: access,
      fieldId,
      attachmentId,
      entityId,
      contentType: file.type,
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    return privateJson({ attachment }, attachment.replay ? 200 : 201);
  } catch (cause) {
    if (cause instanceof OfflineAttachmentError) return privateJson({ error: cause.message }, cause.status);
    return privateJson({ error: "No fue posible preservar la fotografía." }, 500);
  }
}

function text(value: FormDataEntryValue | null, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function privateJson(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}
