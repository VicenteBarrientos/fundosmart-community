export const PORTABLE_WORKSPACE_V2_FORMAT = "fundosmart.portable-workspace.v2";
export const PORTABLE_WORKSPACE_V2_CONTRACT_VERSION = 1;
export const PORTABLE_WORKSPACE_V2_SCHEMA_VERSION =
  "fundosmart.d1-104+r2-6.2026-07-29";
export const PORTABLE_WORKSPACE_V2_POLICY_VERSION = "2026-07-29.rows-1";
export const PORTABLE_WORKSPACE_V2_ROWS_ENABLED = true;

const DISPOSITION_BY_EXPORT_CODE = Object.freeze({
  X0: "excluded_control",
  X1: "projection_required",
  X2: "subject_download",
  X3: "pending_projection",
  X4: "reconstructible",
  X5: "aggregate_only",
});

const D1_EXPORT_CODES = Object.freeze({
  account_closure_requests: "X2",
  auth_identities: "X2",
  auth_sessions: "X0",
  auth_oauth_attempts: "X0",
  platform_staff_principals: "X0",
  platform_staff_capability_grants: "X0",
  platform_staff_bootstrap_claims: "X0",
  platform_staff_elevations: "X0",
  platform_staff_events: "X0",
  organizations: "X2",
  fields: "X1",
  organization_memberships: "X2",
  membership_field_access: "X2",
  organization_access_bootstrap: "X0",
  app_state: "X0",
  organization_feature_flags: "X3",
  organization_ai_configs: "X3",
  sync_mutations: "X3",
  domain_events: "X3",
  scheduled_jobs: "X0",
  paddock_operations: "X3",
  potreros: "X1",
  paddock_ndvi: "X1",
  paddock_lineage_edges: "X3",
  activities: "X1",
  subdivision_drafts: "X1",
  paddock_subdivision_drafts: "X3",
  livestock_lots: "X1",
  paddock_cell_operations: "X1",
  paddock_cells: "X1",
  paddock_rotation_settings: "X1",
  paddock_rotation_setting_operations: "X1",
  field_landmark_operations: "X1",
  field_landmarks: "X1",
  paddock_operation_lot_moves: "X3",
  livestock_animals: "X1",
  livestock_weighings: "X1",
  livestock_partners: "X1",
  livestock_contributions: "X3",
  livestock_expenses: "X1",
  milk_settlements: "X1",
  livestock_feeding_plans: "X1",
  livestock_feed_inventory: "X3",
  livestock_feed_consumptions: "X3",
  livestock_notification_preferences: "X2",
  livestock_notification_deliveries: "X0",
  import_jobs: "X1",
  import_job_specs: "X3",
  inbox_addresses: "X2",
  inbox_sender_whitelists: "X2",
  inbox_quarantine: "X3",
  inbox_incoming_messages: "X3",
  livestock_sale_documents: "X3",
  livestock_sale_document_links: "X3",
  field_visits: "X3",
  original_integrity_sweep_states: "X0",
  original_integrity_incidents: "X3",
  restore_confirmation_tokens: "X0",
  restore_recovery_jobs: "X0",
  restore_recovery_objects: "X0",
  restore_recovery_events: "X3",
  import_rows: "X1",
  import_errors: "X1",
  source_records: "X1",
  field_visit_paddocks: "X3",
  field_visit_recommendations: "X3",
  soil_analysis_reports: "X3",
  soil_analysis_results: "X3",
  cooprinsem_history_unit_contracts: "X3",
  milk_bulk_production: "X3",
  milk_quality_samples: "X3",
  pabco_compliance_items: "X3",
  pabco_evidence_documents: "X2",
  livestock_lactations: "X1",
  livestock_milk_controls: "X1",
  livestock_reproductive_events: "X1",
  livestock_births: "X1",
  livestock_birth_offspring: "X1",
  livestock_health_events: "X1",
  field_external_identifiers: "X1",
  livestock_lot_external_identifiers: "X1",
  livestock_animal_identifiers: "X1",
  livestock_lot_memberships: "X1",
  traceability_establishments: "X3",
  traceability_diios: "X3",
  traceability_movements: "X3",
  traceability_movement_items: "X3",
  traceability_declarations: "X3",
  traceability_import_stages: "X0",
  traceability_events: "X3",
  pasture_provider_decisions: "X3",
  pasture_ndvi_calibrations: "X3",
  pasture_raw_observations: "X3",
  pasture_biomass_estimates: "X4",
  pasture_rotation_plans: "X3",
  benchmark_consents: "X2",
  benchmark_field_profiles: "X3",
  benchmark_aggregates: "X5",
  benchmark_positions: "X0",
  analytics_threshold_revisions: "X3",
  analytics_projection_runs: "X4",
  analytics_herd_metrics: "X4",
  analytics_alert_evaluations: "X3",
  agenda_task_states: "X3",
  agenda_task_operations: "X3",
  agenda_task_events: "X3",
  product_feedback: "X2",
  product_feedback_events: "X2",
  audit_log: "X1",
  legal_acceptances: "X2",
  personal_data_events: "X2",
});

const R2_EXPORT_CODES = Object.freeze({
  "R2:import-originals": "X2",
  "R2:offline-attachments": "X3",
  "R2:pabco-evidence": "X2",
  "R2:pasture-raw": "X3",
  "R2:traceability-documents": "X2",
  "R2:isolated-recovery-disabled": "X0",
});

export const PORTABLE_WORKSPACE_V2_D1_POLICY = buildPolicy(D1_EXPORT_CODES);
export const PORTABLE_WORKSPACE_V2_R2_POLICY = buildPolicy(R2_EXPORT_CODES);
export const PORTABLE_WORKSPACE_V2_SECTION_CANDIDATES = Object.freeze(
  policyNames(PORTABLE_WORKSPACE_V2_D1_POLICY, "projection_required"),
);
export const PORTABLE_WORKSPACE_V2_POLICY = deepFreeze({
  version: PORTABLE_WORKSPACE_V2_POLICY_VERSION,
  d1: policyGroups(PORTABLE_WORKSPACE_V2_D1_POLICY),
  r2: policyGroups(PORTABLE_WORKSPACE_V2_R2_POLICY),
});

function buildPolicy(exportCodes) {
  return deepFreeze(Object.fromEntries(
    Object.entries(exportCodes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, exportCode]) => [
        name,
        { exportCode, disposition: DISPOSITION_BY_EXPORT_CODE[exportCode] },
      ]),
  ));
}

function policyGroups(policy) {
  return deepFreeze({
    excludedControl: policyNames(policy, "excluded_control"),
    projectionRequired: policyNames(policy, "projection_required"),
    subjectDownload: policyNames(policy, "subject_download"),
    pendingProjection: policyNames(policy, "pending_projection"),
    reconstructible: policyNames(policy, "reconstructible"),
    aggregateOnly: policyNames(policy, "aggregate_only"),
  });
}

function policyNames(policy, disposition) {
  return Object.entries(policy)
    .filter(([, decision]) => decision.disposition === disposition)
    .map(([name]) => name)
    .sort();
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
