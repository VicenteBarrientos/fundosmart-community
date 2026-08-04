import {
  SAG_DEA_CATEGORIES,
  SAG_DEA_FORM_VERSION,
  SAG_DRAFT_LABEL,
  SAG_DRAFT_STATUS,
  SAG_FMA_FORM_VERSION,
  SAG_MAX_FMA_DIIO,
  buildDeaDraft as buildSagDeaDraft,
  buildFmaDrafts as buildSagFmaDrafts,
  isValidDiio,
  normalizeDiio,
  normalizeRup,
} from "../../ganado/sag/sag-export-rules.mjs";

export {
  SAG_DEA_FORM_VERSION,
  SAG_DRAFT_LABEL,
  SAG_DRAFT_STATUS,
  SAG_FMA_FORM_VERSION,
  SAG_MAX_FMA_DIIO,
  isValidDiio,
  normalizeDiio,
  normalizeRup,
};

export const TRACEABILITY_DOCUMENT_SCHEMA_VERSION = "fundosmart.traceability.document.v1";
export const DIIO_DEVICE_TYPES = Object.freeze(["double_ear_tag", "ear_button", "ruminal_bolus"]);
export const DIIO_STATUSES = Object.freeze(["available", "assigned", "lost", "replaced", "retired"]);
export const ESTABLISHMENT_TYPES = Object.freeze(["dairy", "beef", "mixed", "other"]);
export const ESTABLISHMENT_STATUSES = Object.freeze(["active", "inactive"]);

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RUP_PATTERN = /^[0-9A-Z.-]{4,32}$/;
const IMPORT_SOURCE_KINDS = new Set(["sipec_file", "cliex_dbf", "manual_template"]);
const DIIO_TRANSITIONS = new Set(["assign", "report_lost", "replace", "retire"]);

/**
 * Normalizes the org/fundo/RUP identity without ever treating demo data as an
 * official establishment. Callers persist officialRup, not displayRup.
 */
export function normalizeEstablishmentIdentity(input) {
  const errors = [];
  const organizationId = normalizeIdentifier(input?.organizationId);
  const fieldId = normalizeIdentifier(input?.fieldId);
  const id = normalizeIdentifier(input?.id);
  requireIdentifier(errors, id, "id", "ESTABLISHMENT_ID_INVALID");
  requireIdentifier(errors, organizationId, "organizationId", "ORGANIZATION_ID_INVALID");
  requireIdentifier(errors, fieldId, "fieldId", "FIELD_ID_INVALID");

  const dataMode = input?.dataMode === "demo" ? "demo" : input?.dataMode === "real" ? "real" : null;
  if (!dataMode) addIssue(errors, "ESTABLISHMENT_DATA_MODE_INVALID", "dataMode", "Indica si los datos son reales o de demostración.");
  const type = ESTABLISHMENT_TYPES.includes(input?.type) ? input.type : null;
  if (!type) addIssue(errors, "ESTABLISHMENT_TYPE_INVALID", "type", "El tipo de establecimiento no es válido.");
  const status = ESTABLISHMENT_STATUSES.includes(input?.status) ? input.status : null;
  if (!status) addIssue(errors, "ESTABLISHMENT_STATUS_INVALID", "status", "El estado del establecimiento no es válido.");

  const rup = normalizeRup(input?.rup);
  let officialRup = null;
  let displayRup = rup;
  if (dataMode === "real") {
    if (!RUP_PATTERN.test(rup)) addIssue(errors, "ESTABLISHMENT_RUP_INVALID", "rup", "El establecimiento real requiere un RUP válido.");
    else officialRup = rup;
  } else if (dataMode === "demo") {
    if (rup && !rup.startsWith("DEMO-")) {
      addIssue(errors, "DEMO_RUP_MUST_BE_FAKE", "rup", "La demo solo admite identificadores RUP marcados como ficticios.");
    }
    displayRup = rup || `DEMO-${id || "ESTABLECIMIENTO"}`;
  }

  const validation = validationResult(errors);
  return {
    validation,
    establishment: validation.valid
      ? deepFreeze({
          id,
          organizationId,
          fieldId,
          officialRup,
          displayRup,
          type,
          status,
          dataMode,
          isOfficialIdentity: dataMode === "real",
          georef: null,
        })
      : null,
  };
}

