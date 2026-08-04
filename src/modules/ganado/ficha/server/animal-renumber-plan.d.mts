export type AnimalRenumberPlanInput = {
  animalId: string;
  fieldId: string;
  organizationId: string;
  fieldIds: string[];
  previousTag: string;
  previousNormalizedTag: string;
  newTag: string;
  newNormalizedTag: string;
  effectiveOn: string;
  reason: string | null;
  actor: string;
  now: string;
  historyIdentifierId: string;
  activeIdentifierId: string;
  auditId: string;
};

export type AnimalRenumberStatementLabel =
  | "close_active_identifier"
  | "backfill_previous_identifier"
  | "open_active_identifier"
  | "move_animal_tag"
  | "audit"
  | "assert_final_state";

export type AnimalRenumberStatement = {
  label: AnimalRenumberStatementLabel;
  expected: "one" | "zeroOrOne" | "assertion";
  sql: string;
  bindings: Array<string | number | null>;
};

export function buildAnimalRenumberPlan(input: AnimalRenumberPlanInput): AnimalRenumberStatement[];

export function assertRenumberPlanApplied(
  results: Array<{ label: AnimalRenumberStatementLabel; changes: number }>,
): boolean;
