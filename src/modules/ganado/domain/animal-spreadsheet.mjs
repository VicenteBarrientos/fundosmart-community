/**
 * Lógica pura de la planilla de animales: interpretar lo que alguien escribe o pega, y
 * convertirlo en el conjunto exacto de escrituras que haría la confirmación.
 *
 * No toca el DOM ni React a propósito. Acá viven las decisiones que se equivocan
 * calladas — separador decimal chileno, orden de las fechas, y qué texto corresponde a
 * qué opción — y son justamente las que hay que poder probar sin navegador.
 *
 * La planilla guarda **texto**, no valores. Una celda conserva lo que se tipeó aunque no
 * se pueda interpretar, igual que en Excel: el error se muestra al lado, nunca se
 * revierte lo escrito.
 */

import {
  formatSpreadsheetDate,
  formatSpreadsheetNumber,
  matchSpreadsheetOption,
  normalizeLookupText,
  parseSpreadsheetDate,
  parseSpreadsheetNumber,
} from "./spreadsheet-values.mjs";

/**
 * Las columnas fijas de la planilla. El resto de la ficha se sigue editando en su diálogo.
 *
 * El peso no está acá: un animal no tiene *un* peso sino una historia, y cada pesaje es
 * una columna con su fecha por encabezado. Las arma `animalSpreadsheetColumns` a partir
 * de las fechas que el contexto declara.
 */
export const ANIMAL_SPREADSHEET_COLUMNS = Object.freeze([
  Object.freeze({ key: "tag", label: "DIIO", kind: "text", width: "9rem" }),
  Object.freeze({ key: "lotId", label: "Lote", kind: "lot", width: "12rem" }),
  Object.freeze({ key: "sex", label: "Sexo", kind: "sex", width: "8rem" }),
  Object.freeze({ key: "status", label: "Estado", kind: "status", width: "8rem" }),
  Object.freeze({ key: "statusDate", label: "Fecha estado", kind: "date", width: "8.5rem" }),
  Object.freeze({ key: "statusReason", label: "Motivo", kind: "text", width: "11rem" }),
  Object.freeze({ key: "birthDate", label: "Nacimiento", kind: "date", width: "8.5rem" }),
  Object.freeze({ key: "purchasePriceClp", label: "Precio compra", kind: "clp", align: "right", width: "9.5rem" }),
  Object.freeze({ key: "purchaseDate", label: "Fecha compra", kind: "date", width: "8.5rem" }),
  Object.freeze({ key: "origin", label: "Origen", kind: "text", width: "11rem" }),
  Object.freeze({ key: "notes", label: "Notas", kind: "text", width: "13rem" }),
]);

const COLUMN_BY_KEY = new Map(ANIMAL_SPREADSHEET_COLUMNS.map((column) => [column.key, column]));

/** Las columnas de pesaje se reconocen por su clave, y la clave lleva la fecha adentro. */
const WEIGHING_COLUMN_PREFIX = "pesaje:";
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** La columna de pesaje va después de Nacimiento: primero quién es el animal, después cuánto pesa. */
const WEIGHING_COLUMN_ANCHOR = "birthDate";

const TAG_PATTERN = /^[A-Za-z0-9.-]+$/;

/** La clave de columna del pesaje de un día. */
export function weighingColumnKey(recordedAt) {
  return `${WEIGHING_COLUMN_PREFIX}${recordedAt}`;
}

/** La fecha que una clave de columna representa, o `null` si no es una columna de pesaje. */
export function weighingColumnDate(columnKey) {
  if (typeof columnKey !== "string" || !columnKey.startsWith(WEIGHING_COLUMN_PREFIX)) return null;
  const recordedAt = columnKey.slice(WEIGHING_COLUMN_PREFIX.length);
  return ISO_DATE_PATTERN.test(recordedAt) ? recordedAt : null;
}

/** Días de pesaje que siguen escritos en un borrador, aunque ya no estén en la historia. */
export function weighingDatesFromEdits(edits) {
  const dates = new Set();
  for (const cells of Object.values(edits ?? {})) {
    if (!cells || typeof cells !== "object") continue;
    for (const key of Object.keys(cells)) {
      const date = weighingColumnDate(key);
      if (date) dates.add(date);
    }
  }
  return [...dates].sort((a, b) => b.localeCompare(a));
}

