"use client";

import {
  LIVESTOCK_ANIMAL_STATUS_LABELS,
  LIVESTOCK_SEX_LABELS,
  type LivestockAnimal,
  type LivestockAnimalStatus,
  type LivestockLot,
  type LivestockWeighing,
} from "@/src/core/domain/types";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { Beef, CircleDollarSign, Filter, HeartPulse, Plus, Search, Sheet, Tag, Weight } from "lucide-react";
import { useMemo, useState } from "react";
import { formatClp, formatDate, formatInteger, formatKg } from "../lib/format";
import { accumulatedWeightGain, recentWeighings } from "../lib/livestock-metrics";
import { AnimalesSpreadsheet, type AnimalSpreadsheetCommit } from "./AnimalesSpreadsheet";
import { ManageLivestockAnimalDialog } from "./ManageLivestockAnimalDialog";
import { FilterSelect, Panel, SmallEmpty, StatCard } from "./ui";

type AnimalesSectionProps = {
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  weighings: LivestockWeighing[];
  onSave: (animal: LivestockAnimal) => Promise<void>;
  onSaveSpreadsheet: AnimalSpreadsheetCommit;
  onDelete: (id: string, snapshotToken: string) => Promise<void>;
};

const ALL = "all";

export function AnimalesSection({ animals, lots, weighings, onSave, onSaveSpreadsheet, onDelete }: AnimalesSectionProps) {
  const [selectedLotId, setSelectedLotId] = useState(ALL);
  const [selectedStatus, setSelectedStatus] = useState<LivestockAnimalStatus | typeof ALL>(ALL);
  const [search, setSearch] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [managedAnimal, setManagedAnimal] = useState<LivestockAnimal | null>(null);
  const [spreadsheetOpen, setSpreadsheetOpen] = useState(false);

  const lotById = useMemo(() => new Map(lots.map((lot) => [lot.id, lot])), [lots]);
  const weighingsByAnimal = useMemo(() => {
    const grouped = new Map<string, LivestockWeighing[]>();
    for (const weighing of weighings) {
      const history = grouped.get(weighing.animalId) ?? [];
      history.push(weighing);
      grouped.set(weighing.animalId, history);
    }
    return grouped;
  }, [weighings]);

  const visibleAnimals = useMemo(() => {
    const term = search.trim().toLowerCase();
    return animals.filter((animal) =>
      (selectedLotId === ALL || animal.lotId === selectedLotId)
      && (selectedStatus === ALL || animal.status === selectedStatus)
      && (!term
        || animal.tag.toLowerCase().includes(term)
        || (animal.origin ?? "").toLowerCase().includes(term)),
    );
  }, [animals, search, selectedLotId, selectedStatus]);

  // Una fila nueva nace en el lote que el filtro tiene puesto; si no hay uno, en el único
  // lote individual que exista. Con varios, la celda de lote queda vacía y hay que elegir.
  const defaultSpreadsheetLotId = useMemo(() => {
    const individualLots = lots.filter((lot) => lot.trackingMode === "individual");
    if (selectedLotId !== ALL && individualLots.some((lot) => lot.id === selectedLotId)) return selectedLotId;
    return individualLots.length === 1 ? individualLots[0].id : "";
  }, [lots, selectedLotId]);

  // La planilla edita exactamente lo que muestran los filtros: lo que se ve es lo que se edita.
  const scopeLabel = useMemo(() => {
    const count = `${visibleAnimals.length} ${visibleAnimals.length === 1 ? "animal" : "animales"}`;
    const parts = [
      selectedLotId === ALL ? null : lotById.get(selectedLotId)?.name ?? null,
      selectedStatus === ALL ? null : LIVESTOCK_ANIMAL_STATUS_LABELS[selectedStatus].toLowerCase(),
      search.trim() ? `búsqueda "${search.trim()}"` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `${count} · ${parts.join(" · ")}` : `${count} (todos)`;
  }, [lotById, search, selectedLotId, selectedStatus, visibleAnimals.length]);

  const activeCount = animals.filter((animal) => animal.status === "active").length;
  const deadCount = animals.filter((animal) => animal.status === "dead").length;
  const soldCount = animals.filter((animal) => animal.status === "sold").length;
  const weighedCount = animals.filter((animal) => animal.latestWeightKg !== null).length;
  const purchaseTotal = animals.reduce((sum, animal) => sum + (animal.purchasePriceClp ?? 0), 0);
  const hasIndividualLot = lots.some((lot) => lot.trackingMode === "individual");

  function openNewAnimal() {
    setManagedAnimal(null);
    setDialogOpen(true);
  }

  function openAnimal(animal: LivestockAnimal) {
    setManagedAnimal(animal);
    setDialogOpen(true);
  }

  return (
    <div>
      <section className="rounded-[20px] border border-line-steel bg-white p-4 shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.14em] text-accent"><Filter size={14} /> Filtros</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              className="flex h-10 items-center justify-center gap-2 rounded-xl border border-line-steel px-4 text-xs font-black text-ink disabled:cursor-not-allowed disabled:opacity-50"
              disabled={spreadsheetOpen || visibleAnimals.length === 0}
              onClick={() => setSpreadsheetOpen(true)}
              title={visibleAnimals.length === 0 ? "No hay animales que editar con estos filtros" : "Editar como planilla: teclado, pegar desde Excel y rellenar hacia abajo"}
              type="button"
            >
              <Sheet size={15} /> Editar en planilla
            </button>
            <button className="flex h-10 items-center justify-center gap-2 rounded-xl bg-ink px-4 text-xs font-black text-white shadow-lg shadow-ink/10 disabled:cursor-not-allowed disabled:opacity-50" disabled={!hasIndividualLot} onClick={openNewAnimal} title={hasIndividualLot ? undefined : "Activa la trazabilidad individual en un lote primero"} type="button">
              <Plus size={15} /> Nuevo animal
            </button>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <FilterSelect label="Lote" onChange={setSelectedLotId} value={selectedLotId}>
            <option value={ALL}>Todos los lotes</option>
            {lots.map((lot) => <option key={lot.id} value={lot.id}>{lot.name}</option>)}
          </FilterSelect>
          <FilterSelect label="Estado" onChange={(value) => setSelectedStatus(value as LivestockAnimalStatus | typeof ALL)} value={selectedStatus}>
            <option value={ALL}>Todos los estados</option>
            {(Object.keys(LIVESTOCK_ANIMAL_STATUS_LABELS) as LivestockAnimalStatus[]).map((status) => <option key={status} value={status}>{LIVESTOCK_ANIMAL_STATUS_LABELS[status]}</option>)}
          </FilterSelect>
          <label>
            <span className="mb-1.5 block text-[12px] font-black uppercase tracking-wide text-ink-subtle">Buscar</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-subtle" size={14} />
              <input className="h-11 w-full rounded-xl border border-line-steel bg-surface-alt pl-9 pr-3 text-xs font-black text-ink outline-none focus:border-accent" onChange={(event) => setSearch(event.target.value)} placeholder="DIIO u origen" value={search} />
            </div>
          </label>
        </div>
      </section>

      <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard help="dashAnimalesActivos" icon={Beef} label="Animales activos" tone="dark" value={formatInteger(activeCount)} detail={`${formatInteger(animals.length)} registrados en total`} />
        <StatCard helpText="Animales que ya tienen al menos un peso anotado. Sin pesaje no se puede calcular cuánto están subiendo." icon={Weight} label="Con pesaje" value={formatInteger(weighedCount)} detail={`${formatInteger(animals.length - weighedCount)} sin pesaje registrado`} />
        <StatCard helpText="Lo que llevas puesto en comprar animales. Es la base contra la que se mide si el negocio dio o no." icon={CircleDollarSign} label="Inversión en compras" value={purchaseTotal > 0 ? formatClp(purchaseTotal) : "Sin datos"} detail="Suma de precios de compra" />
        <StatCard helpText="Animales que salieron del inventario, por muerte o por venta. Una cifra alta de bajas apunta a un problema sanitario o de manejo." icon={HeartPulse} label="Bajas y ventas" tone="amber" value={formatInteger(deadCount + soldCount)} detail={`${formatInteger(deadCount)} fallecidos · ${formatInteger(soldCount)} vendidos`} />
      </section>

      {spreadsheetOpen && (
        <section className="mt-5">
          <AnimalesSpreadsheet
            allAnimals={animals}
            animals={visibleAnimals}
            defaultLotId={defaultSpreadsheetLotId}
            lots={lots}
            onClose={() => setSpreadsheetOpen(false)}
            onCommit={onSaveSpreadsheet}
            scopeLabel={scopeLabel}
            weighings={weighings}
          />
        </section>
      )}

      <section className="mt-5">
        <Panel title="Animales registrados" eyebrow="Trazabilidad individual" help="diio" icon={Tag}>
          {visibleAnimals.length > 0 ? (
            <TableExplorer
              className="mt-5"
              description="Inventario individual con estado, peso, crecimiento y origen."
              filter={{ label: "Sexo", allLabel: "Todos los sexos", columnIndex: 2 }}
              id="ganado.animales"
              searchPlaceholder="Buscar en las columnas visibles..."
              title="Explorar animales"
            >
              <table className="w-full min-w-[760px] border-separate border-spacing-0 text-left">
                <thead>
                  <tr>
                    {["DIIO", "Lote", "Sexo", "Estado", "Últimos 3 pesajes", "GDV", "Precio compra", "Origen"].map((header) => (
                      <th className="border-b border-line-steel pb-2 pr-3 text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle" key={header}>{header}</th>
                    ))}
                    <th className="border-b border-line-steel pb-2" />
                  </tr>
                </thead>
                <tbody>
                  {visibleAnimals.map((animal) => {
                    const lot = lotById.get(animal.lotId);
                    const history = weighingsByAnimal.get(animal.id) ?? [];
                    const gain = accumulatedWeightGain(history);
                    const latestWeighings = recentWeighings(history, 3);
                    return (
                      <tr className="cursor-pointer transition hover:bg-surface-alt" key={animal.id} onClick={() => openAnimal(animal)}>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs font-black text-ink">{animal.tag}</td>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs font-semibold text-ink-muted">{lot?.name ?? "—"}</td>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs text-ink-muted">{LIVESTOCK_SEX_LABELS[animal.sex]}</td>
                        <td className="border-b border-line-steel py-3 pr-3">
                          <AnimalStatusBadge status={animal.status} />
                          {animal.status !== "active" && (animal.statusDate || animal.statusReason) && (
                            <p className="mt-1 text-[12px] font-semibold text-ink-subtle">{[formatDate(animal.statusDate), animal.statusReason].filter((part) => part && part !== "—").join(" · ")}</p>
                          )}
                        </td>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs font-bold text-ink">
                          {latestWeighings.length > 0 ? (
                            <ol className="space-y-0.5">
                              {latestWeighings.map((weighing, index) => (
                                <li className={index === 0 ? "text-xs font-black text-ink" : "text-[12px] font-semibold text-ink-subtle"} key={weighing.recordedAt}>
                                  {formatKg(weighing.weightKg)}
                                  <span className="ml-1.5 font-semibold text-ink-subtle">{formatDate(weighing.recordedAt)}</span>
                                  {weighing.dailyGainKg !== null && (
                                    <span className={`ml-1.5 font-bold ${weighing.dailyGainKg >= 0 ? "text-accent" : "text-red-700"}`}>
                                      {weighing.dailyGainKg >= 0 ? "+" : ""}{weighing.dailyGainKg.toLocaleString("es-CL", { maximumFractionDigits: 2 })} kg/día
                                    </span>
                                  )}
                                </li>
                              ))}
                            </ol>
                          ) : "—"}
                        </td>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs font-bold text-ink">
                          {gain ? `${gain.dailyGainKg >= 0 ? "+" : ""}${gain.dailyGainKg.toLocaleString("es-CL", { maximumFractionDigits: 2 })} kg/día` : "—"}
                        </td>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs font-bold text-ink">{animal.purchasePriceClp !== null ? formatClp(animal.purchasePriceClp) : "—"}</td>
                        <td className="border-b border-line-steel py-3 pr-3 text-xs text-ink-muted">{animal.origin ?? "—"}</td>
                        <td className="border-b border-line-steel py-3 text-right text-[12px] font-black text-accent">Editar</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableExplorer>
          ) : (
            <SmallEmpty text={animals.length === 0 ? "Aún no hay animales registrados. Crea el primero con su DIIO." : "Ningún animal coincide con los filtros."} />
          )}
        </Panel>
      </section>

      {dialogOpen && (
        <ManageLivestockAnimalDialog
          animal={managedAnimal}
          key={managedAnimal?.id ?? "new-livestock-animal"}
          lots={lots}
          onClose={() => setDialogOpen(false)}
          onDelete={onDelete}
          onSave={onSave}
          weighings={weighings}
        />
      )}
    </div>
  );
}

function AnimalStatusBadge({ status }: { status: LivestockAnimalStatus }) {
  const classes = {
    active: "bg-band text-accent",
    dead: "bg-red-50 text-red-700",
    sold: "bg-blue-50 text-blue-700",
    departed: "bg-surface-alt text-ink-muted",
  };
  return <span className={`inline-flex rounded-full px-2.5 py-1 text-[12px] font-black uppercase tracking-wide ${classes[status]}`}>{LIVESTOCK_ANIMAL_STATUS_LABELS[status]}</span>;
}
