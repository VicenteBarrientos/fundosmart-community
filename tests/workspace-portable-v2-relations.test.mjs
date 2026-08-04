import assert from "node:assert/strict";
import test from "node:test";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as databaseSchema from "../db/schema.ts";
import {
  PortableWorkspaceV2Error,
  createPortableWorkspaceV2,
  emptyPortableWorkspaceV2Sections,
} from "../src/core/portability/workspace-portable-v2.mjs";
import {
  PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS,
} from "../src/core/portability/workspace-portable-v2-projections.mjs";

const ACTOR_PSEUDONYM = `identity-sha256:${"a".repeat(64)}`;
const SOURCE_SENTINEL_SECTIONS = new Set([
  "livestock_births",
  "livestock_health_events",
  "livestock_lactations",
  "livestock_milk_controls",
  "livestock_reproductive_events",
]);
const tableConfigs = schemaTableConfigs();

test("rechaza import_jobs fuera del perfil Cooprinsem", async () => {
  const sections = baseSections(["field-a"]);
  sections.import_jobs = [rowFor("import_jobs", {
    id: "job-survet",
    organization_id: "org-1",
    field_id: "field-a",
    source_system: "survet",
  })];

  await rejectsCode(sections, ["field-a"], "FILTER_MISMATCH");
});

test("last_operation debe pertenecer al landmark exacto, no sólo al fundo", async () => {
  const sections = baseSections(["field-a"]);
  sections.field_landmark_operations = [
    rowFor("field_landmark_operations", {
      id: "operation-a",
      organization_id: "org-1",
      field_id: "field-a",
      landmark_id: "landmark-a",
    }),
    rowFor("field_landmark_operations", {
      id: "operation-b",
      organization_id: "org-1",
      field_id: "field-a",
      landmark_id: "landmark-b",
    }),
  ];
  sections.field_landmarks = [
    rowFor("field_landmarks", {
      id: "landmark-a",
      field_id: "field-a",
      last_operation_id: "operation-b",
    }),
    rowFor("field_landmarks", {
      id: "landmark-b",
      field_id: "field-a",
      last_operation_id: "operation-b",
    }),
  ];

  await rejectsCode(sections, ["field-a"], "CROSS_SCOPE_REFERENCE");
});

test("un control lechero no puede usar la lactancia de otro animal", async () => {
  const sections = baseSections(["field-a"]);
  sections.livestock_lots = [rowFor("livestock_lots", {
    id: "lot-a",
    field_id: "field-a",
  })];
  sections.livestock_animals = [
    rowFor("livestock_animals", { id: "animal-a", lot_id: "lot-a" }),
    rowFor("livestock_animals", { id: "animal-b", lot_id: "lot-a" }),
  ];
  sections.livestock_lactations = [rowFor("livestock_lactations", {
    id: "lactation-b",
    field_id: "field-a",
    animal_id: "animal-b",
    sequence_number: 1,
  })];
  sections.livestock_milk_controls = [rowFor("livestock_milk_controls", {
    id: "control-a",
    field_id: "field-a",
    animal_id: "animal-a",
    lactation_id: "lactation-b",
  })];

  await rejectsCode(sections, ["field-a"], "CROSS_SCOPE_REFERENCE");
});

for (const scenario of [
  {
    name: "animal de la madre",
    event: { animal_id: "animal-b" },
  },
  {
    name: "tipo calving",
    event: { event_type: "heat" },
  },
  {
    name: "fecha del parto",
    event: { occurred_at: "2026-07-28T12:00:00.000Z" },
  },
]) {
  test(`un parto exige el mismo ${scenario.name} en su evento reproductivo`, async () => {
    const sections = baseSections(["field-a"]);
    sections.livestock_lots = [rowFor("livestock_lots", {
      id: "lot-a",
      field_id: "field-a",
    })];
    sections.livestock_animals = [
      rowFor("livestock_animals", { id: "animal-a", lot_id: "lot-a" }),
      rowFor("livestock_animals", { id: "animal-b", lot_id: "lot-a" }),
    ];
    sections.livestock_reproductive_events = [
      rowFor("livestock_reproductive_events", {
        id: "event-a",
        field_id: "field-a",
        animal_id: "animal-a",
        event_type: "calving",
        occurred_at: "2026-07-29T12:00:00.000Z",
        ...scenario.event,
      }),
    ];
    sections.livestock_births = [rowFor("livestock_births", {
      id: "birth-a",
      field_id: "field-a",
      dam_animal_id: "animal-a",
      reproductive_event_id: "event-a",
      occurred_at: "2026-07-29T12:00:00.000Z",
    })];

    await rejectsCode(sections, ["field-a"], "CROSS_SCOPE_REFERENCE");
  });
}

