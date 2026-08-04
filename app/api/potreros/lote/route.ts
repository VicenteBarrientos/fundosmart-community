import { authorizeApiAccess, isAccessResponse, reauthorizeApiAccess, requireContextField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { getPotreroReplacementPreview, replacePotrerosForFundo } from "@/src/modules/potreros/server/potrero-repository";
import type { Potrero } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

type BulkPayload = {
  fundoId?: string;
  potreros?: Potrero[];
  confirmReplace?: boolean;
  expectedSnapshotToken?: string;
};

export async function GET(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const fundoId = new URL(request.url).searchParams.get("fundoId")?.trim();
    if (!fundoId) return Response.json({ error: "Selecciona un fundo." }, { status: 400 });
    const forbidden = requireContextField(access, fundoId);
    if (forbidden) return forbidden;

    const preview = await getPotreroReplacementPreview(fundoId, access);
    const currentAccess = await reauthorizeApiAccess(access, "view", fundoId);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ preview });
  } catch (error) {
    return replacementError(error);
  }
}

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<BulkPayload>(request);
    if (payload instanceof Response) return payload;
    const error = validatePayload(payload);
    if (error) return Response.json({ error }, { status: 400 });
    if (!payload.expectedSnapshotToken?.trim()) {
      return Response.json({ error: "Actualiza la previsualización antes de reemplazar los potreros." }, { status: 409 });
    }
    const forbidden = requireContextField(access, payload.fundoId);
    if (forbidden) return forbidden;

    const saved = await replacePotrerosForFundo(
      payload.fundoId!,
      payload.potreros!,
      access,
      payload.expectedSnapshotToken.trim(),
    );
    const currentAccess = await reauthorizeApiAccess(access, "operate", payload.fundoId!);
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ potreros: saved }, { status: 201 });
  } catch (error) {
    return replacementError(error);
  }
}

function replacementError(error: unknown) {
  if (error instanceof DomainRuleError && error.code === "FIELD_SCOPE_CONFLICT") {
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  }
  if (error instanceof DomainRuleError) {
    return Response.json({ error: error.message, code: error.code }, { status: 409 });
  }
  return Response.json({ error: "No fue posible crear las subdivisiones." }, { status: 500 });
}

function validatePayload(payload: BulkPayload) {
  if (!payload.confirmReplace) return "Debes confirmar el reemplazo de los potreros actuales.";
  if (!payload.fundoId?.trim()) return "Selecciona un fundo.";
  if (!Array.isArray(payload.potreros) || payload.potreros.length < 2) return "Crea al menos dos subdivisiones.";

  for (const potrero of payload.potreros) {
    if (!potrero.id?.trim() || potrero.fieldId !== payload.fundoId) return "Hay un potrero con identificación inválida.";
    if (!potrero.name?.trim() || !potrero.sector?.trim()) return "Todos los potreros necesitan nombre y sector.";
    if (!Array.isArray(potrero.coordinates) || potrero.coordinates.length < 3) return "Una subdivisión no tiene suficientes puntos.";
    if (!Number.isFinite(potrero.areaHectares) || potrero.areaHectares <= 0) return "Una subdivisión tiene una superficie inválida.";
  }

  return null;
}
