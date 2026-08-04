import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildOnboardingSteps,
  createEmptyOnboardingState,
  createOnboardingScope,
  createOnboardingStorageKey,
  dismissOnboarding,
  isOnboardingActivated,
  loadOnboardingState,
  reconcileOnboardingState,
  resumeOnboarding,
  saveOnboardingState,
  selectOnboardingPath,
} from "../src/modules/onboarding/domain/onboarding-progress.mjs";

const source = (relativePath) => readFile(new URL(relativePath, import.meta.url), "utf8");
const T0 = "2026-07-28T10:00:00.000Z";
const T1 = "2026-07-28T10:01:00.000Z";
const T2 = "2026-07-28T10:02:00.000Z";
const T3 = "2026-07-28T10:03:00.000Z";
const T4 = "2026-07-28T10:04:00.000Z";

test("the local onboarding scope is stable, isolated, and does not expose raw identifiers", async () => {
  const first = await createOnboardingScope("org-personal-a", "membership-owner-a");
  const repeated = await createOnboardingScope("org-personal-a", "membership-owner-a");
  const otherMember = await createOnboardingScope("org-personal-a", "membership-owner-b");
  assert.match(first, /^[a-f0-9]{32}$/u);
  assert.equal(first, repeated);
  assert.notEqual(first, otherMember);
  const key = createOnboardingStorageKey(first);
  assert.equal(key, `fundosmart:onboarding:${first}:v1`);
  assert.doesNotMatch(key, /org-personal|membership-owner/u);
});

test("canonical facts stamp every durable milestone and complete the checklist", () => {
  let state = createEmptyOnboardingState(T0);
  state = selectOnboardingPath(state, "manual", T1);
  state = reconcileOnboardingState(state, {
    fieldCount: 1,
    paddockCount: 0,
    hasFirstAction: false,
  }, T2);
  assert.equal(state.firstFieldCompletedAt, T2);
  assert.equal(state.firstPaddockCompletedAt, null);
  assert.equal(state.firstActionCompletedAt, null);
  assert.deepEqual(
    buildOnboardingSteps(state, {
      fieldCount: 1,
      paddockCount: 0,
      hasFirstAction: false,
    }).map((step) => [step.id, step.completed]),
    [["path", true], ["field", true], ["paddock", false], ["action", false]],
  );

  state = reconcileOnboardingState(state, {
    fieldCount: 1,
    paddockCount: 2,
    hasFirstAction: true,
  }, T3);
  assert.equal(state.status, "completed");
  assert.equal(state.firstFieldCompletedAt, T2);
  assert.equal(state.firstPaddockCompletedAt, T3);
  assert.equal(state.firstActionCompletedAt, T3);
  assert.equal(state.completedAt, T3);
  assert.equal(isOnboardingActivated({
    fieldCount: 1,
    paddockCount: 2,
    hasFirstAction: true,
  }), true);
});

test("closing and resuming are persistent without allowing client-only canonical completion", () => {
  const storage = new MemoryStorage();
  const scope = "0123456789abcdef0123456789abcdef";
  let state = selectOnboardingPath(createEmptyOnboardingState(T0), "spreadsheet", T1);
  state = dismissOnboarding(state, T2);
  assert.equal(state.status, "dismissed");
  assert.equal(state.dismissedAt, T2);
  assert.equal(saveOnboardingState(storage, scope, state), true);
  assert.deepEqual(loadOnboardingState(storage, scope, T3), state);

  state = resumeOnboarding(state, T3);
  assert.equal(state.status, "active");
  assert.equal(state.dismissedAt, null);
  assert.equal(state.resumedAt, T3);
  state = reconcileOnboardingState(state, {
    fieldCount: 0,
    paddockCount: 0,
    hasFirstAction: false,
  }, T4);
  assert.equal(state.status, "active");
  assert.equal(state.firstFieldCompletedAt, null);
  assert.equal(state.firstPaddockCompletedAt, null);
  assert.equal(state.firstActionCompletedAt, null);
});

