import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseLotDestination,
  DEFAULT_AREA_TOLERANCE_RATIO,
  DEFAULT_AREA_TOLERANCE_SQUARE_METERS,
  planMerge,
  planRedesign,
  planSplit,
  planUndo,
} from "../src/modules/potreros/utils/paddock-operations.ts";
import { metersToDegrees } from "../src/modules/potreros/utils/geometry.ts";

const ORIGIN_LATITUDE = -40;
const ORIGIN_LONGITUDE = -73;

function coordinate(northMeters, eastMeters) {
  return [
    ORIGIN_LATITUDE + metersToDegrees(northMeters, ORIGIN_LATITUDE, "latitude"),
    ORIGIN_LONGITUDE + metersToDegrees(eastMeters, ORIGIN_LATITUDE, "longitude"),
  ];
}

function rectangle(id, westMeters, eastMeters, southMeters, northMeters) {
  return {
    id,
    coordinates: [
      coordinate(southMeters, westMeters),
      coordinate(southMeters, eastMeters),
      coordinate(northMeters, eastMeters),
      coordinate(northMeters, westMeters),
    ],
  };
}

function verticalSplitChildren(prefix, widthMeters, heightMeters, count, missingAreaSquareMeters = 0) {
  const stripWidthMeters = widthMeters / count;
  return Array.from({ length: count }, (_, index) => {
    const westMeters = stripWidthMeters * index;
    const eastMeters = index === count - 1 ? widthMeters : stripWidthMeters * (index + 1);
    const northMeters = index === count - 1
      ? heightMeters - missingAreaSquareMeters / (eastMeters - westMeters)
      : heightMeters;
    return rectangle(`${prefix}-${index + 1}`, westMeters, eastMeters, 0, northMeters);
  });
}

test("planMerge acepta una arista compartida y normaliza duplicados sin redondear el área", () => {
  const left = rectangle("a-left", 0, 100, 0, 100);
  const right = rectangle("b-right", 100, 200, 0, 100);
  left.coordinates.splice(2, 0, [...left.coordinates[1]]);
  left.coordinates.push([...left.coordinates[0]]);

  const plan = planMerge([left, right], "merged");

  assert.equal(plan.valid, true, plan.blockers.join("\n"));
  assert.equal(plan.children.length, 1);
  assert.equal(plan.lineageEdges.length, 2);
  assert.equal(plan.primaryParentByChildId.merged, "a-left");
  assert.ok(plan.areaBeforeSquareMeters > 19_000);
  assert.ok(plan.areaAfterSquareMeters > 19_000);
  assert.ok(plan.areaDeltaRatio < 1e-6);
  const merged = plan.children[0].coordinates;
  assert.notDeepEqual(merged[0], merged.at(-1));
  merged.forEach((point, index) => {
    if (index > 0) assert.notDeepEqual(point, merged[index - 1]);
  });
});

test("planMerge bloquea contacto por punto, polígonos disjuntos y un Polygon con huecos", () => {
  const base = rectangle("base", 0, 100, 0, 100);
  const pointOnly = rectangle("point", 100, 200, 100, 200);
  const disjoint = rectangle("disjoint", 300, 400, 0, 100);

  const pointPlan = planMerge([base, pointOnly], "point-result");
  const disjointPlan = planMerge([base, disjoint], "disjoint-result");

  assert.equal(pointPlan.valid, false);
  assert.match(pointPlan.blockers.join(" "), /punto|MultiPolygon/iu);
  assert.equal(disjointPlan.valid, false);
  assert.match(disjointPlan.blockers.join(" "), /disjuntas|MultiPolygon/iu);

  const frame = [
    rectangle("bottom", 0, 300, 0, 100),
    rectangle("top", 0, 300, 200, 300),
    rectangle("left", 0, 100, 100, 200),
    rectangle("right", 200, 300, 100, 200),
  ];
  const holePlan = planMerge(frame, "frame");
  assert.equal(holePlan.valid, false);
  assert.match(holePlan.blockers.join(" "), /huecos/iu);
});

test("planSplit conserva el área y las aristas compartidas sin tocar un potrero externo", () => {
  const parent = rectangle("parent", 0, 200, 0, 100);
  const children = [
    rectangle("child-left", 0, 100, 0, 100),
    rectangle("child-right", 100, 200, 0, 100),
  ];
  const external = rectangle("external", 300, 400, 0, 100);
  const originalInputs = structuredClone({ parent, children, external });

  const plan = planSplit(parent, children);

  assert.equal(plan.valid, true, plan.blockers.join("\n"));
  assert.equal(plan.parents.length, 1);
  assert.equal(plan.parents[0].id, "parent");
  assert.equal(plan.children.length, 2);
  assert.ok(plan.areaDeltaRatio < 1e-6);
  assert.deepEqual({ parent, children, external }, originalInputs);
  const lowerShared = coordinate(0, 100);
  const upperShared = coordinate(100, 100);
  plan.children.forEach((child) => {
    assert.ok(child.coordinates.some((point) => point[0] === lowerShared[0] && point[1] === lowerShared[1]));
    assert.ok(child.coordinates.some((point) => point[0] === upperShared[0] && point[1] === upperShared[1]));
  });
});

test("planSplit tolera menos de 1 m² de deriva numérica al crear 15 hijos", () => {
  const parent = rectangle("parent-large", 0, 1_000, 0, 475);
  const children = verticalSplitChildren("child", 1_000, 475, 15, 0.9);

  const plan = planSplit(parent, children);

  assert.ok(plan.absoluteAreaDeltaSquareMeters > 0.8);
  assert.ok(plan.absoluteAreaDeltaSquareMeters < 1);
  assert.ok(plan.areaDeltaRatio > 1e-6, "la regresión debe superar la tolerancia antigua");
  assert.ok(plan.areaDeltaRatio < DEFAULT_AREA_TOLERANCE_RATIO);
  assert.equal(plan.valid, true, plan.blockers.join("\n"));
  assert.doesNotMatch(plan.blockers.join(" "), /no conserva el área cruda/iu);
});

