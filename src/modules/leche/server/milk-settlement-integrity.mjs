// These application/portable-input limits are intentionally stricter than the
// public D1 invariant layer. Existing rows remain readable, while every
// product mutation and validated restore must satisfy this narrower contract.
export const MILK_SETTLEMENT_LIMITS = Object.freeze({
  plant: 128,
  purchaseOrder: 128,
  producerCode: 128,
  partyName: 200,
  sourceDocumentName: 255,
  notes: 4_000,
  lineItems: 200,
  lineItemDescription: 200,
  lineItemMeasurement: 200,
});

export function deriveMilkSettlementPrices(value) {
  const settlement = record(value);
  if (
    !settlement
    || !isFiniteNumber(settlement.totalLiters)
    || settlement.totalLiters <= 0
    || !isFiniteNumber(settlement.netAmountClp)
    || !isFiniteNumber(settlement.grossAmountClp)
  ) return value;

  return {
    ...settlement,
    netPricePerLiterClp: roundPrice(settlement.netAmountClp / settlement.totalLiters),
    grossPricePerLiterClp: roundPrice(settlement.grossAmountClp / settlement.totalLiters),
  };
}

export function milkSettlementIntegrityIssues(value) {
  const settlement = record(value);
  if (!settlement) return ["La liquidación debe ser un objeto válido."];

  const issues = [];
  validateText(issues, settlement.id, 200, "El identificador de la liquidación no es válido.");
  validateText(issues, settlement.fieldId, 200, "El fundo de la liquidación no es válido.");
  if (typeof settlement.period !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(settlement.period)) {
    issues.push("El período debe identificar un mes válido en formato AAAA-MM.");
  }
  if (settlement.generatedAt !== null && !isValidDate(settlement.generatedAt)) {
    issues.push("La fecha de emisión de la liquidación no es válida.");
  }
  validateText(issues, settlement.plant, MILK_SETTLEMENT_LIMITS.plant, "La planta no puede superar 128 caracteres.", true);
  validateText(issues, settlement.purchaseOrder, MILK_SETTLEMENT_LIMITS.purchaseOrder, "La orden de compra no es válida.");
  validateText(issues, settlement.producerCode, MILK_SETTLEMENT_LIMITS.producerCode, "El código de productor no puede superar 128 caracteres.", true);
  validateText(issues, settlement.producerName, MILK_SETTLEMENT_LIMITS.partyName, "El nombre del productor no es válido.");
  validateText(issues, settlement.buyerName, MILK_SETTLEMENT_LIMITS.partyName, "La empresa compradora no es válida.");

  const totalLitersValid = isFiniteNumber(settlement.totalLiters) && settlement.totalLiters > 0;
  if (!totalLitersValid) issues.push("Los litros totales deben ser mayores que cero.");
  const firstHalfValid = validateHalfLiters(issues, settlement.litersFirstHalf, "primera");
  const secondHalfValid = validateHalfLiters(issues, settlement.litersSecondHalf, "segunda");
  if (
    totalLitersValid
    && firstHalfValid
    && secondHalfValid
    && (settlement.litersFirstHalf !== null || settlement.litersSecondHalf !== null)
  ) {
    const partsTotal = (settlement.litersFirstHalf ?? 0) + (settlement.litersSecondHalf ?? 0);
    const tolerance = 0.0010000001;
    if (Math.abs(partsTotal - settlement.totalLiters) > tolerance) {
      issues.push("La suma de litros por quincena debe coincidir con el total.");
    }
  }

  const netAmountValid = isNonNegativeSafeInteger(settlement.netAmountClp);
  const taxAmountValid = isNonNegativeSafeInteger(settlement.taxAmountClp);
  if (!netAmountValid) issues.push("El monto neto debe ser un CLP entero no negativo.");
  if (!taxAmountValid) issues.push("El IVA debe ser un CLP entero no negativo.");
  const grossAmountValid = Number.isSafeInteger(settlement.grossAmountClp)
    && settlement.grossAmountClp > 0
    && netAmountValid
    && taxAmountValid
    && settlement.grossAmountClp === settlement.netAmountClp + settlement.taxAmountClp;
  if (!grossAmountValid) issues.push("El total debe ser un CLP entero igual al neto más IVA.");

  const netPriceValid = isFiniteNumber(settlement.netPricePerLiterClp)
    && settlement.netPricePerLiterClp > 0;
  if (!netPriceValid) {
    issues.push("El precio neto por litro debe ser mayor que cero.");
  } else if (
    totalLitersValid
    && netAmountValid
    && Math.abs(settlement.netPricePerLiterClp - settlement.netAmountClp / settlement.totalLiters) > 0.01
  ) {
    issues.push("El precio neto por litro no coincide con el monto y los litros.");
  }

  const grossPriceValid = settlement.grossPricePerLiterClp === null
    || (isFiniteNumber(settlement.grossPricePerLiterClp) && settlement.grossPricePerLiterClp > 0);
  if (!grossPriceValid) {
    issues.push("El precio bruto por litro debe ser mayor que cero.");
  } else if (
    settlement.grossPricePerLiterClp !== null
    && totalLitersValid
    && grossAmountValid
    && Math.abs(settlement.grossPricePerLiterClp - settlement.grossAmountClp / settlement.totalLiters) > 0.01
  ) {
    issues.push("El precio bruto por litro no coincide con el total y los litros.");
  }

  if (settlement.sourceDocumentName !== null) {
    validateText(
      issues,
      settlement.sourceDocumentName,
      MILK_SETTLEMENT_LIMITS.sourceDocumentName,
      "El nombre del documento de origen no es válido.",
    );
  }
  validateText(issues, settlement.notes, MILK_SETTLEMENT_LIMITS.notes, "Las notas no pueden superar 4.000 caracteres.", true);

  validateLineItems(issues, settlement.lineItems, settlement.netAmountClp, netAmountValid);
  const createdAtValid = isValidDate(settlement.createdAt);
  const updatedAtValid = isValidDate(settlement.updatedAt);
  if (!createdAtValid || !updatedAtValid) {
    issues.push("La versión temporal de la liquidación no es válida.");
  } else if (Date.parse(settlement.updatedAt) < Date.parse(settlement.createdAt)) {
    issues.push("La fecha de actualización no puede ser anterior a la creación.");
  }
  return issues;
}

