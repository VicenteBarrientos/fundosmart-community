import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer } from "vite";

const root = process.cwd();
let vite;
let validateAnimalPayload;

const BASE_ANIMAL = {
  id: "animal-payload",
  lotId: "lot-payload",
  tag: "TAG-PAYLOAD",
  sex: "female",
  status: "active",
};

before(async () => {
  vite = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root,
    resolve: { alias: [{ find: "@", replacement: root }] },
    server: { middlewareMode: true },
  });
  ({ validateAnimalPayload } = await vite.ssrLoadModule(
    "/src/modules/ganado/server/animal-payload.ts",
  ));
});

after(async () => {
  await vite?.close();
});

test("el payload acepta fechas calendario reales y rechaza fechas imposibles", () => {
  assert.equal(validateAnimalPayload({
    ...BASE_ANIMAL,
    weighings: [{ recordedAt: "2024-02-29", weightKg: 2000 }],
  }), null);
  assert.match(validateAnimalPayload({
    ...BASE_ANIMAL,
    weighings: [{ recordedAt: "2026-02-29", weightKg: 300 }],
  }), /fecha de un pesaje no es válida/i);
  assert.match(validateAnimalPayload({
    ...BASE_ANIMAL,
    latestWeightKg: 300,
    latestWeightDate: "2026-99-99",
  }), /fecha del pesaje no es válida/i);
});

test("el payload aplica el mismo límite de peso que la planilla", () => {
  assert.equal(validateAnimalPayload({
    ...BASE_ANIMAL,
    weighings: [{ recordedAt: "2026-03-01", weightKg: null }],
  }), null);
  assert.match(validateAnimalPayload({
    ...BASE_ANIMAL,
    weighings: [{ recordedAt: "2026-03-01", weightKg: 2000.1 }],
  }), /no superar 2\.000 kg/i);
  assert.match(validateAnimalPayload({
    ...BASE_ANIMAL,
    latestWeightKg: 5000,
    latestWeightDate: "2026-03-01",
  }), /no superar 2\.000 kg/i);
});

test("el payload conserva los topes de duplicados y tamaño del lote", () => {
  assert.match(validateAnimalPayload({
    ...BASE_ANIMAL,
    weighings: [
      { recordedAt: "2026-03-01", weightKg: 300 },
      { recordedAt: "2026-03-01", weightKg: 305 },
    ],
  }), /viene repetido/i);

  const weighings = Array.from({ length: 41 }, (_, index) => ({
    recordedAt: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
    weightKg: 300,
  }));
  assert.match(validateAnimalPayload({ ...BASE_ANIMAL, weighings }), /más de 40 pesajes/i);
});
