const ACTIVITY_LABELS = {
  fertilization: "Fertilización",
  grazing: "Pastoreo",
  soil: "Análisis de suelo",
  harvest: "Cosecha",
  maintenance: "Mantención",
  other: "Otro manejo",
};

const ACTIVITY_PATTERNS = [
  ["fertilization", /\b(fertiliz|urea|abono)\w*/],
  ["grazing", /\b(pastoreo|pastorear|pastoreado)\b/],
  ["soil", /\b(analisis de suelo|muestra de suelo)\b/],
  ["harvest", /\b(cosecha|cosechar|ensilaje|silo)\b/],
  ["maintenance", /\b(mantencion|mantener|reparacion|reparar|cerco|bebedero)\w*/],
  ["other", /\b(otro manejo|manejo general)\b/],
];

const ACTION_PATTERN = /\b(registra|registrar|anota|anotar|guarda|guardar|crea|crear|agrega|agregar)\b/;

export function buildAssistantReply(message, data, options = {}) {
  const original = cleanText(message, 600);
  const normalized = normalizeText(original);
  const today = options.today ?? todayInChile();

  if (!original) return helpReply("Escribe una pregunta o una tarea para comenzar.");

  const activityType = detectActivityType(normalized);
  if (ACTION_PATTERN.test(normalized) && activityType) {
    if (data.canOperate === false) {
      return {
        message: "Puedo preparar esa tarea, pero tu acceso actual es de solo lectura. Pide a un operador, encargado o administrador que la registre.",
        suggestions: ["¿Qué requiere atención hoy?", "Mostrar mis potreros"],
        links: [{ label: "Abrir potreros", href: "/app/potreros" }],
        action: null,
      };
    }
    return buildActivityPreview(original, normalized, activityType, data, {
      today,
      actionId: options.actionId ?? `assistant-activity-${crypto.randomUUID()}`,
      createdAt: options.createdAt ?? new Date().toISOString(),
    });
  }

  const field = resolveQuestionField(normalized, data.fields ?? []);
  const scoped = field ? scopeData(data, field.id) : data;

  if (/\b(que requiere atencion|que necesita atencion|alertas?|pendientes?|prioridad|prioridades)\b/.test(normalized)) {
    return attentionReply(scoped, field, today);
  }
  if (/\b(pabco|cumplimiento|vencimientos?|documentos? sanitarios?)\b/.test(normalized)) {
    return pabcoReply(scoped, field, today);
  }
  if (/\b(retiro|resguardo|antibiot|no entregar|leche bloqueada)\w*/.test(normalized)) {
    return withdrawalReply(scoped, field);
  }
  if (/\b(calidad|rcs|celulas somaticas|grasa|proteina|ufc|mastitis)\b/.test(normalized)) {
    return qualityReply(scoped, field);
  }
  if (/\b(reproduccion|pren|preñez|insemin|celo|secado|secar)\w*/.test(normalized)) {
    return reproductionReply(scoped, field, today);
  }
  if (/\b(produccion|litros?|estanque|entregas?|medidor)\b/.test(normalized) && /\b(leche|litros?|estanque|entregas?|medidor)\b/.test(normalized)) {
    return productionReply(scoped, field, normalized, today);
  }
  if (/\b(vacas?|animales?|ganado|reban|rebaño)\b/.test(normalized)) {
    return livestockReply(scoped, field);
  }
  if (/\b(fundos?|campos?|potreros?)\b/.test(normalized)) {
    return fieldsReply(data);
  }
  if (/\b(hola|ayuda|puedes hacer|que sabes|ejemplos?)\b/.test(normalized)) return helpReply();

  return helpReply("Todavía no puedo interpretar esa solicitud con seguridad.");
}

