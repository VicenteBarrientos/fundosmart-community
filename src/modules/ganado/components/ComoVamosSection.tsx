"use client";

import type {
  LivestockAnimal,
  LivestockContribution,
  LivestockExpense,
  LivestockLot,
  LivestockPartner,
  LivestockWeighing,
} from "@/src/core/domain/types";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { BarChart3, Beef, CircleDollarSign, Scale, TrendingUp, Users } from "lucide-react";
import { useState } from "react";
import { Collapsible } from "@/src/ui/Collapsible";
import { formatClp, formatInteger, formatKg, formatNumber } from "../lib/format";
import { calculatePartnerBalances, totalKgGained } from "../lib/livestock-metrics";
import type { HerdOperations } from "../domain/operations";
import { Field, Panel, SmallEmpty, StatCard } from "./ui";

type ComoVamosSectionProps = {
  animals: LivestockAnimal[];
  contributions: LivestockContribution[];
  expenses: LivestockExpense[];
  lots: LivestockLot[];
  partners: LivestockPartner[];
  weighings: LivestockWeighing[];
  operations: HerdOperations;
};

export function ComoVamosSection({
  animals,
  contributions,
  expenses,
  lots,
  partners,
  weighings,
  operations,
}: ComoVamosSectionProps) {
  const [pricePerKg, setPricePerKg] = useState("");
  const parsedPrice = Number(pricePerKg);
  const validPrice = Number.isInteger(parsedPrice) && parsedPrice > 0 ? parsedPrice : null;

  const activeAnimals = animals.filter((animal) => animal.status === "active");
  const animalsWithWeight = activeAnimals.filter((animal) => animal.latestWeightKg !== null);
  const herdWeightKg = animalsWithWeight.reduce((sum, animal) => sum + (animal.latestWeightKg ?? 0), 0);
  const withoutWeight = activeAnimals.length - animalsWithWeight.length;
  const herdValueClp = validPrice !== null ? Math.round(herdWeightKg * validPrice) : null;

  const totalContributions = contributions.reduce((sum, contribution) => sum + contribution.amountClp, 0);
  const totalExpenses = expenses.reduce((sum, expense) => sum + expense.amountClp, 0);
  const cashBalance = totalContributions - totalExpenses;
  const projectedMargin = herdValueClp !== null ? herdValueClp - totalExpenses : null;

  const partnerShares = calculatePartnerBalances(partners.map((partner) => ({
    id: partner.id,
    name: partner.name,
    contributionsClp: contributions
      .filter((contribution) => contribution.partnerId === partner.id)
      .reduce((sum, contribution) => sum + contribution.amountClp, 0),
    paidExpensesClp: 0,
  })));

  const foodExpenses = expenses.filter((expense) => expense.category === "alimento");
  const totalFoodExpenses = foodExpenses.reduce((sum, expense) => sum + expense.amountClp, 0);
  const gainedKg = totalKgGained(weighings);
  const globalCostPerKg = gainedKg > 0 ? totalFoodExpenses / gainedKg : null;

  const costByLot = lots.map((lot) => {
    const animalIds = new Set(animals.filter((animal) => animal.lotId === lot.id).map((animal) => animal.id));
    const lotGainedKg = totalKgGained(weighings, animalIds);
    const lotFoodExpenses = foodExpenses
      .filter((expense) => expense.lotId === lot.id)
      .reduce((sum, expense) => sum + expense.amountClp, 0);
    return {
      lot,
      gainedKg: lotGainedKg,
      foodExpensesClp: lotFoodExpenses,
      costPerKg: lotGainedKg > 0 ? lotFoodExpenses / lotGainedKg : null,
    };
  });

  return (
    <div>
      <Collapsible defaultOpen helpText="Precio de referencia por kilo vivo. Cambia este número para ver cuánto valdría tu rebaño en distintos escenarios; no se guarda." icon={BarChart3} persistKey="ganado.como-vamos.supuesto" title="Supuesto de venta">
        <Panel title="Supuesto de venta" eyebrow="Valor del kilo vivo" icon={BarChart3}>
          <div className="mt-5 flex flex-wrap items-end gap-3">
          <div className="w-full max-w-xs">
            <Field label="Precio estimado CLP por kg vivo">
              <input
                className="input-base"
                inputMode="numeric"
                min="1"
                onChange={(event) => setPricePerKg(event.target.value)}
                placeholder="Ej. 1.800"
                step="1"
                type="number"
                value={pricePerKg}
              />
            </Field>
          </div>
          <p className="pb-2 text-[12px] font-semibold text-ink-subtle">
            Este supuesto no se guarda; puedes cambiarlo para comparar escenarios.
          </p>
          </div>
        </Panel>
      </Collapsible>

      <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          detail={`${formatInteger(animalsWithWeight.length)} con pesaje · ${formatInteger(withoutWeight)} sin pesaje`}
          helpText="Kilos totales de animal en pie. Los que no tienen pesaje quedan fuera, así que el total puede estar corto."
          icon={Scale}
          label="Peso vivo del rebaño"
          tone="dark"
          value={herdWeightKg > 0 ? formatKg(herdWeightKg) : "Sin pesajes"}
        />
        <StatCard
          detail={validPrice !== null ? `A ${formatClp(validPrice)} por kg vivo` : "Ingresa un precio por kilo"}
          helpText="Cuánto valdría el rebaño si lo vendieras hoy al precio por kilo que pusiste arriba. Es un supuesto, no una venta."
          icon={Beef}
          label="Valor estimado"
          value={herdValueClp !== null ? formatClp(herdValueClp) : "—"}
        />
        <StatCard
          detail={`Caja de la organización ${formatClp(cashBalance)}`}
          helpText="Todo lo gastado en este rebaño hasta hoy: compra de animales, alimento, veterinario y servicios."
          icon={CircleDollarSign}
          label="Costo acumulado"
          value={formatClp(totalExpenses)}
        />
        <StatCard
          detail="Valor del rebaño menos costos, sin contar dos veces los aportes"
          helpText="Lo que ganarías o perderías si vendieras hoy: valor estimado del rebaño menos todo lo gastado."
          icon={TrendingUp}
          label="Resultado proyectado"
          tone="amber"
          value={projectedMargin !== null ? formatClp(projectedMargin) : "—"}
        />
      </section>

      <section className="mt-5 grid gap-3 sm:grid-cols-3">
        <StatCard detail={`${operations.workItems.length} acciones en agenda`} helpText="Tareas de la agenda que están atrasadas o vencen hoy." icon={BarChart3} label="Tareas urgentes" tone="amber" value={String(operations.workItems.filter((item) => item.priority === "overdue" || item.priority === "today").length)} />
        <StatCard detail={`${operations.kpis.confirmedPregnancies} de ${operations.kpis.servedFemales} servidas`} help="analiticaTasaPrenez" icon={Beef} label="Tasa de preñez" value={operations.kpis.pregnancyRatePct === null ? "Sin base" : `${formatNumber(operations.kpis.pregnancyRatePct, 1)}%`} />
        <StatCard detail="Precio real menos compra y gastos prorrateados" helpText="Lo que dejaron los animales ya vendidos: precio real de venta menos lo que costó comprarlos y criarlos." icon={TrendingUp} label="Margen vendido estimado" value={formatClp(operations.lotMargins.reduce((sum, lot) => sum + lot.marginClp, 0))} />
      </section>

      <section className="mt-5 grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <Panel title="Reparto por socio" eyebrow="Según aportes de capital" helpText="Cuánto le tocaría a cada socio del resultado, en proporción a lo que aportó." icon={Users}>
          {partnerShares.length > 0 ? (
            <TableExplorer
              className="mt-5"
              defaultOpen={false}
              description="Aportes, participación y resultado proyectado para cada socio."
              filter={{ label: "Socio", allLabel: "Todos los socios", columnIndex: 0 }}
              id="ganado.como-vamos.reparto"
              searchPlaceholder="Buscar socio..."
              title="Reparto por socio"
            >
              <table className="w-full min-w-[520px] text-left">
                <thead>
                  <tr>
                    {["Socio", "Aportes", "Participación", "Resultado que le toca"].map((header) => (
                      <th className="border-b border-line-steel pb-2 pr-3 text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle" key={header}>{header}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {partnerShares.map((partner) => (
                    <tr key={partner.id}>
                      <td className="border-b border-line-steel py-3 pr-3 text-xs font-black text-ink">{partner.name}</td>
                      <td className="border-b border-line-steel py-3 pr-3 text-right text-xs font-bold text-ink">{formatClp(partner.contributionsClp)}</td>
                      <td className="border-b border-line-steel py-3 pr-3 text-right text-xs text-ink-muted">{formatNumber(partner.participation * 100, 1)}%</td>
                      <td className="border-b border-line-steel py-3 text-right text-xs font-black text-ink">
                        {projectedMargin !== null ? formatClp(Math.round(projectedMargin * partner.participation)) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableExplorer>
          ) : (
            <SmallEmpty text="Registra socios y aportes en Plata para calcular el reparto." />
          )}
        </Panel>

        <Collapsible help="costoPorKilo" icon={TrendingUp} persistKey="ganado.como-vamos.costo-kilo" title="Costo por kilo producido">
          <Panel title="Costo por kilo producido" eyebrow="Alimento dividido por kilos ganados" icon={TrendingUp}>
          <div className="mt-5 rounded-2xl bg-ink p-4 text-white">
            <p className="text-[12px] font-black uppercase tracking-[0.12em] text-white/55">Costo global</p>
            <p className="mt-1 text-2xl font-black text-white">
              {globalCostPerKg !== null ? `${formatClp(Math.round(globalCostPerKg))}/kg` : "Sin base comparable"}
            </p>
            <p className="mt-1 text-[12px] font-semibold text-white/55">
              Alimento {formatClp(totalFoodExpenses)} ÷ {formatNumber(gainedKg, 1)} kg ganados
            </p>
          </div>

          <div className="mt-4 space-y-2">
            {costByLot.map((item) => (
              <div className="flex items-center gap-3 rounded-2xl border border-line-steel bg-surface-alt px-4 py-3" key={item.lot.id}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-black text-ink">{item.lot.name}</p>
                  <p className="mt-0.5 text-[12px] font-semibold text-ink-subtle">
                    Alimento asignado {formatClp(item.foodExpensesClp)} · {formatNumber(item.gainedKg, 1)} kg ganados
                  </p>
                </div>
                <p className="text-xs font-black text-ink">
                  {item.costPerKg !== null ? `${formatClp(Math.round(item.costPerKg))}/kg` : "—"}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px] font-semibold leading-4 text-ink-subtle">
            Los egresos de alimento sin lote entran solo al costo global. Se necesitan al menos dos pesajes en días distintos por animal para medir kilos ganados.
          </p>
          </Panel>
        </Collapsible>
      </section>
    </div>
  );
}
