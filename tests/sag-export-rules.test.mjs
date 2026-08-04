import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SAG_DEA_FORM_VERSION,
  SAG_DRAFT_LABEL,
  SAG_DRAFT_STATUS,
  SAG_FMA_FORM_VERSION,
  SAG_MAX_FMA_DIIO,
  buildDeaDraft,
  buildFmaDrafts,
  deaDraftToCsv,
  fmaDraftToCsv,
  fmaDraftsToCsv,
  isValidChileanRut,
  isValidDiio,
  normalizeDiio,
  normalizeRut,
  validateSagProfile,
} from "../src/modules/ganado/sag/sag-export-rules.mjs";

const PROFILE = Object.freeze({
  fieldId: "field-1",
  rup: "01.02.1234",
  holderRut: "12.345.678-5",
  holderName: "Agrícola Los Robles SpA",
  commune: "Osorno",
  address: "Camino Rural 123",
});

function movement(overrides = {}) {
  return {
    id: "movement-1",
    destinationRup: "02.03.4321",
    destinationCommune: "Río Negro",
    destinationAddress: "Ruta U-500 km 12",
    departureDate: "2026-07-20",
    departureTime: "08:30",
    arrivalDate: "2026-07-20",
    arrivalTime: "10:15",
    carrierName: "Transportes del Sur",
    carrierRut: "9.876.543-3",
    vehiclePlate: "ABCD12",
    trailerPlate: "EFGH34",
    observations: "Traslado programado",
    declarations: { noQuarantine: true, noSymptoms: true, noActiveWithdrawal: true },
    ...overrides,
  };
}

function animal(index, overrides = {}) {
  return {
    id: `animal-${index}`,
    fieldId: PROFILE.fieldId,
    diio: String(100_000_000 + index),
    speciesCode: "bovine",
    categoryCode: index % 2 === 0 ? "heifer" : "cow",
    status: "active",
    ...overrides,
  };
}

test("normalizes and validates official 9-digit DIIO values", () => {
  assert.equal(normalizeDiio("123.456.789"), "123456789");
  assert.equal(normalizeDiio("123-456-789"), "123456789");
  assert.equal(isValidDiio("123 456 789"), true);
  assert.equal(isValidDiio("12345678"), false);
  assert.equal(isValidDiio("A23456789"), false);
});

test("validates Chilean RUT values without depending on display punctuation", () => {
  assert.equal(normalizeRut("12.345.678-5"), "12345678-5");
  assert.equal(isValidChileanRut("12.345.678-5"), true);
  assert.equal(isValidChileanRut("9.876.543-3"), true);
  assert.equal(isValidChileanRut("12.345.678-4"), false);
});

test("profile validation reports each required declarant field", () => {
  const issues = validateSagProfile({ fieldId: "", rup: "?", holderRut: "1-9", holderName: "", commune: "", address: "" });
  assert.deepEqual(new Set(issues.map((entry) => entry.code)), new Set([
    "PROFILE_FIELD_REQUIRED",
    "PROFILE_RUP_INVALID",
    "PROFILE_HOLDER_RUT_INVALID",
    "PROFILE_HOLDER_NAME_REQUIRED",
    "PROFILE_COMMUNE_REQUIRED",
    "PROFILE_ADDRESS_REQUIRED",
  ]));
});

test("builds a versioned DEA draft and aggregates individual and summary inventory", () => {
  const result = buildDeaDraft({
    profile: PROFILE,
    asOfDate: "2026-07-20",
    generatedAt: "2026-07-20T12:00:00.000Z",
    inventoryEntries: [
      { id: "cow-1", fieldId: PROFILE.fieldId, speciesCode: "bovine", categoryCode: "cow", trackingMode: "individual", quantity: 1 },
      { id: "cow-summary", fieldId: PROFILE.fieldId, speciesCode: "bovine", categoryCode: "cow", trackingMode: "summary", quantity: 14 },
      { id: "heifer-summary", fieldId: PROFILE.fieldId, speciesCode: "bovine", categoryCode: "heifer", trackingMode: "summary", quantity: 8 },
      { id: "sold", fieldId: PROFILE.fieldId, speciesCode: "bovine", categoryCode: "steer", status: "sold", quantity: 2 },
      { id: "ewes", fieldId: PROFILE.fieldId, speciesCode: "ovine", categoryCode: "ewe", trackingMode: "summary", quantity: 20 },
    ],
  });

  assert.equal(result.validation.valid, true);
  assert.ok(result.draft);
  assert.equal(result.draft.documentKind, "SAG_DEA_DRAFT");
  assert.equal(result.draft.draftLabel, SAG_DRAFT_LABEL);
  assert.equal(result.draft.declarationStatus, SAG_DRAFT_STATUS);
  assert.equal(result.draft.declared, false);
  assert.equal(result.draft.formVersion, SAG_DEA_FORM_VERSION);
  assert.equal(result.draft.establishment.rup, PROFILE.rup);
  assert.equal(result.draft.totalAnimals, 43);
  assert.deepEqual(
    result.draft.rows.map(({ speciesCode, categoryCode, quantity }) => ({ speciesCode, categoryCode, quantity })),
    [
      { speciesCode: "bovine", categoryCode: "cow", quantity: 15 },
      { speciesCode: "bovine", categoryCode: "heifer", quantity: 8 },
      { speciesCode: "ovine", categoryCode: "ewe", quantity: 20 },
    ],
  );
});

