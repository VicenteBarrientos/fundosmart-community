import type { VisitItemOutcomeInput, WorkVisit } from "../domain/types";

const OFFLINE_VISITS_KEY_PREFIX = "fundosmart:offline_visits:";
const PENDING_SYNC_KEY = "fundosmart:pending_visit_sync";

export type PendingVisitSync = {
  visitId: string;
  expectedVersion: number;
  outcomes: VisitItemOutcomeInput[];
  updatedAt: string;
};

export function saveOfflineVisit(visit: WorkVisit): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const key = `${OFFLINE_VISITS_KEY_PREFIX}${visit.id}`;
    window.localStorage.setItem(key, JSON.stringify(visit));
  } catch (cause) {
    console.warn("No se pudo guardar la visita en almacenamiento local offline:", cause);
  }
}

export function loadOfflineVisit(visitId: string): WorkVisit | null {
  if (typeof window === "undefined" || !window.localStorage) return null;
  try {
    const key = `${OFFLINE_VISITS_KEY_PREFIX}${visitId}`;
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as WorkVisit) : null;
  } catch (cause) {
    console.warn("No se pudo cargar la visita del almacenamiento local:", cause);
    return null;
  }
}

export function savePendingVisitSync(syncData: PendingVisitSync): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const raw = window.localStorage.getItem(PENDING_SYNC_KEY);
    const pendingList: PendingVisitSync[] = raw ? (JSON.parse(raw) as PendingVisitSync[]) : [];
    const filtered = pendingList.filter((item) => item.visitId !== syncData.visitId);
    filtered.push(syncData);
    window.localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(filtered));
  } catch (cause) {
    console.warn("No se pudo guardar la sincronización pendiente:", cause);
  }
}

export function getPendingVisitSyncs(): PendingVisitSync[] {
  if (typeof window === "undefined" || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(PENDING_SYNC_KEY);
    return raw ? (JSON.parse(raw) as PendingVisitSync[]) : [];
  } catch (cause) {
    console.warn("No se pudo leer la lista de sincronizaciones pendientes:", cause);
    return [];
  }
}

export function clearPendingVisitSync(visitId: string): void {
  if (typeof window === "undefined" || !window.localStorage) return;
  try {
    const syncs = getPendingVisitSyncs().filter((item) => item.visitId !== visitId);
    window.localStorage.setItem(PENDING_SYNC_KEY, JSON.stringify(syncs));
  } catch (cause) {
    console.warn("No se pudo limpiar la sincronización pendiente:", cause);
  }
}
