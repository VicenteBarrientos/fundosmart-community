import type { LivestockFeedConsumption, LivestockFeedInventory } from "@/src/core/domain/types";

export type FeedExpenseRequest = {
  id: string;
  date: string | null;
  description: string;
  amountClp: number;
  paymentSource: "society" | "partner" | "unassigned";
  paidById: string | null;
};

export type FeedStockReceiptInput = {
  requestId: string;
  inventoryId: string;
  fieldId: string;
  productName: string;
  quantityKg: number;
  unitCostClp: number;
  reorderLevelKg: number | null;
  expense: FeedExpenseRequest | null;
};

export type FeedConsumptionInput = {
  id: string;
  fieldId: string;
  inventoryId: string;
  lotId: string;
  planId: string | null;
  occurredAt: string;
  quantityKg: number;
  source: string;
};

export type LivestockFeedData = {
  inventory: LivestockFeedInventory[];
  consumptions: LivestockFeedConsumption[];
};

export class LivestockFeedRuleError extends Error {
  status: number;
  code: string;

  constructor(message: string, code: string, status = 400) {
    super(message);
    this.name = "LivestockFeedRuleError";
    this.status = status;
    this.code = code;
  }
}

type InventoryRow = {
  id: string;
  field_id: string;
  product_name: string;
  quantity_kg: number;
  unit_cost_clp: number;
  reorder_level_kg: number;
  created_at: string;
  updated_at: string;
};

type ConsumptionRow = {
  id: string;
  field_id: string;
  lot_id: string;
  inventory_item_id: string;
  plan_id: string | null;
  occurred_at: string;
  quantity_kg: number;
  cost_clp: number;
  source: string;
  created_by: string;
  created_at: string;
};

type AuditRow = { after: string | Record<string, unknown> | null };

export function normalizeFeedStockReceiptInput(value: unknown): FeedStockReceiptInput {
  const input = objectValue(value);
  const requestId = identifier(input.requestId, "Falta el identificador idempotente de la recepción.", "RECEIPT_REQUEST_ID_REQUIRED");
  const inventoryId = identifier(input.inventoryId, "Falta el identificador del stock.", "INVENTORY_ID_REQUIRED");
  const fieldId = identifier(input.fieldId, "Selecciona un fundo.", "FIELD_REQUIRED");
  const productName = requiredText(input.productName, 180, "Indica el alimento recibido.", "PRODUCT_REQUIRED");
  const quantityKg = positiveNumber(input.quantityKg, "La cantidad recibida debe ser mayor que cero.", "RECEIPT_QUANTITY_INVALID");
  const unitCostClp = nonNegativeNumber(input.unitCostClp, "El costo unitario no puede ser negativo.", "UNIT_COST_INVALID");
  const reorderLevelKg = input.reorderLevelKg === null || input.reorderLevelKg === undefined || input.reorderLevelKg === ""
    ? null
    : nonNegativeNumber(input.reorderLevelKg, "El nivel de reposición no puede ser negativo.", "REORDER_LEVEL_INVALID");
  const expense = input.expense === null || input.expense === undefined ? null : normalizeExpense(input.expense);
  return {
    requestId,
    inventoryId,
    fieldId,
    productName,
    quantityKg: round(quantityKg, 3),
    unitCostClp: round(unitCostClp, 4),
    reorderLevelKg: reorderLevelKg === null ? null : round(reorderLevelKg, 3),
    expense,
  };
}

