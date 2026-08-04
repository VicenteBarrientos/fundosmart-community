import { kml } from "@tmcw/togeojson";
import { DOMParser } from "@xmldom/xmldom";
import proj4 from "proj4";
import getShapefile from "shpjs";
import {
  GIS_PARSER_VERSION,
  MAX_CLIENT_COMPRESSED_FILE_BYTES,
  publicImportLimits,
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
} from "./limits.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { normalizeImportFeatures, type RawFeature } from "./normalize.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { loadSafeZip, readZipEntry, type SafeZip } from "./safe-zip.ts";
import type { GisImportFormat, GisImportInput, GisImportPreview } from "./types";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { GisImportError } from "./types.ts";

export async function previewGisImport(input: GisImportInput): Promise<GisImportPreview> {
  const bytes = toOwnedBytes(input.bytes);
  const fileName = sanitizeFileName(input.fileName);
  if (!input.fieldId.trim()) throw new GisImportError("Falta el fundo de destino.", "FIELD_REQUIRED", 400);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIENT_COMPRESSED_FILE_BYTES) {
    throw new GisImportError(
      `El archivo debe tener contenido y no superar ${MAX_CLIENT_COMPRESSED_FILE_BYTES} bytes.`,
      "COMPRESSED_SIZE_LIMIT",
      413,
    );
  }

  const format = detectImportFormat(fileName);
  const fileSha256 = await sha256Hex(bytes);
  const importPreviewId = await sha256Hex(new TextEncoder().encode(
    `${GIS_PARSER_VERSION}\0${input.fieldId.trim()}\0${format}\0${fileSha256}`,
  ));
  const parsed = await parseByFormat(bytes, format);
  const normalized = normalizeImportFeatures(parsed.features, importPreviewId);
  return {
    importPreviewId,
    parserVersion: GIS_PARSER_VERSION,
    fieldId: input.fieldId.trim(),
    fileName,
    fileSha256,
    format,
    compressedBytes: bytes.byteLength,
    expandedBytes: parsed.expandedBytes,
    sourceFeatureCount: normalized.sourceFeatureCount,
    previewFeatureCount: normalized.features.length,
    totalRawVertices: normalized.totalRawVertices,
    totalPreviewVertices: normalized.totalPreviewVertices,
    features: normalized.features,
    warnings: parsed.warnings,
    limits: publicImportLimits(),
  };
}

export function detectImportFormat(fileName: string): GisImportFormat {
  const extension = fileName.toLowerCase().split(".").at(-1);
  if (extension === "json" || extension === "geojson") return "geojson";
  if (extension === "kml") return "kml";
  if (extension === "kmz") return "kmz";
  if (extension === "zip") return "shapefile";
  throw new GisImportError("Formato no admitido. Usa GeoJSON/JSON, KML, KMZ o ZIP Shapefile.", "UNSUPPORTED_FORMAT", 415);
}

async function parseByFormat(
  bytes: Uint8Array,
  format: GisImportFormat,
): Promise<{ features: RawFeature[]; expandedBytes: number; warnings: string[] }> {
  if (format === "geojson") {
    const document = parseJson(bytes);
    validateGeoJsonCrs(document);
    return { features: coerceRawFeatures(document), expandedBytes: bytes.byteLength, warnings: [] };
  }
  if (format === "kml") {
    return { features: parseKml(bytes), expandedBytes: bytes.byteLength, warnings: [] };
  }
  if (format === "kmz") return parseKmz(bytes);
  return parseShapefile(bytes);
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GisImportError("El archivo JSON no está codificado en UTF-8 válido.", "INVALID_UTF8", 422);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GisImportError("El archivo no contiene JSON válido.", "INVALID_JSON", 422);
  }
}

function parseKml(bytes: Uint8Array): RawFeature[] {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new GisImportError("El KML no está codificado en UTF-8 válido.", "INVALID_UTF8", 422);
  }
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    throw new GisImportError("El KML no puede contener DTD ni entidades XML.", "UNSAFE_XML", 422);
  }
  try {
    const document = new DOMParser({
      locator: false,
      onError(level) {
        if (level !== "warning") throw new Error("invalid xml");
      },
    }).parseFromString(xml, "application/xml");
    if (document.documentElement?.localName?.toLowerCase() !== "kml") {
      throw new Error("not kml");
    }
    return coerceRawFeatures(kml(document, { skipNullGeometry: false }));
  } catch {
    throw new GisImportError("El archivo no contiene KML válido.", "INVALID_KML", 422);
  }
}

