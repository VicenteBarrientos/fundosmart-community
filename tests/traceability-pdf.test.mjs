import assert from "node:assert/strict";
import test from "node:test";

import {
  renderTraceabilityDocumentPdf,
  sha256Hex,
  traceabilityDocumentObjectKey,
} from "../src/modules/trazabilidad/server/official-document-pdf.mjs";

test("renders deterministic multi-page FMA PDFs with an immutable tenant key", async () => {
  const projection = fmaProjection();
  const first = renderTraceabilityDocumentPdf(projection);
  const replay = renderTraceabilityDocumentPdf(structuredClone(projection));
  assert.deepEqual(first, replay);
  assert.equal(new TextDecoder("latin1").decode(first.slice(0, 8)), "%PDF-1.7");
  const body = new TextDecoder("latin1").decode(first);
  assert.match(body, /\/Type \/Pages \/Count 2/u);
  assert.match(body, /BORRADOR - NO DECLARADO/u);
  assert.match(body, /Formato oficial SAG pendiente de confirmaci/u);
  assert.equal(await sha256Hex(first), await sha256Hex(replay));
  assert.equal(
    traceabilityDocumentObjectKey(projection),
    "trazabilidad/org-a/field-a/fma/fma-2026-001/v1.pdf",
  );
});

test("renders DEA totals without inventing an official status", async () => {
  const projection = deaProjection();
  const pdf = renderTraceabilityDocumentPdf(projection);
  const body = new TextDecoder("latin1").decode(pdf);
  assert.match(body, /Declaraci.n de Existencias Anual/u);
  assert.match(body, /Total de animales/u);
  assert.match(body, /DATOS FICTICIOS DE DEMOSTRACI.N/u);
  assert.equal((await sha256Hex(pdf)).length, 64);
});

test("renders a deterministic internally issued FMA without claiming SAG submission", async () => {
  const draft = fmaProjection();
  const projection = {
    ...draft,
    metadata: { ...draft.metadata, state: "issued", folio: "FS-FMA-0123456789ABCDEF" },
  };
  const first = renderTraceabilityDocumentPdf(projection);
  const replay = renderTraceabilityDocumentPdf(structuredClone(projection));
  assert.deepEqual(first, replay);
  const body = new TextDecoder("latin1").decode(first);
  assert.match(body, /EMITIDO INTERNO - NO SAG/u);
  assert.match(body, /FS-FMA-0123456789ABCDEF/u);
  assert.match(body, /no acredita una declaraci.n/u);
});

test("rejects path traversal in official document identities", () => {
  assert.throws(
    () => traceabilityDocumentObjectKey({ ...deaProjection(), metadata: { ...deaProjection().metadata, documentId: "../secret" } }),
    /identidad documental/u,
  );
});

function fmaProjection() {
  return {
    metadata: {
      documentId: "fma-2026-001",
      kind: "FMA",
      revision: 1,
      generatedAt: "2026-07-21T12:00:00.000Z",
      formVersion: "2024-08-08",
      fakeData: false,
    },
    content: {
      organizationId: "org-a",
      fieldId: "field-a",
      establishment: { rup: "01.02.1234", holderName: "Agrícola Los Robles SpA", commune: "Osorno", address: "Camino Rural 123" },
      destination: { rup: "02.03.4321", commune: "Río Negro" },
      departure: { date: "2026-07-21", time: "08:30" },
      expectedArrival: { date: "2026-07-21", time: "10:15" },
      transport: { carrierName: "Transportes del Sur", vehiclePlate: "ABCD12" },
      animals: Array.from({ length: 45 }, (_, index) => ({
        diio: String(100_000_001 + index),
        speciesLabel: "Bovinos",
        categoryLabel: index % 2 === 0 ? "Vaca" : "Vaquilla",
      })),
    },
  };
}

function deaProjection() {
  return {
    metadata: {
      documentId: "dea-demo-2026",
      kind: "DEA",
      revision: 1,
      generatedAt: "2026-07-21T12:00:00.000Z",
      formVersion: "2025-03-05",
      fakeData: true,
    },
    content: {
      organizationId: "org-a",
      fieldId: "field-a",
      period: 2026,
      asOfDate: "2026-06-30",
      establishment: { rup: "DEMO-EJEMPLO", holderName: "Titular Ficticio", commune: "Osorno", address: "Dirección ficticia" },
      rows: [
        { speciesLabel: "Bovinos", categoryLabel: "Vacas", quantity: 46 },
        { speciesLabel: "Bovinos", categoryLabel: "Vaquillas", quantity: 18 },
      ],
      totalAnimals: 64,
    },
  };
}
