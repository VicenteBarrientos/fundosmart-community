import { getDb } from "@/db";
import type { Activity, LivestockAnimal, LivestockLot } from "@/src/core/domain/types";
import type { OrganizationFieldScope } from "@/src/modules/access/domain/types";
import type { HerdWorkItem } from "@/src/modules/ganado/domain/operations";
import { buildDashboardHerdWorkItems } from "@/src/modules/ganado/lib/operations-rules";
import type { MilkMammaryWorkItem } from "@/src/modules/leche/domain/types";
import {
  buildMammaryWorklist,
  calculateMammaryHealth,
} from "@/src/modules/leche/domain/herd-health-rules.mjs";

const MAMMARY_HISTORY_DAYS = 1095;

type DashboardOperationalSnapshot = {
  activities: Activity[];
  activityCostsByPeriod: DashboardActivityCost[];
  animals: LivestockAnimal[];
  lots: LivestockLot[];
  herdWorkItems: HerdWorkItem[];
  mammaryWorkItems: MilkMammaryWorkItem[];
};

export type DashboardActivityCost = {
  fieldId: string;
  period: string;
  costClp: number;
};

type DashboardOperationalSnapshotOptions = {
  includeActivityCosts?: boolean;
  now?: string;
};

type LotRow = {
  lotId: string;
  lotFieldId: string;
  paddockId: string | null;
  lotName: string;
  category: LivestockLot["category"];
  animalCount: number;
  averageWeightKg: number | null;
  entryDate: string;
  lotStatus: LivestockLot["status"];
  ownerName: string | null;
  trackingMode: LivestockLot["trackingMode"];
  lotNotes: string;
  lotCreatedAt: string;
  lotUpdatedAt: string;
};

type AnimalLotRow = LotRow & {
  animalId: string;
  animalLotId: string;
  tag: string;
  sex: LivestockAnimal["sex"];
  animalStatus: LivestockAnimal["status"];
  statusDate: string | null;
  statusReason: string | null;
  birthDate: string | null;
  purchasePriceClp: number | null;
  purchaseDate: string | null;
  salePriceClp: number | null;
  saleBuyer: string | null;
  saleWeightKg: number | null;
  origin: string | null;
  animalNotes: string;
  animalSource: string;
  animalCreatedAt: string;
  latestWeightKg: number | null;
  latestWeightDate: string | null;
};

type ReproductiveRow = {
  animalId: string;
  eventType: "service" | "insemination" | "pregnancy_diagnosis" | "calving" | "abortion";
  occurredAt: string;
  result: string | null;
  sireIdentifier: string | null;
};

type BirthRow = { damAnimalId: string; occurredAt: string };

type HealthRow = {
  id: string;
  fieldId: string;
  animalId: string;
  eventType: "observation" | "diagnosis" | "treatment" | "vaccination" | "withdrawal_clearance";
  occurredAt: string;
  status: "open" | "completed";
  condition: string | null;
  productName: string | null;
  withdrawalMilkUntil: string | null;
  withdrawalMeatUntil: string | null;
  notes: string;
  metadata: string | Record<string, unknown>;
};

type MilkControlRow = {
  animalId: string;
  controlDate: string;
  totalLiters: number;
  somaticCellCount: number;
};

