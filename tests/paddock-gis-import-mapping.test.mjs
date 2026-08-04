import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildGisImportCommitPlan,
  createGisImportMappingPlan,
  setGisImportHoleKind,
  updateGisImportMappingFeature,
  withGisImportMappingContext,
} from "../src/modules/potreros/import/mapping.ts";
import { calculateAreaSquareMeters } from "../src/modules/potreros/utils/geometry.ts";
import {
  createOsornoMappingPreview,
  lineFeature,
  makePreview,
  OSORNO_CURRENT_BOUNDARY,
  OSORNO_IMPORTED_BOUNDARY,
  OSORNO_PADDOCK_EAST,
  OSORNO_PADDOCK_WEST,
  pointFeature,
  polygonFeature,
  rectangle,
  unsupportedFeature,
} from "./fixtures/paddock-gis-import-mapping.mjs";

test("la heurística de Osorno elige sólo el contenedor inequívoco y conserva MultiPolygon y candidatos", () => {
  const preview = createOsornoMappingPreview();
  const before = structuredClone(preview);
  const plan = createGisImportMappingPlan(preview);

  assert.deepEqual(preview, before, "crear el plan no muta la vista previa");
  assert.equal(plan.heuristic.status, "unique_container");
  assert.equal(plan.summary.fieldBoundaries, 1);
  assert.equal(plan.summary.paddocks, 2);
  assert.equal(plan.summary.landmarkCandidates, 2);
  assert.equal(plan.effectiveBoundarySource, "imported");
  assert.deepEqual(
    plan.features.filter((feature) => feature.kind === "polygon").map((feature) => [feature.sourceIndex, feature.partIndex, feature.role]),
    [[0, null, "field_boundary"], [1, 0, "paddock"], [1, 1, "paddock"]],
  );
  assert.equal(plan.canCommit, false, "el hueco de la parte 1 sigue sin clasificar");
  assert.equal(plan.summary.unclassifiedHoles, 1);
  assert.ok(plan.features.filter((feature) => feature.kind === "landmark").every((feature) => feature.confirmable));
  assert.doesNotMatch(plan.globalBlockers.join(" "), /puntos|líneas/iu);
});

test("clasificar huecos produce PolygonRings canónico sin variar área y deja IDs idempotentes", () => {
  const preview = createOsornoMappingPreview();
  const first = createGisImportMappingPlan(preview);
  const repeated = createGisImportMappingPlan(structuredClone(preview));
  const west = first.features.find((feature) => feature.kind === "polygon" && feature.partIndex === 0);
  assert.ok(west);
  const classified = setGisImportHoleKind(first, west.planFeatureId, 0, "laguna");
  const result = buildGisImportCommitPlan(classified);

  assert.equal(first.features.find((feature) => feature.planFeatureId === west.planFeatureId).holeKinds[0], null);
  assert.equal(classified.canCommit, true);
  assert.deepEqual(
    first.features.map((feature) => [feature.planFeatureId, feature.targetId]),
    repeated.features.map((feature) => [feature.planFeatureId, feature.targetId]),
  );
  assert.equal(new Set(first.features.map((feature) => feature.planFeatureId)).size, first.features.length);
  assert.equal(new Set(first.features.map((feature) => feature.targetId)).size, first.features.length);
  assert.equal(result.ok, true);
  assert.equal(result.plan.validationBoundary.source, "imported");
  assert.deepEqual(result.plan.fieldBoundary.geometry.outer, OSORNO_IMPORTED_BOUNDARY);
  assert.equal(result.plan.paddocks.length, 2);
  assert.deepEqual(result.plan.paddocks[0].holeKinds, ["laguna"]);
  assert.equal(result.plan.landmarkCandidates.length, 2);
  for (const paddock of result.plan.paddocks) {
    const relativeAreaDelta = Math.abs(calculateAreaSquareMeters(paddock.geometry) - paddock.sourceAreaSquareMeters)
      / paddock.sourceAreaSquareMeters;
    assert.ok(relativeAreaDelta <= 0.001, `el área cambió ${relativeAreaDelta * 100}%`);
  }
});

