const REPRODUCTIVE_EVENT_TYPES = new Set([
  "heat",
  "service",
  "insemination",
  "pregnancy_diagnosis",
  "calving",
  "dry_off",
  "abortion",
]);
const CALVING_TYPES = new Set(["single", "twin", "multiple", "unknown"]);
const CALVING_DIFFICULTIES = new Set(["unassisted", "assisted", "dystocia", "unknown"]);
const BIRTH_OUTCOMES = new Set(["live", "mixed", "stillbirth", "unknown"]);
const OFFSPRING_OUTCOMES = new Set(["alive", "stillborn", "deceased", "unknown"]);
const LIVESTOCK_SEXES = new Set(["female", "male", "unknown"]);
const HEALTH_EVENT_TYPES = new Set(["observation", "diagnosis", "treatment", "vaccination", "withdrawal_clearance"]);
const HEALTH_EVENT_STATUSES = new Set(["open", "completed", "cancelled"]);
const ANIMAL_TAG_PATTERN = /^[A-Za-z0-9.-]+$/;
const ANIMAL_TAG_MAX_LENGTH = 60;

export class AnimalRecordRuleError extends Error {
  constructor(message, code = "ANIMAL_RECORD_INVALID") {
    super(message);
    this.name = "AnimalRecordRuleError";
    this.code = code;
  }
}

export function normalizeMilkControlInput(input) {
  const animalId = requiredText(input?.animalId, "Selecciona un animal.", "ANIMAL_REQUIRED");
  const controlDate = requiredDate(input?.controlDate, "Ingresa una fecha de control válida.", "CONTROL_DATE_INVALID");
  const morningLiters = optionalNumber(input?.morningLiters, "La leche AM no es válida.");
  const afternoonLiters = optionalNumber(input?.afternoonLiters, "La leche PM no es válida.");
  const thirdMilkingLiters = optionalNumber(input?.thirdMilkingLiters, "La tercera ordeña no es válida.");
  const suppliedTotal = optionalNumber(input?.totalLiters, "El total de leche no es válido.");
  for (const value of [morningLiters, afternoonLiters, thirdMilkingLiters, suppliedTotal]) {
    if (value !== null && value < 0) throw new AnimalRecordRuleError("Los litros no pueden ser negativos.", "MILK_NEGATIVE");
  }

  const milkings = [morningLiters, afternoonLiters, thirdMilkingLiters].filter((value) => value !== null);
  const measuredTotal = milkings.reduce((total, value) => total + value, 0);
  const totalLiters = suppliedTotal ?? (milkings.length > 0 ? round(measuredTotal, 3) : null);
  if (totalLiters === null || totalLiters <= 0) {
    throw new AnimalRecordRuleError("Registra un total de leche mayor que cero.", "MILK_TOTAL_REQUIRED");
  }
  if (suppliedTotal !== null && milkings.length > 0 && Math.abs(suppliedTotal - measuredTotal) > 0.2) {
    throw new AnimalRecordRuleError("El total de leche no coincide con la suma de las ordeñas.", "MILK_TOTAL_MISMATCH");
  }

  const fatPct = optionalNumber(input?.fatPct, "El porcentaje de grasa no es válido.");
  const proteinPct = optionalNumber(input?.proteinPct, "El porcentaje de proteína no es válido.");
  for (const [label, value] of [["grasa", fatPct], ["proteína", proteinPct]]) {
    if (value !== null && (value < 0 || value > 15)) {
      throw new AnimalRecordRuleError(`El porcentaje de ${label} debe estar entre 0 y 15.`, "MILK_PERCENTAGE_INVALID");
    }
  }

  const somaticCellCount = optionalInteger(input?.somaticCellCount, "El recuento de células somáticas debe ser un entero no negativo.");
  if (somaticCellCount !== null && somaticCellCount < 0) {
    throw new AnimalRecordRuleError("El recuento de células somáticas no puede ser negativo.", "SCC_NEGATIVE");
  }

  return {
    animalId,
    controlDate,
    morningLiters,
    afternoonLiters,
    thirdMilkingLiters,
    totalLiters: round(totalLiters, 3),
    fatPct,
    proteinPct,
    somaticCellCount,
    notes: optionalText(input?.notes, 1_000),
  };
}

export function normalizeReproductiveEventInput(input) {
  const animalId = requiredText(input?.animalId, "Selecciona un animal.", "ANIMAL_REQUIRED");
  const eventType = typeof input?.eventType === "string" ? input.eventType.trim() : "";
  if (!REPRODUCTIVE_EVENT_TYPES.has(eventType)) {
    throw new AnimalRecordRuleError("Selecciona un evento reproductivo válido.", "REPRODUCTIVE_EVENT_INVALID");
  }
  return {
    animalId,
    eventType,
    occurredAt: requiredDate(input?.occurredAt, "Ingresa una fecha de evento válida.", "EVENT_DATE_INVALID"),
    method: nullableText(input?.method, 120),
    result: nullableText(input?.result, 160),
    sireIdentifier: nullableText(input?.sireIdentifier, 120),
    notes: optionalText(input?.notes, 1_000),
  };
}

