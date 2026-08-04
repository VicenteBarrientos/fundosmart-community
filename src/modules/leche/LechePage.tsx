"use client";

import type { Fundo, MilkSettlement } from "@/src/core/domain/types";
import { downloadCsv } from "@/src/core/export/csv.mjs";
import { AppShell } from "@/src/core/layout/AppShell";
import { Hint, HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import { useDialogA11y } from "@/src/ui/useDialogA11y";
import {
  AlertTriangle,
  BarChart3,
  Beef,
  CalendarDays,
  Calculator,
  ChevronRight,
  CircleDollarSign,
  Download,
  Droplets,
  FileText,
  FlaskConical,
  HeartPulse,
  LoaderCircle,
  Milk,
  Pencil,
  Plus,
  Stethoscope,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { fetchMilkSettlements, persistMilkSettlement, removeMilkSettlement } from "./api/milk-client";
import { fetchMilkSnapshot } from "./api/milk-operations-client";
import { ManageMilkSettlementDialog } from "./components/ManageMilkSettlementDialog";
import { MilkModuleSections } from "./components/MilkModuleSections";
import { MilkPriceSimulator } from "./components/MilkPriceSimulator";
import { createLatestRequestGate } from "./domain/latest-request-gate.mjs";
import { analyzeMilkSettlement } from "./domain/milk-settlement-analysis.mjs";
import type { MilkModuleSection, MilkModuleSnapshot } from "./domain/types";

type LechePageProps = {
  canViewFinance: boolean;
  fundos: Fundo[];
  initialFieldId?: string;
  initialSection?: MilkModuleSection;
  initialSettlements: MilkSettlement[];
  initialSnapshot: MilkModuleSnapshot | null;
  isDemo: boolean;
  organizationId: string;
  organizationName: string;
  userName: string;
};

const ALL = "all";
const MODULE_SECTIONS = [
  { id: "settlements", label: "Liquidaciones", icon: FileText, help: "lecheLiquidaciones" },
  { id: "simulator", label: "Simulador", icon: Calculator, help: "lecheSimulador" },
  { id: "production", label: "Producción", icon: BarChart3, help: "lecheProduccion" },
  { id: "herd", label: "Rebaño lechero", icon: Beef, help: "lecheRebano" },
  { id: "reproduction", label: "Reproducción", icon: HeartPulse, help: "lecheReproduccion" },
  { id: "health", label: "Sanidad y PABCO", icon: Stethoscope, help: "lecheSanidad" },
] as const satisfies readonly { id: string; label: string; icon: LucideIcon; help: HelpKey }[];

export function LechePage({
  canViewFinance,
  fundos,
  initialFieldId = ALL,
  initialSection = "settlements",
  initialSettlements,
  initialSnapshot,
  isDemo,
  organizationId,
  organizationName,
  userName,
}: LechePageProps) {
  const [settlements, setSettlements] = useState(initialSettlements);
  const [snapshot, setSnapshot] = useState<MilkModuleSnapshot | null>(initialSnapshot);
  const [activeSection, setActiveSection] =
    useState<MilkModuleSection>(initialSection);
  const [selectedFundoId, setSelectedFundoId] = useState(initialFieldId);
  const [selectedYear, setSelectedYear] = useState(ALL);
  const [selectedSettlementId, setSelectedSettlementId] = useState<
    string | null
  >(initialSettlements[0]?.id ?? null);
  const [managedSettlement, setManagedSettlement] = useState<
    MilkSettlement | "new" | null
  >(null);
  const [confirmDelete, setConfirmDelete] = useState<MilkSettlement | null>(
    null,
  );
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const closeDeleteDialog = useCallback(() => setConfirmDelete(null), []);
  useDialogA11y(deleteDialogRef, closeDeleteDialog, Boolean(confirmDelete) && !deleting);
  const snapshotRequestGateRef = useRef<
    ReturnType<typeof createLatestRequestGate> | null
  >(null);
  if (snapshotRequestGateRef.current === null)
    snapshotRequestGateRef.current = createLatestRequestGate();
  const snapshotCacheRef = useRef(new Map<string, MilkModuleSnapshot>());
  if (initialSnapshot && snapshotCacheRef.current.size === 0) {
    snapshotCacheRef.current.set(snapshotCacheKey(undefined), initialSnapshot);
  }

  const fundoById = useMemo(
    () => new Map(fundos.map((fundo) => [fundo.id, fundo])),
    [fundos],
  );
  const years = [
    ...new Set([
      ...settlements.map((settlement) => settlement.period.slice(0, 4)),
      ...(snapshot?.bulkProduction ?? []).map((record) => record.recordedAt.slice(0, 4)),
      ...(snapshot?.qualitySamples ?? []).map((sample) => sample.sampledAt.slice(0, 4)),
      ...(snapshot?.herd ?? []).flatMap((animal) =>
        animal.controlSeries.map((control) => control.date.slice(0, 4)),
      ),
    ]),
  ]
    .filter(Boolean)
    .sort()
    .reverse();
  const filtered = settlements
    .filter(
      (settlement) =>
        selectedFundoId === ALL || settlement.fieldId === selectedFundoId,
    )
    .filter(
      (settlement) =>
        selectedYear === ALL || settlement.period.startsWith(selectedYear),
    )
    .sort((a, b) => b.period.localeCompare(a.period));
  const selectedSettlement =
    filtered.find((settlement) => settlement.id === selectedSettlementId) ??
    filtered[0] ??
    null;

  const totalLiters = filtered.reduce(
    (sum, settlement) => sum + settlement.totalLiters,
    0,
  );
  const totalNet = filtered.reduce(
    (sum, settlement) => sum + settlement.netAmountClp,
    0,
  );
  const totalTax = filtered.reduce(
    (sum, settlement) => sum + settlement.taxAmountClp,
    0,
  );
  const totalGross = filtered.reduce(
    (sum, settlement) => sum + settlement.grossAmountClp,
    0,
  );
  const weightedNetPrice = totalLiters > 0 ? totalNet / totalLiters : 0;
  const maximumLiters = Math.max(
    0,
    ...filtered.map((settlement) => settlement.totalLiters),
  );
  const selectedFundo =
    fundos.find((fundo) => fundo.id === selectedFundoId) ?? null;

  async function saveSettlement(settlement: MilkSettlement) {
    const saved = await persistMilkSettlement(settlement);
    setSettlements((current) => [
      saved,
      ...current.filter((item) => item.id !== saved.id),
    ]);
    setSelectedSettlementId(saved.id);
  }

  async function deleteSettlement() {
    if (!confirmDelete) return;
    setDeleting(true);
    setError(null);
    try {
      await removeMilkSettlement(confirmDelete.id, confirmDelete.updatedAt);
      setSettlements((current) => current.filter((item) => item.id !== confirmDelete.id));
      if (selectedSettlementId === confirmDelete.id) setSelectedSettlementId(null);
      setConfirmDelete(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible eliminar la liquidación.",
      );
    } finally {
      setDeleting(false);
    }
  }

  async function refreshSnapshot(year = selectedYear, force = false) {
    const cutoff = snapshotCutoff(year);
    const cacheKey = snapshotCacheKey(cutoff);
    const cached = snapshotCacheRef.current.get(cacheKey);
    if (!force && cached) {
      setSnapshot(cached);
      return;
    }
    const requestTicket = snapshotRequestGateRef.current!.begin();
    setError(null);
    try {
      const nextSnapshot = await fetchMilkSnapshot(cutoff);
      if (!snapshotRequestGateRef.current!.isCurrent(requestTicket)) return;
      snapshotCacheRef.current.set(cacheKey, nextSnapshot);
      setSnapshot(nextSnapshot);
    } catch (cause) {
      if (!snapshotRequestGateRef.current!.isCurrent(requestTicket)) return;
      setError(
        cause instanceof Error
          ? cause.message
          : "No fue posible actualizar el tablero lechero.",
      );
      if (force) throw cause;
    }
  }

  async function refreshModule() {
    const requests: Promise<unknown>[] = [];
    if (canViewFinance) {
      requests.push(fetchMilkSettlements().then((nextSettlements) => {
        setSettlements(nextSettlements);
        setSelectedSettlementId((current) => current && nextSettlements.some((item) => item.id === current) ? current : nextSettlements[0]?.id ?? null);
      }));
    }
    if (sectionNeedsOperationalSnapshot(activeSection)) {
      requests.push(refreshSnapshot(selectedYear, true));
    }
    await Promise.all(requests);
  }

  function exportCsv() {
    if (filtered.length === 0) return;
    const headers = [
      "Período",
      "Fundo",
      "Comprador",
      "Orden de compra",
      "Litros",
      "Precio neto por litro",
      "Neto CLP",
      "IVA CLP",
      "Total CLP",
      "Documento",
    ];
    const rows = filtered.map((settlement) => [
      settlement.period,
      fundoById.get(settlement.fieldId)?.name ?? "Fundo",
      settlement.buyerName,
      settlement.purchaseOrder,
      settlement.totalLiters,
      settlement.netPricePerLiterClp,
      settlement.netAmountClp,
      settlement.taxAmountClp,
      settlement.grossAmountClp,
      settlement.sourceDocumentName ?? "",
    ]);
    downloadCsv(`fundosmart-leche-${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  }

  return (
    <AppShell activeSection="leche" fieldName={selectedFundo?.name ?? "Todos los fundos"} isDemo={isDemo} onRefresh={refreshModule} organizationId={organizationId} organizationName={organizationName} userName={userName}>
      <div className="px-4 py-5 sm:px-6 lg:px-8 lg:py-7 xl:px-10">
        <div className="mx-auto max-w-[1540px]">
          <header className="flex flex-col gap-5 xl:flex-row xl:items-end xl:justify-between">
            <div>
              <div className="flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.16em] text-accent">
                <span className="size-1.5 rounded-full bg-accent" /> Gestión
                lechera
              </div>
              <h1 className="mt-2 text-[32px] font-black tracking-[-0.055em] text-ink sm:text-[38px]">
                Leche
              </h1>
              <p className="mt-1 max-w-2xl text-sm text-ink-muted">
                Producción y liquidaciones de leche, separadas del ganado de
                engorda y de sus costos.
              </p>
            </div>
            {activeSection === "settlements" && (
              <div className="flex flex-col gap-2 sm:flex-row">
                  <button
                    className="flex h-11 items-center justify-center gap-2 rounded-xl border border-line-steel bg-white px-4 text-xs font-black text-ink disabled:opacity-45"
                    disabled={filtered.length === 0}
                    onClick={exportCsv}
                    type="button"
                  >
                    <Download size={15} /> Exportar
                  </button>
                  <button
                    className="flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-xs font-black text-white shadow-lg shadow-accent/10"
                    onClick={() => setManagedSettlement("new")}
                    type="button"
                  >
                    <Plus size={15} /> Nueva liquidación
                  </button>
              </div>
            )}
          </header>

          <nav
            aria-label="Áreas del módulo Leche"
            className="mt-6 flex gap-1.5 overflow-x-auto rounded-2xl border border-line-steel bg-white p-1.5 shadow-[0_8px_30px_rgba(35,50,42,0.04)]"
          >
            {MODULE_SECTIONS.map((section) => {
              const Icon = section.icon;
              const current = section.id === activeSection;
              return (
                <Hint className="flex shrink-0" help={section.help} key={section.label}>
                  <button
                    aria-current={current ? "page" : undefined}
                    className={`flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-xs font-black transition ${current ? "bg-ink text-white" : "text-ink-muted hover:bg-surface-alt hover:text-ink"}`}
                    onClick={() => {
                      setActiveSection(section.id);
                      if (sectionNeedsOperationalSnapshot(section.id))
                        void refreshSnapshot(selectedYear);
                    }}
                    type="button"
                  >
                    <Icon size={15} /> {section.label}
                  </button>
                </Hint>
              );
            })}
          </nav>

          <section className="mt-5 rounded-[20px] border border-line-steel bg-white p-4 shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
            <div className="grid gap-3 sm:grid-cols-2 xl:max-w-2xl">
              <FilterSelect
                label="Fundo"
                onChange={setSelectedFundoId}
                value={selectedFundoId}
              >
                <option value={ALL}>Todos los fundos</option>
                {fundos.map((fundo) => (
                  <option key={fundo.id} value={fundo.id}>
                    {fundo.name}
                  </option>
                ))}
              </FilterSelect>
              <FilterSelect
                label="Año"
                onChange={(year) => {
                  setSelectedYear(year);
                  if (sectionNeedsOperationalSnapshot(activeSection))
                    void refreshSnapshot(year);
                }}
                value={selectedYear}
              >
                <option value={ALL}>Todos los años</option>
                {years.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </FilterSelect>
            </div>
          </section>

          {activeSection === "settlements" ? (
            <>
              <section className="mt-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
                <StatCard
                  detail={`${filtered.length} liquidaciones`}
                  helpText="Litros que la planta reconoce haber recibido y pagado. Pueden diferir de los que tú anotaste al entregar."
                  icon={Droplets}
                  label="Litros pagados"
                  tone="dark"
                  value={formatNumber(totalLiters, 0)}
                />
                <StatCard
                  detail="Promedio ponderado"
                  helpText="Lo que realmente te quedó por cada litro, ya con bonos y descuentos aplicados. Es el número con que se compara una planta contra otra."
                  icon={Milk}
                  label="Precio neto por litro"
                  value={formatClpDecimal(weightedNetPrice)}
                />
                <StatCard
                  detail={`IVA ${formatClp(totalTax)}`}
                  helpText="Monto sin IVA. Es el ingreso que entra al resultado del negocio."
                  icon={CircleDollarSign}
                  label="Facturación neta"
                  value={formatClp(totalNet)}
                />
                <StatCard
                  detail="Neto más IVA"
                  helpText="Lo que aparece en el documento de pago, con IVA incluido. No es lo que gana el negocio."
                  icon={CircleDollarSign}
                  label="Total liquidado"
                  tone="amber"
                  value={formatClp(totalGross)}
                />
              </section>

              <section className="mt-5 grid gap-5 xl:grid-cols-[minmax(0,0.72fr)_minmax(0,1.28fr)]">
                <Panel>
                  <PanelHeader
                    eyebrow="Producción pagada"
                    helpText="Cada barra es un período de pago. Sirve para ver de un vistazo si la producción sube, baja o se estanca."
                    icon={BarChart3}
                    title="Litros por liquidación"
                  />
                  {filtered.length > 0 ? (
                    <div className="mt-5 space-y-4">
                      {[...filtered].reverse().map((settlement) => {
                        const share =
                          maximumLiters > 0
                            ? (settlement.totalLiters / maximumLiters) * 100
                            : 0;
                        return (
                          <button
                            className="block w-full text-left"
                            key={settlement.id}
                            onClick={() =>
                              setSelectedSettlementId(settlement.id)
                            }
                            type="button"
                          >
                            <div className="flex items-end justify-between gap-3">
                              <div>
                                <p className="text-xs font-black text-ink">
                                  {formatPeriod(settlement.period)}
                                </p>
                                <p className="mt-0.5 text-[12px] font-bold text-ink-subtle">
                                  {settlement.buyerName}
                                </p>
                              </div>
                              <p className="text-xs font-black text-ink">
                                {formatNumber(settlement.totalLiters, 0)} L
                              </p>
                            </div>
                            <div className="mt-2 h-2.5 overflow-hidden rounded-full bg-surface-alt">
                              <div
                                className="h-full rounded-full bg-accent"
                                style={{ width: `${Math.max(3, share)}%` }}
                              />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <EmptyState text="No hay liquidaciones para esta selección." />
                  )}
                </Panel>

                <Panel>
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <PanelHeader
                      eyebrow="Historial"
                      help="lecheLiquidaciones"
                      icon={CalendarDays}
                      title="Liquidaciones registradas"
                    />
                    <p className="text-[12px] font-bold text-ink-subtle">
                      {filtered.length} registros
                    </p>
                  </div>
                  {filtered.length > 0 ? (
                    <TableExplorer
                      className="mt-5"
                      defaultOpen
                      description="Consulta cada liquidación, compara sus montos y abre el detalle sin perder el alcance de fundo y año seleccionado."
                      filter={{
                        label: "Período",
                        allLabel: "Todos los períodos",
                        columnIndex: 0,
                      }}
                      id="leche.liquidaciones"
                      maxHeight="30rem"
                      searchPlaceholder="Buscar período, orden de compra o monto…"
                      title="Historial de liquidaciones"
                    >
                      <table className="w-full min-w-[760px] text-left">
                        <thead>
                          <tr>
                            {[
                              "Período",
                              "Producción",
                              "Precio neto",
                              "Neto",
                              "Total",
                              "",
                            ].map((header) => (
                              <th
                                className="border-b border-line-steel px-2 py-2 text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle"
                                key={header}
                              >
                                {header}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((settlement) => (
                            <tr
                              className={
                                settlement.id === selectedSettlement?.id
                                  ? "bg-surface-alt"
                                  : ""
                              }
                              key={settlement.id}
                            >
                              <td className="border-b border-line-steel px-2 py-3">
                                <button
                                  className="text-left"
                                  onClick={() =>
                                    setSelectedSettlementId(settlement.id)
                                  }
                                  type="button"
                                >
                                  <p className="text-xs font-black text-ink">
                                    {formatPeriod(settlement.period)}
                                  </p>
                                  <p className="mt-0.5 text-[12px] text-ink-subtle">
                                    OC {settlement.purchaseOrder}
                                  </p>
                                </button>
                              </td>
                              <td className="border-b border-line-steel px-2 py-3 text-right text-xs font-bold text-ink">
                                {formatNumber(settlement.totalLiters, 0)} L
                              </td>
                              <td className="border-b border-line-steel px-2 py-3 text-right text-xs text-ink-muted">
                                {formatClpDecimal(
                                  settlement.netPricePerLiterClp,
                                )}
                              </td>
                              <td className="border-b border-line-steel px-2 py-3 text-right text-xs font-bold text-ink">
                                {formatClp(settlement.netAmountClp)}
                              </td>
                              <td className="border-b border-line-steel px-2 py-3 text-right text-xs font-black text-ink">
                                {formatClp(settlement.grossAmountClp)}
                              </td>
                              <td className="border-b border-line-steel px-2 py-3">
                                <button
                                  aria-label={`Ver ${formatPeriod(settlement.period)}`}
                                  className="grid size-8 place-items-center rounded-lg text-accent hover:bg-surface-alt"
                                  onClick={() =>
                                    setSelectedSettlementId(settlement.id)
                                  }
                                  type="button"
                                >
                                  <ChevronRight size={15} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableExplorer>
                  ) : (
                    <EmptyState text="No hay liquidaciones para esta selección." />
                  )}
                </Panel>
              </section>

              {selectedSettlement && (
                <section className="mt-5 pb-8">
                  <SettlementDetail
                    fundoName={
                      fundoById.get(selectedSettlement.fieldId)?.name ?? "Fundo"
                    }
                    onDelete={() => setConfirmDelete(selectedSettlement)}
                    onEdit={() => setManagedSettlement(selectedSettlement)}
                    settlement={selectedSettlement}
                  />
                </section>
              )}
            </>
          ) : activeSection === "simulator" ? (
            <section className="mt-5 pb-8">
              <MilkPriceSimulator
                fundos={fundos}
                key={`simulator-${selectedFundoId}`}
                selectedFundoId={selectedFundoId}
                settlements={settlements}
              />
            </section>
          ) : snapshot ? (
            <MilkModuleSections
              fundos={fundos}
              key={`${activeSection}-${selectedFundoId}`}
              onRefresh={() => refreshSnapshot(selectedYear, true)}
              section={activeSection}
              selectedFundoId={selectedFundoId}
              selectedYear={selectedYear}
              settlements={settlements}
              snapshot={snapshot}
            />
          ) : (
            <ModuleSectionLoading />
          )}
          {error && (
            <p className="mb-8 rounded-xl bg-red-50 px-4 py-3 text-xs font-bold text-red-800">
              {error}
            </p>
          )}
        </div>
      </div>

      {managedSettlement && (
        <ManageMilkSettlementDialog
          fundos={fundos}
          onClose={() => setManagedSettlement(null)}
          onSave={saveSettlement}
          settlement={managedSettlement === "new" ? null : managedSettlement}
        />
      )}
      {confirmDelete && (
        <div className="fixed inset-0 z-[1250] grid place-items-center bg-black/45 p-4 backdrop-blur-sm">
          <div
            aria-modal="true"
            className="w-full max-w-md rounded-[22px] bg-white p-5 shadow-2xl"
            ref={deleteDialogRef}
            role="dialog"
            tabIndex={-1}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[12px] font-black uppercase tracking-wide text-red-700">
                  Eliminar liquidación
                </p>
                <h2 className="mt-1 text-lg font-black text-ink">
                  {formatPeriod(confirmDelete.period)}
                </h2>
              </div>
              <button
                aria-label="Cerrar"
                className="grid size-8 place-items-center rounded-lg"
                onClick={closeDeleteDialog}
                type="button"
              >
                <X size={17} />
              </button>
            </div>
            <p className="mt-3 text-xs leading-5 text-ink-muted">
              Se eliminará la orden {confirmDelete.purchaseOrder} y todo su
              detalle. Esta acción no se puede deshacer.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                className="h-10 rounded-xl border border-line-steel px-4 text-xs font-black"
                onClick={closeDeleteDialog}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="flex h-10 items-center gap-2 rounded-xl bg-red-700 px-4 text-xs font-black text-white disabled:opacity-60"
                disabled={deleting}
                onClick={deleteSettlement}
                type="button"
              >
                {deleting ? (
                  <LoaderCircle className="animate-spin" size={14} />
                ) : (
                  <Trash2 size={14} />
                )}{" "}
                Eliminar
              </button>
            </div>
          </div>
        </div>
      )}
    </AppShell>
  );
}

function ModuleSectionLoading() {
  return (
    <section aria-live="polite" className="mt-5 flex min-h-64 items-center justify-center rounded-[20px] border border-line-steel bg-white p-8 text-center shadow-[0_8px_30px_rgba(35,50,42,0.04)]">
      <div>
        <LoaderCircle className="mx-auto animate-spin text-accent" size={24} />
        <p className="mt-3 text-xs font-black text-ink">Cargando esta sección…</p>
        <p className="mt-1 text-[12px] text-ink-subtle">Se conservará en memoria mientras sigas en Leche.</p>
      </div>
    </section>
  );
}

function SettlementDetail({
  settlement,
  fundoName,
  onEdit,
  onDelete,
}: {
  settlement: MilkSettlement;
  fundoName: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const lineItemTotal = settlement.lineItems.reduce(
    (sum, item) => sum + item.amountClp,
    0,
  );
  const analysis = analyzeMilkSettlement(settlement);
  const qualityMetrics: { label: string; value: number | null; suffix: string; digits: number; help: HelpKey }[] = [
    { label: "Grasa", value: analysis.quality.fatPct, suffix: "%", digits: 2, help: "lecheGrasa" },
    {
      label: "Proteína",
      value: analysis.quality.proteinPct,
      suffix: "%",
      digits: 2,
      help: "lecheProteina",
    },
    {
      label: "Sólidos",
      value: analysis.quality.totalSolidsPct,
      suffix: "%",
      digits: 2,
      help: "lecheSolidos",
    },
    {
      label: "RCS",
      value: analysis.quality.somaticCellCount,
      suffix: "/ml",
      digits: 0,
      help: "rcs",
    },
    {
      label: "UFC",
      value: analysis.quality.bacterialCountUfc,
      suffix: "/ml",
      digits: 0,
      help: "ufc",
    },
  ];
  return (
    <Panel>
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">
            Detalle de la liquidación
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.04em] text-ink">
            {formatPeriod(settlement.period)} · {settlement.buyerName}
          </h2>
          <p className="mt-1 text-[12px] font-semibold text-ink-subtle">
            {fundoName} · Productor {settlement.producerCode}{" "}
            {settlement.producerName} · OC {settlement.purchaseOrder}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            className="flex h-9 items-center gap-2 rounded-xl border border-line-steel px-3 text-[12px] font-black text-ink-muted"
            onClick={onEdit}
            type="button"
          >
            <Pencil size={13} /> Editar
          </button>
          <button
            className="flex h-9 items-center gap-2 rounded-xl border border-red-100 px-3 text-[12px] font-black text-red-700"
            onClick={onDelete}
            type="button"
          >
            <Trash2 size={13} /> Eliminar
          </button>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MiniStat
          label="Primera quincena"
          value={
            settlement.litersFirstHalf === null
              ? "Sin dato"
              : `${formatNumber(settlement.litersFirstHalf, 0)} L`
          }
        />
        <MiniStat
          label="Segunda quincena"
          value={
            settlement.litersSecondHalf === null
              ? "Sin dato"
              : `${formatNumber(settlement.litersSecondHalf, 0)} L`
          }
        />
        <MiniStat
          label="Monto neto"
          value={formatClp(settlement.netAmountClp)}
        />
        <MiniStat label="IVA" value={formatClp(settlement.taxAmountClp)} />
        <MiniStat
          label="Total"
          value={formatClp(settlement.grossAmountClp)}
          strong
        />
      </div>

      <div className="mt-5 rounded-2xl border border-line-steel bg-surface-alt p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <FlaskConical className="text-accent" size={16} />
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.13em] text-accent">
                Calidad estructurada
              </p>
              <p className="mt-0.5 text-[12px] text-ink-subtle">
                Valores normalizados desde el detalle de la liquidación
              </p>
            </div>
          </div>
          {analysis.alerts.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {analysis.alerts.map((alert) => (
                <span
                  className="flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-[12px] font-black text-amber-900"
                  key={alert.code}
                >
                  <AlertTriangle size={11} /> {alert.message}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-5">
          {qualityMetrics.map((metric) => (
            <div
              className="rounded-xl bg-white px-3 py-3 shadow-sm ring-1 ring-line-steel"
              key={metric.label}
            >
              <p className="flex items-center gap-1 text-[12px] font-black uppercase tracking-wide text-ink-subtle">
                {metric.label}
                <HelpTip help={metric.help} label={metric.label} />
              </p>
              <p className="mt-1 text-sm font-black text-ink">
                {metric.value === null
                  ? "Sin dato"
                  : `${formatNumber(metric.value, metric.digits)} ${metric.suffix}`}
              </p>
            </div>
          ))}
        </div>
        {analysis.quality.observations.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {analysis.quality.observations.map((observation, index) => (
              <span
                className="rounded-lg bg-surface-alt px-2 py-1 text-[12px] font-bold text-ink-muted"
                key={`${observation.metric}-${observation.periodPart}-${index}`}
              >
                {observation.periodPart === "firstHalf"
                  ? "1ª qna"
                  : observation.periodPart === "secondHalf"
                    ? "2ª qna"
                    : "Período"}{" "}
                · {observation.description}:{" "}
                {formatNumber(
                  observation.value,
                  observation.unit === "percent" ? 2 : 0,
                )}
              </span>
            ))}
          </div>
        )}
      </div>

      {analysis.payment.categories.length > 0 && (
        <div className="mt-5">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-[12px] font-black uppercase tracking-[0.13em] text-accent">
                Aporte al precio por concepto
              </p>
              <p className="mt-1 text-[12px] text-ink-subtle">
                Base, composición, calidad, sanitario y bonos expresados en
                CLP/L
              </p>
            </div>
            <p className="text-xs font-black text-ink">
              {analysis.payment.totalAmountPerLiterClp === null
                ? "—"
                : formatClpDecimal(
                    analysis.payment.totalAmountPerLiterClp,
                  )}{" "}
              / L
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {analysis.payment.categories
              .filter((category) => category.lineItemCount > 0)
              .map((category) => (
                <div
                  className="rounded-xl border border-line-steel px-3 py-3"
                  key={category.category}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[12px] font-black uppercase tracking-wide text-ink-subtle">
                      {category.label}
                    </p>
                    <p className="text-[12px] font-bold text-ink-subtle">
                      {category.sharePct === null
                        ? "—"
                        : `${formatNumber(category.sharePct, 1)}%`}
                    </p>
                  </div>
                  <div className="mt-1 flex items-baseline justify-between gap-2">
                    <p className="text-sm font-black text-ink">
                      {category.amountPerLiterClp === null
                        ? "—"
                        : `${formatClpDecimal(category.amountPerLiterClp)}/L`}
                    </p>
                    <p
                      className={`text-[12px] font-bold ${category.amountClp < 0 ? "text-red-700" : "text-accent"}`}
                    >
                      {formatClp(category.amountClp)}
                    </p>
                  </div>
                </div>
              ))}
          </div>
        </div>
      )}

      {settlement.lineItems.length > 0 && (
        <div className="mt-5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p
              className={`ml-auto text-[12px] font-bold ${lineItemTotal === settlement.netAmountClp ? "text-accent" : "text-red-700"}`}
            >
              Detalle {formatClp(lineItemTotal)} · Neto{" "}
              {formatClp(settlement.netAmountClp)}
            </p>
          </div>
          <TableExplorer
            defaultOpen
            description="Desglosa los conceptos que forman el pago neto y permite localizar rápidamente una bonificación, descuento o medición."
            filter={{
              label: "Concepto",
              allLabel: "Todos los conceptos",
              columnIndex: 0,
            }}
            id="leche.composicion-pago"
            maxHeight="20rem"
            searchPlaceholder="Buscar concepto, medición o monto…"
            title="Composición del pago"
          >
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr>
                  {["Concepto", "Medición", "$/L", "A pago"].map((header) => (
                    <th
                      className="border-b border-line-steel px-3 py-2 text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle"
                      key={header}
                    >
                      {header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {settlement.lineItems.map((item, index) => (
                  <tr key={`${item.description}-${index}`}>
                    <td className="border-b border-line-steel px-3 py-2.5 text-xs font-bold text-ink">
                      {item.description}
                    </td>
                    <td className="border-b border-line-steel px-3 py-2.5 text-right text-xs text-ink-muted">
                      {item.measurement ?? "—"}
                    </td>
                    <td className="border-b border-line-steel px-3 py-2.5 text-right text-xs text-ink-muted">
                      {item.unitPriceClp === null
                        ? "—"
                        : formatClpDecimal(item.unitPriceClp)}
                    </td>
                    <td className="border-b border-line-steel px-3 py-2.5 text-right text-xs font-black text-ink">
                      {formatClp(item.amountClp)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableExplorer>
        </div>
      )}

      <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 rounded-2xl bg-surface-alt px-4 py-3 text-[12px] font-semibold text-ink-muted">
        <span>
          Planta: <strong className="text-ink">{settlement.plant}</strong>
        </span>
        <span>
          Documento:{" "}
          <strong className="text-ink">
            {settlement.sourceDocumentName ?? "Sin referencia"}
          </strong>
        </span>
        {settlement.generatedAt && (
          <span>
            Generada:{" "}
            <strong className="text-ink">
              {new Date(settlement.generatedAt).toLocaleString("es-CL")}
            </strong>
          </span>
        )}
        {settlement.notes && (
          <span className="basis-full">{settlement.notes}</span>
        )}
      </div>
    </Panel>
  );
}

function FilterSelect({
  label,
  children,
  value,
  onChange,
}: {
  label: string;
  children: React.ReactNode;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label>
      <span className="mb-1.5 block text-[12px] font-black uppercase tracking-wide text-ink-subtle">
        {label}
      </span>
      <select
        className="h-11 w-full rounded-xl border border-line-steel bg-surface-alt px-3 text-xs font-black text-ink outline-none focus:border-accent"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

function StatCard({
  help,
  helpText,
  icon: Icon,
  label,
  value,
  detail,
  tone = "default",
}: {
  help?: HelpKey;
  helpText?: string;
  icon: typeof Milk;
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "dark" | "amber";
}) {
  const tones = {
    default: "bg-white",
    dark: "bg-ink",
    amber: "bg-surface-alt",
  };
  return (
    <article
      className={`rounded-[18px] border border-line-steel p-4 shadow-[0_6px_24px_rgba(35,50,42,0.04)] ${tones[tone]}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p
            className={`flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] ${tone === "dark" ? "text-white/50" : "text-ink-subtle"}`}
          >
            {label}
            <HelpTip help={help} label={label} text={helpText} tone={tone === "dark" ? "inverse" : "muted"} />
          </p>
          <p
            className={`mt-2 truncate text-xl font-black tracking-[-0.045em] sm:text-2xl ${tone === "dark" ? "text-white" : "text-ink"}`}
          >
            {value}
          </p>
          <p
            className={`mt-1 text-[12px] font-semibold ${tone === "dark" ? "text-white/50" : "text-ink-subtle"}`}
          >
            {detail}
          </p>
        </div>
        <span
          className={`grid size-9 shrink-0 place-items-center rounded-xl ${tone === "dark" ? "bg-white/10 text-white" : tone === "amber" ? "bg-warn-bg text-warn-ink" : "bg-surface-alt text-accent"}`}
        >
          <Icon size={17} />
        </span>
      </div>
    </article>
  );
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <article className="rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_38px_rgba(35,50,42,0.05)] sm:p-6">
      {children}
    </article>
  );
}

function PanelHeader({
  eyebrow,
  help,
  helpText,
  icon: Icon,
  title,
}: {
  eyebrow: string;
  help?: HelpKey;
  helpText?: string;
  icon: typeof Milk;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-surface-alt text-accent">
        <Icon size={18} />
      </span>
      <div>
        <p className="text-[12px] font-black uppercase tracking-[0.14em] text-accent">
          {eyebrow}
        </p>
        <h2 className="mt-1 flex items-center gap-1.5 text-base font-black tracking-[-0.035em] text-ink">
          {title}
          <HelpTip help={help} label={title} text={helpText} />
        </h2>
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl p-4 ${strong ? "bg-ink text-white" : "bg-surface-alt"}`}
    >
      <p
        className={`text-[12px] font-black uppercase tracking-wide ${strong ? "text-white/50" : "text-ink-subtle"}`}
      >
        {label}
      </p>
      <p
        className={`mt-1 text-sm font-black ${strong ? "text-white" : "text-ink"}`}
      >
        {value}
      </p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="mt-5 grid min-h-36 place-items-center rounded-2xl border border-dashed border-line-steel bg-surface-alt p-5 text-center">
      <div>
        <Milk className="mx-auto text-accent" size={24} />
        <p className="mt-2 text-xs font-black text-ink">{text}</p>
      </div>
    </div>
  );
}

function formatPeriod(value: string) {
  return new Date(`${value}-01T12:00:00`).toLocaleDateString("es-CL", {
    month: "long",
    year: "numeric",
  });
}

function formatNumber(value: number, maximumFractionDigits: number) {
  return value.toLocaleString("es-CL", { maximumFractionDigits });
}

function formatClp(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatClpDecimal(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(value);
}

function snapshotCutoff(year: string): string | undefined {
  if (year === ALL) return undefined;
  const current = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const yearEnd = `${year}-12-31`;
  return yearEnd > current ? current : yearEnd;
}

function snapshotCacheKey(asOf: string | undefined): string {
  return asOf ?? "latest";
}

function sectionNeedsOperationalSnapshot(section: MilkModuleSection): boolean {
  return section !== "settlements" && section !== "simulator";
}
