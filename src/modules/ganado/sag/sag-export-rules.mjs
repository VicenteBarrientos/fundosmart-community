export const SAG_DRAFT_LABEL = "BORRADOR DECLARABLE SAG - NO DECLARADO";
export const SAG_DRAFT_STATUS = "draft_not_declared";
export const SAG_DEA_FORM_VERSION = "2025-03-05";
export const SAG_FMA_FORM_VERSION = "2024-08-08";
export const SAG_MAX_FMA_DIIO = 45;

export const SAG_DEA_CATEGORIES = Object.freeze({
  bovine: Object.freeze({
    cow: "Vaca",
    heifer: "Vaquilla",
    steer: "Novillo",
    young_bull: "Torito",
    bull: "Toro",
    ox: "Buey",
    female_calf: "Ternera",
    male_calf: "Ternero",
  }),
  ovine: Object.freeze({
    hogget: "Borrega/o",
    wether: "Capón",
    ewe: "Oveja",
    ram: "Carnero",
    lamb: "Cordero/a",
  }),
  mule: Object.freeze({ female: "Hembra", male: "Macho", offspring: "Cría" }),
  equine: Object.freeze({ mare: "Yegua", stallion: "Potro", gelding: "Caballo", offspring: "Cría" }),
  asinine: Object.freeze({ female: "Hembra", male: "Macho", offspring: "Cría" }),
  caprine: Object.freeze({ female: "Hembra", breeding_male: "Macho reproductor", offspring: "Cría" }),
  cervid: Object.freeze({ female: "Hembra", male: "Macho", offspring: "Cría" }),
  rabbit: Object.freeze({ breeder: "Reproductor", fattening: "Engorda", offspring: "Cría" }),
  llama: Object.freeze({ female: "Hembra", male: "Macho", offspring: "Cría" }),
  alpaca: Object.freeze({ female: "Hembra", male: "Macho", offspring: "Cría" }),
  buffalo: Object.freeze({ female: "Hembra", male: "Macho", offspring: "Cría" }),
  swine: Object.freeze({
    industrial_grandparent: "Abuela industrial",
    industrial_breeding_male: "Reproductor macho industrial",
    industrial_breeding_female: "Reproductora hembra industrial",
    growing: "Recría",
    fattening: "Engorda",
    non_industrial_male: "Macho no industrial",
    non_industrial_female: "Hembra no industrial",
  }),
  wild_boar: Object.freeze({ female: "Hembra", male: "Macho" }),
  poultry: Object.freeze({
    broiler_grandparent: "Abuela broiler",
    broiler_breeder: "Reproductor broiler",
    broiler: "Broiler",
    turkey_breeder: "Reproductor de pavos",
    turkey: "Pavo",
    layer_breeder: "Reproductora ponedora",
    layer: "Ponedora",
    backyard_hen: "Gallina de traspatio",
    backyard_turkey: "Pavo de traspatio",
    ostrich: "Avestruz",
    emu: "Emú",
    rhea: "Ñandú",
    quail: "Codorniz",
    goose: "Ganso",
    duck: "Pato",
    pheasant: "Faisán",
    partridge: "Perdiz",
    ornamental: "Ornamental",
  }),
});

export const SAG_SPECIES_LABELS = Object.freeze({
  bovine: "Bovinos",
  ovine: "Ovinos",
  mule: "Mulares",
  equine: "Caballares",
  asinine: "Asnales",
  caprine: "Caprinos",
  cervid: "Cérvidos",
  rabbit: "Conejos",
  llama: "Llamas",
  alpaca: "Alpacas",
  buffalo: "Bubalinos",
  swine: "Porcinos",
  wild_boar: "Jabalíes",
  poultry: "Aves",
});

const SAG_FMA_SPECIES = new Set([
  "bovine", "swine", "equine", "wild_boar", "ovine",
  "cervid", "buffalo", "caprine", "alpaca", "llama",
]);

export function normalizeDiio(value) {
  return String(value ?? "").trim().replace(/[.\s-]/g, "");
}