export function validateDiioDevice(value) {
  const errors = [];
  requireIdentifier(errors, normalizeIdentifier(value?.id), "id", "DIIO_ID_INVALID");
  requireIdentifier(errors, normalizeIdentifier(value?.organizationId), "organizationId", "ORGANIZATION_ID_INVALID");
  requireIdentifier(errors, normalizeIdentifier(value?.fieldId), "fieldId", "FIELD_ID_INVALID");
  if (!isValidDiio(value?.officialNumber)) addIssue(errors, "DIIO_NUMBER_INVALID", "officialNumber", "El DIIO oficial debe contener exactamente 9 dígitos.");
  if (!DIIO_DEVICE_TYPES.includes(value?.deviceType)) addIssue(errors, "DIIO_DEVICE_TYPE_INVALID", "deviceType", "El tipo de dispositivo DIIO no es válido.");
  if (!DIIO_STATUSES.includes(value?.status)) addIssue(errors, "DIIO_STATUS_INVALID", "status", "El estado DIIO no es válido.");
  if (!Number.isInteger(value?.version) || value.version < 1) addIssue(errors, "DIIO_VERSION_INVALID", "version", "La versión DIIO debe ser un entero positivo.");
  if (value?.rfidId !== null && value?.rfidId !== undefined && !normalizeText(value.rfidId, 128)) {
    addIssue(errors, "DIIO_RFID_INVALID", "rfidId", "El identificador RFID no es válido.");
  }

  if (value?.status === "available") {
    if (value?.animalId) addIssue(errors, "DIIO_AVAILABLE_HAS_ANIMAL", "animalId", "Un DIIO disponible no puede estar asignado.");
    if (value?.assignedAt || value?.endedAt) addIssue(errors, "DIIO_AVAILABLE_HAS_DATES", "assignedAt", "Un DIIO disponible no puede tener fechas de asignación o término.");
  }
  if (value?.status === "assigned") {
    requireIdentifier(errors, normalizeIdentifier(value?.animalId), "animalId", "DIIO_ASSIGNED_ANIMAL_REQUIRED");
    if (!isIsoInstant(value?.assignedAt)) addIssue(errors, "DIIO_ASSIGNED_AT_INVALID", "assignedAt", "La asignación requiere fecha y hora ISO.");
    if (value?.endedAt) addIssue(errors, "DIIO_ASSIGNED_HAS_END", "endedAt", "Un DIIO activo no puede tener fecha de término.");
  }
  if (["lost", "replaced", "retired"].includes(value?.status) && !isIsoInstant(value?.endedAt)) {
    addIssue(errors, "DIIO_ENDED_AT_INVALID", "endedAt", "El estado terminal requiere fecha y hora ISO.");
  }
  if (value?.status === "replaced" && !normalizeIdentifier(value?.replacedByDeviceId)) {
    addIssue(errors, "DIIO_REPLACEMENT_REQUIRED", "replacedByDeviceId", "El DIIO reemplazado debe enlazar su reemplazo.");
  }
  return validationResult(errors);
}

/**
 * Decides one DIIO lifecycle command. It performs no I/O and returns every row
 * that must be changed atomically by the repository.
 */
export function decideDiioTransition(input) {
  const current = normalizeDevice(input?.current);
  const replacement = input?.replacement ? normalizeDevice(input.replacement) : null;
  const command = input?.command ?? {};
  const errors = [];

  errors.push(...validateDiioDevice(current).errors);
  if (!DIIO_TRANSITIONS.has(command.action)) addIssue(errors, "DIIO_TRANSITION_INVALID", "command.action", "La transición DIIO no es válida.");
  requireIdentifier(errors, normalizeIdentifier(command.idempotencyKey), "command.idempotencyKey", "IDEMPOTENCY_KEY_INVALID");
  requireIdentifier(errors, normalizeIdentifier(command.actorId), "command.actorId", "ACTOR_ID_INVALID");
  if (!isIsoInstant(command.occurredAt)) addIssue(errors, "DIIO_OCCURRED_AT_INVALID", "command.occurredAt", "La transición requiere fecha y hora ISO.");

  if (current.lastTransitionKey && current.lastTransitionKey === command.idempotencyKey) {
    if (!transitionReplayMatches(current, replacement, command)) {
      addIssue(errors, "IDEMPOTENCY_KEY_REUSED", "command.idempotencyKey", "La clave de idempotencia ya fue usada con otra transición o contenido.");
    }
    const validation = validationResult(errors);
    return validation.valid
      ? { validation, replay: true, updates: deepFreeze([]), event: null }
      : { validation, replay: false, updates: [], event: null };
  }

  const activeAssignments = Array.isArray(input?.activeAssignments) ? input.activeAssignments.map(normalizeDevice) : [];
  for (const [index, assignment] of activeAssignments.entries()) {
    if (assignment.organizationId !== current.organizationId || assignment.fieldId !== current.fieldId) {
      addIssue(errors, "DIIO_ASSIGNMENT_SCOPE_MISMATCH", `activeAssignments[${index}]`, "La asignación activa pertenece a otro tenant o fundo.");
    }
  }

  let updates = [];
  if (command.action === "assign") {
    if (current.status !== "available") addIssue(errors, "DIIO_ASSIGN_FROM_INVALID_STATE", "current.status", "Solo un DIIO disponible puede asignarse.");
    const animalId = normalizeIdentifier(command.animalId);
    requireIdentifier(errors, animalId, "command.animalId", "DIIO_ASSIGN_ANIMAL_REQUIRED");
    if (activeAssignments.some((entry) => entry.status === "assigned" && entry.animalId === animalId && entry.id !== current.id)) {
      addIssue(errors, "ANIMAL_ALREADY_HAS_ACTIVE_DIIO", "command.animalId", "El animal ya tiene un DIIO activo.");
    }
    updates = [{ ...current, animalId, status: "assigned", assignedAt: command.occurredAt, endedAt: null }];
  } else if (command.action === "report_lost") {
    if (current.status !== "assigned") addIssue(errors, "DIIO_LOST_FROM_INVALID_STATE", "current.status", "Solo un DIIO asignado puede declararse perdido.");
    updates = [{ ...current, status: "lost", endedAt: command.occurredAt }];
  } else if (command.action === "retire") {
    if (!["available", "assigned", "lost"].includes(current.status)) addIssue(errors, "DIIO_RETIRE_FROM_INVALID_STATE", "current.status", "El DIIO no puede darse de baja desde su estado actual.");
    updates = [{ ...current, status: "retired", endedAt: command.occurredAt }];
  } else if (command.action === "replace") {
    if (!["assigned", "lost"].includes(current.status)) addIssue(errors, "DIIO_REPLACE_FROM_INVALID_STATE", "current.status", "Solo un DIIO asignado o perdido puede reemplazarse.");
    if (!replacement) addIssue(errors, "DIIO_REPLACEMENT_REQUIRED", "replacement", "Selecciona el nuevo DIIO.");
    if (!current.animalId) addIssue(errors, "DIIO_REPLACE_ANIMAL_REQUIRED", "current.animalId", "El DIIO reemplazado debe conservar un animal.");
    if (replacement) {
      errors.push(...validateDiioDevice(replacement).errors.map((entry) => ({ ...entry, field: `replacement.${entry.field}` })));
      if (replacement.organizationId !== current.organizationId || replacement.fieldId !== current.fieldId) {
        addIssue(errors, "DIIO_REPLACEMENT_SCOPE_MISMATCH", "replacement", "El DIIO de reemplazo pertenece a otro tenant o fundo.");
      }
      if (replacement.status !== "available") addIssue(errors, "DIIO_REPLACEMENT_NOT_AVAILABLE", "replacement.status", "El DIIO de reemplazo debe estar disponible.");
      if (replacement.id === current.id || replacement.officialNumber === current.officialNumber) {
        addIssue(errors, "DIIO_REPLACEMENT_SAME_DEVICE", "replacement", "El reemplazo debe usar otro dispositivo oficial.");
      }
      if (activeAssignments.some((entry) => entry.status === "assigned" && entry.animalId === current.animalId && entry.id !== current.id)) {
        addIssue(errors, "ANIMAL_ALREADY_HAS_ACTIVE_DIIO", "current.animalId", "El animal ya tiene otro DIIO activo.");
      }
      updates = [
        { ...current, status: "replaced", endedAt: command.occurredAt, replacedByDeviceId: replacement.id },
        {
          ...replacement,
          animalId: current.animalId,
          status: "assigned",
          assignedAt: command.occurredAt,
          endedAt: null,
          replacesDeviceId: current.id,
        },
      ];
    }
  }

  const validation = validationResult(errors);
  if (!validation.valid) return { validation, replay: false, updates: [], event: null };
  updates = updates.map((entry) => deepFreeze({
    ...entry,
    lastTransitionKey: command.idempotencyKey,
    version: entry.version + 1,
  }));
  const event = deepFreeze({
    type: `traceability.diio.${command.action}`,
    organizationId: current.organizationId,
    fieldId: current.fieldId,
    actorId: command.actorId,
    occurredAt: command.occurredAt,
    idempotencyKey: command.idempotencyKey,
    deviceIds: updates.map((entry) => entry.id),
    animalId: updates.find((entry) => entry.animalId)?.animalId ?? null,
  });
  return { validation, replay: false, updates: deepFreeze(updates), event };
}