export function validateConfirmedActivity(action, confirmationId) {
  if (!action || typeof action !== "object" || Array.isArray(action)) return "Falta la tarea por confirmar.";
  if (action.kind !== "create_activity") return "La tarea no está permitida.";
  if (typeof action.id !== "string" || !/^assistant-activity-[0-9a-f-]{36}$/i.test(action.id)) return "La tarea no es válida.";
  if (confirmationId !== action.id) return "La confirmación no corresponde a esta tarea.";
  if (typeof action.paddockId !== "string" || !action.paddockId.trim()) return "Falta el potrero de la tarea.";
  if (!(action.activityType in ACTIVITY_LABELS)) return "El tipo de manejo no es válido.";
  if (!isIsoDate(action.occurredAt)) return "La fecha del manejo no es válida.";
  if (typeof action.description !== "string" || !action.description.trim() || action.description.length > 500) return "La descripción del manejo no es válida.";
  if (!action.description.startsWith("Registrado por Asistente FundoSmart:")) return "La procedencia del manejo no es válida.";
  if (typeof action.createdAt !== "string" || Number.isNaN(new Date(action.createdAt).valueOf())) return "La tarea no tiene una fecha de creación válida.";
  if (action.quantity !== null && (typeof action.quantity !== "number" || !Number.isFinite(action.quantity) || action.quantity <= 0)) return "La cantidad del manejo no es válida.";
  if (action.unit !== null && (typeof action.unit !== "string" || !action.unit.trim() || action.unit.length > 30)) return "La unidad del manejo no es válida.";
  if ((action.quantity === null) !== (action.unit === null)) return "La cantidad y su unidad deben registrarse juntas.";
  if (action.costClp !== null) return "El asistente no registra costos en esta tarea.";
  return null;
}

function buildActivityPreview(original, normalized, activityType, data, options) {
  const fields = data.fields ?? [];
  const paddocks = data.paddocks ?? [];
  const namedFields = findNamedItems(normalized, fields);
  let candidates = findNamedItems(normalized, paddocks);
  if (namedFields.length === 1) candidates = candidates.filter((paddock) => paddock.fieldId === namedFields[0].id);

  if (candidates.length === 0) {
    const choices = paddocks.slice(0, 8).map((paddock) => {
      const field = fields.find((candidate) => candidate.id === paddock.fieldId);
      return `${field?.name ?? "Fundo"} › ${paddock.name}`;
    });
    return {
      message: `Puedo registrar ${ACTIVITY_LABELS[activityType].toLowerCase()}, pero necesito el nombre exacto del potrero.${choices.length ? ` Opciones: ${choices.join(", ")}.` : " No hay potreros activos disponibles."}`,
      suggestions: ["Mostrar mis potreros", "¿Qué requiere atención hoy?"],
      links: [{ label: "Abrir potreros", href: "/app/potreros" }],
      action: null,
    };
  }
  if (candidates.length > 1) {
    return {
      message: `Encontré más de un potrero con ese nombre: ${candidates.map((paddock) => {
        const field = fields.find((candidate) => candidate.id === paddock.fieldId);
        return `${field?.name ?? "Fundo"} › ${paddock.name}`;
      }).join(", ")}. Indica también el fundo.`,
      suggestions: ["Mostrar mis potreros"],
      links: [{ label: "Abrir potreros", href: "/app/potreros" }],
      action: null,
    };
  }

  const paddock = candidates[0];
  const field = fields.find((candidate) => candidate.id === paddock.fieldId) ?? null;
  const occurredAt = parseRequestedDate(normalized, options.today);
  if (!occurredAt) {
    return {
      message: "No pude validar la fecha. Usa hoy, ayer, AAAA-MM-DD o DD/MM/AAAA.",
      suggestions: [`Registrar ${ACTIVITY_LABELS[activityType].toLowerCase()} en ${paddock.name} hoy`],
      links: [],
      action: null,
    };
  }
  if (occurredAt > options.today) {
    return {
      message: "Por ahora registro manejos ya realizados. Usa hoy o una fecha anterior.",
      suggestions: [`Registrar ${ACTIVITY_LABELS[activityType].toLowerCase()} en ${paddock.name} hoy`],
      links: [{ label: "Abrir potreros", href: "/app/potreros" }],
      action: null,
    };
  }
  const amount = parseQuantity(normalized);
  const action = {
    kind: "create_activity",
    id: options.actionId,
    fieldId: paddock.fieldId,
    fieldName: field?.name ?? "Fundo",
    paddockId: paddock.id,
    paddockName: paddock.name,
    activityType,
    activityLabel: ACTIVITY_LABELS[activityType],
    occurredAt,
    description: cleanText(`Registrado por Asistente FundoSmart: ${original}`, 500),
    quantity: amount?.quantity ?? null,
    unit: amount?.unit ?? null,
    costClp: null,
    createdAt: options.createdAt,
  };
  const quantity = action.quantity === null ? "" : ` · ${formatNumber(action.quantity)} ${action.unit}`;
  return {
    message: `Preparé este manejo: ${action.activityLabel} · ${action.fieldName} › ${action.paddockName} · ${formatDate(action.occurredAt)}${quantity}. Revísalo y confírmalo; todavía no guardé ningún dato.`,
    suggestions: [],
    links: [{ label: "Abrir potreros", href: "/app/potreros" }],
    action,
  };
}

