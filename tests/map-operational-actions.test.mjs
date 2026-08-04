import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createInitialOperationalState,
  reduceOperationalState,
} from "../src/modules/potreros/workspace/useMapOperationalActions.ts";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

const SAMPLE_PADDOCK = {
  id: "potrero-101",
  fieldId: "fundo-1",
  nombre: "Potrero El Mirador",
  name: "Potrero El Mirador",
  hectareas: 12.5,
  areaHectares: 12.5,
  sector: "Norte",
  coordinates: [[-40.6, -73.1], [-40.6, -73.2], [-40.7, -73.2], [-40.6, -73.1]],
  soil: { ph: 6.2, nitrogen: null, phosphorus: null, potassium: null },
  status: "Disponible",
};

test("createInitialOperationalState inicia en modo idle y es inmutable", () => {
  const initial = createInitialOperationalState();
  assert.equal(initial.kind, "idle");
  assert.equal(initial.targetPaddock, null);
  assert.equal(initial.draftActivity, null);
  assert.ok(Object.isFrozen(initial));
});

test("reduceOperationalState ejecuta transiciones move-lot, management y task de forma inmutable", () => {
  const initial = createInitialOperationalState();

  const moveLotState = reduceOperationalState(initial, {
    type: "move-lot",
    targetPaddock: SAMPLE_PADDOCK,
  });
  assert.equal(moveLotState.kind, "move-lot");
  assert.equal(moveLotState.targetPaddock?.id, "potrero-101");
  assert.ok(Object.isFrozen(moveLotState));

  const mgmtState = reduceOperationalState(initial, {
    type: "register-management",
    targetPaddock: SAMPLE_PADDOCK,
    dateISO: "2026-07-28",
  });
  assert.equal(mgmtState.kind, "register-management");
  assert.equal(mgmtState.draftActivity?.occurredAt, "2026-07-28");
  assert.equal(mgmtState.draftActivity?.type, "fertilization");
  assert.ok(Object.isFrozen(mgmtState));

  const taskState = reduceOperationalState(initial, {
    type: "create-task",
    targetPaddock: SAMPLE_PADDOCK,
    dateISO: "2026-07-28",
  });
  assert.equal(taskState.kind, "create-task");
  assert.equal(taskState.draftActivity?.type, "grazing");
  assert.ok(Object.isFrozen(taskState));

  const resetState = reduceOperationalState(taskState, { type: "reset" });
  assert.equal(resetState.kind, "idle");
  assert.equal(resetState.targetPaddock, null);
});

test("useMapOperationalActions es neutral a Leaflet", async () => {
  const source = await readFile(
    path.join(projectRoot, "src/modules/potreros/workspace/useMapOperationalActions.ts"),
    "utf8",
  );

  assert.match(source, /export function useMapOperationalActions/u);
  assert.match(source, /startMoveLot/u);
  assert.match(source, /startManagement/u);
  assert.match(source, /startCreateTask/u);
  assert.doesNotMatch(source, /(?:react-)?leaflet/iu);
});
