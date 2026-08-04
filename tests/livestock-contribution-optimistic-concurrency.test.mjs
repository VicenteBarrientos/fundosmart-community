import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("contribution mutations carry a canonical snapshot through every boundary", async () => {
  const [types, repository, route, client, page, section] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/ganado/server/livestock-finance-repository.ts"),
    readSource("../app/api/ganado/plata/aportes/route.ts"),
    readSource("../src/modules/ganado/api/livestock-client.ts"),
    readSource("../src/modules/ganado/GanadoPage.tsx"),
    readSource("../src/modules/ganado/components/PlataSection.tsx"),
  ]);

  assert.match(types, /export type LivestockContribution = \{[\s\S]+?snapshotToken: string \| null/);
  assert.match(repository, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(repository, /return `livestock-contribution:v1:\$\{hex\}`/);
  assert.match(repository, /contribution\.snapshotToken !== currentSnapshotToken/);
  assert.match(repository, /expectedSnapshotToken !== await contributionSnapshotToken\(existing\)/);
  assert.match(repository, /contributions: await Promise\.all\(contributions\.map\(toContribution\)\)/);

  assert.match(route, /!\("snapshotToken" in payload\)[\s\S]+?contributionVersionConflict/);
  assert.match(route, /if \(!snapshotToken\) return contributionVersionConflict\(\)/);
  assert.match(route, /FINANCE_CONTRIBUTION_VERSION_CONFLICT[\s\S]+?status: 409/);
  assert.match(route, /deleteLivestockContribution\([\s\S]+?snapshotToken/);

  assert.match(client, /removeLivestockContribution\(id: string, snapshotToken: string\)/);
  assert.match(client, /new URLSearchParams\(\{ id, snapshotToken \}\)/);
  assert.match(page, /removeLivestockContribution\(id, snapshotToken\)/);
  assert.match(section, /snapshotToken: null/);
  assert.match(section, /contributions\.find\(\(contribution\) => contribution\.id === id\)\?\.snapshotToken/);
  assert.match(section, /onDelete\(id, snapshotToken\)/);
});