/**
 * Las fechas que merecen columna, de la más reciente a la más antigua.
 *
 * El orden lo decide esta función y no quien llama: dos pantallas que ordenaran distinto
 * pegarían la misma columna de Excel en fechas distintas.
 */
function normalizeWeighingDates(dates) {
  const unique = new Set();
  for (const date of dates ?? []) {
    if (typeof date === "string" && ISO_DATE_PATTERN.test(date)) unique.add(date);
  }
  return [...unique].sort((a, b) => b.localeCompare(a));
}

function weighingColumn(recordedAt) {
  return Object.freeze({
    key: weighingColumnKey(recordedAt),
    label: formatSpreadsheetDate(recordedAt),
    kind: "weighing",
    align: "right",
    recordedAt,
    width: "8.5rem",
  });
}

/** Las columnas de la planilla: las fijas más una por cada fecha de pesaje del contexto. */
export function animalSpreadsheetColumns(context) {
  const dates = normalizeWeighingDates(context?.weighingDates);
  if (dates.length === 0) return ANIMAL_SPREADSHEET_COLUMNS;
  const anchor = ANIMAL_SPREADSHEET_COLUMNS.findIndex((column) => column.key === WEIGHING_COLUMN_ANCHOR) + 1;
  return Object.freeze([
    ...ANIMAL_SPREADSHEET_COLUMNS.slice(0, anchor),
    ...dates.map(weighingColumn),
    ...ANIMAL_SPREADSHEET_COLUMNS.slice(anchor),
  ]);
}

function columnForKey(columnKey) {
  const recordedAt = weighingColumnDate(columnKey);
  if (recordedAt) return weighingColumn(recordedAt);
  return COLUMN_BY_KEY.get(columnKey);
}

/**
 * La historia de pesajes del animal como `{ fecha: kilos }`.
 *
 * Si el contexto no la trae —una pantalla que solo edita el resto de la ficha— se cae al
 * último peso del animal, que es lo único que ese caller conoce. Así la planilla nunca
 * concluye que un animal no tiene pesajes solo porque quien la abrió no los pasó.
 */
function weighingHistory(animal, context) {
  const known = context?.weighingsByAnimal?.[animal.id];
  if (known) return known;
  if (animal.latestWeightKg !== null && animal.latestWeightKg !== undefined && animal.latestWeightDate) {
    return { [animal.latestWeightDate]: animal.latestWeightKg };
  }
  return {};
}

/** El peso vigente después de aplicar lo que la planilla escribió: el del día más reciente. */
function resolveLatestWeighing(history, writes) {
  const merged = { ...history };
  for (const [recordedAt, weightKg] of Object.entries(writes)) {
    if (weightKg === null) delete merged[recordedAt];
    else merged[recordedAt] = weightKg;
  }
  let latestDate = null;
  for (const recordedAt of Object.keys(merged)) {
    if (latestDate === null || recordedAt > latestDate) latestDate = recordedAt;
  }
  return latestDate === null
    ? { latestWeightKg: null, latestWeightDate: null }
    : { latestWeightKg: merged[latestDate], latestWeightDate: latestDate };
}

// Los lectores de valores viven en `spreadsheet-values.mjs`: los comparten esta planilla,
// la de pesajes y la de egresos, y una segunda copia terminaría interpretando "1.234"
// distinto que la primera. Se reexportan para que quien ya los importaba de acá siga igual.
export {
  formatSpreadsheetDate,
  formatSpreadsheetNumber,
  normalizeLookupText,
  parseSpreadsheetDate,
  parseSpreadsheetNumber,
} from "./spreadsheet-values.mjs";

