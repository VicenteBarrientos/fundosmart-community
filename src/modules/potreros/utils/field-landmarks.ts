import type { Coordinate } from "../types";
import type {
  FieldLandmarkDeleteRequest,
  FieldLandmarkGeometryType,
  FieldLandmarkImportedInput,
  FieldLandmarkInput,
  FieldLandmarkKind,
  FieldLandmarkUpsertRequest,
} from "../domain/field-landmarks";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { FIELD_LANDMARK_KINDS } from "../domain/field-landmarks.ts";
// @ts-expect-error Node's native TypeScript test runner requires the source extension at runtime.
import { calculatePathLengthMeters } from "./geometry.ts";

export const MAX_FIELD_LANDMARK_VERTICES = 2_000;
const MAX_LANDMARK_ID_LENGTH = 160;
const MAX_LANDMARK_NAME_LENGTH = 160;
const MAX_LANDMARK_NOTES_LENGTH = 2_000;

export type ValidatedFieldLandmarkInput = FieldLandmarkInput & { lengthMeters: number };

export type ImportedFieldLandmarkIdentity = Readonly<{
  id: string;
  operationId: string;
}>;

export class FieldLandmarkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldLandmarkValidationError";
  }
}

export function fieldLandmarkInputFromImportedGeometry(
  input: FieldLandmarkImportedInput,
): FieldLandmarkInput {
  const geometryType: FieldLandmarkGeometryType = input.geometry.type === "Point" ? "point" : "line";
  const geometry = input.geometry.type === "Point"
    ? [cloneCoordinate(input.geometry.coordinates)]
    : input.geometry.coordinates.map(cloneCoordinate);
  const validated = validateFieldLandmarkInput({
    id: input.id,
    fieldId: input.fieldId,
    kind: input.kind,
    geometryType,
    geometry,
    name: input.name,
    notes: input.notes ?? "",
  });
  return withoutLength(validated);
}

export function importedFieldLandmarkIdentity(candidateIdValue: string): ImportedFieldLandmarkIdentity {
  const candidateId = candidateIdValue.normalize("NFC").trim();
  if (!candidateId) throw invalid("Falta la identidad estable del candidato de hito.");
  const digest = stableIdentityDigest(candidateId);
  const id = candidateId.length <= MAX_LANDMARK_ID_LENGTH
    ? candidateId
    : `${candidateId.slice(0, MAX_LANDMARK_ID_LENGTH - digest.length - 1)}:${digest}`;
  return { id, operationId: `landmark-import:${digest}` };
}

export function parseFieldLandmarkUpsertRequest(value: unknown): FieldLandmarkUpsertRequest & { lengthMeters: number } {
  const record = requireRecord(value, "La solicitud del hito no es válida.");
  const expectedVersion = record.expectedVersion;
  if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || Number(expectedVersion) < 1)) {
    throw invalid("La versión esperada del hito no es válida.");
  }
  const operationId = requiredText(record.operationId, "Falta el identificador estable de la operación.", MAX_LANDMARK_ID_LENGTH);
  const validated = validateFieldLandmarkInput(record);
  return {
    ...withoutLength(validated),
    lengthMeters: validated.lengthMeters,
    operationId,
    expectedVersion: expectedVersion === null ? null : Number(expectedVersion),
  };
}

export function parseFieldLandmarkDeleteRequest(value: unknown): FieldLandmarkDeleteRequest {
  const record = requireRecord(value, "La solicitud de archivo del hito no es válida.");
  if (!Number.isInteger(record.expectedVersion) || Number(record.expectedVersion) < 1) {
    throw invalid("La versión esperada del hito no es válida.");
  }
  return {
    id: requiredText(record.id, "Selecciona un hito.", MAX_LANDMARK_ID_LENGTH),
    fieldId: requiredText(record.fieldId, "Selecciona un fundo.", MAX_LANDMARK_ID_LENGTH),
    operationId: requiredText(record.operationId, "Falta el identificador estable de la operación.", MAX_LANDMARK_ID_LENGTH),
    expectedVersion: Number(record.expectedVersion),
  };
}

