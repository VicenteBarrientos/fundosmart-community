import { env } from "cloudflare:workers";

export type StoredImportFile = {
  objectKey: string;
  etag: string;
};

export class ImportFileStorageError extends Error {
  readonly code = "IMPORT_FILE_STORAGE_FAILED";

  constructor(message = "No fue posible conservar el archivo original en el almacenamiento privado.", options?: ErrorOptions) {
    super(message, options);
    this.name = "ImportFileStorageError";
  }
}

export async function readImportFile(objectKey: string): Promise<R2ObjectBody | null> {
  const bucket = env.FILES;
  if (!bucket) {
    throw new Error("El almacenamiento privado de archivos no está disponible.");
  }
  return bucket.get(objectKey);
}

export async function headImportFile(objectKey: string): Promise<R2Object | null> {
  const bucket = env.FILES;
  if (!bucket) {
    throw new Error("El almacenamiento privado de archivos no está disponible.");
  }
  return bucket.head(objectKey);
}

export async function storeImportFile(input: {
  bytes: ArrayBuffer;
  contentType: string;
  fieldId: string;
  filename: string;
  importJobId: string;
  organizationId: string;
  requestedBy: string;
  sha256: string;
  sourceFormat?: string;
  sourceSystem?: string;
  sourceTable: string;
}): Promise<StoredImportFile> {
  const bucket = env.FILES;
  if (!bucket) {
    throw new Error("El almacenamiento privado de archivos no está disponible.");
  }

  const safeFilename = input.filename.normalize("NFKD").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "origen.bin";
  const customMetadata: Record<string, string> = {
    fieldId: input.fieldId,
    importJobId: input.importJobId,
    organizationId: input.organizationId,
    requestedBy: input.requestedBy,
    sha256: input.sha256,
    sourceTable: input.sourceTable,
  };
  if (input.sourceSystem) customMetadata.sourceSystem = input.sourceSystem;
  if (input.sourceFormat) customMetadata.sourceFormat = input.sourceFormat;
  const objectKey = [
    safeSegment(input.sourceSystem ?? "cooprinsem"),
    safeSegment(input.organizationId),
    safeSegment(input.fieldId),
    safeSegment(input.sha256),
    safeSegment(input.importJobId),
    safeFilename,
  ].join("/");

  let stored: R2Object | null;
  try {
    stored = await bucket.put(objectKey, input.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: input.contentType || "application/octet-stream" },
      customMetadata,
    });
  } catch (cause) {
    throw new ImportFileStorageError(undefined, { cause });
  }
  if (!stored) {
    throw new ImportFileStorageError("Ya existe un archivo privado para este intento de importación.");
  }

  return { objectKey, etag: stored.httpEtag };
}

export async function deleteImportFile(objectKey: string): Promise<void> {
  const bucket = env.FILES;
  if (!bucket) {
    throw new Error("El almacenamiento privado de archivos no está disponible.");
  }
  await bucket.delete(objectKey);
  if (await bucket.head(objectKey)) {
    throw new Error("El archivo privado no pudo eliminarse de forma verificable.");
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}