function optionsForColumn(column, context) {
  if (column.kind === "sex") {
    return Object.entries(context.sexLabels ?? {}).map(([value, label]) => ({ value, label }));
  }
  if (column.kind === "status") {
    return Object.entries(context.statusLabels ?? {}).map(([value, label]) => ({ value, label }));
  }
  if (column.kind === "lot") {
    return (context.lots ?? [])
      .filter((lot) => lot.trackingMode === "individual")
      .map((lot) => ({ value: lot.id, label: lot.name }));
  }
  return [];
}

/** Opciones que la grilla ofrece al editar una celda de lista. */
export function spreadsheetColumnOptions(columnKey, context) {
  const column = COLUMN_BY_KEY.get(columnKey);
  return column ? optionsForColumn(column, context) : [];
}

/** El texto con el que nace la celda: lo que se ve, y lo que al re-interpretarse da lo mismo. */
export function formatAnimalCell(columnKey, animal, context) {
  const column = columnForKey(columnKey);
  if (!column) return "";
  if (column.kind === "weighing") {
    return formatSpreadsheetNumber(weighingHistory(animal, context)[column.recordedAt] ?? null, 1);
  }
  const value = animal[columnKey];

  if (column.kind === "date") return formatSpreadsheetDate(value);
  if (column.kind === "weight") return formatSpreadsheetNumber(value, 1);
  if (column.kind === "clp") return formatSpreadsheetNumber(value, 0);
  if (column.kind === "sex" || column.kind === "status" || column.kind === "lot") {
    const option = optionsForColumn(column, context).find((entry) => entry.value === value);
    return option?.label ?? "";
  }
  return value === null || value === undefined ? "" : String(value);
}

/** Interpreta el texto de una celda como el valor que iría en el animal. */
export function parseAnimalCell(columnKey, text, context) {
  const column = columnForKey(columnKey);
  if (!column) return { value: null, error: "Columna desconocida." };
  const raw = String(text ?? "").trim();

  if (column.kind === "date") return parseSpreadsheetDate(raw);

  if (column.kind === "weight" || column.kind === "weighing") {
    const parsed = parseSpreadsheetNumber(raw);
    if (parsed.error) return parsed;
    if (parsed.value !== null && parsed.value <= 0) return { value: null, error: "El peso debe ser mayor que cero." };
    if (parsed.value !== null && parsed.value > 2000) return { value: null, error: "Un peso sobre 2.000 kg parece un error de tipeo." };
    return { value: parsed.value === null ? null : Math.round(parsed.value * 10) / 10, error: null };
  }

  if (column.kind === "clp") {
    const parsed = parseSpreadsheetNumber(raw);
    if (parsed.error) return parsed;
    if (parsed.value === null) return { value: null, error: null };
    if (parsed.value < 0) return { value: null, error: "El monto no puede ser negativo." };
    if (!Number.isInteger(parsed.value)) return { value: null, error: "El dinero se registra en pesos enteros." };
    return { value: parsed.value, error: null };
  }

  if (column.kind === "sex" || column.kind === "status" || column.kind === "lot") {
    const options = optionsForColumn(column, context);
    if (raw === "") {
      if (column.kind === "lot") return { value: null, error: "Indica el lote." };
      return { value: null, error: `Indica ${column.kind === "sex" ? "el sexo" : "el estado"}.` };
    }
    const option = matchSpreadsheetOption(options, raw);
    if (!option) {
      const known = options.map((entry) => entry.label).join(", ");
      return {
        value: null,
        error: column.kind === "lot"
          ? `No hay un lote con trazabilidad individual llamado "${raw}".`
          : `Valor no reconocido. Opciones: ${known}.`,
      };
    }
    return { value: option.value, error: null };
  }

  if (columnKey === "tag") {
    if (raw === "") return { value: null, error: "El DIIO no puede quedar vacío." };
    if (!TAG_PATTERN.test(raw)) return { value: null, error: "El DIIO solo admite letras, números, punto y guion." };
    return { value: raw, error: null };
  }

  return { value: raw, error: null };
}

/**
 * Un animal que todavía no existe: la fila en blanco que agrega la planilla.
 *
 * Nace sin `snapshotToken` a propósito, y esa ausencia es la que distingue una fila nueva
 * de una guardada en todo el resto del módulo. Un animal leído del repositorio siempre
 * trae token; uno que nunca se escribió no puede traerlo.
 */
