export const LIVESTOCK_INVENTORY_PLAN_VERSION = "fundosmart.import.livestock_inventory.plan.v1";

/**
 * Exit vocabulary mapped onto the canonical animal statuses.
 *
 * There is no "stolen" status, so rustling becomes `departed` and keeps its reason in
 * `statusReason`. Recording it as `sold` would invent a sale and a buyer.
 */
const EXIT_STATUS = Object.freeze({
  died: Object.freeze({ status: "dead", reason: "Muerta según inventario" }),
  sold_market: Object.freeze({ status: "sold", reason: "Vendida en feria según inventario" }),
  rustled: Object.freeze({ status: "departed", reason: "Abigeato según inventario" }),
});

/**
 * Turns parsed inventory rows into the exact canonical writes a confirmation would
 * perform, without performing any of them.
 *
 * The plan separates three very different things on purpose:
 *
 * - **writes**, which the source states unambiguously;
 * - **pending decisions**, which the source implies but cannot date or attribute — the
 *   palpation date lives in a column header, an exit states a year, and a single
 *   offspring cell cannot be paired with one of four calvings;
 * - **conflicts**, which contradict what is already stored and must never be
 *   overwritten silently.
 *
 * Every planned write carries a deterministic `dedupeKey`, so planning the same file
 * twice yields the same plan and a confirmation can be replayed safely.
 */
