import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  getPaddockLegend,
  getPaddockStyle,
  PADDOCK_THEMATIC_MODE_LABELS,
} from "../src/modules/potreros/utils/paddock-style.ts";

const BASE_PADDOCK = {
  id: "paddock-1",
  name: "La Vega",
  status: "Disponible",
  sector: "Norte",
  landUse: "pradera_permanente",
  soil: { ph: 6.2 },
};

test("el contrato cubre los seis modos y cada estilo referencia literalmente su leyenda", () => {
  assert.deepEqual(Object.keys(PADDOCK_THEMATIC_MODE_LABELS), [
    "status",
    "sector",
    "land_use",
    "ph",
    "rotation",
    "ndvi",
  ]);
  const contexts = {
    status: {},
    sector: { sectors: ["Norte"] },
    land_use: {},
    ph: {},
    rotation: {
      rotationSnapshot: { grazingDates: ["2026-07-05"] },
      rotationReferenceDate: "2026-07-20",
    },
    ndvi: { ndviSnapshot: { meanNdvi: 0.72, observedAt: "2026-06-18" } },
  };

  Object.keys(PADDOCK_THEMATIC_MODE_LABELS).forEach((mode) => {
    const style = getPaddockStyle(BASE_PADDOCK, mode, contexts[mode]);
    const legend = getPaddockLegend(mode, contexts[mode]);
    const entry = legend.entries.find((candidate) => candidate.key === style.categoryKey);

    assert.ok(entry, `${mode} debe tener una entrada de leyenda para ${style.categoryKey}`);
    assert.equal(style.label, entry.label);
    assert.equal(style.pathOptions.fillColor, entry.color);
    assert.equal(style.textColor, entry.textColor);
    assert.equal(legend.title, PADDOCK_THEMATIC_MODE_LABELS[mode]);
  });
});

test("pH usa cuatro cortes inclusivos, acepta extremos físicos y explicita valores ausentes o inválidos", () => {
  const cases = [
    [0, "ph:very_acidic"],
    [5.499, "ph:very_acidic"],
    [5.5, "ph:acidic"],
    [5.999, "ph:acidic"],
    [6, "ph:suitable"],
    [6.5, "ph:suitable"],
    [6.501, "ph:high"],
    [14, "ph:high"],
  ];
  cases.forEach(([ph, expected]) => {
    assert.equal(styleForPh(ph).categoryKey, expected);
  });
  [null, Number.NaN, Number.POSITIVE_INFINITY, -0.001, 14.001].forEach((ph) => {
    const style = styleForPh(ph);
    assert.equal(style.categoryKey, "missing");
    assert.equal(style.hasData, false);
    assert.equal(style.pathOptions.dashArray, "4 4");
  });
  assert.equal(getPaddockLegend("ph").entries.length, 5, "cuatro rangos más Sin dato");
  assert.match(styleForPh(6.2).detail, /^pH 6,2 · Adecuado/u);
});

test("NDVI usa cuatro cortes sobre [-1, 1] y exige un snapshot mensual fechado", () => {
  const cases = [
    [-1, "ndvi:very_low"],
    [0.199, "ndvi:very_low"],
    [0.2, "ndvi:low"],
    [0.399, "ndvi:low"],
    [0.4, "ndvi:medium"],
    [0.599, "ndvi:medium"],
    [0.6, "ndvi:high"],
    [1, "ndvi:high"],
  ];
  cases.forEach(([meanNdvi, expected]) => {
    assert.equal(styleForNdvi(meanNdvi, "2026-06").categoryKey, expected);
  });
  assert.equal(styleForNdvi(0.72, "2026-06-18T12:30:00Z").detail, "NDVI 0,72 · jun 2026");
  assert.equal(styleForNdvi(0.72, new Date("2026-06-18T23:00:00Z")).detail, "NDVI 0,72 · jun 2026");
  [
    [null, "2026-06"],
    [Number.NaN, "2026-06"],
    [-1.001, "2026-06"],
    [1.001, "2026-06"],
    [0.72, null],
    [0.72, "2026-02-30"],
    [0.72, "fecha-inválida"],
  ].forEach(([meanNdvi, observedAt]) => {
    assert.equal(styleForNdvi(meanNdvi, observedAt).categoryKey, "missing");
  });
  assert.equal(getPaddockLegend("ndvi").entries.length, 5, "cuatro rangos más Sin dato");
});

test("sectores Unicode se normalizan, ordenan y colorean de forma estable e independiente del orden", () => {
  const composed = "Ñandú";
  const decomposed = "N\u0303andu\u0301";
  const sectors = ["  Zorzal ", composed, "Álamo", "Aromo", decomposed, null, "   "];
  const forward = getPaddockLegend("sector", { sectors });
  const reverse = getPaddockLegend("sector", { sectors: [...sectors].reverse() });

  assert.deepEqual(forward, reverse);
  assert.deepEqual(forward.entries.map((entry) => entry.key), [
    "sector:aromo",
    "sector:zorzal",
    "sector:álamo",
    "sector:ñandú",
    "missing",
  ]);
  const normalizedStyle = getPaddockStyle({ ...BASE_PADDOCK, sector: `  ${decomposed} ` }, "sector");
  const composedStyle = getPaddockStyle({ ...BASE_PADDOCK, sector: composed }, "sector");
  assert.equal(normalizedStyle.categoryKey, composedStyle.categoryKey);
  assert.equal(normalizedStyle.pathOptions.fillColor, composedStyle.pathOptions.fillColor);
  assert.equal(getPaddockStyle({ ...BASE_PADDOCK, sector: "   " }, "sector").categoryKey, "missing");
});