async function parseKmz(bytes: Uint8Array) {
  const safeZip = await loadSafeZip(bytes);
  const kmlEntries = safeZip.entries.filter((entry) => !entry.directory && entry.name.toLowerCase().endsWith(".kml"));
  if (kmlEntries.length !== 1) {
    throw new GisImportError("El KMZ debe contener exactamente un archivo KML.", "AMBIGUOUS_KMZ", 422);
  }
  const kmlBytes = await readZipEntry(safeZip.zip, kmlEntries[0].name);
  return {
    features: parseKml(kmlBytes),
    expandedBytes: safeZip.expandedBytes,
    warnings: safeZip.entries.some((entry) => !entry.directory && !entry.name.toLowerCase().endsWith(".kml"))
      ? ["Los recursos auxiliares del KMZ se validaron, pero no forman parte de la vista previa geométrica."]
      : [],
  };
}

async function parseShapefile(bytes: Uint8Array) {
  const safeZip = await loadSafeZip(bytes);
  const files = safeZip.entries.filter((entry) => !entry.directory);
  const shapeEntries = files.filter((entry) => extension(entry.name) === "shp");
  const projectionEntries = files.filter((entry) => extension(entry.name) === "prj");
  if (shapeEntries.length !== 1) {
    throw new GisImportError("El ZIP Shapefile debe contener exactamente una capa .shp.", "AMBIGUOUS_SHAPEFILE", 422);
  }
  if (projectionEntries.length !== 1) {
    throw new GisImportError("El ZIP Shapefile debe contener exactamente un archivo .prj.", "SHAPEFILE_CRS_REQUIRED", 422);
  }
  const baseName = withoutExtension(shapeEntries[0].name).toLowerCase();
  const projectionEntry = projectionEntries[0];
  if (withoutExtension(projectionEntry.name).toLowerCase() !== baseName) {
    throw new GisImportError("El archivo .prj no corresponde inequívocamente a la capa .shp.", "AMBIGUOUS_SHAPEFILE_CRS", 422);
  }
  const byExtension = (suffix: string) => files.find((entry) => (
    extension(entry.name) === suffix && withoutExtension(entry.name).toLowerCase() === baseName
  ));
  const [shpBytes, prjBytes, dbfBytes, cpgBytes] = await Promise.all([
    readZipEntry(safeZip.zip, shapeEntries[0].name),
    readZipEntry(safeZip.zip, projectionEntry.name),
    optionalZipEntry(safeZip, byExtension("dbf")?.name),
    optionalZipEntry(safeZip, byExtension("cpg")?.name),
  ]);
  const prj = decodeProjection(prjBytes);
  try {
    proj4(prj);
  } catch {
    throw new GisImportError("El sistema de coordenadas del .prj no se puede procesar.", "UNSUPPORTED_SHAPEFILE_CRS", 422);
  }

  let parsed: unknown;
  try {
    parsed = await getShapefile({
      shp: shpBytes,
      ...(dbfBytes ? { dbf: dbfBytes } : {}),
      prj,
      ...(cpgBytes ? { cpg: new TextDecoder("utf-8", { fatal: true }).decode(cpgBytes) } : {}),
    });
  } catch {
    throw new GisImportError("No fue posible interpretar la geometría del Shapefile.", "INVALID_SHAPEFILE", 422);
  }
  return {
    features: coerceRawFeatures(parsed),
    expandedBytes: safeZip.expandedBytes,
    warnings: dbfBytes ? [] : ["El Shapefile no incluye .dbf; se usarán nombres genéricos."],
  };
}

async function optionalZipEntry(safeZip: SafeZip, name: string | undefined): Promise<Uint8Array | null> {
  return name ? readZipEntry(safeZip.zip, name) : null;
}