test("blocks a DEA draft with cross-field, category, or quantity errors", () => {
  const result = buildDeaDraft({
    profile: PROFILE,
    asOfDate: "2026-02-30",
    inventoryEntries: [
      { fieldId: "field-2", speciesCode: "bovine", categoryCode: "ewe", trackingMode: "summary", quantity: 0 },
      { fieldId: PROFILE.fieldId, speciesCode: "bovine", categoryCode: "cow", trackingMode: "individual", quantity: 2 },
    ],
  });
  assert.equal(result.validation.valid, false);
  assert.equal(result.draft, null);
  assert.deepEqual(new Set(result.validation.errors.map((entry) => entry.code)), new Set([
    "DEA_DATE_INVALID",
    "DEA_FIELD_MISMATCH",
    "SAG_CATEGORY_INVALID",
    "DEA_QUANTITY_INVALID",
    "DEA_INDIVIDUAL_QUANTITY_INVALID",
  ]));
});

test("splits a valid FMA movement into stable drafts of at most 45 DIIO", () => {
  const animals = Array.from({ length: 91 }, (_, index) => animal(index + 1));
  const result = buildFmaDrafts({
    profile: PROFILE,
    movement: movement(),
    animals,
    generatedAt: "2026-07-20T12:00:00.000Z",
  });

  assert.equal(result.validation.valid, true);
  assert.equal(SAG_MAX_FMA_DIIO, 45);
  assert.deepEqual(result.drafts.map((draft) => draft.animals.length), [45, 45, 1]);
  assert.deepEqual(result.drafts.map((draft) => [draft.draftNumber, draft.draftCount]), [[1, 3], [2, 3], [3, 3]]);
  assert.equal(result.drafts[0].animals[0].animalId, "animal-1");
  assert.equal(result.drafts[2].animals[0].animalId, "animal-91");
  for (const draft of result.drafts) {
    assert.equal(draft.documentKind, "SAG_FMA_DRAFT");
    assert.equal(draft.formVersion, SAG_FMA_FORM_VERSION);
    assert.equal(draft.draftLabel, SAG_DRAFT_LABEL);
    assert.equal(draft.declarationStatus, SAG_DRAFT_STATUS);
    assert.equal(draft.declared, false);
    assert.equal(draft.declarations.noActiveWithdrawal, true);
  }
});

test("blocks duplicate or malformed DIIO and mismatched official categories", () => {
  const result = buildFmaDrafts({
    profile: PROFILE,
    movement: movement(),
    animals: [
      animal(1),
      animal(2, { diio: animal(1).diio }),
      animal(3, { diio: "ABC", categoryCode: "ewe" }),
      animal(4, { speciesCode: "poultry", categoryCode: "layer" }),
    ],
  });
  assert.equal(result.validation.valid, false);
  assert.deepEqual(result.drafts, []);
  assert.deepEqual(new Set(result.validation.errors.map((entry) => entry.code)), new Set([
    "FMA_DIIO_DUPLICATED",
    "FMA_DIIO_INVALID",
    "SAG_CATEGORY_INVALID",
    "FMA_SPECIES_UNSUPPORTED",
  ]));
});

test("blocks active milk or meat withdrawal at departure and ignores expired or cancelled records", () => {
  const selected = [animal(1), animal(2), animal(3)];
  const blocked = buildFmaDrafts({
    profile: PROFILE,
    movement: movement(),
    animals: selected,
    withdrawals: [
      { animalId: "animal-1", withdrawalMilkUntil: "2026-07-20", status: "completed" },
      { animalId: "animal-2", withdrawalMeatUntil: "2026-07-21", status: "open" },
      { animalId: "animal-3", withdrawalMeatUntil: "2026-07-25", status: "cancelled" },
      { animalId: "animal-3", withdrawalMilkUntil: "2026-07-19", status: "completed" },
    ],
  });
  assert.equal(blocked.validation.valid, false);
  assert.equal(blocked.validation.errors.filter((entry) => entry.code === "FMA_ACTIVE_WITHDRAWAL").length, 2);

  const allowed = buildFmaDrafts({
    profile: PROFILE,
    movement: movement(),
    animals: [animal(3)],
    withdrawals: [
      { animalId: "animal-3", withdrawalMeatUntil: "2026-07-25", status: "cancelled" },
      { animalId: "animal-3", withdrawalMilkUntil: "2026-07-19", status: "completed" },
    ],
  });
  assert.equal(allowed.validation.valid, true);
});

