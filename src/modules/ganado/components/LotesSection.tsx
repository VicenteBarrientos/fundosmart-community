"use client";

import {
  LIVESTOCK_CATEGORY_LABELS,
  LIVESTOCK_STATUS_LABELS,
  type Fundo,
  type LivestockCategory,
  type LivestockLot,
  type LivestockStatus,
  type Potrero,
} from "@/src/core/domain/types";
import { Beef, CalendarDays, Filter, Layers3, MapPinned, Pencil, Plus, Weight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatDate, formatInteger, formatKg, formatNumber } from "../lib/format";
import { ManageLivestockLotDialog } from "./ManageLivestockLotDialog";
import { FilterSelect, MiniStat, Panel, SmallEmpty, StatCard } from "./ui";

type LotesSectionProps = {
  fundos: Fundo[];
  potreros: Potrero[];
  lots: LivestockLot[];
  onSave: (lot: LivestockLot) => Promise<void>;
  onDelete: (id: string, updatedAt: string) => Promise<void>;
};

const ALL = "all";

export function LotesSection({ fundos, potreros, lots, onSave, onDelete }: LotesSectionProps) {
  const [selectedFundoId, setSelectedFundoId] = useState(ALL);
  const [selectedCategory, setSelectedCategory] = useState<LivestockCategory | typeof ALL>(ALL);
  const [selectedStatus, setSelectedStatus] = useState<LivestockStatus | typeof ALL>("active");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managedLot, setManagedLot] = useState<LivestockLot | null>(null);

  const fundoById = useMemo(() => new Map(fundos.map((fundo) => [fundo.id, fundo])), [fundos]);
  const potreroById = useMemo(() => new Map(potreros.map((potrero) => [potrero.id, potrero])), [potreros]);
  const scopedLots = useMemo(() => lots.filter((lot) =>
    (selectedFundoId === ALL || lot.fieldId === selectedFundoId)
    && (selectedCategory === ALL || lot.category === selectedCategory),
  ), [lots, selectedCategory, selectedFundoId]);
  const visibleLots = useMemo(
    () => scopedLots.filter((lot) => selectedStatus === ALL || lot.status === selectedStatus),
    [scopedLots, selectedStatus],
  );
  const activeLots = useMemo(() => scopedLots.filter((lot) => lot.status === "active"), [scopedLots]);
  const totalAnimals = activeLots.reduce((sum, lot) => sum + lot.animalCount, 0);
  const totalLiveWeightKg = activeLots.reduce((sum, lot) => sum + lot.animalCount * (lot.averageWeightKg ?? 0), 0);
  const lotsWithWeight = activeLots.filter((lot) => lot.averageWeightKg !== null).length;
  const assignedLots = activeLots.filter((lot) => lot.paddockId !== null).length;
  const unassignedAnimals = activeLots.filter((lot) => lot.paddockId === null).reduce((sum, lot) => sum + lot.animalCount, 0);

  const categoryBreakdown = (Object.keys(LIVESTOCK_CATEGORY_LABELS) as LivestockCategory[])
    .map((category) => ({
      category,
      label: LIVESTOCK_CATEGORY_LABELS[category],
      count: activeLots.filter((lot) => lot.category === category).reduce((sum, lot) => sum + lot.animalCount, 0),
    }))
    .filter((item) => item.count > 0)
    .sort((a, b) => b.count - a.count);

  const locationBreakdown = useMemo(() => {
    const groups = new Map<string, { label: string; fundo: string; animals: number; lots: number }>();
    for (const lot of activeLots) {
      const key = lot.paddockId ?? `unassigned:${lot.fieldId}`;
      const potrero = lot.paddockId ? potreroById.get(lot.paddockId) : null;
      const current = groups.get(key) ?? {
        label: potrero?.name ?? "Sin potrero asignado",
        fundo: fundoById.get(lot.fieldId)?.name ?? "Fundo",
        animals: 0,
        lots: 0,
      };
      current.animals += lot.animalCount;
      current.lots += 1;
      groups.set(key, current);
    }
    return [...groups.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.animals - a.animals);
  }, [activeLots, fundoById, potreroById]);

  function openNewLot() {
    setManagedLot(null);
    setDialogOpen(true);
  }

  function openLot(lot: LivestockLot) {
    setManagedLot(lot);
    setDialogOpen(true);
  }

  return (
    <div>
      <section className="rounded-[20px] border border-line-steel bg-white p-4 shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.14em] text-accent"><Filter size={14} /> Filtros</span>
          <button className="ml-auto flex h-10 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white shadow-lg shadow-ink/10" onClick={openNewLot} type="button">
            <Plus size={15} /> Nuevo lote ganadero
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <FilterSelect label="Fundo" onChange={setSelectedFundoId} value={selectedFundoId}>
            <option value={ALL}>Todos los fundos</option>
            {fundos.map((fundo) => <option key={fundo.id} value={fundo.id}>{fundo.name}</option>)}
          </FilterSelect>
          <FilterSelect label="Categoría" onChange={(value) => setSelectedCategory(value as LivestockCategory | typeof ALL)} value={selectedCategory}>
            <option value={ALL}>Todas las categorías</option>
            {(Object.keys(LIVESTOCK_CATEGORY_LABELS) as LivestockCategory[]).map((category) => <option key={category} value={category}>{LIVESTOCK_CATEGORY_LABELS[category]}</option>)}
          </FilterSelect>
          <FilterSelect label="Estado" onChange={(value) => setSelectedStatus(value as LivestockStatus | typeof ALL)} value={selectedStatus}>
            <option value={ALL}>Todos los estados</option>
            {(Object.keys(LIVESTOCK_STATUS_LABELS) as LivestockStatus[]).map((status) => <option key={status} value={status}>{LIVESTOCK_STATUS_LABELS[status]}</option>)}
          </FilterSelect>
        </div>
      </section>

      <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard helpText="Total de animales repartidos en los lotes activos. Es la carga real que hoy come pasto en el campo." icon={Beef} label="Cabezas activas" tone="dark" value={formatInteger(totalAnimals)} detail={`${activeLots.length} ${activeLots.length === 1 ? "lote activo" : "lotes activos"}`} />
        <StatCard helpText="Suma del peso de todos los animales. Determina cuánto pasto se consume por día y cuánto vale el inventario." icon={Weight} label="Peso vivo estimado" value={totalLiveWeightKg > 0 ? `${formatNumber(totalLiveWeightKg / 1000, 1)} ton` : "Sin datos"} detail={`${lotsWithWeight} ${lotsWithWeight === 1 ? "lote con peso" : "lotes con peso"}`} />
        <StatCard helpText="Lotes que ya tienen asignado un potrero en el mapa. Sin potrero asignado no se les puede planificar la rotación." icon={MapPinned} label="Lotes en potrero" value={String(assignedLots)} detail={`${activeLots.length - assignedLots} sin asignar`} />
        <StatCard helpText="Animales que no están ubicados en ningún potrero del mapa. No entran en los cálculos de oferta de pasto." icon={Layers3} label="Cabezas sin potrero" tone="amber" value={formatInteger(unassignedAnimals)} detail="Pendientes de ubicación" />
      </section>

      <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <Panel title="Composición del ganado" eyebrow="Categorías" helpText="Cómo se reparte el rebaño entre vacas, vaquillas, terneros y novillos. La mezcla define qué puede producir el campo." icon={Beef}>
          {categoryBreakdown.length > 0 ? (
            <div className="mt-5 space-y-4">
              {categoryBreakdown.map((item) => {
                const share = totalAnimals > 0 ? (item.count / totalAnimals) * 100 : 0;
                return (
                  <div key={item.category}>
                    <div className="flex items-center justify-between gap-3"><p className="text-xs font-black text-ink">{item.label}</p><p className="text-xs font-black text-ink">{formatInteger(item.count)}</p></div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-alt"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(2, share)}%` }} /></div>
                  </div>
                );
              })}
            </div>
          ) : <SmallEmpty text="Aún no hay animales activos en esta selección." />}
        </Panel>

        <Panel title="Distribución actual" eyebrow="Fundos y potreros" helpText="Dónde está parado cada lote hoy, para ver si hay potreros sobrecargados o vacíos." icon={MapPinned}>
          {locationBreakdown.length > 0 ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {locationBreakdown.map((location) => (
                <div className={`rounded-2xl border p-4 ${location.key.startsWith("unassigned:") ? "border-amber-200 bg-amber-50/60" : "border-line-steel bg-surface-alt"}`} key={location.key}>
                  <div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="truncate text-xs font-black text-ink">{location.label}</p><p className="mt-1 truncate text-[12px] font-bold uppercase tracking-wide text-ink-subtle">{location.fundo}</p></div><span className="text-xl font-black text-ink">{formatInteger(location.animals)}</span></div>
                  <p className="mt-3 text-[12px] font-bold text-ink-subtle">{location.lots} {location.lots === 1 ? "lote" : "lotes"}</p>
                </div>
              ))}
            </div>
          ) : <SmallEmpty text="La distribución aparecerá al crear lotes activos." />}
        </Panel>
      </section>

      <section className="mt-5">
        <Panel title="Lotes registrados" eyebrow="Inventario" help="ganadoLotes" icon={Layers3}>
          {visibleLots.length > 0 ? (
            <div className="mt-5 grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
              {visibleLots.map((lot) => {
                const fundo = fundoById.get(lot.fieldId);
                const potrero = lot.paddockId ? potreroById.get(lot.paddockId) : null;
                return (
                  <article className="rounded-[18px] border border-line-steel bg-surface-alt p-4 transition hover:border-line-strong hover:bg-white" key={lot.id}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0"><StatusBadge status={lot.status} /><h3 className="mt-2 truncate text-base font-black tracking-[-0.035em] text-ink">{lot.name}</h3><p className="mt-1 text-[12px] font-bold text-accent">{LIVESTOCK_CATEGORY_LABELS[lot.category]}</p></div>
                      <button aria-label={`Editar ${lot.name}`} className="grid size-9 shrink-0 place-items-center rounded-xl border border-line-steel bg-white text-ink-muted" onClick={() => openLot(lot)} type="button"><Pencil size={15} /></button>
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <MiniStat label="Animales" value={formatInteger(lot.animalCount)} />
                      <MiniStat label="Peso promedio" value={lot.averageWeightKg ? formatKg(lot.averageWeightKg) : "Sin dato"} />
                    </div>
                    <div className="mt-4 border-t border-line-steel pt-3">
                      <p className="flex items-center gap-2 text-[12px] font-black text-ink-muted"><MapPinned className="text-accent" size={13} /> {potrero?.name ?? "Sin potrero asignado"}</p>
                      <p className="mt-1.5 pl-5 text-[12px] font-bold text-ink-subtle">{fundo?.name ?? "Fundo"}</p>
                      <p className="mt-2 flex items-center gap-2 text-[12px] text-ink-subtle"><CalendarDays size={12} /> Ingreso {formatDate(lot.entryDate)}</p>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="mt-5 grid min-h-64 place-items-center rounded-2xl border border-dashed border-line-steel bg-surface-alt p-6 text-center"><div><span className="mx-auto grid size-12 place-items-center rounded-2xl bg-band text-accent"><Beef size={23} /></span><p className="mt-3 text-sm font-black text-ink">No hay lotes ganaderos en esta selección.</p><p className="mt-1 text-[12px] text-ink-subtle">Comienza ingresando la cantidad de animales y su ubicación actual.</p><button className="mt-4 inline-flex h-10 items-center gap-2 rounded-xl bg-accent px-4 text-[12px] font-black text-white" onClick={openNewLot} type="button"><Plus size={14} /> Crear primer lote</button></div></div>
          )}
        </Panel>
      </section>

      {dialogOpen && (
        <ManageLivestockLotDialog
          fundos={fundos}
          key={managedLot?.id ?? "new-livestock-lot"}
          lot={managedLot}
          onClose={() => setDialogOpen(false)}
          onDelete={onDelete}
          onSave={onSave}
          potreros={potreros}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: LivestockStatus }) {
  const classes = { active: "bg-band text-accent", sold: "bg-blue-50 text-blue-700", departed: "bg-surface-alt text-ink-muted" };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black uppercase tracking-wide ${classes[status]}`}>{LIVESTOCK_STATUS_LABELS[status]}</span>;
}
