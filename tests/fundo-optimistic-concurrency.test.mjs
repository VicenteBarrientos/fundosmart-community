import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("field edits carry a canonical snapshot token through every boundary", async () => {
  const [types, repository, replacementRepository, route, client, page, dialog] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/potreros/server/fundo-repository.ts"),
    readSource("../src/modules/potreros/server/potrero-repository.ts"),
    readSource("../app/api/fundos/route.ts"),
    readSource("../src/modules/potreros/api/fundos-client.ts"),
    readSource("../src/modules/potreros/PotrerosPage.tsx"),
    readSource("../src/modules/potreros/components/ManageFundoDialog.tsx"),
  ]);

  assert.match(types, /export type Fundo = \{[\s\S]+?snapshotToken\?: string/);
  assert.match(repository, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(repository, /field-snapshot:v1:\$\{hex\}/);
  assert.match(repository, /fundo\.snapshotToken !== await fundoSnapshotToken\(existing\)/);
  assert.match(repository, /snapshotToken: await fundoSnapshotToken\(row\)/);
  assert.match(repository, /Promise\.all\(rows\.map\(toFundo\)\)/);

  assert.match(route, /access\.fieldIds\.includes\(payload\.id\)[\s\S]+?!payload\.snapshotToken\?\.trim\(\)[\s\S]+?status: 409/);
  assert.match(client, /body: JSON\.stringify\(fundo\)/);
  assert.match(replacementRepository, /fundo: await toFundo\(snapshot\.field\)/);
  assert.match(page, /fundo\.snapshotToken \?\? null/);
  assert.match(page, /const requestedFundo = \{ \.\.\.selectedFundo, coordinates: cloneRing\(boundaryDraft\), areaHectares: area \}/);
  assert.match(
    page,
    /linkedPaddockUpdates\.length === 0\)[\s\S]+?updateFundo\(requestedFundo\)[\s\S]+?persistLinkedFieldBoundary\(requestedFundo, linkedPaddockUpdates\)/,
  );
  assert.match(dialog, /onSave\(\{ \.\.\.fundo, name: name\.trim\(\), location: location\.trim\(\) \}\)/);
});