export async function getDashboardOperationalSnapshot(
  scope: OrganizationFieldScope,
  options: DashboardOperationalSnapshotOptions = {},
): Promise<DashboardOperationalSnapshot> {
  if (scope.fieldIds.length === 0) return emptySnapshot();

  const now = options.now ?? new Date().toISOString();
  const client = getDb().$client;
  const fieldIds = JSON.stringify([...new Set(scope.fieldIds)]);
  const asOf = todayInChile(now);
  const historyStart = addDays(asOf, -(MAMMARY_HISTORY_DAYS - 1));
  const [
    lotResult,
    animalResult,
    reproductiveResult,
    birthResult,
    healthResult,
    controlResult,
    activityResult,
    activityCostResult,
  ] =
    await client.batch<Record<string, unknown>>([
      client.prepare(`
        SELECT
          lot.id AS lotId,
          lot.field_id AS lotFieldId,
          lot.paddock_id AS paddockId,
          lot.name AS lotName,
          lot.category,
          lot.animal_count AS animalCount,
          lot.average_weight_kg AS averageWeightKg,
          lot.entry_date AS entryDate,
          lot.status AS lotStatus,
          lot.owner_name AS ownerName,
          lot.tracking_mode AS trackingMode,
          lot.notes AS lotNotes,
          lot.created_at AS lotCreatedAt,
          lot.updated_at AS lotUpdatedAt
        FROM livestock_lots AS lot
        INNER JOIN fields AS field ON field.id = lot.field_id
        WHERE field.organization_id = ?
          AND field.id IN (SELECT value FROM json_each(?))
        ORDER BY lot.name
      `).bind(scope.organizationId, fieldIds),
      client.prepare(`
        SELECT
          animal.id AS animalId,
          animal.lot_id AS animalLotId,
          animal.tag,
          animal.sex,
          animal.status AS animalStatus,
          animal.status_date AS statusDate,
          animal.status_reason AS statusReason,
          animal.birth_date AS birthDate,
          animal.purchase_price_clp AS purchasePriceClp,
          animal.purchase_date AS purchaseDate,
          animal.sale_price_clp AS salePriceClp,
          animal.sale_buyer AS saleBuyer,
          animal.sale_weight_kg AS saleWeightKg,
          animal.origin,
          animal.notes AS animalNotes,
          animal.source AS animalSource,
          animal.created_at AS animalCreatedAt,
          latest_weighing.weight_kg AS latestWeightKg,
          latest_weighing.recorded_at AS latestWeightDate,
          lot.id AS lotId,
          lot.field_id AS lotFieldId,
          lot.paddock_id AS paddockId,
          lot.name AS lotName,
          lot.category,
          lot.animal_count AS animalCount,
          lot.average_weight_kg AS averageWeightKg,
          lot.entry_date AS entryDate,
          lot.status AS lotStatus,
          lot.owner_name AS ownerName,
          lot.tracking_mode AS trackingMode,
          lot.notes AS lotNotes,
          lot.created_at AS lotCreatedAt,
          lot.updated_at AS lotUpdatedAt
        FROM livestock_animals AS animal
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS field ON field.id = lot.field_id
        LEFT JOIN livestock_weighings AS latest_weighing
          ON latest_weighing.animal_id = animal.id
         AND latest_weighing.recorded_at = (
           SELECT MAX(candidate.recorded_at)
           FROM livestock_weighings AS candidate
           WHERE candidate.animal_id = animal.id
         )
        WHERE field.organization_id = ?
          AND field.id IN (SELECT value FROM json_each(?))
        ORDER BY animal.tag
      `).bind(scope.organizationId, fieldIds),
      client.prepare(`
        SELECT
          event.animal_id AS animalId,
          event.event_type AS eventType,
          event.occurred_at AS occurredAt,
          event.result,
          event.sire_identifier AS sireIdentifier
        FROM livestock_reproductive_events AS event
        INNER JOIN livestock_animals AS animal ON animal.id = event.animal_id
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS current_field ON current_field.id = lot.field_id
        WHERE current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND animal.status = 'active'
          AND event.field_id IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM fields AS event_field
            WHERE event_field.id = event.field_id
              AND event_field.organization_id = ?
          )
          AND event.event_type IN (
            'service', 'insemination', 'pregnancy_diagnosis', 'calving', 'abortion'
          )
      `).bind(scope.organizationId, fieldIds, fieldIds, scope.organizationId),
      client.prepare(`
        SELECT birth.dam_animal_id AS damAnimalId, MAX(birth.occurred_at) AS occurredAt
        FROM livestock_births AS birth
        INNER JOIN livestock_animals AS animal ON animal.id = birth.dam_animal_id
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS current_field ON current_field.id = lot.field_id
        WHERE current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND animal.status = 'active'
          AND birth.field_id IN (SELECT value FROM json_each(?))
          AND EXISTS (
            SELECT 1 FROM fields AS birth_field
            WHERE birth_field.id = birth.field_id
              AND birth_field.organization_id = ?
          )
        GROUP BY birth.dam_animal_id
      `).bind(scope.organizationId, fieldIds, fieldIds, scope.organizationId),
      client.prepare(`
        SELECT
          health.id,
          health.field_id AS fieldId,
          health.animal_id AS animalId,
          health.event_type AS eventType,
          health.occurred_at AS occurredAt,
          health.status,
          health.condition,
          health.product_name AS productName,
          health.withdrawal_milk_until AS withdrawalMilkUntil,
          health.withdrawal_meat_until AS withdrawalMeatUntil,
          health.notes,
          health.metadata
        FROM livestock_health_events AS health
        INNER JOIN livestock_animals AS animal ON animal.id = health.animal_id
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS current_field ON current_field.id = lot.field_id
        WHERE current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND animal.status = 'active'
          AND health.status != 'cancelled'
          AND EXISTS (
            SELECT 1 FROM fields AS health_field
            WHERE health_field.id = health.field_id
              AND health_field.organization_id = ?
          )
          AND (
            health.status = 'open'
            OR health.withdrawal_milk_until >= ?
            OR health.withdrawal_meat_until >= ?
          )
      `).bind(scope.organizationId, fieldIds, scope.organizationId, asOf, asOf),
      client.prepare(`
        SELECT
          control.animal_id AS animalId,
          control.control_date AS controlDate,
          control.total_liters AS totalLiters,
          control.somatic_cell_count AS somaticCellCount
        FROM livestock_milk_controls AS control
        INNER JOIN livestock_animals AS animal ON animal.id = control.animal_id
        INNER JOIN livestock_lots AS lot ON lot.id = animal.lot_id
        INNER JOIN fields AS current_field ON current_field.id = lot.field_id
        WHERE current_field.organization_id = ?
          AND current_field.id IN (SELECT value FROM json_each(?))
          AND animal.status = 'active'
          AND lot.category IN ('dairy_cow', 'dry_cow')
          AND control.somatic_cell_count IS NOT NULL
          AND control.control_date BETWEEN ? AND ?
          AND EXISTS (
            SELECT 1 FROM fields AS control_field
            WHERE control_field.id = control.field_id
              AND control_field.organization_id = ?
          )
          AND control.id IN (
            SELECT recent.id
            FROM livestock_milk_controls AS recent
            WHERE recent.animal_id = control.animal_id
              AND recent.somatic_cell_count IS NOT NULL
              AND recent.control_date BETWEEN ? AND ?
              AND EXISTS (
                SELECT 1 FROM fields AS recent_field
                WHERE recent_field.id = recent.field_id
                  AND recent_field.organization_id = ?
              )
            ORDER BY recent.control_date DESC
            LIMIT 2
          )
      `).bind(
        scope.organizationId,
        fieldIds,
        historyStart,
        asOf,
        scope.organizationId,
        historyStart,
        asOf,
        scope.organizationId,
      ),
      client.prepare(`
        WITH ranked_activity AS (
          SELECT
            activity.id,
            activity.paddock_id AS potreroId,
            activity.type,
            activity.occurred_at AS occurredAt,
            activity.description,
            activity.quantity,
            activity.unit,
            activity.cost_clp AS costClp,
            activity.created_at AS createdAt,
            activity.updated_at AS updatedAt,
            ROW_NUMBER() OVER (
              PARTITION BY paddock.field_id
              ORDER BY activity.occurred_at DESC, activity.created_at DESC, activity.id DESC
            ) AS fieldRank
          FROM activities AS activity
          INNER JOIN potreros AS paddock ON paddock.id = activity.paddock_id
          INNER JOIN fields AS field ON field.id = paddock.field_id
          WHERE field.organization_id = ?
            AND field.id IN (SELECT value FROM json_each(?))
            AND activity.deleted_at IS NULL
            AND paddock.deleted_at IS NULL
            AND paddock.archived_at IS NULL
        )
        SELECT
          id, potreroId, type, occurredAt, description, quantity, unit,
          costClp, createdAt, updatedAt
        FROM ranked_activity
        WHERE fieldRank <= 5
        ORDER BY occurredAt DESC, createdAt DESC, id DESC
      `).bind(scope.organizationId, fieldIds),
      ...(options.includeActivityCosts
        ? [client.prepare(`
            SELECT
              paddock.field_id AS fieldId,
              substr(activity.occurred_at, 1, 7) AS period,
              SUM(COALESCE(activity.cost_clp, 0)) AS costClp
            FROM activities AS activity
            INNER JOIN potreros AS paddock ON paddock.id = activity.paddock_id
            INNER JOIN fields AS field ON field.id = paddock.field_id
            WHERE field.organization_id = ?
              AND field.id IN (SELECT value FROM json_each(?))
              AND activity.deleted_at IS NULL
              AND paddock.deleted_at IS NULL
              AND paddock.archived_at IS NULL
            GROUP BY paddock.field_id, substr(activity.occurred_at, 1, 7)
            ORDER BY paddock.field_id, period DESC
          `).bind(scope.organizationId, fieldIds)]
        : []),
    ]);

  const lots = resultRows<LotRow>(lotResult).map(toLot);
  const animalRows = resultRows<AnimalLotRow>(animalResult);
  const animals = animalRows.map(toAnimal);
  const reproductiveEvents = resultRows<ReproductiveRow>(reproductiveResult);
  const births = resultRows<BirthRow>(birthResult);
  const healthEvents = resultRows<HealthRow>(healthResult).map((row) => ({
    ...row,
    metadata: parseRecord(row.metadata),
  }));
  const accessibleFields = new Set(scope.fieldIds);
  const herdWorkItems = buildDashboardHerdWorkItems({
    animals,
    lots,
    reproductiveEvents,
    births,
    healthEvents: healthEvents.filter((event) => accessibleFields.has(event.fieldId)),
    now,
  });

  const dairyAnimalsById = new Map(
    animalRows.flatMap((row) =>
      row.animalStatus === "active" && (row.category === "dairy_cow" || row.category === "dry_cow")
        ? [[row.animalId, { fieldId: row.lotFieldId, tag: row.tag, lotName: row.lotName }] as const]
        : []),
  );
  const mammaryHealth = calculateMammaryHealth(
    resultRows<MilkControlRow>(controlResult),
    healthEvents.filter((event) => dairyAnimalsById.has(event.animalId)),
    asOf,
  );
  const mammaryWorkItems = buildMammaryWorklist(mammaryHealth).flatMap((item) => {
    const animal = dairyAnimalsById.get(item.animalId);
    return animal ? [{ ...item, ...animal }] : [];
  }) as MilkMammaryWorkItem[];

  const activities = resultRows<Activity>(activityResult).map((activity) => ({ ...activity }));
  const activityCostsByPeriod = activityCostResult
    ? resultRows<DashboardActivityCost>(activityCostResult).map((cost) => ({
        fieldId: cost.fieldId,
        period: cost.period,
        costClp: cost.costClp,
      }))
    : [];

  return { activities, activityCostsByPeriod, animals, lots, herdWorkItems, mammaryWorkItems };
}