export function isValidDiio(value) {
  return /^\d{9}$/.test(normalizeDiio(value));
}

export function normalizeRut(value) {
  const compact = String(value ?? "").trim().toUpperCase().replace(/[.\s-]/g, "");
  if (compact.length < 2) return compact;
  return `${compact.slice(0, -1)}-${compact.slice(-1)}`;
}

export function isValidChileanRut(value) {
  const normalized = normalizeRut(value).replace("-", "");
  if (!/^\d{7,8}[0-9K]$/.test(normalized)) return false;
  const body = normalized.slice(0, -1);
  const supplied = normalized.slice(-1);
  let factor = 2;
  let sum = 0;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    sum += Number(body[index]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const remainder = 11 - (sum % 11);
  const expected = remainder === 11 ? "0" : remainder === 10 ? "K" : String(remainder);
  return supplied === expected;
}

export function normalizeRup(value) {
  return String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
}

export function validateSagProfile(profile) {
  const issues = [];
  requiredText(issues, profile?.fieldId, "fieldId", "PROFILE_FIELD_REQUIRED", "Selecciona el fundo que declara.");
  const rup = normalizeRup(profile?.rup);
  if (!rup) issue(issues, "PROFILE_RUP_REQUIRED", "rup", "Registra el RUP del establecimiento.");
  else if (!/^[0-9A-Z.-]{4,32}$/.test(rup)) issue(issues, "PROFILE_RUP_INVALID", "rup", "El RUP contiene caracteres o un largo no válidos.");
  if (!profile?.holderRut) issue(issues, "PROFILE_HOLDER_RUT_REQUIRED", "holderRut", "Registra el RUT del titular o mandatario.");
  else if (!isValidChileanRut(profile.holderRut)) issue(issues, "PROFILE_HOLDER_RUT_INVALID", "holderRut", "El RUT del titular o mandatario no es válido.");
  requiredText(issues, profile?.holderName, "holderName", "PROFILE_HOLDER_NAME_REQUIRED", "Registra el nombre del titular o mandatario.");
  requiredText(issues, profile?.commune, "commune", "PROFILE_COMMUNE_REQUIRED", "Registra la comuna del establecimiento.");
  requiredText(issues, profile?.address, "address", "PROFILE_ADDRESS_REQUIRED", "Registra la dirección del establecimiento.");
  return issues;
}

export function buildDeaDraft(input) {
  const errors = validateSagProfile(input?.profile);
  const warnings = [];
  const asOfDate = String(input?.asOfDate ?? "").trim();
  if (!isIsoDate(asOfDate)) issue(errors, "DEA_DATE_INVALID", "asOfDate", "Indica una fecha de corte válida para la DEA.");
  const entries = Array.isArray(input?.inventoryEntries) ? input.inventoryEntries : [];
  if (entries.length === 0) issue(errors, "DEA_INVENTORY_REQUIRED", "inventoryEntries", "No hay existencias para resumir.");

  const normalizedEntries = [];
  for (const [index, entry] of entries.entries()) {
    if (entry?.status && entry.status !== "active") continue;
    const entryIssues = validateInventoryEntry(entry, input?.profile?.fieldId, `inventoryEntries[${index}]`);
    errors.push(...entryIssues);
    if (entryIssues.length === 0) {
      normalizedEntries.push({
        id: String(entry.id ?? `entry-${index + 1}`),
        fieldId: String(entry.fieldId ?? input.profile.fieldId),
        speciesCode: entry.speciesCode,
        categoryCode: entry.categoryCode,
        quantity: entry.quantity ?? 1,
        trackingMode: entry.trackingMode === "summary" ? "summary" : "individual",
      });
    }
  }
  if (entries.length > 0 && normalizedEntries.length === 0 && errors.length === validateSagProfile(input?.profile).length) {
    issue(errors, "DEA_NO_ACTIVE_INVENTORY", "inventoryEntries", "No hay animales activos para declarar.");
  }

  const validation = validationResult(errors, warnings);
  if (!validation.valid) return { validation, draft: null };

  const categoryTotals = new Map();
  for (const entry of normalizedEntries) {
    const key = `${entry.speciesCode}:${entry.categoryCode}`;
    categoryTotals.set(key, (categoryTotals.get(key) ?? 0) + entry.quantity);
  }
  const rows = [...categoryTotals.entries()]
    .map(([key, quantity]) => {
      const [speciesCode, categoryCode] = key.split(":");
      return {
        speciesCode,
        speciesLabel: SAG_SPECIES_LABELS[speciesCode],
        categoryCode,
        categoryLabel: SAG_DEA_CATEGORIES[speciesCode][categoryCode],
        quantity,
      };
    })
    .sort((left, right) => left.speciesLabel.localeCompare(right.speciesLabel, "es") || left.categoryLabel.localeCompare(right.categoryLabel, "es"));

  return {
    validation,
    draft: {
      documentKind: "SAG_DEA_DRAFT",
      draftLabel: SAG_DRAFT_LABEL,
      declarationStatus: SAG_DRAFT_STATUS,
      declared: false,
      formVersion: input?.formVersion ?? SAG_DEA_FORM_VERSION,
      generatedAt: input?.generatedAt ?? null,
      asOfDate,
      establishment: normalizeProfile(input.profile),
      rows,
      totalAnimals: rows.reduce((total, row) => total + row.quantity, 0),
    },
  };
}

export function buildFmaDrafts(input) {
  const errors = validateSagProfile(input?.profile);
  const warnings = [];
  const movement = input?.movement ?? {};
  validateMovement(errors, movement);
  const animals = Array.isArray(input?.animals) ? input.animals : [];
  if (animals.length === 0) issue(errors, "FMA_ANIMALS_REQUIRED", "animals", "Selecciona al menos un animal para el movimiento.");

  const normalizedAnimals = [];
  const diioIndexes = new Map();
  for (const [index, animal] of animals.entries()) {
    const path = `animals[${index}]`;
    const animalIssues = validateFmaAnimal(animal, input?.profile?.fieldId, path);
    errors.push(...animalIssues);
    if (animalIssues.length > 0) continue;
    const diio = normalizeDiio(animal.diio);
    if (diioIndexes.has(diio)) {
      issue(errors, "FMA_DIIO_DUPLICATED", `${path}.diio`, `El DIIO ${diio} está repetido en el movimiento.`);
      continue;
    }
    diioIndexes.set(diio, index);
    normalizedAnimals.push({
      animalId: String(animal.id),
      diio,
      speciesCode: animal.speciesCode,
      speciesLabel: SAG_SPECIES_LABELS[animal.speciesCode],
      categoryCode: animal.categoryCode,
      categoryLabel: SAG_DEA_CATEGORIES[animal.speciesCode][animal.categoryCode],
    });
  }

  const withdrawals = Array.isArray(input?.withdrawals) ? input.withdrawals : [];
  const departureDate = String(movement.departureDate ?? "");
  for (const animal of normalizedAnimals) {
    const active = withdrawals.filter((entry) => entry?.animalId === animal.animalId && withdrawalIsActive(entry, departureDate));
    if (active.length > 0) {
      const latest = active.flatMap((entry) => [entry.withdrawalMilkUntil, entry.withdrawalMeatUntil]).filter(Boolean).sort().at(-1);
      issue(errors, "FMA_ACTIVE_WITHDRAWAL", `animals.${animal.animalId}`, `El animal ${animal.diio} mantiene un resguardo activo${latest ? ` hasta ${latest}` : ""}.`);
    }
  }

  const validation = validationResult(errors, warnings);
  if (!validation.valid) return { validation, drafts: [] };

  const groups = chunk(normalizedAnimals, SAG_MAX_FMA_DIIO);
  const drafts = groups.map((group, index) => ({
    documentKind: "SAG_FMA_DRAFT",
    draftLabel: SAG_DRAFT_LABEL,
    declarationStatus: SAG_DRAFT_STATUS,
    declared: false,
    formVersion: input?.formVersion ?? SAG_FMA_FORM_VERSION,
    generatedAt: input?.generatedAt ?? null,
    movementId: String(movement.id),
    draftNumber: index + 1,
    draftCount: groups.length,
    referenceFolio: movement.referenceFolio ? String(movement.referenceFolio).trim() : null,
    establishment: normalizeProfile(input.profile),
    destination: {
      rup: normalizeRup(movement.destinationRup),
      commune: String(movement.destinationCommune).trim(),
      address: String(movement.destinationAddress).trim(),
    },
    departure: { date: movement.departureDate, time: movement.departureTime },
    expectedArrival: { date: movement.arrivalDate, time: movement.arrivalTime },
    transport: {
      carrierName: String(movement.carrierName).trim(),
      carrierRut: normalizeRut(movement.carrierRut),
      vehiclePlate: String(movement.vehiclePlate).trim().toUpperCase(),
      trailerPlate: movement.trailerPlate ? String(movement.trailerPlate).trim().toUpperCase() : null,
    },
    declarations: {
      noQuarantine: true,
      noSymptoms: true,
      noActiveWithdrawal: true,
    },
    observations: String(movement.observations ?? "").trim(),
    animals: group,
    categoryTotals: summarizeFmaCategories(group),
  }));
  return { validation, drafts };
}

export function deaDraftToCsv(draft) {
  assertDraft(draft, "SAG_DEA_DRAFT");
  const headers = [
    "TIPO_DOCUMENTO", "ESTADO", "VERSION_FORMULARIO", "FECHA_CORTE", "RUP",
    "TITULAR", "ESPECIE_CODIGO", "ESPECIE", "CATEGORIA_CODIGO", "CATEGORIA", "CANTIDAD",
  ];
  const rows = draft.rows.map((row) => [
    draft.documentKind, draft.draftLabel, draft.formVersion, draft.asOfDate, draft.establishment.rup,
    draft.establishment.holderName, row.speciesCode, row.speciesLabel, row.categoryCode, row.categoryLabel, row.quantity,
  ]);
  return toCsv(headers, rows);
}

export function fmaDraftToCsv(draft) {
  assertDraft(draft, "SAG_FMA_DRAFT");
  const headers = [
    "TIPO_DOCUMENTO", "ESTADO", "VERSION_FORMULARIO", "MOVIMIENTO_ID", "PARTE", "TOTAL_PARTES",
    "RUP_ORIGEN", "RUT_TITULAR", "RUP_DESTINO", "COMUNA_DESTINO", "DIRECCION_DESTINO",
    "FECHA_SALIDA", "HORA_SALIDA", "FECHA_LLEGADA", "HORA_LLEGADA", "TRANSPORTISTA",
    "RUT_TRANSPORTISTA", "PATENTE", "PATENTE_ACOPLADO", "DIIO", "ESPECIE_CODIGO", "ESPECIE",
    "CATEGORIA_CODIGO", "CATEGORIA", "OBSERVACIONES",
  ];
  const rows = draft.animals.map((animal) => [
    draft.documentKind, draft.draftLabel, draft.formVersion, draft.movementId, draft.draftNumber, draft.draftCount,
    draft.establishment.rup, draft.establishment.holderRut, draft.destination.rup, draft.destination.commune, draft.destination.address,
    draft.departure.date, draft.departure.time, draft.expectedArrival.date, draft.expectedArrival.time,
    draft.transport.carrierName, draft.transport.carrierRut, draft.transport.vehiclePlate, draft.transport.trailerPlate ?? "",
    animal.diio, animal.speciesCode, animal.speciesLabel, animal.categoryCode, animal.categoryLabel, draft.observations,
  ]);
  return toCsv(headers, rows);
}

export function fmaDraftsToCsv(drafts) {
  if (!Array.isArray(drafts) || drafts.length === 0) throw new TypeError("No hay borradores FMA válidos para exportar.");
  const bodies = drafts.map((draft) => fmaDraftToCsv(draft).replace(/^\uFEFF/, ""));
  return `\uFEFF${bodies.join("\r\n")}`;
}

function validateInventoryEntry(entry, fieldId, path) {
  const issues = [];
  if (entry?.fieldId && fieldId && entry.fieldId !== fieldId) issue(issues, "DEA_FIELD_MISMATCH", `${path}.fieldId`, "La existencia pertenece a otro fundo.");
  validateSagCategory(issues, entry?.speciesCode, entry?.categoryCode, path);
  const quantity = entry?.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity <= 0) issue(issues, "DEA_QUANTITY_INVALID", `${path}.quantity`, "La cantidad debe ser un entero mayor que cero.");
  if (entry?.trackingMode === "individual" && quantity !== 1) issue(issues, "DEA_INDIVIDUAL_QUANTITY_INVALID", `${path}.quantity`, "Una existencia individual debe representar exactamente un animal.");
  return issues;
}

