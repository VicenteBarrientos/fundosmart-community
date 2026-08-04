import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOperationalReport } from "../src/modules/reportes/operational-report.mjs";

const fundos = [
  { id: "field-a", name: "Fundo A", areaHectares: 100 },
  { id: "field-b", name: "Fundo B", areaHectares: 80 },
];
const potreros = [
  { id: "paddock-a", fieldId: "field-a", areaHectares: 60, status: "Disponible" },
  { id: "paddock-b", fieldId: "field-b", areaHectares: 40, status: "En pastoreo" },
];
const activities = [
  { id: "activity-a", potreroId: "paddock-a", occurredAt: "2026-07-10", costClp: 10_000 },
  { id: "activity-b", potreroId: "paddock-b", occurredAt: "2026-06-01", costClp: 20_000 },
];
const lots = [
  { id: "lot-a", fieldId: "field-a", category: "dairy_cow", trackingMode: "summary", status: "active", animalCount: 10 },
  { id: "lot-b", fieldId: "field-b", category: "dairy_cow", trackingMode: "summary", status: "active", animalCount: 5 },
];
const settlements = [
  { id: "milk-a-current", fieldId: "field-a", period: "2026-06", totalLiters: 12_000, netAmountClp: 4_800_000, grossAmountClp: 5_712_000 },
  { id: "milk-a-previous", fieldId: "field-a", period: "2026-05", totalLiters: 10_000, netAmountClp: 3_900_000, grossAmountClp: 4_641_000 },
  { id: "milk-b-current", fieldId: "field-b", period: "2026-06", totalLiters: 6_000, netAmountClp: 2_100_000, grossAmountClp: 2_499_000 },
  { id: "milk-b-previous", fieldId: "field-b", period: "2026-05", totalLiters: 6_500, netAmountClp: 2_200_000, grossAmountClp: 2_618_000 },
];
const expenses = [
  { id: "expense-a", fieldId: "field-a", date: "2026-06-15", amountClp: 900_000 },
  { id: "expense-b", fieldId: "field-b", date: "2026-06-15", amountClp: 500_000 },
];

test("el reporte operacional agrega solo las filas recibidas y omite toda finanza sin capacidad", () => {
  const report = buildOperationalReport({
    activities: activities.slice(0, 1),
    animals: [],
    canViewFinance: false,
    expenses: [],
    fundos: fundos.slice(0, 1),
    generatedAt: "2026-07-18T12:00:00.000Z",
    lots: lots.slice(0, 1),
    potreros: potreros.slice(0, 1),
    settlements: settlements.filter((row) => row.fieldId === "field-a"),
  });

  assert.equal(report.fields.length, 1);
  assert.equal(report.fields[0].fieldId, "field-a");
  assert.equal(report.fields[0].activeAnimals, 10);
  assert.equal(report.fields[0].latestMilkTotalLiters, 12_000);
  assert.equal(report.fields[0].activities30Days, 1);
  assert.equal(report.fields[0].coveragePercent, 60);
  assert.equal(Object.hasOwn(report.fields[0], "finance"), false);
  assert.equal(Object.hasOwn(report.total, "finance"), false);
  assert.doesNotMatch(JSON.stringify(report), /4800000|3900000/);
});

test("el reporte financiero conserva totales y separa cada fundo", () => {
  const report = buildOperationalReport({
    activities,
    animals: [],
    canViewFinance: true,
    expenses,
    fundos,
    generatedAt: "2026-07-18T12:00:00.000Z",
    lots,
    potreros,
    settlements,
  });

  assert.equal(report.total.activeAnimals, 15);
  assert.equal(report.total.latestMilkTotalLiters, 18_000);
  assert.equal(report.total.finance.latestMilkNetAmountClp, 6_900_000);
  assert.equal(report.total.finance.periodCostsClp, 1_420_000);
  assert.equal(report.total.finance.operatingResultClp, 5_480_000);
  assert.equal(report.fields[0].finance.periodCostsClp, 900_000);
  assert.equal(report.fields[1].finance.periodCostsClp, 520_000);
});

test("la ruta filtra todos los recursos antes de construir el reporte y la navegación lo desbloquea", async () => {
  const route = await readFile(new URL("../app/(producto)/reportes/page.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("../src/core/layout/AppShell.tsx", import.meta.url), "utf8");

  assert.match(route, /requirePageAccess\("\/app\/reportes"\)/);
  assert.match(route, /const allowedFields = new Set\(access\.fieldIds\)/);
  assert.match(route, /fundos\.filter\(\(fundo\) => allowedFields\.has\(fundo\.id\)\)/);
  assert.match(route, /potreros\.filter\(\(potrero\) => allowedFields\.has\(potrero\.fieldId\)\)/);
  assert.match(route, /activities\.filter\(\(activity\) => visiblePaddockIds\.has\(activity\.potreroId\)\)/);
  assert.match(route, /animals\.filter\(\(animal\) => visibleLotIds\.has\(animal\.lotId\)\)/);
  assert.match(route, /settlements\.filter\(\(settlement\) => allowedFields\.has\(settlement\.fieldId\)\)/);
  assert.match(route, /canViewFinance[\s\S]+listLivestockFinance\(financeScope\)[\s\S]+Promise\.resolve/);
  assert.match(shell, /key: "reportes", label: "Reportes", icon: BarChart3, href: "\/app\/reportes"/);
  assert.doesNotMatch(shell, /key: "reportes"[^\n]+locked: true/);
});
