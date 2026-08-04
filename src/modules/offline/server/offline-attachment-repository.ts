import type { AccessContext } from "@/src/modules/access/domain/types";
import { DEMO_EMAIL } from "../../demo/data/demo-data.mjs";

export type StoredOfflineAttachment = {
  id: string;
  objectKey: string;
  sha256: string;
  size: number;
  replay: boolean;
};

export class OfflineAttachmentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OfflineAttachmentError";
    this.status = status;
  }
}

export async function preserveOfflineAttachment(input: {
  bucket: R2Bucket;
  db: D1Database;
  actor: AccessContext;
  fieldId: string;
  attachmentId: string;
  entityId: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<StoredOfflineAttachment> {
  const sha256 = await sha256Hex(input.bytes);
  const linkedMutationId = await assertLinkedMutation(input);
  const objectKey = `offline/${encodeURIComponent(input.actor.organizationId)}/${encodeURIComponent(input.fieldId)}/${input.attachmentId}`;
  const coreMetadata = {
    organizationId: input.actor.organizationId,
    fieldId: input.fieldId,
    entityId: input.entityId,
    attachmentId: input.attachmentId,
    sha256,
    size: String(input.bytes.byteLength),
    contentType: input.contentType,
  };
  let object = await headObject(input.bucket, objectKey);
  if (object) {
    if (!matches(object, coreMetadata)) throw new OfflineAttachmentError("El identificador del adjunto ya pertenece a otra fotografía.", 409);
    await assertLinkedMutation(input, linkedMutationId);
    return { id: input.attachmentId, objectKey, sha256, size: input.bytes.byteLength, replay: true };
  }

  await assertLinkedMutation(input, linkedMutationId);
  const uploadToken = crypto.randomUUID();
  try {
    await input.bucket.put(objectKey, input.bytes, {
      httpMetadata: { contentType: input.contentType, cacheControl: "private, no-store" },
      customMetadata: { ...coreMetadata, uploadToken },
      sha256,
      onlyIf: { etagDoesNotMatch: "*" },
    });
  } catch {
    object = await headObject(input.bucket, objectKey);
    if (!object || !matches(object, coreMetadata)) throw new OfflineAttachmentError("No fue posible preservar la fotografía.", 503);
    try {
      await assertLinkedMutation(input, linkedMutationId);
    } catch (cause) {
      if (object.customMetadata?.uploadToken === uploadToken) {
        await removeOwnedObject(input.bucket, objectKey, uploadToken);
      }
      throw cause;
    }
    return {
      id: input.attachmentId,
      objectKey,
      sha256,
      size: input.bytes.byteLength,
      replay: object.customMetadata?.uploadToken !== uploadToken,
    };
  }
  object = await headObject(input.bucket, objectKey);
  if (!object || !matches(object, coreMetadata) || object.customMetadata?.uploadToken !== uploadToken) {
    throw new OfflineAttachmentError("No fue posible verificar la fotografía preservada.", 503);
  }
  try {
    await assertLinkedMutation(input, linkedMutationId);
  } catch (cause) {
    await removeOwnedObject(input.bucket, objectKey, uploadToken);
    throw cause;
  }
  return { id: input.attachmentId, objectKey, sha256, size: input.bytes.byteLength, replay: false };
}

type AttachmentAccessInput = Pick<Parameters<typeof preserveOfflineAttachment>[0],
  "db" | "actor" | "fieldId" | "entityId" | "attachmentId">;

async function assertLinkedMutation(input: AttachmentAccessInput, expectedMutationId?: string): Promise<string> {
  const row = await input.db.prepare(`
    WITH current_member AS (
      SELECT membership.id, membership.organization_id, membership.normalized_email, membership.role
      FROM organization_memberships AS membership
      WHERE membership.id = ?
        AND membership.organization_id = ?
        AND membership.normalized_email = ?
        AND membership.normalized_email <> ?
        AND membership.status = 'active'
        AND membership.role IN ('owner', 'admin', 'manager', 'operator')
      LIMIT 1
    ),
    current_access AS (
      SELECT current_member.normalized_email
      FROM current_member
      JOIN fields AS field
        ON field.id = ? AND field.organization_id = current_member.organization_id
      LEFT JOIN membership_field_access AS current_scope
        ON current_scope.membership_id = current_member.id AND current_scope.field_id = field.id
      WHERE current_member.role IN ('owner', 'admin') OR current_scope.field_id IS NOT NULL
    )
    SELECT
      CASE WHEN EXISTS (SELECT 1 FROM current_access) THEN 1 ELSE 0 END AS authorized,
      (
        SELECT mutation.id
        FROM sync_mutations AS mutation
        JOIN current_access
          ON mutation.actor = current_access.normalized_email
        WHERE mutation.organization_id = ? AND mutation.field_id = ?
          AND mutation.entity_id = ? AND mutation.status = 'applied'
          AND mutation.entity IN ('livestock_weighing', 'livestock_health', 'livestock_estrus', 'livestock_movement')
          AND json_extract(mutation.payload, '$.attachmentId') = ?
        LIMIT 1
      ) AS mutationId
  `).bind(
    input.actor.membershipId,
    input.actor.organizationId,
    input.actor.email.trim().toLowerCase(),
    DEMO_EMAIL,
    input.fieldId,
    input.actor.organizationId,
    input.fieldId,
    input.entityId,
    input.attachmentId,
  ).first<{ authorized: number; mutationId: string | null }>();
  if (Number(row?.authorized) !== 1) {
    throw new OfflineAttachmentError("La membresía o el acceso al fundo cambió durante la carga.", 403);
  }
  if (!row?.mutationId || (expectedMutationId && row.mutationId !== expectedMutationId)) {
    throw new OfflineAttachmentError("La captura debe quedar aplicada por el mismo operador antes de preservar su fotografía.", 409);
  }
  return row.mutationId;
}

async function headObject(bucket: R2Bucket, objectKey: string): Promise<R2Object | null> {
  try {
    return await bucket.head(objectKey);
  } catch {
    throw new OfflineAttachmentError("No fue posible verificar el almacenamiento privado.", 503);
  }
}

async function removeOwnedObject(bucket: R2Bucket, objectKey: string, uploadToken: string): Promise<void> {
  const object = await headObject(bucket, objectKey);
  if (!object || object.customMetadata?.uploadToken !== uploadToken) return;
  try {
    await bucket.delete(objectKey);
  } catch {
    throw new OfflineAttachmentError("La carga perdió autorización y su limpieza quedó pendiente.", 503);
  }
  const remaining = await headObject(bucket, objectKey);
  if (remaining?.customMetadata?.uploadToken === uploadToken) {
    throw new OfflineAttachmentError("La carga perdió autorización y su limpieza quedó pendiente.", 503);
  }
}

function matches(object: R2Object, metadata: Record<string, string>): boolean {
  return object.size === Number(metadata.size)
    && Object.entries(metadata).every(([key, value]) => object.customMetadata?.[key] === value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