function attentionReply(data, field, today) {
  const withdrawals = data.milk?.withdrawals ?? [];
  const dueWork = (data.milk?.reproduction?.workItems ?? []).filter((item) => item.dueAt <= today);
  const pabco = (data.milk?.pabcoItems ?? []).filter((item) => ["pending", "expiring", "expired"].includes(item.status));
  const dryOff = (data.milk?.herd ?? []).filter((animal) => animal.dryOffAlert);
  const total = withdrawals.length + dueWork.length + pabco.length + dryOff.length;
  const scope = scopeLabel(field);
  const message = total === 0
    ? `${scope}: no encontré alertas lecheras, reproductivas ni PABCO pendientes al ${formatDate(today)}.`
    : `${scope}, al ${formatDate(today)}: ${withdrawals.length} resguardo${plural(withdrawals.length)} activo${plural(withdrawals.length)}, ${dueWork.length} tarea${plural(dueWork.length)} reproductiva${plural(dueWork.length)} vencida${plural(dueWork.length)}, ${dryOff.length} ${dryOff.length === 1 ? "recomendación" : "recomendaciones"} de secado y ${pabco.length} requisito${plural(pabco.length)} PABCO por atender.`;
  return standardReply(message, ["Resume la producción de leche", "Ver próximos vencimientos PABCO"], "/app/leche", "Abrir Leche");
}

function productionReply(data, field, normalized, today) {
  const kind = /\b(entrega|planta)\w*/.test(normalized)
    ? "delivery"
    : /\b(medidor|rollup|control)\w*/.test(normalized)
      ? "milk_meter_rollup"
      : "tank_total";
  const period = requestedPeriod(normalized, today);
  const rows = (data.milk?.bulkProduction ?? []).filter((row) => row.kind === kind && row.recordedAt >= period.start && row.recordedAt <= period.end);
  const liters = rows.reduce((sum, row) => sum + row.volumeLiters, 0);
  const label = kind === "delivery" ? "entregas" : kind === "milk_meter_rollup" ? "controles agregados" : "producción de estanque";
  const scope = scopeLabel(field);
  const message = rows.length === 0
    ? `${scope}: no hay registros de ${label} ${period.label}. No mezclé otras fuentes para evitar duplicar litros.`
    : `${scope}: ${formatNumber(liters)} litros de ${label} ${period.label}, en ${rows.length} registro${plural(rows.length)}. No mezclé otras fuentes para evitar duplicar litros.`;
  return standardReply(message, ["¿Cómo está la calidad de la leche?", "¿Qué requiere atención hoy?"], "/app/leche", "Ver producción");
}

function qualityReply(data, field) {
  const samples = [...(data.milk?.qualitySamples ?? [])].sort((left, right) => right.sampledAt.localeCompare(left.sampledAt));
  const latest = samples[0];
  if (!latest) return standardReply(`${scopeLabel(field)}: todavía no hay muestras de calidad registradas.`, ["Ver próximos vencimientos PABCO"], "/app/leche", "Abrir calidad");
  const metrics = [
    latest.fatPercent === null ? null : `grasa ${formatNumber(latest.fatPercent)}%`,
    latest.proteinPercent === null ? null : `proteína ${formatNumber(latest.proteinPercent)}%`,
    latest.somaticCellCount === null ? null : `RCS ${formatNumber(latest.somaticCellCount)} ${unitLabel(latest.somaticCellCountUnit)}`,
    latest.bacterialCount === null ? null : `UFC ${formatNumber(latest.bacterialCount)} ${unitLabel(latest.bacterialCountUnit)}`,
  ].filter(Boolean);
  const detail = metrics.length ? metrics.join(" · ") : "sin mediciones numéricas";
  return standardReply(`${scopeLabel(field)}: la muestra más reciente es del ${formatDate(latest.sampledAt)}: ${detail}.`, ["¿Hay resguardos activos?", "¿Qué requiere atención hoy?"], "/app/leche", "Abrir calidad");
}

function pabcoReply(data, field, today) {
  const items = [...(data.milk?.pabcoItems ?? [])].sort((left, right) => (left.validUntil ?? "9999").localeCompare(right.validUntil ?? "9999"));
  const attention = items.filter((item) => ["pending", "expiring", "expired"].includes(item.status));
  if (items.length === 0) return standardReply(`${scopeLabel(field)}: todavía no hay requisitos PABCO registrados.`, ["¿Qué requiere atención hoy?"], "/app/leche", "Abrir PABCO");
  const next = attention[0] ?? items.find((item) => item.validUntil && item.validUntil >= today) ?? items[0];
  const due = next.validUntil ? `, con vigencia hasta ${formatDate(next.validUntil)}` : "";
  return standardReply(`${scopeLabel(field)}: ${attention.length} de ${items.length} requisito${plural(items.length)} PABCO requiere${attention.length === 1 ? "" : "n"} atención. El próximo es ${pabcoLabel(next.requirement)} (${statusLabel(next.status)})${due}.`, ["¿Hay resguardos activos?", "¿Qué requiere atención hoy?"], "/app/leche", "Abrir PABCO");
}