export function normalizeTraceabilityInventory(input) {
  const errors = [];
  const organizationId = normalizeIdentifier(input?.organizationId);
  const fieldId = normalizeIdentifier(input?.fieldId);
  requireIdentifier(errors, organizationId, "organizationId", "ORGANIZATION_ID_INVALID");
  requireIdentifier(errors, fieldId, "fieldId", "FIELD_ID_INVALID");
  const rawEntries = Array.isArray(input?.entries) ? input.entries : [];
  const normalized = [];

  for (const [index, entry] of rawEntries.entries()) {
    const path = `entries[${index}]`;
    const entryOrganizationId = normalizeIdentifier(entry?.organizationId ?? organizationId);
    const entryFieldId = normalizeIdentifier(entry?.fieldId ?? fieldId);
    if (entryOrganizationId !== organizationId) addIssue(errors, "INVENTORY_ORGANIZATION_MISMATCH", `${path}.organizationId`, "La existencia pertenece a otra organización.");
    if (entryFieldId !== fieldId) addIssue(errors, "INVENTORY_FIELD_MISMATCH", `${path}.fieldId`, "La existencia pertenece a otro fundo.");
    const id = normalizeIdentifier(entry?.id);
    requireIdentifier(errors, id, `${path}.id`, "INVENTORY_ID_INVALID");
    const trackingMode = entry?.trackingMode === "summary" ? "summary" : entry?.trackingMode === "individual" ? "individual" : null;
    if (!trackingMode) addIssue(errors, "INVENTORY_TRACKING_MODE_INVALID", `${path}.trackingMode`, "La existencia debe ser individual o resumida.");
    const quantity = entry?.quantity ?? (trackingMode === "individual" ? 1 : null);
    if (!Number.isInteger(quantity) || quantity < 1) addIssue(errors, "INVENTORY_QUANTITY_INVALID", `${path}.quantity`, "La cantidad debe ser un entero positivo.");
    if (trackingMode === "individual" && quantity !== 1) addIssue(errors, "INVENTORY_INDIVIDUAL_QUANTITY_INVALID", `${path}.quantity`, "Una existencia individual representa exactamente un animal.");
    const animalId = entry?.animalId ? normalizeIdentifier(entry.animalId) : null;
    if (trackingMode === "individual" && !animalId) addIssue(errors, "INVENTORY_ANIMAL_REQUIRED", `${path}.animalId`, "Una existencia individual requiere animal.");
    if (trackingMode === "summary" && (animalId || entry?.diio)) addIssue(errors, "INVENTORY_SUMMARY_HAS_IDENTITY", path, "Una existencia resumida no puede incluir animal ni DIIO individual.");
    const diio = entry?.diio ? normalizeDiio(entry.diio) : null;
    if (diio && !isValidDiio(diio)) addIssue(errors, "INVENTORY_DIIO_INVALID", `${path}.diio`, "El DIIO debe contener exactamente 9 dígitos.");
    if (!SAG_DEA_CATEGORIES[entry?.speciesCode]?.[entry?.categoryCode]) {
      addIssue(errors, "INVENTORY_CATEGORY_INVALID", `${path}.categoryCode`, "La especie o categoría SAG no es válida.");
    }
    const status = entry?.status === "inactive" ? "inactive" : entry?.status === "active" || entry?.status === undefined ? "active" : null;
    if (!status) addIssue(errors, "INVENTORY_STATUS_INVALID", `${path}.status`, "El estado de inventario no es válido.");
    normalized.push({
      id,
      organizationId: entryOrganizationId,
      fieldId: entryFieldId,
      trackingMode,
      animalId,
      diio,
      speciesCode: entry?.speciesCode,
      categoryCode: entry?.categoryCode,
      quantity,
      status,
      locationRup: entry?.locationRup ? normalizeRup(entry.locationRup) : null,
    });
  }

  addDuplicateIssues(errors, normalized, "id", "INVENTORY_ID_DUPLICATE", "entries", "Hay identificadores de existencia repetidos.");
  addDuplicateIssues(errors, normalized.filter((entry) => entry.animalId), "animalId", "INVENTORY_ANIMAL_DUPLICATE", "entries", "El animal aparece más de una vez en el inventario.");
  addDuplicateIssues(errors, normalized.filter((entry) => entry.status === "active" && entry.diio), "diio", "INVENTORY_DIIO_DUPLICATE", "entries", "El DIIO aparece activo más de una vez.");

  const validation = validationResult(errors);
  return {
    validation,
    entries: validation.valid ? deepFreeze(normalized.sort(compareInventoryEntries)) : [],
  };
}

