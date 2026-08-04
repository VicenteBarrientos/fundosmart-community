import type { BirthInput, HealthEventInput, MilkControlInput, RenumberInput, ReproductiveEventInput } from "../domain/types";

export class AnimalRecordRuleError extends Error {
  code: string;
  constructor(message: string, code?: string);
}

export function normalizeMilkControlInput(input: unknown): MilkControlInput & { totalLiters: number };
export function normalizeReproductiveEventInput(input: unknown): ReproductiveEventInput;
export function normalizeBirthInput(input: unknown): BirthInput;
export function normalizeHealthEventInput(input: unknown): HealthEventInput;
export function normalizeAnimalTag(value: unknown): string;
export function normalizeRenumberInput(
  input: unknown,
  today?: string,
): RenumberInput & { normalizedNewTag: string };