export function createAnimalDraftRow(id, lotId = "") {
  return {
    id,
    lotId,
    tag: "",
    sex: "unknown",
    status: "active",
    statusDate: null,
    statusReason: null,
    birthDate: null,
    purchasePriceClp: null,
    purchaseDate: null,
    salePriceClp: null,
    saleBuyer: null,
    saleWeightKg: null,
    origin: null,
    notes: "",
    source: "Planilla",
    latestWeightKg: null,
    latestWeightDate: null,
    createdAt: "",
  };
}

/** Una fila que la planilla agregó y el repositorio todavía no conoce. */
export function isDraftAnimalRow(animal) {
  return !animal?.snapshotToken;
}

/** Las celdas de un animal tal como nacen en la planilla, antes de cualquier edición. */
export function buildAnimalSpreadsheetRow(animal, context) {
  const cells = {};
  for (const column of animalSpreadsheetColumns(context)) {
    cells[column.key] = formatAnimalCell(column.key, animal, context);
  }
  return { id: animal.id, label: animal.tag, cells };
}

/**
 * Una fila nueva sin nada escrito es un renglón de sobra, no un animal a medio llenar.
 *
 * El lote no cuenta como contenido: viene puesto por el filtro que estaba activo al
 * agregar la fila, y nadie lo tipeó. Si contara, agregar diez filas produciría diez
 * errores al instante.
 */
function isEmptyDraftRow(next, weighingWrites) {
  return !next.tag
    && next.sex === "unknown"
    && next.status === "active"
    && next.statusDate === null
    && next.birthDate === null
    && Object.keys(weighingWrites).length === 0
    && next.purchasePriceClp === null
    && next.purchaseDate === null
    && !next.origin
    && !next.notes
    && !next.statusReason;
}

function rowLevelErrors(animal, next, weighingWrites, context) {
  const errors = [];
  const label = (key) => COLUMN_BY_KEY.get(key)?.label ?? key;

  // Un animal nuevo se juzga completo, no por lo que se tocó: nace de cero y el
  // repositorio va a exigir estos campos igual.
  if (isDraftAnimalRow(animal)) {
    if (!next.tag) errors.push({ key: "tag", label: label("tag"), message: "Un animal nuevo necesita su DIIO." });
    if (!next.lotId) errors.push({ key: "lotId", label: label("lotId"), message: "Un animal nuevo necesita el lote donde entra." });
  }

  if (next.status !== "active" && !next.statusDate) {
    errors.push({ key: "statusDate", label: label("statusDate"), message: `Un animal ${normalizeLookupText(context.statusLabels?.[next.status] ?? next.status)} necesita la fecha del cambio.` });
  }
  if (next.status === "sold" && (!next.salePriceClp || !next.saleBuyer || !next.saleWeightKg)) {
    errors.push({ key: "status", label: label("status"), message: "Cerrar una venta necesita precio, comprador y peso final: hazlo en la ficha del animal." });
  }
  if (
    animal.status !== next.status
    && (animal.status === "sold" || next.status === "sold")
  ) {
    errors.push({
      key: "status",
      label: label("status"),
      message: "Las ventas se cierran o reabren desde la ficha del animal.",
    });
  }
  if (animal.status === "sold" && animal.statusDate !== next.statusDate) {
    errors.push({
      key: "statusDate",
      label: label("statusDate"),
      message: "La fecha de una venta se corrige desde la ficha del animal.",
    });
  }
  const protectedSaleDate = [
    animal.status === "sold" ? animal.statusDate : null,
    next.status === "sold" ? next.statusDate : null,
  ].find((date) => date && Object.hasOwn(weighingWrites, date));
  if (protectedSaleDate) {
    const key = weighingColumnKey(protectedSaleDate);
    errors.push({
      key,
      label: label(key),
      message: "El peso final de venta se corrige desde la ficha del animal.",
    });
  }
  return errors;
}