test("rotación reutiliza el motor de descanso, sus umbrales y hace explícita la calidad desconocida", () => {
  const style = (grazingDates, assignedLotCount = 0, rotationThresholds) => getPaddockStyle(BASE_PADDOCK, "rotation", {
    rotationSnapshot: { grazingDates, assignedLotCount },
    rotationReferenceDate: "2026-07-20",
    rotationThresholds,
  });

  assert.equal(style(["2026-05-01"], 1).categoryKey, "rotation:occupied");
  assert.equal(style(["2026-07-06"]).categoryKey, "rotation:recent");
  assert.equal(style(["2026-07-05"]).categoryKey, "rotation:ready");
  assert.equal(style(["2026-06-19"]).categoryKey, "rotation:long_rest");
  assert.equal(style([]).categoryKey, "missing");
  assert.equal(style(["fecha-inválida"]).categoryKey, "missing");
  assert.equal(style(["2026-07-22"]).categoryKey, "missing");
  assert.equal(getPaddockStyle(BASE_PADDOCK, "rotation").categoryKey, "missing");

  const custom = style(["2026-07-10"], 0, { recentDays: 7, longRestDays: 21 });
  const legend = getPaddockLegend("rotation", { rotationThresholds: { recentDays: 7, longRestDays: 21 } });
  assert.equal(custom.categoryKey, "rotation:ready");
  assert.equal(custom.label, "Listo (7–21 días)");
  assert.equal(legend.entries.find((entry) => entry.key === custom.categoryKey).label, custom.label);
  assert.throws(
    () => getPaddockLegend("rotation", { rotationThresholds: { recentDays: 31, longRestDays: 30 } }),
    /umbrales/iu,
  );
});

test("selección y foco conservan el color y la categoría semántica", () => {
  const base = getPaddockStyle(BASE_PADDOCK, "status");
  const selected = getPaddockStyle(BASE_PADDOCK, "status", { selected: true });
  const focused = getPaddockStyle(BASE_PADDOCK, "status", { focused: true });
  const both = getPaddockStyle(BASE_PADDOCK, "status", { selected: true, focused: true });

  [selected, focused, both].forEach((style) => {
    assert.equal(style.categoryKey, base.categoryKey);
    assert.equal(style.label, base.label);
    assert.equal(style.pathOptions.fillColor, base.pathOptions.fillColor);
    assert.ok(style.pathOptions.weight > base.pathOptions.weight);
  });
  assert.equal(selected.selected, true);
  assert.equal(focused.focused, true);
  assert.deepEqual([both.selected, both.focused], [true, true]);
  assert.equal(focused.pathOptions.dashArray, "8 3");
});

test("todos los nulos caen en una categoría visible y todas las paletas ofrecen contraste textual AA", () => {
  const empty = { id: "empty", name: "Sin datos", status: null, sector: null, landUse: null, soil: { ph: null } };
  ["status", "sector", "land_use", "ph", "rotation", "ndvi"].forEach((mode) => {
    const style = getPaddockStyle(empty, mode);
    assert.equal(style.categoryKey, "missing");
    assert.equal(style.label, "Sin dato");
    assert.equal(style.hasData, false);
  });

  const legendContexts = {
    status: {},
    sector: { sectors: ["Norte", "Sur", "Ñandú", "Vega", "Loma"] },
    land_use: {},
    ph: {},
    rotation: {},
    ndvi: {},
  };
  Object.entries(legendContexts).forEach(([mode, context]) => {
    getPaddockLegend(mode, context).entries.forEach((entry) => {
      assert.ok(
        contrastRatio(entry.color, entry.textColor) >= 4.5,
        `${mode}/${entry.key} debe alcanzar contraste AA`,
      );
    });
  });
});

test("el helper permanece puro, portable a Workers y sin dependencias DOM, Leaflet o de red", async () => {
  const source = await readFile(new URL("../src/modules/potreros/utils/paddock-style.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /from\s+["'](?:leaflet|react-leaflet)["']/u);
  assert.doesNotMatch(source, /\b(?:window|document|navigator|fetch|XMLHttpRequest)\b/u);
});

function styleForPh(ph) {
  return getPaddockStyle({ ...BASE_PADDOCK, soil: { ph } }, "ph");
}

function styleForNdvi(meanNdvi, observedAt) {
  return getPaddockStyle(BASE_PADDOCK, "ndvi", { ndviSnapshot: { meanNdvi, observedAt } });
}

function contrastRatio(first, second) {
  const brighter = Math.max(relativeLuminance(first), relativeLuminance(second));
  const darker = Math.min(relativeLuminance(first), relativeLuminance(second));
  return (brighter + 0.05) / (darker + 0.05);
}

function relativeLuminance(color) {
  const components = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(color);
  assert.ok(components, `color hexadecimal esperado: ${color}`);
  const linear = components.slice(1).map((component) => {
    const channel = Number.parseInt(component, 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
}