function validateFmaAnimal(animal, fieldId, path) {
  const issues = [];
  requiredText(issues, animal?.id, `${path}.id`, "FMA_ANIMAL_ID_REQUIRED", "Falta el identificador interno de un animal.");
  if (animal?.fieldId && fieldId && animal.fieldId !== fieldId) issue(issues, "FMA_FIELD_MISMATCH", `${path}.fieldId`, "El animal pertenece a otro fundo.");
  if (animal?.status && animal.status !== "active") issue(issues, "FMA_ANIMAL_NOT_ACTIVE", `${path}.status`, "Solo se pueden incluir animales activos en un movimiento.");
  if (!isValidDiio(animal?.diio)) issue(issues, "FMA_DIIO_INVALID", `${path}.diio`, "El FMA requiere un DIIO de 9 dígitos.");
  validateSagCategory(issues, animal?.speciesCode, animal?.categoryCode, path);
  if (animal?.speciesCode && !SAG_FMA_SPECIES.has(animal.speciesCode)) issue(issues, "FMA_SPECIES_UNSUPPORTED", `${path}.speciesCode`, "La especie no está habilitada por este borrador FMA.");
  return issues;
}

function validateSagCategory(issues, speciesCode, categoryCode, path) {
  if (!speciesCode || !SAG_DEA_CATEGORIES[speciesCode]) {
    issue(issues, "SAG_SPECIES_INVALID", `${path}.speciesCode`, "Selecciona una especie SAG válida.");
    return;
  }
  if (!categoryCode || !SAG_DEA_CATEGORIES[speciesCode][categoryCode]) {
    issue(issues, "SAG_CATEGORY_INVALID", `${path}.categoryCode`, "La categoría no corresponde a la especie SAG seleccionada.");
  }
}

