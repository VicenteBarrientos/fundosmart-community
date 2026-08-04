import assert from "node:assert/strict";
import test from "node:test";
import { buildTodayAgenda } from "../src/modules/dashboard/today-agenda.mjs";

const herdItems = [
  {
    id: "pregnancy:cow-1:2026-07-27",
    kind: "pregnancy_check",
    animalId: "cow-1",
    animalTag: "TEST-001",
    lotId: "lot-1",
    lotName: "Lechería",
    fieldId: "field-1",
    dueDate: "2026-07-27",
    priority: "today",
    title: "Diagnóstico de preñez",
    detail: "Servicio sin confirmación registrada.",
  },
  {
    id: "weighing:cow-2:2026-07-20",
    kind: "weighing",
    animalId: "cow-2",
    animalTag: "TEST-002",
    lotId: "lot-1",
    lotName: "Lechería",
    fieldId: "field-1",
    dueDate: "2026-07-20",
    priority: "overdue",
    title: "Pesaje pendiente",
    detail: "Último pesaje vencido.",
  },
];

test("combines existing sources into one ordered agenda with evidence and safe links", () => {
  const items = buildTodayAgenda({
    contextFieldId: "field-1",
    herdWorkItems: herdItems,
    mammaryWorkItems: [{
      animalId: "cow-3",
      fieldId: "field-1",
      tag: "TEST-003",
      lotName: "Lechería",
      priority: "urgent",
      action: "review_now",
      controlDate: "2026-07-26",
      ageDays: 1,
      totalLiters: 14,
      somaticCellCount: 800_000,
      status: "critical",
      trend: "increasing",
      hasOpenMastitis: false,
      reasonCodes: ["critical_rcs", "increasing_trend"],
    }],
    operationalAlerts: [{
      id: "no-available-paddocks",
      tone: "warning",
      title: "Sin potreros disponibles",
      detail: "No hay potreros marcados como disponibles.",
      href: "/app/potreros",
    }],
    referenceDate: "2026-07-27T12:00:00.000Z",
  });

  assert.deepEqual(items.map(({ id, urgency }) => [id, urgency]), [
    ["ganado:weighing:cow-2:2026-07-20", "urgent"],
    ["leche:mammary:cow-3", "urgent"],
    ["ganado:pregnancy:cow-1:2026-07-27", "today"],
    ["operacion:field-1:no-available-paddocks", "soon"],
  ]);
  assert.equal(items.every((item) => item.reason && item.sourceLabel && item.evidenceDate), true);
  assert.equal(items.every((item) => item.href.startsWith("/app/")), true);
  assert.match(items.find((item) => item.id === "leche:mammary:cow-3").href, /section=health/);
  assert.match(items.find((item) => item.id === "leche:mammary:cow-3").reason, /800\.000 células\/ml/);
});

test("deduplicates aggregate weighing and open mammary follow-up signals", () => {
  const items = buildTodayAgenda({
    herdWorkItems: [
      ...herdItems,
      {
        id: "health:cow-3:2026-07-20",
        kind: "health_follow_up",
        animalId: "cow-3",
        animalTag: "TEST-003",
        lotId: "lot-1",
        lotName: "Lechería",
        fieldId: "field-1",
        dueDate: "2026-07-20",
        priority: "overdue",
        title: "Seguimiento sanitario",
        detail: "Caso abierto.",
      },
    ],
    mammaryWorkItems: [{
      animalId: "cow-3",
      fieldId: "field-1",
      tag: "TEST-003",
      lotName: "Lechería",
      priority: "urgent",
      action: "review_now",
      controlDate: null,
      ageDays: null,
      totalLiters: null,
      somaticCellCount: null,
      status: "unknown",
      trend: "unavailable",
      hasOpenMastitis: true,
      reasonCodes: ["open_mastitis_case"],
    }],
    operationalAlerts: [{
      id: "weight-coverage",
      tone: "warning",
      title: "Cobertura de pesaje baja",
      detail: "Faltan pesajes.",
      href: "/app/ganado",
    }],
    referenceDate: "2026-07-27",
  });

  assert.equal(items.some((item) => item.id.includes("health:cow-3")), false);
  assert.equal(items.some((item) => item.id.includes("weight-coverage")), false);
  assert.equal(items.filter((item) => item.animalId === "cow-3").length, 1);
});

