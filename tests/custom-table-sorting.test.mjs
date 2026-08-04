import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  nextSortState,
  stableSortData,
} from "../src/ui/sortable-data-core.mjs";

const root = process.cwd();

test("ordena datos de grillas por texto y número, con empates estables y ausentes al final", () => {
  const rows = [
    { id: "a", name: "Pampa 10", hectares: 2.92 },
    { id: "b", name: "Pampa 2", hectares: 0.52 },
    { id: "c", name: "Pampa 1", hectares: 0.52 },
    { id: "d", name: "Sin superficie", hectares: null },
  ];
  const columns = {
    name: { kind: "text", value: (row) => row.name },
    hectares: { kind: "number", value: (row) => row.hectares },
  };

  assert.deepEqual(
    stableSortData(rows, { column: "name", direction: "ascending" }, columns).map((row) => row.id),
    ["c", "b", "a", "d"],
  );
  assert.deepEqual(
    stableSortData(rows, { column: "hectares", direction: "ascending" }, columns).map((row) => row.id),
    ["b", "c", "a", "d"],
  );
  assert.deepEqual(
    stableSortData(rows, { column: "hectares", direction: "descending" }, columns).map((row) => row.id),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(stableSortData(rows, null, columns), rows);
  assert.notEqual(stableSortData(rows, null, columns), rows);
});

test("el primer clic ordena ascendente y el segundo invierte la misma columna", () => {
  assert.deepEqual(nextSortState(null, "name"), { column: "name", direction: "ascending" });
  assert.deepEqual(
    nextSortState({ column: "name", direction: "ascending" }, "name"),
    { column: "name", direction: "descending" },
  );
  assert.deepEqual(
    nextSortState({ column: "name", direction: "descending" }, "hectares"),
    { column: "hectares", direction: "ascending" },
  );
});

test("las grillas de datos que no son HTML tables usan el encabezado ordenable común", () => {
  const paddocks = readFileSync(join(root, "src/modules/potreros/components/ListaPotreros.tsx"), "utf8");
  const exclusions = readFileSync(join(root, "src/modules/potreros/components/ExclusionDialogs.tsx"), "utf8");
  const staff = readFileSync(join(root, "src/modules/staff/StaffConsolePage.tsx"), "utf8");
  const header = readFileSync(join(root, "src/ui/SortableGridHeader.tsx"), "utf8");

  assert.match(paddocks, /PADDOCK_SORT_OPTIONS\.map/u);
  assert.match(paddocks, /stableSortData\(filtered, sort, PADDOCK_SORT_COLUMNS\)/u);
  assert.match(paddocks, /label="Ordenar potreros"/u);

  assert.match(exclusions, /EXCLUSION_SORT_OPTIONS\.map/u);
  assert.match(exclusions, /stableSortData\(preview\.affected, sort, EXCLUSION_SORT_COLUMNS\)/u);
  assert.match(exclusions, /label="Ordenar potreros afectados"/u);

  assert.match(staff, /WORKSPACE_SORT_OPTIONS\.map/u);
  assert.match(staff, /MEMBERSHIP_SORT_OPTIONS\.slice\(0, 2\)\.map/u);
  assert.match(staff, /AUDIT_SORT_OPTIONS\.map/u);
  assert.match(staff, /sortedAuditLogs\.map/u);

  assert.match(header, /aria-pressed=\{active\}/u);
  assert.match(header, /Activar para ordenar/u);
  assert.match(header, /direction === "ascending" \? "↑"/u);
  assert.match(header, /<select/u);
});