export function normalizeBirthInput(input) {
  const animalId = requiredText(input?.animalId, "Selecciona una madre.", "ANIMAL_REQUIRED");
  const occurredAt = requiredDate(input?.occurredAt, "Ingresa una fecha de parto válida.", "BIRTH_DATE_INVALID");
  const calvingType = enumValue(input?.calvingType, CALVING_TYPES, "Selecciona un tipo de parto válido.", "CALVING_TYPE_INVALID");
  const difficulty = enumValue(input?.difficulty, CALVING_DIFFICULTIES, "Selecciona una dificultad de parto válida.", "CALVING_DIFFICULTY_INVALID");
  const outcome = enumValue(input?.outcome, BIRTH_OUTCOMES, "Selecciona un resultado de parto válido.", "BIRTH_OUTCOME_INVALID");
  const rawOffspring = Array.isArray(input?.offspring) ? input.offspring : [];
  if (rawOffspring.length < 1 || rawOffspring.length > 3) {
    throw new AnimalRecordRuleError("Registra entre una y tres crías para el parto.", "OFFSPRING_COUNT_INVALID");
  }
  if (calvingType === "single" && rawOffspring.length !== 1) {
    throw new AnimalRecordRuleError("Un parto único debe tener exactamente una cría.", "CALVING_COUNT_MISMATCH");
  }
  if (calvingType === "twin" && rawOffspring.length !== 2) {
    throw new AnimalRecordRuleError("Un parto de mellizos debe tener exactamente dos crías.", "CALVING_COUNT_MISMATCH");
  }
  if (calvingType === "multiple" && rawOffspring.length < 2) {
    throw new AnimalRecordRuleError("Un parto múltiple debe tener al menos dos crías.", "CALVING_COUNT_MISMATCH");
  }
  const offspring = rawOffspring.map((entry, index) => {
    const temporaryIdentifier = requiredText(entry?.temporaryIdentifier, `Identifica la cría ${index + 1}.`, "OFFSPRING_IDENTIFIER_REQUIRED").slice(0, 120);
    const sex = enumValue(entry?.sex, LIVESTOCK_SEXES, `Selecciona el sexo de la cría ${index + 1}.`, "OFFSPRING_SEX_INVALID");
    const offspringOutcome = enumValue(entry?.outcome, OFFSPRING_OUTCOMES, `Selecciona el resultado de la cría ${index + 1}.`, "OFFSPRING_OUTCOME_INVALID");
    const birthWeightKg = optionalNumber(entry?.birthWeightKg, `El peso de la cría ${index + 1} no es válido.`);
    if (birthWeightKg !== null && (birthWeightKg <= 0 || birthWeightKg > 100)) {
      throw new AnimalRecordRuleError("El peso de nacimiento debe ser mayor que cero y no superar 100 kg.", "OFFSPRING_WEIGHT_INVALID");
    }
    return {
      temporaryIdentifier,
      sex,
      outcome: offspringOutcome,
      birthWeightKg: birthWeightKg === null ? null : round(birthWeightKg, 2),
      notes: optionalText(entry?.notes, 500),
    };
  });
  if (new Set(offspring.map((entry) => entry.temporaryIdentifier.toLocaleLowerCase("es"))).size !== offspring.length) {
    throw new AnimalRecordRuleError("Las crías del mismo parto deben tener identificadores distintos.", "OFFSPRING_IDENTIFIER_DUPLICATE");
  }
  return {
    animalId,
    occurredAt,
    calvingType,
    difficulty,
    outcome,
    sireIdentifier: nullableText(input?.sireIdentifier, 120),
    notes: optionalText(input?.notes, 1_000),
    offspring,
  };
}

