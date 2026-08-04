import { authorizeApiAccess, isAccessResponse, requireContextField } from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { NextResponse } from "next/server";
import {
  createSaleDocument,
  getAnimalEconomicMargin,
  getSaleDocumentsForField,
  linkSaleDocument,
} from "@/src/modules/ganado/server/livestock-sale-repository";

function actorAccess(access: {
  membershipId: string;
  email: string;
  organizationId: string;
  fieldIds: string[];
}) {
  return {
    membershipId: access.membershipId,
    email: access.email,
    organizationId: access.organizationId,
    fieldIds: access.fieldIds,
  };
}

export async function GET(request: Request) {
  try {
    const accessContext = await authorizeApiAccess("operate");
    if (isAccessResponse(accessContext)) return accessContext;
    const access = actorAccess(accessContext);

    const url = new URL(request.url);
    const action = url.searchParams.get("action") || "documents";
    const fieldId = url.searchParams.get("fieldId") || accessContext.fieldIds[0];
    const animalId = url.searchParams.get("animalId");

    if (action === "margin" && animalId) {
      const margin = await getAnimalEconomicMargin({ access, animalId });
      return NextResponse.json({ margin });
    }

    if (action === "documents") {
      const fieldError = requireContextField(accessContext, fieldId);
      if (fieldError) return fieldError;

      const documents = await getSaleDocumentsForField({ access, fieldId: fieldId! });
      return NextResponse.json({ documents });
    }

    return NextResponse.json({ error: "Acción GET no válida." }, { status: 400 });
  } catch (error) {
    return unexpectedApiFailure("livestock.sales.get", "Fallo al consultar documentos de venta.", error);
  }
}

export async function POST(request: Request) {
  try {
    const accessContext = await authorizeApiAccess("operate");
    if (isAccessResponse(accessContext)) return accessContext;
    const access = actorAccess(accessContext);

    const body = (await request.json().catch(() => ({}))) as {
      action?: string;
      fieldId?: string;
      documentType?: "liquidacion_feria" | "guia_despacho" | "factura_venta";
      documentNumber?: string;
      buyerOrSupplierName?: string;
      documentDate?: string;
      totalAmountClp?: number;
      documentId?: string;
      animalId?: string;
      lotId?: string;
      allocatedAmountClp?: number;
      allocatedWeightKg?: number;
      notes?: string;
    };

    const { action } = body;

    if (action === "create_document") {
      const fieldId = body.fieldId || accessContext.fieldIds[0];
      const fieldError = requireContextField(accessContext, fieldId);
      if (fieldError) return fieldError;

      if (!body.buyerOrSupplierName || !body.documentDate || typeof body.totalAmountClp !== "number") {
        return NextResponse.json({ error: "Datos de comprobante incompletos (comprador, fecha y monto)." }, { status: 400 });
      }

      const doc = await createSaleDocument({
        access,
        fieldId: fieldId!,
        documentType: body.documentType,
        documentNumber: body.documentNumber,
        buyerOrSupplierName: body.buyerOrSupplierName,
        documentDate: body.documentDate,
        totalAmountClp: body.totalAmountClp,
      });

      return NextResponse.json({ document: doc });
    }

    if (action === "link_document") {
      if (!body.documentId || typeof body.allocatedAmountClp !== "number") {
        return NextResponse.json({ error: "Datos de conciliación incompletos (documentId y monto asignado)." }, { status: 400 });
      }

      const link = await linkSaleDocument({
        access,
        documentId: body.documentId,
        animalId: body.animalId,
        lotId: body.lotId,
        allocatedAmountClp: body.allocatedAmountClp,
        allocatedWeightKg: body.allocatedWeightKg,
        notes: body.notes,
      });

      return NextResponse.json({ link });
    }

    return NextResponse.json({ error: "Acción POST no válida." }, { status: 400 });
  } catch (error) {
    return unexpectedApiFailure("livestock.sales.post", "Fallo al procesar documento de venta.", error);
  }
}