/**
 * Advertencias: lo que se va a escribir tal cual se pidió, pero cuyo efecto no es el que
 * la celda sugiere. No bloquean la confirmación; se muestran antes de confirmarla.
 */
function rowLevelWarnings(animal, next, weighingWrites) {
  const warnings = [];

  // Un pesaje anterior al último no cambia el peso vigente: queda guardado en su día y el
  // animal sigue mostrando el del día más reciente. Se avisa por columna, porque en una
  // planilla con varias fechas la que se tipeó no tiene por qué ser la más nueva.
  for (const [recordedAt, weightKg] of Object.entries(weighingWrites)) {
    if (weightKg === null) continue;
    if (!animal.latestWeightDate || recordedAt >= animal.latestWeightDate) continue;
    warnings.push({
      key: weighingColumnKey(recordedAt),
      message: `El pesaje queda registrado el ${formatSpreadsheetDate(recordedAt)}, pero el peso vigente seguirá siendo el del ${formatSpreadsheetDate(animal.latestWeightDate)} por ser más reciente.`,
    });
  }

  for (const [recordedAt, weightKg] of Object.entries(weighingWrites)) {
    if (weightKg !== null) continue;
    warnings.push({
      key: weighingColumnKey(recordedAt),
      message: `Vaciar la celda borra el pesaje del ${formatSpreadsheetDate(recordedAt)}. La ganancia diaria se recalcula contra el pesaje que quede antes.`,
    });
  }

  if (next.tag !== animal.tag) {
    warnings.push({
      key: "tag",
      message: `Cambiar el DIIO ${animal.tag} por ${next.tag} solo se acepta si el animal no tiene historia de números. Si la tiene, hay que hacerlo desde su ficha para conservar el anterior con su fecha.`,
    });
  }

  if (next.lotId !== animal.lotId) {
    warnings.push({
      key: "lotId",
      message: "Mover el animal de lote recalcula el promedio de los dos lotes.",
    });
  }

  return warnings;
}

/**
 * Convierte la planilla editada en el plan exacto de lo que va a cambiar.
 *
 * Separa a propósito lo que se puede escribir de lo que está mal escrito, igual que el
 * plan de importación: nada se confirma mientras haya una celda que el sistema no
 * entiende, y cada error apunta a su celda.
 */
