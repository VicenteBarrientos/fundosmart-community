export const ONBOARDING_STORAGE_VERSION = 1;
export const ONBOARDING_PATHS = Object.freeze([
  "cooprinsem",
  "spreadsheet",
  "manual",
]);

const ONBOARDING_STATUSES = new Set(["active", "dismissed", "completed"]);
const ONBOARDING_PATH_SET = new Set(ONBOARDING_PATHS);

export async function createOnboardingScope(organizationId, membershipId) {
  const organization = requiredScopePart(organizationId, "organizationId");
  const membership = requiredScopePart(membershipId, "membershipId");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `fundosmart:onboarding:v${ONBOARDING_STORAGE_VERSION}:${organization}:${membership}`,
    ),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

export function createOnboardingStorageKey(scope) {
  if (!/^[a-f0-9]{32}$/u.test(scope)) {
    throw new Error("El alcance local de onboarding no es válido.");
  }
  return `fundosmart:onboarding:${scope}:v${ONBOARDING_STORAGE_VERSION}`;
}

export function createEmptyOnboardingState(now = new Date().toISOString()) {
  const timestamp = validTimestamp(now) ?? new Date().toISOString();
  return {
    version: ONBOARDING_STORAGE_VERSION,
    status: "active",
    path: null,
    startedAt: timestamp,
    lastSeenAt: timestamp,
    pathSelectedAt: null,
    pathUpdatedAt: null,
    firstFieldCompletedAt: null,
    firstPaddockCompletedAt: null,
    firstActionCompletedAt: null,
    dismissedAt: null,
    resumedAt: null,
    completedAt: null,
  };
}

export function loadOnboardingState(storage, scope, now = new Date().toISOString()) {
  const fallback = createEmptyOnboardingState(now);
  if (!storage) return fallback;
  const key = createOnboardingStorageKey(scope);
  try {
    const raw = storage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return normalizeOnboardingState(parsed) ?? fallback;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // Storage is optional. Canonical product facts still drive completion.
    }
    return fallback;
  }
}

