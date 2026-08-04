import { writeFile } from "node:fs/promises";
import path from "node:path";

import * as demo from "../../src/modules/demo/data/demo-data.mjs";
import { portableMilkSettlementIntegrityIssues } from "../../src/modules/leche/server/milk-settlement-integrity.mjs";

const root = process.cwd();
const output = path.join(root, "drizzle", "0002_public_demo.sql");
const ORGANIZATION_ID = "org-fundosmart-demo";
const ACTOR = "system:public-demo-seed";
const DEMO_STATE_KEY = "fundosmart-community-public-demo-v1";
const statements = [];

const add = (sql) => statements.push(sql.trim());
const seed = (table, columns, rows) => {
  if (rows.length === 0) return;
  add(`WITH seed (${columns.map(quoteIdentifier).join(", ")}) AS (
  VALUES
${rows
    .map((row) => `    (${columns.map((column) => sqlLiteral(row[column])).join(", ")})`)
    .join(",\n")}
)
INSERT OR IGNORE INTO ${quoteIdentifier(table)} (${columns.map(quoteIdentifier).join(", ")})
SELECT ${columns.map(quoteIdentifier).join(", ")} FROM seed`);
};

seed("organizations", ["id", "name", "kind", "plan_code", "created_at"], [{
  id: ORGANIZATION_ID,
  name: "FundoSmart Demo",
  kind: "demo",
  plan_code: "legacy",
  created_at: demo.DEMO_CREATED_AT,
}]);

seed("fields", [
  "id", "organization_id", "name", "location", "is_demo", "area_hectares", "coordinates", "created_at",
], [{
  id: demo.DEMO_FIELD.id,
  organization_id: ORGANIZATION_ID,
  name: demo.DEMO_FIELD.name,
  location: demo.DEMO_FIELD.location,
  is_demo: true,
  area_hectares: demo.DEMO_FIELD.areaHectares,
  coordinates: demo.DEMO_FIELD.coordinates,
  created_at: demo.DEMO_CREATED_AT,
}]);

seed("organization_memberships", [
  "id", "organization_id", "user_email", "normalized_email", "display_name", "role", "status",
  "created_by", "created_at", "updated_at",
], [{
  id: demo.DEMO_MEMBERSHIP_ID,
  organization_id: ORGANIZATION_ID,
  user_email: demo.DEMO_EMAIL,
  normalized_email: demo.DEMO_EMAIL,
  display_name: "Usuario Demo",
  role: "viewer",
  status: "active",
  created_by: ACTOR,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
}]);

seed("membership_field_access", ["id", "membership_id", "field_id", "created_by", "created_at"], [{
  id: "membership-field-fundo-el-ejemplo-demo",
  membership_id: demo.DEMO_MEMBERSHIP_ID,
  field_id: demo.DEMO_FIELD_ID,
  created_by: ACTOR,
  created_at: demo.DEMO_CREATED_AT,
}]);

seed("organization_feature_flags", [
  "id", "organization_id", "field_id", "feature", "enabled", "created_by", "updated_by", "created_at", "updated_at",
], ["trazabilidad", "pastoreo", "analitica", "benchmarking"].map((feature) => ({
  id: `feature-demo-${feature}`,
  organization_id: ORGANIZATION_ID,
  field_id: demo.DEMO_FIELD_ID,
  feature,
  enabled: true,
  created_by: ACTOR,
  updated_by: ACTOR,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
})));