test("blocked or corrupt storage degrades to a valid in-memory checklist", () => {
  const scope = "fedcba9876543210fedcba9876543210";
  const corrupt = new MemoryStorage();
  corrupt.setItem(createOnboardingStorageKey(scope), "{not-json");
  const recovered = loadOnboardingState(corrupt, scope, T0);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.startedAt, T0);
  assert.equal(corrupt.getItem(createOnboardingStorageKey(scope)), null);

  const blocked = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  assert.equal(loadOnboardingState(blocked, scope, T1).startedAt, T1);
  assert.equal(saveOnboardingState(blocked, scope, recovered), false);
});

test("the dashboard exposes the three routes, isolated demo, recovery, and canonical progress", async () => {
  const [route, dashboard, checklist, feedback, agendaRepository] = await Promise.all([
    source("../app/(producto)/dashboard/page.tsx"),
    source("../src/modules/dashboard/DashboardPage.tsx"),
    source("../src/modules/onboarding/OnboardingChecklist.tsx"),
    source("../src/modules/feedback/FeedbackDialog.tsx"),
    source("../src/modules/dashboard/agenda-repository.ts"),
  ]);

  assert.match(route, /countConfirmedImportsForOnboarding/u);
  assert.match(route, /createDashboardOnboardingScope/u);
  assert.match(route, /visibleActivities\.length > 0/u);
  assert.match(route, /visibleAnimals\.length > 0/u);
  assert.match(route, /confirmedImportCount > 0/u);
  assert.match(route, /state\.status === "completed"/u);
  assert.match(agendaRepository, /getImportCenterDashboard/u);
  assert.match(agendaRepository, /dashboard\.totals\.confirmedCount/u);
  assert.match(agendaRepository, /createOnboardingScope/u);
  assert.match(dashboard, /!isDemo && canManageAgenda/u);
  assert.match(dashboard, /<OnboardingChecklist/u);

  assert.match(checklist, /Migrar Cooprinsem/u);
  assert.match(checklist, /Importar una planilla/u);
  assert.match(checklist, /Empezar manualmente/u);
  assert.match(checklist, /Retomar configuración/u);
  assert.match(checklist, /Cerrar guía de inicio por ahora/u);
  assert.match(checklist, /Explorar demo/u);
  assert.match(checklist, /Fundo El Ejemplo/u);
  assert.match(checklist, /FeedbackDialog variant="onboarding"/u);
  assert.match(checklist, /loadOnboardingState/u);
  assert.match(checklist, /reconcileOnboardingState/u);
  assert.doesNotMatch(checklist, /\/api\/onboarding|fetch\(/u);
  assert.match(feedback, /Pedir ayuda/u);
});

test("the spreadsheet entry opens the requested safe profile and preserves its field", async () => {
  const [route, page, checklist] = await Promise.all([
    source("../app/(producto)/importaciones/page.tsx"),
    source("../src/modules/importaciones/ImportacionesPage.tsx"),
    source("../src/modules/onboarding/OnboardingChecklist.tsx"),
  ]);
  assert.match(route, /profile\?: string \| string\[\]/u);
  assert.match(route, /IMPORT_PROFILE_KEYS\.includes/u);
  assert.match(route, /initialProfileKey=\{initialProfileKey\}/u);
  assert.match(page, /useState<ImportProfileKey>\(initialProfileKey\)/u);
  assert.match(checklist, /fieldId=\$\{encodeURIComponent\(facts\.firstFieldId\)\}&profile=generic\.pasture_measurements\.table\.v1/u);
});

class MemoryStorage {
  #items = new Map();

  getItem(key) {
    return this.#items.get(key) ?? null;
  }

  removeItem(key) {
    this.#items.delete(key);
  }

  setItem(key, value) {
    this.#items.set(key, String(value));
  }
}
