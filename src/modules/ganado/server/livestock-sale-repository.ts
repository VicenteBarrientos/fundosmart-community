import crypto from "node:crypto";
import { getDb } from "@/db";
import {
  livestockAnimals,
  livestockFeedConsumptions,
  livestockExpenses,
  livestockSaleDocumentLinks,
  livestockSaleDocuments,
} from "@/db/schema";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { ImportActorAccess } from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import { assertCurrentImportActorAccess } from "@/src/modules/integraciones/cooprinsem/server/import-repository";
import { calculateAnimalMargin } from "../domain/livestock-margin.mjs";

export type CreateSaleDocumentInput = {
  access: ImportActorAccess;
  fieldId: string;
  documentType?: "liquidacion_feria" | "guia_despacho" | "factura_venta";
  documentNumber?: string;
  buyerOrSupplierName: string;
  documentDate: string;
  totalAmountClp: number;
  objectKey?: string;
  sha256?: string;
};

export type LinkSaleDocumentInput = {
  access: ImportActorAccess;
  documentId: string;
  animalId?: string;
  lotId?: string;
  allocatedAmountClp: number;
  allocatedWeightKg?: number;
  notes?: string;
};

export async function createSaleDocument(input: CreateSaleDocumentInput) {
  await assertCurrentImportActorAccess(input.access, [input.fieldId]);
  const db = getDb();
  const id = `sale-doc-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await db.insert(livestockSaleDocuments).values({
    id,
    organizationId: input.access.organizationId,
    fieldId: input.fieldId,
    documentType: input.documentType || "liquidacion_feria",
    documentNumber: input.documentNumber || null,
    buyerOrSupplierName: input.buyerOrSupplierName.trim(),
    documentDate: input.documentDate,
    totalAmountClp: input.totalAmountClp,
    objectKey: input.objectKey || null,
    sha256: input.sha256 || null,
    status: "pending",
    createdByEmail: input.access.email,
    createdAt: now,
    updatedAt: now,
  });

  return {
    id,
    organizationId: input.access.organizationId,
    fieldId: input.fieldId,
    documentType: input.documentType || "liquidacion_feria",
    documentNumber: input.documentNumber || null,
    buyerOrSupplierName: input.buyerOrSupplierName.trim(),
    documentDate: input.documentDate,
    totalAmountClp: input.totalAmountClp,
    objectKey: input.objectKey || null,
    sha256: input.sha256 || null,
    status: "pending",
    createdByEmail: input.access.email,
    createdAt: now,
    updatedAt: now,
  };
}

export async function linkSaleDocument(input: LinkSaleDocumentInput) {
  await assertCurrentImportActorAccess(input.access, input.access.fieldIds);
  const db = getDb();

  const [doc] = await db
    .select()
    .from(livestockSaleDocuments)
    .where(
      and(
        eq(livestockSaleDocuments.id, input.documentId),
        eq(livestockSaleDocuments.organizationId, input.access.organizationId),
      ),
    )
    .limit(1);

  if (!doc) throw new Error("Documento de venta no encontrado o sin autorización.");

  const linkId = `sale-link-${crypto.randomUUID()}`;
  const now = new Date().toISOString();

  await db.insert(livestockSaleDocumentLinks).values({
    id: linkId,
    documentId: input.documentId,
    animalId: input.animalId || null,
    lotId: input.lotId || null,
    allocatedAmountClp: input.allocatedAmountClp,
    allocatedWeightKg: input.allocatedWeightKg || null,
    notes: input.notes || null,
    createdAt: now,
  });

  // Mark document reconciled
  await db
    .update(livestockSaleDocuments)
    .set({ status: "reconciled", updatedAt: now })
    .where(eq(livestockSaleDocuments.id, input.documentId));

  // If animalId is linked, update sale fields on animal record
  if (input.animalId) {
    await db
      .update(livestockAnimals)
      .set({
        salePriceClp: input.allocatedAmountClp,
        saleBuyer: doc.buyerOrSupplierName,
        saleWeightKg: input.allocatedWeightKg || null,
        status: "sold",
        statusDate: doc.documentDate,
        statusReason: `Vendido según ${doc.documentType} N° ${doc.documentNumber || doc.id}`,
        updatedAt: now,
      })
      .where(eq(livestockAnimals.id, input.animalId));
  }

  return { id: linkId, documentId: input.documentId, status: "reconciled" };
}

export async function getSaleDocumentsForField({
  access,
  fieldId,
}: {
  access: ImportActorAccess;
  fieldId: string;
}) {
  await assertCurrentImportActorAccess(access, [fieldId]);
  const db = getDb();

  const docs = await db
    .select()
    .from(livestockSaleDocuments)
    .where(
      and(
        eq(livestockSaleDocuments.organizationId, access.organizationId),
        eq(livestockSaleDocuments.fieldId, fieldId),
      ),
    )
    .orderBy(desc(livestockSaleDocuments.createdAt));

  const docIds = docs.map((d) => d.id);
  const links = docIds.length > 0
    ? await db
        .select()
        .from(livestockSaleDocumentLinks)
        .where(inArray(livestockSaleDocumentLinks.documentId, docIds))
    : [];

  return docs.map((d) => ({
    ...d,
    links: links.filter((l) => l.documentId === d.id),
  }));
}

export async function getAnimalEconomicMargin({
  access,
  animalId,
}: {
  access: ImportActorAccess;
  animalId: string;
}) {
  await assertCurrentImportActorAccess(access, access.fieldIds);
  const db = getDb();

  const [animal] = await db
    .select()
    .from(livestockAnimals)
    .where(eq(livestockAnimals.id, animalId))
    .limit(1);

  if (!animal) throw new Error("Animal no encontrado.");

  const [saleLink] = await db
    .select()
    .from(livestockSaleDocumentLinks)
    .where(eq(livestockSaleDocumentLinks.animalId, animalId))
    .limit(1);

  const feedConsumptions = animal.lotId
    ? await db
        .select()
        .from(livestockFeedConsumptions)
        .where(eq(livestockFeedConsumptions.lotId, animal.lotId))
    : [];

  const expenses = animal.lotId
    ? await db
        .select()
        .from(livestockExpenses)
        .where(eq(livestockExpenses.lotId, animal.lotId))
    : [];

  let daysInField = 0;
  if (animal.createdAt) {
    const start = new Date(animal.createdAt).getTime();
    const end = animal.statusDate ? new Date(animal.statusDate).getTime() : Date.now();
    daysInField = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
  }

  return calculateAnimalMargin({
    animal,
    saleLink: saleLink ? { allocatedAmountClp: saleLink.allocatedAmountClp, allocatedWeightKg: saleLink.allocatedWeightKg } : null,
    feedConsumptions: feedConsumptions.map((f) => ({ costClp: f.costClp })),
    expenses: expenses.map((e) => ({ amountClp: e.amountClp })),
    categoryAvgDailyFeedCostClp: 1200, // Standard daily average category feed cost
    daysInField,
  });
}
