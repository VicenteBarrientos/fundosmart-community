const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const FIELD_LANDMARK_KINDS = new Set([
  "bebedero",
  "porton",
  "sala_ordena",
  "bodega",
  "manga",
  "cerco_electrico",
  "callejon",
  "linea_agua",
  "otro",
]);
const EXCLUSION_KINDS = new Set(["laguna", "bosque", "construccion", "roquerio", "humedal"]);
const MAX_PADDOCK_GEOMETRY_UPDATES = 24;
const MAX_POLYGON_VERTICES = 4_000;
const MAX_LANDMARK_VERTICES = 2_000;
export const GEOGRAPHIC_LWW_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;

export const GEOGRAPHIC_SYNC_ENTITIES = new Set(["paddock_geometry", "field_landmark"]);

export function isGeographicSyncEntity(entity) {
  return GEOGRAPHIC_SYNC_ENTITIES.has(entity);
}

export function validateGeographicSyncMutation(value) {
  if (!isGeographicSyncEntity(value?.entity)) return null;
  if (value.entity === "paddock_geometry") return validatePaddockGeometryMutation(value);
  return validateFieldLandmarkMutation(value);
}

export function parsePaddockGeometryPayload(value) {
  const payload = requireRecord(value, "La geometría de potrero no es válida.");
  assertExactKeys(payload, ["capturedAt", "source", "updates"], "La geometría de potrero contiene campos no permitidos.");
  if (!Array.isArray(payload.updates) || payload.updates.length < 1 || payload.updates.length > MAX_PADDOCK_GEOMETRY_UPDATES) {
    throw new TypeError(`La edición admite entre 1 y ${MAX_PADDOCK_GEOMETRY_UPDATES} geometrías de potrero.`);
  }
  const source = payload.source;
  if (source !== "map" && source !== "gps") throw new TypeError("El origen de la geometría debe ser mapa o GPS.");
  const capturedAt = timestamp(payload.capturedAt, "La captura de geometría necesita una fecha UTC válida.");
  const updates = payload.updates.map((candidate) => {
    const update = requireRecord(candidate, "Una geometría de potrero no es válida.");
    assertExactKeys(update, ["expectedVersion", "geometry", "holeKinds", "id"], "Una geometría de potrero contiene campos no permitidos.");
    const id = text(update.id, 160, "Cada geometría necesita un potrero.");
    const expectedVersion = timestamp(update.expectedVersion, "Cada geometría necesita la versión UTC que leyó el dispositivo.");
    const geometry = polygonRings(update.geometry);
    if (!Array.isArray(update.holeKinds) || update.holeKinds.length !== geometry.holes.length || update.holeKinds.some((kind) => !EXCLUSION_KINDS.has(kind))) {
      throw new TypeError("Los tipos de exclusión no coinciden con los huecos de la geometría.");
    }
    return { id, expectedVersion, geometry, holeKinds: [...update.holeKinds] };
  });
  if (new Set(updates.map(({ id }) => id)).size !== updates.length) {
    throw new TypeError("Una edición no puede repetir el mismo potrero.");
  }
  return { capturedAt, source, updates };
}

export function parseFieldLandmarkPayload(value) {
  const payload = requireRecord(value, "El hito geográfico no es válido.");
  if (payload.action === "archive") {
    assertExactKeys(payload, ["action"], "El archivo del hito contiene campos no permitidos.");
    return { action: "archive" };
  }
  if (payload.action !== "upsert") throw new TypeError("La acción del hito no está soportada.");
  assertExactKeys(payload, ["action", "geometry", "geometryType", "kind", "name", "notes"], "El hito contiene campos no permitidos.");
  if (!FIELD_LANDMARK_KINDS.has(payload.kind)) throw new TypeError("El tipo de hito no está soportado.");
  if (payload.geometryType !== "point" && payload.geometryType !== "line") throw new TypeError("La geometría del hito debe ser punto o línea.");
  if (!Array.isArray(payload.geometry)) throw new TypeError("La geometría del hito no es válida.");
  const minimum = payload.geometryType === "point" ? 1 : 2;
  const maximum = payload.geometryType === "point" ? 1 : MAX_LANDMARK_VERTICES;
  if (payload.geometry.length < minimum || payload.geometry.length > maximum) throw new TypeError("La cantidad de vértices del hito no es válida.");
  const geometry = payload.geometry.map((coordinate, index) => parseCoordinate(coordinate, `La coordenada ${index + 1} del hito`));
  return {
    action: "upsert",
    kind: payload.kind,
    geometryType: payload.geometryType,
    geometry,
    name: text(payload.name, 160, "El hito necesita un nombre."),
    notes: optionalText(payload.notes, 2_000, "Las notas del hito no son válidas."),
  };
}

