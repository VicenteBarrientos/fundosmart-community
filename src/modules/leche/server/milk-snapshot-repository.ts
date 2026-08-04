import { getDb } from "@/db";
import {
  fields,
  livestockAnimals,
  livestockHealthEvents,
  livestockLactations,
  livestockLots,
  livestockMilkControls,
  livestockReproductiveEvents,
  milkSettlements,
} from "@/db/schema";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import type {
  MilkHerdAnimalSummary,
  MilkMammaryHealthSummary,
  MilkMammaryWorkItem,
  MilkModuleSnapshot,
  MilkReproductionKpis,
  MilkReproductionWorkItem,
} from "../domain/types";
import {
  buildMammaryWorklist,
  calculateMammaryHealth,
  buildActiveWithdrawals,
} from "../domain/herd-health-rules.mjs";
import {
  calculate305DayProjection,
  calculateDaysInMilk,
  calculateRollingHerdAverage,
  evaluateDryOffRecommendation,
  getCurrentProduction,
} from "../domain/lactation-metrics.mjs";
import {
  buildReproductiveWorklists,
  calculateCalvingInterval,
  calculateDaysOpen,
  calculateReproductiveRates,
} from "../domain/reproduction-metrics.mjs";
import { buildMilkReconciliation } from "../domain/milk-reconciliation.mjs";
import {
  listMilkBulkProduction,
  listMilkQualitySamples,
  listPabcoComplianceItems,
} from "./milk-operations-repository";
import { and, asc, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";

/* El tablero leía la historia completa —todos los controles, celos, partos y
   tratamientos del rebaño— en cada visita al módulo, así que el costo de abrir
   Leche crecía con los años del predio y no con lo que la pantalla muestra.

   Ninguna métrica mira tan atrás. La media móvil del rebaño y los indicadores
   reproductivos declaran ventana de 365 días; la proyección a 305 días vive
   dentro de la lactancia en curso; los resguardos sanitarios duran días. Tres
   años dan margen de sobra sobre todas ellas.

   La consecuencia está acotada y es deliberada: el intervalo entre partos usa
   los dos últimos, y una vaca cuyo parto anterior quedó fuera de la ventana
   deja de informarlo. A ese plazo el dato ya no describe al rebaño actual. */
const SNAPSHOT_HISTORY_DAYS = 1095;

export async function getMilkModuleSnapshot(
  scope: OrganizationFieldScope,
  asOf = todayInChile(),
): Promise<MilkModuleSnapshot> {
  if (scope.fieldIds.length === 0) return emptySnapshot(asOf);
  const db = getDb();
  const historyStart = addDays(asOf, -(SNAPSHOT_HISTORY_DAYS - 1));
  const [
    bulkProduction,
    qualitySamples,
    pabcoItems,
    animalRows,
    lactationRows,
    controlRows,
    reproductiveEventRows,
    healthEventRows,
    settlementRows,
  ] = await Promise.all([
    listMilkBulkProduction(scope),
    listMilkQualitySamples(scope),
    listPabcoComplianceItems(scope),
    db
      .select({
        animalId: livestockAnimals.id,
        tag: livestockAnimals.tag,
        lotId: livestockLots.id,
        lotName: livestockLots.name,
        fieldId: livestockLots.fieldId,
        category: livestockLots.category,
      })
      .from(livestockAnimals)
      .innerJoin(
        livestockLots,
        eq(livestockLots.id, livestockAnimals.lotId),
      )
      .innerJoin(
        fields,
        and(
          eq(fields.id, livestockLots.fieldId),
          eq(fields.organizationId, scope.organizationId),
          inArray(fields.id, scope.fieldIds),
        ),
      )
      .where(
        and(
          inArray(livestockLots.category, ["dairy_cow", "dry_cow"]),
          inArray(livestockAnimals.status, ["active"]),
        ),
      )
      .orderBy(asc(livestockAnimals.tag)),
    db
      .select({ record: livestockLactations })
      .from(livestockLactations)
      .innerJoin(
        livestockAnimals,
        eq(livestockAnimals.id, livestockLactations.animalId),
      )
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(
        and(
          eq(fields.organizationId, scope.organizationId),
          inArray(fields.id, scope.fieldIds),
          inArray(livestockLots.category, ["dairy_cow", "dry_cow"]),
          eq(livestockAnimals.status, "active"),
          /* Una lactancia abierta sigue siendo la vigente por vieja que sea:
             recortarla por fecha borraría la lactancia en curso del animal. */
          or(
            gte(livestockLactations.startedAt, historyStart),
            isNull(livestockLactations.endedAt),
          ),
          sql`EXISTS (
            SELECT 1 FROM fields AS history_field
            WHERE history_field.id = ${livestockLactations.fieldId}
              AND history_field.organization_id = ${scope.organizationId}
          )`,
        ),
      )
      .orderBy(desc(livestockLactations.startedAt)),
    db
      .select({ record: livestockMilkControls })
      .from(livestockMilkControls)
      .innerJoin(
        livestockAnimals,
        eq(livestockAnimals.id, livestockMilkControls.animalId),
      )
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(
        and(
          eq(fields.organizationId, scope.organizationId),
          inArray(fields.id, scope.fieldIds),
          inArray(livestockLots.category, ["dairy_cow", "dry_cow"]),
          eq(livestockAnimals.status, "active"),
          gte(livestockMilkControls.controlDate, historyStart),
          sql`EXISTS (
            SELECT 1 FROM fields AS history_field
            WHERE history_field.id = ${livestockMilkControls.fieldId}
              AND history_field.organization_id = ${scope.organizationId}
          )`,
        ),
      )
      .orderBy(desc(livestockMilkControls.controlDate)),
    db
      .select({ record: livestockReproductiveEvents })
      .from(livestockReproductiveEvents)
      .innerJoin(
        livestockAnimals,
        eq(livestockAnimals.id, livestockReproductiveEvents.animalId),
      )
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(
        and(
          eq(fields.organizationId, scope.organizationId),
          inArray(fields.id, scope.fieldIds),
          inArray(livestockLots.category, ["dairy_cow", "dry_cow"]),
          eq(livestockAnimals.status, "active"),
          gte(livestockReproductiveEvents.occurredAt, historyStart),
          sql`EXISTS (
            SELECT 1 FROM fields AS history_field
            WHERE history_field.id = ${livestockReproductiveEvents.fieldId}
              AND history_field.organization_id = ${scope.organizationId}
          )`,
        ),
      )
      .orderBy(desc(livestockReproductiveEvents.occurredAt)),
    db
      .select({ record: livestockHealthEvents })
      .from(livestockHealthEvents)
      .innerJoin(
        livestockAnimals,
        eq(livestockAnimals.id, livestockHealthEvents.animalId),
      )
      .innerJoin(livestockLots, eq(livestockLots.id, livestockAnimals.lotId))
      .innerJoin(fields, eq(fields.id, livestockLots.fieldId))
      .where(
        and(
          eq(fields.organizationId, scope.organizationId),
          inArray(fields.id, scope.fieldIds),
          inArray(livestockLots.category, ["dairy_cow", "dry_cow"]),
          eq(livestockAnimals.status, "active"),
          gte(livestockHealthEvents.occurredAt, historyStart),
          sql`EXISTS (
            SELECT 1 FROM fields AS history_field
            WHERE history_field.id = ${livestockHealthEvents.fieldId}
              AND history_field.organization_id = ${scope.organizationId}
          )`,
        ),
      )
      .orderBy(desc(livestockHealthEvents.occurredAt)),
    db
      .select({
        fieldId: milkSettlements.fieldId,
        period: milkSettlements.period,
        totalLiters: milkSettlements.totalLiters,
        netAmountClp: milkSettlements.netAmountClp,
      })
      .from(milkSettlements)
      .innerJoin(fields, eq(fields.id, milkSettlements.fieldId))
      .where(
        and(
          eq(fields.organizationId, scope.organizationId),
          inArray(fields.id, scope.fieldIds),
        ),
      ),
  ]);
  const lactations = lactationRows.map(({ record }) => record);
  const controls = controlRows.map(({ record }) => record);
  const reproductiveEvents = reproductiveEventRows.map(({ record }) => record);
  const healthEvents = healthEventRows.map(({ record }) => record);

  const animalsById = new Map(
    animalRows.map((animal) => [animal.animalId, animal]),
  );
  const rollingAverageByField = new Map(
    [...new Set(animalRows.map((animal) => animal.fieldId))].map((fieldId) => {
      const fieldAnimalIds = new Set(
        animalRows
          .filter((animal) => animal.fieldId === fieldId)
          .map((animal) => animal.animalId),
      );
      return [
        fieldId,
        calculateRollingHerdAverage({
          lactations: lactations.filter((entry) =>
            fieldAnimalIds.has(entry.animalId),
          ),
          controls: controls.filter((entry) =>
            fieldAnimalIds.has(entry.animalId),
          ),
          asOf,
        }).litersPerCow,
      ] as const;
    }),
  );
  const herd = animalRows.map((animal): MilkHerdAnimalSummary => {
    const animalLactations = lactations.filter(
      (entry) => entry.animalId === animal.animalId,
    );
    const animalControls = controls.filter(
      (entry) => entry.animalId === animal.animalId,
    );
    const currentLactation =
      animalLactations.find((entry) => entry.startedAt <= asOf) ?? null;
    const lactationStatus = currentLactation
      ? deriveLactationStatusAt(currentLactation, asOf)
      : null;
    const currentProduction = currentLactation
      ? getCurrentProduction(currentLactation, animalControls, asOf)
      : null;
    const projection = currentLactation
      ? calculate305DayProjection(currentLactation, animalControls, asOf)
      : null;
    const relevantControls = animalControls
      .filter((control) => control.controlDate <= asOf)
      .filter(
        (control) =>
          !currentLactation ||
          (control.controlDate >= currentLactation.startedAt &&
            (currentLactation.endedAt === null ||
              control.controlDate <= currentLactation.endedAt)),
      );
    const latestControl = relevantControls[0] ?? null;
    const daysInMilk = currentLactation
      ? calculateDaysInMilk(currentLactation, asOf)
      : null;
    const lastLiters =
      currentProduction?.liters ?? latestControl?.totalLiters ?? null;
    const dryOffRecommendation = evaluateDryOffRecommendation({
      lactationStatus,
      daysInMilk,
      latestLiters: lastLiters,
    });
    const controlSeries = relevantControls
      .sort((left, right) => left.controlDate.localeCompare(right.controlDate))
      .slice(-24)
      .map((control) => ({
        date: control.controlDate,
        liters: control.totalLiters,
      }));
    return {
      animalId: animal.animalId,
      fieldId: animal.fieldId,
      tag: animal.tag,
      lotId: animal.lotId,
      lotName: animal.lotName,
      lactationId: currentLactation?.id ?? null,
      lactationStatus,
      lactationNumber: currentLactation?.sequenceNumber ?? null,
      daysInMilk,
      dryOffAlert: dryOffRecommendation.shouldDryOff,
      dryOffReason: dryOffRecommendation.reason,
      lastControlDate: latestControl?.controlDate ?? null,
      lastLiters,
      fatPercent: latestControl?.fatPct ?? null,
      proteinPercent: latestControl?.proteinPct ?? null,
      somaticCellCount: latestControl?.somaticCellCount ?? null,
      projected305Liters: projection?.projected305Liters ?? null,
      rollingHerdAverageLiters:
        rollingAverageByField.get(animal.fieldId) ?? null,
      controlSeries,
    };
  });

  const yearStart = addDays(asOf, -364);
  const dairyAnimalIds = animalRows.map((animal) => animal.animalId);
  const dairyAnimalIdSet = new Set(dairyAnimalIds);
  const reproductionKpis = calculateSnapshotReproductionKpis(
    dairyAnimalIds,
    reproductiveEvents,
    yearStart,
    asOf,
  );
  const worklists = buildReproductiveWorklists(reproductiveEvents, asOf);
  const workItems = [
    ...mapWorkItems(worklists.expectedHeat, "heat_watch", animalsById),
    ...mapWorkItems(worklists.toInseminate, "breed", animalsById),
    ...mapWorkItems(worklists.pregnancyChecks, "pregnancy_check", animalsById),
    ...mapWorkItems(worklists.dryOff, "dry_off", animalsById),
  ].sort((left, right) => left.dueAt.localeCompare(right.dueAt));

  const activeWithdrawals = buildActiveWithdrawals(healthEvents, asOf);
  const withdrawals = activeWithdrawals.entries.flatMap((entry) => {
    const animal = animalsById.get(entry.animalId);
    if (!animal) return [];
    return [
      {
        eventId: entry.eventId,
        animalId: entry.animalId,
        fieldId: animal.fieldId,
        tag: animal.tag,
        condition: entry.condition,
        productName: entry.productName,
        milkUntil: entry.milkUntil,
        meatUntil: entry.meatUntil,
        noMilkDelivery: entry.doNotDeliverMilk,
      },
    ];
  });
  const mammaryMetrics = calculateMammaryHealth(
    controls.filter((control) => dairyAnimalIdSet.has(control.animalId)),
    healthEvents.filter((event) => dairyAnimalIdSet.has(event.animalId)),
    asOf,
  );
  const mammaryHealth = summarizeMammaryHealth(mammaryMetrics);
  const mammaryWorkItems = mapMammaryWorkItems(
    buildMammaryWorklist(mammaryMetrics),
    animalsById,
  );
  const fieldMetrics = [...new Set(scope.fieldIds)].sort().map((fieldId) => {
    const animalIds = animalRows
      .filter((animal) => animal.fieldId === fieldId)
      .map((animal) => animal.animalId);
    const animalIdSet = new Set(animalIds);
    const fieldReproductiveEvents = reproductiveEvents.filter((event) =>
      animalIdSet.has(event.animalId),
    );
    const fieldMammaryMetrics = calculateMammaryHealth(
      controls.filter((control) => animalIdSet.has(control.animalId)),
      healthEvents.filter((event) => animalIdSet.has(event.animalId)),
      asOf,
    );
    return {
      fieldId,
      reproductionKpis: calculateSnapshotReproductionKpis(
        animalIds,
        fieldReproductiveEvents,
        yearStart,
        asOf,
      ),
      mammaryHealth: summarizeMammaryHealth(fieldMammaryMetrics),
    };
  });

  return {
    asOf,
    bulkProduction,
    qualitySamples,
    pabcoItems,
    reconciliation: buildMilkReconciliation(bulkProduction, settlementRows),
    herd,
    reproduction: {
      kpis: reproductionKpis,
      workItems,
    },
    withdrawals,
    mammaryHealth,
    mammaryWorkItems,
    fieldMetrics,
    generatedAt: new Date().toISOString(),
  };
}

function deriveLactationStatusAt(
  lactation: typeof livestockLactations.$inferSelect,
  asOf: string,
): MilkHerdAnimalSummary["lactationStatus"] {
  if (lactation.endedAt && asOf < lactation.endedAt) return "active";
  return lactation.status;
}

function calculateSnapshotReproductionKpis(
  animalIds: string[],
  events: Array<typeof livestockReproductiveEvents.$inferSelect>,
  periodStart: string,
  periodEnd: string,
): MilkReproductionKpis {
  const reproductiveRates = calculateReproductiveRates(events, {
    periodStart,
    periodEnd,
    animalIds,
  });
  const daysOpen = animalIds.flatMap((animalId) => {
    const result = calculateDaysOpen(
      events.filter((event) => event.animalId === animalId),
      periodEnd,
    );
    return result ? [result.days] : [];
  });
  const calvingIntervals = animalIds.flatMap((animalId) => {
    const result = calculateCalvingInterval(
      events.filter((event) => event.animalId === animalId),
      periodEnd,
    );
    return result ? [result.days] : [];
  });
  return {
    openDaysAverage: average(daysOpen),
    calvingIntervalDaysAverage: average(calvingIntervals),
    pregnancyRatePercent: reproductiveRates.pregnancyRatePct,
    conceptionRatePercent: reproductiveRates.conceptionRatePct,
    heatDetectionRatePercent: reproductiveRates.heatDetectionRatePct,
  };
}

function summarizeMammaryHealth(
  mammary: ReturnType<typeof calculateMammaryHealth>,
): MilkMammaryHealthSummary {
  return {
    evaluatedAnimalCount: mammary.evaluatedAnimalCount,
    currentAnimalCount: mammary.currentAnimalCount,
    staleAnimalCount: mammary.staleAnimalCount,
    herdSomaticCellCount: mammary.herdSomaticCellCount,
    herdStatus: mammary.herdStatus,
    mastitisCaseCount: mammary.mastitisCases.length,
    highRiskAnimalIds: mammary.highRiskAnimalIds,
  };
}

function mapMammaryWorkItems(
  workItems: ReturnType<typeof buildMammaryWorklist>,
  animalsById: ReadonlyMap<string, { fieldId: string; tag: string; lotName: string }>,
): MilkMammaryWorkItem[] {
  return workItems.flatMap((item) => {
    const animal = animalsById.get(item.animalId);
    return animal
      ? [{
        animalId: item.animalId,
        fieldId: animal.fieldId,
        tag: animal.tag,
        lotName: animal.lotName,
        priority: item.priority,
        action: item.action,
        controlDate: item.controlDate,
        ageDays: item.ageDays,
        totalLiters: item.totalLiters,
        somaticCellCount: item.somaticCellCount,
        status: item.status,
        trend: item.trend,
        hasOpenMastitis: item.hasOpenMastitis,
        reasonCodes: item.reasonCodes,
      }]
      : [];
  });
}

function mapWorkItems(
  items: Array<{ animalId: string; dueDate: string; reason: string }>,
  action: MilkReproductionWorkItem["action"],
  animalsById: Map<string, { fieldId: string; tag: string; lotName: string }>,
): MilkReproductionWorkItem[] {
  return items.flatMap((item) => {
    const animal = animalsById.get(item.animalId);
    return animal
      ? [
          {
            animalId: item.animalId,
            fieldId: animal.fieldId,
            tag: animal.tag,
            lotName: animal.lotName,
            action,
            dueAt: item.dueDate,
            reason: item.reason,
          },
        ]
      : [];
  });
}

function average(values: number[]): number | null {
  return values.length > 0
    ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1)
    : null;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function todayInChile(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function emptySnapshot(asOf: string): MilkModuleSnapshot {
  return {
    asOf,
    bulkProduction: [],
    qualitySamples: [],
    pabcoItems: [],
    reconciliation: [],
    herd: [],
    reproduction: {
      kpis: {
        openDaysAverage: null,
        calvingIntervalDaysAverage: null,
        pregnancyRatePercent: null,
        conceptionRatePercent: null,
        heatDetectionRatePercent: null,
      },
      workItems: [],
    },
    withdrawals: [],
    mammaryHealth: {
      evaluatedAnimalCount: 0,
      currentAnimalCount: 0,
      staleAnimalCount: 0,
      herdSomaticCellCount: null,
      herdStatus: "unknown",
      mastitisCaseCount: 0,
      highRiskAnimalIds: [],
    },
    mammaryWorkItems: [],
    fieldMetrics: [],
    generatedAt: new Date().toISOString(),
  };
}
