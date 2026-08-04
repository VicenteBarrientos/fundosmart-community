import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, test } from "node:test";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
let db;

beforeEach(() => {
  db?.close();
  db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of readdirSync(path.join(process.cwd(), "drizzle")).filter((entry) => /^\d{4}_.+\.sql$/u.test(entry)).sort()) {
    db.exec(readFileSync(path.join(process.cwd(), "drizzle", name), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  db.exec(`
    INSERT OR IGNORE INTO organizations (id, name) VALUES ('trace-org-a', 'Trace A'), ('trace-org-b', 'Trace B');
    INSERT OR IGNORE INTO fields (id, organization_id, name, location, is_demo, area_hectares, coordinates) VALUES
      ('trace-field-a', 'trace-org-a', 'Trace Field A', 'Osorno', 0, 10, '[]'),
      ('trace-field-b', 'trace-org-b', 'Trace Field B', 'Osorno', 0, 10, '[]');
    INSERT INTO livestock_lots (id, field_id, name, category, animal_count, entry_date, status, tracking_mode)
    VALUES ('trace-lot-a', 'trace-field-a', 'A', 'dairy_cow', 46, '2026-01-01', 'active', 'individual'),
           ('trace-lot-b', 'trace-field-b', 'B', 'dairy_cow', 1, '2026-01-01', 'active', 'individual');
    INSERT INTO traceability_establishments
      (id, organization_id, field_id, rup, normalized_rup, kind, status,
       holder_rut, holder_name, commune, address, created_by)
    VALUES ('est-a', 'trace-org-a', 'trace-field-a', 'RUP-A1', 'RUP-A1', 'dairy', 'active',
            '12.345.678-5', 'Titular A', 'Osorno', 'Camino A', 'owner-a@example.com'),
           ('est-b', 'trace-org-b', 'trace-field-b', 'RUP-B1', 'RUP-B1', 'dairy', 'active',
            '11.111.111-1', 'Titular B', 'Osorno', 'Camino B', 'owner-b@example.com');
  `);
  const insertAnimal = db.prepare(`
    INSERT INTO livestock_animals (id, lot_id, tag, sex, status)
    VALUES (?, ?, ?, 'female', 'active')
  `);
  for (let index = 1; index <= 46; index += 1) {
    insertAnimal.run(`animal-a-${index}`, "trace-lot-a", String(100_000_000 + index));
  }
  insertAnimal.run("animal-b-1", "trace-lot-b", "100000001");
});

test("DIIO identity is tenant-scoped, field-bound and one-active-per-animal", () => {
  insertDiio({ id: "diio-a-1", organizationId: "trace-org-a", fieldId: "trace-field-a", establishmentId: "est-a", animalId: "animal-a-1", number: "100000001" });

  assert.throws(
    () => insertDiio({ id: "diio-a-duplicate-number", organizationId: "trace-org-a", fieldId: "trace-field-a", establishmentId: "est-a", animalId: "animal-a-2", number: "100000001" }),
    /UNIQUE constraint failed/u,
  );
  assert.throws(
    () => insertDiio({ id: "diio-a-duplicate-animal", organizationId: "trace-org-a", fieldId: "trace-field-a", establishmentId: "est-a", animalId: "animal-a-1", number: "100000002" }),
    /UNIQUE constraint failed/u,
  );
  assert.throws(
    () => insertDiio({ id: "diio-cross-scope", organizationId: "trace-org-a", fieldId: "trace-field-a", establishmentId: "est-b", animalId: "animal-a-2", number: "100000002" }),
    /FOREIGN KEY constraint failed/u,
  );

  insertDiio({ id: "diio-b-1", organizationId: "trace-org-b", fieldId: "trace-field-b", establishmentId: "est-b", animalId: "animal-b-1", number: "100000001" });
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM traceability_diios WHERE normalized_number='100000001'").get().count, 2);

  db.prepare(`
    UPDATE traceability_diios
    SET status='lost', ended_at='2026-07-22T00:00:00.000Z', effective_at='2026-07-22T00:00:00.000Z',
        status_reason='Extraviado', last_transition_key='lost-diio-a-1', version=2
    WHERE id='diio-a-1'
  `).run();
  assert.throws(
    () => db.prepare("UPDATE traceability_diios SET status='assigned', version=3 WHERE id='diio-a-1'").run(),
    /invalid traceability DIIO transition/u,
  );
  assert.throws(
    () => db.prepare("DELETE FROM traceability_diios WHERE id='diio-a-1'").run(),
    /lifecycle-only/u,
  );
});

test("FMA rows enforce 45 DIIO and become immutable after document storage", () => {
  for (let index = 1; index <= 46; index += 1) {
    insertDiio({
      id: `diio-a-${index}`,
      organizationId: "trace-org-a",
      fieldId: "trace-field-a",
      establishmentId: "est-a",
      animalId: `animal-a-${index}`,
      number: String(100_000_000 + index),
    });
  }
  db.prepare(`
    INSERT INTO traceability_movements
      (id, organization_id, field_id, establishment_id, origin_rup, destination_rup,
       departure_at, expected_arrival_at, carrier, carrier_rut, vehicle_plate, reason,
       form_version, request_hash, created_by, updated_by)
    VALUES ('movement-a', 'trace-org-a', 'trace-field-a', 'est-a', 'RUP-A1', 'RUP-DEST',
      '2026-07-21T09:00:00.000Z', '2026-07-21T12:00:00.000Z', 'Transportes A', '76543210-3',
      'ABCD12', 'venta', '2024-08-08', ?, 'owner-a@example.com', 'owner-a@example.com')
  `).run(HASH_A);
  const insertItem = db.prepare(`
    INSERT INTO traceability_movement_items
      (id, organization_id, field_id, movement_id, diio_id, animal_id)
    VALUES (?, 'trace-org-a', 'trace-field-a', 'movement-a', ?, ?)
  `);
  for (let index = 1; index <= 45; index += 1) {
    insertItem.run(`item-${index}`, `diio-a-${index}`, `animal-a-${index}`);
  }
  assert.throws(
    () => insertItem.run("item-46", "diio-a-46", "animal-a-46"),
    /at most 45 DIIO/u,
  );

  db.prepare(`
    UPDATE traceability_movements
    SET status='issued', folio='FMA-2026-0001', document_status='stored',
        document_object_key='trazabilidad/trace-org-a/movement-a.pdf', document_sha256=?,
        document_etag='etag-a', document_size_bytes=1024, issued_at='2026-07-21T08:00:00.000Z',
        updated_at='2026-07-21T08:00:00.000Z', version=2
    WHERE id='movement-a'
  `).run(HASH_B);
  assert.throws(() => db.prepare("DELETE FROM traceability_movement_items WHERE id='item-1'").run(), /items are immutable/u);
  assert.throws(() => db.prepare("UPDATE traceability_movements SET destination_rup='RUP-OTHER' WHERE id='movement-a'").run(), /invalid official movement transition|document is immutable/u);
  assert.throws(() => db.prepare("DELETE FROM traceability_movements WHERE id='movement-a'").run(), /cannot be deleted/u);

  db.prepare(`
    UPDATE traceability_movements
    SET status='annulled', annulled_at='2026-07-22T08:00:00.000Z', annulment_reason='Error de destino',
        updated_at='2026-07-22T08:00:00.000Z', version=3
    WHERE id='movement-a'
  `).run();
  assert.throws(() => db.prepare("UPDATE traceability_movements SET annulment_reason='Otro' WHERE id='movement-a'").run(), /invalid official movement transition/u);
});

test("DEA documents and the traceability journal remain immutable", () => {
  insertDiio({ id: "diio-a-1", organizationId: "trace-org-a", fieldId: "trace-field-a", establishmentId: "est-a", animalId: "animal-a-1", number: "100000001" });
  db.prepare(`
    INSERT INTO traceability_declarations
      (id, organization_id, field_id, establishment_id, period, revision, as_of_date, counts,
       total_animals, inventory_hash, request_hash, form_version, created_by, updated_by)
    VALUES ('dea-a', 'trace-org-a', 'trace-field-a', 'est-a', 2026, 1, '2026-06-30',
      '{"bovine":{"cow":46}}', 46, ?, ?, '2025-03-05', 'owner-a@example.com', 'owner-a@example.com')
  `).run(HASH_A, HASH_B);
  db.prepare(`
    UPDATE traceability_declarations
    SET status='declared', folio='DEA-2026-0001', document_status='stored',
        document_object_key='trazabilidad/trace-org-a/dea-a.pdf', document_sha256=?,
        document_etag='etag-dea', document_size_bytes=1024, declared_at='2026-07-21T08:00:00.000Z',
        updated_at='2026-07-21T08:00:00.000Z', version=2
    WHERE id='dea-a'
  `).run(HASH_A);
  assert.throws(() => db.prepare("UPDATE traceability_declarations SET total_animals=45 WHERE id='dea-a'").run(), /invalid official declaration transition|document is immutable/u);
  assert.throws(() => db.prepare("DELETE FROM traceability_declarations WHERE id='dea-a'").run(), /cannot be deleted/u);

  db.exec(`
    INSERT INTO domain_events (id, organization_id, field_id, type, entity, entity_id, payload, actor)
    VALUES ('domain-event-a', 'trace-org-a', 'trace-field-a', 'traceability.diio.assigned', 'traceability_diio', 'diio-a-1', '{}', 'owner-a@example.com');
    INSERT INTO traceability_events
      (id, organization_id, field_id, type, entity_type, entity_id, animal_id, diio_id, payload, domain_event_id, actor)
    VALUES ('trace-event-a', 'trace-org-a', 'trace-field-a', 'diio.assigned', 'traceability_diio', 'diio-a-1',
      'animal-a-1', 'diio-a-1', '{}', 'domain-event-a', 'owner-a@example.com');
  `);
  assert.throws(() => db.prepare("UPDATE traceability_events SET type='changed' WHERE id='trace-event-a'").run(), /append-only/u);
  assert.throws(() => db.prepare("DELETE FROM traceability_events WHERE id='trace-event-a'").run(), /append-only/u);
});

function insertDiio({ id, organizationId, fieldId, establishmentId, animalId, number }) {
  return db.prepare(`
    INSERT INTO traceability_diios
      (id, organization_id, field_id, establishment_id, official_number, normalized_number,
      device_type, animal_id, status, assigned_at, effective_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, 'double_ear_tag', ?, 'assigned', '2026-07-21T00:00:00.000Z', '2026-07-21T00:00:00.000Z', 'owner@example.com')
  `).run(id, organizationId, fieldId, establishmentId, number, number, animalId);
}