export function buildPaddockGeometryVersion(updates) {
  if (!Array.isArray(updates) || updates.length === 0) throw new TypeError("No hay versiones de potrero para comparar.");
  const normalized = updates.map((entry) => ({
    id: text(entry?.id, 160, "Cada versión necesita un potrero."),
    expectedVersion: timestamp(entry?.expectedVersion, "Cada potrero necesita una versión UTC válida."),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) throw new TypeError("Una versión no puede repetir potreros.");
  return `paddock-geometry-v1:${JSON.stringify(normalized)}`;
}

export function decidePaddockGeometryLww(input) {
  const clientTs = timestamp(input?.clientTs, "La política LWW necesita client_ts UTC.");
  const nowIso = timestamp(input?.nowIso, "La política LWW necesita la hora UTC del servidor.");
  const currentUpdatedAt = timestamp(input?.currentUpdatedAt, "La política LWW necesita la versión actual.");
  const clientMs = Date.parse(clientTs);
  if (clientMs > Date.parse(nowIso) + GEOGRAPHIC_LWW_MAX_FUTURE_SKEW_MS) {
    return { action: "conflict", reason: "client_ts excede la tolerancia de reloj de la política geográfica LWW v1.", comparedClientTs: null };
  }
  const accepted = input?.acceptedProjectionMatchesCurrent && input?.lastAcceptedClientTs
    ? timestamp(input.lastAcceptedClientTs, "La última captura LWW aceptada no es válida.")
    : null;
  const comparedClientTs = accepted ?? currentUpdatedAt;
  if (clientMs <= Date.parse(comparedClientTs)) {
    return { action: "conflict", reason: "client_ts no es posterior a la última versión geográfica comprobable.", comparedClientTs };
  }
  return { action: "apply", reason: null, comparedClientTs };
}

export function applyGeographicEvents(snapshot, events) {
  const paddocks = new Map((snapshot?.paddocks ?? []).map((paddock) => [paddock.id, paddock]));
  const landmarks = new Map((snapshot?.landmarks ?? []).map((landmark) => [landmark.id, landmark]));
  const fieldId = snapshot?.fieldId ?? events?.[0]?.fieldId ?? "";
  for (const event of events ?? []) {
    if (event?.fieldId !== fieldId) continue;
    const projection = event?.payload?.projection;
    if (event?.entity === "paddock_geometry" && projection?.kind === "paddock_geometry" && Array.isArray(projection.paddocks)) {
      for (const paddock of projection.paddocks) {
        if (paddock?.id && paddock.fieldId === event.fieldId) paddocks.set(paddock.id, paddock);
      }
    }
    if (event?.entity === "field_landmark" && projection?.kind === "field_landmark" && projection.landmark?.id && projection.landmark.fieldId === event.fieldId) {
      landmarks.set(projection.landmark.id, projection.landmark);
    }
  }
  return {
    fieldId,
    paddocks: [...paddocks.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
    landmarks: [...landmarks.values()].sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };
}

function validatePaddockGeometryMutation(value) {
  try {
    if (value.op !== "update") return "La geometría de potrero solo admite actualización versionada.";
    const payload = parsePaddockGeometryPayload(value.payload);
    if (payload.capturedAt !== value.clientTs) return "La geometría debe usar el mismo instante en capturedAt y client_ts.";
    if (!payload.updates.some(({ id }) => id === value.entityId)) return "La entidad principal no pertenece a la edición de geometría.";
    if (value.expectedVersion !== buildPaddockGeometryVersion(payload.updates)) return "La versión del lote de geometrías no coincide con sus potreros.";
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "La geometría de potrero no es válida.";
  }
}

function validateFieldLandmarkMutation(value) {
  try {
    const payload = parseFieldLandmarkPayload(value.payload);
    if (payload.action === "archive") {
      if (value.op !== "update" || !positiveIntegerText(value.expectedVersion)) return "Archivar un hito requiere su versión vigente.";
      return null;
    }
    if (value.op === "create") {
      if (value.expectedVersion !== null && value.expectedVersion !== undefined && value.expectedVersion !== "") return "Crear un hito no acepta una versión previa.";
      return null;
    }
    if (value.op !== "update" || !positiveIntegerText(value.expectedVersion)) return "Editar un hito requiere su versión vigente.";
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : "El hito geográfico no es válido.";
  }
}

function polygonRings(value) {
  const geometry = requireRecord(value, "La geometría canónica del potrero no es válida.");
  assertExactKeys(geometry, ["holes", "outer"], "La geometría canónica contiene campos no permitidos.");
  if (!Array.isArray(geometry.outer) || !Array.isArray(geometry.holes)) throw new TypeError("La geometría necesita borde exterior y huecos.");
  const total = geometry.outer.length + geometry.holes.reduce((sum, hole) => sum + (Array.isArray(hole) ? hole.length : MAX_POLYGON_VERTICES + 1), 0);
  if (geometry.outer.length < 3 || total > MAX_POLYGON_VERTICES) throw new TypeError("La geometría del potrero no tiene una cantidad válida de vértices.");
  const outer = geometry.outer.map((coordinate, index) => parseCoordinate(coordinate, `La coordenada exterior ${index + 1}`));
  const holes = geometry.holes.map((hole, holeIndex) => {
    if (!Array.isArray(hole) || hole.length < 3) throw new TypeError(`La exclusión ${holeIndex + 1} necesita al menos tres vértices.`);
    return hole.map((coordinate, index) => parseCoordinate(coordinate, `La coordenada ${index + 1} de la exclusión ${holeIndex + 1}`));
  });
  return { outer, holes };
}

function parseCoordinate(value, label) {
  if (!Array.isArray(value) || value.length !== 2 || !Number.isFinite(value[0]) || !Number.isFinite(value[1])) throw new TypeError(`${label} no es válida.`);
  if (value[0] < -90 || value[0] > 90 || value[1] < -180 || value[1] > 180) throw new TypeError(`${label} está fuera de WGS84.`);
  return [value[0], value[1]];
}

function timestamp(value, message) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value) || !Number.isFinite(Date.parse(value))) throw new TypeError(message);
  return value;
}

function text(value, maximum, message) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > maximum) throw new TypeError(message);
  return value.trim();
}

function optionalText(value, maximum, message) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.trim().length > maximum) throw new TypeError(message);
  return value.trim();
}

function positiveIntegerText(value) {
  return typeof value === "string" && /^[1-9]\d*$/u.test(value) && Number.isSafeInteger(Number(value));
}

function requireRecord(value, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(message);
  return value;
}

function assertExactKeys(value, keys, message) {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key)) || keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
    throw new TypeError(message);
  }
}
