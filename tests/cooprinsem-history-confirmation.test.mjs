import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildCooprinsemHistoryWorkset,
  COOPRINSEM_MILK_UNIT_CONTRACT_VERSION,
} from "../src/modules/integraciones/cooprinsem/server/history-projection-rules.mjs";

const repository = readFileSync(new URL("../src/modules/integraciones/cooprinsem/server/configuration-repository.ts", import.meta.url), "utf8");
const route = readFileSync(new URL("../app/api/integraciones/cooprinsem/configuracion/route.ts", import.meta.url), "utf8");
const workspace = readFileSync(new URL("../src/modules/integraciones/cooprinsem/CooprinsemConfigurationWorkspace.tsx", import.meta.url), "utf8");
const schema = readFileSync(new URL("../db/schema.ts", import.meta.url), "utf8");

test("deduplica procedencias de cubiertas y mantiene separados los conflictos", () => {
  const workset = buildCooprinsemHistoryWorkset([
    {
      animalId: "animal-1", importJobId: "job-1", importRowId: "row-1", sourceTable: "PreDetimp.dbf", sourceKey: "A",
      record: { FCONTROL: "2026-07-10", FECCUBANT: "2026-06-10", NOMTORO2: " toro-7 " },
    },
    {
      animalId: "animal-1", importJobId: "job-2", importRowId: "row-2", sourceTable: "_Traspasos.DBF", sourceKey: "B",
      record: { FCONTROL: "2026-07-10", FECULTCUB: "2026-06-10", NOMTORO: "TORO-7" },
    },
    {
      animalId: "animal-2", importJobId: "job-3", importRowId: "row-3", sourceTable: "PreDetimp.dbf", sourceKey: "C",
      record: { FCONTROL: "2026-07-10", FECCUBANT: "2026-06-09", NOMTORO2: "TORO-A", FECULTCUB: "2026-06-09", NOMTORO: "TORO-B" },
    },
  ], { milkUnitContractVersion: COOPRINSEM_MILK_UNIT_CONTRACT_VERSION });
  assert.equal(workset.reproductiveServices.length, 2);
  assert.equal(workset.reproductiveServices[0].state, "ready");
  assert.equal(workset.reproductiveServices[0].sources.length, 2);
  assert.deepEqual(workset.reproductiveServices[0].roles, ["latest_service", "previous_month_service"]);
  assert.equal(workset.reproductiveServices[1].state, "blocked");
  assert.match(workset.reproductiveServices[1].blockers.join(" "), /reproductores distintos/);
});

test("el contrato append-only exige litros, evidencia SHA-256 y una versión por fundo", () => {
  const db = migratedDatabase();
  db.exec("INSERT INTO organizations (id, name) VALUES ('org-1', 'Organización')");
  db.exec("INSERT INTO fields (id, organization_id, name) VALUES ('field-1', 'org-1', 'Fundo')");
  const insert = db.prepare(`
    INSERT INTO cooprinsem_history_unit_contracts (
      id, organization_id, field_id, source_system, contract_version, canonical_unit,
      source_fields, evidence_sha256, confirmed_by, confirmed_at
    ) VALUES (?, 'org-1', 'field-1', 'cooprinsem', ?, ?, '["LECHE"]', ?, 'owner@example.com', '2026-07-19T00:00:00.000Z')
  `);
  insert.run("contract-1", COOPRINSEM_MILK_UNIT_CONTRACT_VERSION, "liters", "a".repeat(64));
  assert.throws(() => insert.run("contract-2", COOPRINSEM_MILK_UNIT_CONTRACT_VERSION, "liters", "b".repeat(64)), /UNIQUE/);
  assert.throws(() => insert.run("contract-3", "future.v2", "kilograms", "c".repeat(64)), /CHECK/);
  assert.throws(() => insert.run("contract-4", "future.v2", "liters", "short"), /CHECK/);
  assert.throws(() => insert.run("contract-5", "future.v2", "liters", "z".repeat(64)), /CHECK/);
  assert.throws(() => db.exec("UPDATE cooprinsem_history_unit_contracts SET confirmed_by = 'other@example.com' WHERE id = 'contract-1'"), /append_only/);
  assert.throws(() => db.exec("DELETE FROM cooprinsem_history_unit_contracts WHERE id = 'contract-1'"), /append_only/);
  db.close();
});

test("la confirmación productiva se revalida, enlaza procedencias e impide escribir leche", () => {
  assert.match(route, /authorizeApiAccess\("manage_imports"\)/);
  assert.match(route, /confirm_history_milk_unit_contract/);
  assert.match(route, /confirm_history_services/);
  assert.match(route, /actorEmail: access\.email/);
  assert.match(route, /fieldIds: access\.fieldIds/);
  assert.match(route, /membershipId: access\.membershipId/);
  assert.match(route, /organizationId: access\.organizationId/);
  assert.match(repository, /LECHE\*=LITROS/);
  assert.match(repository, /CONFIRMAR CUBIERTAS/);
  assert.match(repository, /const evidenceSha256 = confirmationDigest\(plan\.confirmationToken\)/);
  assert.match(repository, /\^\[a-f0-9\]\{64\}\$/);
  assert.doesNotMatch(repository, /INSERT OR IGNORE INTO cooprinsem_history_unit_contracts/);
  assert.match(repository, /INSERT INTO cooprinsem_history_unit_contracts[\s\S]+current_field\.organization_id/);
  assert.match(repository, /import\.history\.milk_unit\.confirmed[\s\S]+WHERE changes\(\) = 1/);
  assert.match(repository, /insertContract, insertAudit, assertComplete/);
  assert.match(repository, /created_contract\.confirmed_by = \?/);
  assert.match(repository, /integer overflow/);
  assert.match(repository, /buildConfirmationToken\("history-services"/);
  assert.match(repository, /FROM json_each\(\?\) AS invalid_service/);
  assert.match(repository, /current_event\.updated_at = json_extract/);
  assert.match(repository, /sourceGuards, createEvents, linkReusedEvents, serviceAudits, assertComplete/);
  assert.match(repository, /integer overflow/);
  assert.match(repository, /target_entity, target_id/);
  assert.match(repository, /import\.history\.service\.(?:created|reused)/);
  assert.match(repository, /historySourceRecordId/);
  assert.match(repository, /eq\(cooprinsemHistoryUnitContracts\.organizationId, scope\.organizationId\)/);
  assert.match(repository, /eq\(importJobs\.organizationId, scope\.organizationId\)/);
  assert.doesNotMatch(repository, /INSERT(?: OR IGNORE)? INTO livestock_milk_controls/);
  assert.match(schema, /cooprinsem_history_unit_contracts/);
  assert.match(workspace, /Dos confirmaciones independientes/);
  assert.match(workspace, /los controles lecheros todavía no se escriben/);
});

test("cada sentencia raw de configuración prepara contra el baseline público", () => {
  const db = migratedDatabase();
  const statements = [...repository.matchAll(/client\.prepare\(`([\s\S]*?)`\)/g)]
    .map((match) => match[1]
      .replaceAll("${actorGuard.sql}", "1 = 1")
      .replaceAll("${guard.sql}", "1 = 1"));
  assert.ok(statements.length >= 13);
  for (const sql of statements) db.prepare(sql);
  db.close();
});

function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrationDirectory).filter((entry) => entry.endsWith(".sql")).sort()) {
    db.exec(readFileSync(new URL(name, migrationDirectory), "utf8").replaceAll("--> statement-breakpoint", ""));
  }
  return db;
}