export function normalizeFeedConsumptionInput(value: unknown): FeedConsumptionInput {
  const input = objectValue(value);
  return {
    id: identifier(input.id, "Falta el identificador idempotente del consumo.", "CONSUMPTION_ID_REQUIRED"),
    fieldId: identifier(input.fieldId, "Selecciona un fundo.", "FIELD_REQUIRED"),
    inventoryId: identifier(input.inventoryId, "Selecciona el alimento a descontar.", "INVENTORY_ID_REQUIRED"),
    lotId: identifier(input.lotId, "Selecciona el lote que consumió el alimento.", "LOT_REQUIRED"),
    planId: optionalIdentifier(input.planId),
    occurredAt: isoDate(input.occurredAt, "Indica una fecha de consumo válida.", "CONSUMPTION_DATE_INVALID"),
    quantityKg: round(positiveNumber(input.quantityKg, "La cantidad consumida debe ser mayor que cero.", "CONSUMPTION_QUANTITY_INVALID"), 3),
    source: optionalText(input.source, 120) || "Registro manual",
  };
}

export function calculateWeightedUnitCost(
  currentQuantityKg: number,
  currentUnitCostClp: number,
  receivedQuantityKg: number,
  receivedUnitCostClp: number,
): number {
  const totalQuantity = currentQuantityKg + receivedQuantityKg;
  if (totalQuantity <= 0) return receivedUnitCostClp;
  return ((currentQuantityKg * currentUnitCostClp) + (receivedQuantityKg * receivedUnitCostClp)) / totalQuantity;
}

export function calculateFeedConsumptionCost(quantityKg: number, unitCostClp: number): number {
  return Math.round(quantityKg * unitCostClp);
}

export async function listLivestockFeedData(fieldIds: string[]): Promise<LivestockFeedData> {
  if (fieldIds.length === 0) return { inventory: [], consumptions: [] };
  const client = await databaseClient();
  const placeholders = fieldIds.map(() => "?").join(", ");
  const [inventoryResult, consumptionResult] = await client.batch([
    client.prepare(`
      SELECT id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg, created_at, updated_at
      FROM livestock_feed_inventory
      WHERE field_id IN (${placeholders})
      ORDER BY field_id, product_name, id
    `).bind(...fieldIds),
    client.prepare(`
      SELECT id, field_id, lot_id, inventory_item_id, plan_id, occurred_at, quantity_kg, cost_clp, source, created_by, created_at
      FROM livestock_feed_consumptions
      WHERE field_id IN (${placeholders})
      ORDER BY occurred_at DESC, created_at DESC, id
    `).bind(...fieldIds),
  ]);
  return {
    inventory: (inventoryResult.results as unknown as InventoryRow[]).map(toInventory),
    consumptions: (consumptionResult.results as unknown as ConsumptionRow[]).map(toConsumption),
  };
}