test("sin contenedor único nunca inventa límite y puede validar contra el límite actual", () => {
  const disjoint = makePreview([
    polygonFeature({ previewFeatureId: "a", sourceIndex: 0, name: "Oeste", sector: "A", outer: OSORNO_PADDOCK_WEST }),
    polygonFeature({ previewFeatureId: "b", sourceIndex: 1, name: "Este", sector: "B", outer: OSORNO_PADDOCK_EAST }),
  ]);
  const withoutCurrent = createGisImportMappingPlan(disjoint);
  const withCurrent = createGisImportMappingPlan(disjoint, { currentFieldBoundary: OSORNO_CURRENT_BOUNDARY });

  assert.equal(withoutCurrent.heuristic.status, "not_found");
  assert.ok(withoutCurrent.features.every((feature) => feature.role === "paddock"));
  assert.equal(withoutCurrent.effectiveBoundarySource, null);
  assert.match(withoutCurrent.globalBlockers.join(" "), /límite actual/iu);
  assert.equal(withCurrent.effectiveBoundarySource, "current");
  assert.equal(withCurrent.canCommit, true);
  const commit = buildGisImportCommitPlan(withCurrent);
  assert.equal(commit.ok, true);
  assert.equal(commit.plan.fieldBoundary, null);
  assert.equal(commit.plan.validationBoundary.source, "current");

  const identical = makePreview([
    polygonFeature({ previewFeatureId: "same-a", sourceIndex: 0, name: "Uno", sector: "A", outer: OSORNO_PADDOCK_WEST }),
    polygonFeature({ previewFeatureId: "same-b", sourceIndex: 1, name: "Dos", sector: "B", outer: OSORNO_PADDOCK_WEST }),
  ]);
  const ambiguous = createGisImportMappingPlan(identical, { currentFieldBoundary: OSORNO_CURRENT_BOUNDARY });
  assert.equal(ambiguous.heuristic.status, "ambiguous");
  assert.equal(ambiguous.heuristic.candidatePlanFeatureIds.length, 2);
  assert.equal(ambiguous.summary.fieldBoundaries, 0);
});

test("ediciones Unicode son inmutables, conservan identidad y el plan limita field_boundary a uno", () => {
  const initial = createGisImportMappingPlan(createOsornoMappingPreview());
  const west = initial.features.find((feature) => feature.kind === "polygon" && feature.partIndex === 0);
  const east = initial.features.find((feature) => feature.kind === "polygon" && feature.partIndex === 1);
  assert.ok(west && east);
  const edited = updateGisImportMappingFeature(initial, west.planFeatureId, {
    name: "  Pradera N\u0303andu\u0301  ",
    sector: "  Húmedo Sur  ",
  });
  const editedWest = edited.features.find((feature) => feature.planFeatureId === west.planFeatureId);

  assert.equal(editedWest.name, "Pradera Ñandú");
  assert.equal(editedWest.sector, "Húmedo Sur");
  assert.equal(editedWest.targetId, west.targetId);
  assert.notEqual(edited, initial);
  assert.equal(initial.features.find((feature) => feature.planFeatureId === west.planFeatureId).name, west.name);

  const duplicateBoundary = updateGisImportMappingFeature(edited, east.planFeatureId, { role: "field_boundary" });
  assert.equal(duplicateBoundary.summary.fieldBoundaries, 2);
  assert.equal(duplicateBoundary.canCommit, false);
  assert.match(duplicateBoundary.globalBlockers.join(" "), /máximo un límite/iu);
  assert.throws(
    () => updateGisImportMappingFeature(initial, west.planFeatureId, { role: "landmark_candidate" }),
    /rol no corresponde/iu,
  );
});

test("IDs siguen sin colisionar incluso ante metadatos duplicados del preview", () => {
  const duplicate = polygonFeature({
    previewFeatureId: "duplicada",
    sourceIndex: 7,
    name: "Duplicada",
    sector: "A",
    outer: OSORNO_PADDOCK_WEST,
  });
  const preview = makePreview([duplicate, structuredClone(duplicate)], { importPreviewId: "id con Unicode Ñ y :" });
  const plan = createGisImportMappingPlan(preview, { currentFieldBoundary: OSORNO_CURRENT_BOUNDARY });
  const repeated = createGisImportMappingPlan(structuredClone(preview), { currentFieldBoundary: OSORNO_CURRENT_BOUNDARY });

  assert.equal(new Set(plan.features.map((feature) => feature.planFeatureId)).size, 2);
  assert.equal(new Set(plan.features.map((feature) => feature.targetId)).size, 2);
  assert.deepEqual(
    plan.features.map((feature) => [feature.planFeatureId, feature.targetId]),
    repeated.features.map((feature) => [feature.planFeatureId, feature.targetId]),
  );
  assert.ok(plan.features.every((feature) => !feature.planFeatureId.includes("Ñ")));
});