export function planLivestockInventoryImport(parsed, context = {}) {
  const fieldId = requireText(context.fieldId, "fieldId");
  const existingAnimals = normalizeAnimalIndex(context.existingAnimalsByTag);
  const existingLots = normalizeLotIndex(context.existingLotsByName);
  const palpationDate = optionalIsoDate(context.palpationDate, "palpationDate");

  const plan = {
    planVersion: LIVESTOCK_INVENTORY_PLAN_VERSION,
    fieldId,
    animalsToCreate: [],
    animalsToUpdate: [],
    lotsToCreate: [],
    lotMemberships: [],
    reproductiveEvents: [],
    births: [],
    statusChanges: [],
    pending: [],
    conflicts: [],
  };

  const lotsSeen = new Map();
  plan.rowsSeen = (parsed?.rows ?? []).length;
  const outcomeByRecord = new Map();

  for (const row of parsed?.rows ?? []) {
    // A row the reader could not resolve is evidence of a problem, not input.
    if (row.status === "error") {
      plan.conflicts.push({
        rowNumber: row.rowNumber,
        recordNumber: row.recordNumber,
        code: "ROW_REJECTED_BY_READER",
        message: "La fila no se puede planificar mientras tenga errores de lectura.",
        issues: row.issues.filter((issue) => issue.severity === "error").map((issue) => issue.ruleCode),
      });
      outcomeByRecord.set(row.recordNumber, "rejected");
      continue;
    }
    outcomeByRecord.set(row.recordNumber, "unchanged");

    const record = row.normalizedRecord;
    const tag = record.animalExternalId;
    if (!tag) continue;

    const existing = existingAnimals.get(tag) ?? null;
    const anchor = { rowNumber: row.rowNumber, recordNumber: row.recordNumber, tag };

    if (!existing) {
      plan.animalsToCreate.push({
        ...anchor,
        dedupeKey: `animal:${fieldId}:${tag}`,
        tag,
        birthDate: record.birthDate,
        status: record.exit ? EXIT_STATUS[record.exit.kind].status : "active",
      });
      outcomeByRecord.set(row.recordNumber, "inserted");
    } else {
      // A stored birth date that disagrees with the sheet is a conflict, never an
      // update: the sheet is a migration source, not the system of record.
      if (record.birthDate && existing.birthDate && record.birthDate !== existing.birthDate) {
        plan.conflicts.push({
          ...anchor,
          code: "BIRTH_DATE_MISMATCH",
          message: `El animal ya registra nacimiento ${existing.birthDate} y la planilla dice ${record.birthDate}.`,
          storedValue: existing.birthDate,
          incomingValue: record.birthDate,
        });
        outcomeByRecord.set(row.recordNumber, "conflict");
      } else if (record.birthDate && !existing.birthDate) {
        plan.animalsToUpdate.push({
          ...anchor,
          animalId: existing.id,
          dedupeKey: `animal-birth:${existing.id}`,
          birthDate: record.birthDate,
        });
        outcomeByRecord.set(row.recordNumber, "updated");
      }
    }

    if (record.lotName) {
      const lotKey = normalizeKey(record.lotName);
      const knownLot = existingLots.get(lotKey) ?? null;
      if (!knownLot && !lotsSeen.has(lotKey)) {
        lotsSeen.set(lotKey, record.lotName);
        plan.lotsToCreate.push({
          dedupeKey: `lot:${fieldId}:${lotKey}`,
          name: record.lotName,
        });
      }
      plan.lotMemberships.push({
        ...anchor,
        dedupeKey: `membership:${fieldId}:${tag}:${lotKey}`,
        lotName: record.lotName,
        lotId: knownLot?.id ?? null,
      });
    }

    if (record.exit) {
      const mapped = EXIT_STATUS[record.exit.kind];
      plan.statusChanges.push({
        ...anchor,
        dedupeKey: `status:${fieldId}:${tag}:${record.exit.kind}`,
        status: mapped.status,
        // The source gives a year at best, so the date stays unknown rather than
        // becoming an invented 1 January.
        statusDate: null,
        statusReason: mapped.reason,
        exitYear: record.exit.year,
        sourceText: record.exit.rawText,
      });
      if (record.exit.kind === "rustled") {
        plan.pending.push({
          ...anchor,
          code: "EXIT_KIND_HAS_NO_CANONICAL_STATUS",
          message: "El abigeato se registra como «Retirado» con su motivo; confirma que esa clasificación es aceptable.",
        });
      }
      plan.pending.push({
        ...anchor,
        code: "EXIT_DATE_REQUIRED",
        message: record.exit.year
          ? `La planilla sólo indica el año ${record.exit.year}; falta la fecha exacta de la salida.`
          : "La planilla no indica cuándo ocurrió la salida.",
      });
    }

    for (const date of record.calvingDates) {
      plan.reproductiveEvents.push(reproductiveEvent(fieldId, tag, "calving", date, anchor));
    }
    if (record.dryOffDate) {
      plan.reproductiveEvents.push(reproductiveEvent(fieldId, tag, "dry_off", record.dryOffDate, anchor));
    }
    for (const date of [record.heatDate, record.winterHeatDate]) {
      if (date) plan.reproductiveEvents.push(reproductiveEvent(fieldId, tag, "heat", date, anchor));
    }

    if (record.pregnancyStatus) {
      if (palpationDate) {
        plan.reproductiveEvents.push({
          ...reproductiveEvent(fieldId, tag, "pregnancy_diagnosis", palpationDate, anchor),
          result: record.pregnancyStatus,
        });
      } else {
        // "palpacion 18/10" dates the session in the column header, without a year.
        plan.pending.push({
          ...anchor,
          code: "PALPATION_DATE_REQUIRED",
          message: "El resultado de palpación no tiene fecha propia: la columna la declara en su título. Confirma la fecha de la sesión.",
          value: record.pregnancyStatus,
        });
      }
    }

    if (record.offspring) {
      if (record.calvingDates.length === 1) {
        plan.births.push({
          ...anchor,
          dedupeKey: `birth:${fieldId}:${tag}:${record.calvingDates[0]}`,
          occurredAt: record.calvingDates[0],
          calfSex: record.offspring.sex,
          calfExternalId: record.offspring.externalId,
        });
      } else {
        plan.pending.push({
          ...anchor,
          code: "OFFSPRING_CALVING_PAIRING",
          message: record.calvingDates.length === 0
            ? "Hay cría registrada pero ninguna fecha de parición con la que asociarla."
            : `Hay una sola cría y ${record.calvingDates.length} fechas de parición: falta indicar a cuál corresponde.`,
          value: record.offspring.externalId ?? record.offspring.sex,
        });
      }
    }

    // An existing animal that gains events, a membership or an exit is an update, not
    // an untouched row: the receipt has to account for what actually changed.
    if (outcomeByRecord.get(row.recordNumber) === "unchanged" && rowProducesWrites(plan, row.recordNumber)) {
      outcomeByRecord.set(row.recordNumber, "updated");
    }
  }

  plan.rowOutcomes = [...outcomeByRecord.entries()]
    .map(([recordNumber, outcome]) => ({ recordNumber, outcome }))
    .sort((left, right) => left.recordNumber - right.recordNumber);
  plan.summary = summarize(plan);
  return plan;
}

