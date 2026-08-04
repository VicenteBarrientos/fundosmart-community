import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  mapCooprinsemMilkControl,
  mapCooprinsemMilkQualitySample,
} from "../src/modules/integraciones/cooprinsem/server/milk-control-rules.mjs";

const repository = readFileSync(
  new URL("../src/modules/integraciones/cooprinsem/server/projection-repository.ts", import.meta.url),
  "utf8",
);

test("maps a PreDetimp row to one individual milk control", () => {
  const result = mapCooprinsemMilkControl({
    FCONTROL: "2026-07-17",
    LECHE: 22.5,
    LECHEAM: 12,
    LECHEPM: 9,
    LECHE3RA: 1.5,
    MGX100: 3.9,
    PTX100: 3.4,
    RCS: 187000,
  });

  assert.deepEqual(result.control, {
    controlDate: "2026-07-17",
    morningLiters: 12,
    afternoonLiters: 9,
    thirdMilkingLiters: 1.5,
    totalLiters: 22.5,
    fatPct: 3.9,
    proteinPct: 3.4,
    somaticCellCount: 187000,
  });
  assert.deepEqual(result.issues, []);
});

test("uses the effective date and component sum for _Traspasos", () => {
  const result = mapCooprinsemMilkControl(
    { LECHEAM: "6,25", LECHEPM: 5.5, SCC: 210000 },
    { effectiveAt: "2026-07-18" },
  );

  assert.equal(result.control.controlDate, "2026-07-18");
  assert.equal(result.control.totalLiters, 11.75);
  assert.equal(result.control.somaticCellCount, 210000);
});

test("does not create a non-positive control and omits values outside storage constraints", () => {
  const empty = mapCooprinsemMilkControl({ FCONTROL: "2026-07-17", LECHE: 0 });
  assert.equal(empty.control, null);
  assert.match(empty.issues.join(" "), /total positivo/);

  const bounded = mapCooprinsemMilkControl({ FCONTROL: "2026-07-17", LECHE: 10, MGX100: 20, PTX100: -1, RCS: 1.5 });
  assert.equal(bounded.control.fatPct, null);
  assert.equal(bounded.control.proteinPct, null);
  assert.equal(bounded.control.somaticCellCount, null);
  assert.equal(bounded.issues.length, 3);
});

test("maps documented laboratory aliases only with explicit count units", () => {
  const result = mapCooprinsemMilkQualitySample({
    FECHA: "2026-07-19",
    GRASA: 4.1,
    PROTEINA: 3.5,
    SOLIDOS: 12.8,
    SCC: 230000,
    UFC: 14000,
  }, {
    somaticCellCountUnit: "cells_per_ml",
    bacterialCountUnit: "cfu_per_ml",
  });

  assert.deepEqual(result.sample, {
    sampledAt: "2026-07-19",
    period: "2026-07",
    kind: "laboratory",
    fatPercent: 4.1,
    proteinPercent: 3.5,
    totalSolidsPercent: 12.8,
    somaticCellCount: 230000,
    somaticCellCountUnit: "cells_per_ml",
    bacterialCount: 14000,
    bacterialCountUnit: "cfu_per_ml",
    sanitaryFlags: {},
    source: "cooprinsem_laboratory",
  });

  const ambiguous = mapCooprinsemMilkQualitySample({ FECHA: "2026-07-19", RCS: 230, UFC: 14 });
  assert.equal(ambiguous.sample, null);
  assert.match(ambiguous.issues.join(" "), /unidad explicita/);

  const fromDbfUnits = mapCooprinsemMilkQualitySample({ FECHA: "2026-07-19", RCS: 230, UNIRCS: "MIL_CEL_ML" });
  assert.equal(fromDbfUnits.sample.somaticCellCountUnit, "thousand_cells_per_ml");
});

test("confirmation batches an idempotent, source-linked milk control projection", () => {
  assert.match(repository, /deterministicProjectionId\("milk-control"/);
  assert.match(repository, /INSERT OR IGNORE INTO livestock_milk_controls/);
  assert.match(repository, /'livestock_milk_control'/);
  assert.match(repository, /source_record_id = \?/);
  assert.match(repository, /import\.milk_control\.created/);
  assert.match(repository, /projectableMilkControlCount/);
  assert.match(repository, /importedMilkControlCount/);
  assert.match(repository, /INSERT OR IGNORE INTO milk_quality_samples/);
  assert.match(repository, /import\.milk_quality_sample\.created/);
  assert.match(repository, /projectableMilkQualitySampleCount/);
});