seed("potreros", [
  "id", "field_id", "name", "sector", "area_hectares", "coordinates", "grazeable_area_hectares",
  "land_use", "hole_kinds", "soil_ph", "soil_nitrogen", "soil_phosphorus", "soil_potassium",
  "last_activity", "status", "created_at", "updated_at",
], demo.DEMO_PADDOCKS.map((paddock) => ({
  id: paddock.id,
  field_id: paddock.fieldId,
  name: paddock.name,
  sector: paddock.sector,
  area_hectares: paddock.areaHectares,
  coordinates: paddock.coordinates,
  grazeable_area_hectares: paddock.grazeableAreaHectares,
  land_use: paddock.landUse,
  hole_kinds: paddock.holeKinds,
  soil_ph: paddock.soil.ph,
  soil_nitrogen: paddock.soil.nitrogen,
  soil_phosphorus: paddock.soil.phosphorus,
  soil_potassium: paddock.soil.potassium,
  last_activity: paddock.lastActivity,
  status: paddock.status,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
})));

seed("activities", [
  "id", "paddock_id", "type", "occurred_at", "description", "quantity", "unit", "cost_clp", "created_at", "updated_at",
], demo.DEMO_ACTIVITIES.map((activity) => ({
  id: activity.id,
  paddock_id: activity.potreroId,
  type: activity.type,
  occurred_at: activity.occurredAt,
  description: activity.description,
  quantity: activity.quantity,
  unit: activity.unit,
  cost_clp: activity.costClp,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
})));

seed("livestock_lots", [
  "id", "field_id", "paddock_id", "name", "category", "animal_count", "average_weight_kg", "entry_date",
  "status", "owner_name", "tracking_mode", "notes", "created_at", "updated_at",
], demo.DEMO_LOTS.map((lot) => ({
  id: lot.id,
  field_id: lot.fieldId,
  paddock_id: lot.paddockId,
  name: lot.name,
  category: lot.category,
  animal_count: lot.animalCount,
  average_weight_kg: lot.averageWeightKg,
  entry_date: lot.entryDate,
  status: lot.status,
  owner_name: lot.ownerName,
  tracking_mode: lot.trackingMode,
  notes: lot.notes,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
})));

seed("livestock_animals", [
  "id", "lot_id", "tag", "sex", "status", "status_date", "status_reason", "birth_date", "purchase_price_clp",
  "purchase_date", "origin", "notes", "source", "created_at", "updated_at",
], demo.DEMO_ANIMALS.map((animal) => ({
  id: animal.id,
  lot_id: animal.lotId,
  tag: animal.tag,
  sex: animal.sex,
  status: animal.status,
  status_date: animal.statusDate,
  status_reason: animal.statusReason,
  birth_date: animal.birthDate,
  purchase_price_clp: animal.purchasePriceClp,
  purchase_date: animal.purchaseDate,
  origin: animal.origin,
  notes: animal.notes,
  source: animal.source,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
})));

seed("livestock_weighings", [
  "id", "lot_id", "animal_id", "recorded_at", "weight_kg", "notes", "source", "created_at",
], demo.DEMO_WEIGHINGS.map((weighing) => ({
  id: weighing.id,
  lot_id: weighing.lotId,
  animal_id: weighing.animalId,
  recorded_at: weighing.recordedAt,
  weight_kg: weighing.weightKg,
  notes: weighing.notes,
  source: weighing.source,
  created_at: demo.DEMO_CREATED_AT,
})));

seed("livestock_feeding_plans", [
  "id", "lot_id", "product_name", "kg_per_animal_day", "sack_weight_kg", "notes", "created_at", "updated_at",
], demo.DEMO_FEEDING_PLANS.map((plan) => ({
  id: plan.id,
  lot_id: plan.lotId,
  product_name: plan.productName,
  kg_per_animal_day: plan.kgPerAnimalDay,
  sack_weight_kg: plan.sackWeightKg,
  notes: plan.notes,
  created_at: demo.DEMO_CREATED_AT,
  updated_at: demo.DEMO_CREATED_AT,
})));

seed("livestock_expenses", [
  "id", "organization_id", "field_id", "date", "description", "category", "amount_clp", "payment_source",
  "paid_by_id", "lot_id", "created_at",
], demo.DEMO_EXPENSES.map((expense) => ({
  id: expense.id,
  organization_id: ORGANIZATION_ID,
  field_id: expense.fieldId,
  date: expense.date,
  description: expense.description,
  category: expense.category,
  amount_clp: expense.amountClp,
  payment_source: expense.paymentSource,
  paid_by_id: expense.paidById,
  lot_id: expense.lotId,
  created_at: demo.DEMO_CREATED_AT,
})));