export function reconcileDiioInventory(input) {
  const inventoryResult = normalizeTraceabilityInventory(input);
  if (!inventoryResult.validation.valid) return { validation: inventoryResult.validation, findings: [] };
  const errors = [];
  const activeAnimals = new Map(
    inventoryResult.entries
      .filter((entry) => entry.status === "active" && entry.trackingMode === "individual")
      .map((entry) => [entry.animalId, entry]),
  );
  const devices = (Array.isArray(input?.devices) ? input.devices : []).map(normalizeDevice);
  const assigned = devices.filter((entry) => entry.status === "assigned");
  for (const [index, device] of devices.entries()) {
    const result = validateDiioDevice(device);
    errors.push(...result.errors.map((entry) => ({ ...entry, field: `devices[${index}].${entry.field}` })));
    if (device.organizationId !== input.organizationId || device.fieldId !== input.fieldId) {
      addIssue(errors, "DIIO_RECONCILIATION_SCOPE_MISMATCH", `devices[${index}]`, "El dispositivo pertenece a otro tenant o fundo.");
    }
  }
  const findings = [];
  for (const entry of activeAnimals.values()) {
    const matches = assigned.filter((device) => device.animalId === entry.animalId);
    if (matches.length === 0) findings.push(finding("ANIMAL_WITHOUT_ACTIVE_DIIO", entry.animalId, entry.diio, []));
    if (matches.length > 1) findings.push(finding("ANIMAL_WITH_MULTIPLE_ACTIVE_DIIO", entry.animalId, entry.diio, matches.map((device) => device.id)));
    if (matches.length === 1 && entry.diio && entry.diio !== matches[0].officialNumber) {
      findings.push(finding("ANIMAL_DIIO_MISMATCH", entry.animalId, entry.diio, [matches[0].id]));
    }
  }
  for (const device of assigned) {
    if (!activeAnimals.has(device.animalId)) findings.push(finding("ORPHAN_ASSIGNED_DIIO", device.animalId, device.officialNumber, [device.id]));
  }
  const assignedByNumber = new Map();
  for (const device of assigned) assignedByNumber.set(device.officialNumber, [...(assignedByNumber.get(device.officialNumber) ?? []), device]);
  for (const [officialNumber, matches] of assignedByNumber.entries()) {
    if (matches.length > 1) findings.push(finding("DIIO_ASSIGNED_TO_MULTIPLE_ANIMALS", null, officialNumber, matches.map((device) => device.id)));
  }
  return {
    validation: validationResult(errors),
    findings: deepFreeze(findings.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)))),
  };
}

