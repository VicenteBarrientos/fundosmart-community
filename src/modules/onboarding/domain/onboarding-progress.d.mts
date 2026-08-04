export const ONBOARDING_STORAGE_VERSION: 1;
export const ONBOARDING_PATHS: readonly ["cooprinsem", "spreadsheet", "manual"];

export type OnboardingPath = (typeof ONBOARDING_PATHS)[number];
export type OnboardingStatus = "active" | "dismissed" | "completed";
export type OnboardingFacts = {
  fieldCount: number;
  paddockCount: number;
  hasFirstAction: boolean;
};
export type OnboardingState = {
  version: 1;
  status: OnboardingStatus;
  path: OnboardingPath | null;
  startedAt: string;
  lastSeenAt: string;
  pathSelectedAt: string | null;
  pathUpdatedAt: string | null;
  firstFieldCompletedAt: string | null;
  firstPaddockCompletedAt: string | null;
  firstActionCompletedAt: string | null;
  dismissedAt: string | null;
  resumedAt: string | null;
  completedAt: string | null;
};
export type OnboardingStep = {
  id: "path" | "field" | "paddock" | "action";
  label: string;
  detail: string;
  completed: boolean;
};
export type OnboardingStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function createOnboardingScope(
  organizationId: string,
  membershipId: string,
): Promise<string>;
export function createOnboardingStorageKey(scope: string): string;
export function createEmptyOnboardingState(now?: string): OnboardingState;
export function loadOnboardingState(
  storage: OnboardingStorage | null,
  scope: string,
  now?: string,
): OnboardingState;
export function saveOnboardingState(
  storage: OnboardingStorage | null,
  scope: string,
  state: OnboardingState,
): boolean;
export function reconcileOnboardingState(
  state: OnboardingState,
  facts: OnboardingFacts,
  now?: string,
): OnboardingState;
export function selectOnboardingPath(
  state: OnboardingState,
  path: OnboardingPath,
  now?: string,
): OnboardingState;
export function dismissOnboarding(
  state: OnboardingState,
  now?: string,
): OnboardingState;
export function resumeOnboarding(
  state: OnboardingState,
  now?: string,
): OnboardingState;
export function buildOnboardingSteps(
  state: OnboardingState,
  facts: OnboardingFacts,
): OnboardingStep[];
export function isOnboardingActivated(facts: OnboardingFacts): boolean;
export function onboardingPathLabel(path: OnboardingPath | null): string;
