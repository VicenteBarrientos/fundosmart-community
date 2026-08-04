import {
  authorizeApiAccess,
  isAccessResponse,
  reauthorizeApiSnapshotAccess,
  requireContextField,
  requireResourceField,
} from "@/app/access";
import { unexpectedApiFailure } from "@/app/api-failure.mjs";
import { readJsonObject } from "@/app/json-body.mjs";
import type { LivestockAnimal } from "@/src/core/domain/types";
import { DomainRuleError } from "@/src/core/server/domain-rule-error.mjs";
import { resolveResourceFieldId } from "@/src/modules/access/server/resource-scope";
import { validateAnimalPayload } from "@/src/modules/ganado/server/animal-payload";
import {
  listLivestockAnimals,
  upsertLivestockAnimal,
} from "@/src/modules/ganado/server/livestock-animal-repository";
import { listLivestockLots } from "@/src/modules/ganado/server/livestock-repository";
import { listLivestockWeighings } from "@/src/modules/ganado/server/livestock-weighing-repository";

export const dynamic = "force-dynamic";

/**
 * Una planilla puede tocar muchos animales de una vez, pero no infinitos: el tope
 * mantiene acotado el lote de escrituras y el tiempo de la petición.
 */
const MAX_SPREADSHEET_ROWS = 500;

type SpreadsheetPayload = {
  animals?: Partial<LivestockAnimal>[];
};

/**
 * Confirma una planilla de animales.
 *
 * El orden importa y es deliberado:
 *
 * 1. **Se valida todo antes de escribir nada.** Si una sola fila está mal formada, no se
 *    guarda ninguna. Es el caso común de error y ahí la confirmación es todo o nada.
 * 2. **Se escribe fila por fila reusando `upsertLivestockAnimal`.** No se duplica el SQL
 *    de guardas —pertenencia al fundo, DIIO único, trazabilidad individual, token de
 *    concurrencia—, porque una segunda copia de esas reglas es una copia que algún día
 *    se queda atrás y deja pasar lo que la primera bloquea.
 * 3. **Si una fila choca, se detiene y se informa cuáles quedaron guardadas.** Cada
 *    animal es atómico por su cuenta, así que el estado parcial siempre es un estado
 *    válido; el cliente poda el borrador con `savedIds` y reintenta el resto sin volver
 *    a tipear.
 */
export async function POST(request: Request) {
  try {
    const access = await authorizeApiAccess("operate");
    if (isAccessResponse(access)) return access;

    const payload = await readJsonObject<SpreadsheetPayload>(request);
    if (payload instanceof Response) return payload;

    const animals = payload.animals;
    if (!Array.isArray(animals) || animals.length === 0) {
      return Response.json({ error: "La planilla no trae cambios que guardar." }, { status: 400 });
    }
    if (animals.length > MAX_SPREADSHEET_ROWS) {
      return Response.json(
        { error: `La planilla no puede confirmar más de ${MAX_SPREADSHEET_ROWS} animales de una vez.` },
        { status: 400 },
      );
    }
    const uniqueIds = new Set(animals.map((animal) => animal.id?.trim()));
    if (uniqueIds.size !== animals.length) {
      return Response.json({ error: "La planilla trae el mismo animal repetido." }, { status: 400 });
    }

    for (const animal of animals) {
      const invalid = validateAnimalPayload(animal);
      if (invalid) {
        return Response.json(
          { error: `${animal.tag ? `Animal ${animal.tag}: ` : ""}${invalid}`, failedAnimalId: animal.id ?? null, savedIds: [] },
          { status: 400 },
        );
      }
    }

    // La autorización por fundo se resuelve antes de escribir: el lote de destino y, para
    // un animal que ya existe, también el fundo donde está hoy.
    //
    // El token de concurrencia se exige solo a lo que ya existe. Un animal que la planilla
    // acaba de agregar no puede traerlo, y pedírselo sería negarse a crear nada; que no
    // exista todavía lo verifica el repositorio, que inserta solo si el identificador está
    // libre y el DIIO no se repite en el fundo.
    for (const animal of animals) {
      const targetForbidden = await requireResourceField(access, "lot", animal.lotId!.trim());
      if (targetForbidden) return targetForbidden;
      const existingFieldId = await resolveResourceFieldId("animal", animal.id!.trim());
      if (existingFieldId) {
        const existingForbidden = requireContextField(access, existingFieldId);
        if (existingForbidden) return existingForbidden;
        if (!animal.snapshotToken?.trim()) {
          return Response.json(
            { error: `${animal.tag ? `Animal ${animal.tag}: ` : ""}actualiza la planilla antes de confirmar.`, failedAnimalId: animal.id ?? null, savedIds: [] },
            { status: 409 },
          );
        }
      }
    }

    const savedIds: string[] = [];
    for (const animal of animals) {
      try {
        await upsertLivestockAnimal(animal as LivestockAnimal, access);
        savedIds.push(animal.id!.trim());
      } catch (cause) {
        const [remainingAnimals, remainingLots, remainingWeighings] = await Promise.all([
          listLivestockAnimals(access),
          listLivestockLots(access),
          listLivestockWeighings(access),
        ]);
        return spreadsheetFailure(cause, animal, savedIds, {
          animals: remainingAnimals,
          lots: remainingLots,
          weighings: remainingWeighings,
        });
      }
    }

    const [allAnimals, lots, weighings] = await Promise.all([
      listLivestockAnimals(access),
      listLivestockLots(access),
      listLivestockWeighings(access),
    ]);
    const currentAccess = await reauthorizeApiSnapshotAccess(access, {
      capability: "operate",
      fieldIds: access.fieldIds,
    });
    if (isAccessResponse(currentAccess)) return currentAccess;
    return Response.json({ animals: allAnimals, lots, savedIds, weighings }, { status: 200 });
  } catch (cause) {
    return unexpectedApiFailure(
      "livestock.animal.spreadsheet",
      "No fue posible confirmar la planilla de animales.",
      cause,
    );
  }
}

function spreadsheetFailure(
  cause: unknown,
  animal: Partial<LivestockAnimal>,
  savedIds: string[],
  snapshot: { animals: LivestockAnimal[]; lots: unknown[]; weighings: unknown[] },
): Response {
  const failedAnimalId = animal.id ?? null;
  const prefix = animal.tag ? `Animal ${animal.tag}: ` : "";

  if (cause instanceof Error && "code" in cause && cause.code === "FIELD_SCOPE_CONFLICT") {
    return Response.json(
      { ...snapshot, error: `${prefix}${cause.message}`, failedAnimalId, savedIds },
      { status: 409 },
    );
  }
  if (cause instanceof DomainRuleError) {
    return Response.json(
      { ...snapshot, code: cause.code, error: `${prefix}${cause.message}`, failedAnimalId, savedIds },
      { status: 422 },
    );
  }
  return unexpectedApiFailure(
    "livestock.animal.spreadsheet",
    `${prefix}No fue posible guardar el animal.`,
    cause,
  );
}
