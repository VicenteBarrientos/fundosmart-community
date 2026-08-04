import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readSource = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("partner mutations carry a canonical snapshot through every boundary", async () => {
  const [types, repository, route, client, page, section] = await Promise.all([
    readSource("../src/core/domain/types.ts"),
    readSource("../src/modules/ganado/server/livestock-finance-repository.ts"),
    readSource("../app/api/ganado/plata/socios/route.ts"),
    readSource("../src/modules/ganado/api/livestock-client.ts"),
    readSource("../src/modules/ganado/GanadoPage.tsx"),
    readSource("../src/modules/ganado/components/PlataSection.tsx"),
  ]);

  assert.match(types, /export type LivestockPartner = \{[\s\S]+?snapshotToken: string \| null/);
  assert.match(repository, /crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(repository, /return `livestock-partner:v1:\$\{hex\}`/);
  assert.match(repository, /partner\.snapshotToken !== currentSnapshotToken/);
  assert.match(repository, /expectedSnapshotToken !== await partnerSnapshotToken\(existing\)/);
  assert.match(repository, /partners: await Promise\.all\(partners\.map\(toPartner\)\)/);

  assert.match(route, /!\("snapshotToken" in payload\)[\s\S]+?partnerVersionConflict/);
  assert.match(route, /if \(!snapshotToken\) return partnerVersionConflict\(\)/);
  assert.match(route, /FINANCE_VERSION_CONFLICT[\s\S]+?status: 409/);
  assert.match(route, /deleteLivestockPartner\([\s\S]+?snapshotToken/);

  assert.match(client, /removeLivestockPartner\(id: string, snapshotToken: string\)/);
  assert.match(client, /new URLSearchParams\(\{ id, snapshotToken \}\)/);
  assert.match(page, /removeLivestockPartner\(id, snapshotToken\)/);
  assert.match(section, /snapshotToken: null/);
  assert.match(section, /partnerById\.get\(id\)\?\.snapshotToken/);
  assert.match(section, /onDelete\(id, snapshotToken\)/);
});