function withdrawalReply(data, field) {
  const rows = data.milk?.withdrawals ?? [];
  if (rows.length === 0) return standardReply(`${scopeLabel(field)}: no hay resguardos activos registrados.`, ["¿Cómo está la calidad de la leche?"], "/app/leche", "Abrir salud");
  const details = rows.slice(0, 5).map((row) => `${row.tag}${row.milkUntil ? ` hasta ${formatDate(row.milkUntil)}` : ""}`).join(", ");
  return standardReply(`${scopeLabel(field)}: hay ${rows.length} resguardo${plural(rows.length)} activo${plural(rows.length)}. Animales: ${details}${rows.length > 5 ? ` y ${rows.length - 5} más` : ""}.`, ["¿Qué requiere atención hoy?"], "/app/leche", "Abrir salud");
}

function reproductionReply(data, field, today) {
  const items = data.milk?.reproduction?.workItems ?? [];
  const due = items.filter((item) => item.dueAt <= today);
  if (items.length === 0) return standardReply(`${scopeLabel(field)}: no hay tareas reproductivas proyectadas.`, ["¿Qué requiere atención hoy?"], "/app/leche", "Abrir reproducción");
  const next = [...items].sort((left, right) => left.dueAt.localeCompare(right.dueAt))[0];
  return standardReply(`${scopeLabel(field)}: hay ${items.length} tarea${plural(items.length)} reproductiva${plural(items.length)}; ${due.length} está${due.length === 1 ? "" : "n"} vencida${plural(due.length)}. La próxima es ${workLabel(next.action)} para ${next.tag}, fecha ${formatDate(next.dueAt)}.`, ["¿Hay resguardos activos?", "¿Qué requiere atención hoy?"], "/app/leche", "Abrir reproducción");
}

function livestockReply(data, field) {
  const counts = data.livestock ?? { total: 0, active: 0 };
  const dairy = data.milk?.herd?.length ?? 0;
  return standardReply(`${scopeLabel(field)}: ${counts.total} animal${plural(counts.total, "es")} registrado${plural(counts.total)}, ${counts.active} activo${plural(counts.active)} y ${dairy} en el rebaño lechero operativo.`, ["¿Qué requiere atención hoy?", "Resume la producción de leche"], "/app/ganado", "Abrir Ganado");
}

function fieldsReply(data) {
  const fields = data.fields ?? [];
  const paddocks = data.paddocks ?? [];
  if (fields.length === 0) return standardReply("No hay fundos disponibles para tu membresía.", [], "/app/potreros", "Abrir fundos");
  const summary = fields.map((field) => `${field.name} (${paddocks.filter((paddock) => paddock.fieldId === field.id).length} potreros)`).join(", ");
  return standardReply(`Tienes acceso a ${fields.length} fundo${plural(fields.length)}: ${summary}.`, ["¿Qué requiere atención hoy?"], "/app/potreros", "Abrir fundos");
}

function helpReply(prefix = "Puedo consultar tus datos autorizados y preparar tareas seguras.") {
  return {
    message: `${prefix} Prueba con “¿Qué requiere atención hoy?”, “Resume la producción de leche”, “¿Cómo está la calidad?” o “Registra pastoreo en Potrero Norte hoy”.`,
    suggestions: ["¿Qué requiere atención hoy?", "Resume la producción de leche", "Ver próximos vencimientos PABCO"],
    links: [],
    action: null,
  };
}

function standardReply(message, suggestions, href, label) {
  return { message, suggestions, links: [{ label, href }], action: null };
}