export function buildFmaDocumentProjections(input) {
  const establishmentResult = normalizeEstablishmentIdentity(input?.establishment);
  const errors = [...establishmentResult.validation.errors];
  const establishment = establishmentResult.establishment;
  const metadataInput = validateDocumentInput(errors, input?.document, "FMA");
  if (!establishment) return { validation: validationResult(errors), projections: [] };

  if (input?.profile?.fieldId !== establishment.fieldId) addIssue(errors, "FMA_PROFILE_FIELD_MISMATCH", "profile.fieldId", "El perfil SAG pertenece a otro fundo.");
  const sourceRup = establishment.officialRup ?? establishment.displayRup;
  if (input?.movement?.sourceRup && normalizeRup(input.movement.sourceRup) !== sourceRup) {
    addIssue(errors, "FMA_SOURCE_RUP_MISMATCH", "movement.sourceRup", "El RUP de origen no coincide con el establecimiento.");
  }
  if (normalizeRup(input?.movement?.destinationRup) === sourceRup) {
    addIssue(errors, "FMA_DESTINATION_EQUALS_SOURCE", "movement.destinationRup", "El RUP de destino debe ser distinto del origen.");
  }
  if (establishment.dataMode === "demo" && input?.movement?.referenceFolio) {
    addIssue(errors, "DEMO_FOLIO_FORBIDDEN", "movement.referenceFolio", "La demo no puede usar folios oficiales.");
  }
  if (input?.movement?.destinationPurpose === "international_export") {
    if (!normalizeText(input.movement.exportAuthorizationRef, 128)) addIssue(errors, "FMA_EXPORT_AUTHORIZATION_REQUIRED", "movement.exportAuthorizationRef", "La exportación requiere una autorización de referencia.");
    if (!normalizeText(input.movement.destinationCountry, 80)) addIssue(errors, "FMA_EXPORT_COUNTRY_REQUIRED", "movement.destinationCountry", "La exportación requiere país de destino.");
  }
  if (isIsoDate(input?.movement?.departureDate) && isIsoDate(input?.movement?.arrivalDate)
      && input.movement.departureDate === input.movement.arrivalDate
      && isTime(input.movement.departureTime) && isTime(input.movement.arrivalTime)
      && input.movement.arrivalTime < input.movement.departureTime) {
    addIssue(errors, "FMA_ARRIVAL_BEFORE_DEPARTURE", "movement.arrivalTime", "La llegada no puede ser anterior a la salida.");
  }

  const animals = Array.isArray(input?.animals) ? input.animals.map((animal, index) => {
    if (animal?.organizationId && animal.organizationId !== establishment.organizationId) addIssue(errors, "FMA_ANIMAL_ORGANIZATION_MISMATCH", `animals[${index}].organizationId`, "El animal pertenece a otra organización.");
    if (animal?.fieldId !== establishment.fieldId) addIssue(errors, "FMA_ANIMAL_FIELD_MISMATCH", `animals[${index}].fieldId`, "El animal pertenece a otro fundo.");
    if (!animal?.locationRup) addIssue(errors, "FMA_ANIMAL_LOCATION_REQUIRED", `animals[${index}].locationRup`, "El animal debe tener una ubicación de origen confirmada.");
    else if (normalizeRup(animal.locationRup) !== sourceRup) addIssue(errors, "FMA_ANIMAL_ORIGIN_MISMATCH", `animals[${index}].locationRup`, "El animal no está presente en el RUP de origen.");
    return animal;
  }).sort((left, right) => normalizeDiio(left?.diio).localeCompare(normalizeDiio(right?.diio)) || String(left?.id).localeCompare(String(right?.id))) : [];

  const sag = buildSagFmaDrafts({
    profile: { ...input?.profile, fieldId: establishment.fieldId, rup: sourceRup },
    movement: input?.movement,
    animals,
    withdrawals: input?.withdrawals,
    generatedAt: metadataInput.generatedAt,
    formVersion: input?.document?.formVersion ?? SAG_FMA_FORM_VERSION,
  });
  errors.push(...sag.validation.errors);
  const validation = validationResult(errors);
  if (!validation.valid) return { validation, projections: [] };

  const projections = sag.drafts.map((draft, index) => buildDocumentEnvelope({
    documentId: `${metadataInput.documentId}-${index + 1}`,
    kind: "FMA",
    revision: metadataInput.revision,
    generatedAt: metadataInput.generatedAt,
    formVersion: draft.formVersion,
    dataMode: establishment.dataMode,
    supersedesDocumentId: metadataInput.supersedesDocumentId,
    content: {
      ...draft,
      organizationId: establishment.organizationId,
      fieldId: establishment.fieldId,
      referenceFolio: establishment.dataMode === "demo" ? null : draft.referenceFolio,
      fakeData: establishment.dataMode === "demo",
      officialFormatDecision: "pending_confirmation",
    },
  }));
  return { validation, projections: deepFreeze(projections) };
}

