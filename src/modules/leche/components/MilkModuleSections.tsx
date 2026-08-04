"use client";

import type {
  Fundo,
  MilkBulkProduction,
  MilkSettlement,
  PabcoComplianceItem,
  PabcoComplianceRequirement,
  PabcoComplianceStatus,
} from "@/src/core/domain/types";
import { Field } from "@/src/ui/form";
import { HelpTip } from "@/src/ui/Hint";
import type { HelpKey } from "@/src/ui/help-copy";
import { TableExplorer } from "@/src/ui/TableExplorer";
import {
  AlertTriangle,
  Beef,
  BellRing,
  CalendarCheck,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Droplets,
  FlaskConical,
  HeartPulse,
  LoaderCircle,
  Mail,
  Plus,
  RefreshCw,
  ShieldAlert,
  Stethoscope,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  fetchPabcoNotificationPreferences,
  persistBulkMilkControls,
  persistMilkBulkProduction,
  persistMilkQualitySample,
  persistPabcoComplianceItem,
  persistPabcoNotificationPreferences,
  removeMilkOperation,
  uploadPabcoEvidence,
} from "../api/milk-operations-client";
import type {
  MilkMammaryHealthSummary,
  MilkMammaryWorkItem,
  MilkModuleSection,
  MilkModuleSnapshot,
  MilkReproductionKpis,
} from "../domain/types";
import {
  resolvePabcoComplianceEditor,
} from "../domain/pabco-compliance-editor.mjs";
import {
  isDownloadablePabcoEvidenceReference,
} from "../domain/pabco-evidence-reference.mjs";
import {
  resolvePabcoNotificationPreferenceEditor,
} from "../domain/pabco-notification-preference-editor.mjs";
import {
  derivePabcoComplianceStatus,
  selectDuePabcoReminderWorkItems,
} from "../domain/pabco-notification-rules.mjs";

type Props = {
  // "simulator" is rendered by MilkPriceSimulator from LechePage, so it must stay out
  // of this union: the routing below falls through to HealthSection and would show the
  // wrong screen for any section it does not name.
  section: Exclude<MilkModuleSection, "settlements" | "simulator">;
  fundos: Fundo[];
  settlements: MilkSettlement[];
  snapshot: MilkModuleSnapshot;
  selectedFundoId: string;
  selectedYear: string;
  onRefresh: () => Promise<void>;
};

const ALL = "all";
const EMPTY_REPRODUCTION_KPIS: MilkReproductionKpis = {
  openDaysAverage: null,
  calvingIntervalDaysAverage: null,
  pregnancyRatePercent: null,
  conceptionRatePercent: null,
  heatDetectionRatePercent: null,
};
const EMPTY_MAMMARY_HEALTH: MilkMammaryHealthSummary = {
  evaluatedAnimalCount: 0,
  currentAnimalCount: 0,
  staleAnimalCount: 0,
  herdSomaticCellCount: null,
  herdStatus: "unknown",
  mastitisCaseCount: 0,
  highRiskAnimalIds: [],
};

export function MilkModuleSections(props: Props) {
  if (props.section === "production") return <ProductionSection {...props} />;
  if (props.section === "herd") return <HerdSection {...props} />;
  if (props.section === "reproduction")
    return <ReproductionSection {...props} />;
  return <HealthSection {...props} />;
}

