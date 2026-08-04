import { reauthorizePageAccess, requirePageAccess } from "@/app/access";
import { AnimalRecordPage } from "@/src/modules/ganado/ficha/AnimalRecordPage";
import { DEMO_EMAIL } from "@/src/modules/demo/data/demo-data.mjs";
import {
  getAnimalRecord,
  listAnimalDirectory,
} from "@/src/modules/ganado/ficha/server/animal-record-repository";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AnimalRecordRoute() {
  const returnTo = "/app/ganado/ficha";
  const access = await requirePageAccess(returnTo);
  const animals = await listAnimalDirectory(access);
  const initialAnimal = animals.find((animal) => animal.sex === "female") ?? animals[0];
  const initialRecord = initialAnimal ? await getAnimalRecord(initialAnimal.id, access) : null;
  const loadedFieldIds = new Set(animals.map((animal) => animal.fieldId));
  if (initialRecord) loadedFieldIds.add(initialRecord.fieldId);
  const currentAccess = await reauthorizePageAccess(
    access,
    returnTo,
    "view",
    initialRecord?.fieldId ?? initialAnimal?.fieldId,
  );
  const currentFieldIds = new Set(currentAccess.fieldIds);
  if ([...loadedFieldIds].some((fieldId) => !currentFieldIds.has(fieldId))) {
    redirect("/app/sin-acceso?code=ACCESS_SCOPE_CHANGED");
  }
  return (
    <AnimalRecordPage
      animals={animals}
      initialRecord={initialRecord}
      isDemo={currentAccess.email === DEMO_EMAIL}
      organizationId={currentAccess.organizationId}
      organizationName={currentAccess.organizationName}
      userName={currentAccess.displayName}
    />
  );
}
