import {
  LIVESTOCK_ANIMAL_STATUS_LABELS,
  LIVESTOCK_SEX_LABELS,
  type LivestockAnimal,
} from "@/src/core/domain/types";

/**
 * Reglas de forma del animal que llega por API.
 *
 * Vive fuera de las rutas porque la ficha y la planilla escriben el mismo registro: si
 * cada una validara por su cuenta, la más nueva terminaría aceptando lo que la otra
 * rechaza, y esa diferencia es exactamente por donde entran los datos malos.
 */
/**
 * Cuántos pesajes admite una sola escritura del animal.
 *
 * Cada pesaje es una sentencia más en el mismo lote, así que el tope acota el tamaño de la
 * transacción. No limita cuántos pesajes puede acumular un animal: limita cuántos se
 * pueden tocar de una vez.
 */
const MAX_WEIGHINGS_PER_WRITE = 40;
const MAX_ANIMAL_WEIGHT_KG = 2_000;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

function isValidAnimalWeight(value: number): boolean {
  return Number.isFinite(value) && value > 0 && value <= MAX_ANIMAL_WEIGHT_KG;
}

export function validateAnimalPayload(payload: Partial<LivestockAnimal>): string | null {
  if (!payload.id?.trim()) return "Falta el identificador interno del animal.";
  if (!payload.lotId?.trim()) return "Selecciona un lote.";
  if (!payload.tag?.trim()) return "Ingresa el DIIO o identificador.";
  if (!/^[A-Za-z0-9.-]+$/.test(payload.tag.trim())) return "El identificador contiene caracteres no válidos.";
  if (!payload.sex || !(payload.sex in LIVESTOCK_SEX_LABELS)) return "El sexo no es válido.";
  if (!payload.status || !(payload.status in LIVESTOCK_ANIMAL_STATUS_LABELS)) return "El estado no es válido.";
  if (payload.status !== "active" && !payload.statusDate) return "Indica la fecha del cambio de estado.";
  if (payload.statusDate && !isValidIsoDate(payload.statusDate)) return "La fecha del estado no es válida.";
  if (payload.birthDate && !isValidIsoDate(payload.birthDate)) return "La fecha de nacimiento no es válida.";
  if (payload.purchaseDate && !isValidIsoDate(payload.purchaseDate)) return "La fecha de compra no es válida.";
  if (payload.purchasePriceClp !== null && payload.purchasePriceClp !== undefined && (!Number.isInteger(payload.purchasePriceClp) || payload.purchasePriceClp < 0)) return "El precio de compra debe ser un monto CLP entero.";
  if (payload.salePriceClp !== null && payload.salePriceClp !== undefined && (!Number.isInteger(payload.salePriceClp) || payload.salePriceClp < 0)) return "El precio de venta debe ser un monto CLP entero.";
  if (payload.saleWeightKg !== null && payload.saleWeightKg !== undefined && !isValidAnimalWeight(payload.saleWeightKg)) return "El peso de venta debe ser mayor que cero y no superar 2.000 kg.";
  if (payload.status === "sold" && (!payload.salePriceClp || !payload.saleBuyer?.trim() || !payload.saleWeightKg)) return "Para cerrar la venta registra precio, comprador y peso final.";
  if (payload.latestWeightKg !== null && payload.latestWeightKg !== undefined && !isValidAnimalWeight(payload.latestWeightKg)) return "El peso debe ser mayor que cero y no superar 2.000 kg.";
  if (payload.latestWeightKg !== null && payload.latestWeightKg !== undefined && !payload.latestWeightDate) return "Indica la fecha del pesaje.";
  if (payload.latestWeightDate && !isValidIsoDate(payload.latestWeightDate)) return "La fecha del pesaje no es válida.";
  if (payload.weighings !== undefined) {
    if (!Array.isArray(payload.weighings)) return "Los pesajes del animal no vienen en una lista.";
    if (payload.weighings.length > MAX_WEIGHINGS_PER_WRITE) {
      return `No se pueden guardar más de ${MAX_WEIGHINGS_PER_WRITE} pesajes de un animal a la vez.`;
    }
    const dates = new Set<string>();
    for (const weighing of payload.weighings) {
      if (!weighing || typeof weighing !== "object") return "Un pesaje del animal no tiene forma de pesaje.";
      if (!weighing.recordedAt || !isValidIsoDate(weighing.recordedAt)) return "La fecha de un pesaje no es válida.";
      // Dos veces el mismo día son dos escrituras peleando por la misma fila: la que
      // quedara sería la última en llegar, y eso no es una decisión, es un azar.
      if (dates.has(weighing.recordedAt)) return `El pesaje del ${weighing.recordedAt} viene repetido.`;
      dates.add(weighing.recordedAt);
      if (weighing.weightKg === null) continue;
      if (!isValidAnimalWeight(weighing.weightKg)) return "El peso de un pesaje debe ser mayor que cero y no superar 2.000 kg.";
    }
  }
  return null;
}