test("planSplit reporta diferencias materiales por proporción o metros cuadrados como advertencias sin bloquear", () => {
  const proportionalParent = rectangle("parent-proportional", 0, 1_000, 0, 475);
  const proportionalPlan = planSplit(
    proportionalParent,
    verticalSplitChildren("proportional", 1_000, 475, 15, 10),
  );
  assert.ok(proportionalPlan.areaDeltaRatio > DEFAULT_AREA_TOLERANCE_RATIO);
  assert.equal(proportionalPlan.valid, true);
  assert.doesNotMatch(proportionalPlan.blockers.join(" "), /no conserva el área cruda/iu);
  assert.match(proportionalPlan.warnings.join(" "), /no conserva el área cruda/iu);

  const absoluteParent = rectangle("parent-absolute", 0, 5_000, 0, 5_000);
  const absolutePlan = planSplit(
    absoluteParent,
    verticalSplitChildren("absolute", 5_000, 5_000, 15, 6),
  );
  assert.ok(absolutePlan.areaDeltaRatio < DEFAULT_AREA_TOLERANCE_RATIO);
  assert.ok(absolutePlan.absoluteAreaDeltaSquareMeters > DEFAULT_AREA_TOLERANCE_SQUARE_METERS);
  assert.equal(absolutePlan.valid, true);
  assert.doesNotMatch(absolutePlan.blockers.join(" "), /no conserva el área cruda/iu);
  assert.match(absolutePlan.warnings.join(" "), /no conserva el área cruda/iu);
});

test("planRedesign expone la matriz completa y el padre primario es determinista en empates", () => {
  const parents = [
    rectangle("a-left", 0, 100, 0, 100),
    rectangle("b-right", 100, 200, 0, 100),
  ];
  const children = [
    rectangle("south", 0, 200, 0, 50),
    rectangle("north", 0, 200, 50, 100),
  ];

  const plan = planRedesign(parents, children);

  assert.equal(plan.valid, true, plan.blockers.join("\n"));
  assert.equal(plan.overlapMatrix.length, 4);
  assert.equal(plan.lineageEdges.length, 4);
  assert.equal(plan.primaryParentByChildId.south, "a-left");
  assert.equal(plan.primaryParentByChildId.north, "a-left");
  assert.equal(plan.lineageEdges.filter((edge) => edge.isPrimary).length, 2);
  assert.ok(plan.areaDeltaRatio < 1e-6);
});

test("chooseLotDestination exige un ganador único con al menos 30% del área padre", () => {
  const parent = rectangle("parent", 0, 100, 0, 100);
  const below = chooseLotDestination(parent, [rectangle("below", 0, 29.9, 0, 100)], { lotId: "lot-below" });
  const threshold = chooseLotDestination(parent, [rectangle("threshold", 0, 30, 0, 100)], { lotId: "lot-threshold" });
  const tie = chooseLotDestination(parent, [
    rectangle("a-half", 0, 50, 0, 100),
    rectangle("b-half", 50, 100, 0, 100),
  ], { lotId: "lot-tie" });

  assert.equal(below.destinationPaddockId, null);
  assert.equal(below.reason, "below-threshold");
  assert.ok(below.overlapRatio < 0.3);
  assert.equal(threshold.destinationPaddockId, "threshold");
  assert.equal(threshold.reason, "winner");
  assert.ok(Math.abs(threshold.overlapRatio - 0.3) < 1e-9);
  assert.equal(tie.destinationPaddockId, null);
  assert.equal(tie.reason, "tie");
  assert.match(tie.warning, /empate/iu);
});

test("planUndo invierte lotes intactos y bloquea actividad, descendencia y lotes cambiados o nuevos", () => {
  const reversible = planUndo({
    operationId: "op-ok",
    children: [
      { paddockId: "child-a", ownActivityCount: 0, descendantOperationCount: 0 },
      { paddockId: "child-b", ownActivityCount: 0, descendantOperationCount: 0 },
    ],
    originalLotMoves: [
      { lotId: "lot-1", fromPaddockId: "parent", toPaddockId: "child-a" },
    ],
    currentLots: [
      { lotId: "lot-1", paddockId: "child-a" },
    ],
  });

  assert.equal(reversible.canUndo, true);
  assert.deepEqual(reversible.reverseLotMoves, [
    { lotId: "lot-1", fromPaddockId: "child-a", toPaddockId: "parent" },
  ]);

  const blocked = planUndo({
    operationId: "op-blocked",
    children: [
      { paddockId: "child-a", ownActivityCount: 1, descendantOperationCount: 0 },
      { paddockId: "child-b", ownActivityCount: 0, descendantOperationCount: 1 },
    ],
    originalLotMoves: [
      { lotId: "lot-changed", fromPaddockId: "parent", toPaddockId: "child-a" },
    ],
    currentLots: [
      { lotId: "lot-changed", paddockId: "child-b" },
      { lotId: "lot-new", paddockId: "child-a" },
    ],
  });

  assert.equal(blocked.canUndo, false);
  assert.deepEqual(blocked.reverseLotMoves, []);
  assert.match(blocked.blockers.join(" "), /actividad propia/iu);
  assert.match(blocked.blockers.join(" "), /descendiente/iu);
  assert.match(blocked.blockers.join(" "), /cambió/iu);
  assert.match(blocked.blockers.join(" "), /fue asignado/iu);
});