function rowProducesWrites(plan, recordNumber) {
  const touches = (list) => list.some((entry) => entry.recordNumber === recordNumber);
  return touches(plan.reproductiveEvents)
    || touches(plan.lotMemberships)
    || touches(plan.statusChanges)
    || touches(plan.births);
}

/**
 * Counts a plan the way the confirmation receipt requires, one outcome per row.
 *
 * A row can create an animal and add four events at once; the receipt speaks in rows,
 * so the strongest outcome wins and the total always closes.
 */
export function buildLivestockInventoryReceiptOutcomes(plan) {
  const rowOutcomes = plan?.rowOutcomes ?? [];
  const counts = { inserted: 0, updated: 0, unchanged: 0, conflict: 0, rejected: 0 };
  for (const entry of rowOutcomes) counts[entry.outcome] += 1;

  const rowCount = plan?.rowsSeen ?? rowOutcomes.length;
  const accounted = counts.inserted + counts.updated + counts.unchanged + counts.conflict + counts.rejected;
  if (accounted !== rowCount) {
    throw new RangeError(
      `El recibo no cuadra: ${accounted} filas clasificadas frente a ${rowCount} leídas.`,
    );
  }

  return {
    rowCount,
    insertedRowCount: counts.inserted,
    updatedRowCount: counts.updated,
    unchangedRowCount: counts.unchanged,
    conflictRowCount: counts.conflict,
    rejectedRowCount: counts.rejected,
    importedRowCount: counts.inserted + counts.updated,
    skippedRowCount: counts.unchanged,
    rowOutcomes,
    status: counts.conflict > 0 || counts.rejected > 0 ? "completed_with_errors" : "completed",
  };
}

/**
 * Pending decisions the person may knowingly waive, and what is lost by waiving each.
 *
 * Waiving is allowed but never silent: a plan confirmed with `PALPATION_DATE_REQUIRED`
 * accepted imports everything except the pregnancy results, and the report says so.
 */
const WAIVABLE_PENDING = Object.freeze({
  EXIT_DATE_REQUIRED: "La salida se importa sin fecha exacta; queda el año cuando la planilla lo indica.",
  EXIT_KIND_HAS_NO_CANONICAL_STATUS: "El abigeato queda registrado como «Retirado» con su motivo.",
  PALPATION_DATE_REQUIRED: "No se importa ningún resultado de palpación.",
  OFFSPRING_CALVING_PAIRING: "No se importa el nacimiento de esas crías.",
});

export function evaluateLivestockInventoryPlanReadiness(plan, options = {}) {
  const accepted = new Set(options.acceptedPendingCodes ?? []);
  const byCode = new Map();
  for (const entry of plan?.pending ?? []) {
    byCode.set(entry.code, (byCode.get(entry.code) ?? 0) + 1);
  }

  const blocking = [];
  const waived = [];
  for (const [code, count] of byCode) {
    const target = accepted.has(code) ? waived : blocking;
    target.push({
      code,
      count,
      waivable: Object.hasOwn(WAIVABLE_PENDING, code),
      dataDropped: WAIVABLE_PENDING[code] ?? null,
    });
  }
  blocking.sort((left, right) => right.count - left.count);

  const unknownAcceptances = [...accepted].filter((code) => !Object.hasOwn(WAIVABLE_PENDING, code));
  const conflictCount = plan?.conflicts?.length ?? 0;

  // Conflicts are never waivable: each one contradicts stored data or a rejected row.
  const confirmable = conflictCount === 0 && blocking.length === 0 && unknownAcceptances.length === 0;
  return {
    confirmable,
    conflictCount,
    blocking,
    waived,
    unknownAcceptances,
    reason: confirmable
      ? null
      : conflictCount > 0
        ? "Hay conflictos que deben resolverse antes de confirmar."
        : unknownAcceptances.length > 0
          ? `No se reconocen estas aceptaciones: ${unknownAcceptances.join(", ")}.`
          : "Quedan decisiones pendientes sin resolver ni aceptar.",
  };
}

