import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiAccess,
  reauthorizeApiSnapshotAccess,
  requireContextField,
  requireResourceField,
} from "@/app/access";
import {
  consumeLivestockFeed,
  listLivestockFeedData,
  LivestockFeedRuleError,
  normalizeFeedConsumptionInput,
  normalizeFeedStockReceiptInput,
  receiveLivestockFeedStock,
} from "@/src/modules/ganado/server/livestock-feed-repository";

export const dynamic = "force-dynamic";

export async function GET() {
  const access = await authorizeApiAccess();
  if (isAccessResponse(access)) return access;
  try {
    const feedData = await listLivestockFeedData(access.fieldIds);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "view",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json(feedData, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (cause) {
    console.error("[ganado] livestock feed query failed", cause);
    return Response.json({ error: "No fue posible cargar el inventario de alimento." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const access = await authorizeApiAccess("operate");
  if (isAccessResponse(access)) return access;

  let payload: unknown;
  try {
    payload = await request.json() as unknown;
  } catch {
    return Response.json({ error: "La solicitud no contiene datos validos.", code: "PAYLOAD_INVALID" }, { status: 400 });
  }

  try {
    const action = readAction(payload);
    if (action === "receive_stock") {
      const input = normalizeFeedStockReceiptInput(payload);
      const fieldForbidden = requireContextField(access, input.fieldId);
      if (fieldForbidden) return fieldForbidden;

      if (input.expense) {
        const financeAccess = await authorizeApiAccess("manage_finance");
        if (isAccessResponse(financeAccess)) return financeAccess;
        const financeFieldForbidden = requireContextField(financeAccess, input.fieldId);
        if (financeFieldForbidden) return financeFieldForbidden;
      }

      const result = await receiveLivestockFeedStock(input, access.email);
      const currentAccess = await reauthorizeApiAccess(access, "operate", input.fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return Response.json(result, { status: result.replayed ? 200 : 201 });
    }

    if (action === "consume") {
      const input = normalizeFeedConsumptionInput(payload);
      const fieldForbidden = requireContextField(access, input.fieldId);
      if (fieldForbidden) return fieldForbidden;
      const lotForbidden = await requireResourceField(access, "lot", input.lotId);
      if (lotForbidden) return lotForbidden;

      const result = await consumeLivestockFeed(input, access.email);
      const currentAccess = await reauthorizeApiAccess(access, "operate", input.fieldId);
      if (isAccessResponse(currentAccess)) return currentAccess;
      return Response.json(result, { status: result.replayed ? 200 : 201 });
    }

    return Response.json({ error: "Selecciona una operacion de alimentacion soportada." }, { status: 400 });
  } catch (cause) {
    if (cause instanceof LivestockFeedRuleError) {
      return Response.json({ error: cause.message, code: cause.code }, { status: cause.status });
    }
    console.error("[ganado] livestock feed mutation failed", cause);
    return Response.json({ error: "No fue posible registrar la operacion de alimentacion." }, { status: 500 });
  }
}

function readAction(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const action = (value as Record<string, unknown>).action;
  return typeof action === "string" ? action.trim() : null;
}