function ProductionSection({
  fundos,
  snapshot,
  selectedFundoId,
  selectedYear,
  onRefresh,
}: Props) {
  const fieldId =
    selectedFundoId === ALL ? (fundos[0]?.id ?? "") : selectedFundoId;
  const [productionOpen, setProductionOpen] = useState(false);
  const [qualityOpen, setQualityOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [productionForm, setProductionForm] = useState({
    fieldId,
    recordedAt: today(),
    kind: "tank_total",
    volumeLiters: "",
    notes: "",
  });
  const [qualityForm, setQualityForm] = useState({
    fieldId,
    sampledAt: today(),
    fat: "",
    protein: "",
    solids: "",
    rcs: "",
    ufc: "",
    notes: "",
  });
  const production = snapshot.bulkProduction.filter((row) =>
    matches(row.fieldId, row.recordedAt, selectedFundoId, selectedYear),
  );
  const quality = snapshot.qualitySamples.filter((row) =>
    matches(row.fieldId, row.sampledAt, selectedFundoId, selectedYear),
  );
  const reconciliation = snapshot.reconciliation.filter(
    (row) =>
      (selectedFundoId === ALL || row.fieldId === selectedFundoId) &&
      (selectedYear === ALL || row.period.startsWith(selectedYear)),
  );
  const produced = reconciliation.reduce(
    (sum, row) => sum + row.litersProduced,
    0,
  );
  const settled = reconciliation.reduce(
    (sum, row) => sum + row.litersSettled,
    0,
  );
  const net = reconciliation.reduce((sum, row) => sum + row.netAmountClp, 0);
  const deviation =
    produced > 0 ? ((settled - produced) / produced) * 100 : null;

  async function saveProduction(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await persistMilkBulkProduction({
        id: `milk-bulk-${crypto.randomUUID()}`,
        organizationId: "",
        fieldId: productionForm.fieldId,
        recordedAt: productionForm.recordedAt,
        kind: productionForm.kind as MilkBulkProduction["kind"],
        volumeLiters: requiredNumber(
          productionForm.volumeLiters,
          "Ingresa los litros producidos.",
        ),
        source: "manual",
        sourceRecordId: null,
        notes: productionForm.notes,
        createdBy: "",
        createdAt: now,
        updatedAt: now,
      });
      setProductionForm((current) => ({
        ...current,
        volumeLiters: "",
        notes: "",
      }));
      setProductionOpen(false);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function saveQuality(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await persistMilkQualitySample({
        id: `milk-quality-${crypto.randomUUID()}`,
        organizationId: "",
        fieldId: qualityForm.fieldId,
        sampledAt: qualityForm.sampledAt,
        period: qualityForm.sampledAt.slice(0, 7),
        kind: "bulk_tank",
        fatPercent: nullableNumber(qualityForm.fat),
        proteinPercent: nullableNumber(qualityForm.protein),
        totalSolidsPercent: nullableNumber(qualityForm.solids),
        somaticCellCount: nullableInteger(qualityForm.rcs),
        somaticCellCountUnit: qualityForm.rcs ? "cells_per_ml" : null,
        bacterialCount: nullableInteger(qualityForm.ufc),
        bacterialCountUnit: qualityForm.ufc ? "cfu_per_ml" : null,
        sanitaryFlags: {},
        source: "manual",
        sourceRecordId: null,
        notes: qualityForm.notes,
        createdBy: "",
        createdAt: now,
        updatedAt: now,
      });
      setQualityForm((current) => ({
        ...current,
        fat: "",
        protein: "",
        solids: "",
        rcs: "",
        ufc: "",
        notes: "",
      }));
      setQualityOpen(false);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function deleteRecord(
    resource: "bulk_production" | "quality_sample",
    id: string,
    updatedAt: string,
  ) {
    if (!window.confirm("¿Eliminar este registro lechero manual?")) return;
    setError(null);
    try {
      await removeMilkOperation(resource, id, updatedAt);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  return (
    <div className="mt-5 space-y-5 pb-8">
      <SectionLead
        icon={Droplets}
        eyebrow="Producción física"
        title="Estanque y conciliación"
        text="Compara lo producido en el predio con los litros pagados por la planta y calcula el precio real por litro."
        actions={
          <>
            <ActionButton onClick={() => setProductionOpen((value) => !value)}>
              <Plus size={14} /> Registrar producción
            </ActionButton>
            <ActionButton
              light
              onClick={() => setQualityOpen((value) => !value)}
            >
              <FlaskConical size={14} /> Registrar calidad
            </ActionButton>
            <ActionButton
              light
              onClick={() =>
                downloadCsv(
                  "fundosmart-produccion-leche.csv",
                  [
                    "Período",
                    "Fundo",
                    "Producido L",
                    "Liquidado L",
                    "Desviación %",
                    "Neto CLP",
                    "Precio real CLP/L",
                  ],
                  reconciliation.map((row) => [
                    row.period,
                    row.fieldId,
                    row.litersProduced,
                    row.litersSettled,
                    row.deltaPercent ?? "",
                    row.netAmountClp,
                    row.realPricePerLiterClp ?? "",
                  ]),
                )
              }
            >
              <Download size={14} /> Exportar
            </ActionButton>
          </>
        }
      />
      {error && <ErrorBox text={error} />}
      {productionOpen && (
        <FormPanel title="Producción de estanque">
          <form className="grid gap-3 md:grid-cols-5" onSubmit={saveProduction}>
            <FundoSelect
              fundos={fundos}
              onChange={(value) =>
                setProductionForm({ ...productionForm, fieldId: value })
              }
              value={productionForm.fieldId}
            />
            <Field label="Fecha">
              <input
                className={inputClass}
                onChange={(event) =>
                  setProductionForm({
                    ...productionForm,
                    recordedAt: event.target.value,
                  })
                }
                required
                type="date"
                value={productionForm.recordedAt}
              />
            </Field>
            <Field label="Tipo">
              <select
                className={inputClass}
                onChange={(event) =>
                  setProductionForm({
                    ...productionForm,
                    kind: event.target.value,
                  })
                }
                value={productionForm.kind}
              >
                <option value="tank_total">Total de estanque</option>
                <option value="delivery">Entrega</option>
                <option value="milk_meter_rollup">Rollup medidores</option>
              </select>
            </Field>
            <Field label="Litros">
              <input
                className={inputClass}
                min="0.001"
                onChange={(event) =>
                  setProductionForm({
                    ...productionForm,
                    volumeLiters: event.target.value,
                  })
                }
                required
                step="0.001"
                type="number"
                value={productionForm.volumeLiters}
              />
            </Field>
            <Field label="Notas">
              <input
                className={inputClass}
                onChange={(event) =>
                  setProductionForm({
                    ...productionForm,
                    notes: event.target.value,
                  })
                }
                value={productionForm.notes}
              />
            </Field>
            <SaveButton saving={saving} />
          </form>
        </FormPanel>
      )}
      {qualityOpen && (
        <FormPanel help="lecheEstanque" title="Muestra de calidad de estanque">
          <form
            className="grid gap-3 md:grid-cols-4 xl:grid-cols-8"
            onSubmit={saveQuality}
          >
            <FundoSelect
              fundos={fundos}
              onChange={(value) =>
                setQualityForm({ ...qualityForm, fieldId: value })
              }
              value={qualityForm.fieldId}
            />
            <Field label="Fecha">
              <input
                className={inputClass}
                onChange={(event) =>
                  setQualityForm({
                    ...qualityForm,
                    sampledAt: event.target.value,
                  })
                }
                required
                type="date"
                value={qualityForm.sampledAt}
              />
            </Field>
            {[
              ["Grasa %", "fat"],
              ["Proteína %", "protein"],
              ["Sólidos %", "solids"],
              ["RCS /ml", "rcs"],
              ["UFC /ml", "ufc"],
            ].map(([label, key]) => (
              <Field key={key} label={label}>
                <input
                  className={inputClass}
                  min="0"
                  onChange={(event) =>
                    setQualityForm({
                      ...qualityForm,
                      [key]: event.target.value,
                    })
                  }
                  step={key === "rcs" || key === "ufc" ? "1" : "0.001"}
                  type="number"
                  value={qualityForm[key as keyof typeof qualityForm]}
                />
              </Field>
            ))}
            <SaveButton saving={saving} />
          </form>
        </FormPanel>
      )}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric
          helpText="Litros que salieron del estanque según tus propios registros."
          label="Litros producidos"
          value={`${formatNumber(produced)} L`}
          detail={`${production.length} registros`}
        />
        <Metric
          helpText="Litros que la planta declara haber recibido y por los que efectivamente te pagó."
          label="Litros liquidados"
          value={`${formatNumber(settled)} L`}
          detail="Pago de planta"
        />
        <Metric
          help="lecheDesviacion"
          label="Desviación"
          value={
            deviation === null ? "Sin base" : `${formatDecimal(deviation, 2)}%`
          }
          detail="Pagado menos producido"
          warning={deviation !== null && Math.abs(deviation) > 2}
        />
        <Metric
          help="lechePrecioReal"
          label="$ real por litro"
          value={produced > 0 ? formatClpDecimal(net / produced) : "Sin base"}
          detail="Neto / litros físicos"
        />
      </div>
      <div className="grid gap-5 xl:grid-cols-2">
        <DataPanel title="Registros de producción" icon={Droplets}>
          {production.length ? (
            <Table
              description="Revisa cada registro de estanque y distingue rápidamente su origen antes de corregir o eliminar una captura manual."
              filter={{
                label: "Fuente",
                allLabel: "Todas las fuentes",
                columnIndex: 3,
              }}
              headers={["Fecha", "Tipo", "Litros", "Fuente", ""]}
              id="leche.produccion.registros"
              maxHeight="24rem"
              searchPlaceholder="Buscar fecha, tipo, litros o fuente…"
              title="Producción registrada"
            >
              {production.map((row) => (
                <tr key={row.id}>
                  <Cell strong>{formatDate(row.recordedAt)}</Cell>
                  <Cell>{bulkKindLabel(row.kind)}</Cell>
                  <Cell right>{formatNumber(row.volumeLiters)} L</Cell>
                  <Cell>{sourceLabel(row.source)}</Cell>
                  <Cell right>
                    {row.source === "manual" && (
                      <button
                        aria-label="Eliminar producción"
                        className="text-red-600"
                        onClick={() =>
                          deleteRecord("bulk_production", row.id, row.updatedAt)
                        }
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </Cell>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text="Aún no hay registros de estanque." />
          )}
        </DataPanel>
        <DataPanel help="lecheConciliacion" title="Conciliación por período" icon={RefreshCw}>
          {reconciliation.length ? (
            <Table
              description="Compara la leche producida con la liquidada y detecta períodos cuya diferencia requiere revisión."
              filter={{
                label: "Período",
                allLabel: "Todos los períodos",
                columnIndex: 0,
              }}
              headers={["Período", "Producido", "Pagado", "Δ", "$ real/L"]}
              id="leche.produccion.conciliacion"
              maxHeight="22rem"
              searchPlaceholder="Buscar período, volumen o precio…"
              title="Períodos conciliados"
            >
              {reconciliation.map((row) => (
                <tr key={`${row.fieldId}-${row.period}`}>
                  <Cell strong>{formatPeriod(row.period)}</Cell>
                  <Cell right>{formatNumber(row.litersProduced)} L</Cell>
                  <Cell right>{formatNumber(row.litersSettled)} L</Cell>
                  <Cell
                    right
                    danger={
                      row.deltaPercent !== null &&
                      Math.abs(row.deltaPercent) > 2
                    }
                  >
                    {row.deltaPercent === null
                      ? "—"
                      : `${formatDecimal(row.deltaPercent, 2)}%`}
                  </Cell>
                  <Cell right strong>
                    {row.realPricePerLiterClp === null
                      ? "—"
                      : formatClpDecimal(row.realPricePerLiterClp)}
                  </Cell>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text="Registra producción para iniciar la conciliación." />
          )}
        </DataPanel>
        <DataPanel help="lecheEstanque" title="Calidad de estanque" icon={FlaskConical}>
          {quality.length ? (
            <Table
              description="Consulta las muestras del estanque y localiza valores de sólidos, RCS o UFC que necesiten atención."
              filter={{
                label: "Fecha de muestra",
                allLabel: "Todas las fechas",
                columnIndex: 0,
              }}
              headers={["Fecha", "Grasa", "Proteína", "RCS", "UFC", ""]}
              id="leche.produccion.calidad"
              maxHeight="24rem"
              searchPlaceholder="Buscar fecha o resultado de calidad…"
              title="Muestras de calidad"
            >
              {quality.map((row) => (
                <tr key={row.id}>
                  <Cell strong>{formatDate(row.sampledAt)}</Cell>
                  <Cell right>{percent(row.fatPercent)}</Cell>
                  <Cell right>{percent(row.proteinPercent)}</Cell>
                  <Cell
                    right
                    danger={
                      normalizedCount(
                        row.somaticCellCount,
                        row.somaticCellCountUnit,
                      ) > 700000
                    }
                  >
                    {count(row.somaticCellCount, row.somaticCellCountUnit)}
                  </Cell>
                  <Cell
                    right
                    danger={
                      normalizedCount(
                        row.bacterialCount,
                        row.bacterialCountUnit,
                      ) > 1000000
                    }
                  >
                    {count(row.bacterialCount, row.bacterialCountUnit)}
                  </Cell>
                  <Cell right>
                    {row.source === "manual" && (
                      <button
                        aria-label="Eliminar muestra"
                        className="text-red-600"
                        onClick={() =>
                          deleteRecord("quality_sample", row.id, row.updatedAt)
                        }
                        type="button"
                      >
                        <Trash2 size={14} />
                      </button>
                    )}
                  </Cell>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text="Aún no hay muestras estructuradas." />
          )}
        </DataPanel>
      </div>
    </div>
  );
}

function HerdSection({
  snapshot,
  selectedFundoId,
  selectedYear,
  onRefresh,
}: Props) {
  const herd = snapshot.herd.filter(
    (animal) => selectedFundoId === ALL || animal.fieldId === selectedFundoId,
  );
  const [open, setOpen] = useState(false);
  const [controlDate, setControlDate] = useState(today());
  const [selectedLotId, setSelectedLotId] = useState(ALL);
  const [rowsText, setRowsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedCurveAnimalId, setSelectedCurveAnimalId] = useState("");
  const active = herd.filter((animal) => animal.lactationStatus === "active");
  const dry = herd.filter(
    (animal) =>
      animal.lactationStatus === "dry" || animal.lactationStatus === null,
  );
  const lastProduction = active.reduce(
    (sum, animal) => sum + (animal.lastLiters ?? 0),
    0,
  );
  const average = active.length > 0 ? lastProduction / active.length : 0;
  const rankedProduction = active
    .filter((animal) => animal.lastLiters !== null)
    .sort(
      (left, right) =>
        (right.lastLiters ?? 0) - (left.lastLiters ?? 0) ||
        left.tag.localeCompare(right.tag, "es"),
    );
  const productionRank = new Map(
    rankedProduction.map((animal, index) => [animal.animalId, index + 1]),
  );
  const rankedHerd = [...herd].sort(
    (left, right) =>
      (productionRank.get(left.animalId) ?? Number.MAX_SAFE_INTEGER) -
        (productionRank.get(right.animalId) ?? Number.MAX_SAFE_INTEGER) ||
      left.tag.localeCompare(right.tag, "es"),
  );
  const dryOffAlerts = herd.filter((animal) => animal.dryOffAlert);
  const lots = [
    ...new Map(herd.map((animal) => [animal.lotId, animal.lotName])).entries(),
  ];
  const curveAnimal =
    herd.find((animal) => animal.animalId === selectedCurveAnimalId) ??
    herd.find((animal) => animal.controlSeries.length > 0) ??
    herd[0] ??
    null;
  const curveSeries = (curveAnimal?.controlSeries ?? []).filter(
    (control) => selectedYear === ALL || control.date.startsWith(selectedYear),
  );

  async function saveControls(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const byTag = new Map(
        herd
          .filter(
            (animal) => selectedLotId === ALL || animal.lotId === selectedLotId,
          )
          .map((animal) => [animal.tag.trim().toLocaleLowerCase("es"), animal]),
      );
      const rows = rowsText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !/^diio[;\t]/i.test(line))
        .map((line, index) => {
          const [tag, am, pm, third, fat, protein, rcs] = line
            .split(/[;\t]/)
            .map((value) => value.trim());
          const animal = byTag.get((tag ?? "").toLocaleLowerCase("es"));
          if (!animal)
            throw new Error(
              `Fila ${index + 1}: no existe el DIIO ${tag || "vacío"} en el filtro actual.`,
            );
          const morningLiters = nullableNumber(am);
          const afternoonLiters = nullableNumber(pm);
          const thirdMilkingLiters = nullableNumber(third);
          const totalLiters =
            (morningLiters ?? 0) +
            (afternoonLiters ?? 0) +
            (thirdMilkingLiters ?? 0);
          if (totalLiters <= 0)
            throw new Error(
              `Fila ${index + 1}: la suma de ordeñas debe ser mayor que cero.`,
            );
          return {
            animalId: animal.animalId,
            controlDate,
            morningLiters,
            afternoonLiters,
            thirdMilkingLiters,
            totalLiters,
            fatPct: nullableNumber(fat),
            proteinPct: nullableNumber(protein),
            somaticCellCount: nullableInteger(rcs),
          };
        });
      if (!rows.length) throw new Error("Agrega al menos una fila de control.");
      await persistBulkMilkControls(rows);
      setRowsText("");
      setOpen(false);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-5 space-y-5 pb-8">
      <SectionLead
        icon={Beef}
        eyebrow="Rebaño lechero"
        title="Lactancias y producción por vaca"
        text="Vista consolidada de vacas en leche y secas, días en leche, último control, proyección 305 días y RHA."
        actions={
          <>
            <ActionButton onClick={() => setOpen((value) => !value)}>
              <Upload size={14} /> Ingreso masivo
            </ActionButton>
            <ActionButton
              light
              onClick={() =>
                downloadCsv(
                  "fundosmart-rebano-lechero.csv",
                  [
                    "Ranking producción",
                    "DIIO",
                    "Fundo",
                    "Lote",
                    "Estado lactancia",
                    "DEL",
                    "Último control",
                    "Litros",
                    "Proyección 305 d",
                    "RHA",
                    "RCS",
                    "Alerta secado",
                  ],
                  rankedHerd.map((animal) => [
                    productionRank.get(animal.animalId) ?? "",
                    animal.tag,
                    animal.fieldId,
                    animal.lotName,
                    animal.lactationStatus ?? "",
                    animal.daysInMilk ?? "",
                    animal.lastControlDate ?? "",
                    animal.lastLiters ?? "",
                    animal.projected305Liters ?? "",
                    animal.rollingHerdAverageLiters ?? "",
                    animal.somaticCellCount ?? "",
                    dryOffReasonLabel(animal.dryOffReason),
                  ]),
                )
              }
            >
              <Download size={14} /> Exportar
            </ActionButton>
          </>
        }
      />
      {error && <ErrorBox text={error} />}
      {open && (
        <FormPanel help="lecheControlLechero" title="Ingreso masivo de control lechero">
          <form
            className="grid gap-3 lg:grid-cols-[180px_180px_1fr_auto]"
            onSubmit={saveControls}
          >
            <Field label="Fecha del control">
              <input
                className={inputClass}
                onChange={(event) => setControlDate(event.target.value)}
                required
                type="date"
                value={controlDate}
              />
            </Field>
            <Field label="Lote">
              <select
                className={inputClass}
                onChange={(event) => setSelectedLotId(event.target.value)}
                value={selectedLotId}
              >
                <option value={ALL}>Todos los lotes</option>
                {lots.map(([lotId, lotName]) => (
                  <option key={lotId} value={lotId}>
                    {lotName}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Filas: DIIO; AM; PM; 3ra; grasa; proteína; RCS">
              <textarea
                className={`${inputClass} min-h-28 py-2 font-mono`}
                onChange={(event) => setRowsText(event.target.value)}
                placeholder={"DIIO-101; 12,4; 10,8; ; 4,2; 3,6; 180000"}
                value={rowsText}
              />
            </Field>
            <SaveButton label="Guardar controles" saving={saving} />
          </form>
        </FormPanel>
      )}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Metric
          helpText="Vacas que hoy se están ordeñando. Las secas descansan antes del próximo parto y no producen."
          label="Vacas en leche"
          value={String(active.length)}
          detail={`${dry.length} secas/sin lactancia`}
        />
        <Metric
          help="lecheControlLechero"
          label="Último control"
          value={`${formatDecimal(lastProduction, 1)} L`}
          detail="Suma por vaca"
        />
        <Metric
          help="dashLitrosVacaDia"
          label="Litros/vaca/día"
          value={`${formatDecimal(average, 1)} L`}
          detail="Vacas en ordeña"
        />
        <Metric
          help="lecheProyeccion305"
          label="Con proyección 305 d"
          value={String(
            herd.filter((animal) => animal.projected305Liters !== null).length,
          )}
          detail="Lactancias con datos"
        />
        <Metric
          help="lecheSecado"
          label="Alertas de secado"
          value={String(dryOffAlerts.length)}
          detail="≥305 DEL o ≤8 L/d desde 220 DEL"
          warning={dryOffAlerts.length > 0}
        />
      </div>
      <DataPanel help="lecheCurvaLactancia" title="Curva de lactancia individual" icon={Droplets}>
        {herd.length ? (
          <div>
            <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <Field label="Vaca">
                <select
                  className={`${inputClass} min-w-52`}
                  onChange={(event) =>
                    setSelectedCurveAnimalId(event.target.value)
                  }
                  value={curveAnimal?.animalId ?? ""}
                >
                  {herd.map((animal) => (
                    <option key={animal.animalId} value={animal.animalId}>
                      {animal.tag} · {animal.lotName}
                    </option>
                  ))}
                </select>
              </Field>
              {curveAnimal && (
                <p className="text-[12px] font-bold text-ink-muted">
                  DEL {curveAnimal.daysInMilk ?? "—"} · Proyección 305 d{" "}
                  {numberOrDash(curveAnimal.projected305Liters, 0)} L · RHA{" "}
                  {numberOrDash(curveAnimal.rollingHerdAverageLiters, 0)} L
                </p>
              )}
            </div>
            {curveSeries.length ? (
              <LactationCurve series={curveSeries} />
            ) : (
              <Empty text="La vaca seleccionada no tiene controles en el período." />
            )}
          </div>
        ) : (
          <Empty text="No hay vacas lecheras para graficar." />
        )}
      </DataPanel>
      <DataPanel helpText="Estado actual de cada vaca del rebaño lechero: en ordeña, seca, preñada o vacía. Se actualiza con cada evento registrado." title="Inventario dinámico" icon={Beef}>
        {herd.length ? (
          <Table
            description="Explora el desempeño individual del rebaño, su estado de lactancia y las alertas que requieren seguimiento."
            filter={{
              label: "Estado de lactancia",
              allLabel: "Todos los estados",
              columnIndex: 3,
            }}
            headers={[
              "#",
              "DIIO",
              "Lote",
              "Estado",
              "DEL",
              "Último control",
              "L/día",
              "305 d",
              "RHA",
              "RCS",
              "Alerta secado",
            ]}
            id="leche.rebano.inventario"
            maxHeight="32rem"
            searchPlaceholder="Buscar DIIO, lote, estado o indicador…"
            title="Inventario lechero"
          >
            {rankedHerd.map((animal) => (
              <tr key={animal.animalId}>
                <Cell right strong>
                  {productionRank.get(animal.animalId) ?? "—"}
                </Cell>
                <Cell strong>{animal.tag}</Cell>
                <Cell>{animal.lotName}</Cell>
                <Cell>
                  {animal.lactationStatus === "active"
                    ? "En leche"
                    : animal.lactationStatus === "dry"
                      ? "Seca"
                      : "Sin lactancia"}
                </Cell>
                <Cell right>{animal.daysInMilk ?? "—"}</Cell>
                <Cell>
                  {animal.lastControlDate
                    ? formatDate(animal.lastControlDate)
                    : "—"}
                </Cell>
                <Cell right>{numberOrDash(animal.lastLiters, 1)}</Cell>
                <Cell right>{numberOrDash(animal.projected305Liters, 0)}</Cell>
                <Cell right>
                  {numberOrDash(animal.rollingHerdAverageLiters, 0)}
                </Cell>
                <Cell right danger={(animal.somaticCellCount ?? 0) >= 400000}>
                  {numberOrDash(animal.somaticCellCount, 0)}
                </Cell>
                <Cell>
                  {animal.dryOffAlert ? (
                    <StatusBadge tone="amber">
                      {dryOffReasonLabel(animal.dryOffReason)}
                    </StatusBadge>
                  ) : (
                    "—"
                  )}
                </Cell>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty
            text={
              selectedYear === ALL
                ? "No hay vacas lecheras individualizadas."
                : "No hay datos para el período seleccionado."
            }
          />
        )}
      </DataPanel>
    </div>
  );
}

function ReproductionSection({ snapshot, selectedFundoId }: Props) {
  const workItems = snapshot.reproduction.workItems.filter(
    (item) => selectedFundoId === ALL || item.fieldId === selectedFundoId,
  );
  const kpis =
    selectedFundoId === ALL
      ? snapshot.reproduction.kpis
      : (snapshot.fieldMetrics.find(
          (metrics) => metrics.fieldId === selectedFundoId,
        )?.reproductionKpis ?? EMPTY_REPRODUCTION_KPIS);
  return (
    <div className="mt-5 space-y-5 pb-8">
      <SectionLead
        icon={HeartPulse}
        eyebrow="Reproducción"
        title="KPIs y listas de trabajo"
        text="Prioriza celos, inseminaciones, chequeos de preñez y secados a partir de los eventos de cada vaca."
        actions={
          <ActionButton
            light
            onClick={() =>
              downloadCsv(
                "fundosmart-reproduccion.csv",
                ["DIIO", "Fundo", "Lote", "Acción", "Fecha objetivo", "Motivo"],
                workItems.map((item) => [
                  item.tag,
                  item.fieldId,
                  item.lotName,
                  actionLabel(item.action),
                  item.dueAt,
                  reasonLabel(item.reason),
                ]),
              )
            }
          >
            <Download size={14} /> Exportar
          </ActionButton>
        }
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Metric
          help="reproDiasAbiertos"
          label="Días abiertos"
          value={numberOrDash(kpis.openDaysAverage, 1)}
          detail="Promedio del rebaño"
        />
        <Metric
          help="reproIntervaloPartos"
          label="Intervalo entre partos"
          value={numberOrDash(kpis.calvingIntervalDaysAverage, 1)}
          detail="Días promedio"
        />
        <Metric
          help="analiticaTasaPrenez"
          label="Tasa de preñez"
          value={percent(kpis.pregnancyRatePercent)}
          detail="Ventana 365 días"
        />
        <Metric
          help="reproTasaConcepcion"
          label="Tasa de concepción"
          value={percent(kpis.conceptionRatePercent)}
          detail="Servicios positivos"
        />
        <Metric
          help="reproDeteccionCelo"
          label="Detección de celo"
          value={percent(kpis.heatDetectionRatePercent)}
          detail="Ciclos detectados"
        />
      </div>
      <DataPanel helpText="Qué vaca hay que revisar, inseminar o secar esta semana, ordenado por lo que ya está atrasado." title="Lista de trabajo reproductiva" icon={CalendarCheck}>
        {workItems.length ? (
          <Table
            description="Prioriza las próximas acciones reproductivas por vaca, lote, fecha objetivo y motivo calculado."
            filter={{
              label: "Acción",
              allLabel: "Todas las acciones",
              columnIndex: 2,
            }}
            headers={["Vaca", "Lote", "Acción", "Fecha objetivo", "Motivo"]}
            id="leche.reproduccion.trabajo"
            maxHeight="26rem"
            searchPlaceholder="Buscar vaca, lote, acción o motivo…"
            title="Trabajo reproductivo"
          >
            {workItems.map((item) => (
              <tr key={`${item.animalId}-${item.action}-${item.dueAt}`}>
                <Cell strong>{item.tag}</Cell>
                <Cell>{item.lotName}</Cell>
                <Cell>
                  <StatusBadge
                    tone={
                      item.action === "pregnancy_check"
                        ? "amber"
                        : item.action === "dry_off"
                          ? "blue"
                          : "green"
                    }
                  >
                    {actionLabel(item.action)}
                  </StatusBadge>
                </Cell>
                <Cell danger={item.dueAt < snapshot.asOf}>
                  {formatDate(item.dueAt)}
                </Cell>
                <Cell>{reasonLabel(item.reason)}</Cell>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No hay tareas reproductivas calculadas con los eventos actuales." />
        )}
      </DataPanel>
    </div>
  );
}

function HealthSection({
  fundos,
  snapshot,
  selectedFundoId,
  selectedYear,
  onRefresh,
}: Props) {
  const fieldId =
    selectedFundoId === ALL ? (fundos[0]?.id ?? "") : selectedFundoId;
  const withdrawals = snapshot.withdrawals.filter(
    (entry) => selectedFundoId === ALL || entry.fieldId === selectedFundoId,
  );
  const items = snapshot.pabcoItems.filter(
    (item) => selectedFundoId === ALL || item.fieldId === selectedFundoId,
  );
  const quality = snapshot.qualitySamples.filter((row) =>
    matches(row.fieldId, row.sampledAt, selectedFundoId, selectedYear),
  );
  const mammaryHealth =
    selectedFundoId === ALL
      ? snapshot.mammaryHealth
      : (snapshot.fieldMetrics.find(
          (metrics) => metrics.fieldId === selectedFundoId,
        )?.mammaryHealth ?? EMPTY_MAMMARY_HEALTH);
  const mammaryWorkItems = snapshot.mammaryWorkItems.filter(
    (item) => selectedFundoId === ALL || item.fieldId === selectedFundoId,
  );
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evidenceFile, setEvidenceFile] = useState<File | null>(null);
  const [form, setForm] = useState({
    fieldId,
    requirement: "annual_water_analysis" as PabcoComplianceRequirement,
    status: "compliant" as PabcoComplianceStatus,
    validFrom: today(),
    validUntil: "",
    reminderAt: "",
    evidence: "",
    notes: "",
  });
  const [notificationSaving, setNotificationSaving] = useState(false);
  const [notificationMessage, setNotificationMessage] = useState<string | null>(
    null,
  );
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [browserEnabled, setBrowserEnabled] = useState(false);
  const [reminderDays, setReminderDays] = useState(14);
  const notificationEditable = selectedFundoId !== ALL;

  function loadComplianceForm(
    nextFieldId: string,
    nextRequirement: PabcoComplianceRequirement,
  ) {
    setEvidenceFile(null);
    setForm(
      resolvePabcoComplianceEditor(
        items,
        nextFieldId,
        nextRequirement,
        today(),
      ),
    );
  }

  function toggleComplianceEditor() {
    if (open) {
      setOpen(false);
      return;
    }
    loadComplianceForm(fieldId, form.requirement);
    setOpen(true);
  }

  useEffect(() => {
    let cancelled = false;
    void fetchPabcoNotificationPreferences()
      .then((preferences) => {
        if (cancelled) return;
        const editor = resolvePabcoNotificationPreferenceEditor(
          preferences,
          selectedFundoId,
        );
        setEmailEnabled(editor.emailEnabled);
        setBrowserEnabled(editor.browserEnabled);
        setReminderDays(editor.reminderDays);
      })
      .catch((cause) => {
        if (!cancelled) setNotificationMessage(errorMessage(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedFundoId]);

  useEffect(() => {
    if (
      !browserEnabled ||
      !("Notification" in window) ||
      Notification.permission !== "granted"
    )
      return;
    const dueItems = selectDuePabcoReminderWorkItems(
      items,
      today(),
      reminderDays,
    );
    for (const item of dueItems) {
      const storageKey = `fundosmart:pabco-browser:${item.id}:${item.dueDate}`;
      try {
        if (window.localStorage.getItem(storageKey)) continue;
        new Notification(item.title, {
          body: item.detail,
          icon: "/fundosmart-ultra-min-app-icon-192.png",
          tag: storageKey,
        });
        window.localStorage.setItem(storageKey, new Date().toISOString());
      } catch {
        // Browser privacy modes may block notifications or local storage.
      }
    }
  }, [browserEnabled, items, reminderDays]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const current = items.find(
        (item) =>
          item.fieldId === form.fieldId &&
          item.requirement === form.requirement,
      );
      const now = new Date().toISOString();
      const uploadedEvidence = evidenceFile
        ? await uploadPabcoEvidence(form.fieldId, evidenceFile)
        : null;
      const record: PabcoComplianceItem = {
        id: current?.id ?? `pabco-${crypto.randomUUID()}`,
        organizationId: current?.organizationId ?? "",
        fieldId: form.fieldId,
        requirement: form.requirement,
        status: form.status,
        evidenceDocumentId:
          uploadedEvidence?.id ||
          form.evidence ||
          current?.evidenceDocumentId ||
          null,
        validFrom: form.validFrom || null,
        validUntil: form.validUntil || null,
        reminderAt: form.reminderAt || null,
        source: current?.source ?? "manual",
        sourceRecordId: current?.sourceRecordId ?? null,
        notes: form.notes,
        createdBy: current?.createdBy ?? "",
        createdAt: current?.createdAt ?? now,
        updatedAt: current?.updatedAt ?? now,
      };
      await persistPabcoComplianceItem(record);
      setEvidenceFile(null);
      setOpen(false);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  async function remove(item: PabcoComplianceItem) {
    if (!window.confirm("¿Eliminar este requisito PABCO?")) return;
    setError(null);
    try {
      await removeMilkOperation("pabco_item", item.id, item.updatedAt);
      await onRefresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }

  async function saveNotifications() {
    if (!notificationEditable) {
      setNotificationMessage(
        "Selecciona un fundo específico para editar sus recordatorios.",
      );
      return;
    }
    setNotificationSaving(true);
    setNotificationMessage(null);
    try {
      if (browserEnabled) {
        if (!("Notification" in window)) {
          throw new Error("Este navegador no admite notificaciones.");
        }
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          throw new Error("El navegador no autorizó las notificaciones.");
        }
      }
      await persistPabcoNotificationPreferences({
        fieldIds: [selectedFundoId],
        emailEnabled,
        browserEnabled,
        reminderDays,
      });
      if (browserEnabled && Notification.permission === "granted") {
        new Notification("FundoSmart · Recordatorios PABCO", {
          body: `Alertas activadas con ${reminderDays} días de anticipación.`,
          icon: "/fundosmart-ultra-min-app-icon-192.png",
          tag: "fundosmart-pabco-preferences",
        });
      }
      setNotificationMessage(
        "Preferencias de recordatorios PABCO actualizadas.",
      );
    } catch (cause) {
      setNotificationMessage(errorMessage(cause));
    } finally {
      setNotificationSaving(false);
    }
  }

  const complianceStatus = (item: PabcoComplianceItem) =>
    derivePabcoComplianceStatus(item, snapshot.asOf);
  const compliant = items.filter(
    (item) => complianceStatus(item) === "compliant",
  ).length;
  return (
    <div className="mt-5 space-y-5 pb-8">
      <SectionLead
        icon={Stethoscope}
        eyebrow="Sanidad y PABCO"
        title="Resguardos, salud mamaria y cumplimiento"
        text="Evita entregas durante resguardos, sigue RCS/mastitis y reúne la evidencia exigida para PABCO Lechero."
        actions={
          <>
            <ActionButton onClick={toggleComplianceEditor}>
              <ClipboardCheck size={14} /> Actualizar PABCO
            </ActionButton>
            <ActionButton
              light
              onClick={() =>
                downloadCsv(
                  "fundosmart-sanidad-pabco.csv",
                  [
                    "Tipo",
                    "Fundo",
                    "Animal o requisito",
                    "Estado",
                    "Fecha límite",
                    "Documento",
                  ],
                  [
                    ...withdrawals.map((entry) => [
                      "Resguardo",
                      entry.fieldId,
                      entry.tag,
                      entry.noMilkDelivery
                        ? "No entregar leche"
                        : "Sin bloqueo de leche",
                      entry.milkUntil ?? "",
                      entry.productName ?? "",
                    ]),
                    ...mammaryWorkItems.map((item) => [
                      "Salud mamaria",
                      item.fieldId,
                      item.tag,
                      mammaryPriorityLabel(item.priority),
                      item.controlDate ?? "",
                      mammarySignalLabel(item.reasonCodes),
                    ]),
                    ...items.map((item) => [
                      "PABCO",
                      item.fieldId,
                      PABCO_LABELS[item.requirement],
                      PABCO_STATUS_LABELS[complianceStatus(item)],
                      item.validUntil ?? "",
                      item.evidenceDocumentId ?? "",
                    ]),
                  ],
                )
              }
            >
              <Download size={14} /> Exportar
            </ActionButton>
          </>
        }
      />
      {error && <ErrorBox text={error} />}
      <FormPanel helpText="Avisos que se generan solos cuando un requisito PABCO está por vencer, para no quedar fuera de norma." title="Recordatorios automáticos PABCO">
        <div className="grid items-end gap-3 md:grid-cols-[1fr_1fr_1fr_auto]">
          <label className="flex min-h-11 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink">
            <input
              checked={emailEnabled}
              disabled={!notificationEditable}
              onChange={(event) => setEmailEnabled(event.target.checked)}
              type="checkbox"
            />
            <Mail size={14} /> Email programado
          </label>
          <label className="flex min-h-11 items-center gap-2 rounded-xl border border-line-steel bg-white px-3 text-xs font-black text-ink">
            <input
              checked={browserEnabled}
              disabled={!notificationEditable}
              onChange={(event) => setBrowserEnabled(event.target.checked)}
              type="checkbox"
            />
            <BellRing size={14} /> Aviso en navegador
          </label>
          <Field label="Anticipación (días)">
            <input
              className={inputClass}
              disabled={!notificationEditable}
              max="60"
              min="0"
              onChange={(event) => setReminderDays(Number(event.target.value))}
              type="number"
              value={reminderDays}
            />
          </Field>
          <ActionButton
            disabled={notificationSaving || !notificationEditable}
            onClick={saveNotifications}
          >
            {notificationSaving ? (
              <LoaderCircle className="animate-spin" size={14} />
            ) : (
              <BellRing size={14} />
            )}
            Guardar alertas
          </ActionButton>
        </div>
        {!notificationEditable && (
          <p className="mt-3 text-xs font-bold text-ink-muted">
            Selecciona un fundo específico para consultar y editar sus
            recordatorios sin alterar la configuración de los demás.
          </p>
        )}
        {notificationMessage && (
          <p className="mt-3 rounded-xl bg-band px-3 py-2 text-xs font-bold text-accent">
            {notificationMessage}
          </p>
        )}
      </FormPanel>
      {open && (
        <FormPanel help="pabco" title="Requisito PABCO">
          <form
            className="grid gap-3 md:grid-cols-4 xl:grid-cols-8"
            onSubmit={save}
          >
            <FundoSelect
              fundos={fundos}
              onChange={(value) =>
                loadComplianceForm(value, form.requirement)
              }
              value={form.fieldId}
            />
            <Field label="Requisito">
              <select
                className={inputClass}
                onChange={(event) =>
                  loadComplianceForm(
                    form.fieldId,
                    event.target.value as PabcoComplianceRequirement,
                  )
                }
                value={form.requirement}
              >
                {Object.entries(PABCO_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Estado">
              <select
                className={inputClass}
                onChange={(event) =>
                  setForm({
                    ...form,
                    status: event.target.value as PabcoComplianceStatus,
                  })
                }
                value={form.status}
              >
                {Object.entries(PABCO_STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Válido desde">
              <input
                className={inputClass}
                onChange={(event) =>
                  setForm({ ...form, validFrom: event.target.value })
                }
                type="date"
                value={form.validFrom}
              />
            </Field>
            <Field label="Válido hasta">
              <input
                className={inputClass}
                onChange={(event) =>
                  setForm({ ...form, validUntil: event.target.value })
                }
                type="date"
                value={form.validUntil}
              />
            </Field>
            <Field label="Recordatorio">
              <input
                className={inputClass}
                max={form.validUntil || undefined}
                onChange={(event) =>
                  setForm({ ...form, reminderAt: event.target.value })
                }
                type="date"
                value={form.reminderAt}
              />
            </Field>
            <Field label="Documento / folio">
              <input
                className={inputClass}
                onChange={(event) =>
                  setForm({ ...form, evidence: event.target.value })
                }
                value={form.evidence}
              />
            </Field>
            <Field label="Adjuntar evidencia">
              <input
                accept=".pdf,.docx,.xlsx,.jpg,.jpeg,.png,.webp"
                className={`${inputClass} py-2 text-[12px]`}
                onChange={(event) =>
                  setEvidenceFile(event.target.files?.[0] ?? null)
                }
                type="file"
              />
            </Field>
            <div className="md:col-span-2 xl:col-span-4">
              <Field label="Notas">
                <input
                  className={inputClass}
                  onChange={(event) =>
                    setForm({ ...form, notes: event.target.value })
                  }
                  value={form.notes}
                />
              </Field>
            </div>
            <SaveButton saving={saving} />
          </form>
        </FormPanel>
      )}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric
          help="lecheResguardo"
          label="No entregar leche"
          value={String(
            withdrawals.filter((item) => item.noMilkDelivery).length,
          )}
          detail="Resguardos activos"
          warning={withdrawals.some((item) => item.noMilkDelivery)}
        />
        <Metric
          help="rcs"
          label="RCS de rebaño"
          value={
            mammaryHealth.herdSomaticCellCount === null
              ? "Sin dato"
              : formatNumber(mammaryHealth.herdSomaticCellCount)
          }
          detail={mammaryHealth.herdStatus}
          warning={["high", "critical"].includes(
            mammaryHealth.herdStatus,
          )}
        />
        <Metric
          help="lecheMastitis"
          label="Casos de mastitis"
          value={String(mammaryHealth.mastitisCaseCount)}
          detail={`${mammaryWorkItems.length} revisiones priorizadas`}
        />
        <Metric
          help="pabco"
          label="PABCO vigente"
          value={`${compliant}/${items.length || 5}`}
          detail="Requisitos conformes"
        />
      </div>
      <DataPanel
        helpText="Prioriza señales de RCS, controles vencidos y casos mamarios abiertos. La lista propone revisar o repetir controles; no diagnostica ni prescribe."
        title="Trabajo de salud mamaria"
        icon={Stethoscope}
      >
        {mammaryWorkItems.length ? (
          <Table
            description="Ordena las vacas que requieren revisión humana a partir del último RCS, su tendencia, la vigencia del control y casos mamarios abiertos."
            filter={{
              label: "Prioridad",
              allLabel: "Todas las prioridades",
              columnIndex: 2,
            }}
            headers={["Vaca", "Lote", "Prioridad", "Señal", "Último control", "RCS", "Siguiente paso"]}
            id="leche.sanidad.trabajo-mamario"
            maxHeight="26rem"
            searchPlaceholder="Buscar vaca, lote, señal, RCS o prioridad…"
            title="Revisiones mamarias priorizadas"
          >
            {mammaryWorkItems.map((item) => (
              <tr key={item.animalId}>
                <Cell strong>{item.tag}</Cell>
                <Cell>{item.lotName}</Cell>
                <Cell>
                  <StatusBadge tone={mammaryPriorityTone(item.priority)}>
                    {mammaryPriorityLabel(item.priority)}
                  </StatusBadge>
                </Cell>
                <Cell>{mammarySignalLabel(item.reasonCodes)}</Cell>
                <Cell>
                  {item.controlDate
                    ? `${formatDate(item.controlDate)} · ${item.ageDays ?? 0} d`
                    : "Sin control individual"}
                </Cell>
                <Cell right danger={(item.somaticCellCount ?? 0) >= 400000}>
                  {numberOrDash(item.somaticCellCount, 0)}
                </Cell>
                <Cell>{mammaryActionLabel(item.action)}</Cell>
              </tr>
            ))}
          </Table>
        ) : (
          <Empty text="No hay señales mamarias pendientes con los datos actuales." />
        )}
      </DataPanel>
      <div className="grid gap-5 xl:grid-cols-2">
        <DataPanel help="lecheResguardo" title="Resguardos activos" icon={ShieldAlert}>
          {withdrawals.length ? (
            <Table
              description="Ubica tratamientos con resguardo vigente y confirma hasta cuándo se restringe la entrega de leche o carne."
              filter={{
                label: "Condición",
                allLabel: "Todas las condiciones",
                columnIndex: 1,
              }}
              headers={[
                "Vaca",
                "Condición",
                "Producto",
                "Leche hasta",
                "Carne hasta",
              ]}
              id="leche.sanidad.resguardos"
              maxHeight="24rem"
              searchPlaceholder="Buscar vaca, condición, producto o fecha…"
              title="Resguardos sanitarios"
            >
              {withdrawals.map((entry) => (
                <tr key={entry.eventId}>
                  <Cell strong>{entry.tag}</Cell>
                  <Cell>{entry.condition ?? "Tratamiento"}</Cell>
                  <Cell>{entry.productName ?? "—"}</Cell>
                  <Cell danger={entry.noMilkDelivery}>
                    {entry.milkUntil ? formatDate(entry.milkUntil) : "—"}
                  </Cell>
                  <Cell>
                    {entry.meatUntil ? formatDate(entry.meatUntil) : "—"}
                  </Cell>
                </tr>
              ))}
            </Table>
          ) : (
            <Empty text="No hay resguardos activos." />
          )}
        </DataPanel>
        <DataPanel help="pabco" title="Checklist PABCO Lechero" icon={ClipboardCheck}>
          {items.length ? (
            <div className="space-y-2">
              {items.map((item) => (
                <div
                  className="flex items-center justify-between gap-3 rounded-xl border border-line-steel px-3 py-3"
                  key={item.id}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-black text-ink">
                      {PABCO_LABELS[item.requirement]}
                    </p>
                    <p className="mt-0.5 text-[12px] text-ink-subtle">
                      {item.validUntil
                        ? `Vence ${formatDate(item.validUntil)}`
                        : "Sin vencimiento"}
                      {item.reminderAt
                        ? ` · Recordar ${formatDate(item.reminderAt)}`
                        : ""}
                      {item.evidenceDocumentId ? " · " : ""}
                      {item.evidenceDocumentId &&
                      isDownloadablePabcoEvidenceReference(item.evidenceDocumentId) ? (
                        <a
                          className="font-black text-accent underline"
                          href={`/api/leche/pabco-documentos?id=${encodeURIComponent(item.evidenceDocumentId)}`}
                        >
                          Ver evidencia
                        </a>
                      ) : item.evidenceDocumentId ? (
                        `Evidencia ${item.evidenceDocumentId}`
                      ) : null}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <StatusBadge
                      tone={
                        complianceStatus(item) === "compliant"
                          ? "green"
                          : complianceStatus(item) === "expired"
                            ? "red"
                            : "amber"
                      }
                    >
                      {PABCO_STATUS_LABELS[complianceStatus(item)]}
                    </StatusBadge>
                    <button
                      aria-label="Eliminar"
                      className="text-red-600"
                      onClick={() => remove(item)}
                      type="button"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty text="Completa los cinco requisitos PABCO del predio." />
          )}
        </DataPanel>
      </div>
      {quality.length > 0 && (
        <DataPanel help="rcs" title="Tendencia de salud mamaria" icon={FlaskConical}>
          <Table
            description="Sigue la evolución del recuento de células somáticas y separa muestras dentro de meta, en atención o críticas."
            filter={{
              label: "Estado",
              allLabel: "Todos los estados",
              columnIndex: 2,
            }}
            headers={["Fecha", "RCS", "Estado", "Fuente"]}
            id="leche.sanidad.rcs"
            maxHeight="24rem"
            searchPlaceholder="Buscar fecha, estado, fuente o RCS…"
            title="Salud mamaria por muestra"
          >
            {quality.map((sample) => {
              const rcs = normalizedCount(
                sample.somaticCellCount,
                sample.somaticCellCountUnit,
              );
              return (
                <tr key={sample.id}>
                  <Cell strong>{formatDate(sample.sampledAt)}</Cell>
                  <Cell right>{rcs ? formatNumber(rcs) : "—"}</Cell>
                  <Cell>
                    <StatusBadge
                      tone={
                        rcs > 700000 ? "red" : rcs > 400000 ? "amber" : "green"
                      }
                    >
                      {rcs > 700000
                        ? "Crítico"
                        : rcs > 400000
                          ? "Atención"
                          : "Dentro de meta"}
                    </StatusBadge>
                  </Cell>
                  <Cell>{sample.source}</Cell>
                </tr>
              );
            })}
          </Table>
        </DataPanel>
      )}
    </div>
  );
}

function LactationCurve({
  series,
}: {
  series: Array<{ date: string; liters: number }>;
}) {
  const width = 640;
  const height = 180;
  const paddingX = 36;
  const paddingY = 22;
  const maximum = Math.max(1, ...series.map((point) => point.liters));
  const coordinates = series.map((point, index) => ({
    ...point,
    x:
      paddingX +
      (index / Math.max(1, series.length - 1)) * (width - paddingX * 2),
    y: height - paddingY - (point.liters / maximum) * (height - paddingY * 2),
  }));
  return (
    <div className="rounded-2xl border border-line-steel bg-surface-alt p-3">
      <svg
        aria-label="Litros diarios por fecha de control"
        className="h-auto w-full overflow-visible"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        {[0, 0.5, 1].map((ratio) => {
          const y = height - paddingY - ratio * (height - paddingY * 2);
          return (
            <line
              key={ratio}
              stroke="#dfe6da"
              strokeDasharray="4 5"
              x1={paddingX}
              x2={width - paddingX}
              y1={y}
              y2={y}
            />
          );
        })}
        <polyline
          fill="none"
          points={coordinates.map((point) => `${point.x},${point.y}`).join(" ")}
          stroke="#19784b"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="4"
        />
        {coordinates.map((point) => (
          <circle
            cx={point.x}
            cy={point.y}
            fill="#c8ec74"
            key={`${point.date}-${point.liters}`}
            r="5"
            stroke="#173b2d"
            strokeWidth="2"
          >
            <title>{`${formatDate(point.date)}: ${formatDecimal(point.liters, 1)} litros`}</title>
          </circle>
        ))}
        <text fill="#7b867f" fontSize="10" x="2" y={paddingY + 3}>
          {formatDecimal(maximum, 1)} L
        </text>
        <text fill="#7b867f" fontSize="10" x="14" y={height - paddingY + 3}>
          0 L
        </text>
      </svg>
      <div className="flex justify-between px-7 text-[12px] font-bold text-ink-subtle">
        <span>{formatDate(series[0]!.date)}</span>
        <span>{formatDate(series.at(-1)!.date)}</span>
      </div>
    </div>
  );
}

const inputClass =
  "h-10 w-full rounded-xl border border-line-steel bg-white px-3 text-xs font-bold text-ink outline-none focus:border-accent";
const PABCO_LABELS: Record<PabcoComplianceRequirement, string> = {
  veterinary_advisory: "Asesoría veterinaria",
  medicine_prescriptions: "Medicamentos y recetas",
  withdrawal_management: "Gestión de resguardos",
  annual_water_analysis: "Análisis anual de agua",
  animal_traceability: "Trazabilidad animal",
};
const PABCO_STATUS_LABELS: Record<PabcoComplianceStatus, string> = {
  pending: "Pendiente",
  compliant: "Vigente",
  expiring: "Por vencer",
  expired: "Vencido",
  not_applicable: "No aplica",
};

function SectionLead({
  icon: Icon,
  eyebrow,
  title,
  text,
  actions,
}: {
  icon: typeof Droplets;
  eyebrow: string;
  title: string;
  text: string;
  actions?: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 rounded-[22px] border border-line-steel bg-ink p-5 text-white shadow-lg shadow-ink/10 sm:p-6 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-start gap-4">
        <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-white/10 text-white">
          <Icon size={20} />
        </span>
        <div>
          <p className="text-[12px] font-black uppercase tracking-[0.15em] text-white">
            {eyebrow}
          </p>
          <h2 className="mt-1 text-xl font-black tracking-[-0.04em]">
            {title}
          </h2>
          <p className="mt-1 max-w-3xl text-xs leading-5 text-white/60">
            {text}
          </p>
        </div>
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </section>
  );
}
function ActionButton({
  children,
  onClick,
  light = false,
  disabled = false,
}: {
  children: React.ReactNode;
  onClick: () => void;
  light?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      className={`flex h-10 items-center gap-2 rounded-xl px-3 text-[12px] font-black disabled:cursor-not-allowed disabled:opacity-50 ${light ? "bg-white/10 text-white" : "bg-accent text-ink"}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}
function FormPanel({
  help,
  helpText,
  title,
  children,
}: {
  help?: HelpKey;
  helpText?: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[20px] border border-line-steel bg-surface-alt p-4">
      <p className="mb-3 flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.13em] text-accent">
        {title}
        <HelpTip help={help} label={title} text={helpText} />
      </p>
      {children}
    </section>
  );
}
function DataPanel({
  help,
  helpText,
  title,
  icon: Icon,
  children,
}: {
  help?: HelpKey;
  helpText?: string;
  title: string;
  icon: typeof Droplets;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 overflow-hidden rounded-[22px] border border-line-steel bg-white p-5 shadow-[0_10px_38px_rgba(35,50,42,0.05)]">
      <div className="flex items-center gap-2">
        <Icon className="text-accent" size={16} />
        <h3 className="flex items-center gap-1.5 text-sm font-black text-ink">{title}<HelpTip help={help} label={title} text={helpText} /></h3>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}
function Metric({
  help,
  helpText,
  label,
  value,
  detail,
  warning = false,
}: {
  help?: HelpKey;
  helpText?: string;
  label: string;
  value: string;
  detail: string;
  warning?: boolean;
}) {
  return (
    <article
      className={`rounded-[18px] border p-4 shadow-sm ${warning ? "border-amber-200 bg-amber-50" : "border-line-steel bg-white"}`}
    >
      <p className="flex items-center gap-1 text-[12px] font-black uppercase tracking-[0.12em] text-ink-subtle">
        {label}
        <HelpTip help={help} label={label} text={helpText} />
      </p>
      <p
        className={`mt-2 text-xl font-black tracking-[-0.04em] ${warning ? "text-amber-900" : "text-ink"}`}
      >
        {value}
      </p>
      <p className="mt-1 text-[12px] font-semibold text-ink-subtle">{detail}</p>
    </article>
  );
}
function FundoSelect({
  fundos,
  value,
  onChange,
}: {
  fundos: Fundo[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Field label="Fundo">
      <select
        className={inputClass}
        onChange={(event) => onChange(event.target.value)}
        required
        value={value}
      >
        {fundos.map((fundo) => (
          <option key={fundo.id} value={fundo.id}>
            {fundo.name}
          </option>
        ))}
      </select>
    </Field>
  );
}
function SaveButton({
  saving,
  label = "Guardar",
}: {
  saving: boolean;
  label?: string;
}) {
  return (
    <button
      className="mt-auto flex h-10 items-center justify-center gap-2 self-end rounded-xl bg-accent px-4 text-[12px] font-black text-white disabled:opacity-60"
      disabled={saving}
      type="submit"
    >
      {saving ? (
        <LoaderCircle className="animate-spin" size={14} />
      ) : (
        <CheckCircle2 size={14} />
      )}
      {label}
    </button>
  );
}
function Table({
  children,
  defaultOpen = true,
  description,
  filter,
  headers,
  id,
  maxHeight,
  searchPlaceholder,
  title,
}: {
  children: React.ReactNode;
  defaultOpen?: boolean;
  description: string;
  filter?: {
    allLabel: string;
    columnIndex: number;
    label: string;
  };
  headers: string[];
  id: string;
  maxHeight?: string;
  searchPlaceholder: string;
  title: string;
}) {
  return (
    <TableExplorer
      defaultOpen={defaultOpen}
      description={description}
      filter={filter}
      id={id}
      maxHeight={maxHeight}
      searchPlaceholder={searchPlaceholder}
      title={title}
    >
      <table className="w-full min-w-[680px] text-left">
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                className="border-b border-line-steel px-2 py-2 text-[12px] font-black uppercase tracking-[0.1em] text-ink-subtle"
                key={header}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </TableExplorer>
  );
}
function Cell({
  children,
  right = false,
  strong = false,
  danger = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
  danger?: boolean;
}) {
  return (
    <td
      className={`border-b border-line-steel px-2 py-2.5 text-[12px] ${right ? "text-right" : ""} ${strong ? "font-black text-ink" : "text-ink-muted"} ${danger ? "!font-black !text-red-700" : ""}`}
    >
      {children}
    </td>
  );
}
function StatusBadge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "green" | "amber" | "red" | "blue";
}) {
  const styles = {
    green: "bg-emerald-50 text-emerald-800",
    amber: "bg-amber-50 text-amber-800",
    red: "bg-red-50 text-red-800",
    blue: "bg-blue-50 text-blue-800",
  };
  return (
    <span
      className={`inline-flex rounded-full px-2 py-1 text-[12px] font-black ${styles[tone]}`}
    >
      {children}
    </span>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="grid min-h-32 place-items-center rounded-xl border border-dashed border-line-steel bg-surface-alt p-4 text-center">
      <div>
        <CalendarCheck className="mx-auto text-accent" size={22} />
        <p className="mt-2 text-xs font-black text-ink">{text}</p>
      </div>
    </div>
  );
}
function ErrorBox({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 rounded-xl bg-red-50 px-4 py-3 text-xs font-bold text-red-800">
      <AlertTriangle size={15} />
      {text}
    </p>
  );
}

function matches(
  fieldId: string,
  date: string,
  selectedFundoId: string,
  selectedYear: string,
) {
  return (
    (selectedFundoId === ALL || fieldId === selectedFundoId) &&
    (selectedYear === ALL || date.startsWith(selectedYear))
  );
}
function today() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}
function formatNumber(value: number) {
  return value.toLocaleString("es-CL", { maximumFractionDigits: 0 });
}
function formatDecimal(value: number, digits: number) {
  return value.toLocaleString("es-CL", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}
function formatClpDecimal(value: number) {
  return new Intl.NumberFormat("es-CL", {
    style: "currency",
    currency: "CLP",
    maximumFractionDigits: 2,
  }).format(value);
}
function formatDate(value: string) {
  return new Date(`${value.slice(0, 10)}T12:00:00`).toLocaleDateString("es-CL");
}
function formatPeriod(value: string) {
  return new Date(`${value}-01T12:00:00`).toLocaleDateString("es-CL", {
    month: "short",
    year: "numeric",
  });
}
function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  if (!Number.isFinite(parsed) || parsed < 0)
    throw new Error("Hay un valor numérico inválido.");
  return parsed;
}
function nullableInteger(value: unknown): number | null {
  const parsed = nullableNumber(value);
  if (parsed === null) return null;
  if (!Number.isInteger(parsed))
    throw new Error("RCS y UFC deben ser números enteros.");
  return parsed;
}
function requiredNumber(value: unknown, message: string) {
  const parsed = nullableNumber(value);
  if (parsed === null || parsed <= 0) throw new Error(message);
  return parsed;
}
function percent(value: number | null) {
  return value === null ? "—" : `${formatDecimal(value, 1)}%`;
}
function numberOrDash(value: number | null, digits: number) {
  return value === null
    ? "—"
    : value.toLocaleString("es-CL", { maximumFractionDigits: digits });
}
function normalizedCount(value: number | null, unit: string | null) {
  return value === null
    ? 0
    : unit?.startsWith("thousand_")
      ? value * 1000
      : value;
}
function count(value: number | null, unit: string | null) {
  const normalized = normalizedCount(value, unit);
  return value === null ? "—" : formatNumber(normalized);
}
function errorMessage(cause: unknown) {
  return cause instanceof Error
    ? cause.message
    : "No fue posible completar la operación.";
}
function actionLabel(value: string) {
  return (
    (
      {
        breed: "Inseminar/servir",
        pregnancy_check: "Chequear preñez",
        dry_off: "Secar",
        heat_watch: "Vigilar celo",
      } as Record<string, string>
    )[value] ?? value
  );
}
function reasonLabel(value: string) {
  return (
    (
      {
        observed_heat: "Celo observado",
        breeding: "Servicio registrado",
        confirmed_conception: "Concepción confirmada",
        last_heat_or_breeding: "Último celo/servicio",
        voluntary_wait_complete: "Fin de espera voluntaria",
      } as Record<string, string>
    )[value] ?? value
  );
}
function mammaryPriorityLabel(value: MilkMammaryWorkItem["priority"]) {
  return {
    urgent: "Urgente",
    high: "Alta",
    medium: "Media",
    review: "Actualizar",
  }[value];
}
function mammaryPriorityTone(
  value: MilkMammaryWorkItem["priority"],
): "green" | "amber" | "red" | "blue" {
  if (value === "urgent") return "red";
  if (value === "high" || value === "medium") return "amber";
  return "blue";
}
function mammaryActionLabel(value: MilkMammaryWorkItem["action"]) {
  return {
    review_now: "Revisar hoy y definir acción",
    review_soon: "Revisar dentro de 48 h",
    schedule_recheck: "Programar nuevo RCS",
    update_control: "Actualizar control lechero",
  }[value];
}
function mammarySignalLabel(reasonCodes: string[]) {
  const labels: Record<string, string> = {
    open_mastitis_case: "Caso mamario abierto",
    critical_rcs: "RCS crítico",
    high_rcs: "RCS alto",
    elevated_rcs: "RCS elevado",
    increasing_trend: "Tendencia al alza",
    stale_control: "Control con más de 45 días",
  };
  return reasonCodes.map((reason) => labels[reason] ?? reason).join(" · ");
}
function dryOffReasonLabel(value: "days_in_milk" | "low_production" | null) {
  if (value === "days_in_milk") return "DEL ≥ 305";
  if (value === "low_production") return "Producción ≤ 8 L/d";
  return "";
}
function bulkKindLabel(value: string) {
  return (
    (
      {
        tank_total: "Total de estanque",
        delivery: "Entrega",
        milk_meter_rollup: "Medidores",
      } as Record<string, string>
    )[value] ?? value
  );
}
function sourceLabel(value: string) {
  return (
    (
      {
        manual: "Manual",
        cooprinsem_clo: "Cooprinsem CLO",
        cooprinsem_laboratory: "Laboratorio Cooprinsem",
        equipment: "Equipo",
        settlement: "Liquidación",
      } as Record<string, string>
    )[value] ?? value
  );
}
function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<string | number>>,
) {
  if (rows.length === 0) return;
  const csv = `\uFEFF${[headers, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n")}`;
  const url = URL.createObjectURL(
    new Blob([csv], { type: "text/csv;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
function csvCell(value: string | number) {
  const text = String(value);
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}