const milkColumns = [
  "id", "field_id", "period", "generated_at", "plant", "purchase_order", "producer_code", "producer_name",
  "buyer_name", "liters_first_half", "liters_second_half", "total_liters", "net_amount_clp", "tax_amount_clp",
  "gross_amount_clp", "net_price_per_liter_clp", "gross_price_per_liter_clp", "source_document_name", "notes",
  "line_items", "created_at", "updated_at",
];
seed("milk_settlements", milkColumns, demo.DEMO_MILK_SETTLEMENTS.map((settlement) => {
  const row = {
    id: settlement.id,
    field_id: settlement.fieldId,
    period: settlement.period,
    generated_at: settlement.generatedAt,
    plant: settlement.plant,
    purchase_order: settlement.purchaseOrder,
    producer_code: settlement.producerCode,
    producer_name: settlement.producerName,
    buyer_name: settlement.buyerName,
    liters_first_half: settlement.litersFirstHalf,
    liters_second_half: settlement.litersSecondHalf,
    total_liters: settlement.totalLiters,
    net_amount_clp: settlement.netAmountClp,
    tax_amount_clp: settlement.taxAmountClp,
    gross_amount_clp: settlement.grossAmountClp,
    net_price_per_liter_clp: settlement.netPricePerLiterClp,
    gross_price_per_liter_clp: settlement.grossPricePerLiterClp,
    source_document_name: settlement.sourceDocumentName,
    notes: settlement.notes,
    line_items: settlement.lineItems,
    created_at: demo.DEMO_CREATED_AT,
    updated_at: demo.DEMO_CREATED_AT,
  };
  const [issue] = portableMilkSettlementIntegrityIssues(row);
  if (issue) throw new Error(`Liquidación demo inválida ${settlement.id}: ${issue}`);
  return row;
}));

seed("app_state", ["key", "value", "updated_at"], [{
  key: DEMO_STATE_KEY,
  value: {
    provenance: "deterministic-synthetic",
    privateSources: false,
    fieldId: demo.DEMO_FIELD_ID,
    paddocks: demo.DEMO_PADDOCKS.length,
    animals: demo.DEMO_ANIMALS.length,
  },
  updated_at: demo.DEMO_CREATED_AT,
}]);

seed("audit_log", [
  "id", "organization_id", "field_id", "actor", "action", "entity_type", "entity_id", "after", "occurred_at",
], [{
  id: "audit-public-demo-created",
  organization_id: ORGANIZATION_ID,
  field_id: demo.DEMO_FIELD_ID,
  actor: ACTOR,
  action: "demo.account.seeded",
  entity_type: "organization_membership",
  entity_id: demo.DEMO_MEMBERSHIP_ID,
  after: {
    email: demo.DEMO_EMAIL,
    role: "viewer",
    fieldIds: [demo.DEMO_FIELD_ID],
    fictitiousData: true,
    provenance: "deterministic-synthetic",
  },
  occurred_at: demo.DEMO_CREATED_AT,
}]);

const header = [
  "-- Generated by scripts/data/generate-public-demo-migration.mjs.",
  "-- Every row is deterministic and fictitious; no customer or operational source was used.",
  "",
].join("\n");

await writeFile(output, `${header}${statements.join(";\n--> statement-breakpoint\n")};\n`, "utf8");

function quoteIdentifier(value) {
  return `\`${String(value).replaceAll("`", "``")}\``;
}

function sqlLiteral(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`Non-finite SQL number: ${value}`);
    return String(value);
  }
  const serialized = typeof value === "object" ? JSON.stringify(value) : String(value);
  return `'${serialized.replaceAll("'", "''")}'`;
}