function reproductiveEvent(fieldId, tag, eventType, occurredAt, anchor) {
  return {
    ...anchor,
    dedupeKey: `event:${fieldId}:${tag}:${eventType}:${occurredAt}`,
    eventType,
    occurredAt,
    result: null,
  };
}

function summarize(plan) {
  const eventsByType = {};
  for (const event of plan.reproductiveEvents) {
    eventsByType[event.eventType] = (eventsByType[event.eventType] ?? 0) + 1;
  }
  return {
    animalsToCreate: plan.animalsToCreate.length,
    animalsToUpdate: plan.animalsToUpdate.length,
    lotsToCreate: plan.lotsToCreate.length,
    lotMemberships: plan.lotMemberships.length,
    reproductiveEvents: plan.reproductiveEvents.length,
    eventsByType,
    births: plan.births.length,
    statusChanges: plan.statusChanges.length,
    pending: plan.pending.length,
    conflicts: plan.conflicts.length,
  };
}

function normalizeAnimalIndex(source) {
  const index = new Map();
  if (!source) return index;
  const entries = source instanceof Map ? source.entries() : Object.entries(source);
  for (const [tag, value] of entries) {
    const key = String(tag ?? "").trim();
    if (!key) continue;
    index.set(key, {
      id: String(value?.id ?? ""),
      birthDate: value?.birthDate ?? null,
      status: value?.status ?? "active",
    });
  }
  return index;
}

function normalizeLotIndex(source) {
  const index = new Map();
  if (!source) return index;
  const entries = source instanceof Map ? source.entries() : Object.entries(source);
  for (const [name, value] of entries) {
    const key = normalizeKey(name);
    if (!key) continue;
    index.set(key, { id: String(value?.id ?? ""), name: value?.name ?? String(name) });
  }
  return index;
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function requireText(value, name) {
  const text = String(value ?? "").trim();
  if (!text) throw new RangeError(`Se requiere ${name} para planificar la importación.`);
  return text;
}

function optionalIsoDate(value, name) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new RangeError(`${name} debe ser una fecha ISO (aaaa-mm-dd).`);
  }
  return text;
}

/**
 * Order in which the canonical tables must be written.
 *
 * Foreign keys dictate it: a lot and an animal must exist before a membership can
 * reference both, an animal before any of its events, and a calving event before the
 * birth that points at it.
 */
export const LIVESTOCK_INVENTORY_OPERATION_ORDER = Object.freeze([
  "lot.insert",
  "animal.insert",
  "animal.update_birth_date",
  "animal.update_status",
  "lot_membership.insert",
  "reproductive_event.insert",
  "birth.insert",
]);

/**
 * Expands a plan into the ordered, dependency-safe operations a confirmation executes.
 *
 * The plan speaks in external tags because that is all the spreadsheet has; D1 needs
 * primary keys. Resolving one to the other is done here, once, against both the
 * animals this batch creates and the ones already stored — a membership or an event
 * that cannot be resolved to an animal is returned as unresolved instead of being
 * written against a missing key.
 *
 * `newId(kind, dedupeKey)` must be deterministic for a given dedupeKey: replaying a
 * confirmation then produces the same primary keys, which is what makes the write
 * idempotent.
 */
