import type { LivestockWeighing } from "@/src/core/domain/types";

const DAY_MS = 86_400_000;

export type AccumulatedWeightGain = {
  days: number;
  deltaKg: number;
  dailyGainKg: number;
};

export function accumulatedWeightGain(weighings: Pick<LivestockWeighing, "recordedAt" | "weightKg">[]): AccumulatedWeightGain | null {
  if (weighings.length < 2) return null;
  const ordered = [...weighings].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const days = isoDayNumber(last.recordedAt) - isoDayNumber(first.recordedAt);
  if (days <= 0) return null;
  const deltaKg = last.weightKg - first.weightKg;
  return { days, deltaKg, dailyGainKg: deltaKg / days };
}

export type RecentWeighing = {
  recordedAt: string;
  weightKg: number;
  /** Kilos por día contra el pesaje inmediatamente anterior del animal. */
  dailyGainKg: number | null;
};

/**
 * Los últimos pesajes de un animal, del más nuevo al más viejo.
 *
 * La ganancia se calcula contra el pesaje anterior **de toda la historia**, no del recorte:
 * si se muestran tres y hay cuatro, el tercero igual se compara con el cuarto. Recortar
 * primero haría aparecer un "sin dato" que solo existe porque la pantalla es chica.
 */
export function recentWeighings(
  weighings: Pick<LivestockWeighing, "recordedAt" | "weightKg">[],
  limit = 3,
): RecentWeighing[] {
  const ordered = [...weighings].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
  const withGain = ordered.map((weighing, index) => {
    const previous = index > 0 ? ordered[index - 1] : null;
    const days = previous ? isoDayNumber(weighing.recordedAt) - isoDayNumber(previous.recordedAt) : 0;
    return {
      recordedAt: weighing.recordedAt,
      weightKg: weighing.weightKg,
      dailyGainKg: previous && days > 0 ? (weighing.weightKg - previous.weightKg) / days : null,
    };
  });
  return withGain.slice(-limit).reverse();
}

export function totalKgGained(weighings: LivestockWeighing[], animalIds?: Set<string>): number {
  const byAnimal = new Map<string, LivestockWeighing[]>();
  for (const weighing of weighings) {
    if (animalIds && !animalIds.has(weighing.animalId)) continue;
    const history = byAnimal.get(weighing.animalId) ?? [];
    history.push(weighing);
    byAnimal.set(weighing.animalId, history);
  }
  let total = 0;
  for (const history of byAnimal.values()) {
    total += accumulatedWeightGain(history)?.deltaKg ?? 0;
  }
  return total;
}

export type PartnerBalanceInput = {
  id: string;
  name: string;
  contributionsClp: number;
  paidExpensesClp: number;
};

export type PartnerBalance = PartnerBalanceInput & {
  totalProvidedClp: number;
  participation: number;
  quotaClp: number;
  balanceClp: number;
};

export function calculatePartnerBalances(partners: PartnerBalanceInput[]): PartnerBalance[] {
  const totalContributions = partners.reduce((sum, partner) => sum + partner.contributionsClp, 0);
  const totalPartnerPaidExpenses = partners.reduce((sum, partner) => sum + partner.paidExpensesClp, 0);
  return partners.map((partner) => {
    const participation = totalContributions > 0
      ? partner.contributionsClp / totalContributions
      : partners.length > 0
        ? 1 / partners.length
        : 0;
    const totalProvidedClp = partner.contributionsClp + partner.paidExpensesClp;
    const quotaClp = Math.round(totalPartnerPaidExpenses * participation);
    return {
      ...partner,
      totalProvidedClp,
      participation,
      quotaClp,
      balanceClp: partner.paidExpensesClp - quotaClp,
    };
  });
}

export function suggestedTransfers(balances: PartnerBalance[]): { debtor: string; creditor: string; amountClp: number }[] {
  const debtors = balances
    .filter((balance) => balance.balanceClp < 0)
    .map((balance) => ({ name: balance.name, amountClp: -balance.balanceClp }))
    .sort((a, b) => b.amountClp - a.amountClp);
  const creditors = balances
    .filter((balance) => balance.balanceClp > 0)
    .map((balance) => ({ name: balance.name, amountClp: balance.balanceClp }))
    .sort((a, b) => b.amountClp - a.amountClp);
  const result: { debtor: string; creditor: string; amountClp: number }[] = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const amountClp = Math.min(debtors[debtorIndex].amountClp, creditors[creditorIndex].amountClp);
    if (amountClp > 0) {
      result.push({
        debtor: debtors[debtorIndex].name,
        creditor: creditors[creditorIndex].name,
        amountClp,
      });
    }
    debtors[debtorIndex].amountClp -= amountClp;
    creditors[creditorIndex].amountClp -= amountClp;
    if (debtors[debtorIndex].amountClp === 0) debtorIndex += 1;
    if (creditors[creditorIndex].amountClp === 0) creditorIndex += 1;
  }
  return result;
}

function isoDayNumber(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / DAY_MS);
}