function validateMovement(issues, movement) {
  requiredText(issues, movement?.id, "movement.id", "FMA_MOVEMENT_ID_REQUIRED", "Falta el identificador del movimiento.");
  const destinationRup = normalizeRup(movement?.destinationRup);
  if (!destinationRup) issue(issues, "FMA_DESTINATION_RUP_REQUIRED", "movement.destinationRup", "Registra el RUP de destino.");
  else if (!/^[0-9A-Z.-]{4,32}$/.test(destinationRup)) issue(issues, "FMA_DESTINATION_RUP_INVALID", "movement.destinationRup", "El RUP de destino no es válido.");
  requiredText(issues, movement?.destinationCommune, "movement.destinationCommune", "FMA_DESTINATION_COMMUNE_REQUIRED", "Registra la comuna de destino.");
  requiredText(issues, movement?.destinationAddress, "movement.destinationAddress", "FMA_DESTINATION_ADDRESS_REQUIRED", "Registra la dirección de destino.");
  if (!isIsoDate(movement?.departureDate)) issue(issues, "FMA_DEPARTURE_DATE_INVALID", "movement.departureDate", "Indica una fecha de salida válida.");
  if (!isTime(movement?.departureTime)) issue(issues, "FMA_DEPARTURE_TIME_INVALID", "movement.departureTime", "Indica una hora de salida válida.");
  if (!isIsoDate(movement?.arrivalDate)) issue(issues, "FMA_ARRIVAL_DATE_INVALID", "movement.arrivalDate", "Indica una fecha estimada de llegada válida.");
  if (!isTime(movement?.arrivalTime)) issue(issues, "FMA_ARRIVAL_TIME_INVALID", "movement.arrivalTime", "Indica una hora estimada de llegada válida.");
  if (isIsoDate(movement?.departureDate) && isIsoDate(movement?.arrivalDate) && movement.arrivalDate < movement.departureDate) {
    issue(issues, "FMA_ARRIVAL_BEFORE_DEPARTURE", "movement.arrivalDate", "La llegada no puede ser anterior a la salida.");
  }
  requiredText(issues, movement?.carrierName, "movement.carrierName", "FMA_CARRIER_NAME_REQUIRED", "Registra el nombre del transportista.");
  if (!movement?.carrierRut) issue(issues, "FMA_CARRIER_RUT_REQUIRED", "movement.carrierRut", "Registra el RUT del transportista.");
  else if (!isValidChileanRut(movement.carrierRut)) issue(issues, "FMA_CARRIER_RUT_INVALID", "movement.carrierRut", "El RUT del transportista no es válido.");
  requiredText(issues, movement?.vehiclePlate, "movement.vehiclePlate", "FMA_VEHICLE_PLATE_REQUIRED", "Registra la patente del vehículo.");
  const declarations = movement?.declarations ?? {};
  if (declarations.noQuarantine !== true) issue(issues, "FMA_DECLARATION_QUARANTINE_REQUIRED", "movement.declarations.noQuarantine", "Debes confirmar que el origen no está sujeto a cuarentena o restricción oficial.");
  if (declarations.noSymptoms !== true) issue(issues, "FMA_DECLARATION_SYMPTOMS_REQUIRED", "movement.declarations.noSymptoms", "Debes confirmar que los animales no presentan síntomas compatibles con EDO.");
  if (declarations.noActiveWithdrawal !== true) issue(issues, "FMA_DECLARATION_WITHDRAWAL_REQUIRED", "movement.declarations.noActiveWithdrawal", "Debes confirmar que los animales no mantienen resguardos activos.");
}