export function buildLivestockInventoryOperations(plan, context = {}) {
  const newId = typeof context.newId === "function"
    ? context.newId
    : (kind, dedupeKey) => `${kind}:${dedupeKey}`;
  const existingAnimals = normalizeAnimalIndex(context.existingAnimalsByTag);
  const existingLots = normalizeLotIndex(context.existingLotsByName);

  const operations = [];
  const unresolved = [];
  const animalIdByTag = new Map();
  const lotIdByKey = new Map();

  for (const [tag, animal] of existingAnimals) animalIdByTag.set(tag, animal.id);
  for (const [key, lot] of existingLots) lotIdByKey.set(key, lot.id);

  for (const lot of plan.lotsToCreate) {
    const id = newId("lot", lot.dedupeKey);
    lotIdByKey.set(normalizeKey(lot.name), id);
    operations.push({ kind: "lot.insert", dedupeKey: lot.dedupeKey, id, values: { name: lot.name } });
  }

  for (const animal of plan.animalsToCreate) {
    const id = newId("animal", animal.dedupeKey);
    animalIdByTag.set(animal.tag, id);
    operations.push({
      kind: "animal.insert",
      dedupeKey: animal.dedupeKey,
      id,
      rowNumber: animal.rowNumber,
      values: { tag: animal.tag, birthDate: animal.birthDate, status: animal.status },
    });
  }

  for (const animal of plan.animalsToUpdate) {
    operations.push({
      kind: "animal.update_birth_date",
      dedupeKey: animal.dedupeKey,
      id: animal.animalId,
      rowNumber: animal.rowNumber,
      values: { birthDate: animal.birthDate },
    });
  }

  for (const change of plan.statusChanges) {
    const animalId = animalIdByTag.get(change.tag);
    if (!animalId) {
      unresolved.push({ kind: "animal.update_status", tag: change.tag, rowNumber: change.rowNumber, reason: "UNKNOWN_ANIMAL" });
      continue;
    }
    operations.push({
      kind: "animal.update_status",
      dedupeKey: change.dedupeKey,
      id: animalId,
      rowNumber: change.rowNumber,
      values: { status: change.status, statusDate: change.statusDate, statusReason: change.statusReason },
    });
  }

  for (const membership of plan.lotMemberships) {
    const animalId = animalIdByTag.get(membership.tag);
    const lotId = membership.lotId ?? lotIdByKey.get(normalizeKey(membership.lotName)) ?? null;
    if (!animalId || !lotId) {
      unresolved.push({
        kind: "lot_membership.insert",
        tag: membership.tag,
        rowNumber: membership.rowNumber,
        reason: !animalId ? "UNKNOWN_ANIMAL" : "UNKNOWN_LOT",
      });
      continue;
    }
    operations.push({
      kind: "lot_membership.insert",
      dedupeKey: membership.dedupeKey,
      id: newId("membership", membership.dedupeKey),
      rowNumber: membership.rowNumber,
      values: { animalId, lotId },
    });
  }

  const calvingEventIdByKey = new Map();
  for (const event of plan.reproductiveEvents) {
    const animalId = animalIdByTag.get(event.tag);
    if (!animalId) {
      unresolved.push({ kind: "reproductive_event.insert", tag: event.tag, rowNumber: event.rowNumber, reason: "UNKNOWN_ANIMAL" });
      continue;
    }
    const id = newId("event", event.dedupeKey);
    if (event.eventType === "calving") calvingEventIdByKey.set(`${event.tag}:${event.occurredAt}`, id);
    operations.push({
      kind: "reproductive_event.insert",
      dedupeKey: event.dedupeKey,
      id,
      rowNumber: event.rowNumber,
      values: {
        animalId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        result: event.result,
      },
    });
  }

  for (const birth of plan.births) {
    const animalId = animalIdByTag.get(birth.tag);
    if (!animalId) {
      unresolved.push({ kind: "birth.insert", tag: birth.tag, rowNumber: birth.rowNumber, reason: "UNKNOWN_ANIMAL" });
      continue;
    }
    operations.push({
      kind: "birth.insert",
      dedupeKey: birth.dedupeKey,
      id: newId("birth", birth.dedupeKey),
      rowNumber: birth.rowNumber,
      values: {
        damAnimalId: animalId,
        // Links the birth to the calving it belongs to, when that event is in this batch.
        reproductiveEventId: calvingEventIdByKey.get(`${birth.tag}:${birth.occurredAt}`) ?? null,
        occurredAt: birth.occurredAt,
        calfSex: birth.calfSex,
        calfExternalId: birth.calfExternalId,
      },
    });
  }

  operations.sort((left, right) =>
    LIVESTOCK_INVENTORY_OPERATION_ORDER.indexOf(left.kind) - LIVESTOCK_INVENTORY_OPERATION_ORDER.indexOf(right.kind));

  return {
    fieldId: plan.fieldId,
    operations,
    unresolved,
    countsByKind: operations.reduce((counts, operation) => {
      counts[operation.kind] = (counts[operation.kind] ?? 0) + 1;
      return counts;
    }, {}),
  };
}