test("validatePotreroGeometry reporta solapes, salidas del fundo y geometría inválida por feature", () => {
  const overlapA = rectangle(-40.576, -73.146, -40.568, -73.136);
  const overlapB = rectangle(-40.575, -73.144, -40.567, -73.134);
  const outside = rectangle(-40.563, -73.123, -40.557, -73.115);
  const bowTie = [[-40.575, -73.145], [-40.568, -73.134], [-40.575, -73.134], [-40.568, -73.145]];
  const preview = makePreview([
    polygonFeature({ previewFeatureId: "overlap-a", sourceIndex: 0, name: "Solape A", sector: "A", outer: overlapA }),
    polygonFeature({ previewFeatureId: "overlap-b", sourceIndex: 1, name: "Solape B", sector: "B", outer: overlapB }),
    polygonFeature({ previewFeatureId: "outside", sourceIndex: 2, name: "Fuera", sector: "C", outer: outside }),
    polygonFeature({ previewFeatureId: "bow", sourceIndex: 3, name: "Cruzado", sector: "D", outer: bowTie }),
  ]);
  const plan = createGisImportMappingPlan(preview, { currentFieldBoundary: OSORNO_CURRENT_BOUNDARY });
  const first = plan.features.find((feature) => feature.previewFeatureId === "overlap-a");
  const third = plan.features.find((feature) => feature.previewFeatureId === "outside");
  const invalid = plan.features.find((feature) => feature.previewFeatureId === "bow");

  assert.match(first.warnings.join(" "), /superpone más de 0,1 ha/iu);
  assert.match(third.warnings.join(" "), /fuera del límite del fundo/iu);
  assert.match(invalid.errors.join(" "), /cruza consigo mismo/iu);
  assert.equal(invalid.confirmable, false);
  assert.equal(plan.canCommit, false);
});

test("huecos exigen clasificación exacta y pueden revalidarse con otro contexto sin mutación", () => {
  const initial = createGisImportMappingPlan(createOsornoMappingPreview());
  const west = initial.features.find((feature) => feature.kind === "polygon" && feature.partIndex === 0);
  assert.ok(west);
  assert.match(west.blockers.join(" "), /clasifica 1 hueco/iu);
  assert.throws(() => setGisImportHoleKind(initial, west.planFeatureId, 3, "laguna"), /hueco seleccionado/iu);
  assert.throws(
    () => updateGisImportMappingFeature(initial, west.planFeatureId, { holeKinds: [] }),
    /clasificación por cada hueco/iu,
  );

  const classified = setGisImportHoleKind(initial, west.planFeatureId, 0, "humedal");
  const currentBoundary = structuredClone(OSORNO_CURRENT_BOUNDARY);
  const revalidated = withGisImportMappingContext(classified, {
    currentFieldBoundary: currentBoundary,
    existingPaddockBoundaries: [OSORNO_PADDOCK_EAST],
  });
  currentBoundary[0][0] = 0;
  assert.equal(revalidated.context.currentFieldBoundary.outer[0][0], OSORNO_CURRENT_BOUNDARY[0][0]);
  assert.equal(classified.revision + 1, revalidated.revision);
});

test("puntos, líneas y features no soportadas se preservan o ignoran sin bloquear potreros", () => {
  const preview = makePreview([
    polygonFeature({ previewFeatureId: "p", sourceIndex: 0, name: "Potrero", sector: "A", outer: OSORNO_PADDOCK_WEST }),
    pointFeature({ previewFeatureId: "point", sourceIndex: 1, name: "Bebedero", coordinate: [-40.572, -73.14] }),
    lineFeature({ previewFeatureId: "line", sourceIndex: 2, name: "Cerco", coordinates: [[-40.575, -73.14], [-40.57, -73.14]] }),
    unsupportedFeature("bad", 3),
  ]);
  const initial = createGisImportMappingPlan(preview, { currentFieldBoundary: OSORNO_CURRENT_BOUNDARY });
  const point = initial.features.find((feature) => feature.previewFeatureId === "point");
  const unsupported = initial.features.find((feature) => feature.previewFeatureId === "bad");
  assert.equal(initial.canCommit, true);
  assert.equal(point.role, "landmark_candidate");
  assert.equal(unsupported.role, "ignore");
  assert.equal(unsupported.errors.length, 1);
  assert.equal(unsupported.blockers.length, 0);

  const ignoredPoint = updateGisImportMappingFeature(initial, point.planFeatureId, { role: "ignore" });
  const result = buildGisImportCommitPlan(ignoredPoint);
  assert.equal(result.ok, true);
  assert.equal(result.plan.landmarkCandidates.length, 1);
  assert.equal(result.plan.landmarkCandidates[0].geometry.type, "LineString");
});

test("el planificador permanece DOM/network-free y sin estado aleatorio o mutaciones globales", async () => {
  const source = await readFile(new URL("../src/modules/potreros/import/mapping.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:window|document|navigator|fetch|XMLHttpRequest|localStorage)\b/u);
  assert.doesNotMatch(source, /Math\.random|crypto\.randomUUID/u);
  assert.doesNotMatch(source, /from\s+["'](?:node:|leaflet|react)/u);
});