test("keeps aggregate operational signals when no individual task replaces them", () => {
  const [item] = buildTodayAgenda({
    operationalAlerts: [{
      id: "weight-coverage",
      tone: "warning",
      title: "Cobertura de pesaje baja",
      detail: "Faltan pesajes.",
      href: "https://external.example",
    }],
    referenceDate: "2026-07-27",
  });

  assert.equal(item.category, "weighing");
  assert.equal(item.href, "/app");
  assert.equal(item.sourceLabel, "Ganado");
});

test("projects only recent reconciled agronomic recommendations for the selected field", () => {
  const items = buildTodayAgenda({
    agronomicWorkItems: [
      {
        id: "recommendation-1",
        fieldId: "field-1",
        importJobId: "import-1",
        paddockId: "paddock-7",
        paddockName: "Potrero 7",
        externalPaddockKey: "7",
        visitDate: "2026-02-17",
        actionHeading: "Siembras obligadas.",
        recommendationText: "Revisar el barbecho antes de sembrar.",
      },
      {
        id: "recommendation-old",
        fieldId: "field-1",
        importJobId: "import-old",
        paddockId: "paddock-old",
        paddockName: "Potrero antiguo",
        externalPaddockKey: "1",
        visitDate: "2025-12-01",
        actionHeading: "Manejo histórico.",
        recommendationText: "Esta señal ya es demasiado antigua para Hoy.",
      },
      {
        id: "recommendation-other-field",
        fieldId: "field-2",
        importJobId: "import-2",
        paddockId: "paddock-2",
        paddockName: "Potrero 2",
        externalPaddockKey: "2",
        visitDate: "2026-07-20",
        actionHeading: "Manejo reciente.",
        recommendationText: "Pertenece a otro fundo.",
      },
    ],
    contextFieldId: "field-1",
    referenceDate: "2026-07-27",
  });

  assert.equal(items.length, 1);
  assert.equal(items[0].id, "potreros:agronomic:recommendation-1");
  assert.equal(items[0].source, "potreros");
  assert.equal(items[0].urgency, "review");
  assert.equal(items[0].lotName, "Potrero 7");
  assert.equal(items[0].href, "/app/potreros?fieldId=field-1");
  assert.match(items[0].reason, /Revisar el barbecho/);
});

test("does not mutate source arrays and drops malformed rows", () => {
  const source = structuredClone(herdItems);
  const items = buildTodayAgenda({
    herdWorkItems: [...source, { id: "", kind: "weighing" }],
    referenceDate: "2026-07-27",
  });

  assert.deepEqual(source, herdItems);
  assert.equal(items.length, herdItems.length);
});

test("projects staged import signals into the agenda with proper urgency and source", () => {
  const items = buildTodayAgenda({
    contextFieldId: "field-1",
    importWorkItems: [
      {
        id: "import-job-1",
        fieldId: "field-1",
        importJobId: "job-101",
        sourceType: "survet_control",
        filename: "Control_Lechero_Julio.xlsx",
        createdAt: "2026-07-26T10:00:00.000Z",
        status: "staged",
        summary: "30 registros de control lechero en staging.",
      },
      {
        id: "import-job-2",
        fieldId: "field-1",
        importJobId: "job-102",
        sourceType: "cooprinsem_soil",
        filename: "Analisis_Suelo_P2.pdf",
        createdAt: "2026-07-27T08:00:00.000Z",
        status: "conflict",
        summary: "Conflicto en la conciliación del potrero P2.",
      },
    ],
    referenceDate: "2026-07-27",
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].id, "importaciones:staged:import-job-2");
  assert.equal(items[0].urgency, "urgent");
  assert.equal(items[0].category, "imports");
  assert.equal(items[0].source, "importaciones");
  assert.match(items[0].title, /Analisis_Suelo_P2.pdf/);

  assert.equal(items[1].id, "importaciones:staged:import-job-1");
  assert.equal(items[1].urgency, "today");
  assert.equal(items[1].category, "imports");
  assert.equal(items[1].href, "/app/importaciones?fieldId=field-1");
});