export async function receiveLivestockFeedStock(
  input: FeedStockReceiptInput,
  actor: string,
): Promise<{ inventory: LivestockFeedInventory; expenseId: string | null; replayed: boolean }> {
  const client = await databaseClient();
  const markerId = receiptMarkerId(input.requestId);
  const fingerprint = receiptFingerprint(input);
  const existingMarker = await client.prepare("SELECT after FROM audit_log WHERE id = ?").bind(markerId).first<AuditRow>();
  if (existingMarker) {
    assertMatchingFingerprint(existingMarker.after, fingerprint, "RECEIPT_IDEMPOTENCY_CONFLICT");
    const replayInventory = await findInventoryByProduct(client, input.fieldId, input.productName);
    if (!replayInventory) throw new LivestockFeedRuleError("La recepción existe, pero su stock no está disponible.", "RECEIPT_INVENTORY_MISSING", 409);
    return { inventory: toInventory(replayInventory), expenseId: input.expense?.id ?? null, replayed: true };
  }

  const scope = await client.prepare("SELECT id, organization_id FROM fields WHERE id = ?").bind(input.fieldId).first<{ id: string; organization_id: string }>();
  if (!scope) throw new LivestockFeedRuleError("El fundo seleccionado no existe.", "FIELD_NOT_FOUND", 404);
  const inventoryWithId = await client.prepare("SELECT id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg, created_at, updated_at FROM livestock_feed_inventory WHERE id = ?")
    .bind(input.inventoryId).first<InventoryRow>();
  if (inventoryWithId && (inventoryWithId.field_id !== input.fieldId || inventoryWithId.product_name !== input.productName)) {
    throw new LivestockFeedRuleError("El identificador de stock ya pertenece a otro alimento o fundo.", "INVENTORY_ID_CONFLICT", 409);
  }
  if (input.expense) await assertExpenseCanBeCreated(client, input.expense);

  const now = new Date().toISOString();
  const statements = [
    client.prepare(`
      INSERT INTO livestock_feed_inventory (
        id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg, created_at, updated_at
      ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(field_id, product_name) DO NOTHING
    `).bind(input.inventoryId, input.fieldId, input.productName, input.unitCostClp, input.reorderLevelKg ?? 0, now, now),
    client.prepare(`
      UPDATE livestock_feed_inventory
      SET unit_cost_clp = CASE
            WHEN quantity_kg + ? > 0
              THEN ((quantity_kg * unit_cost_clp) + (? * ?)) / (quantity_kg + ?)
            ELSE ?
          END,
          quantity_kg = quantity_kg + ?,
          reorder_level_kg = COALESCE(?, reorder_level_kg),
          updated_at = ?
      WHERE field_id = ?
        AND product_name = ?
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(
      input.quantityKg,
      input.quantityKg,
      input.unitCostClp,
      input.quantityKg,
      input.unitCostClp,
      input.quantityKg,
      input.reorderLevelKg,
      now,
      input.fieldId,
      input.productName,
      markerId,
    ),
  ];
  if (input.expense) {
    statements.push(client.prepare(`
      INSERT INTO livestock_expenses (
        id, field_id, date, description, category, amount_clp, payment_source, paid_by_id, lot_id, created_at
      )
      SELECT ?, ?, ?, ?, 'alimento', ?, ?, ?, NULL, ?
      WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(
      input.expense.id,
      input.fieldId,
      input.expense.date,
      input.expense.description,
      input.expense.amountClp,
      input.expense.paymentSource,
      input.expense.paymentSource === "partner" ? input.expense.paidById : null,
      now,
      markerId,
    ));
  }
  statements.push(client.prepare(`
    INSERT INTO audit_log (
      id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, source_record_id, occurred_at
    )
    SELECT ?, ?, ?, ?, 'feed.stock_received', 'livestock_feed_inventory', inventory.id, NULL, ?, NULL, ?
    FROM livestock_feed_inventory AS inventory
    WHERE inventory.field_id = ?
      AND inventory.product_name = ?
      AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    ON CONFLICT(id) DO NOTHING
  `).bind(
    markerId,
    scope.organization_id,
    input.fieldId,
    actor,
    JSON.stringify({
      requestFingerprint: fingerprint,
      productName: input.productName,
      quantityKg: input.quantityKg,
      unitCostClp: input.unitCostClp,
      expenseId: input.expense?.id ?? null,
    }),
    now,
    input.fieldId,
    input.productName,
    markerId,
  ));

  const results = await client.batch(statements);
  const applied = Number(results[1]?.meta?.changes ?? 0) > 0;
  const saved = await findInventoryByProduct(client, input.fieldId, input.productName);
  if (!saved) throw new LivestockFeedRuleError("No fue posible materializar el stock recibido.", "RECEIPT_NOT_APPLIED", 409);
  return { inventory: toInventory(saved), expenseId: input.expense?.id ?? null, replayed: !applied };
}