export function portableMilkSettlementIntegrityIssues(value) {
  const row = record(value);
  if (!row) return ["La fila de liquidación debe ser un objeto válido."];
  return milkSettlementIntegrityIssues({
    id: row.id,
    fieldId: row.field_id,
    period: row.period,
    generatedAt: row.generated_at,
    plant: row.plant,
    purchaseOrder: row.purchase_order,
    producerCode: row.producer_code,
    producerName: row.producer_name,
    buyerName: row.buyer_name,
    litersFirstHalf: row.liters_first_half,
    litersSecondHalf: row.liters_second_half,
    totalLiters: row.total_liters,
    netAmountClp: row.net_amount_clp,
    taxAmountClp: row.tax_amount_clp,
    grossAmountClp: row.gross_amount_clp,
    netPricePerLiterClp: row.net_price_per_liter_clp,
    grossPricePerLiterClp: row.gross_price_per_liter_clp,
    sourceDocumentName: row.source_document_name,
    notes: row.notes,
    lineItems: row.line_items,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function validateHalfLiters(issues, value, label) {
  if (value === null) return true;
  if (!isFiniteNumber(value) || value < 0) {
    issues.push(`Los litros de la ${label} quincena no pueden ser negativos.`);
    return false;
  }
  return true;
}

function validateLineItems(issues, value, netAmountClp, netAmountValid) {
  if (!Array.isArray(value) || value.length > MILK_SETTLEMENT_LIMITS.lineItems) {
    issues.push("La liquidación admite hasta 200 líneas de detalle.");
    return;
  }
  let amountsValid = true;
  for (const lineItemValue of value) {
    const lineItem = record(lineItemValue);
    if (!lineItem) {
      issues.push("Cada línea de detalle debe ser un objeto válido.");
      amountsValid = false;
      continue;
    }
    if (!hasExactLineItemShape(lineItem)) {
      issues.push("Cada línea debe declarar exactamente descripción, medición, precio unitario y monto.");
      amountsValid = false;
      continue;
    }
    validateText(
      issues,
      lineItem.description,
      MILK_SETTLEMENT_LIMITS.lineItemDescription,
      "Cada línea debe tener una descripción válida.",
    );
    if (
      lineItem.measurement !== null
      && (
        typeof lineItem.measurement !== "string"
        || lineItem.measurement.length > MILK_SETTLEMENT_LIMITS.lineItemMeasurement
      )
    ) {
      issues.push("La medición de una línea no puede superar 200 caracteres.");
    }
    if (lineItem.unitPriceClp !== null && !isFiniteNumber(lineItem.unitPriceClp)) {
      issues.push("El precio unitario de una línea no es válido.");
    }
    if (!Number.isSafeInteger(lineItem.amountClp)) {
      issues.push("El monto de cada línea debe ser un CLP entero seguro.");
      amountsValid = false;
    }
  }
  if (value.length > 0 && amountsValid && netAmountValid) {
    const lineItemsTotal = value.reduce((sum, lineItem) => sum + lineItem.amountClp, 0);
    if (!Number.isSafeInteger(lineItemsTotal) || Math.abs(lineItemsTotal - netAmountClp) > 1) {
      issues.push("La suma de las líneas de detalle debe coincidir con el monto neto.");
    }
  }
}

function hasExactLineItemShape(value) {
  const expected = ["description", "measurement", "unitPriceClp", "amountClp"];
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validateText(issues, value, maximumLength, message, allowEmpty = false) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.trim().length === 0)
    || value.length > maximumLength
  ) issues.push(message);
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function roundPrice(value) {
  return Math.round(value * 10_000) / 10_000;
}

function isValidDate(value) {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:(?:T| )([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{3}))?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)?)?$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthLengths = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= monthLengths[month - 1] && Number.isFinite(Date.parse(value));
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}
