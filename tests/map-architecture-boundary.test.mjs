import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const allowedLeafletImports = new Set([
  "app/layout.tsx",
  "app/(producto)/potreros/imprimir/PrintPaddockMap.tsx",
  "src/core/maps/leaflet-react.tsx",
  "src/modules/potreros/components/MapaPotreros.tsx",
]);

test("Leaflet remains confined to the authorized presentation files", async () => {
  const files = await sourceFiles(["app", "src"]);
  const importers = [];

  for (const file of files) {
    const source = await readFile(resolve(root, file), "utf8");
    if (/(?:from\s+|import\s*(?:\(\s*)?)["'](?:react-)?leaflet(?:\/[^"']*)?["']/u.test(source)) {
      importers.push(file);
    }
  }

  assert.deepEqual(importers.sort(), [...allowedLeafletImports].sort());
});

test("map-core is renderer, React, network, and persistence independent", async () => {
  const files = await sourceFiles(["src/modules/potreros/map-core"]);
  assert.ok(files.length >= 4);

  for (const file of files) {
    const source = await readFile(resolve(root, file), "utf8");
    assert.doesNotMatch(source, /(?:react-)?leaflet|from\s+["']react["']/u, `${file} imported presentation code`);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket/u, `${file} acquired network access`);
    assert.doesNotMatch(
      source,
      /from\s+["'][^"']*(?:\/api\/|\/server\/|client|repository|gateway)[^"']*["']|\bfetch\s*\(/iu,
      `${file} acquired persistence access`,
    );
  }
});

test("the interaction adapter receives only read and gesture dispatch capabilities", async () => {
  const source = await readFile(
    resolve(root, "src/modules/potreros/map-core/interaction-contract.ts"),
    "utf8",
  );
  const context = source.slice(
    source.indexOf("export type MapInteractionAdapterContext"),
    source.indexOf("export type MapInteractionAdapterLease"),
  );

  assert.match(context, /read:/u);
  assert.match(context, /dispatch:/u);
  assert.doesNotMatch(context, /save|persist|fetch|gateway|client|repository/iu);
});

async function sourceFiles(roots) {
  const collected = [];
  for (const sourceRoot of roots) await collect(resolve(root, sourceRoot), collected);
  return collected.sort();
}

async function collect(directory, collected) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await collect(absolute, collected);
    } else if (/\.(?:ts|tsx|js|jsx|mjs)$/u.test(entry.name)) {
      collected.push(relative(root, absolute).replaceAll("\\", "/"));
    }
  }
}