function toAnimal(row: AnimalLotRow): LivestockAnimal {
  return {
    id: row.animalId,
    lotId: row.animalLotId,
    tag: row.tag,
    sex: row.sex,
    status: row.animalStatus,
    statusDate: row.statusDate,
    statusReason: row.statusReason,
    birthDate: row.birthDate,
    purchasePriceClp: row.purchasePriceClp,
    purchaseDate: row.purchaseDate,
    salePriceClp: row.salePriceClp,
    saleBuyer: row.saleBuyer,
    saleWeightKg: row.saleWeightKg,
    origin: row.origin,
    notes: row.animalNotes,
    source: row.animalSource,
    latestWeightKg: row.latestWeightKg,
    latestWeightDate: row.latestWeightDate,
    createdAt: row.animalCreatedAt,
  };
}

function toLot(row: LotRow): LivestockLot {
  return {
    id: row.lotId,
    fieldId: row.lotFieldId,
    paddockId: row.paddockId,
    name: row.lotName,
    category: row.category,
    animalCount: row.animalCount,
    averageWeightKg: row.averageWeightKg,
    entryDate: row.entryDate,
    status: row.lotStatus,
    ownerName: row.ownerName,
    trackingMode: row.trackingMode,
    notes: row.lotNotes,
    createdAt: row.lotCreatedAt,
    updatedAt: row.lotUpdatedAt,
  };
}

function resultRows<T>(result: { results?: unknown[]; success?: boolean }): T[] {
  if (result.success === false || !Array.isArray(result.results)) {
    throw new Error("No se pudo construir el snapshot operacional del dashboard.");
  }
  return result.results as T[];
}

function parseRecord(value: string | Record<string, unknown>): Record<string, unknown> {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function emptySnapshot(): DashboardOperationalSnapshot {
  return {
    activities: [],
    activityCostsByPeriod: [],
    animals: [],
    lots: [],
    herdWorkItems: [],
    mammaryWorkItems: [],
  };
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayInChile(now: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Santiago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