export async function consumeLivestockFeed(
  input: FeedConsumptionInput,
  actor: string,
): Promise<{ consumption: LivestockFeedConsumption; inventory: LivestockFeedInventory; replayed: boolean }> {
  const client = await databaseClient();
  const existing = await client.prepare(`
    SELECT id, field_id, lot_id, inventory_item_id, plan_id, occurred_at, quantity_kg, cost_clp, source, created_by, created_at
    FROM livestock_feed_consumptions WHERE id = ?
  `).bind(input.id).first<ConsumptionRow>();
  if (existing) {
    assertMatchingConsumption(existing, input);
    const replayInventory = await findInventoryById(client, input.inventoryId);
    if (!replayInventory) throw new LivestockFeedRuleError("El consumo existe, pero su stock no está disponible.", "CONSUMPTION_INVENTORY_MISSING", 409);
    return { consumption: toConsumption(existing), inventory: toInventory(replayInventory), replayed: true };
  }

  const inventory = await findInventoryById(client, input.inventoryId);
  if (!inventory || inventory.field_id !== input.fieldId) {
    throw new LivestockFeedRuleError("El alimento seleccionado no existe en este fundo.", "INVENTORY_NOT_FOUND", 404);
  }
  const lot = await client.prepare(`
    SELECT lots.id, lots.field_id, fields.organization_id
    FROM livestock_lots AS lots
    INNER JOIN fields ON fields.id = lots.field_id
    WHERE lots.id = ?
  `).bind(input.lotId).first<{ id: string; field_id: string; organization_id: string }>();
  if (!lot || lot.field_id !== input.fieldId) {
    throw new LivestockFeedRuleError("El lote no pertenece al fundo seleccionado.", "LOT_FIELD_MISMATCH", 409);
  }
  if (input.planId) {
    const plan = await client.prepare("SELECT id, lot_id, product_name FROM livestock_feeding_plans WHERE id = ?")
      .bind(input.planId).first<{ id: string; lot_id: string; product_name: string }>();
    if (!plan || plan.lot_id !== input.lotId || plan.product_name !== inventory.product_name) {
      throw new LivestockFeedRuleError("El plan no corresponde al lote y alimento seleccionados.", "FEEDING_PLAN_MISMATCH", 409);
    }
  }
  if (inventory.quantity_kg < input.quantityKg) {
    throw new LivestockFeedRuleError("El stock disponible no alcanza para registrar este consumo.", "INSUFFICIENT_FEED_STOCK", 409);
  }

  const now = new Date().toISOString();
  const markerId = consumptionMarkerId(input.id);
  const fingerprint = consumptionFingerprint(input);
  const results = await client.batch([
    client.prepare(`
      INSERT INTO livestock_feed_consumptions (
        id, field_id, lot_id, inventory_item_id, plan_id, occurred_at, quantity_kg, cost_clp, source, created_by, created_at
      )
      SELECT ?, inventory.field_id, ?, inventory.id, ?, ?, ?, CAST(ROUND(? * inventory.unit_cost_clp) AS INTEGER), ?, ?, ?
      FROM livestock_feed_inventory AS inventory
      WHERE inventory.id = ?
        AND inventory.field_id = ?
        AND inventory.quantity_kg >= ?
        AND NOT EXISTS (SELECT 1 FROM livestock_feed_consumptions WHERE id = ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      input.id,
      input.lotId,
      input.planId,
      input.occurredAt,
      input.quantityKg,
      input.quantityKg,
      input.source,
      actor,
      now,
      input.inventoryId,
      input.fieldId,
      input.quantityKg,
      input.id,
    ),
    client.prepare(`
      UPDATE livestock_feed_inventory
      SET quantity_kg = quantity_kg - ?, updated_at = ?
      WHERE id = ?
        AND quantity_kg >= ?
        AND EXISTS (
          SELECT 1
          FROM livestock_feed_consumptions
          WHERE id = ?
            AND inventory_item_id = livestock_feed_inventory.id
        )
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
    `).bind(input.quantityKg, now, input.inventoryId, input.quantityKg, input.id, markerId),
    client.prepare(`
      INSERT INTO audit_log (
        id, organization_id, field_id, actor, action, entity_type, entity_id, before, after, source_record_id, occurred_at
      )
      SELECT ?, ?, consumption.field_id, ?, 'feed.consumed', 'livestock_feed_consumption', consumption.id,
             NULL, ?, NULL, ?
      FROM livestock_feed_consumptions AS consumption
      WHERE consumption.id = ?
        AND NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      markerId,
      lot.organization_id,
      actor,
      JSON.stringify({ requestFingerprint: fingerprint, inventoryId: input.inventoryId, quantityKg: input.quantityKg }),
      now,
      input.id,
      markerId,
    ),
  ]);

  const savedConsumption = await client.prepare(`
    SELECT id, field_id, lot_id, inventory_item_id, plan_id, occurred_at, quantity_kg, cost_clp, source, created_by, created_at
    FROM livestock_feed_consumptions WHERE id = ?
  `).bind(input.id).first<ConsumptionRow>();
  if (!savedConsumption) {
    throw new LivestockFeedRuleError("El stock cambió y ya no alcanza para registrar el consumo.", "INSUFFICIENT_FEED_STOCK", 409);
  }
  assertMatchingConsumption(savedConsumption, input);
  const savedInventory = await findInventoryById(client, input.inventoryId);
  if (!savedInventory) throw new LivestockFeedRuleError("El stock actualizado no está disponible.", "CONSUMPTION_INVENTORY_MISSING", 409);
  return {
    consumption: toConsumption(savedConsumption),
    inventory: toInventory(savedInventory),
    replayed: Number(results[0]?.meta?.changes ?? 0) === 0,
  };
}