function decodeProjection(bytes: Uint8Array): string {
  let value: string;
  try {
    value = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new GisImportError("El archivo .prj no está codificado en UTF-8 válido.", "UNSUPPORTED_SHAPEFILE_CRS", 422);
  }
  if (!value || value.length > 65_536 || value.includes("\0")) {
    throw new GisImportError("El archivo .prj está vacío o no es válido.", "UNSUPPORTED_SHAPEFILE_CRS", 422);
  }
  return value;
}

function validateGeoJsonCrs(document: unknown): void {
  const root = asRecord(document);
  if (!root || !("crs" in root) || root.crs === null || root.crs === undefined) return;
  const crs = asRecord(root.crs);
  const properties = asRecord(crs?.properties);
  const name = properties?.name;
  if (crs?.type !== "name" || typeof name !== "string" || !isWgs84CrsName(name)) {
    throw new GisImportError(
      "GeoJSON sólo admite coordenadas WGS84 (EPSG:4326 u OGC:CRS84).",
      "UNSUPPORTED_GEOJSON_CRS",
      422,
    );
  }
}

function isWgs84CrsName(value: string): boolean {
  const normalized = value.trim().toUpperCase();
  return normalized === "EPSG:4326"
    || normalized === "CRS84"
    || normalized === "OGC:CRS84"
    || normalized === "URN:OGC:DEF:CRS:EPSG::4326"
    || normalized === "URN:OGC:DEF:CRS:OGC::CRS84"
    || normalized === "HTTP://WWW.OPENGIS.NET/DEF/CRS/EPSG/0/4326"
    || normalized === "HTTP://WWW.OPENGIS.NET/DEF/CRS/OGC/1.3/CRS84";
}

export function coerceRawFeatures(document: unknown): RawFeature[] {
  if (Array.isArray(document)) return document.flatMap(coerceRawFeatures);
  const root = asRecord(document);
  if (!root || typeof root.type !== "string") {
    throw new GisImportError("El documento no tiene una estructura GeoJSON reconocible.", "INVALID_GEOJSON", 422);
  }
  if (root.type === "FeatureCollection") {
    if (!Array.isArray(root.features)) {
      throw new GisImportError("FeatureCollection no contiene una lista de features.", "INVALID_GEOJSON", 422);
    }
    return root.features.map(coerceFeature);
  }
  if (root.type === "Feature") return [coerceFeature(root)];
  if (isGeometryType(root.type)) return [{ id: null, properties: {}, geometry: root }];
  throw new GisImportError("El documento no tiene una estructura GeoJSON reconocible.", "INVALID_GEOJSON", 422);
}

function coerceFeature(value: unknown): RawFeature {
  const feature = asRecord(value);
  if (!feature || feature.type !== "Feature") {
    throw new GisImportError("Una entrada de FeatureCollection no es una feature válida.", "INVALID_GEOJSON", 422);
  }
  const properties = feature.properties === null || feature.properties === undefined
    ? {}
    : asRecord(feature.properties);
  if (!properties) {
    throw new GisImportError("Las propiedades de una feature deben ser un objeto.", "INVALID_GEOJSON", 422);
  }
  return {
    id: typeof feature.id === "string" || typeof feature.id === "number" ? feature.id : null,
    properties,
    geometry: feature.geometry,
  };
}

function isGeometryType(value: string): boolean {
  return ["Point", "MultiPoint", "LineString", "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection"].includes(value);
}

function sanitizeFileName(value: string): string {
  const name = value.replace(/\\/g, "/").split("/").at(-1)?.trim() ?? "";
  if (!name || name.length > 180 || name.includes("\0")) {
    throw new GisImportError("El nombre del archivo no es válido.", "INVALID_FILENAME", 400);
  }
  return name;
}

function extension(name: string): string {
  return name.toLowerCase().split(".").at(-1) ?? "";
}

function withoutExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? name : name.slice(0, dot);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function toOwnedBytes(input: ArrayBuffer | Uint8Array): Uint8Array {
  return new Uint8Array(input instanceof Uint8Array ? input : new Uint8Array(input));
}

async function sha256Hex(input: Uint8Array): Promise<string> {
  const owned = new ArrayBuffer(input.byteLength);
  new Uint8Array(owned).set(input);
  const digest = await crypto.subtle.digest("SHA-256", owned);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}