export function buildDeaDocumentProjection(input) {
  const establishmentResult = normalizeEstablishmentIdentity(input?.establishment);
  const errors = [...establishmentResult.validation.errors];
  const establishment = establishmentResult.establishment;
  const metadataInput = validateDocumentInput(errors, input?.document, "DEA");
  if (!establishment) return { validation: validationResult(errors), projection: null };
  if (input?.profile?.fieldId !== establishment.fieldId) addIssue(errors, "DEA_PROFILE_FIELD_MISMATCH", "profile.fieldId", "El perfil SAG pertenece a otro fundo.");
  const period = Number(input?.period);
  if (!Number.isInteger(period) || period < 2000 || period > 2100) addIssue(errors, "DEA_PERIOD_INVALID", "period", "El período DEA debe ser un año válido.");
  if (isIsoDate(input?.asOfDate) && Number(input.asOfDate.slice(0, 4)) !== period) addIssue(errors, "DEA_PERIOD_DATE_MISMATCH", "asOfDate", "La fecha de corte debe pertenecer al período DEA.");

  const inventory = normalizeTraceabilityInventory({
    organizationId: establishment.organizationId,
    fieldId: establishment.fieldId,
    entries: input?.inventoryEntries,
  });
  errors.push(...inventory.validation.errors);
  const sourceRup = establishment.officialRup ?? establishment.displayRup;
  const sagEntries = inventory.entries.map((entry) => ({
    id: entry.id,
    fieldId: entry.fieldId,
    speciesCode: entry.speciesCode,
    categoryCode: entry.categoryCode,
    quantity: entry.quantity,
    trackingMode: entry.trackingMode,
    status: entry.status,
  }));
  const sag = buildSagDeaDraft({
    profile: { ...input?.profile, fieldId: establishment.fieldId, rup: sourceRup },
    asOfDate: input?.asOfDate,
    inventoryEntries: sagEntries,
    generatedAt: metadataInput.generatedAt,
    formVersion: input?.document?.formVersion ?? SAG_DEA_FORM_VERSION,
  });
  errors.push(...sag.validation.errors);
  const validation = validationResult(errors);
  if (!validation.valid || !sag.draft) return { validation, projection: null };
  const projection = buildDocumentEnvelope({
    documentId: metadataInput.documentId,
    kind: "DEA",
    revision: metadataInput.revision,
    generatedAt: metadataInput.generatedAt,
    formVersion: sag.draft.formVersion,
    dataMode: establishment.dataMode,
    supersedesDocumentId: metadataInput.supersedesDocumentId,
    content: {
      ...sag.draft,
      organizationId: establishment.organizationId,
      fieldId: establishment.fieldId,
      period,
      fakeData: establishment.dataMode === "demo",
      officialFormatDecision: "pending_confirmation",
    },
  });
  return { validation, projection };
}

/**
 * Parses an import into a reviewable stage. It never mutates inventory: every
 * collision is explicit and accepted rows are deterministic.
 */
