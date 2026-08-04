"use client";

import type {
  Fundo,
  LivestockAnimal,
  LivestockContribution,
  LivestockExpense,
  LivestockFeedConsumption,
  LivestockFeedInventory,
  LivestockFinanceAuditEntry,
  LivestockFeedingPlan,
  LivestockLot,
  LivestockPartner,
  LivestockWeighing,
  Potrero,
} from "@/src/core/domain/types";
import { AppShell } from "@/src/core/layout/AppShell";
import { BarChart3, Beef, Bluetooth, CalendarCheck2, ChevronRight, CircleAlert, CircleDollarSign, Dna, FileCheck2, FileHeart, Layers3, LoaderCircle, Sprout, Weight, Wheat, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { Hint } from "@/src/ui/Hint";
import { HELP, type HelpKey } from "@/src/ui/help-copy";
import { useCallback, useRef, useState } from "react";
import {
  AnimalSpreadsheetError,
  ExpenseSpreadsheetError,
  fetchHerdOperations,
  fetchLivestockFeedData,
  fetchLivestockFeedingPlans,
  fetchLivestockSnapshot,
  persistAnimalSpreadsheet,
  persistExpenseSpreadsheet,
  persistLivestockAnimal,
  persistLivestockContribution,
  persistLivestockExpense,
  persistLivestockLot,
  persistLivestockPartner,
  persistLivestockFeedingPlan,
  persistWeighingSession,
  removeLivestockAnimal,
  removeLivestockContribution,
  removeLivestockExpense,
  removeLivestockLot,
  removeLivestockPartner,
  removeLivestockFeedingPlan,
  removeWeighing,
  type WeighingSessionInput,
} from "./api/livestock-client";
import { fetchPotreros } from "../potreros/api/potreros-client";
import { AgendaSection } from "./components/AgendaSection";
import { AnimalesSection } from "./components/AnimalesSection";
import { ComoVamosSection } from "./components/ComoVamosSection";
import { GenealogiaSection } from "./components/GenealogiaSection";
import { ForageSection } from "./components/ForageSection";
import { FeedInventorySection } from "./components/FeedInventorySection";
import { LotesSection } from "./components/LotesSection";
import { PesajesSection } from "./components/PesajesSection";
import { PlataSection } from "./components/PlataSection";
import { RacionSection } from "./components/RacionSection";
import { SagSection } from "./components/SagSection";
import { TerrenoSection } from "./components/TerrenoSection";
import type { HerdOperations } from "./domain/operations";

type GanadoPageProps = {
  canManageFinance: boolean;
  canManageOrganizationFinance: boolean;
  fundos: Fundo[];
  potreros: Potrero[];
  initialLots: LivestockLot[];
  initialAnimals: LivestockAnimal[];
  initialWeighings: LivestockWeighing[];
  initialPartners: LivestockPartner[];
  initialContributions: LivestockContribution[];
  initialExpenses: LivestockExpense[];
  initialFinanceAudit: LivestockFinanceAuditEntry[];
  initialFeedingPlans: LivestockFeedingPlan[];
  initialOperations: HerdOperations;
  offlineScope: string;
  initialFeedInventory: LivestockFeedInventory[];
  initialFeedConsumptions: LivestockFeedConsumption[];
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
};

const TABS = [
  { key: "agenda", label: "Agenda", icon: CalendarCheck2, help: "ganadoAgenda" },
  { key: "lotes", label: "Lotes", icon: Layers3, help: "ganadoLotes" },
  { key: "animales", label: "Animales", icon: Beef, help: "ganadoAnimales" },
  { key: "pesajes", label: "Pesajes", icon: Weight, help: "ganadoPesajes" },
  { key: "terreno", label: "Terreno", icon: Bluetooth, help: "ganadoTerreno" },
  { key: "genealogia", label: "Genealogía", icon: Dna, help: "ganadoGenealogia" },
  { key: "sag", label: "SAG / SIPEC", icon: FileCheck2, help: "ganadoSag" },
  { key: "forraje", label: "Forraje / NDVI", icon: Sprout, help: "ganadoForraje" },
  { key: "plata", label: "Plata", icon: CircleDollarSign, help: "ganadoPlata" },
  { key: "racion", label: "Ración", icon: Wheat, help: "ganadoRacion" },
  { key: "como-vamos", label: "¿Cómo vamos?", icon: BarChart3, help: "ganadoComoVamos" },
] as const satisfies readonly { key: string; label: string; icon: LucideIcon; help: HelpKey }[];

type TabKey = (typeof TABS)[number]["key"];
type DeferredDataKey = "paddocks" | "feeding";
type DeferredLoadState = "idle" | "loading" | "loaded" | "error";

export function GanadoPage({
  canManageFinance,
  canManageOrganizationFinance,
  fundos,
  potreros,
  initialLots,
  initialAnimals,
  initialWeighings,
  initialPartners,
  initialContributions,
  initialExpenses,
  initialFinanceAudit,
  initialFeedingPlans,
  initialOperations,
  offlineScope,
  initialFeedInventory,
  initialFeedConsumptions,
  isDemo,
  organizationId,
  organizationName,
  userName,
}: GanadoPageProps) {
  const [tab, setTab] = useState<TabKey>("agenda");
  const [lots, setLots] = useState(initialLots);
  const [animals, setAnimals] = useState(initialAnimals);
  const [weighings, setWeighings] = useState(initialWeighings);
  const [partners, setPartners] = useState(initialPartners);
  const [contributions, setContributions] = useState(initialContributions);
  const [expenses, setExpenses] = useState(initialExpenses);
  const [financeAudit, setFinanceAudit] = useState(initialFinanceAudit);
  const [feedingPlans, setFeedingPlans] = useState(initialFeedingPlans);
  const [paddocks, setPaddocks] = useState(potreros);
  const [feedInventory, setFeedInventory] = useState(initialFeedInventory);
  const [feedConsumptions, setFeedConsumptions] = useState(initialFeedConsumptions);
  const [feedRevision, setFeedRevision] = useState(0);
  const [operations, setOperations] = useState(initialOperations);
  const [deferredState, setDeferredState] = useState<Record<DeferredDataKey, DeferredLoadState>>({
    paddocks: potreros.length > 0 ? "loaded" : "idle",
    feeding: initialFeedingPlans.length > 0 || initialFeedInventory.length > 0 || initialFeedConsumptions.length > 0 ? "loaded" : "idle",
  });
  const deferredRequests = useRef<Partial<Record<DeferredDataKey, Promise<void>>>>({});

  const loadPaddocks = useCallback(async (force = false) => {
    if (!force && deferredState.paddocks === "loaded") return;
    if (deferredRequests.current.paddocks) return deferredRequests.current.paddocks;
    setDeferredState((current) => ({ ...current, paddocks: "loading" }));
    const request = fetchPotreros()
      .then((next) => {
        setPaddocks(next);
        setDeferredState((current) => ({ ...current, paddocks: "loaded" }));
      })
      .catch((cause) => {
        setDeferredState((current) => ({ ...current, paddocks: "error" }));
        if (force) throw cause;
      })
      .finally(() => { deferredRequests.current.paddocks = undefined; });
    deferredRequests.current.paddocks = request;
    await request;
  }, [deferredState.paddocks]);

  const loadFeeding = useCallback(async (force = false) => {
    if (!force && deferredState.feeding === "loaded") return;
    if (deferredRequests.current.feeding) return deferredRequests.current.feeding;
    setDeferredState((current) => ({ ...current, feeding: "loading" }));
    const request = Promise.all([fetchLivestockFeedingPlans(), fetchLivestockFeedData()])
      .then(([plans, feed]) => {
        setFeedingPlans(plans);
        setFeedInventory(feed.inventory);
        setFeedConsumptions(feed.consumptions);
        setFeedRevision((current) => current + 1);
        setDeferredState((current) => ({ ...current, feeding: "loaded" }));
      })
      .catch((cause) => {
        setDeferredState((current) => ({ ...current, feeding: "error" }));
        if (force) throw cause;
      })
      .finally(() => { deferredRequests.current.feeding = undefined; });
    deferredRequests.current.feeding = request;
    await request;
  }, [deferredState.feeding]);

  const refreshOperations = useCallback(async () => {
    try { setOperations(await fetchHerdOperations()); }
    catch (cause) { console.warn("[fundosmart] herd agenda refresh failed", cause); }
  }, []);
  const refreshLivestockSnapshot = useCallback(async () => {
    try {
      const snapshot = await fetchLivestockSnapshot();
      setLots(snapshot.lots); setAnimals(snapshot.animals); setWeighings(snapshot.weighings);
      await refreshOperations();
    } catch (cause) { console.warn("[fundosmart] livestock snapshot refresh failed", cause); }
  }, [refreshOperations]);
  const visibleTabs = TABS.filter((item) => item.key !== "plata" || canManageFinance);

  const refreshModule = useCallback(async () => {
    const extraRequests: Promise<void>[] = [];
    if (deferredState.paddocks === "loaded") extraRequests.push(loadPaddocks(true));
    if (deferredState.feeding === "loaded") extraRequests.push(loadFeeding(true));
    const coreRequest = Promise.all([
      fetchLivestockSnapshot(),
      fetchHerdOperations(),
    ]);
    await Promise.all([coreRequest, ...extraRequests]);
    const [snapshot, nextOperations] = await coreRequest;
    setLots(snapshot.lots);
    setAnimals(snapshot.animals);
    setWeighings(snapshot.weighings);
    setOperations(nextOperations);
  }, [deferredState.feeding, deferredState.paddocks, loadFeeding, loadPaddocks]);

  function openTab(nextTab: TabKey) {
    setTab(nextTab);
    if (nextTab === "lotes" || nextTab === "forraje") {
      void loadPaddocks();
    }
    if (nextTab === "forraje" || nextTab === "racion") {
      void loadFeeding();
    }
  }

  async function saveLot(lot: LivestockLot) {
    const saved = await persistLivestockLot(lot);
    setLots((current) => upsertById(current, saved));
    await refreshOperations();
  }

  async function deleteLot(id: string, updatedAt: string) {
    const removedAnimalIds = new Set(animals.filter((animal) => animal.lotId === id).map((animal) => animal.id));
    await removeLivestockLot(id, updatedAt);
    setLots((current) => current.filter((lot) => lot.id !== id));
    setAnimals((current) => current.filter((animal) => animal.lotId !== id));
    setWeighings((current) => current.filter((weighing) => !removedAnimalIds.has(weighing.animalId)));
    await refreshOperations();
  }

  async function saveAnimal(animal: LivestockAnimal) {
    const result = await persistLivestockAnimal(animal);
    setAnimals((current) => upsertById(current, result.animal));
    setLots(result.lots);
    await refreshOperations();
  }

  /**
   * Confirma la planilla y rebasa la pantalla con lo que el servidor devolvió.
   *
   * Si una fila choca, el error viaja con el snapshot de ese momento: la planilla se
   * queda con lo que no alcanzó a guardarse en vez de mostrar datos viejos.
   */
  async function saveAnimalSpreadsheet(changed: LivestockAnimal[]) {
    try {
      const result = await persistAnimalSpreadsheet(changed);
      setAnimals(result.animals);
      setLots(result.lots);
      setWeighings(result.weighings);
      await refreshOperations();
      return { savedIds: result.savedIds };
    } catch (cause) {
      if (cause instanceof AnimalSpreadsheetError && cause.snapshot) {
        setAnimals(cause.snapshot.animals);
        setLots(cause.snapshot.lots);
        setWeighings(cause.snapshot.weighings);
        await refreshOperations();
      }
      throw cause;
    }
  }

  /**
   * Confirma la planilla de egresos y refleja lo guardado sin recargar.
   *
   * Cada egreso trae su entrada de auditoría, y también las de una confirmación que se
   * detuvo a medias: lo que alcanzó a escribirse tiene que quedar registrado igual.
   */
  async function saveExpenseSpreadsheet(changed: LivestockExpense[]) {
    try {
      const result = await persistExpenseSpreadsheet(changed);
      setExpenses((current) => result.expenses.reduce(upsertById, current));
      setFinanceAudit((current) => result.auditEntries.reduce((entries, entry) => prependAudit(entries, entry), current));
      return { savedIds: result.savedIds };
    } catch (cause) {
      if (cause instanceof ExpenseSpreadsheetError && cause.savedIds.length > 0) {
        setExpenses((current) => cause.expenses.reduce(upsertById, current));
        setFinanceAudit((current) => cause.auditEntries.reduce((entries, entry) => prependAudit(entries, entry), current));
      }
      throw cause;
    }
  }

  async function deleteAnimal(id: string, snapshotToken: string) {
    const updatedLots = await removeLivestockAnimal(id, snapshotToken);
    setAnimals((current) => current.filter((animal) => animal.id !== id));
    setWeighings((current) => current.filter((weighing) => weighing.animalId !== id));
    setLots(updatedLots);
    await refreshOperations();
  }

  async function saveWeighingSession(session: WeighingSessionInput) {
    const result = await persistWeighingSession(session);
    setWeighings(result.weighings);
    setLots(result.lots);
    setAnimals(result.animals);
    await refreshOperations();
  }

  async function deleteWeighing(id: string, snapshotToken: string) {
    const result = await removeWeighing(id, snapshotToken);
    setWeighings(result.weighings);
    setLots(result.lots);
    setAnimals(result.animals);
    await refreshOperations();
  }

  async function savePartner(partner: LivestockPartner) {
    const result = await persistLivestockPartner(partner);
    setPartners((current) => sortByName(upsertById(current, result.value)));
    setFinanceAudit((current) => prependAudit(current, result.auditEntry));
  }

  async function deletePartner(id: string, snapshotToken: string) {
    const result = await removeLivestockPartner(id, snapshotToken);
    setPartners((current) => current.filter((partner) => partner.id !== id));
    setContributions((current) => current.filter((contribution) => contribution.partnerId !== id));
    if (result.auditEntry) setFinanceAudit((current) => prependAudit(current, result.auditEntry!));
  }

  async function saveContribution(contribution: LivestockContribution) {
    const result = await persistLivestockContribution(contribution);
    setContributions((current) => upsertById(current, result.value));
    setFinanceAudit((current) => prependAudit(current, result.auditEntry));
  }

  async function deleteContribution(id: string, snapshotToken: string) {
    const result = await removeLivestockContribution(id, snapshotToken);
    setContributions((current) => current.filter((contribution) => contribution.id !== id));
    if (result.auditEntry) setFinanceAudit((current) => prependAudit(current, result.auditEntry!));
  }

  async function saveExpense(expense: LivestockExpense) {
    const result = await persistLivestockExpense(expense);
    setExpenses((current) => upsertById(current, result.value));
    setFinanceAudit((current) => prependAudit(current, result.auditEntry));
    await refreshOperations();
  }

  async function deleteExpense(id: string) {
    const result = await removeLivestockExpense(id);
    setExpenses((current) => current.filter((expense) => expense.id !== id));
    if (result.auditEntry) setFinanceAudit((current) => prependAudit(current, result.auditEntry!));
    await refreshOperations();
  }

  async function saveFeedingPlan(plan: LivestockFeedingPlan) {
    const saved = await persistLivestockFeedingPlan(plan);
    setFeedingPlans((current) => upsertById(current, saved));
  }

  async function deleteFeedingPlan(id: string, updatedAt: string) {
    await removeLivestockFeedingPlan(id, updatedAt);
    setFeedingPlans((current) => current.filter((plan) => plan.id !== id));
  }

  return (
    <AppShell activeSection="ganado" fieldName="Todos los fundos" isDemo={isDemo} onRefresh={refreshModule} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> Inventario, pesajes y plata
              </div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">Ganado</h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                Controla los lotes, cada animal con su DIIO, las sesiones de pesaje, la plata de los socios y la ración diaria.
              </p>
            </div>
            <Link className="inline-flex h-11 items-center justify-center gap-2 self-start rounded-xl bg-accent px-4 text-xs font-black text-white shadow-lg shadow-accent/10" data-hint={HELP.ganadoFicha360} href="/app/ganado/ficha">
              <FileHeart size={16} /> Abrir Ficha animal 360 <ChevronRight size={14} />
            </Link>
          </header>

          <nav aria-label="Secciones de ganado" className="mt-6 flex gap-1.5 overflow-x-auto rounded-2xl border border-line-steel bg-white p-1.5 shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
            {/* La barra tiene desplazamiento horizontal, así que el globo va en un
                portal (`Hint`) y no como pseudoelemento: si no, se recortaría. */}
            {visibleTabs.map((item) => {
              const Icon = item.icon;
              const active = item.key === tab;
              return (
                <Hint className="flex shrink-0" help={item.help} key={item.key}>
                  <button
                    className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black transition ${
                      active ? "bg-ink text-white shadow-lg shadow-ink/10" : "text-ink-muted hover:bg-surface-alt"
                    }`}
                    onClick={() => openTab(item.key)}
                    type="button"
                  >
                    <Icon size={15} /> {item.label}
                  </button>
                </Hint>
              );
            })}
          </nav>

          <div className="mt-5 pb-8">
            {tab === "agenda" && (
              <AgendaSection
                animals={animals}
                fieldIds={fundos.map((fundo) => fundo.id)}
                lots={lots}
                onOpenSag={() => openTab("sag")}
                onOperationsChange={setOperations}
                operations={operations}
              />
            )}
            {tab === "lotes" && (
              deferredState.paddocks === "loaded"
                ? <LotesSection fundos={fundos} lots={lots} onDelete={deleteLot} onSave={saveLot} potreros={paddocks} />
                : <DeferredSectionState label="lotes y potreros" onRetry={() => loadPaddocks()} state={deferredState.paddocks} />
            )}
            {tab === "animales" && (
              <AnimalesSection animals={animals} lots={lots} onDelete={deleteAnimal} onSave={saveAnimal} onSaveSpreadsheet={saveAnimalSpreadsheet} weighings={weighings} />
            )}
            {tab === "pesajes" && (
              <PesajesSection
                animals={animals}
                lots={lots}
                onDeleteWeighing={deleteWeighing}
                onSaveSession={saveWeighingSession}
                weighings={weighings}
              />
            )}
            {tab === "terreno" && (
              <TerrenoSection
                animals={animals}
                lots={lots}
                offlineScope={offlineScope}
                onSynced={refreshLivestockSnapshot}
              />
            )}
            {tab === "genealogia" && <GenealogiaSection pedigree={operations.pedigree} />}
            {tab === "sag" && <SagSection animals={animals} fundos={fundos} lots={lots} offlineScope={offlineScope} />}
            {tab === "forraje" && (
              deferredState.paddocks === "loaded" && deferredState.feeding === "loaded"
                ? <ForageSection animals={animals} feedingPlans={feedingPlans} fundos={fundos} lots={lots} offlineScope={offlineScope} potreros={paddocks} />
                : <DeferredSectionState
                    label="forraje y alimentación"
                    onRetry={() => Promise.all([loadPaddocks(), loadFeeding()]).then(() => undefined)}
                    state={deferredState.paddocks === "error" || deferredState.feeding === "error" ? "error" : "loading"}
                  />
            )}
            {canManageFinance && tab === "plata" && (
              <PlataSection
                auditEntries={financeAudit}
                canManageOrganizationFinance={canManageOrganizationFinance}
                contributions={contributions}
                expenses={expenses}
                fundos={fundos}
                lots={lots}
                onDeleteContribution={deleteContribution}
                onDeleteExpense={deleteExpense}
                onDeletePartner={deletePartner}
                onSaveContribution={saveContribution}
                onSaveExpense={saveExpense}
                onSaveExpenseSpreadsheet={saveExpenseSpreadsheet}
                onSavePartner={savePartner}
                partners={partners}
              />
            )}
            {tab === "racion" && (
              deferredState.feeding === "loaded" ? <>
                <RacionSection lots={lots} onDelete={deleteFeedingPlan} onSave={saveFeedingPlan} plans={feedingPlans} />
                <FeedInventorySection canManageFinance={canManageFinance} fundos={fundos} initialConsumptions={feedConsumptions} initialInventory={feedInventory} key={`feed-${feedRevision}`} lots={lots} plans={feedingPlans} />
              </> : <DeferredSectionState label="ración e inventario de alimento" onRetry={() => loadFeeding()} state={deferredState.feeding} />
            )}
            {tab === "como-vamos" && (
              <ComoVamosSection
                animals={animals}
                contributions={contributions}
                expenses={expenses}
                lots={lots}
                operations={operations}
                partners={partners}
                weighings={weighings}
              />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

function DeferredSectionState({ label, onRetry, state }: { label: string; onRetry: () => Promise<void>; state: DeferredLoadState }) {
  return (
    <section aria-live="polite" className="flex min-h-64 items-center justify-center rounded-[20px] border border-line-steel bg-white p-8 text-center shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
      <div>
        {state === "error" ? <CircleAlert className="mx-auto text-alert-ink" size={24} /> : <LoaderCircle className="mx-auto animate-spin text-accent" size={24} />}
        <p className="mt-3 text-xs font-black text-ink">{state === "error" ? `No fue posible cargar ${label}.` : `Cargando ${label}…`}</p>
        <p className="mt-1 text-[12px] text-ink-subtle">La sección se conservará en memoria durante esta visita.</p>
        {state === "error" && <button className="mt-4 h-10 rounded-xl bg-ink px-4 text-xs font-black text-white" onClick={() => { void onRetry(); }} type="button">Reintentar</button>}
      </div>
    </section>
  );
}

function upsertById<T extends { id: string }>(items: T[], saved: T): T[] {
  const exists = items.some((item) => item.id === saved.id);
  return exists ? items.map((item) => (item.id === saved.id ? saved : item)) : [saved, ...items];
}

function sortByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.name.localeCompare(b.name, "es"));
}

function prependAudit(
  entries: LivestockFinanceAuditEntry[],
  entry: LivestockFinanceAuditEntry,
): LivestockFinanceAuditEntry[] {
  return [entry, ...entries.filter((current) => current.id !== entry.id)].slice(0, 50);
}
