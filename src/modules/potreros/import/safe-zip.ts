import JSZip from "jszip";
import {
  MAX_ARCHIVE_COMPRESSION_RATIO,
  MAX_ARCHIVE_ENTRIES,
  MAX_ARCHIVE_ENTRY_BYTES,
  MAX_ARCHIVE_PATH_BYTES,
  MAX_EXPANDED_ARCHIVE_BYTES,
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
} from "./limits.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { GisImportError } from "./types.ts";

export type SafeZipEntry = {
  name: string;
  compressedBytes: number;
  expandedBytes: number;
  directory: boolean;
};

export type SafeZip = {
  zip: JSZip;
  entries: SafeZipEntry[];
  expandedBytes: number;
};

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const MAX_EOCD_SEARCH_BYTES = 65_557;

export async function loadSafeZip(bytes: Uint8Array): Promise<SafeZip> {
  const entries = inspectZipEntries(bytes);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false });
  } catch {
    throw new GisImportError("El archivo ZIP está dañado o usa una compresión no admitida.", "CORRUPT_ZIP", 422);
  }
  return {
    zip,
    entries,
    expandedBytes: entries.reduce((sum, entry) => sum + entry.expandedBytes, 0),
  };
}

export function inspectZipEntries(bytes: Uint8Array): SafeZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = findEndOfCentralDirectory(view);
  if (eocdOffset < 0) {
    throw new GisImportError("El archivo ZIP no contiene un directorio central válido.", "CORRUPT_ZIP", 422);
  }

  const disk = view.getUint16(eocdOffset + 4, true);
  const centralDisk = view.getUint16(eocdOffset + 6, true);
  const diskEntries = view.getUint16(eocdOffset + 8, true);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== totalEntries) {
    throw new GisImportError("Los archivos ZIP multidisco no están admitidos.", "UNSUPPORTED_ZIP", 422);
  }
  if (totalEntries === 0 || totalEntries > MAX_ARCHIVE_ENTRIES) {
    throw new GisImportError(
      `El ZIP debe contener entre 1 y ${MAX_ARCHIVE_ENTRIES} entradas.`,
      "ZIP_ENTRY_LIMIT",
      413,
    );
  }
  if (centralOffset + centralSize > eocdOffset || centralOffset + centralSize > bytes.byteLength) {
    throw new GisImportError("El directorio central del ZIP está fuera de rango.", "CORRUPT_ZIP", 422);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: SafeZipEntry[] = [];
  const seenPaths = new Set<string>();
  let offset = centralOffset;
  let expandedTotal = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new GisImportError("El directorio central del ZIP está dañado.", "CORRUPT_ZIP", 422);
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedBytes = view.getUint32(offset + 20, true);
    const expandedBytes = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nameLength === 0 || nameLength > MAX_ARCHIVE_PATH_BYTES || nextOffset > bytes.byteLength) {
      throw new GisImportError("Una ruta del ZIP es inválida o demasiado larga.", "UNSAFE_ZIP_PATH", 422);
    }
    if ((flags & 0x1) !== 0) {
      throw new GisImportError("Los archivos ZIP cifrados no están admitidos.", "UNSUPPORTED_ZIP", 422);
    }
    if (method !== 0 && method !== 8) {
      throw new GisImportError("El ZIP usa un método de compresión no admitido.", "UNSUPPORTED_ZIP", 422);
    }
    if (compressedBytes === 0xffffffff || expandedBytes === 0xffffffff) {
      throw new GisImportError("Los archivos ZIP64 no están admitidos en esta vista previa.", "UNSUPPORTED_ZIP", 422);
    }

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new GisImportError("Una ruta del ZIP no está codificada en UTF-8 válido.", "UNSAFE_ZIP_PATH", 422);
    }
    validateArchivePath(name);
    const normalizedName = name.toLowerCase();
    if (seenPaths.has(normalizedName)) {
      throw new GisImportError("El ZIP contiene rutas duplicadas o ambiguas.", "AMBIGUOUS_ZIP", 422);
    }
    seenPaths.add(normalizedName);

    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) {
      throw new GisImportError("El ZIP contiene enlaces simbólicos, que no están admitidos.", "UNSAFE_ZIP_PATH", 422);
    }
    const directory = name.endsWith("/");
    if (!directory) {
      if (expandedBytes > MAX_ARCHIVE_ENTRY_BYTES) {
        throw new GisImportError("Una entrada expandida del ZIP supera 40 MiB.", "ZIP_EXPANDED_LIMIT", 413);
      }
      const ratio = expandedBytes / Math.max(1, compressedBytes);
      if (ratio > MAX_ARCHIVE_COMPRESSION_RATIO) {
        throw new GisImportError("El ZIP tiene una relación de compresión insegura.", "ZIP_BOMB", 413);
      }
      expandedTotal += expandedBytes;
      if (expandedTotal > MAX_EXPANDED_ARCHIVE_BYTES) {
        throw new GisImportError("El contenido expandido del ZIP supera 80 MiB.", "ZIP_EXPANDED_LIMIT", 413);
      }
    }
    entries.push({ name, compressedBytes, expandedBytes, directory });
    offset = nextOffset;
  }
  if (offset !== centralOffset + centralSize) {
    throw new GisImportError("El directorio central del ZIP es ambiguo.", "CORRUPT_ZIP", 422);
  }
  return entries;
}

export async function readZipEntry(zip: JSZip, name: string): Promise<Uint8Array> {
  const entry = zip.file(name);
  if (!entry) throw new GisImportError("Falta una entrada esperada dentro del ZIP.", "CORRUPT_ZIP", 422);
  try {
    return await entry.async("uint8array");
  } catch {
    throw new GisImportError("No fue posible expandir una entrada del ZIP.", "CORRUPT_ZIP", 422);
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const firstPossible = Math.max(0, view.byteLength - MAX_EOCD_SEARCH_BYTES);
  for (let offset = view.byteLength - 22; offset >= firstPossible; offset -= 1) {
    if (view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      const commentLength = view.getUint16(offset + 20, true);
      if (offset + 22 + commentLength === view.byteLength) return offset;
    }
  }
  return -1;
}

function validateArchivePath(name: string): void {
  const pathWithoutDirectoryMarker = name.endsWith("/") ? name.slice(0, -1) : name;
  if (
    name.includes("\\")
    || name.includes("\0")
    || name.startsWith("/")
    || /^[a-z]:/iu.test(name)
    || pathWithoutDirectoryMarker.length === 0
    || pathWithoutDirectoryMarker.split("/").some((part) => part === ".." || part === "." || part === "")
  ) {
    throw new GisImportError("El ZIP contiene una ruta insegura.", "UNSAFE_ZIP_PATH", 422);
  }
}