function scopeData(data, fieldId) {
  const milk = data.milk ?? {};
  return {
    ...data,
    fields: (data.fields ?? []).filter((field) => field.id === fieldId),
    paddocks: (data.paddocks ?? []).filter((paddock) => paddock.fieldId === fieldId),
    livestock: data.livestockByField?.[fieldId] ?? { total: 0, active: 0 },
    milk: {
      ...milk,
      bulkProduction: (milk.bulkProduction ?? []).filter((row) => row.fieldId === fieldId),
      qualitySamples: (milk.qualitySamples ?? []).filter((row) => row.fieldId === fieldId),
      pabcoItems: (milk.pabcoItems ?? []).filter((row) => row.fieldId === fieldId),
      herd: (milk.herd ?? []).filter((row) => row.fieldId === fieldId),
      withdrawals: (milk.withdrawals ?? []).filter((row) => row.fieldId === fieldId),
      reproduction: {
        ...(milk.reproduction ?? {}),
        workItems: (milk.reproduction?.workItems ?? []).filter((row) => row.fieldId === fieldId),
      },
    },
  };
}

function resolveQuestionField(normalized, fields) {
  const matches = findNamedItems(normalized, fields);
  return matches.length === 1 ? matches[0] : null;
}

function findNamedItems(normalized, items) {
  return items
    .filter((item) => {
      const name = normalizeText(item.name);
      return name.length >= 2 && normalized.includes(name);
    })
    .sort((left, right) => right.name.length - left.name.length)
    .filter((item, index, matches) => index === 0 || normalizeText(item.name).length === normalizeText(matches[0].name).length);
}

function detectActivityType(normalized) {
  return ACTIVITY_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? null;
}

function parseRequestedDate(normalized, today) {
  if (/\bayer\b/.test(normalized)) return addDays(today, -1);
  if (/\bhoy\b/.test(normalized)) return today;
  const iso = normalized.match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1];
  if (iso) return isIsoDate(iso) ? iso : null;
  const local = normalized.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (local) {
    const value = `${local[3]}-${local[2].padStart(2, "0")}-${local[1].padStart(2, "0")}`;
    return isIsoDate(value) ? value : null;
  }
  return today;
}

function parseQuantity(normalized) {
  const match = normalized.match(/\b(\d+(?:[.,]\d+)?)\s*(kg|kilos?|litros?|l|toneladas?|ton|horas?|dias?|fardos?)\b/);
  if (!match) return null;
  const quantity = Number(match[1].replace(",", "."));
  if (!Number.isFinite(quantity) || quantity <= 0) return null;
  const raw = match[2];
  const unit = /^k/.test(raw) ? "kg" : /^(l|litro)/.test(raw) ? "L" : /^ton/.test(raw) ? "t" : /^hora/.test(raw) ? "horas" : /^dia/.test(raw) ? "días" : "fardos";
  return { quantity, unit };
}

function requestedPeriod(normalized, today) {
  if (/\bhoy\b/.test(normalized)) return { start: today, end: today, label: `hoy, ${formatDate(today)}` };
  if (/\bayer\b/.test(normalized)) {
    const yesterday = addDays(today, -1);
    return { start: yesterday, end: yesterday, label: `ayer, ${formatDate(yesterday)}` };
  }
  if (/\b(esta semana|ultimos 7|ultimas 7)\b/.test(normalized)) return { start: addDays(today, -6), end: today, label: "en los últimos 7 días" };
  if (/\b(este mes|mes actual)\b/.test(normalized)) return { start: `${today.slice(0, 7)}-01`, end: today, label: "en el mes actual" };
  return { start: addDays(today, -29), end: today, label: "en los últimos 30 días" };
}

function normalizeText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function cleanText(value, maxLength) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function todayInChile() {
  const values = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(value, days) {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("es-CL", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00Z`));
}

function formatNumber(value) {
  return new Intl.NumberFormat("es-CL", { maximumFractionDigits: 2 }).format(value);
}

function plural(value, many = "s") {
  return value === 1 ? "" : many;
}

function scopeLabel(field) {
  return field?.name ?? "Todos tus fundos";
}

function unitLabel(value) {
  if (value === "thousand_cells_per_ml" || value === "thousand_cfu_per_ml") return "mil/mL";
  return "/mL";
}

function pabcoLabel(value) {
  return ({ veterinary_advisory: "asesoría veterinaria", medicine_prescriptions: "recetas de medicamentos", withdrawal_management: "gestión de resguardos", annual_water_analysis: "análisis anual de agua", animal_traceability: "trazabilidad animal" })[value] ?? value;
}

function statusLabel(value) {
  return ({ pending: "pendiente", compliant: "al día", expiring: "por vencer", expired: "vencido", not_applicable: "no aplica" })[value] ?? value;
}

function workLabel(value) {
  return ({ breed: "inseminar", pregnancy_check: "diagnóstico de preñez", dry_off: "secado", heat_watch: "vigilancia de celo" })[value] ?? value;
}
