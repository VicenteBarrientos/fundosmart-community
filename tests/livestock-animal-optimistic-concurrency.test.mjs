import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("animal mutations carry a canonical row and dependency snapshot through every boundary", async () => {
  const [types, repository, route, client, page, section, dialog, spreadsheet] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/ganado/server/livestock-animal-repository.ts"),
    readSource("../app/api/ganado/animales/route.ts"),
    readSource("../src/modules/ganado/api/livestock-client.ts"),
    readSource("../src/modules/ganado/GanadoPage.tsx"),
    readSource("../src/modules/ganado/components/AnimalesSection.tsx"),
    readSource("../src/modules/ganado/components/ManageLivestockAnimalDialog.tsx"),
    readSource("../src/modules/ganado/components/AnimalesSpreadsheet.tsx"),
  ]);

  assert.match(types, /export type LivestockAnimal = \{[\s\S]+?snapshotToken\?: string/);
  assert.match(repository, /dependencies: JSON\.parse\(dependencySnapshot\)/);
  assert.match(repository, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(repository, /return `livestock-animal:v1:\$\{hex\}`/);
  assert.match(repository, /dependencySnapshot: sql<string>[\s\S]+?animalDependencySnapshotSql\("livestock_animals\.id"\)/);
  assert.match(repository, /!animal\.snapshotToken \|\| animal\.snapshotToken !== await animalSnapshotToken\(existing\.animal, dependencySnapshot\)/);
  assert.match(repository, /expectedSnapshotToken !== await animalSnapshotToken\(existing\.animal, dependencySnapshot\)/);
  assert.match(repository, /El peso final de venta se corrige desde la ficha del animal/);
  assert.doesNotMatch(repository, /existingDependencySnapshot/);
  assert.match(repository, /const writeMarker = `pending:\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(repository, /SET updated_at = \?[\s\S]+?AND updated_at = \?[\s\S]+?prepareIndividualLotSummaryUpdate/);

  assert.match(route, /if \(!payload\.snapshotToken\?\.trim\(\)\)[\s\S]+?status: 409/);
  assert.match(route, /if \(!expectedSnapshotToken\)[\s\S]+?status: 409/);
  assert.match(route, /deleteLivestockAnimal\(id, access, expectedSnapshotToken\)/);
  assert.match(route, /cause\.code === "FIELD_SCOPE_CONFLICT"[\s\S]+?status: 409/);

  assert.match(client, /new URLSearchParams\(\{ id, snapshotToken \}\)/);
  assert.match(page, /removeLivestockAnimal\(id, snapshotToken\)/);
  assert.match(section, /onDelete: \(id: string, snapshotToken: string\)/);
  assert.match(dialog, /snapshotToken: animal\?\.snapshotToken/);
  assert.match(dialog, /onDelete\(animal\.id, animal\.snapshotToken\)/);
  assert.match(spreadsheet, /\.\.\.historyDates, \.\.\.addedDates, \.\.\.editedWeighingDates/);
  assert.match(spreadsheet, /\.\.\.editedWeighingDates,[\s\S]+?return allWeighingDates\.filter/);
});
