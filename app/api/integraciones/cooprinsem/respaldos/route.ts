import { authorizeApiAccess, isAccessResponse, requireContextField, requireResourceField } from "@/app/access";
import {
  backupFilename,
  backupScope,
  buildFieldBackup,
  buildImportBackup,
  getOriginalFileReference,
  recordBackupDownload,
  sameOriginalFileReference,
} from "@/src/modules/integraciones/cooprinsem/server/backup-repository";
import { safeDownloadFilename, sha256Hex } from "@/src/modules/integraciones/cooprinsem/server/backup-format.mjs";
import { readImportFile } from "@/src/modules/integraciones/cooprinsem/server/file-storage";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorizeApiAccess("manage_imports");
  if (isAccessResponse(access)) return access;

  const params = new URL(request.url).searchParams;
  const scope = params.get("scope")?.trim();
  const id = params.get("id")?.trim() ?? "";
  const asset = params.get("asset")?.trim() || "backup";
  if ((scope !== "field" && scope !== "import") || !id) {
    return Response.json({ error: "Indica scope=field|import y el identificador del respaldo." }, { status: 400 });
  }
  if (asset !== "backup" && asset !== "original") {
    return Response.json({ error: "El recurso solicitado debe ser backup u original." }, { status: 400 });
  }
  if (asset === "original" && scope !== "import") {
    return Response.json({ error: "Solo una importación puede descargar su archivo original." }, { status: 400 });
  }

  if (scope === "field") {
    const forbidden = requireContextField(access, id);
    if (forbidden) return forbidden;
  } else {
    const forbidden = await requireResourceField(access, "import_job", id);
    if (forbidden) return forbidden;
  }

  const repositoryAccess = {
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    email: access.email,
    fieldIds: access.fieldIds,
  };
  if (asset === "original") return downloadOriginal(id, { ...repositoryAccess, actor: access.email });

  const backup = scope === "field"
    ? await buildFieldBackup({ fieldId: id, actor: access.email, ...repositoryAccess })
    : await buildImportBackup({ importJobId: id, actor: access.email, ...repositoryAccess });
  if (!backup) return Response.json({ error: "El alcance solicitado no existe." }, { status: 404 });

  const filename = backupFilename(backup);
  const body = `${JSON.stringify(backup, null, 2)}\n`;
  const sha256 = await sha256Hex(body);
  const audited = await recordBackupDownload({
    access: repositoryAccess,
    actor: access.email,
    scope: backupScope(backup),
    kind: "portable_backup",
    sha256,
    filename,
    recordCounts: backup.manifest.recordCounts,
  });
  if (!audited) return staleScopeResponse();
  return new Response(body, {
    headers: downloadHeaders(filename, "application/json; charset=utf-8", sha256, new TextEncoder().encode(body).byteLength),
  });
}

async function downloadOriginal(importJobId: string, access: {
  actor: string;
  membershipId: string;
  organizationId: string;
  fieldIds: string[];
}): Promise<Response> {
  const repositoryAccess = {
    membershipId: access.membershipId,
    organizationId: access.organizationId,
    email: access.actor,
    fieldIds: access.fieldIds,
  };
  const reference = await getOriginalFileReference(importJobId, repositoryAccess);
  if (!reference) return Response.json({ error: "La importación no existe." }, { status: 404 });

  let object: R2ObjectBody | null;
  try {
    object = await readImportFile(reference.objectKey);
  } catch {
    return Response.json({ error: "El almacenamiento privado de archivos no está disponible." }, { status: 503 });
  }
  if (!object) return Response.json({ error: "El archivo original ya no está disponible en el almacenamiento privado." }, { status: 404 });
  const currentReference = await getOriginalFileReference(importJobId, repositoryAccess);
  if (!currentReference || !sameOriginalFileReference(reference, currentReference)) return staleScopeResponse();
  const storedSha256 = object.customMetadata?.sha256;
  if (object.size !== currentReference.fileSizeBytes || storedSha256 !== currentReference.sha256) {
    return Response.json({
      error: "La copia almacenada no coincide con el tamaño y la huella registrados; se bloqueó la descarga para evitar entregar un respaldo no verificable.",
    }, { status: 409 });
  }

  const filename = safeDownloadFilename(currentReference.originalFilename, "original.dbf");
  const audited = await recordBackupDownload({
    access: repositoryAccess,
    actor: access.actor,
    scope: {
      type: "import",
      id: currentReference.importJobId,
      name: currentReference.originalFilename,
      organizationId: currentReference.organizationId,
      organizationName: currentReference.organizationId,
      fieldId: currentReference.fieldId,
      fieldName: currentReference.fieldName,
    },
    kind: "original_file",
    sha256: currentReference.sha256,
    filename,
  });
  if (!audited) return staleScopeResponse();
  const headers = downloadHeaders(
    filename,
    currentReference.contentType || object.httpMetadata?.contentType || "application/octet-stream",
    currentReference.sha256,
    object.size,
  );
  if (object.httpEtag) headers.set("ETag", object.httpEtag);
  return new Response(object.body, { headers });
}

function staleScopeResponse(): Response {
  return Response.json({ error: "El alcance cambió durante la preparación; vuelve a solicitar la descarga." }, { status: 409 });
}

function downloadHeaders(filename: string, contentType: string, sha256: string, size: number): Headers {
  return new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Content-Length": String(size),
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "X-FundoSmart-SHA256": sha256,
  });
}
