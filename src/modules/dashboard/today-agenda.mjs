const URGENCY_RANK = {
  urgent: 0,
  today: 1,
  soon: 2,
  review: 3,
};

const HERD_URGENCY = {
  overdue: "urgent",
  today: "today",
  soon: "soon",
  watch: "review",
};

const MAMMARY_URGENCY = {
  urgent: "urgent",
  high: "today",
  medium: "soon",
  review: "review",
};

const ALERT_URGENCY = {
  attention: "urgent",
  warning: "soon",
  info: "review",
};

const MAMMARY_REASON_LABELS = {
  open_mastitis_case: "Caso mamario abierto ya registrado",
  critical_rcs: "RCS crítico",
  high_rcs: "RCS alto",
  elevated_rcs: "RCS elevado",
  increasing_trend: "Tendencia al alza",
  stale_control: "Control con más de 45 días",
};

export function buildTodayAgenda({
  agronomicWorkItems = [],
  importWorkItems = [],
  contextFieldId = null,
  herdWorkItems = [],
  mammaryWorkItems = [],
  operationalAlerts = [],
  referenceDate,
} = {}) {
  const today = isoDate(referenceDate) ?? new Date().toISOString().slice(0, 10);
  const openMammaryAnimalIds = new Set(
    mammaryWorkItems
      .filter((item) => item?.hasOpenMastitis)
      .map((item) => text(item.animalId))
      .filter(Boolean),
  );
  const usableHerdItems = herdWorkItems.filter((item) =>
    !(item?.kind === "health_follow_up" && openMammaryAnimalIds.has(text(item.animalId))));
  const hasIndividualWeighingTasks = usableHerdItems.some((item) => item?.kind === "weighing");
  const usableOperationalAlerts = operationalAlerts.filter((alert) =>
    !(alert?.id === "weight-coverage" && hasIndividualWeighingTasks));

  const items = [
    ...agronomicWorkItems.flatMap((item) =>
      normalizeAgronomicItem(item, contextFieldId, today)),
    ...importWorkItems.flatMap((item) =>
      normalizeImportItem(item, contextFieldId, today)),
    ...usableHerdItems.flatMap((item) => normalizeHerdItem(item, today)),
    ...mammaryWorkItems.flatMap((item) => normalizeMammaryItem(item, today)),
    ...usableOperationalAlerts.flatMap((alert) =>
      normalizeOperationalAlert(alert, contextFieldId, today)),
  ];

  const byId = new Map();
  for (const candidate of items) {
    const item = { ...candidate, revision: agendaItemRevision(candidate) };
    const current = byId.get(item.id);
    if (!current || compareAgendaItems(item, current) < 0) byId.set(item.id, item);
  }
  return [...byId.values()].sort(compareAgendaItems);
}

function normalizeAgronomicItem(item, contextFieldId, today) {
  const id = text(item?.id);
  const fieldId = text(item?.fieldId);
  const paddockName = text(item?.paddockName);
  const visitDate = isoDate(item?.visitDate);
  const actionHeading = text(item?.actionHeading);
  const recommendationText = text(item?.recommendationText);
  const importJobId = text(item?.importJobId);
  if (
    !id
    || !fieldId
    || !paddockName
    || !visitDate
    || !actionHeading
    || !recommendationText
    || !importJobId
    || (contextFieldId && fieldId !== contextFieldId)
    || visitDate > today
    || daysBetween(visitDate, today) > 180
  ) return [];
  const query = new URLSearchParams({ fieldId });
  return [{
    id: `potreros:agronomic:${id}`,
    category: "paddocks",
    source: "potreros",
    sourceLabel: "Asesoría agronómica",
    fieldId,
    animalId: null,
    animalTag: null,
    lotName: paddockName,
    urgency: "review",
    title: `Revisar recomendación · ${paddockName}`,
    reason: truncate(`${actionHeading} ${recommendationText}`, 360),
    evidenceDate: visitDate,
    dateLabel: "Visita",
    href: `/app/potreros?${query.toString()}`,
    actionLabel: "Abrir potreros",
  }];
}