export function normalizeHealthEventInput(input) {
  const animalId = requiredText(input?.animalId, "Selecciona un animal.", "ANIMAL_REQUIRED");
  const eventType = enumValue(input?.eventType, HEALTH_EVENT_TYPES, "Selecciona un evento sanitario válido.", "HEALTH_EVENT_INVALID");
  const occurredAt = requiredDate(input?.occurredAt, "Ingresa una fecha sanitaria válida.", "HEALTH_DATE_INVALID");
  const status = enumValue(input?.status, HEALTH_EVENT_STATUSES, "Selecciona un estado sanitario válido.", "HEALTH_STATUS_INVALID");
  const condition = nullableText(input?.condition, 180);
  const productName = nullableText(input?.productName, 180);
  const activeIngredient = nullableText(input?.activeIngredient, 180);
  const doseAmount = optionalNumber(input?.doseAmount, "La dosis no es válida.");
  const doseUnit = nullableText(input?.doseUnit, 40);
  const withdrawalMilkUntil = optionalDate(input?.withdrawalMilkUntil, "La fecha de retiro de leche no es válida.", "MILK_WITHDRAWAL_DATE_INVALID");
  const withdrawalMeatUntil = optionalDate(input?.withdrawalMeatUntil, "La fecha de retiro de carne no es válida.", "MEAT_WITHDRAWAL_DATE_INVALID");
  if (["observation", "diagnosis", "treatment"].includes(eventType) && !condition) {
    throw new AnimalRecordRuleError("Describe la condición o motivo del evento.", "HEALTH_CONDITION_REQUIRED");
  }
  if (["treatment", "vaccination"].includes(eventType) && !productName) {
    throw new AnimalRecordRuleError("Registra el producto aplicado.", "HEALTH_PRODUCT_REQUIRED");
  }
  if ((doseAmount === null) !== (doseUnit === null)) {
    throw new AnimalRecordRuleError("Registra juntos el valor y la unidad de la dosis.", "HEALTH_DOSE_INCOMPLETE");
  }
  if (doseAmount !== null && doseAmount < 0) {
    throw new AnimalRecordRuleError("La dosis no puede ser negativa.", "HEALTH_DOSE_INVALID");
  }
  for (const withdrawalDate of [withdrawalMilkUntil, withdrawalMeatUntil]) {
    if (withdrawalDate !== null && withdrawalDate < occurredAt) {
      throw new AnimalRecordRuleError("El retiro no puede terminar antes del evento sanitario.", "HEALTH_WITHDRAWAL_INVALID");
    }
  }
  return {
    animalId,
    eventType,
    occurredAt,
    status,
    condition,
    productName,
    activeIngredient,
    doseAmount: doseAmount === null ? null : round(doseAmount, 3),
    doseUnit,
    route: nullableText(input?.route, 80),
    withdrawalMilkUntil,
    withdrawalMeatUntil,
    professional: nullableText(input?.professional, 160),
    notes: optionalText(input?.notes, 1_000),
  };
}

export function normalizeAnimalTag(value) {
  return typeof value === "string" ? value.trim().toLocaleUpperCase("en") : "";
}

export function normalizeRenumberInput(input, today = new Date().toISOString().slice(0, 10)) {
  const animalId = requiredText(input?.animalId, "Selecciona un animal.", "ANIMAL_REQUIRED");
  const newTag = requiredText(input?.newTag, "Ingresa el número nuevo.", "RENUMBER_TAG_REQUIRED");
  if (newTag.length > ANIMAL_TAG_MAX_LENGTH) {
    throw new AnimalRecordRuleError("El número nuevo es demasiado largo.", "RENUMBER_TAG_TOO_LONG");
  }
  if (!ANIMAL_TAG_PATTERN.test(newTag)) {
    throw new AnimalRecordRuleError("El número nuevo solo admite letras, dígitos, punto y guion.", "RENUMBER_TAG_INVALID");
  }
  const effectiveOn = requiredDate(input?.effectiveOn, "Ingresa una fecha de cambio válida.", "RENUMBER_DATE_INVALID");
  if (effectiveOn > today) {
    throw new AnimalRecordRuleError("El cambio de número no puede quedar vigente a futuro.", "RENUMBER_DATE_FUTURE");
  }
  return { animalId, newTag, normalizedNewTag: normalizeAnimalTag(newTag), effectiveOn, reason: nullableText(input?.reason, 300) };
}

function requiredText(value, message, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new AnimalRecordRuleError(message, code);
  return normalized;
}

function requiredDate(value, message, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new AnimalRecordRuleError(message, code);
  const date = new Date(`${normalized}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
    throw new AnimalRecordRuleError(message, code);
  }
  return normalized;
}

function optionalDate(value, message, code) {
  if (value === null || value === undefined || value === "") return null;
  return requiredDate(value, message, code);
}

function enumValue(value, allowed, message, code) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!allowed.has(normalized)) throw new AnimalRecordRuleError(message, code);
  return normalized;
}

function optionalNumber(value, message) {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(String(value).replace(",", "."));
  if (!Number.isFinite(number)) throw new AnimalRecordRuleError(message, "NUMBER_INVALID");
  return number;
}

function optionalInteger(value, message) {
  const number = optionalNumber(value, message);
  if (number !== null && !Number.isInteger(number)) throw new AnimalRecordRuleError(message, "INTEGER_INVALID");
  return number;
}

function nullableText(value, maxLength) {
  const normalized = optionalText(value, maxLength);
  return normalized || null;
}

function optionalText(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