function normalizeExpense(value: unknown): FeedExpenseRequest {
  const input = objectValue(value);
  const paymentSource = requiredText(input.paymentSource, 40, "Indica el origen del pago.", "EXPENSE_PAYMENT_SOURCE_REQUIRED");
  if (!["society", "partner", "unassigned"].includes(paymentSource)) {
    throw new LivestockFeedRuleError("El origen del pago no es válido.", "EXPENSE_PAYMENT_SOURCE_INVALID");
  }
  const paidById = optionalIdentifier(input.paidById);
  if (paymentSource === "partner" && !paidById) {
    throw new LivestockFeedRuleError("Selecciona el socio que pagó la compra.", "EXPENSE_PARTNER_REQUIRED");
  }
  const amountClp = Number(input.amountClp);
  if (!Number.isInteger(amountClp) || amountClp <= 0) {
    throw new LivestockFeedRuleError("El egreso debe ser un monto CLP entero mayor que cero.", "EXPENSE_AMOUNT_INVALID");
  }
  return {
    id: identifier(input.id, "Falta el identificador del egreso.", "EXPENSE_ID_REQUIRED"),
    date: input.date === null || input.date === undefined || input.date === "" ? null : isoDate(input.date, "La fecha del egreso no es válida.", "EXPENSE_DATE_INVALID"),
    description: requiredText(input.description, 300, "Describe la compra de alimento.", "EXPENSE_DESCRIPTION_REQUIRED"),
    amountClp,
    paymentSource: paymentSource as FeedExpenseRequest["paymentSource"],
    paidById: paymentSource === "partner" ? paidById : null,
  };
}

async function assertExpenseCanBeCreated(client: Awaited<ReturnType<typeof databaseClient>>, expense: FeedExpenseRequest) {
  const existing = await client.prepare("SELECT id FROM livestock_expenses WHERE id = ?").bind(expense.id).first<{ id: string }>();
  if (existing) throw new LivestockFeedRuleError("El identificador del egreso ya fue utilizado.", "EXPENSE_ID_CONFLICT", 409);
  if (expense.paymentSource === "partner") {
    const partner = await client.prepare("SELECT id FROM livestock_partners WHERE id = ?").bind(expense.paidById).first<{ id: string }>();
    if (!partner) throw new LivestockFeedRuleError("El socio pagador no existe.", "EXPENSE_PARTNER_NOT_FOUND", 404);
  }
}

function assertMatchingConsumption(row: ConsumptionRow, input: FeedConsumptionInput) {
  const matches = row.field_id === input.fieldId
    && row.lot_id === input.lotId
    && row.inventory_item_id === input.inventoryId
    && row.plan_id === input.planId
    && row.occurred_at === input.occurredAt
    && row.quantity_kg === input.quantityKg
    && row.source === input.source;
  if (!matches) throw new LivestockFeedRuleError("El identificador de consumo ya fue usado con otros datos.", "CONSUMPTION_IDEMPOTENCY_CONFLICT", 409);
}

