import assert from "node:assert/strict";
import test from "node:test";
import {
  createMapWorkspaceState,
  reduceMapWorkspace,
} from "../src/modules/potreros/workspace/useMapWorkspace.ts";

const INITIAL_CONTEXT = {
  fieldId: "field-alpha",
  viewport: { center: [-40.5, -73.1], zoom: 14 },
};

const VALID_CANONICAL_LAYER = {
  id: "layer-canonical-paddocks",
  kind: "canonical",
  label: "Potreros Canónicos",
  source: "fundosmart-d1",
  status: "available",
  visible: true,
  observedAt: "2026-07-28T13:00:00.000Z",
  version: "v1",
  attribution: "FundoSmart",
  error: null,
};

const VALID_EXTERNAL_LAYER = {
  id: "layer-osm-tiles",
  kind: "external-context",
  label: "OpenStreetMap",
  source: "osm-online",
  status: "available",
  visible: true,
  observedAt: "2026-07-28T13:00:00.000Z",
  version: "v1",
  attribution: "© OpenStreetMap contributors",
  error: null,
};

test("reduceMapWorkspace registra capa válida y mantiene inmutabilidad", () => {
  const initial = createMapWorkspaceState(INITIAL_CONTEXT);
  const next = reduceMapWorkspace(initial, {
    type: "register-layer",
    layer: VALID_CANONICAL_LAYER,
    ...INITIAL_CONTEXT,
  });

  assert.notEqual(initial, next);
  assert.equal(Object.keys(next.layers).length, 1);
  assert.equal(next.layers["layer-canonical-paddocks"].label, "Potreros Canónicos");
  assert.ok(Object.isFrozen(next.layers));
});

test("reduceMapWorkspace conmuta la visibilidad de una capa registrada", () => {
  const initial = createMapWorkspaceState(INITIAL_CONTEXT);
  const withLayer = reduceMapWorkspace(initial, {
    type: "register-layer",
    layer: VALID_CANONICAL_LAYER,
    ...INITIAL_CONTEXT,
  });

  const hidden = reduceMapWorkspace(withLayer, {
    type: "set-layer-visibility",
    id: "layer-canonical-paddocks",
    visible: false,
    ...INITIAL_CONTEXT,
  });

  assert.equal(hidden.layers["layer-canonical-paddocks"].visible, false);

  const shown = reduceMapWorkspace(hidden, {
    type: "set-layer-visibility",
    id: "layer-canonical-paddocks",
    visible: true,
    ...INITIAL_CONTEXT,
  });

  assert.equal(shown.layers["layer-canonical-paddocks"].visible, true);
});

test("reduceMapWorkspace actualiza el estado de una capa registrada y valida incoherencias", () => {
  const initial = createMapWorkspaceState(INITIAL_CONTEXT);
  const withLayer = reduceMapWorkspace(initial, {
    type: "register-layer",
    layer: VALID_EXTERNAL_LAYER,
    ...INITIAL_CONTEXT,
  });

  const updated = reduceMapWorkspace(withLayer, {
    type: "set-layer-status",
    id: "layer-osm-tiles",
    status: "stale",
    ...INITIAL_CONTEXT,
  });

  assert.equal(updated.layers["layer-osm-tiles"].status, "stale");

  // Incoherent error status without message should be rejected (returns same state)
  const invalid = reduceMapWorkspace(updated, {
    type: "set-layer-status",
    id: "layer-osm-tiles",
    status: "error",
    error: null,
    ...INITIAL_CONTEXT,
  });

  assert.equal(invalid, updated);
});