export function planAnimalSpreadsheet({ animals, edits, context }) {
  const changes = [];
  const errors = [];
  const warnings = [];
  const editedByAnimal = edits ?? {};
  let changedCellCount = 0;
  let createdRowCount = 0;

  const fieldByLot = new Map((context.lots ?? []).map((lot) => [lot.id, lot.fieldId ?? null]));
  // El DIIO es único por fundo. Se compara contra todo el rebaño, no contra lo que los
  // filtros dejaron a la vista, porque el repositorio no sabe de filtros.
  const takenTags = new Map();
  for (const known of context.knownAnimals ?? []) {
    takenTags.set(`${fieldByLot.get(known.lotId) ?? ""}|${normalizeLookupText(known.tag)}`, known.id);
  }

  const columns = animalSpreadsheetColumns(context);

  for (const animal of animals) {
    const edited = editedByAnimal[animal.id];
    const isDraft = isDraftAnimalRow(animal);
    if (!edited && !isDraft) continue;

    const next = { ...animal };
    const fields = [];
    /** Solo los días que la planilla tocó: `null` borra ese pesaje, un número lo escribe. */
    const weighingWrites = {};
    let rowHasCellError = false;

    for (const column of columns) {
      if (!edited || !(column.key in edited)) continue;
      const text = edited[column.key];
      const before = formatAnimalCell(column.key, animal, context);
      if (text === before) continue;

      const parsed = parseAnimalCell(column.key, text, context);
      if (parsed.error) {
        errors.push({
          animalId: animal.id,
          tag: animal.tag,
          key: column.key,
          label: column.label,
          text,
          message: parsed.error,
        });
        rowHasCellError = true;
        continue;
      }
      if (column.kind === "weighing") {
        weighingWrites[column.recordedAt] = parsed.value;
        fields.push({
          key: column.key,
          label: `Pesaje ${column.label}`,
          before,
          after: parsed.value === null ? "" : formatSpreadsheetNumber(parsed.value, 1),
        });
        changedCellCount += 1;
        continue;
      }
      next[column.key] = parsed.value;
      fields.push({ key: column.key, label: column.label, before, after: formatAnimalCell(column.key, next, context) });
      changedCellCount += 1;
    }

    // El peso vigente no se tipea: sale del día más reciente que quede después de escribir.
    // Lo recalculamos acá para que el resto de la app —promedio del lote, GDV, tablero—
    // vea lo mismo que verá cuando el repositorio devuelva el animal guardado.
    Object.assign(next, resolveLatestWeighing(weighingHistory(animal, context), weighingWrites));

    // Una fila agregada y nunca llenada es un renglón de sobra: no bloquea ni se guarda.
    if (isDraft && isEmptyDraftRow(next, weighingWrites)) continue;
    if (!isDraft && fields.length === 0 && !rowHasCellError) continue;

    for (const error of rowLevelErrors(animal, next, weighingWrites, context)) {
      errors.push({ animalId: animal.id, tag: animal.tag, text: null, ...error });
      rowHasCellError = true;
    }

    if (next.tag) {
      const tagKey = `${fieldByLot.get(next.lotId) ?? ""}|${normalizeLookupText(next.tag)}`;
      const owner = takenTags.get(tagKey);
      if (owner && owner !== animal.id) {
        errors.push({
          animalId: animal.id,
          tag: animal.tag || next.tag,
          key: "tag",
          label: COLUMN_BY_KEY.get("tag").label,
          text: next.tag,
          message: "Ya hay un animal con ese DIIO en el fundo.",
        });
        rowHasCellError = true;
      } else {
        takenTags.set(tagKey, animal.id);
      }
    }

    if (rowHasCellError) continue;
    if (!isDraft && fields.length === 0) continue;

    for (const warning of isDraft ? [] : rowLevelWarnings(animal, next, weighingWrites)) {
      warnings.push({ animalId: animal.id, tag: animal.tag, ...warning });
    }
    if (isDraft) createdRowCount += 1;
    // Los pesajes viajan como lista aparte y no como el peso vigente: el repositorio
    // necesita saber qué días tocar, y "el último" no alcanza para describir tres.
    changes.push({
      animalId: animal.id,
      created: isDraft,
      tag: next.tag || animal.tag,
      fields,
      animal: {
        ...next,
        weighings: Object.entries(weighingWrites)
          .map(([recordedAt, weightKg]) => ({ recordedAt, weightKg }))
          .sort((a, b) => a.recordedAt.localeCompare(b.recordedAt)),
      },
    });
  }

  return {
    changes,
    errors,
    warnings,
    changedRowCount: changes.length,
    changedCellCount,
    createdRowCount,
    blocked: errors.length > 0,
  };
}

/**
 * Deja en el borrador solo lo que sigue sin guardarse.
 *
 * Después de una confirmación parcial —la que se detiene porque una fila chocó— esto es
 * lo que permite reintentar sin volver a tipear nada.
 */
export function pruneSpreadsheetDraft(edits, savedAnimalIds) {
  const saved = new Set(savedAnimalIds ?? []);
  const remaining = {};
  for (const [animalId, cells] of Object.entries(edits ?? {})) {
    if (saved.has(animalId)) continue;
    remaining[animalId] = cells;
  }
  return remaining;
}

/** Quita del borrador las celdas cuyo texto volvió a coincidir con lo guardado. */
export function compactSpreadsheetDraft(edits, animals, context) {
  const animalById = new Map(animals.map((animal) => [animal.id, animal]));
  const compacted = {};
  for (const [animalId, cells] of Object.entries(edits ?? {})) {
    const animal = animalById.get(animalId);
    if (!animal) continue;
    const kept = {};
    for (const [key, text] of Object.entries(cells)) {
      if (text === formatAnimalCell(key, animal, context)) continue;
      kept[key] = text;
    }
    if (Object.keys(kept).length > 0) compacted[animalId] = kept;
  }
  return compacted;
}
