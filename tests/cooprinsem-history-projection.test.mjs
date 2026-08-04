import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assessCooprinsemHistoricalRecord,
  buildCooprinsemHistoryAssessment,
  buildCooprinsemHistoryWorkset,
  COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
  HISTORY_PROJECTION_FORMAT,
} from "../src/modules/integraciones/cooprinsem/server/history-projection-rules.mjs";

test("detecta leche sin inventar su unidad y deduplica cubiertas equivalentes", () => {
  const assessment = assessCooprinsemHistoricalRecord({
    FCONTROL: "2026-07-10",
    LECHEAM: 12.3,
    LECHEPM: 10.2,
    LECHE3RA: 2.5,
    LECHE: 25,
    MGX100: 3.9,
    PTX100: 3.4,
    FECCUBANT: "2026-06-10",
    NOMTORO2: "TORO-7",
    FECCUB3: "2026-06-10",
    NOMTORO3: "TORO-7",
  });
  assert.equal(assessment.milkControl.totalLiters, 25);
  assert.equal(assessment.milkControl.state, "blocked");
  assert.match(assessment.milkControl.blockers.join(" "), /contrato explícito/);
  assert.equal(assessment.reproductiveServices.length, 1);
  assert.deepEqual(assessment.reproductiveServices[0], {
    occurredAt: "2026-06-10",
    sireIdentifier: "TORO-7",
    roles: ["previous_month_service", "prior_control_month_service"],
    state: "ready",
    blockers: [],
  });
});

test("el contrato de litros habilita la evaluación pero no la escritura y bloquea valores divergentes", () => {
  const entries = [
    { animalId: "animal-1", importRowId: "row-1", record: { FCONTROL: "2026-07-10", LECHE: 20 } },
    { animalId: "animal-2", importRowId: "row-2", record: { FCONTROL: "2026-07-10", LECHE: 21 } },
  ];
  const summary = buildCooprinsemHistoryAssessment(entries, {
    milkUnitContractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
  });
  assert.equal(summary.writeEnabled, false);
  assert.equal(summary.milkUnitContract.confirmed, true);
  assert.equal(summary.milkUnitContract.canonicalUnit, "liters");
  assert.equal(summary.milkControlReadyCount, 2);
  assert.equal(summary.milkControlBlockedCount, 0);

  const workset = buildCooprinsemHistoryWorkset([
    { animalId: "animal-1", importRowId: "row-1", record: { FCONTROL: "2026-07-10", LECHE: 20 } },
    { animalId: "animal-1", importRowId: "row-2", record: { FCONTROL: "2026-07-10", LECHE: 22 } },
  ], { milkUnitContractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION });
  assert.equal(workset.milkControls.length, 1);
  assert.equal(workset.milkControls[0].state, "blocked");
  assert.match(workset.milkControls[0].blockers.join(" "), /valores distintos/);
});

test("bloquea cubiertas futuras, fechas ausentes y reproductores contradictorios", () => {
  const future = assessCooprinsemHistoricalRecord({
    FCONTROL: "2026-07-10",
    FECCUBANT: "2026-07-11",
    NOMTORO2: "TORO-A",
    NOMTORO: "TORO-SIN-FECHA",
  });
  assert.equal(future.reproductiveServices.length, 2);
  assert.ok(future.reproductiveServices.every((entry) => entry.state === "blocked"));

  const summary = buildCooprinsemHistoryAssessment([
    { animalId: "animal-1", importRowId: "row-1", record: { FCONTROL: "2026-07-10", FECULTCUB: "2026-06-05", NOMTORO: "TORO-A" } },
    { animalId: "animal-1", importRowId: "row-2", record: { FCONTROL: "2026-07-10", FECCUBANT: "2026-06-05", NOMTORO2: "TORO-B" } },
  ]);
  assert.equal(summary.reproductiveServiceCandidateCount, 1);
  assert.equal(summary.reproductiveServiceReadyCount, 0);
  assert.equal(summary.reproductiveServiceBlockedCount, 1);
  assert.match(summary.blockers.join(" "), /reproductores distintos/);
});

test("el recibo agregado deduplica por animal y fecha y conserva escritura apagada", () => {
  const record = { FCONTROL: "2026-07-10", LECHE: 20, FECULTCUB: "2026-06-01", NOMTORO: "TORO-1" };
  const summary = buildCooprinsemHistoryAssessment([
    { animalId: "animal-1", importRowId: "row-1", record },
    { animalId: "animal-1", importRowId: "row-2", record },
    { animalId: "animal-2", importRowId: "row-3", record },
  ]);
  assert.equal(summary.format, HISTORY_PROJECTION_FORMAT);
  assert.equal(summary.writeEnabled, false);
  assert.equal(summary.eligibleRowCount, 3);
  assert.equal(summary.milkControlCandidateCount, 2);
  assert.equal(summary.milkControlReadyCount, 0);
  assert.equal(summary.reproductiveServiceCandidateCount, 2);
  assert.equal(summary.reproductiveServiceReadyCount, 2);
  assert.doesNotMatch(JSON.stringify(summary), /TORO-1|animal-1|2026-06-01|\b20\b/);
});

test("la evaluación aparece en el plan y no añade escritores productivos", async () => {
  const repository = await readFile(new URL("../src/modules/integraciones/cooprinsem/server/projection-repository.ts", import.meta.url), "utf8");
  const executableRepository = repository.replace(/\/\*[\s\S]*?\*\//g, "");
  const page = await readFile(new URL("../src/modules/integraciones/cooprinsem/CooprinsemImportPage.tsx", import.meta.url), "utf8");
  const rules = await readFile(new URL("../src/modules/integraciones/cooprinsem/server/history-projection-rules.mjs", import.meta.url), "utf8");
  assert.match(repository, /buildCooprinsemHistoryAssessment/);
  assert.match(repository, /historyAssessment/);
  assert.match(executableRepository, /INSERT INTO livestock_milk_controls/);
  assert.doesNotMatch(executableRepository, /INSERT OR IGNORE INTO livestock_(?:lactations|reproductive_events)/);
  assert.doesNotMatch(rules, /\b(?:INSERT|UPDATE|DELETE)\b|@\/db|from "drizzle-orm"/);
  assert.match(page, /Historia productiva detectada/);
  assert.match(page, /Los controles proyectables se importan/);
  assert.match(page, /historia reproductiva sigue en solo lectura/);
});
