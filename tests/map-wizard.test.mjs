import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));

test("MapWizardDialog es neutral a Leaflet y ofrece wizard de 4 pasos", async () => {
  const source = await readFile(
    path.join(projectRoot, "src/modules/potreros/components/map/MapWizardDialog.tsx"),
    "utf8",
  );

  assert.match(source, /export function MapWizardDialog/u);
  assert.match(source, /step === "locate"/u);
  assert.match(source, /step === "boundary"/u);
  assert.match(source, /step === "first-paddock"/u);
  assert.match(source, /step === "review"/u);
  assert.doesNotMatch(source, /(?:react-)?leaflet/iu);
});
