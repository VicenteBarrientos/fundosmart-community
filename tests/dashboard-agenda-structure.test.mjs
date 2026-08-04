import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const files = {
  route: "app/api/agenda/route.ts",
  page: "app/(producto)/dashboard/page.tsx",
  ui: "src/modules/dashboard/DashboardPage.tsx",
  repository: "src/modules/dashboard/agenda-repository.ts",
  agronomicRepository: "src/modules/dashboard/agronomic-agenda-repository.ts",
  migration: "drizzle/0000_public_schema.sql",
};

test("agenda API keeps same-origin, capability and post-write authorization barriers", async () => {
  const source = await readFile(files.route, "utf8");
  assert.match(source, /isSameOriginAgendaMutation\(request\)/u);
  assert.match(source, /authorizeApiAccess\("operate", mutation\.fieldId\)/u);
  assert.match(source, /mutateAgendaTask\(\{ actor: access, mutation \}\)/u);
  assert.match(source, /reauthorizeApiAccess\(\s*access,\s*"operate",\s*mutation\.fieldId/u);
  assert.match(source, /privateAgendaJson/u);
});

test("dashboard loads the scoped management snapshot and never stores task state locally", async () => {
  const [page, ui] = await Promise.all([
    readFile(files.page, "utf8"),
    readFile(files.ui, "utf8"),
  ]);
  assert.match(page, /listAgendaManagement\(access\)/u);
  assert.match(page, /listAgronomicAgendaSignals\(access\)/u);
  assert.match(page, /canManageAgenda=\{canManageAgenda\}/u);
  assert.match(ui, /applyAgendaTaskStates/u);
  assert.match(ui, /persistAgendaTaskMutation/u);
  assert.match(ui, /Pendientes/u);
  assert.match(ui, /Pospuestas/u);
  assert.match(ui, /Cerradas/u);
  assert.match(ui, /Mis tareas/u);
  assert.match(ui, /status === "postponed"\) return item\.agendaView === "postponed"/u);
  assert.doesNotMatch(ui, /localStorage|sessionStorage/u);
});

test("agronomic agenda signals require confirmed imports and active scoped paddocks", async () => {
  const source = await readFile(files.agronomicRepository, "utf8");
  assert.match(source, /import_job\.status IN \('completed', 'completed_with_errors'\)/u);
  assert.match(source, /import_job\.confirmed_at IS NOT NULL/u);
  assert.match(source, /paddock\.deleted_at IS NULL/u);
  assert.match(source, /paddock\.archived_at IS NULL/u);
  assert.match(source, /recommendation\.organization_id = \?/u);
  assert.match(source, /recommendation\.field_id IN/u);
});

test("repository revalidates actor and assignee in the same D1 batch", async () => {
  const source = await readFile(files.repository, "utf8");
  assert.match(source, /current_actor\.status = 'active'/u);
  assert.match(source, /current_actor\.role IN \('owner', 'admin', 'manager', 'operator'\)/u);
  assert.match(source, /current_assignee\.status = 'active'/u);
  assert.match(source, /client\.batch\(\[/u);
  assert.match(source, /agenda_task_operations/u);
  assert.match(source, /agenda_task_events/u);
});

test("migration preserves lifecycle and append-only audit invariants", async () => {
  const source = (await Promise.all([
    readFile(files.migration, "utf8"),
    readFile("drizzle/0001_public_invariants.sql", "utf8"),
  ])).join("\n");
  for (const table of [
    "agenda_task_states",
    "agenda_task_operations",
    "agenda_task_events",
  ]) {
    assert.ok(source.includes(`CREATE TABLE \`${table}\``));
  }
  assert.match(source, /agenda_task_states_identity_immutable/u);
  assert.match(source, /agenda_task_states_lifecycle_versioned/u);
  assert.match(source, /agenda_task_states_no_delete/u);
  assert.match(source, /agenda_task_operations_no_update/u);
  assert.match(source, /agenda_task_events_no_delete/u);
});
