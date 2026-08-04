import { authorizeApiAccess, isAccessResponse, requireResourceField } from "@/app/access";
import { readJsonObject } from "@/app/json-body.mjs";
import { updatePotreroBoundaries } from "@/src/modules/potreros/server/potrero-repository";
import type { Potrero } from "@/src/modules/potreros/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;
    const payload = await readJsonObject<{ potreros?: Potrero[] }>(request);
    if (payload instanceof Response) return payload;
    if (!Array.isArray(payload.potreros) || payload.potreros.length === 0) {
      return Response.json({ error: "No hay límites para actualizar." }, { status: 400 });
    }

    for (const potrero of payload.potreros) {
      if (!potrero.id?.trim()) return Response.json({ error: "Falta el identificador de un potrero." }, { status: 400 });
      if (!Array.isArray(potrero.coordinates) || potrero.coordinates.length < 3) {
        return Response.json({ error: "Cada potrero necesita al menos tres vértices." }, { status: 400 });
      }
      if (!Number.isFinite(potrero.areaHectares) || potrero.areaHectares <= 0) {
        return Response.json({ error: "Una superficie calculada no es válida." }, { status: 400 });
      }
      if (!potrero.updatedAt?.trim()) {
        return Response.json({ error: "Actualiza los potreros antes de modificar sus límites." }, { status: 409 });
      }
      const forbidden = await requireResourceField(access, "paddock", potrero.id);
      if (forbidden) return forbidden;
    }

    const saved = await updatePotreroBoundaries(payload.potreros, access);
    return Response.json({ potreros: saved });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "FIELD_SCOPE_CONFLICT") {
      return Response.json({ error: error.message }, { status: 409 });
    }
    return Response.json({ error: "No fue posible actualizar los límites." }, { status: 500 });
  }
}