export function validateFieldLandmarkInput(value: unknown): ValidatedFieldLandmarkInput {
  const record = requireRecord(value, "El hito no es válido.");
  const id = requiredText(record.id, "Selecciona un hito.", MAX_LANDMARK_ID_LENGTH);
  const fieldId = requiredText(record.fieldId, "Selecciona un fundo.", MAX_LANDMARK_ID_LENGTH);
  const kind = parseKind(record.kind);
  const geometryType = parseGeometryType(record.geometryType);
  const geometry = parseGeometry(record.geometry, geometryType);
  const name = requiredText(record.name, "Asigna un nombre al hito.", MAX_LANDMARK_NAME_LENGTH);
  const notes = optionalText(record.notes, "Las notas del hito", MAX_LANDMARK_NOTES_LENGTH);
  const lengthMeters = geometryType === "line" ? calculatePathLengthMeters(geometry) : 0;
  if (!Number.isFinite(lengthMeters) || (geometryType === "line" && lengthMeters <= 0)) {
    throw invalid("La longitud de la línea no es válida.");
  }
  return { id, fieldId, kind, geometryType, geometry, name, notes, lengthMeters };
}

function parseGeometry(value: unknown, geometryType: FieldLandmarkGeometryType): Coordinate[] {
  if (!Array.isArray(value)) throw invalid("La geometría del hito no es válida.");
  if (value.length > MAX_FIELD_LANDMARK_VERTICES) {
    throw invalid(`La geometría supera el límite de ${MAX_FIELD_LANDMARK_VERTICES} vértices.`);
  }
  if (geometryType === "point" && value.length !== 1) {
    throw invalid("Un hito puntual debe contener exactamente una coordenada.");
  }
  if (geometryType === "line" && value.length < 2) {
    throw invalid("Un hito lineal debe contener al menos dos coordenadas.");
  }
  const coordinates = value.map((coordinate, index) => parseCoordinate(coordinate, index));
  for (let index = 1; index < coordinates.length; index += 1) {
    if (coordinatesEqual(coordinates[index - 1], coordinates[index])) {
      throw invalid("La geometría contiene vértices vecinos duplicados.");
    }
  }
  return coordinates;
}

function parseCoordinate(value: unknown, index: number): Coordinate {
  if (!Array.isArray(value) || value.length !== 2) {
    throw invalid(`La coordenada ${index + 1} no contiene latitud y longitud.`);
  }
  const [latitude, longitude] = value;
  if (typeof latitude !== "number" || !Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw invalid(`La latitud de la coordenada ${index + 1} está fuera de WGS84.`);
  }
  if (typeof longitude !== "number" || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw invalid(`La longitud de la coordenada ${index + 1} está fuera de WGS84.`);
  }
  return [latitude, longitude];
}

function parseKind(value: unknown): FieldLandmarkKind {
  if (typeof value !== "string" || !FIELD_LANDMARK_KINDS.some((kind) => kind === value)) {
    throw invalid("El tipo de hito no está soportado.");
  }
  return value as FieldLandmarkKind;
}

function parseGeometryType(value: unknown): FieldLandmarkGeometryType {
  if (value !== "point" && value !== "line") throw invalid("El tipo de geometría debe ser punto o línea.");
  return value;
}

function requiredText(value: unknown, message: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim()) throw invalid(message);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalid(`${message} El máximo es ${maxLength} caracteres.`);
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength: number): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw invalid(`${label} no son válidas.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalid(`${label} superan ${maxLength} caracteres.`);
  return normalized;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid(message);
  return value as Record<string, unknown>;
}

function withoutLength(value: ValidatedFieldLandmarkInput): FieldLandmarkInput {
  return {
    id: value.id,
    fieldId: value.fieldId,
    kind: value.kind,
    geometryType: value.geometryType,
    geometry: value.geometry,
    name: value.name,
    notes: value.notes,
  };
}

function cloneCoordinate([latitude, longitude]: Coordinate): Coordinate {
  return [latitude, longitude];
}

function coordinatesEqual(first: Coordinate, second: Coordinate): boolean {
  return first[0] === second[0] && first[1] === second[1];
}

function stableIdentityDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}`;
}

function invalid(message: string): FieldLandmarkValidationError {
  return new FieldLandmarkValidationError(message);
}