function assertMatchingFingerprint(after: AuditRow["after"], expected: string, code: string) {
  const parsed = typeof after === "string" ? safeJson(after) : after;
  if (parsed?.requestFingerprint !== expected) {
    throw new LivestockFeedRuleError("El identificador idempotente ya fue usado con otros datos.", code, 409);
  }
}

function receiptFingerprint(input: FeedStockReceiptInput): string {
  return JSON.stringify({
    inventoryId: input.inventoryId,
    fieldId: input.fieldId,
    productName: input.productName,
    quantityKg: input.quantityKg,
    unitCostClp: input.unitCostClp,
    reorderLevelKg: input.reorderLevelKg,
    expense: input.expense,
  });
}

function consumptionFingerprint(input: FeedConsumptionInput): string {
  return JSON.stringify(input);
}

function receiptMarkerId(requestId: string) {
  return `feed-receipt:${requestId}`;
}

function consumptionMarkerId(id: string) {
  return `feed-consumption:${id}`;
}

async function findInventoryById(client: Awaited<ReturnType<typeof databaseClient>>, id: string) {
  return client.prepare(`
    SELECT id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg, created_at, updated_at
    FROM livestock_feed_inventory WHERE id = ?
  `).bind(id).first<InventoryRow>();
}

async function findInventoryByProduct(client: Awaited<ReturnType<typeof databaseClient>>, fieldId: string, productName: string) {
  return client.prepare(`
    SELECT id, field_id, product_name, quantity_kg, unit_cost_clp, reorder_level_kg, created_at, updated_at
    FROM livestock_feed_inventory WHERE field_id = ? AND product_name = ?
  `).bind(fieldId, productName).first<InventoryRow>();
}

function toInventory(row: InventoryRow): LivestockFeedInventory {
  return {
    id: row.id,
    fieldId: row.field_id,
    productName: row.product_name,
    quantityKg: row.quantity_kg,
    unitCostClp: row.unit_cost_clp,
    reorderLevelKg: row.reorder_level_kg,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toConsumption(row: ConsumptionRow): LivestockFeedConsumption {
  return {
    id: row.id,
    fieldId: row.field_id,
    lotId: row.lot_id,
    inventoryItemId: row.inventory_item_id,
    planId: row.plan_id,
    occurredAt: row.occurred_at,
    quantityKg: row.quantity_kg,
    costClp: row.cost_clp,
    source: row.source,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

async function databaseClient() {
  const { getDb } = await import("../../../../db/index");
  return getDb().$client;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new LivestockFeedRuleError("La solicitud no contiene datos válidos.", "PAYLOAD_INVALID");
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, message: string, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > 180 || !/^[A-Za-z0-9:._-]+$/.test(normalized)) {
    throw new LivestockFeedRuleError(message, code);
  }
  return normalized;
}

function optionalIdentifier(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return identifier(value, "El identificador relacionado no es válido.", "RELATED_ID_INVALID");
}

function requiredText(value: unknown, maximum: number, message: string, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > maximum) throw new LivestockFeedRuleError(message, code);
  return normalized;
}

function optionalText(value: unknown, maximum: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized.slice(0, maximum);
}

function positiveNumber(value: unknown, message: string, code: string): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new LivestockFeedRuleError(message, code);
  return parsed;
}

function nonNegativeNumber(value: unknown, message: string, code: string): number {
  const parsed = typeof value === "string" && value.trim() ? Number(value.replace(",", ".")) : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new LivestockFeedRuleError(message, code);
  return parsed;
}

function isoDate(value: unknown, message: string, code: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new LivestockFeedRuleError(message, code);
  const parsed = new Date(`${normalized}T12:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new LivestockFeedRuleError(message, code);
  }
  return normalized;
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