test("requires all FMA responsibility declarations and transport/profile data", () => {
  const result = buildFmaDrafts({
    profile: { ...PROFILE, rup: "" },
    movement: movement({
      destinationRup: "",
      arrivalDate: "2026-07-19",
      carrierRut: "12.345.678-4",
      vehiclePlate: "",
      declarations: { noQuarantine: false, noSymptoms: false, noActiveWithdrawal: false },
    }),
    animals: [animal(1)],
  });
  const codes = new Set(result.validation.errors.map((entry) => entry.code));
  for (const code of [
    "PROFILE_RUP_REQUIRED",
    "FMA_DESTINATION_RUP_REQUIRED",
    "FMA_ARRIVAL_BEFORE_DEPARTURE",
    "FMA_CARRIER_RUT_INVALID",
    "FMA_VEHICLE_PLATE_REQUIRED",
    "FMA_DECLARATION_QUARANTINE_REQUIRED",
    "FMA_DECLARATION_SYMPTOMS_REQUIRED",
    "FMA_DECLARATION_WITHDRAWAL_REQUIRED",
  ]) assert.equal(codes.has(code), true, `missing ${code}`);
  assert.deepEqual(result.drafts, []);
});

test("exports semicolon CSV with BOM, explicit draft status, versions and safe cells", () => {
  const dea = buildDeaDraft({
    profile: { ...PROFILE, holderName: '=HYPERLINK("https://invalid")' },
    asOfDate: "2026-07-20",
    inventoryEntries: [{ speciesCode: "bovine", categoryCode: "cow", quantity: 3, trackingMode: "summary" }],
  }).draft;
  assert.ok(dea);
  const deaCsv = deaDraftToCsv(dea);
  assert.equal(deaCsv.startsWith("\uFEFF"), true);
  assert.match(deaCsv, /BORRADOR DECLARABLE SAG - NO DECLARADO/);
  assert.match(deaCsv, /2025-03-05/);
  assert.match(deaCsv, /'=HYPERLINK\(""https:\/\/invalid""\)/);

  const fmaResult = buildFmaDrafts({ profile: PROFILE, movement: movement({ observations: 'Carga; "prioritaria"' }), animals: [animal(1)] });
  const fmaCsv = fmaDraftToCsv(fmaResult.drafts[0]);
  assert.match(fmaCsv, /2024-08-08/);
  assert.match(fmaCsv, /Carga; ""prioritaria""/);
  assert.match(fmaCsv, /100000001/);
  const fmaBundleCsv = fmaDraftsToCsv(fmaResult.drafts);
  assert.equal(fmaBundleCsv.startsWith("\uFEFF"), true);
  assert.equal(fmaBundleCsv.slice(1).includes("\uFEFF"), false);
  assert.equal(fmaBundleCsv.includes("BORRADOR DECLARABLE SAG - NO DECLARADO"), true);
});

test("CSV exporters reject arbitrary or already-declared objects", () => {
  assert.throws(() => deaDraftToCsv({ documentKind: "SAG_DEA_DRAFT", declared: true, declarationStatus: "declared" }), /borradores SAG válidos/);
  assert.throws(() => fmaDraftToCsv({ documentKind: "SAG_FMA_DRAFT", declared: false }), /borradores SAG válidos/);
  assert.throws(() => fmaDraftsToCsv([]), /No hay borradores FMA/);
});

test("la ruta SIPEC reautoriza DEA y FMA después de serializar y antes de devolver CSV", async () => {
  const route = await readFile(new URL("../app/api/ganado/sipec/route.ts", import.meta.url), "utf8");
  assert.match(route, /reauthorizeApiAccess/);
  assert.equal([...route.matchAll(/reauthorizeApiAccess\(access, "operate", payload\.profile\.fieldId\)/g)].length, 2);
  assert.match(route, /const csv = deaDraftToCsv\(result\.draft\);[\s\S]+reauthorizeApiAccess[\s\S]+return csvResponse\(csv,/);
  assert.match(route, /const csv = fmaDraftsToCsv\(result\.drafts\);[\s\S]+reauthorizeApiAccess[\s\S]+return csvResponse\(csv,/);
  assert.equal([...route.matchAll(/if \(isAccessResponse\(currentAccess\)\) return currentAccess;/g)].length, 2);
});
