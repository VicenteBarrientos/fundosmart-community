export const WORK_VISIT_KINDS = ["veterinary", "agronomic"] as const;
export type WorkVisitKind = (typeof WORK_VISIT_KINDS)[number];

export const WORK_VISIT_STATUSES = ["planned", "in_progress", "completed", "cancelled"] as const;
export type WorkVisitStatus = (typeof WORK_VISIT_STATUSES)[number];

export const VISIT_ITEM_TARGET_KINDS = ["animal", "paddock"] as const;
export type VisitItemTargetKind = (typeof VISIT_ITEM_TARGET_KINDS)[number];

export const VISIT_ITEM_STATUSES = ["pending", "completed", "skipped"] as const;
export type VisitItemStatus = (typeof VISIT_ITEM_STATUSES)[number];

export type VisitItemInput = {
  targetKind: VisitItemTargetKind;
  targetId: string;
  targetLabel: string;
  lotName?: string | null;
  reason: string;
  supportMetric?: string | null;
};

export type VisitItemOutcomeInput = {
  itemId: string;
  status: VisitItemStatus;
  observation?: string | null;
  outcomeValue?: string | number | null;
};

export type VisitItem = {
  id: string;
  visitId: string;
  targetKind: VisitItemTargetKind;
  targetId: string;
  targetLabel: string;
  lotName: string | null;
  reason: string;
  supportMetric: string | null;
  status: VisitItemStatus;
  observation: string | null;
  outcomeValue: string | number | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkVisit = {
  id: string;
  fieldId: string;
  organizationId: string;
  visitKind: WorkVisitKind;
  visitDate: string;
  professionalName: string;
  title: string;
  notes: string | null;
  status: WorkVisitStatus;
  items: VisitItem[];
  version: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type CreateWorkVisitInput = {
  fieldId: string;
  organizationId: string;
  visitKind: WorkVisitKind;
  visitDate: string;
  professionalName: string;
  title: string;
  notes?: string | null;
  items: VisitItemInput[];
};

export type CloseWorkVisitInput = {
  visitId: string;
  expectedVersion: number;
  outcomes: VisitItemOutcomeInput[];
  notes?: string | null;
};

export type CloseWorkVisitResult = {
  visit: WorkVisit;
  reused: boolean;
  committedOriginCount: number;
  originDetails: Array<{
    itemId: string;
    targetKind: VisitItemTargetKind;
    targetId: string;
    originEntity: string;
    originId: string;
  }>;
};