function withdrawalIsActive(entry, onDate) {
  if (entry?.status === "cancelled") return false;
  return [entry?.withdrawalMilkUntil, entry?.withdrawalMeatUntil].some((value) => isIsoDate(value) && value >= onDate);
}

function summarizeFmaCategories(animals) {
  const totals = new Map();
  for (const animal of animals) {
    const key = `${animal.speciesCode}:${animal.categoryCode}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  }
  return [...totals.entries()].map(([key, quantity]) => {
    const [speciesCode, categoryCode] = key.split(":");
    return {
      speciesCode,
      speciesLabel: SAG_SPECIES_LABELS[speciesCode],
      categoryCode,
      categoryLabel: SAG_DEA_CATEGORIES[speciesCode][categoryCode],
      quantity,
    };
  });
}

function normalizeProfile(profile) {
  return {
    fieldId: String(profile.fieldId).trim(),
    rup: normalizeRup(profile.rup),
    holderRut: normalizeRut(profile.holderRut),
    holderName: String(profile.holderName).trim(),
    commune: String(profile.commune).trim(),
    address: String(profile.address).trim(),
  };
}

function validationResult(errors, warnings) {
  return { valid: errors.length === 0, errors, warnings };
}

function requiredText(issues, value, field, code, message) {
  if (typeof value !== "string" || !value.trim()) issue(issues, code, field, message);
}

function issue(issues, code, field, message) {
  issues.push({ severity: "error", code, field, message });
}

function isIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
}

function assertDraft(draft, kind) {
  if (!draft || draft.documentKind !== kind || draft.declared !== false || draft.declarationStatus !== SAG_DRAFT_STATUS) {
    throw new TypeError("Solo se pueden exportar borradores SAG válidos y no declarados.");
  }
}

function toCsv(headers, rows) {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
}

function csvCell(value) {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
