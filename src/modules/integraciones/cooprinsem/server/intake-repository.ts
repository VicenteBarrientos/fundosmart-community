import { deleteImportFile, ImportFileStorageError, storeImportFile } from "./file-storage";
import {
  createImportJob,
  ImportJobScopeError,
  type ImportJobInput,
} from "./import-repository";

export type StoredImportJobInput = Omit<ImportJobInput, "objectKey"> & {
  bytes: ArrayBuffer;
};

export class ImportFileCompensationError extends Error {
  readonly code = "IMPORT_FILE_COMPENSATION_FAILED";
  readonly intakeCause: unknown;

  constructor(options: { cause: unknown; intakeCause?: unknown }) {
    super("No fue posible revertir el archivo privado de un intento de importación rechazado.", {
      cause: options.cause,
    });
    this.name = "ImportFileCompensationError";
    this.intakeCause = options.intakeCause;
  }
}

export async function createStoredImportJob(input: StoredImportJobInput) {
  const { bytes, ...jobInput } = input;
  let objectKey: string;
  try {
    ({ objectKey } = await storeImportFile({
      bytes,
      contentType: input.contentType || "application/octet-stream",
      fieldId: input.fieldId,
      filename: input.originalFilename,
      importJobId: input.id,
      organizationId: input.organizationId,
      requestedBy: input.requestedBy,
      sha256: input.sha256,
      sourceFormat: input.sourceFormat,
      sourceSystem: input.sourceSystem,
      sourceTable: input.sourceTable,
    }));
  } catch (cause) {
    if (cause instanceof ImportFileStorageError) throw cause;
    throw new ImportFileStorageError(undefined, { cause });
  }

  let created;
  try {
    created = await createImportJob({ ...jobInput, objectKey });
  } catch (cause) {
    if (!(cause instanceof ImportJobScopeError)) throw cause;
    await compensateImportFile(objectKey, cause);
    throw cause;
  }

  if (!created.created) {
    await compensateImportFile(objectKey);
  }
  return created;
}

async function compensateImportFile(objectKey: string, intakeCause?: unknown): Promise<void> {
  try {
    await deleteImportFile(objectKey);
  } catch (cause) {
    throw new ImportFileCompensationError({ cause, intakeCause });
  }
}