test("source_records liga job, source_system, source_table y target al mismo fundo", async () => {
  const sections = baseSections(["field-a", "field-b"]);
  sections.livestock_lots = [rowFor("livestock_lots", {
    id: "lot-b",
    field_id: "field-b",
  })];
  sections.livestock_animals = [rowFor("livestock_animals", {
    id: "animal-b",
    lot_id: "lot-b",
  })];
  sections.import_jobs = [rowFor("import_jobs", {
    id: "job-a",
    organization_id: "org-1",
    field_id: "field-a",
    source_system: "cooprinsem",
    source_table: "job-table",
  })];
  sections.import_rows = [rowFor("import_rows", {
    id: "row-a",
    import_job_id: "job-a",
    record_number: 1,
  })];
  sections.source_records = [rowFor("source_records", {
    id: "source-a",
    import_job_id: "job-a",
    import_row_id: "row-a",
    source_system: "cooprinsem",
    source_table: "source-table",
    target_entity: "livestock_animal",
    target_id: "animal-b",
  })];

  await rejectsCode(
    sections,
    ["field-a", "field-b"],
    "CROSS_SCOPE_REFERENCE",
  );
});

test("audit import_job debe declarar el fundo exacto del job", async () => {
  const sections = baseSections(["field-a", "field-b"]);
  sections.import_jobs = [rowFor("import_jobs", {
    id: "job-a",
    organization_id: "org-1",
    field_id: "field-a",
    source_system: "cooprinsem",
  })];
  sections.audit_log = [rowFor("audit_log", {
    id: "audit-a",
    organization_id: "org-1",
    field_id: "field-b",
    entity_type: "import_job",
    entity_id: "job-a",
  })];

  await rejectsCode(
    sections,
    ["field-a", "field-b"],
    "CROSS_SCOPE_REFERENCE",
  );
});

function baseSections(fieldIds) {
  const sections = emptyPortableWorkspaceV2Sections();
  sections.fields = fieldIds.map((fieldId) => rowFor("fields", {
    id: fieldId,
    organization_id: "org-1",
    is_demo: 0,
  }));
  return sections;
}

function rowFor(section, overrides) {
  const descriptor = PORTABLE_WORKSPACE_V2_ROW_PROJECTIONS[section];
  const config = tableConfigs.get(section);
  assert.ok(descriptor, section);
  assert.ok(config, section);
  const columns = new Map(config.columns.map((column) => [column.name, column]));
  const row = Object.fromEntries(descriptor.columns.map((name) => {
    if (Object.hasOwn(overrides, name)) return [name, overrides[name]];
    const column = columns.get(name);
    assert.ok(column, `${section}.${name}`);
    if (!column.notNull) return [name, null];
    if (descriptor.booleanColumns.includes(name)) return [name, 0];
    if (descriptor.jsonColumns.known.includes(name)) return [name, "{}"];
    if (column.dataType === "number") return [name, 0];
    return [name, `${section}-${name}`];
  }));
  if (SOURCE_SENTINEL_SECTIONS.has(section)) {
    row.__scope_source_record_valid = 1;
  }
  return row;
}

function schemaTableConfigs() {
  const configs = new Map();
  for (const candidate of Object.values(databaseSchema)) {
    try {
      const config = getTableConfig(candidate);
      if (config?.name) configs.set(config.name, config);
    } catch {
      // Los demás exports del módulo no son tablas.
    }
  }
  return configs;
}

async function rejectsCode(sections, fieldIds, code) {
  await assert.rejects(
    () => createPortableWorkspaceV2({
      generatedAt: "2026-07-29T12:00:00.000Z",
      generatedBy: ACTOR_PSEUDONYM,
      organization: { id: "org-1", name: "Organización Uno" },
      fieldIds,
      sections,
    }),
    (error) => {
      assert.ok(error instanceof PortableWorkspaceV2Error);
      assert.equal(error.code, code);
      return true;
    },
  );
}