export function saveOnboardingState(storage, scope, state) {
  if (!storage) return false;
  const normalized = normalizeOnboardingState(state);
  if (!normalized) return false;
  try {
    storage.setItem(createOnboardingStorageKey(scope), JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function reconcileOnboardingState(state, facts, now = new Date().toISOString()) {
  const current = normalizeOnboardingState(state) ?? createEmptyOnboardingState(now);
  const timestamp = validTimestamp(now) ?? new Date().toISOString();
  const normalizedFacts = normalizeFacts(facts);
  const next = {
    ...current,
    lastSeenAt: timestamp,
    firstFieldCompletedAt: normalizedFacts.fieldCount > 0
      ? current.firstFieldCompletedAt ?? timestamp
      : current.firstFieldCompletedAt,
    firstPaddockCompletedAt: normalizedFacts.paddockCount > 0
      ? current.firstPaddockCompletedAt ?? timestamp
      : current.firstPaddockCompletedAt,
    firstActionCompletedAt: normalizedFacts.hasFirstAction
      ? current.firstActionCompletedAt ?? timestamp
      : current.firstActionCompletedAt,
  };
  if (isOnboardingActivated(normalizedFacts)) {
    return {
      ...next,
      status: "completed",
      completedAt: current.completedAt ?? timestamp,
      dismissedAt: null,
    };
  }
  return next;
}

export function selectOnboardingPath(state, path, now = new Date().toISOString()) {
  if (!ONBOARDING_PATH_SET.has(path)) {
    throw new Error("La ruta de onboarding no es válida.");
  }
  const current = normalizeOnboardingState(state) ?? createEmptyOnboardingState(now);
  if (current.status === "completed") return current;
  const timestamp = validTimestamp(now) ?? new Date().toISOString();
  return {
    ...current,
    status: "active",
    path,
    pathSelectedAt: current.pathSelectedAt ?? timestamp,
    pathUpdatedAt: timestamp,
    dismissedAt: null,
    lastSeenAt: timestamp,
  };
}

export function dismissOnboarding(state, now = new Date().toISOString()) {
  const current = normalizeOnboardingState(state) ?? createEmptyOnboardingState(now);
  if (current.status === "completed") return current;
  const timestamp = validTimestamp(now) ?? new Date().toISOString();
  return {
    ...current,
    status: "dismissed",
    dismissedAt: timestamp,
    lastSeenAt: timestamp,
  };
}

export function resumeOnboarding(state, now = new Date().toISOString()) {
  const current = normalizeOnboardingState(state) ?? createEmptyOnboardingState(now);
  if (current.status === "completed") return current;
  const timestamp = validTimestamp(now) ?? new Date().toISOString();
  return {
    ...current,
    status: "active",
    dismissedAt: null,
    resumedAt: timestamp,
    lastSeenAt: timestamp,
  };
}

export function buildOnboardingSteps(state, facts) {
  const current = normalizeOnboardingState(state) ?? createEmptyOnboardingState();
  const normalizedFacts = normalizeFacts(facts);
  return [
    {
      id: "path",
      label: "Elige cómo empezar",
      detail: current.path
        ? `Ruta elegida: ${onboardingPathLabel(current.path)}.`
        : "Cooprinsem, una planilla o registro manual.",
      completed: current.path !== null,
    },
    {
      id: "field",
      label: "Crea tu primer fundo",
      detail: normalizedFacts.fieldCount > 0
        ? `${normalizedFacts.fieldCount} ${normalizedFacts.fieldCount === 1 ? "fundo disponible" : "fundos disponibles"}.`
        : "Nombre, ubicación y límite quedan editables.",
      completed: normalizedFacts.fieldCount > 0,
    },
    {
      id: "paddock",
      label: "Delimita tu primer potrero",
      detail: normalizedFacts.paddockCount > 0
        ? `${normalizedFacts.paddockCount} ${normalizedFacts.paddockCount === 1 ? "potrero disponible" : "potreros disponibles"}.`
        : "Dibuja sus esquinas; FundoSmart calcula la superficie.",
      completed: normalizedFacts.paddockCount > 0,
    },
    {
      id: "action",
      label: "Completa una primera acción útil",
      detail: normalizedFacts.hasFirstAction
        ? "Ya existe un registro productivo confirmado."
        : "Importa, registra un manejo, un animal, leche, costo o completa una tarea.",
      completed: normalizedFacts.hasFirstAction,
    },
  ];
}

export function isOnboardingActivated(facts) {
  const normalized = normalizeFacts(facts);
  return normalized.fieldCount > 0
    && normalized.paddockCount > 0
    && normalized.hasFirstAction;
}

export function onboardingPathLabel(path) {
  if (path === "cooprinsem") return "Migrar Cooprinsem";
  if (path === "spreadsheet") return "Importar una planilla";
  if (path === "manual") return "Empezar manualmente";
  return "Sin elegir";
}

function normalizeOnboardingState(value) {
  if (!value || typeof value !== "object") return null;
  if (value.version !== ONBOARDING_STORAGE_VERSION) return null;
  if (!ONBOARDING_STATUSES.has(value.status)) return null;
  if (value.path !== null && !ONBOARDING_PATH_SET.has(value.path)) return null;
  const timestamps = [
    "startedAt",
    "lastSeenAt",
    "pathSelectedAt",
    "pathUpdatedAt",
    "firstFieldCompletedAt",
    "firstPaddockCompletedAt",
    "firstActionCompletedAt",
    "dismissedAt",
    "resumedAt",
    "completedAt",
  ];
  const normalized = {
    version: ONBOARDING_STORAGE_VERSION,
    status: value.status,
    path: value.path,
  };
  for (const key of timestamps) {
    const timestamp = validTimestamp(value[key]);
    if (key === "startedAt" || key === "lastSeenAt") {
      if (!timestamp) return null;
      normalized[key] = timestamp;
    } else {
      normalized[key] = timestamp;
    }
  }
  if (normalized.status === "completed" && !normalized.completedAt) return null;
  if (normalized.status === "dismissed" && !normalized.dismissedAt) return null;
  return normalized;
}

function normalizeFacts(facts) {
  return {
    fieldCount: nonNegativeInteger(facts?.fieldCount),
    paddockCount: nonNegativeInteger(facts?.paddockCount),
    hasFirstAction: facts?.hasFirstAction === true,
  };
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function validTimestamp(value) {
  if (typeof value !== "string" || !value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function requiredScopePart(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} es obligatorio para aislar el onboarding.`);
  }
  return value.trim();
}