export function stageDiioImport(input) {
  const errors = [];
  const organizationId = normalizeIdentifier(input?.organizationId);
  const fieldId = normalizeIdentifier(input?.fieldId);
  requireIdentifier(errors, organizationId, "organizationId", "ORGANIZATION_ID_INVALID");
  requireIdentifier(errors, fieldId, "fieldId", "FIELD_ID_INVALID");
  if (!IMPORT_SOURCE_KINDS.has(input?.sourceKind)) addIssue(errors, "IMPORT_SOURCE_INVALID", "sourceKind", "La fuente de importación no es válida.");
  const rup = normalizeRup(input?.rup);
  if (!RUP_PATTERN.test(rup)) addIssue(errors, "IMPORT_RUP_INVALID", "rup", "La importación requiere un RUP válido.");
  const rows = (Array.isArray(input?.rows) ? input.rows : []).map((raw, index) => normalizeImportRow(raw, index, { organizationId, fieldId, rup }));
  const rowIssues = [];
  for (const row of rows) {
    if (row.adapterIssueCode) addRowIssue(rowIssues, row.rowNumber, row.adapterIssueCode, "source", row.adapterIssueMessage || "La fila de origen no se puede proyectar.");
    if (!Number.isInteger(row.rowNumber) || row.rowNumber < 1) addRowIssue(rowIssues, row.rowNumber, "IMPORT_ROW_NUMBER_INVALID", "rowNumber", "La fila requiere un número positivo.");
    if (!row.sourceRecordId) addRowIssue(rowIssues, row.rowNumber, "IMPORT_SOURCE_RECORD_REQUIRED", "sourceRecordId", "La fila requiere un identificador de origen.");
    if (!isValidDiio(row.officialNumber)) addRowIssue(rowIssues, row.rowNumber, "IMPORT_DIIO_INVALID", "officialNumber", "El DIIO importado debe contener exactamente 9 dígitos.");
    if (!row.animalExternalId) addRowIssue(rowIssues, row.rowNumber, "IMPORT_ANIMAL_REQUIRED", "animalExternalId", "La fila requiere identificador de animal.");
    if (!DIIO_DEVICE_TYPES.includes(row.deviceType)) addRowIssue(rowIssues, row.rowNumber, "IMPORT_DEVICE_TYPE_INVALID", "deviceType", "El tipo de dispositivo importado no es válido.");
    if (row.rup !== rup) addRowIssue(rowIssues, row.rowNumber, "IMPORT_ROW_RUP_MISMATCH", "rup", "La fila pertenece a otro RUP.");
  }
  const conflicts = [];
  addImportDuplicateConflicts(conflicts, rows, "rowNumber", "IMPORT_ROW_NUMBER_DUPLICATE", "El número de fila está repetido.");
  addImportDuplicateConflicts(conflicts, rows, "sourceRecordId", "IMPORT_SOURCE_RECORD_DUPLICATE", "El identificador de origen está repetido.");
  addImportDuplicateConflicts(conflicts, rows.filter((row) => isValidDiio(row.officialNumber)), "officialNumber", "IMPORT_DIIO_DUPLICATE", "El DIIO aparece más de una vez en el archivo.");
  addImportDuplicateConflicts(conflicts, rows.filter((row) => row.animalExternalId), "animalExternalId", "IMPORT_ANIMAL_DUPLICATE", "El animal aparece más de una vez en el archivo.");

  const existingDevices = (Array.isArray(input?.existingDevices) ? input.existingDevices : []).map(normalizeDevice);
  for (const device of existingDevices) {
    if (device.organizationId !== organizationId || device.fieldId !== fieldId) {
      addIssue(errors, "IMPORT_EXISTING_SCOPE_INVALID", "existingDevices", "La comparación incluye datos de otro tenant o fundo.");
    }
  }
  const comparableDevices = existingDevices.filter((device) => device.organizationId === organizationId && device.fieldId === fieldId);
  const unchanged = [];
  for (const row of rows) {
    const byDiio = comparableDevices.find((device) => device.officialNumber === row.officialNumber);
    const byAnimal = comparableDevices.find((device) => device.status === "assigned" && device.animalId === row.animalExternalId);
    let hasConflict = false;
    if (byDiio && byDiio.status === "assigned" && byDiio.animalId !== row.animalExternalId) {
      conflicts.push(importConflict("IMPORT_DIIO_ASSIGNED_TO_OTHER_ANIMAL", [row.rowNumber], row, byDiio.id, "El DIIO ya está asignado a otro animal."));
      hasConflict = true;
    }
    if (byAnimal && byAnimal.officialNumber !== row.officialNumber) {
      conflicts.push(importConflict("IMPORT_ANIMAL_HAS_OTHER_DIIO", [row.rowNumber], row, byAnimal.id, "El animal ya tiene otro DIIO activo."));
      hasConflict = true;
    }
    if (byDiio && ["lost", "replaced", "retired"].includes(byDiio.status)) {
      conflicts.push(importConflict("IMPORT_DIIO_TERMINAL", [row.rowNumber], row, byDiio.id, "El DIIO ya tiene un estado terminal."));
      hasConflict = true;
    }
    if (!hasConflict && byDiio && byDiio.status === "assigned" && byDiio.animalId === row.animalExternalId) unchanged.push(row);
  }

  const blockedRows = new Set([
    ...rowIssues.map((entry) => entry.rowNumber),
    ...conflicts.flatMap((entry) => entry.rowNumbers),
    ...unchanged.map((entry) => entry.rowNumber),
  ]);
  const candidates = rows.filter((row) => !blockedRows.has(row.rowNumber));
  const sortedConflicts = conflicts.sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  const validation = validationResult(errors);
  const accepted = validation.valid ? candidates : [];
  const canonicalStage = stableStringify({ sourceKind: input?.sourceKind, organizationId, fieldId, rup, rows: [...rows].sort(compareImportRows) });
  return deepFreeze({
    validation,
    accepted: accepted.sort(compareImportRows),
    unchanged: unchanged.sort(compareImportRows),
    conflicts: sortedConflicts,
    rowIssues: rowIssues.sort((left, right) => left.rowNumber - right.rowNumber || left.code.localeCompare(right.code)),
    summary: {
      total: rows.length,
      accepted: accepted.length,
      unchanged: unchanged.length,
      conflicts: sortedConflicts.length,
      invalidRows: new Set(rowIssues.map((entry) => entry.rowNumber)).size,
    },
    canonicalStage,
  });
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function buildDocumentEnvelope(input) {
  const metadata = {
    schemaVersion: TRACEABILITY_DOCUMENT_SCHEMA_VERSION,
    documentId: input.documentId,
    kind: input.kind,
    revision: input.revision,
    generatedAt: input.generatedAt,
    formVersion: input.formVersion,
    state: "draft",
    dataMode: input.dataMode,
    fakeData: input.dataMode === "demo",
    officiallySubmittable: false,
    supersedesDocumentId: input.supersedesDocumentId,
    immutableAfterIssue: ["documentId", "revision", "folio", "sha256", "objectKey"],
  };
  const content = canonicalClone(input.content);
  return deepFreeze({ metadata, content, sha256Input: stableStringify({ metadata, content }) });
}

function validateDocumentInput(errors, input, kind) {
  const documentId = normalizeIdentifier(input?.documentId);
  requireIdentifier(errors, documentId, "document.documentId", `${kind}_DOCUMENT_ID_INVALID`);
  const revision = input?.revision ?? 1;
  if (!Number.isInteger(revision) || revision < 1) addIssue(errors, `${kind}_REVISION_INVALID`, "document.revision", "La revisión del documento debe ser un entero positivo.");
  if (!isIsoInstant(input?.generatedAt)) addIssue(errors, `${kind}_GENERATED_AT_INVALID`, "document.generatedAt", "El documento requiere fecha y hora ISO determinista.");
  const supersedesDocumentId = input?.supersedesDocumentId ? normalizeIdentifier(input.supersedesDocumentId) : null;
  if (input?.supersedesDocumentId && !supersedesDocumentId) addIssue(errors, `${kind}_SUPERSEDES_ID_INVALID`, "document.supersedesDocumentId", "La referencia de corrección no es válida.");
  return { documentId, revision, generatedAt: input?.generatedAt ?? "", supersedesDocumentId };
}

function normalizeDevice(value) {
  return {
    id: normalizeIdentifier(value?.id),
    organizationId: normalizeIdentifier(value?.organizationId),
    fieldId: normalizeIdentifier(value?.fieldId),
    officialNumber: normalizeDiio(value?.officialNumber),
    deviceType: value?.deviceType,
    rfidId: value?.rfidId ? normalizeText(value.rfidId, 128) : null,
    animalId: value?.animalId ? normalizeIdentifier(value.animalId) : null,
    status: value?.status,
    assignedAt: value?.assignedAt ?? null,
    endedAt: value?.endedAt ?? null,
    replacesDeviceId: value?.replacesDeviceId ? normalizeIdentifier(value.replacesDeviceId) : null,
    replacedByDeviceId: value?.replacedByDeviceId ? normalizeIdentifier(value.replacedByDeviceId) : null,
    lastTransitionKey: value?.lastTransitionKey ? normalizeIdentifier(value.lastTransitionKey) : null,
    version: value?.version,
  };
}

function transitionReplayMatches(current, replacement, command) {
  if (command.action === "assign") {
    return current.status === "assigned"
      && current.animalId === normalizeIdentifier(command.animalId)
      && current.assignedAt === command.occurredAt;
  }
  if (command.action === "report_lost") return current.status === "lost" && current.endedAt === command.occurredAt;
  if (command.action === "retire") return current.status === "retired" && current.endedAt === command.occurredAt;
  if (command.action === "replace") {
    return current.status === "replaced"
      && current.endedAt === command.occurredAt
      && replacement?.id === current.replacedByDeviceId
      && replacement?.status === "assigned"
      && replacement?.animalId === current.animalId
      && replacement?.assignedAt === command.occurredAt;
  }
  return false;
}

function normalizeImportRow(raw, index, scope) {
  const keyed = new Map(Object.entries(raw && typeof raw === "object" ? raw : {}).map(([key, value]) => [normalizeColumnName(key), value]));
  const get = (...aliases) => aliases.map(normalizeColumnName).map((key) => keyed.get(key)).find((value) => value !== undefined && value !== null && String(value).trim() !== "");
  const rawType = normalizeColumnName(get("deviceType", "tipo_dispositivo", "tipo_diio") ?? "double_ear_tag");
  const typeAliases = { arete: "double_ear_tag", arete_doble: "double_ear_tag", boton: "ear_button", bolo: "ruminal_bolus", bolo_ruminal: "ruminal_bolus" };
  return {
    rowNumber: Number(get("rowNumber", "fila", "numero_fila") ?? index + 1),
    sourceRecordId: normalizeText(get("sourceRecordId", "id_origen", "registro") ?? `row-${index + 1}`, 128),
    organizationId: scope.organizationId,
    fieldId: scope.fieldId,
    rup: normalizeRup(get("rup", "rup_origen") ?? scope.rup),
    officialNumber: normalizeDiio(get("diio", "numero_diio", "nro_diio")),
    animalExternalId: normalizeIdentifier(get("animalExternalId", "animal_id", "identificador_animal", "animal")),
    deviceType: typeAliases[rawType] ?? rawType,
    rfidId: normalizeText(get("rfidId", "rfid_id", "rfid"), 128) || null,
    adapterIssueCode: normalizeIdentifier(get("adapterIssueCode", "adapter_issue_code")),
    adapterIssueMessage: normalizeText(get("adapterIssueMessage", "adapter_issue_message"), 500),
  };
}

function normalizeColumnName(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

function addImportDuplicateConflicts(conflicts, rows, property, code, message) {
  const groups = new Map();
  for (const row of rows) {
    const value = row[property];
    if (value === null || value === undefined || value === "") continue;
    groups.set(value, [...(groups.get(value) ?? []), row]);
  }
  for (const group of groups.values()) {
    if (group.length > 1) conflicts.push(importConflict(code, group.map((row) => row.rowNumber), group[0], null, message));
  }
}

function importConflict(code, rowNumbers, row, existingDeviceId, message) {
  return {
    code,
    rowNumbers: [...new Set(rowNumbers)].sort((left, right) => left - right),
    officialNumber: row?.officialNumber || null,
    animalExternalId: row?.animalExternalId || null,
    existingDeviceId,
    message,
  };
}

function addRowIssue(issues, rowNumber, code, field, message) {
  issues.push({ severity: "error", rowNumber, code, field, message });
}

function finding(code, animalId, officialNumber, deviceIds) {
  return { code, animalId: animalId ?? null, officialNumber: officialNumber ?? null, deviceIds: [...deviceIds].sort() };
}

function compareInventoryEntries(left, right) {
  return left.speciesCode.localeCompare(right.speciesCode)
    || left.categoryCode.localeCompare(right.categoryCode)
    || String(left.diio ?? "").localeCompare(String(right.diio ?? ""))
    || left.id.localeCompare(right.id);
}

function compareImportRows(left, right) {
  return left.rowNumber - right.rowNumber || left.officialNumber.localeCompare(right.officialNumber) || left.sourceRecordId.localeCompare(right.sourceRecordId);
}

function addDuplicateIssues(errors, entries, property, code, field, message) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry[property], (counts.get(entry[property]) ?? 0) + 1);
  if ([...counts.values()].some((count) => count > 1)) addIssue(errors, code, field, message);
}

function normalizeIdentifier(value) {
  const normalized = normalizeText(value, 128);
  return IDENTIFIER_PATTERN.test(normalized) ? normalized : "";
}

function normalizeText(value, maxLength) {
  return typeof value === "string" || typeof value === "number" ? String(value).trim().slice(0, maxLength) : "";
}

function requireIdentifier(errors, value, field, code) {
  if (!value) addIssue(errors, code, field, "El identificador es obligatorio y no tiene un formato válido.");
}

function addIssue(issues, code, field, message, severity = "error") {
  issues.push({ severity, code, field, message });
}

function validationResult(errors, warnings = []) {
  return { valid: errors.length === 0, errors, warnings };
}

function isIsoInstant(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z"));
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function canonicalClone(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalClone);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalClone(value[key])]));
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