function normalizeImportItem(item, contextFieldId, today) {
  const id = text(item?.id);
  const importJobId = text(item?.importJobId);
  const filename = text(item?.filename);
  const createdAt = isoDate(item?.createdAt) ?? today;
  const fieldId = text(item?.fieldId) || null;
  const summary = text(item?.summary);
  if (
    !id
    || !importJobId
    || !filename
    || (contextFieldId && fieldId && fieldId !== contextFieldId)
  ) return [];
  const urgency = item?.status === "conflict" ? "urgent" : "today";
  const query = new URLSearchParams();
  if (fieldId) query.set("fieldId", fieldId);
  return [{
    id: `importaciones:staged:${id}`,
    category: "imports",
    source: "importaciones",
    sourceLabel: "Importaciones",
    fieldId,
    animalId: null,
    animalTag: null,
    lotName: null,
    urgency,
    title: `Importación pendiente · ${filename}`,
    reason: summary || "Un archivo cargado requiere conciliación antes de incorporarse.",
    evidenceDate: createdAt,
    dateLabel: "Carga",
    href: `/app/importaciones${query.toString() ? `?${query.toString()}` : ""}`,
    actionLabel: "Abrir importaciones",
  }];
}

export function agendaItemRevision(item) {
  const canonical = [
    item?.id,
    item?.source,
    item?.fieldId,
    item?.animalId,
    item?.urgency,
    item?.title,
    item?.reason,
    item?.evidenceDate,
    item?.href,
    item?.actionLabel,
  ].map((value) => String(value ?? "")).join("\u001f");
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(canonical)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function normalizeHerdItem(item, today) {
  const id = text(item?.id);
  const animalId = text(item?.animalId);
  const fieldId = text(item?.fieldId);
  const dueDate = isoDate(item?.dueDate);
  const urgency = HERD_URGENCY[item?.priority];
  if (!id || !animalId || !fieldId || !dueDate || !urgency) return [];
  return [{
    id: `ganado:${id}`,
    category: herdCategory(item.kind),
    source: "ganado",
    sourceLabel: "Ganado",
    fieldId,
    animalId,
    animalTag: text(item.animalTag) || "Animal",
    lotName: text(item.lotName) || null,
    urgency,
    title: text(item.title) || "Revisar animal",
    reason: text(item.detail) || "La agenda del rebaño marcó esta revisión.",
    evidenceDate: dueDate,
    dateLabel: dueDate < today
      ? "Vencida"
      : "Fecha objetivo",
    href: `/app/ganado/ficha?animalId=${encodeURIComponent(animalId)}`,
    actionLabel: "Abrir ficha",
  }];
}

function normalizeMammaryItem(item, today) {
  const animalId = text(item?.animalId);
  const fieldId = text(item?.fieldId);
  const urgency = MAMMARY_URGENCY[item?.priority];
  const actionLabel = mammaryActionLabel(item?.action);
  if (!animalId || !fieldId || !urgency || !actionLabel) return [];
  const controlDate = isoDate(item?.controlDate);
  const animalTag = text(item?.tag) || "Animal";
  const query = new URLSearchParams({ section: "health", fieldId });
  return [{
    id: `leche:mammary:${animalId}`,
    category: "health",
    source: "leche",
    sourceLabel: "Leche · salud mamaria",
    fieldId,
    animalId,
    animalTag,
    lotName: text(item?.lotName) || null,
    urgency,
    title: `${actionLabel} · ${animalTag}`,
    reason: mammaryReason(item),
    evidenceDate: controlDate ?? today,
    dateLabel: controlDate ? "Último control" : "Señal vigente",
    href: `/app/leche?${query.toString()}`,
    actionLabel: "Abrir salud",
  }];
}

function normalizeOperationalAlert(alert, contextFieldId, today) {
  const id = text(alert?.id);
  const urgency = ALERT_URGENCY[alert?.tone];
  if (!id || !urgency) return [];
  const metadata = operationalMetadata(id);
  return [{
    id: `operacion:${contextFieldId || "all"}:${id}`,
    category: metadata.category,
    source: metadata.source,
    sourceLabel: metadata.sourceLabel,
    fieldId: text(contextFieldId) || null,
    animalId: null,
    animalTag: null,
    lotName: null,
    urgency,
    title: text(alert.title) || "Revisión operacional",
    reason: text(alert.detail) || "Un indicador operacional requiere revisión.",
    evidenceDate: today,
    dateLabel: "Calculado",
    href: safeProductHref(alert.href),
    actionLabel: metadata.actionLabel,
  }];
}

function herdCategory(kind) {
  if (["pregnancy_check", "dry_off", "calving"].includes(kind)) return "reproduction";
  if (["withdrawal", "health_follow_up"].includes(kind)) return "health";
  if (kind === "weighing") return "weighing";
  return "records";
}

function mammaryActionLabel(action) {
  return {
    review_now: "Revisar hoy",
    review_soon: "Revisar dentro de 48 h",
    schedule_recheck: "Programar nuevo RCS",
    update_control: "Actualizar control lechero",
  }[action] ?? null;
}

function mammaryReason(item) {
  const parts = [];
  const rcs = finiteNonNegative(item?.somaticCellCount);
  if (rcs !== null) parts.push(`RCS ${rcs.toLocaleString("es-CL")} células/ml`);
  for (const code of item?.reasonCodes ?? []) {
    const label = MAMMARY_REASON_LABELS[code];
    if (label) parts.push(label);
  }
  return [...new Set(parts)].join(" · ")
    || "Una señal de salud mamaria requiere revisión humana.";
}

function operationalMetadata(id) {
  return {
    "milk-drop": {
      actionLabel: "Revisar leche",
      category: "production",
      source: "leche",
      sourceLabel: "Leche",
    },
    "negative-operating-result": {
      actionLabel: "Revisar costos",
      category: "finance",
      source: "costos",
      sourceLabel: "Costos",
    },
    "weight-coverage": {
      actionLabel: "Revisar pesajes",
      category: "weighing",
      source: "ganado",
      sourceLabel: "Ganado",
    },
    "no-available-paddocks": {
      actionLabel: "Revisar potreros",
      category: "paddocks",
      source: "potreros",
      sourceLabel: "Potreros",
    },
    "activity-gap": {
      actionLabel: "Registrar manejo",
      category: "records",
      source: "potreros",
      sourceLabel: "Potreros",
    },
  }[id] ?? {
    actionLabel: "Abrir módulo",
    category: "records",
    source: "dashboard",
    sourceLabel: "Resumen",
  };
}

function compareAgendaItems(left, right) {
  return URGENCY_RANK[left.urgency] - URGENCY_RANK[right.urgency]
    || String(left.evidenceDate ?? "9999-12-31").localeCompare(String(right.evidenceDate ?? "9999-12-31"))
    || left.sourceLabel.localeCompare(right.sourceLabel, "es")
    || left.id.localeCompare(right.id);
}

function safeProductHref(value) {
  const href = text(value);
  return href.startsWith("/app/") || href === "/app" ? href : "/app";
}

function isoDate(value) {
  const candidate = text(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const date = new Date(`${candidate}T12:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === candidate
    ? candidate
    : null;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function daysBetween(from, to) {
  return Math.floor(
    (Date.parse(`${to}T12:00:00.000Z`) - Date.parse(`${from}T12:00:00.000Z`))
    / 86_400_000,
  );
}

function truncate(value, maximum) {
  const cleaned = text(value);
  return cleaned.length <= maximum ? cleaned : `${cleaned.slice(0, maximum - 1).trimEnd()}…`;
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}
