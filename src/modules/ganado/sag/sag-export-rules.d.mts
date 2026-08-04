export type SagValidationIssue = {
  severity: "error";
  code: string;
  field: string;
  message: string;
};

export type SagProfile = {
  fieldId: string;
  rup: string;
  holderRut: string;
  holderName: string;
  commune: string;
  address: string;
};

export type SagInventoryEntry = {
  id?: string;
  fieldId?: string;
  speciesCode: string;
  categoryCode: string;
  quantity?: number;
  trackingMode?: "individual" | "summary";
  status?: string;
};

export type SagFmaAnimal = {
  id: string;
  fieldId?: string;
  diio: string;
  speciesCode: string;
  categoryCode: string;
  status?: string;
};

export type SagWithdrawal = {
  animalId: string;
  status?: string;
  withdrawalMilkUntil?: string | null;
  withdrawalMeatUntil?: string | null;
};

export type SagMovement = {
  id: string;
  destinationRup: string;
  destinationCommune: string;
  destinationAddress: string;
  departureDate: string;
  departureTime: string;
  arrivalDate: string;
  arrivalTime: string;
  carrierName: string;
  carrierRut: string;
  vehiclePlate: string;
  trailerPlate?: string | null;
  referenceFolio?: string | null;
  observations?: string;
  declarations: {
    noQuarantine: boolean;
    noSymptoms: boolean;
    noActiveWithdrawal: boolean;
  };
};

export type SagValidation = {
  valid: boolean;
  errors: SagValidationIssue[];
  warnings: SagValidationIssue[];
};

export const SAG_DRAFT_LABEL: "BORRADOR DECLARABLE SAG - NO DECLARADO";
export const SAG_DRAFT_STATUS: "draft_not_declared";
export const SAG_DEA_FORM_VERSION: "2025-03-05";
export const SAG_FMA_FORM_VERSION: "2024-08-08";
export const SAG_MAX_FMA_DIIO: 45;
export const SAG_DEA_CATEGORIES: Readonly<Record<string, Readonly<Record<string, string>>>>;
export const SAG_SPECIES_LABELS: Readonly<Record<string, string>>;

export function normalizeDiio(value: unknown): string;
export function isValidDiio(value: unknown): boolean;
export function normalizeRut(value: unknown): string;
export function isValidChileanRut(value: unknown): boolean;
export function normalizeRup(value: unknown): string;
export function validateSagProfile(profile: Partial<SagProfile> | null | undefined): SagValidationIssue[];

export function buildDeaDraft(input: {
  profile: SagProfile;
  asOfDate: string;
  inventoryEntries: SagInventoryEntry[];
  generatedAt?: string | null;
  formVersion?: string;
}): { validation: SagValidation; draft: Record<string, unknown> | null };

export function buildFmaDrafts(input: {
  profile: SagProfile;
  movement: SagMovement;
  animals: SagFmaAnimal[];
  withdrawals?: SagWithdrawal[];
  generatedAt?: string | null;
  formVersion?: string;
}): { validation: SagValidation; drafts: Array<Record<string, unknown>> };

export function deaDraftToCsv(draft: Record<string, unknown>): string;
export function fmaDraftToCsv(draft: Record<string, unknown>): string;
export function fmaDraftsToCsv(drafts: Array<Record<string, unknown>>): string;
