CREATE TABLE `account_closure_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`target_id` text NOT NULL,
	`actor_identity_id` text NOT NULL,
	`request_id` text NOT NULL,
	`status` text NOT NULL,
	`requested_at` text NOT NULL,
	`grace_ends_at` text NOT NULL,
	`revoked_at` text,
	`version` integer NOT NULL,
	`snapshot_version` integer NOT NULL,
	`snapshot_json` text NOT NULL,
	FOREIGN KEY (`actor_identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "account_closure_requests_scope_check" CHECK("account_closure_requests"."scope" IN ('account', 'organization')),
	CONSTRAINT "account_closure_requests_target_check" CHECK(length("account_closure_requests"."target_id") BETWEEN 1 AND 320),
	CONSTRAINT "account_closure_requests_request_check" CHECK(length("account_closure_requests"."request_id") BETWEEN 1 AND 160),
	CONSTRAINT "account_closure_requests_status_check" CHECK("account_closure_requests"."status" IN ('grace', 'revoked')),
	CONSTRAINT "account_closure_requests_time_check" CHECK(datetime("account_closure_requests"."requested_at") IS NOT NULL
        AND datetime("account_closure_requests"."grace_ends_at") IS NOT NULL
        AND "account_closure_requests"."grace_ends_at" > "account_closure_requests"."requested_at"
        AND ("account_closure_requests"."revoked_at" IS NULL OR datetime("account_closure_requests"."revoked_at") IS NOT NULL)),
	CONSTRAINT "account_closure_requests_revocation_check" CHECK(("account_closure_requests"."status" = 'grace' AND "account_closure_requests"."revoked_at" IS NULL AND "account_closure_requests"."version" = 1)
        OR ("account_closure_requests"."status" = 'revoked' AND "account_closure_requests"."revoked_at" IS NOT NULL AND "account_closure_requests"."version" > 1)),
	CONSTRAINT "account_closure_requests_snapshot_version_check" CHECK("account_closure_requests"."snapshot_version" = 1),
	CONSTRAINT "account_closure_requests_snapshot_json_check" CHECK(json_valid("account_closure_requests"."snapshot_json") AND json_type("account_closure_requests"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_closure_requests_actor_request_unique` ON `account_closure_requests` (`actor_identity_id`,`request_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `account_closure_requests_active_target_unique` ON `account_closure_requests` (`scope`,`target_id`) WHERE "account_closure_requests"."status" = 'grace';--> statement-breakpoint
CREATE INDEX `account_closure_requests_target_status_idx` ON `account_closure_requests` (`scope`,`target_id`,`status`);--> statement-breakpoint
CREATE INDEX `account_closure_requests_grace_idx` ON `account_closure_requests` (`status`,`grace_ends_at`);--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`paddock_id` text NOT NULL,
	`type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`description` text NOT NULL,
	`quantity` real,
	`unit` text,
	`cost_clp` real,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `activities_paddock_idx` ON `activities` (`paddock_id`);--> statement-breakpoint
CREATE INDEX `activities_occurred_at_idx` ON `activities` (`occurred_at`);--> statement-breakpoint
CREATE TABLE `agenda_task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`state_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`event_type` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`state_id`) REFERENCES `agenda_task_states`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`operation_id`) REFERENCES `agenda_task_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`actor_membership_id`) REFERENCES `organization_memberships`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agenda_task_events_actor_check" CHECK(length("agenda_task_events"."actor_email") BETWEEN 3 AND 320 AND "agenda_task_events"."actor_email" = lower(trim("agenda_task_events"."actor_email"))),
	CONSTRAINT "agenda_task_events_type_check" CHECK("agenda_task_events"."event_type" IN ('complete', 'postpone', 'dismiss', 'reopen', 'assign')),
	CONSTRAINT "agenda_task_events_before_check" CHECK("agenda_task_events"."before_json" IS NULL OR (
        json_valid("agenda_task_events"."before_json") AND json_type("agenda_task_events"."before_json") = 'object'
      )),
	CONSTRAINT "agenda_task_events_after_check" CHECK(json_valid("agenda_task_events"."after_json") AND json_type("agenda_task_events"."after_json") = 'object'),
	CONSTRAINT "agenda_task_events_time_check" CHECK(datetime("agenda_task_events"."occurred_at") IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agenda_task_events_operation_unique` ON `agenda_task_events` (`operation_id`);--> statement-breakpoint
CREATE INDEX `agenda_task_events_state_time_idx` ON `agenda_task_events` (`state_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `agenda_task_events_scope_time_idx` ON `agenda_task_events` (`organization_id`,`field_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `agenda_task_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`state_id` text NOT NULL,
	`actor_membership_id` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`result_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`state_id`) REFERENCES `agenda_task_states`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`actor_membership_id`) REFERENCES `organization_memberships`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agenda_task_operations_action_check" CHECK("agenda_task_operations"."action" IN ('complete', 'postpone', 'dismiss', 'reopen', 'assign')),
	CONSTRAINT "agenda_task_operations_hash_check" CHECK(length("agenda_task_operations"."request_hash") = 64 AND "agenda_task_operations"."request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "agenda_task_operations_result_check" CHECK(json_valid("agenda_task_operations"."result_json") AND json_type("agenda_task_operations"."result_json") = 'object'),
	CONSTRAINT "agenda_task_operations_time_check" CHECK(datetime("agenda_task_operations"."created_at") IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `agenda_task_operations_scope_time_idx` ON `agenda_task_operations` (`organization_id`,`field_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `agenda_task_states` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`item_key` text NOT NULL,
	`signal_revision` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_membership_id` text,
	`scheduled_for` text,
	`resolution_reason` text,
	`version` integer DEFAULT 1 NOT NULL,
	`last_operation_id` text NOT NULL,
	`created_by_membership_id` text NOT NULL,
	`updated_by_membership_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`assignee_membership_id`) REFERENCES `organization_memberships`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`created_by_membership_id`) REFERENCES `organization_memberships`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`updated_by_membership_id`) REFERENCES `organization_memberships`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agenda_task_states_item_check" CHECK(length("agenda_task_states"."item_key") BETWEEN 1 AND 240),
	CONSTRAINT "agenda_task_states_revision_check" CHECK(length("agenda_task_states"."signal_revision") = 16 AND "agenda_task_states"."signal_revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "agenda_task_states_source_check" CHECK("agenda_task_states"."source" IN ('ganado', 'leche', 'costos', 'potreros', 'dashboard')),
	CONSTRAINT "agenda_task_states_status_check" CHECK("agenda_task_states"."status" IN ('open', 'completed', 'postponed', 'dismissed')),
	CONSTRAINT "agenda_task_states_schedule_check" CHECK("agenda_task_states"."scheduled_for" IS NULL OR (
        length("agenda_task_states"."scheduled_for") = 10
        AND date("agenda_task_states"."scheduled_for") = "agenda_task_states"."scheduled_for"
      )),
	CONSTRAINT "agenda_task_states_reason_check" CHECK("agenda_task_states"."resolution_reason" IS NULL OR length("agenda_task_states"."resolution_reason") BETWEEN 3 AND 500),
	CONSTRAINT "agenda_task_states_lifecycle_check" CHECK(
        (
          "agenda_task_states"."status" = 'open'
          AND "agenda_task_states"."scheduled_for" IS NULL
          AND "agenda_task_states"."resolution_reason" IS NULL
        )
        OR (
          "agenda_task_states"."status" = 'postponed'
          AND "agenda_task_states"."scheduled_for" IS NOT NULL
          AND "agenda_task_states"."resolution_reason" IS NOT NULL
        )
        OR (
          "agenda_task_states"."status" IN ('completed', 'dismissed')
          AND "agenda_task_states"."scheduled_for" IS NULL
          AND "agenda_task_states"."resolution_reason" IS NOT NULL
        )
      ),
	CONSTRAINT "agenda_task_states_version_check" CHECK("agenda_task_states"."version" >= 1),
	CONSTRAINT "agenda_task_states_operation_check" CHECK(
        length("agenda_task_states"."last_operation_id") = 36
        AND "agenda_task_states"."last_operation_id" = lower("agenda_task_states"."last_operation_id")
        AND substr("agenda_task_states"."last_operation_id", 9, 1) = '-'
        AND substr("agenda_task_states"."last_operation_id", 14, 1) = '-'
        AND substr("agenda_task_states"."last_operation_id", 19, 1) = '-'
        AND substr("agenda_task_states"."last_operation_id", 24, 1) = '-'
        AND length(replace("agenda_task_states"."last_operation_id", '-', '')) = 32
        AND replace("agenda_task_states"."last_operation_id", '-', '') NOT GLOB '*[^0-9a-f]*'
        AND substr("agenda_task_states"."last_operation_id", 15, 1) GLOB '[1-5]'
        AND substr("agenda_task_states"."last_operation_id", 20, 1) GLOB '[89ab]'
      ),
	CONSTRAINT "agenda_task_states_timestamp_check" CHECK(
        datetime("agenda_task_states"."created_at") IS NOT NULL
        AND datetime("agenda_task_states"."updated_at") IS NOT NULL
        AND "agenda_task_states"."updated_at" >= "agenda_task_states"."created_at"
      )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agenda_task_states_signal_unique` ON `agenda_task_states` (`organization_id`,`field_id`,`item_key`,`signal_revision`);--> statement-breakpoint
CREATE INDEX `agenda_task_states_scope_status_idx` ON `agenda_task_states` (`organization_id`,`field_id`,`status`,`scheduled_for`);--> statement-breakpoint
CREATE INDEX `agenda_task_states_assignee_status_idx` ON `agenda_task_states` (`organization_id`,`assignee_membership_id`,`status`);--> statement-breakpoint
CREATE TABLE `analytics_alert_evaluations` (
	`id` text PRIMARY KEY NOT NULL,
	`projection_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`code` text NOT NULL,
	`status` text NOT NULL,
	`severity` text NOT NULL,
	`explanation` text NOT NULL,
	`evidence_json` text NOT NULL,
	`threshold_revision` text NOT NULL,
	`thresholds_json` text DEFAULT '{"milkDropPct":-15,"somaticCellHigh":400000,"somaticCellCritical":700000,"mastitisRatePct":5,"pregnancyRatePctMinimum":20,"daysOpenMaximum":150,"calvingIntervalDaysMaximum":420,"averageDailyGainKgMinimum":0,"mortalityRatePctMaximum":3,"discardRatePctMaximum":10,"iofcMinimumClp":0}' NOT NULL,
	`source_revision` text NOT NULL,
	`schema_version` text NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`projection_id`) REFERENCES `analytics_projection_runs`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analytics_alert_evaluations_window_check" CHECK("analytics_alert_evaluations"."window_start" <= "analytics_alert_evaluations"."window_end"),
	CONSTRAINT "analytics_alert_evaluations_status_check" CHECK("analytics_alert_evaluations"."status" IN ('triggered', 'clear', 'unavailable')),
	CONSTRAINT "analytics_alert_evaluations_severity_check" CHECK("analytics_alert_evaluations"."severity" IN ('warning', 'critical')),
	CONSTRAINT "analytics_alert_evaluations_evidence_check" CHECK(json_valid("analytics_alert_evaluations"."evidence_json") AND json_type("analytics_alert_evaluations"."evidence_json") = 'object'),
	CONSTRAINT "analytics_alert_evaluations_threshold_check" CHECK(length(trim("analytics_alert_evaluations"."threshold_revision")) > 0),
	CONSTRAINT "analytics_alert_evaluations_threshold_revision_check" CHECK(length("analytics_alert_evaluations"."threshold_revision") = 64 AND "analytics_alert_evaluations"."threshold_revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "analytics_alert_evaluations_thresholds_check" CHECK(json_valid("analytics_alert_evaluations"."thresholds_json") AND json_type("analytics_alert_evaluations"."thresholds_json") = 'object'),
	CONSTRAINT "analytics_alert_evaluations_revision_check" CHECK(length("analytics_alert_evaluations"."source_revision") = 64 AND "analytics_alert_evaluations"."source_revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "analytics_alert_evaluations_schema_check" CHECK("analytics_alert_evaluations"."schema_version" = 'fundosmart.analytics.projection.v1')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_alert_evaluations_projection_code_unique` ON `analytics_alert_evaluations` (`projection_id`,`code`);--> statement-breakpoint
CREATE INDEX `analytics_alert_evaluations_scope_window_idx` ON `analytics_alert_evaluations` (`organization_id`,`field_id`,`window_start`,`window_end`);--> statement-breakpoint
CREATE TABLE `analytics_herd_metrics` (
	`id` text PRIMARY KEY NOT NULL,
	`projection_id` text NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`period` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`metric_key` text NOT NULL,
	`status` text NOT NULL,
	`status_reason` text,
	`value` real,
	`unit` text NOT NULL,
	`numerator` real,
	`denominator` real,
	`sample_count` integer NOT NULL,
	`method` text NOT NULL,
	`references_json` text NOT NULL,
	`source_revision` text NOT NULL,
	`schema_version` text NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`projection_id`) REFERENCES `analytics_projection_runs`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "analytics_herd_metrics_period_check" CHECK("analytics_herd_metrics"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("analytics_herd_metrics"."period", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "analytics_herd_metrics_window_check" CHECK("analytics_herd_metrics"."window_start" <= "analytics_herd_metrics"."window_end"),
	CONSTRAINT "analytics_herd_metrics_status_check" CHECK("analytics_herd_metrics"."status" IN ('available', 'partial', 'insufficient_data', 'unavailable')),
	CONSTRAINT "analytics_herd_metrics_numbers_check" CHECK(
      ("analytics_herd_metrics"."value" IS NULL OR abs("analytics_herd_metrics"."value") <= 1.0e308)
      AND ("analytics_herd_metrics"."numerator" IS NULL OR abs("analytics_herd_metrics"."numerator") <= 1.0e308)
      AND ("analytics_herd_metrics"."denominator" IS NULL OR abs("analytics_herd_metrics"."denominator") <= 1.0e308)
    ),
	CONSTRAINT "analytics_herd_metrics_sample_check" CHECK("analytics_herd_metrics"."sample_count" >= 0),
	CONSTRAINT "analytics_herd_metrics_references_check" CHECK(json_valid("analytics_herd_metrics"."references_json") AND json_type("analytics_herd_metrics"."references_json") = 'array'),
	CONSTRAINT "analytics_herd_metrics_revision_check" CHECK(length("analytics_herd_metrics"."source_revision") = 64 AND "analytics_herd_metrics"."source_revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "analytics_herd_metrics_schema_check" CHECK("analytics_herd_metrics"."schema_version" = 'fundosmart.analytics.projection.v1')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_herd_metrics_projection_metric_unique` ON `analytics_herd_metrics` (`projection_id`,`metric_key`);--> statement-breakpoint
CREATE INDEX `analytics_herd_metrics_scope_period_idx` ON `analytics_herd_metrics` (`organization_id`,`field_id`,`period`,`metric_key`);--> statement-breakpoint
CREATE TABLE `analytics_projection_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`period` text NOT NULL,
	`window_start` text NOT NULL,
	`window_end` text NOT NULL,
	`comparison_start` text NOT NULL,
	`comparison_end` text NOT NULL,
	`source_revision` text NOT NULL,
	`threshold_revision` text DEFAULT 'b90b053e8c0f99e6cae9a67c56c96c99bd152083bbc0b971158f85ce020a76bf' NOT NULL,
	`thresholds_json` text DEFAULT '{"milkDropPct":-15,"somaticCellHigh":400000,"somaticCellCritical":700000,"mastitisRatePct":5,"pregnancyRatePctMinimum":20,"daysOpenMaximum":150,"calvingIntervalDaysMaximum":420,"averageDailyGainKgMinimum":0,"mortalityRatePctMaximum":3,"discardRatePctMaximum":10,"iofcMinimumClp":0}' NOT NULL,
	`schema_version` text NOT NULL,
	`quality_state` text NOT NULL,
	`quality_issues_json` text NOT NULL,
	`quality_domains_json` text NOT NULL,
	`source_counts_json` text NOT NULL,
	`source_coverage_json` text NOT NULL,
	`computed_at` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "analytics_projection_runs_period_check" CHECK("analytics_projection_runs"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("analytics_projection_runs"."period", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "analytics_projection_runs_window_check" CHECK("analytics_projection_runs"."window_start" <= "analytics_projection_runs"."window_end" AND "analytics_projection_runs"."comparison_start" <= "analytics_projection_runs"."comparison_end"),
	CONSTRAINT "analytics_projection_runs_revision_check" CHECK(length("analytics_projection_runs"."source_revision") = 64 AND "analytics_projection_runs"."source_revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "analytics_projection_runs_threshold_revision_check" CHECK(length("analytics_projection_runs"."threshold_revision") = 64 AND "analytics_projection_runs"."threshold_revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "analytics_projection_runs_thresholds_check" CHECK(json_valid("analytics_projection_runs"."thresholds_json") AND json_type("analytics_projection_runs"."thresholds_json") = 'object'),
	CONSTRAINT "analytics_projection_runs_schema_check" CHECK("analytics_projection_runs"."schema_version" = 'fundosmart.analytics.projection.v1'),
	CONSTRAINT "analytics_projection_runs_quality_check" CHECK("analytics_projection_runs"."quality_state" IN ('available', 'partial', 'unavailable')),
	CONSTRAINT "analytics_projection_runs_json_check" CHECK(
      json_valid("analytics_projection_runs"."quality_issues_json") AND json_type("analytics_projection_runs"."quality_issues_json") = 'array'
      AND json_valid("analytics_projection_runs"."quality_domains_json") AND json_type("analytics_projection_runs"."quality_domains_json") = 'object'
      AND json_valid("analytics_projection_runs"."source_counts_json") AND json_type("analytics_projection_runs"."source_counts_json") = 'object'
      AND json_valid("analytics_projection_runs"."source_coverage_json") AND json_type("analytics_projection_runs"."source_coverage_json") = 'object'
    ),
	CONSTRAINT "analytics_projection_runs_current_check" CHECK("analytics_projection_runs"."is_current" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_projection_runs_scope_id_unique` ON `analytics_projection_runs` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_projection_runs_revision_unique` ON `analytics_projection_runs` (`organization_id`,`field_id`,`window_start`,`window_end`,`source_revision`,`threshold_revision`,`schema_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_projection_runs_current_unique` ON `analytics_projection_runs` (`organization_id`,`field_id`,`window_start`,`window_end`) WHERE "analytics_projection_runs"."is_current" = 1;--> statement-breakpoint
CREATE INDEX `analytics_projection_runs_scope_period_idx` ON `analytics_projection_runs` (`organization_id`,`field_id`,`period`,`computed_at`);--> statement-breakpoint
CREATE TABLE `analytics_threshold_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`revision` text NOT NULL,
	`thresholds_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "analytics_threshold_revisions_revision_check" CHECK(length("analytics_threshold_revisions"."revision") = 64 AND "analytics_threshold_revisions"."revision" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "analytics_threshold_revisions_actor_check" CHECK(length(trim("analytics_threshold_revisions"."created_by")) BETWEEN 1 AND 320),
	CONSTRAINT "analytics_threshold_revisions_current_check" CHECK("analytics_threshold_revisions"."is_current" IN (0, 1)),
	CONSTRAINT "analytics_threshold_revisions_json_check" CHECK(
      json_valid("analytics_threshold_revisions"."thresholds_json") AND json_type("analytics_threshold_revisions"."thresholds_json") = 'object'
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.milkDropPct') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.milkDropPct') BETWEEN -100 AND 0
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.somaticCellHigh') IN ('integer', 'real')
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.somaticCellCritical') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.somaticCellHigh') BETWEEN 0 AND 10000000
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.somaticCellCritical') BETWEEN json_extract("analytics_threshold_revisions"."thresholds_json", '$.somaticCellHigh') AND 10000000
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.mastitisRatePct') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.mastitisRatePct') BETWEEN 0 AND 100
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.pregnancyRatePctMinimum') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.pregnancyRatePctMinimum') BETWEEN 0 AND 100
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.daysOpenMaximum') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.daysOpenMaximum') BETWEEN 0 AND 3650
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.calvingIntervalDaysMaximum') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.calvingIntervalDaysMaximum') BETWEEN 0 AND 3650
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.averageDailyGainKgMinimum') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.averageDailyGainKgMinimum') BETWEEN -100 AND 100
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.mortalityRatePctMaximum') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.mortalityRatePctMaximum') BETWEEN 0 AND 100
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.discardRatePctMaximum') IN ('integer', 'real')
      AND json_extract("analytics_threshold_revisions"."thresholds_json", '$.discardRatePctMaximum') BETWEEN 0 AND 100
      AND json_type("analytics_threshold_revisions"."thresholds_json", '$.iofcMinimumClp') IN ('integer', 'real')
      AND abs(json_extract("analytics_threshold_revisions"."thresholds_json", '$.iofcMinimumClp')) <= 1000000000000
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_threshold_revisions_scope_revision_unique` ON `analytics_threshold_revisions` (`organization_id`,`field_id`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `analytics_threshold_revisions_current_unique` ON `analytics_threshold_revisions` (`organization_id`,`field_id`) WHERE "analytics_threshold_revisions"."is_current" = 1;--> statement-breakpoint
CREATE INDEX `analytics_threshold_revisions_scope_history_idx` ON `analytics_threshold_revisions` (`organization_id`,`field_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`source_record_id` text,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_organization_time_idx` ON `audit_log` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_log_field_time_idx` ON `audit_log` (`field_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `audit_log_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `auth_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`provider_subject` text NOT NULL,
	`email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`display_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "auth_identities_provider_check" CHECK("auth_identities"."provider" = 'google'),
	CONSTRAINT "auth_identities_subject_check" CHECK(length("auth_identities"."provider_subject") BETWEEN 1 AND 255),
	CONSTRAINT "auth_identities_email_check" CHECK(length("auth_identities"."email") BETWEEN 3 AND 320),
	CONSTRAINT "auth_identities_timestamps_check" CHECK("auth_identities"."updated_at" >= "auth_identities"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identities_provider_subject_unique` ON `auth_identities` (`provider`,`provider_subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `auth_identities_normalized_email_unique` ON `auth_identities` (`normalized_email`);--> statement-breakpoint
CREATE TABLE `auth_oauth_attempts` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`nonce` text NOT NULL,
	`code_verifier` text NOT NULL,
	`return_to` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT "auth_oauth_attempts_state_hash_check" CHECK(length("auth_oauth_attempts"."state_hash") = 64),
	CONSTRAINT "auth_oauth_attempts_nonce_check" CHECK(length("auth_oauth_attempts"."nonce") BETWEEN 32 AND 256),
	CONSTRAINT "auth_oauth_attempts_verifier_check" CHECK(length("auth_oauth_attempts"."code_verifier") BETWEEN 43 AND 128),
	CONSTRAINT "auth_oauth_attempts_return_check" CHECK(length("auth_oauth_attempts"."return_to") BETWEEN 1 AND 2048),
	CONSTRAINT "auth_oauth_attempts_expiry_check" CHECK("auth_oauth_attempts"."expires_at" > "auth_oauth_attempts"."created_at")
);
--> statement-breakpoint
CREATE INDEX `auth_oauth_attempts_expiry_idx` ON `auth_oauth_attempts` (`expires_at`);--> statement-breakpoint
CREATE TABLE `auth_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "auth_sessions_token_hash_check" CHECK(length("auth_sessions"."token_hash") = 64),
	CONSTRAINT "auth_sessions_expiry_check" CHECK("auth_sessions"."expires_at" > "auth_sessions"."created_at")
);
--> statement-breakpoint
CREATE INDEX `auth_sessions_identity_idx` ON `auth_sessions` (`identity_id`);--> statement-breakpoint
CREATE INDEX `auth_sessions_expiry_idx` ON `auth_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `benchmark_aggregates` (
	`id` text PRIMARY KEY NOT NULL,
	`cohort_key` text NOT NULL,
	`period` text NOT NULL,
	`zone` text NOT NULL,
	`herd_size_band` text NOT NULL,
	`production_system` text NOT NULL,
	`metric_key` text NOT NULL,
	`unit` text NOT NULL,
	`status` text NOT NULL,
	`participant_count` integer NOT NULL,
	`k_threshold` integer NOT NULL,
	`p10` real,
	`p25` real,
	`p50` real,
	`p75` real,
	`p90` real,
	`schema_version` text NOT NULL,
	`computed_at` text NOT NULL,
	CONSTRAINT "benchmark_aggregates_period_check" CHECK("benchmark_aggregates"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("benchmark_aggregates"."period", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "benchmark_aggregates_cohort_check" CHECK(length(trim("benchmark_aggregates"."cohort_key")) BETWEEN 1 AND 240),
	CONSTRAINT "benchmark_aggregates_zone_check" CHECK("benchmark_aggregates"."zone" IN ('los_lagos', 'los_rios', 'araucania', 'nuble_biobio', 'other_chile')),
	CONSTRAINT "benchmark_aggregates_herd_check" CHECK("benchmark_aggregates"."herd_size_band" IN ('lt_50', '50_99', '100_199', '200_plus')),
	CONSTRAINT "benchmark_aggregates_system_check" CHECK("benchmark_aggregates"."production_system" IN ('pasture', 'mixed', 'confined')),
	CONSTRAINT "benchmark_aggregates_metric_check" CHECK("benchmark_aggregates"."metric_key" IN (
      'milk.volume_liters',
      'milk.production_per_cow_day_liters',
      'milk.somatic_cell_count',
      'reproduction.pregnancy_rate_pct',
      'reproduction.days_open_average',
      'reproduction.calving_interval_days_average',
      'weight.average_daily_gain_kg',
      'health.mastitis_rate_pct',
      'outcomes.mortality_rate_pct',
      'outcomes.discard_rate_pct',
      'finance.iofc_clp',
      'finance.feed_cost_clp',
      'finance.cost_per_liter_clp'
    )),
	CONSTRAINT "benchmark_aggregates_unit_check" CHECK(length(trim("benchmark_aggregates"."unit")) BETWEEN 1 AND 80),
	CONSTRAINT "benchmark_aggregates_status_check" CHECK("benchmark_aggregates"."status" IN ('published', 'suppressed')),
	CONSTRAINT "benchmark_aggregates_counts_check" CHECK("benchmark_aggregates"."participant_count" >= 0 AND "benchmark_aggregates"."k_threshold" BETWEEN 3 AND 50),
	CONSTRAINT "benchmark_aggregates_privacy_check" CHECK(
      (
        "benchmark_aggregates"."status" = 'published'
        AND "benchmark_aggregates"."participant_count" >= "benchmark_aggregates"."k_threshold"
        AND "benchmark_aggregates"."p10" IS NOT NULL AND "benchmark_aggregates"."p25" IS NOT NULL AND "benchmark_aggregates"."p50" IS NOT NULL
        AND "benchmark_aggregates"."p75" IS NOT NULL AND "benchmark_aggregates"."p90" IS NOT NULL
        AND abs("benchmark_aggregates"."p10") <= 1.0e308 AND abs("benchmark_aggregates"."p25") <= 1.0e308
        AND abs("benchmark_aggregates"."p50") <= 1.0e308 AND abs("benchmark_aggregates"."p75") <= 1.0e308 AND abs("benchmark_aggregates"."p90") <= 1.0e308
        AND "benchmark_aggregates"."p10" <= "benchmark_aggregates"."p25" AND "benchmark_aggregates"."p25" <= "benchmark_aggregates"."p50"
        AND "benchmark_aggregates"."p50" <= "benchmark_aggregates"."p75" AND "benchmark_aggregates"."p75" <= "benchmark_aggregates"."p90"
      ) OR (
        "benchmark_aggregates"."status" = 'suppressed'
        AND "benchmark_aggregates"."participant_count" < "benchmark_aggregates"."k_threshold"
        AND "benchmark_aggregates"."p10" IS NULL AND "benchmark_aggregates"."p25" IS NULL AND "benchmark_aggregates"."p50" IS NULL
        AND "benchmark_aggregates"."p75" IS NULL AND "benchmark_aggregates"."p90" IS NULL
      )
    ),
	CONSTRAINT "benchmark_aggregates_schema_check" CHECK("benchmark_aggregates"."schema_version" = 'fundosmart.benchmarking.aggregate.v1')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_aggregates_identity_unique` ON `benchmark_aggregates` (`cohort_key`,`period`,`metric_key`,`schema_version`);--> statement-breakpoint
CREATE INDEX `benchmark_aggregates_period_cohort_metric_idx` ON `benchmark_aggregates` (`period`,`cohort_key`,`metric_key`,`status`);--> statement-breakpoint
CREATE TABLE `benchmark_consents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`status` text NOT NULL,
	`terms_revision` text,
	`consented_by` text NOT NULL,
	`consented_at` text,
	`opted_out_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "benchmark_consents_status_check" CHECK("benchmark_consents"."status" IN ('opted_in', 'opted_out')),
	CONSTRAINT "benchmark_consents_actor_check" CHECK(length(trim("benchmark_consents"."consented_by")) BETWEEN 1 AND 320),
	CONSTRAINT "benchmark_consents_state_check" CHECK(
      (
        "benchmark_consents"."status" = 'opted_in'
        AND "benchmark_consents"."terms_revision" IS NOT NULL
        AND "benchmark_consents"."terms_revision" = 'fundosmart.benchmarking.consent.v1'
        AND "benchmark_consents"."consented_at" IS NOT NULL
        AND "benchmark_consents"."opted_out_at" IS NULL
      ) OR (
        "benchmark_consents"."status" = 'opted_out'
        AND "benchmark_consents"."terms_revision" IS NULL
        AND "benchmark_consents"."consented_at" IS NULL
        AND "benchmark_consents"."opted_out_at" IS NOT NULL
      )
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_consents_organization_unique` ON `benchmark_consents` (`organization_id`);--> statement-breakpoint
CREATE INDEX `benchmark_consents_organization_status_idx` ON `benchmark_consents` (`organization_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE TABLE `benchmark_field_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`zone` text NOT NULL,
	`herd_size_band` text NOT NULL,
	`production_system` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "benchmark_field_profiles_zone_check" CHECK("benchmark_field_profiles"."zone" IN ('los_lagos', 'los_rios', 'araucania', 'nuble_biobio', 'other_chile')),
	CONSTRAINT "benchmark_field_profiles_herd_check" CHECK("benchmark_field_profiles"."herd_size_band" IN ('lt_50', '50_99', '100_199', '200_plus')),
	CONSTRAINT "benchmark_field_profiles_system_check" CHECK("benchmark_field_profiles"."production_system" IN ('pasture', 'mixed', 'confined'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_field_profiles_scope_unique` ON `benchmark_field_profiles` (`organization_id`,`field_id`);--> statement-breakpoint
CREATE INDEX `benchmark_field_profiles_scope_idx` ON `benchmark_field_profiles` (`organization_id`,`field_id`,`updated_at`);--> statement-breakpoint
CREATE TABLE `benchmark_positions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`cohort_key` text NOT NULL,
	`period` text NOT NULL,
	`metric_key` text NOT NULL,
	`unit` text NOT NULL,
	`own_value` real NOT NULL,
	`percentile_rank` real NOT NULL,
	`schema_version` text NOT NULL,
	`computed_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cohort_key`,`period`,`metric_key`,`schema_version`) REFERENCES `benchmark_aggregates`(`cohort_key`,`period`,`metric_key`,`schema_version`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "benchmark_positions_period_check" CHECK("benchmark_positions"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("benchmark_positions"."period", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "benchmark_positions_cohort_check" CHECK(length(trim("benchmark_positions"."cohort_key")) BETWEEN 1 AND 240),
	CONSTRAINT "benchmark_positions_metric_check" CHECK(length(trim("benchmark_positions"."metric_key")) BETWEEN 1 AND 100),
	CONSTRAINT "benchmark_positions_unit_check" CHECK(length(trim("benchmark_positions"."unit")) BETWEEN 1 AND 80),
	CONSTRAINT "benchmark_positions_value_check" CHECK(abs("benchmark_positions"."own_value") <= 1.0e308),
	CONSTRAINT "benchmark_positions_percentile_check" CHECK("benchmark_positions"."percentile_rank" BETWEEN 0 AND 100),
	CONSTRAINT "benchmark_positions_schema_check" CHECK("benchmark_positions"."schema_version" = 'fundosmart.benchmarking.aggregate.v1')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `benchmark_positions_identity_unique` ON `benchmark_positions` (`organization_id`,`field_id`,`period`,`metric_key`,`schema_version`);--> statement-breakpoint
CREATE INDEX `benchmark_positions_scope_period_metric_idx` ON `benchmark_positions` (`organization_id`,`field_id`,`period`,`metric_key`);--> statement-breakpoint
CREATE TABLE `cooprinsem_history_unit_contracts` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`source_system` text DEFAULT 'cooprinsem' NOT NULL,
	`contract_version` text NOT NULL,
	`canonical_unit` text NOT NULL,
	`source_fields` text NOT NULL,
	`evidence_sha256` text NOT NULL,
	`confirmed_by` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cooprinsem_history_unit_contracts_source_check" CHECK("cooprinsem_history_unit_contracts"."source_system" = 'cooprinsem'),
	CONSTRAINT "cooprinsem_history_unit_contracts_unit_check" CHECK("cooprinsem_history_unit_contracts"."canonical_unit" = 'liters'),
	CONSTRAINT "cooprinsem_history_unit_contracts_evidence_check" CHECK(length("cooprinsem_history_unit_contracts"."evidence_sha256") = 64 AND "cooprinsem_history_unit_contracts"."evidence_sha256" NOT GLOB '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cooprinsem_history_unit_contracts_field_version_unique` ON `cooprinsem_history_unit_contracts` (`field_id`,`contract_version`);--> statement-breakpoint
CREATE INDEX `cooprinsem_history_unit_contracts_organization_idx` ON `cooprinsem_history_unit_contracts` (`organization_id`,`confirmed_at`);--> statement-breakpoint
CREATE TABLE `domain_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`type` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload` text NOT NULL,
	`source_mutation_id` text,
	`actor` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_mutation_id`) REFERENCES `sync_mutations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "domain_events_payload_check" CHECK(json_valid("domain_events"."payload") AND json_type("domain_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domain_events_id_unique` ON `domain_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `domain_events_source_mutation_unique` ON `domain_events` (`source_mutation_id`);--> statement-breakpoint
CREATE INDEX `domain_events_scope_cursor_idx` ON `domain_events` (`organization_id`,`field_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `domain_events_entity_cursor_idx` ON `domain_events` (`organization_id`,`field_id`,`entity`,`entity_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `field_external_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`source_system` text DEFAULT 'cooprinsem' NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "field_external_identifiers_validity_check" CHECK("field_external_identifiers"."valid_to" IS NULL OR "field_external_identifiers"."valid_from" IS NULL OR "field_external_identifiers"."valid_to" >= "field_external_identifiers"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_external_identifiers_one_active_unique` ON `field_external_identifiers` (`organization_id`,`source_system`,`kind`,`normalized_value`) WHERE "field_external_identifiers"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX `field_external_identifiers_lookup_idx` ON `field_external_identifiers` (`organization_id`,`source_system`,`kind`,`normalized_value`);--> statement-breakpoint
CREATE INDEX `field_external_identifiers_field_idx` ON `field_external_identifiers` (`field_id`);--> statement-breakpoint
CREATE TABLE `field_landmark_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`landmark_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_version` integer,
	`request` text NOT NULL,
	`result` text NOT NULL,
	`actor` text NOT NULL,
	`committed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "field_landmark_operations_kind_check" CHECK("field_landmark_operations"."kind" IN ('create', 'update', 'delete')),
	CONSTRAINT "field_landmark_operations_version_check" CHECK("field_landmark_operations"."expected_version" IS NULL OR "field_landmark_operations"."expected_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `field_landmark_operations_organization_time_idx` ON `field_landmark_operations` (`organization_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `field_landmark_operations_field_time_idx` ON `field_landmark_operations` (`field_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `field_landmark_operations_landmark_time_idx` ON `field_landmark_operations` (`landmark_id`,`committed_at`);--> statement-breakpoint
CREATE TABLE `field_landmarks` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`kind` text NOT NULL,
	`geometry_type` text NOT NULL,
	`geometry` text NOT NULL,
	`name` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`length_meters` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	`last_operation_id` text NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`last_operation_id`) REFERENCES `field_landmark_operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "field_landmarks_kind_check" CHECK("field_landmarks"."kind" IN ('bebedero', 'porton', 'sala_ordena', 'bodega', 'manga', 'cerco_electrico', 'callejon', 'linea_agua', 'otro')),
	CONSTRAINT "field_landmarks_geometry_type_check" CHECK("field_landmarks"."geometry_type" IN ('point', 'line')),
	CONSTRAINT "field_landmarks_geometry_json_check" CHECK(json_valid("field_landmarks"."geometry") AND json_type("field_landmarks"."geometry") = 'array'),
	CONSTRAINT "field_landmarks_geometry_shape_check" CHECK(("field_landmarks"."geometry_type" = 'point' AND json_array_length("field_landmarks"."geometry") = 1) OR ("field_landmarks"."geometry_type" = 'line' AND json_array_length("field_landmarks"."geometry") BETWEEN 2 AND 2000)),
	CONSTRAINT "field_landmarks_length_check" CHECK(("field_landmarks"."geometry_type" = 'point' AND "field_landmarks"."length_meters" = 0) OR ("field_landmarks"."geometry_type" = 'line' AND "field_landmarks"."length_meters" > 0)),
	CONSTRAINT "field_landmarks_name_check" CHECK(length(trim("field_landmarks"."name")) BETWEEN 1 AND 160),
	CONSTRAINT "field_landmarks_notes_check" CHECK(length("field_landmarks"."notes") <= 2000),
	CONSTRAINT "field_landmarks_deleted_date_check" CHECK("field_landmarks"."deleted_at" IS NULL OR "field_landmarks"."deleted_at" >= "field_landmarks"."created_at"),
	CONSTRAINT "field_landmarks_version_check" CHECK("field_landmarks"."version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `field_landmarks_field_active_idx` ON `field_landmarks` (`field_id`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `field_landmarks_field_kind_active_idx` ON `field_landmarks` (`field_id`,`kind`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `field_landmarks_last_operation_idx` ON `field_landmarks` (`last_operation_id`);--> statement-breakpoint
CREATE TABLE `field_visit_paddocks` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`visit_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`import_row_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`external_paddock_key` text NOT NULL,
	`paddock_id` text,
	`observed_at` text,
	`planned_entry_date` text,
	`current_biomass_kg_dm_ha` real,
	`projected_biomass_kg_dm_ha` real,
	`area_ha` real,
	`daily_area_ha` real,
	`calculated_days` real,
	`adjusted_days` real,
	`adjusted_intake_kg_dm_cow_day` real,
	`notes` text,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visit_id`) REFERENCES `field_visits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_row_id`) REFERENCES `import_rows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`organization_id`,`field_id`,`visit_id`) REFERENCES `field_visits`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_job_id`,`import_row_id`) REFERENCES `import_rows`(`import_job_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`,`paddock_id`) REFERENCES `potreros`(`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "field_visit_paddocks_sequence_check" CHECK("field_visit_paddocks"."sequence_number" > 0),
	CONSTRAINT "field_visit_paddocks_external_key_check" CHECK(length(trim("field_visit_paddocks"."external_paddock_key")) > 0),
	CONSTRAINT "field_visit_paddocks_observed_date_check" CHECK("field_visit_paddocks"."observed_at" IS NULL OR "field_visit_paddocks"."observed_at" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "field_visit_paddocks_planned_date_check" CHECK("field_visit_paddocks"."planned_entry_date" IS NULL OR "field_visit_paddocks"."planned_entry_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "field_visit_paddocks_biomass_check" CHECK(("field_visit_paddocks"."current_biomass_kg_dm_ha" IS NOT NULL AND "field_visit_paddocks"."current_biomass_kg_dm_ha" >= 0) OR ("field_visit_paddocks"."projected_biomass_kg_dm_ha" IS NOT NULL AND "field_visit_paddocks"."projected_biomass_kg_dm_ha" >= 0)),
	CONSTRAINT "field_visit_paddocks_positive_values_check" CHECK(
      ("field_visit_paddocks"."area_ha" IS NULL OR "field_visit_paddocks"."area_ha" > 0)
      AND ("field_visit_paddocks"."daily_area_ha" IS NULL OR "field_visit_paddocks"."daily_area_ha" > 0)
      AND ("field_visit_paddocks"."calculated_days" IS NULL OR "field_visit_paddocks"."calculated_days" > 0)
      AND ("field_visit_paddocks"."adjusted_days" IS NULL OR "field_visit_paddocks"."adjusted_days" > 0)
      AND ("field_visit_paddocks"."adjusted_intake_kg_dm_cow_day" IS NULL OR "field_visit_paddocks"."adjusted_intake_kg_dm_cow_day" > 0)
    ),
	CONSTRAINT "field_visit_paddocks_snapshot_check" CHECK(json_valid("field_visit_paddocks"."snapshot_json") AND json_type("field_visit_paddocks"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_visit_paddocks_visit_sequence_unique` ON `field_visit_paddocks` (`visit_id`,`sequence_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_visit_paddocks_import_row_unique` ON `field_visit_paddocks` (`import_row_id`);--> statement-breakpoint
CREATE INDEX `field_visit_paddocks_field_external_idx` ON `field_visit_paddocks` (`field_id`,`external_paddock_key`,`observed_at`);--> statement-breakpoint
CREATE TABLE `field_visit_recommendations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`visit_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`import_row_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`action_group_number` integer NOT NULL,
	`external_paddock_key` text NOT NULL,
	`paddock_id` text NOT NULL,
	`visit_date` text NOT NULL,
	`action_heading` text NOT NULL,
	`recommendation_text` text NOT NULL,
	`reported_group_area_ha` real,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`visit_id`) REFERENCES `field_visits`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_row_id`) REFERENCES `import_rows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`visit_id`) REFERENCES `field_visits`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_job_id`,`import_row_id`) REFERENCES `import_rows`(`import_job_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`,`paddock_id`) REFERENCES `potreros`(`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "field_visit_recommendations_sequence_check" CHECK("field_visit_recommendations"."sequence_number" > 0 AND "field_visit_recommendations"."action_group_number" > 0),
	CONSTRAINT "field_visit_recommendations_external_key_check" CHECK(length(trim("field_visit_recommendations"."external_paddock_key")) BETWEEN 1 AND 80),
	CONSTRAINT "field_visit_recommendations_visit_date_check" CHECK("field_visit_recommendations"."visit_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "field_visit_recommendations_text_check" CHECK(
      length(trim("field_visit_recommendations"."action_heading")) BETWEEN 3 AND 500
      AND length(trim("field_visit_recommendations"."recommendation_text")) BETWEEN 3 AND 8000
    ),
	CONSTRAINT "field_visit_recommendations_area_check" CHECK("field_visit_recommendations"."reported_group_area_ha" IS NULL OR "field_visit_recommendations"."reported_group_area_ha" > 0),
	CONSTRAINT "field_visit_recommendations_snapshot_check" CHECK(json_valid("field_visit_recommendations"."snapshot_json") AND json_type("field_visit_recommendations"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_visit_recommendations_visit_sequence_unique` ON `field_visit_recommendations` (`visit_id`,`sequence_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_visit_recommendations_import_row_unique` ON `field_visit_recommendations` (`import_row_id`);--> statement-breakpoint
CREATE INDEX `field_visit_recommendations_paddock_date_idx` ON `field_visit_recommendations` (`field_id`,`paddock_id`,`visit_date`);--> statement-breakpoint
CREATE TABLE `field_visits` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`visit_kind` text NOT NULL,
	`provider_key` text NOT NULL,
	`profile_key` text NOT NULL,
	`profile_version` text NOT NULL,
	`visit_date` text NOT NULL,
	`next_visit_date` text,
	`report_generated_at` text,
	`external_producer_name` text,
	`external_producer_code` text,
	`snapshot_json` text NOT NULL,
	`confirmed_by` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`import_job_id`) REFERENCES `import_jobs`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "field_visits_kind_check" CHECK("field_visits"."visit_kind" IN ('technical_visit', 'pasture_measurement_batch')),
	CONSTRAINT "field_visits_provider_check" CHECK(length(trim("field_visits"."provider_key")) > 0),
	CONSTRAINT "field_visits_profile_check" CHECK(length(trim("field_visits"."profile_key")) > 0 AND length(trim("field_visits"."profile_version")) > 0),
	CONSTRAINT "field_visits_visit_date_check" CHECK("field_visits"."visit_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "field_visits_next_date_check" CHECK("field_visits"."next_visit_date" IS NULL OR "field_visits"."next_visit_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "field_visits_snapshot_check" CHECK(json_valid("field_visits"."snapshot_json") AND json_type("field_visits"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `field_visits_import_job_unique` ON `field_visits` (`import_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `field_visits_scope_id_unique` ON `field_visits` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE INDEX `field_visits_field_date_idx` ON `field_visits` (`field_id`,`visit_date`,`confirmed_at`);--> statement-breakpoint
CREATE TABLE `fields` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`location` text DEFAULT '' NOT NULL,
	`is_demo` integer DEFAULT true NOT NULL,
	`area_hectares` real DEFAULT 0 NOT NULL,
	`coordinates` text DEFAULT '[]' NOT NULL,
	`soil_report_filename` text,
	`soil_report_folio` text,
	`soil_sample_id` text,
	`soil_report_date` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `fields_organization_id_unique` ON `fields` (`organization_id`,`id`);--> statement-breakpoint
CREATE TABLE `import_errors` (
	`id` text PRIMARY KEY NOT NULL,
	`import_job_id` text NOT NULL,
	`import_row_id` text NOT NULL,
	`field_name` text,
	`rule_code` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`source_value` text,
	`status` text DEFAULT 'open' NOT NULL,
	`resolution_notes` text,
	`resolved_by` text,
	`resolved_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_row_id`) REFERENCES `import_rows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `import_errors_job_status_idx` ON `import_errors` (`import_job_id`,`status`);--> statement-breakpoint
CREATE INDEX `import_errors_row_idx` ON `import_errors` (`import_row_id`);--> statement-breakpoint
CREATE INDEX `import_errors_rule_idx` ON `import_errors` (`rule_code`);--> statement-breakpoint
CREATE TABLE `import_job_specs` (
	`import_job_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`profile_key` text NOT NULL,
	`profile_version` text NOT NULL,
	`mapping_json` text,
	`document_json` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`field_id`,`import_job_id`) REFERENCES `import_jobs`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "import_job_specs_profile_check" CHECK(length(trim("import_job_specs"."profile_key")) > 0 AND length(trim("import_job_specs"."profile_version")) > 0),
	CONSTRAINT "import_job_specs_mapping_json_check" CHECK("import_job_specs"."mapping_json" IS NULL OR (json_valid("import_job_specs"."mapping_json") AND json_type("import_job_specs"."mapping_json") = 'object')),
	CONSTRAINT "import_job_specs_document_json_check" CHECK(json_valid("import_job_specs"."document_json") AND json_type("import_job_specs"."document_json") = 'object')
);
--> statement-breakpoint
CREATE INDEX `import_job_specs_field_profile_idx` ON `import_job_specs` (`field_id`,`profile_key`,`updated_at`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`source_system` text DEFAULT 'cooprinsem' NOT NULL,
	`source_format` text NOT NULL,
	`source_table` text NOT NULL,
	`original_filename` text NOT NULL,
	`content_type` text,
	`file_size_bytes` integer NOT NULL,
	`object_key` text NOT NULL,
	`sha256` text NOT NULL,
	`mapping_version` text NOT NULL,
	`effective_at` text,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`is_dry_run` integer DEFAULT true NOT NULL,
	`requested_by` text NOT NULL,
	`row_count` integer DEFAULT 0 NOT NULL,
	`valid_row_count` integer DEFAULT 0 NOT NULL,
	`warning_row_count` integer DEFAULT 0 NOT NULL,
	`error_row_count` integer DEFAULT 0 NOT NULL,
	`skipped_row_count` integer DEFAULT 0 NOT NULL,
	`file_issue_count` integer DEFAULT 0 NOT NULL,
	`failure_message` text,
	`started_at` text,
	`previewed_at` text,
	`confirmed_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_idempotency_unique` ON `import_jobs` (`organization_id`,`field_id`,`sha256`,`mapping_version`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_jobs_scope_id_unique` ON `import_jobs` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE INDEX `import_jobs_field_created_idx` ON `import_jobs` (`field_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_jobs_status_idx` ON `import_jobs` (`status`);--> statement-breakpoint
CREATE TABLE `import_rows` (
	`id` text PRIMARY KEY NOT NULL,
	`import_job_id` text NOT NULL,
	`record_number` integer NOT NULL,
	`source_key` text,
	`raw_record` text NOT NULL,
	`normalized_record` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`warning_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `import_rows_job_record_unique` ON `import_rows` (`import_job_id`,`record_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `import_rows_job_id_unique` ON `import_rows` (`import_job_id`,`id`);--> statement-breakpoint
CREATE INDEX `import_rows_job_status_idx` ON `import_rows` (`import_job_id`,`status`);--> statement-breakpoint
CREATE TABLE `inbox_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`address_token` text NOT NULL,
	`email_address` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_email` text NOT NULL,
	`revoked_by_email` text,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_addresses_address_token_unique` ON `inbox_addresses` (`address_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_addresses_email_address_unique` ON `inbox_addresses` (`email_address`);--> statement-breakpoint
CREATE INDEX `inbox_addresses_field_status_idx` ON `inbox_addresses` (`field_id`,`status`);--> statement-breakpoint
CREATE INDEX `inbox_addresses_org_status_idx` ON `inbox_addresses` (`organization_id`,`status`);--> statement-breakpoint
CREATE TABLE `inbox_incoming_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`inbox_address_id` text NOT NULL,
	`message_id` text NOT NULL,
	`attachment_sha256` text NOT NULL,
	`import_job_id` text,
	`sender_email` text NOT NULL,
	`subject` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_address_id`) REFERENCES `inbox_addresses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_incoming_messages_dedupe_unique` ON `inbox_incoming_messages` (`organization_id`,`message_id`,`attachment_sha256`);--> statement-breakpoint
CREATE INDEX `inbox_incoming_messages_field_created_idx` ON `inbox_incoming_messages` (`field_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `inbox_quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`inbox_address_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`subject` text,
	`message_id` text,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'quarantined' NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inbox_address_id`) REFERENCES `inbox_addresses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `inbox_quarantine_org_status_idx` ON `inbox_quarantine` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `inbox_quarantine_field_status_idx` ON `inbox_quarantine` (`field_id`,`status`);--> statement-breakpoint
CREATE TABLE `inbox_sender_whitelists` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`sender_email` text NOT NULL,
	`normalized_sender_email` text NOT NULL,
	`label` text,
	`created_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_sender_whitelists_org_email_unique` ON `inbox_sender_whitelists` (`organization_id`,`normalized_sender_email`);--> statement-breakpoint
CREATE INDEX `inbox_sender_whitelists_org_idx` ON `inbox_sender_whitelists` (`organization_id`);--> statement-breakpoint
CREATE TABLE `legal_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`document_kind` text NOT NULL,
	`document_version` text NOT NULL,
	`document_published_on` text NOT NULL,
	`document_content_sha256` text NOT NULL,
	`accepted_at` text NOT NULL,
	`evidence_version` integer NOT NULL,
	`evidence_json` text NOT NULL,
	`request_id` text NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "legal_acceptances_kind_check" CHECK("legal_acceptances"."document_kind" IN ('privacy', 'terms')),
	CONSTRAINT "legal_acceptances_version_check" CHECK(length("legal_acceptances"."document_version") BETWEEN 1 AND 80),
	CONSTRAINT "legal_acceptances_published_on_check" CHECK(date("legal_acceptances"."document_published_on") IS NOT NULL),
	CONSTRAINT "legal_acceptances_content_hash_check" CHECK(length("legal_acceptances"."document_content_sha256") = 64
        AND "legal_acceptances"."document_content_sha256" NOT GLOB '*[^a-f0-9]*'),
	CONSTRAINT "legal_acceptances_time_check" CHECK(datetime("legal_acceptances"."accepted_at") IS NOT NULL),
	CONSTRAINT "legal_acceptances_evidence_version_check" CHECK("legal_acceptances"."evidence_version" = 1),
	CONSTRAINT "legal_acceptances_evidence_json_check" CHECK(json_valid("legal_acceptances"."evidence_json") AND json_type("legal_acceptances"."evidence_json") = 'object'),
	CONSTRAINT "legal_acceptances_request_check" CHECK(length("legal_acceptances"."request_id") BETWEEN 1 AND 160)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `legal_acceptances_identity_document_unique` ON `legal_acceptances` (`identity_id`,`document_kind`,`document_version`);--> statement-breakpoint
CREATE INDEX `legal_acceptances_identity_time_idx` ON `legal_acceptances` (`identity_id`,`accepted_at`);--> statement-breakpoint
CREATE TABLE `livestock_animal_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`source_system` text DEFAULT 'cooprinsem' NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "livestock_animal_identifiers_validity_check" CHECK("livestock_animal_identifiers"."valid_to" IS NULL OR "livestock_animal_identifiers"."valid_from" IS NULL OR "livestock_animal_identifiers"."valid_to" >= "livestock_animal_identifiers"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_animal_identifiers_one_active_unique` ON `livestock_animal_identifiers` (`field_id`,`source_system`,`kind`,`normalized_value`) WHERE "livestock_animal_identifiers"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX `livestock_animal_identifiers_lookup_idx` ON `livestock_animal_identifiers` (`field_id`,`source_system`,`kind`,`normalized_value`);--> statement-breakpoint
CREATE INDEX `livestock_animal_identifiers_animal_idx` ON `livestock_animal_identifiers` (`animal_id`);--> statement-breakpoint
CREATE TABLE `livestock_animals` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`tag` text NOT NULL,
	`sex` text DEFAULT 'unknown' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`status_date` text,
	`status_reason` text,
	`birth_date` text,
	`purchase_price_clp` integer,
	`purchase_date` text,
	`sale_price_clp` integer,
	`sale_buyer` text,
	`sale_weight_kg` real,
	`origin` text,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "livestock_animals_sale_price_check" CHECK("livestock_animals"."sale_price_clp" IS NULL OR "livestock_animals"."sale_price_clp" >= 0),
	CONSTRAINT "livestock_animals_sale_weight_check" CHECK("livestock_animals"."sale_weight_kg" IS NULL OR "livestock_animals"."sale_weight_kg" > 0)
);
--> statement-breakpoint
CREATE INDEX `livestock_animals_tag_idx` ON `livestock_animals` (`tag`);--> statement-breakpoint
CREATE INDEX `livestock_animals_lot_idx` ON `livestock_animals` (`lot_id`);--> statement-breakpoint
CREATE INDEX `livestock_animals_status_idx` ON `livestock_animals` (`status`);--> statement-breakpoint
CREATE TABLE `livestock_birth_offspring` (
	`id` text PRIMARY KEY NOT NULL,
	`birth_id` text NOT NULL,
	`animal_id` text,
	`temporary_identifier` text NOT NULL,
	`sex` text DEFAULT 'unknown' NOT NULL,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`birth_weight_kg` real,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`birth_id`) REFERENCES `livestock_births`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_birth_offspring_sex_check" CHECK("livestock_birth_offspring"."sex" IN ('female', 'male', 'unknown')),
	CONSTRAINT "livestock_birth_offspring_outcome_check" CHECK("livestock_birth_offspring"."outcome" IN ('alive', 'stillborn', 'deceased', 'unknown')),
	CONSTRAINT "livestock_birth_offspring_weight_check" CHECK("livestock_birth_offspring"."birth_weight_kg" IS NULL OR "livestock_birth_offspring"."birth_weight_kg" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_birth_offspring_identifier_unique` ON `livestock_birth_offspring` (`birth_id`,`temporary_identifier`);--> statement-breakpoint
CREATE INDEX `livestock_birth_offspring_animal_idx` ON `livestock_birth_offspring` (`animal_id`);--> statement-breakpoint
CREATE TABLE `livestock_births` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`dam_animal_id` text NOT NULL,
	`reproductive_event_id` text,
	`occurred_at` text NOT NULL,
	`calving_type` text DEFAULT 'unknown' NOT NULL,
	`difficulty` text DEFAULT 'unknown' NOT NULL,
	`outcome` text DEFAULT 'unknown' NOT NULL,
	`sire_identifier` text,
	`sire_animal_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`source_record_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`dam_animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reproductive_event_id`) REFERENCES `livestock_reproductive_events`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sire_animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_births_calving_type_check" CHECK("livestock_births"."calving_type" IN ('single', 'twin', 'multiple', 'unknown')),
	CONSTRAINT "livestock_births_difficulty_check" CHECK("livestock_births"."difficulty" IN ('unassisted', 'assisted', 'dystocia', 'unknown')),
	CONSTRAINT "livestock_births_outcome_check" CHECK("livestock_births"."outcome" IN ('live', 'mixed', 'stillbirth', 'unknown'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_births_dam_date_unique` ON `livestock_births` (`dam_animal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_births_field_date_idx` ON `livestock_births` (`field_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_births_dam_date_idx` ON `livestock_births` (`dam_animal_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `livestock_contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`partner_id` text NOT NULL,
	`amount_clp` integer NOT NULL,
	`date` text,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`partner_id`) REFERENCES `livestock_partners`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `livestock_contributions_organization_idx` ON `livestock_contributions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `livestock_contributions_partner_idx` ON `livestock_contributions` (`partner_id`);--> statement-breakpoint
CREATE TABLE `livestock_expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text,
	`date` text,
	`description` text NOT NULL,
	`category` text DEFAULT 'otro' NOT NULL,
	`amount_clp` integer NOT NULL,
	`payment_source` text DEFAULT 'unassigned' NOT NULL,
	`paid_by_id` text,
	`lot_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`paid_by_id`) REFERENCES `livestock_partners`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `livestock_expenses_organization_idx` ON `livestock_expenses` (`organization_id`);--> statement-breakpoint
CREATE INDEX `livestock_expenses_field_idx` ON `livestock_expenses` (`field_id`);--> statement-breakpoint
CREATE INDEX `livestock_expenses_category_idx` ON `livestock_expenses` (`category`);--> statement-breakpoint
CREATE INDEX `livestock_expenses_paid_by_idx` ON `livestock_expenses` (`paid_by_id`);--> statement-breakpoint
CREATE INDEX `livestock_expenses_lot_idx` ON `livestock_expenses` (`lot_id`);--> statement-breakpoint
CREATE TABLE `livestock_feed_consumptions` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`inventory_item_id` text NOT NULL,
	`plan_id` text,
	`occurred_at` text NOT NULL,
	`quantity_kg` real NOT NULL,
	`cost_clp` integer NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`inventory_item_id`) REFERENCES `livestock_feed_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`plan_id`) REFERENCES `livestock_feeding_plans`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_feed_consumptions_quantity_check" CHECK("livestock_feed_consumptions"."quantity_kg" > 0),
	CONSTRAINT "livestock_feed_consumptions_cost_check" CHECK("livestock_feed_consumptions"."cost_clp" >= 0)
);
--> statement-breakpoint
CREATE INDEX `livestock_feed_consumptions_field_date_idx` ON `livestock_feed_consumptions` (`field_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_feed_consumptions_lot_date_idx` ON `livestock_feed_consumptions` (`lot_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_feed_consumptions_inventory_date_idx` ON `livestock_feed_consumptions` (`inventory_item_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `livestock_feed_inventory` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`product_name` text NOT NULL,
	`quantity_kg` real DEFAULT 0 NOT NULL,
	`unit_cost_clp` real DEFAULT 0 NOT NULL,
	`reorder_level_kg` real DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "livestock_feed_inventory_quantity_check" CHECK("livestock_feed_inventory"."quantity_kg" >= 0),
	CONSTRAINT "livestock_feed_inventory_cost_check" CHECK("livestock_feed_inventory"."unit_cost_clp" >= 0),
	CONSTRAINT "livestock_feed_inventory_reorder_check" CHECK("livestock_feed_inventory"."reorder_level_kg" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_feed_inventory_field_product_unique` ON `livestock_feed_inventory` (`field_id`,`product_name`);--> statement-breakpoint
CREATE INDEX `livestock_feed_inventory_field_idx` ON `livestock_feed_inventory` (`field_id`);--> statement-breakpoint
CREATE TABLE `livestock_feeding_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text NOT NULL,
	`product_name` text DEFAULT 'Concentrado' NOT NULL,
	`kg_per_animal_day` real DEFAULT 0 NOT NULL,
	`sack_weight_kg` real DEFAULT 25 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_feeding_plans_lot_unique` ON `livestock_feeding_plans` (`lot_id`);--> statement-breakpoint
CREATE TABLE `livestock_health_events` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`condition` text,
	`product_name` text,
	`active_ingredient` text,
	`dose_amount` real,
	`dose_unit` text,
	`route` text,
	`withdrawal_milk_until` text,
	`withdrawal_meat_until` text,
	`professional` text,
	`notes` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`source_record_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_health_events_type_check" CHECK("livestock_health_events"."event_type" IN ('observation', 'diagnosis', 'treatment', 'vaccination', 'withdrawal_clearance')),
	CONSTRAINT "livestock_health_events_status_check" CHECK("livestock_health_events"."status" IN ('open', 'completed', 'cancelled')),
	CONSTRAINT "livestock_health_events_dose_check" CHECK("livestock_health_events"."dose_amount" IS NULL OR "livestock_health_events"."dose_amount" >= 0),
	CONSTRAINT "livestock_health_events_milk_withdrawal_check" CHECK("livestock_health_events"."withdrawal_milk_until" IS NULL OR "livestock_health_events"."withdrawal_milk_until" >= "livestock_health_events"."occurred_at"),
	CONSTRAINT "livestock_health_events_meat_withdrawal_check" CHECK("livestock_health_events"."withdrawal_meat_until" IS NULL OR "livestock_health_events"."withdrawal_meat_until" >= "livestock_health_events"."occurred_at")
);
--> statement-breakpoint
CREATE INDEX `livestock_health_events_field_date_idx` ON `livestock_health_events` (`field_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_health_events_animal_date_idx` ON `livestock_health_events` (`animal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_health_events_status_idx` ON `livestock_health_events` (`status`);--> statement-breakpoint
CREATE TABLE `livestock_lactations` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`calving_date` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`status` text DEFAULT 'active' NOT NULL,
	`dry_off_reason` text,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`source_record_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_lactations_sequence_check" CHECK("livestock_lactations"."sequence_number" > 0),
	CONSTRAINT "livestock_lactations_dates_check" CHECK("livestock_lactations"."ended_at" IS NULL OR "livestock_lactations"."ended_at" >= "livestock_lactations"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_lactations_animal_sequence_unique` ON `livestock_lactations` (`animal_id`,`sequence_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_lactations_one_active_unique` ON `livestock_lactations` (`animal_id`) WHERE "livestock_lactations"."status" = 'active';--> statement-breakpoint
CREATE INDEX `livestock_lactations_field_status_idx` ON `livestock_lactations` (`field_id`,`status`);--> statement-breakpoint
CREATE INDEX `livestock_lactations_animal_dates_idx` ON `livestock_lactations` (`animal_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `livestock_lot_external_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`source_system` text DEFAULT 'cooprinsem' NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`normalized_value` text NOT NULL,
	`valid_from` text,
	`valid_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "livestock_lot_external_identifiers_validity_check" CHECK("livestock_lot_external_identifiers"."valid_to" IS NULL OR "livestock_lot_external_identifiers"."valid_from" IS NULL OR "livestock_lot_external_identifiers"."valid_to" >= "livestock_lot_external_identifiers"."valid_from")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_lot_external_identifiers_one_active_unique` ON `livestock_lot_external_identifiers` (`field_id`,`source_system`,`kind`,`normalized_value`) WHERE "livestock_lot_external_identifiers"."valid_to" IS NULL;--> statement-breakpoint
CREATE INDEX `livestock_lot_external_identifiers_lookup_idx` ON `livestock_lot_external_identifiers` (`field_id`,`source_system`,`kind`,`normalized_value`);--> statement-breakpoint
CREATE INDEX `livestock_lot_external_identifiers_lot_idx` ON `livestock_lot_external_identifiers` (`lot_id`);--> statement-breakpoint
CREATE TABLE `livestock_lot_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`animal_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`source_system` text DEFAULT 'manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "livestock_lot_memberships_dates_check" CHECK("livestock_lot_memberships"."ended_at" IS NULL OR "livestock_lot_memberships"."ended_at" >= "livestock_lot_memberships"."started_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_lot_memberships_one_active_unique` ON `livestock_lot_memberships` (`animal_id`) WHERE "livestock_lot_memberships"."ended_at" IS NULL;--> statement-breakpoint
CREATE INDEX `livestock_lot_memberships_animal_dates_idx` ON `livestock_lot_memberships` (`animal_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `livestock_lot_memberships_lot_dates_idx` ON `livestock_lot_memberships` (`lot_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `livestock_lots` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`animal_count` integer NOT NULL,
	`average_weight_kg` real,
	`entry_date` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`owner_name` text,
	`tracking_mode` text DEFAULT 'summary' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `livestock_lots_field_idx` ON `livestock_lots` (`field_id`);--> statement-breakpoint
CREATE INDEX `livestock_lots_paddock_idx` ON `livestock_lots` (`paddock_id`);--> statement-breakpoint
CREATE INDEX `livestock_lots_status_idx` ON `livestock_lots` (`status`);--> statement-breakpoint
CREATE TABLE `livestock_milk_controls` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`lactation_id` text,
	`control_date` text NOT NULL,
	`morning_liters` real,
	`afternoon_liters` real,
	`third_milking_liters` real,
	`total_liters` real NOT NULL,
	`fat_pct` real,
	`protein_pct` real,
	`somatic_cell_count` integer,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`source_record_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`lactation_id`) REFERENCES `livestock_lactations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_milk_controls_total_check" CHECK("livestock_milk_controls"."total_liters" > 0),
	CONSTRAINT "livestock_milk_controls_morning_check" CHECK("livestock_milk_controls"."morning_liters" IS NULL OR "livestock_milk_controls"."morning_liters" >= 0),
	CONSTRAINT "livestock_milk_controls_afternoon_check" CHECK("livestock_milk_controls"."afternoon_liters" IS NULL OR "livestock_milk_controls"."afternoon_liters" >= 0),
	CONSTRAINT "livestock_milk_controls_third_check" CHECK("livestock_milk_controls"."third_milking_liters" IS NULL OR "livestock_milk_controls"."third_milking_liters" >= 0),
	CONSTRAINT "livestock_milk_controls_fat_check" CHECK("livestock_milk_controls"."fat_pct" IS NULL OR ("livestock_milk_controls"."fat_pct" >= 0 AND "livestock_milk_controls"."fat_pct" <= 15)),
	CONSTRAINT "livestock_milk_controls_protein_check" CHECK("livestock_milk_controls"."protein_pct" IS NULL OR ("livestock_milk_controls"."protein_pct" >= 0 AND "livestock_milk_controls"."protein_pct" <= 15)),
	CONSTRAINT "livestock_milk_controls_scc_check" CHECK("livestock_milk_controls"."somatic_cell_count" IS NULL OR "livestock_milk_controls"."somatic_cell_count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_milk_controls_animal_date_unique` ON `livestock_milk_controls` (`animal_id`,`control_date`);--> statement-breakpoint
CREATE INDEX `livestock_milk_controls_field_date_idx` ON `livestock_milk_controls` (`field_id`,`control_date`);--> statement-breakpoint
CREATE INDEX `livestock_milk_controls_lactation_date_idx` ON `livestock_milk_controls` (`lactation_id`,`control_date`);--> statement-breakpoint
CREATE TABLE `livestock_notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`preference_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`due_date` text NOT NULL,
	`channel` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`sent_at` text,
	FOREIGN KEY (`preference_id`) REFERENCES `livestock_notification_preferences`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "livestock_notification_delivery_channel_check" CHECK("livestock_notification_deliveries"."channel" IN ('email', 'browser')),
	CONSTRAINT "livestock_notification_delivery_status_check" CHECK("livestock_notification_deliveries"."status" IN ('sent', 'failed')),
	CONSTRAINT "livestock_notification_delivery_lease_check" CHECK(
      ("livestock_notification_deliveries"."lease_token" IS NULL AND "livestock_notification_deliveries"."lease_expires_at" IS NULL)
      OR ("livestock_notification_deliveries"."status" = 'failed' AND "livestock_notification_deliveries"."lease_token" IS NOT NULL AND "livestock_notification_deliveries"."lease_expires_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_notification_delivery_dedupe_unique` ON `livestock_notification_deliveries` (`preference_id`,`work_item_id`,`due_date`,`channel`);--> statement-breakpoint
CREATE INDEX `livestock_notification_delivery_status_idx` ON `livestock_notification_deliveries` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `livestock_notification_delivery_lease_idx` ON `livestock_notification_deliveries` (`status`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `livestock_notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`user_email` text NOT NULL,
	`email_enabled` integer DEFAULT false NOT NULL,
	`browser_enabled` integer DEFAULT false NOT NULL,
	`reminder_days` integer DEFAULT 14 NOT NULL,
	`timezone` text DEFAULT 'America/Santiago' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "livestock_notification_preferences_days_check" CHECK("livestock_notification_preferences"."reminder_days" BETWEEN 0 AND 60)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_notification_preferences_scope_unique` ON `livestock_notification_preferences` (`organization_id`,`field_id`,`user_email`);--> statement-breakpoint
CREATE INDEX `livestock_notification_preferences_field_idx` ON `livestock_notification_preferences` (`field_id`);--> statement-breakpoint
CREATE TABLE `livestock_partners` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_partners_organization_name_unique` ON `livestock_partners` (`organization_id`,`name`);--> statement-breakpoint
CREATE INDEX `livestock_partners_organization_idx` ON `livestock_partners` (`organization_id`);--> statement-breakpoint
CREATE TABLE `livestock_reproductive_events` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`event_type` text NOT NULL,
	`occurred_at` text NOT NULL,
	`method` text,
	`result` text,
	`sire_identifier` text,
	`sire_animal_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`source_record_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sire_animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "livestock_reproductive_events_type_check" CHECK("livestock_reproductive_events"."event_type" IN ('heat', 'service', 'insemination', 'pregnancy_diagnosis', 'calving', 'dry_off', 'abortion'))
);
--> statement-breakpoint
CREATE INDEX `livestock_reproductive_events_field_date_idx` ON `livestock_reproductive_events` (`field_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_reproductive_events_animal_date_idx` ON `livestock_reproductive_events` (`animal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `livestock_reproductive_events_type_idx` ON `livestock_reproductive_events` (`event_type`);--> statement-breakpoint
CREATE TABLE `livestock_sale_document_links` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`animal_id` text,
	`lot_id` text,
	`allocated_amount_clp` integer DEFAULT 0 NOT NULL,
	`allocated_weight_kg` real,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `livestock_sale_documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `livestock_sale_doc_links_doc_idx` ON `livestock_sale_document_links` (`document_id`);--> statement-breakpoint
CREATE INDEX `livestock_sale_doc_links_animal_idx` ON `livestock_sale_document_links` (`animal_id`);--> statement-breakpoint
CREATE INDEX `livestock_sale_doc_links_lot_idx` ON `livestock_sale_document_links` (`lot_id`);--> statement-breakpoint
CREATE TABLE `livestock_sale_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`document_type` text DEFAULT 'liquidacion_feria' NOT NULL,
	`document_number` text,
	`buyer_or_supplier_name` text NOT NULL,
	`document_date` text NOT NULL,
	`total_amount_clp` integer DEFAULT 0 NOT NULL,
	`object_key` text,
	`sha256` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `livestock_sale_docs_org_field_idx` ON `livestock_sale_documents` (`organization_id`,`field_id`);--> statement-breakpoint
CREATE INDEX `livestock_sale_docs_date_idx` ON `livestock_sale_documents` (`document_date`);--> statement-breakpoint
CREATE TABLE `livestock_weighings` (
	`id` text PRIMARY KEY NOT NULL,
	`lot_id` text,
	`animal_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`weight_kg` real NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'Registro manual' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`lot_id`) REFERENCES `livestock_lots`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `livestock_weighings_animal_date_unique` ON `livestock_weighings` (`animal_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `livestock_weighings_lot_date_idx` ON `livestock_weighings` (`lot_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `livestock_weighings_animal_idx` ON `livestock_weighings` (`animal_id`);--> statement-breakpoint
CREATE INDEX `livestock_weighings_date_idx` ON `livestock_weighings` (`recorded_at`);--> statement-breakpoint
CREATE TABLE `membership_field_access` (
	`id` text PRIMARY KEY NOT NULL,
	`membership_id` text NOT NULL,
	`field_id` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`membership_id`) REFERENCES `organization_memberships`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_field_access_unique` ON `membership_field_access` (`membership_id`,`field_id`);--> statement-breakpoint
CREATE INDEX `membership_field_access_field_idx` ON `membership_field_access` (`field_id`);--> statement-breakpoint
CREATE TABLE `milk_bulk_production` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`kind` text DEFAULT 'tank_total' NOT NULL,
	`volume_liters` real NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_record_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "milk_bulk_production_kind_check" CHECK("milk_bulk_production"."kind" IN ('tank_total', 'delivery', 'milk_meter_rollup')),
	CONSTRAINT "milk_bulk_production_volume_check" CHECK("milk_bulk_production"."volume_liters" > 0),
	CONSTRAINT "milk_bulk_production_source_check" CHECK("milk_bulk_production"."source" IN ('manual', 'cooprinsem_clo', 'equipment'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milk_bulk_production_field_recorded_source_unique` ON `milk_bulk_production` (`field_id`,`recorded_at`,`kind`,`source`);--> statement-breakpoint
CREATE UNIQUE INDEX `milk_bulk_production_source_record_unique` ON `milk_bulk_production` (`field_id`,`source`,`source_record_id`) WHERE "milk_bulk_production"."source_record_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `milk_bulk_production_field_recorded_idx` ON `milk_bulk_production` (`field_id`,`recorded_at`);--> statement-breakpoint
CREATE INDEX `milk_bulk_production_organization_recorded_idx` ON `milk_bulk_production` (`organization_id`,`recorded_at`);--> statement-breakpoint
CREATE TABLE `milk_quality_samples` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`sampled_at` text NOT NULL,
	`period` text NOT NULL,
	`kind` text DEFAULT 'bulk_tank' NOT NULL,
	`fat_percent` real,
	`protein_percent` real,
	`total_solids_percent` real,
	`somatic_cell_count` integer,
	`somatic_cell_count_unit` text,
	`bacterial_count` integer,
	`bacterial_count_unit` text,
	`sanitary_flags` text DEFAULT '{}' NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_record_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "milk_quality_samples_kind_check" CHECK("milk_quality_samples"."kind" IN ('bulk_tank', 'settlement', 'laboratory')),
	CONSTRAINT "milk_quality_samples_period_check" CHECK(length("milk_quality_samples"."period") = 7 AND "milk_quality_samples"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr("milk_quality_samples"."period", 6, 2) BETWEEN '01' AND '12'),
	CONSTRAINT "milk_quality_samples_fat_check" CHECK("milk_quality_samples"."fat_percent" IS NULL OR ("milk_quality_samples"."fat_percent" >= 0 AND "milk_quality_samples"."fat_percent" <= 15)),
	CONSTRAINT "milk_quality_samples_protein_check" CHECK("milk_quality_samples"."protein_percent" IS NULL OR ("milk_quality_samples"."protein_percent" >= 0 AND "milk_quality_samples"."protein_percent" <= 15)),
	CONSTRAINT "milk_quality_samples_solids_check" CHECK("milk_quality_samples"."total_solids_percent" IS NULL OR ("milk_quality_samples"."total_solids_percent" >= 0 AND "milk_quality_samples"."total_solids_percent" <= 100)),
	CONSTRAINT "milk_quality_samples_somatic_count_check" CHECK(("milk_quality_samples"."somatic_cell_count" IS NULL AND "milk_quality_samples"."somatic_cell_count_unit" IS NULL) OR ("milk_quality_samples"."somatic_cell_count" IS NOT NULL AND "milk_quality_samples"."somatic_cell_count" >= 0 AND "milk_quality_samples"."somatic_cell_count_unit" IS NOT NULL AND "milk_quality_samples"."somatic_cell_count_unit" IN ('cells_per_ml', 'thousand_cells_per_ml'))),
	CONSTRAINT "milk_quality_samples_bacterial_count_check" CHECK(("milk_quality_samples"."bacterial_count" IS NULL AND "milk_quality_samples"."bacterial_count_unit" IS NULL) OR ("milk_quality_samples"."bacterial_count" IS NOT NULL AND "milk_quality_samples"."bacterial_count" >= 0 AND "milk_quality_samples"."bacterial_count_unit" IS NOT NULL AND "milk_quality_samples"."bacterial_count_unit" IN ('cfu_per_ml', 'thousand_cfu_per_ml'))),
	CONSTRAINT "milk_quality_samples_sanitary_flags_check" CHECK(json_valid("milk_quality_samples"."sanitary_flags")),
	CONSTRAINT "milk_quality_samples_measurement_check" CHECK("milk_quality_samples"."fat_percent" IS NOT NULL OR "milk_quality_samples"."protein_percent" IS NOT NULL OR "milk_quality_samples"."total_solids_percent" IS NOT NULL OR "milk_quality_samples"."somatic_cell_count" IS NOT NULL OR "milk_quality_samples"."bacterial_count" IS NOT NULL OR "milk_quality_samples"."sanitary_flags" <> '{}'),
	CONSTRAINT "milk_quality_samples_source_check" CHECK("milk_quality_samples"."source" IN ('manual', 'settlement', 'cooprinsem_laboratory', 'equipment'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `milk_quality_samples_field_sampled_source_unique` ON `milk_quality_samples` (`field_id`,`sampled_at`,`kind`,`source`);--> statement-breakpoint
CREATE UNIQUE INDEX `milk_quality_samples_source_record_unique` ON `milk_quality_samples` (`field_id`,`source`,`source_record_id`) WHERE "milk_quality_samples"."source_record_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `milk_quality_samples_field_sampled_idx` ON `milk_quality_samples` (`field_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `milk_quality_samples_field_period_idx` ON `milk_quality_samples` (`field_id`,`period`);--> statement-breakpoint
CREATE INDEX `milk_quality_samples_organization_sampled_idx` ON `milk_quality_samples` (`organization_id`,`sampled_at`);--> statement-breakpoint
CREATE TABLE `milk_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`period` text NOT NULL,
	`generated_at` text,
	`plant` text DEFAULT '' NOT NULL,
	`purchase_order` text NOT NULL,
	`producer_code` text DEFAULT '' NOT NULL,
	`producer_name` text NOT NULL,
	`buyer_name` text NOT NULL,
	`liters_first_half` real,
	`liters_second_half` real,
	`total_liters` real NOT NULL,
	`net_amount_clp` integer NOT NULL,
	`tax_amount_clp` integer DEFAULT 0 NOT NULL,
	`gross_amount_clp` integer NOT NULL,
	`net_price_per_liter_clp` real NOT NULL,
	`gross_price_per_liter_clp` real,
	`source_document_name` text,
	`notes` text DEFAULT '' NOT NULL,
	`line_items` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `milk_settlements_field_idx` ON `milk_settlements` (`field_id`);--> statement-breakpoint
CREATE INDEX `milk_settlements_period_idx` ON `milk_settlements` (`period`);--> statement-breakpoint
CREATE UNIQUE INDEX `milk_settlements_field_order_unique` ON `milk_settlements` (`field_id`,`purchase_order`);--> statement-breakpoint
CREATE TABLE `organization_access_bootstrap` (
	`organization_id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`claimed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `organization_ai_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`provider` text NOT NULL,
	`encrypted_api_key` text NOT NULL,
	`encrypted_key_iv` text NOT NULL,
	`default_model` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_ai_configs_org_provider_idx` ON `organization_ai_configs` (`organization_id`,`provider`);--> statement-breakpoint
CREATE INDEX `organization_ai_configs_lookup_idx` ON `organization_ai_configs` (`organization_id`,`is_active`);--> statement-breakpoint
CREATE TABLE `organization_feature_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text,
	`feature` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "organization_feature_flags_feature_check" CHECK("organization_feature_flags"."feature" IN ('trazabilidad', 'pastoreo', 'analitica', 'benchmarking'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_feature_flags_global_unique` ON `organization_feature_flags` (`organization_id`,`feature`) WHERE "organization_feature_flags"."field_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `organization_feature_flags_field_unique` ON `organization_feature_flags` (`organization_id`,`field_id`,`feature`) WHERE "organization_feature_flags"."field_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `organization_feature_flags_lookup_idx` ON `organization_feature_flags` (`organization_id`,`feature`,`field_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_email` text NOT NULL,
	`normalized_email` text NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`closure_request_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closure_request_id`) REFERENCES `account_closure_requests`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "organization_memberships_role_check" CHECK("organization_memberships"."role" IN ('owner', 'admin', 'manager', 'operator', 'viewer')),
	CONSTRAINT "organization_memberships_status_check" CHECK("organization_memberships"."status" IN ('active', 'suspended'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_memberships_email_unique` ON `organization_memberships` (`organization_id`,`normalized_email`);--> statement-breakpoint
CREATE UNIQUE INDEX `organization_memberships_organization_id_unique` ON `organization_memberships` (`organization_id`,`id`);--> statement-breakpoint
CREATE INDEX `organization_memberships_status_role_idx` ON `organization_memberships` (`organization_id`,`status`,`role`);--> statement-breakpoint
CREATE INDEX `organization_memberships_closure_request_idx` ON `organization_memberships` (`closure_request_id`) WHERE "organization_memberships"."closure_request_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'shared' NOT NULL,
	`plan_code` text DEFAULT 'legacy' NOT NULL,
	`field_limit` integer,
	`paddock_limit` integer,
	`self_service_owner_email` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "organizations_plan_code_check" CHECK("organizations"."plan_code" IN ('legacy', 'free', 'pro')),
	CONSTRAINT "organizations_field_limit_check" CHECK("organizations"."field_limit" IS NULL OR "organizations"."field_limit" > 0),
	CONSTRAINT "organizations_paddock_limit_check" CHECK("organizations"."paddock_limit" IS NULL OR "organizations"."paddock_limit" > 0),
	CONSTRAINT "organizations_free_plan_limits_check" CHECK("organizations"."plan_code" <> 'free' OR ("organizations"."field_limit" = 2 AND "organizations"."paddock_limit" = 200 AND "organizations"."self_service_owner_email" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_self_service_owner_unique` ON `organizations` (`self_service_owner_email`);--> statement-breakpoint
CREATE TABLE `original_integrity_incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`issue_type` text NOT NULL,
	`summary` text NOT NULL,
	`expected_size_bytes` integer NOT NULL,
	`stored_size_bytes` integer,
	`expected_sha256` text NOT NULL,
	`calculated_sha256` text,
	`first_detected_at` text NOT NULL,
	`last_detected_at` text NOT NULL,
	`resolved_at` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "original_integrity_incidents_status_check" CHECK("original_integrity_incidents"."status" IN ('open', 'resolved')),
	CONSTRAINT "original_integrity_incidents_type_check" CHECK("original_integrity_incidents"."issue_type" IN ('missing', 'size_mismatch', 'content_mismatch', 'metadata_mismatch', 'size_limit')),
	CONSTRAINT "original_integrity_incidents_size_check" CHECK("original_integrity_incidents"."expected_size_bytes" >= 0 AND ("original_integrity_incidents"."stored_size_bytes" IS NULL OR "original_integrity_incidents"."stored_size_bytes" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `original_integrity_incidents_import_unique` ON `original_integrity_incidents` (`import_job_id`);--> statement-breakpoint
CREATE INDEX `original_integrity_incidents_field_status_idx` ON `original_integrity_incidents` (`field_id`,`status`,`last_detected_at`);--> statement-breakpoint
CREATE TABLE `original_integrity_sweep_states` (
	`field_id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`cycle_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`last_trigger` text DEFAULT 'request_heartbeat' NOT NULL,
	`cursor_created_at` text,
	`cursor_import_job_id` text,
	`checked_count` integer DEFAULT 0 NOT NULL,
	`healthy_count` integer DEFAULT 0 NOT NULL,
	`missing_count` integer DEFAULT 0 NOT NULL,
	`mismatch_count` integer DEFAULT 0 NOT NULL,
	`read_bytes` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`last_started_at` text,
	`last_batch_at` text,
	`completed_at` text,
	`next_run_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`last_error` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "original_integrity_sweep_status_check" CHECK("original_integrity_sweep_states"."status" IN ('pending', 'running', 'completed', 'completed_with_issues', 'failed')),
	CONSTRAINT "original_integrity_sweep_trigger_check" CHECK("original_integrity_sweep_states"."last_trigger" IN ('manual', 'scheduled', 'request_heartbeat')),
	CONSTRAINT "original_integrity_sweep_counts_check" CHECK("original_integrity_sweep_states"."checked_count" >= 0 AND "original_integrity_sweep_states"."healthy_count" >= 0 AND "original_integrity_sweep_states"."missing_count" >= 0 AND "original_integrity_sweep_states"."mismatch_count" >= 0 AND "original_integrity_sweep_states"."read_bytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `original_integrity_sweep_due_idx` ON `original_integrity_sweep_states` (`next_run_at`,`lease_expires_at`);--> statement-breakpoint
CREATE TABLE `pabco_compliance_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`requirement` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`evidence_document_id` text,
	`valid_from` text,
	`valid_until` text,
	`reminder_at` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`source_record_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_record_id`) REFERENCES `source_records`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "pabco_compliance_items_requirement_check" CHECK("pabco_compliance_items"."requirement" IN ('veterinary_advisory', 'medicine_prescriptions', 'withdrawal_management', 'annual_water_analysis', 'animal_traceability')),
	CONSTRAINT "pabco_compliance_items_status_check" CHECK("pabco_compliance_items"."status" IN ('pending', 'compliant', 'expiring', 'expired', 'not_applicable')),
	CONSTRAINT "pabco_compliance_items_source_check" CHECK("pabco_compliance_items"."source" IN ('manual', 'sag', 'cooprinsem')),
	CONSTRAINT "pabco_compliance_items_validity_check" CHECK("pabco_compliance_items"."valid_until" IS NULL OR "pabco_compliance_items"."valid_from" IS NULL OR "pabco_compliance_items"."valid_until" >= "pabco_compliance_items"."valid_from"),
	CONSTRAINT "pabco_compliance_items_reminder_check" CHECK("pabco_compliance_items"."reminder_at" IS NULL OR "pabco_compliance_items"."valid_until" IS NULL OR "pabco_compliance_items"."reminder_at" <= "pabco_compliance_items"."valid_until")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pabco_compliance_items_field_requirement_unique` ON `pabco_compliance_items` (`field_id`,`requirement`);--> statement-breakpoint
CREATE UNIQUE INDEX `pabco_compliance_items_source_record_unique` ON `pabco_compliance_items` (`field_id`,`source`,`source_record_id`) WHERE "pabco_compliance_items"."source_record_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `pabco_compliance_items_field_status_idx` ON `pabco_compliance_items` (`field_id`,`status`,`valid_until`);--> statement-breakpoint
CREATE INDEX `pabco_compliance_items_organization_status_idx` ON `pabco_compliance_items` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `pabco_compliance_items_reminder_idx` ON `pabco_compliance_items` (`reminder_at`,`status`);--> statement-breakpoint
CREATE TABLE `pabco_evidence_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`filename` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`etag` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_by` text NOT NULL,
	`compensation_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_retry_at` text,
	`stored_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pabco_evidence_documents_size_check" CHECK("pabco_evidence_documents"."size_bytes" > 0 AND "pabco_evidence_documents"."size_bytes" <= 10485760),
	CONSTRAINT "pabco_evidence_documents_sha256_check" CHECK(length("pabco_evidence_documents"."sha256") = 64 AND "pabco_evidence_documents"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "pabco_evidence_documents_status_check" CHECK("pabco_evidence_documents"."status" IN ('pending', 'stored', 'compensation_pending')),
	CONSTRAINT "pabco_evidence_documents_storage_check" CHECK(("pabco_evidence_documents"."status" = 'pending' AND "pabco_evidence_documents"."etag" IS NULL AND "pabco_evidence_documents"."stored_at" IS NULL)
        OR ("pabco_evidence_documents"."status" IN ('stored', 'compensation_pending') AND "pabco_evidence_documents"."etag" IS NOT NULL)),
	CONSTRAINT "pabco_evidence_documents_compensation_check" CHECK("pabco_evidence_documents"."compensation_attempts" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pabco_evidence_documents_object_key_unique` ON `pabco_evidence_documents` (`object_key`);--> statement-breakpoint
CREATE INDEX `pabco_evidence_documents_field_status_idx` ON `pabco_evidence_documents` (`field_id`,`status`);--> statement-breakpoint
CREATE INDEX `pabco_evidence_documents_retry_idx` ON `pabco_evidence_documents` (`status`,`next_retry_at`);--> statement-breakpoint
CREATE TABLE `paddock_cell_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`snapshot_token` text NOT NULL,
	`request` text NOT NULL,
	`result` text NOT NULL,
	`actor` text NOT NULL,
	`committed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_cell_operations_kind_check" CHECK("paddock_cell_operations"."kind" IN ('create', 'close'))
);
--> statement-breakpoint
CREATE INDEX `paddock_cell_operations_organization_time_idx` ON `paddock_cell_operations` (`organization_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `paddock_cell_operations_field_time_idx` ON `paddock_cell_operations` (`field_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `paddock_cell_operations_paddock_time_idx` ON `paddock_cell_operations` (`paddock_id`,`committed_at`);--> statement-breakpoint
CREATE TABLE `paddock_cells` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text NOT NULL,
	`name` text NOT NULL,
	`cell_index` integer NOT NULL,
	`coordinates` text NOT NULL,
	`area_square_meters` real NOT NULL,
	`start_distance_meters` real NOT NULL,
	`end_distance_meters` real NOT NULL,
	`active_from` text NOT NULL,
	`active_to` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_operation_id` text NOT NULL,
	`closed_by_operation_id` text,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_operation_id`) REFERENCES `paddock_cell_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`closed_by_operation_id`) REFERENCES `paddock_cell_operations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_cells_index_check" CHECK("paddock_cells"."cell_index" > 0),
	CONSTRAINT "paddock_cells_area_check" CHECK("paddock_cells"."area_square_meters" > 0),
	CONSTRAINT "paddock_cells_distances_check" CHECK("paddock_cells"."start_distance_meters" >= 0 AND "paddock_cells"."end_distance_meters" > "paddock_cells"."start_distance_meters"),
	CONSTRAINT "paddock_cells_geometry_check" CHECK(json_valid("paddock_cells"."coordinates") AND json_type("paddock_cells"."coordinates") = 'object'),
	CONSTRAINT "paddock_cells_active_dates_check" CHECK("paddock_cells"."active_to" IS NULL OR "paddock_cells"."active_to" >= "paddock_cells"."active_from"),
	CONSTRAINT "paddock_cells_version_check" CHECK("paddock_cells"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddock_cells_operation_index_unique` ON `paddock_cells` (`created_by_operation_id`,`cell_index`);--> statement-breakpoint
CREATE INDEX `paddock_cells_field_active_idx` ON `paddock_cells` (`field_id`,`active_to`);--> statement-breakpoint
CREATE INDEX `paddock_cells_paddock_active_idx` ON `paddock_cells` (`paddock_id`,`active_to`);--> statement-breakpoint
CREATE TABLE `paddock_lineage_edges` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`parent_paddock_id` text NOT NULL,
	`child_paddock_id` text NOT NULL,
	`overlap_square_meters` real NOT NULL,
	`parent_overlap_ratio` real NOT NULL,
	`child_overlap_ratio` real NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `paddock_operations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`parent_paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`child_paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_lineage_edges_distinct_check" CHECK("paddock_lineage_edges"."parent_paddock_id" <> "paddock_lineage_edges"."child_paddock_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddock_lineage_edges_operation_pair_unique` ON `paddock_lineage_edges` (`operation_id`,`parent_paddock_id`,`child_paddock_id`);--> statement-breakpoint
CREATE INDEX `paddock_lineage_edges_parent_idx` ON `paddock_lineage_edges` (`parent_paddock_id`);--> statement-breakpoint
CREATE INDEX `paddock_lineage_edges_child_idx` ON `paddock_lineage_edges` (`child_paddock_id`);--> statement-breakpoint
CREATE TABLE `paddock_ndvi` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text NOT NULL,
	`month` text NOT NULL,
	`status` text NOT NULL,
	`mean_ndvi` real,
	`no_data_reason` text,
	`cloud_pct` real,
	`cloud_pct_is_approximate` integer DEFAULT false NOT NULL,
	`interval_from` text NOT NULL,
	`interval_to` text NOT NULL,
	`observed_at` text,
	`sample_count` integer NOT NULL,
	`no_data_count` integer NOT NULL,
	`valid_sample_count` integer NOT NULL,
	`computed_at` text NOT NULL,
	`geometry_snapshot` text NOT NULL,
	`paddock_snapshot` text NOT NULL,
	`geometry_snapshot_token` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`,`paddock_id`) REFERENCES `potreros`(`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_ndvi_month_check" CHECK("paddock_ndvi"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-01'),
	CONSTRAINT "paddock_ndvi_status_check" CHECK("paddock_ndvi"."status" IN ('ok', 'no_data')),
	CONSTRAINT "paddock_ndvi_interval_check" CHECK("paddock_ndvi"."interval_from" < "paddock_ndvi"."interval_to" AND substr("paddock_ndvi"."interval_from", 1, 10) = "paddock_ndvi"."month"),
	CONSTRAINT "paddock_ndvi_counts_check" CHECK("paddock_ndvi"."sample_count" >= 0 AND "paddock_ndvi"."no_data_count" >= 0 AND "paddock_ndvi"."valid_sample_count" >= 0 AND "paddock_ndvi"."sample_count" = "paddock_ndvi"."no_data_count" + "paddock_ndvi"."valid_sample_count"),
	CONSTRAINT "paddock_ndvi_result_check" CHECK((
      "paddock_ndvi"."status" = 'ok'
      AND "paddock_ndvi"."mean_ndvi" BETWEEN -1 AND 1
      AND "paddock_ndvi"."no_data_reason" IS NULL
      AND "paddock_ndvi"."cloud_pct" BETWEEN 0 AND 100
      AND "paddock_ndvi"."cloud_pct_is_approximate" = 1
      AND "paddock_ndvi"."observed_at" IS NOT NULL
      AND "paddock_ndvi"."valid_sample_count" > 0
    ) OR (
      "paddock_ndvi"."status" = 'no_data'
      AND "paddock_ndvi"."mean_ndvi" IS NULL
      AND "paddock_ndvi"."no_data_reason" IN ('no_intervals', 'no_valid_samples')
      AND "paddock_ndvi"."cloud_pct" IS NULL
      AND "paddock_ndvi"."cloud_pct_is_approximate" = 0
      AND "paddock_ndvi"."valid_sample_count" = 0
      AND ("paddock_ndvi"."no_data_reason" = 'no_valid_samples' OR "paddock_ndvi"."observed_at" IS NULL)
    )),
	CONSTRAINT "paddock_ndvi_geometry_snapshot_check" CHECK(json_valid("paddock_ndvi"."geometry_snapshot") AND json_type("paddock_ndvi"."geometry_snapshot") IN ('array', 'object')),
	CONSTRAINT "paddock_ndvi_paddock_snapshot_check" CHECK(json_valid("paddock_ndvi"."paddock_snapshot") AND json_type("paddock_ndvi"."paddock_snapshot") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddock_ndvi_scope_month_unique` ON `paddock_ndvi` (`organization_id`,`field_id`,`paddock_id`,`month`);--> statement-breakpoint
CREATE INDEX `paddock_ndvi_field_month_idx` ON `paddock_ndvi` (`organization_id`,`field_id`,`month`);--> statement-breakpoint
CREATE INDEX `paddock_ndvi_paddock_computed_idx` ON `paddock_ndvi` (`paddock_id`,`computed_at`);--> statement-breakpoint
CREATE TABLE `paddock_operation_lot_moves` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`lot_id` text NOT NULL,
	`from_paddock_id` text,
	`to_paddock_id` text,
	`overlap_square_meters` real DEFAULT 0 NOT NULL,
	`overlap_ratio` real DEFAULT 0 NOT NULL,
	`reason` text NOT NULL,
	`warning` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `paddock_operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddock_operation_lot_moves_operation_lot_unique` ON `paddock_operation_lot_moves` (`operation_id`,`lot_id`);--> statement-breakpoint
CREATE INDEX `paddock_operation_lot_moves_lot_idx` ON `paddock_operation_lot_moves` (`lot_id`);--> statement-breakpoint
CREATE TABLE `paddock_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`snapshot_token` text NOT NULL,
	`source_operation_id` text,
	`request` text NOT NULL,
	`result` text NOT NULL,
	`actor` text NOT NULL,
	`committed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`reverted_at` text,
	`reverted_by_operation_id` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_operations_kind_check" CHECK("paddock_operations"."kind" IN ('split', 'merge', 'redesign', 'undo'))
);
--> statement-breakpoint
CREATE INDEX `paddock_operations_organization_time_idx` ON `paddock_operations` (`organization_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `paddock_operations_field_time_idx` ON `paddock_operations` (`field_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `paddock_operations_source_idx` ON `paddock_operations` (`source_operation_id`);--> statement-breakpoint
CREATE TABLE `paddock_rotation_setting_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`expected_version` integer,
	`result` text NOT NULL,
	`actor` text NOT NULL,
	`committed_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_rotation_setting_operations_version_check" CHECK("paddock_rotation_setting_operations"."expected_version" IS NULL OR "paddock_rotation_setting_operations"."expected_version" >= 1)
);
--> statement-breakpoint
CREATE INDEX `paddock_rotation_setting_operations_organization_time_idx` ON `paddock_rotation_setting_operations` (`organization_id`,`committed_at`);--> statement-breakpoint
CREATE INDEX `paddock_rotation_setting_operations_field_time_idx` ON `paddock_rotation_setting_operations` (`field_id`,`committed_at`);--> statement-breakpoint
CREATE TABLE `paddock_rotation_settings` (
	`field_id` text PRIMARY KEY NOT NULL,
	`recent_days` integer DEFAULT 15 NOT NULL,
	`long_rest_days` integer DEFAULT 30 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_rotation_settings_thresholds_check" CHECK("paddock_rotation_settings"."recent_days" >= 0 AND "paddock_rotation_settings"."recent_days" < "paddock_rotation_settings"."long_rest_days"),
	CONSTRAINT "paddock_rotation_settings_version_check" CHECK("paddock_rotation_settings"."version" >= 1)
);
--> statement-breakpoint
CREATE TABLE `potreros` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`name` text NOT NULL,
	`sector` text NOT NULL,
	`area_hectares` real NOT NULL,
	`coordinates` text NOT NULL,
	`grazeable_area_hectares` real,
	`land_use` text DEFAULT 'pradera_permanente' NOT NULL,
	`hole_kinds` text DEFAULT '[]' NOT NULL,
	`soil_ph` real,
	`soil_nitrogen` real,
	`soil_phosphorus` real,
	`soil_potassium` real,
	`last_activity` text DEFAULT 'Creado · ahora' NOT NULL,
	`status` text DEFAULT 'Disponible' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`deleted_at` text,
	`archived_at` text,
	`archive_reason` text,
	`created_by_operation_id` text,
	`archived_by_operation_id` text,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "potreros_grazeable_area_check" CHECK("potreros"."grazeable_area_hectares" IS NULL OR "potreros"."grazeable_area_hectares" >= 0),
	CONSTRAINT "potreros_land_use_check" CHECK("potreros"."land_use" IN ('pradera_permanente', 'pradera_rotacion', 'cultivo_forrajero', 'cultivo', 'bosque', 'infraestructura', 'otro'))
);
--> statement-breakpoint
CREATE INDEX `potreros_field_active_idx` ON `potreros` (`field_id`,`archived_at`,`deleted_at`);--> statement-breakpoint
CREATE INDEX `potreros_created_operation_idx` ON `potreros` (`created_by_operation_id`);--> statement-breakpoint
CREATE INDEX `potreros_archived_operation_idx` ON `potreros` (`archived_by_operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `potreros_field_id_unique` ON `potreros` (`field_id`,`id`);--> statement-breakpoint
CREATE TABLE `pasture_biomass_estimates` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text NOT NULL,
	`raw_observation_id` text NOT NULL,
	`method` text NOT NULL,
	`kg_dm_per_hectare` real NOT NULL,
	`calibration_id` text,
	`evidence_json` text NOT NULL,
	`computed_at` text NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`,`paddock_id`) REFERENCES `potreros`(`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`paddock_id`,`raw_observation_id`) REFERENCES `pasture_raw_observations`(`organization_id`,`field_id`,`paddock_id`,`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organization_id`,`field_id`,`calibration_id`) REFERENCES `pasture_ndvi_calibrations`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pasture_biomass_estimates_method_check" CHECK("pasture_biomass_estimates"."method" IN ('manual_direct', 'manual_quadrat', 'ndvi_linear_calibration')),
	CONSTRAINT "pasture_biomass_estimates_value_check" CHECK("pasture_biomass_estimates"."kg_dm_per_hectare" >= 0 AND "pasture_biomass_estimates"."kg_dm_per_hectare" <= 10000000),
	CONSTRAINT "pasture_biomass_estimates_calibration_check" CHECK(
      ("pasture_biomass_estimates"."method" IN ('manual_direct', 'manual_quadrat') AND "pasture_biomass_estimates"."calibration_id" IS NULL)
      OR ("pasture_biomass_estimates"."method" = 'ndvi_linear_calibration' AND "pasture_biomass_estimates"."calibration_id" IS NOT NULL)
    ),
	CONSTRAINT "pasture_biomass_estimates_evidence_check" CHECK(json_valid("pasture_biomass_estimates"."evidence_json") AND json_type("pasture_biomass_estimates"."evidence_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_biomass_estimates_raw_unique` ON `pasture_biomass_estimates` (`raw_observation_id`);--> statement-breakpoint
CREATE INDEX `pasture_biomass_estimates_scope_computed_idx` ON `pasture_biomass_estimates` (`organization_id`,`field_id`,`computed_at`);--> statement-breakpoint
CREATE INDEX `pasture_biomass_estimates_paddock_computed_idx` ON `pasture_biomass_estimates` (`field_id`,`paddock_id`,`computed_at`);--> statement-breakpoint
CREATE TABLE `pasture_ndvi_calibrations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`slope_kg_dm_per_ha` real NOT NULL,
	`intercept_kg_dm_per_ha` real NOT NULL,
	`min_ndvi` real NOT NULL,
	`max_ndvi` real NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`valid_from` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pasture_ndvi_calibrations_provider_check" CHECK(length(trim("pasture_ndvi_calibrations"."provider_key")) BETWEEN 1 AND 80),
	CONSTRAINT "pasture_ndvi_calibrations_coefficients_check" CHECK(abs("pasture_ndvi_calibrations"."slope_kg_dm_per_ha") <= 1.0e308 AND abs("pasture_ndvi_calibrations"."intercept_kg_dm_per_ha") <= 1.0e308),
	CONSTRAINT "pasture_ndvi_calibrations_range_check" CHECK("pasture_ndvi_calibrations"."min_ndvi" >= -1 AND "pasture_ndvi_calibrations"."min_ndvi" < "pasture_ndvi_calibrations"."max_ndvi" AND "pasture_ndvi_calibrations"."max_ndvi" <= 1),
	CONSTRAINT "pasture_ndvi_calibrations_status_check" CHECK("pasture_ndvi_calibrations"."status" IN ('draft', 'active', 'retired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_ndvi_calibrations_scope_id_unique` ON `pasture_ndvi_calibrations` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_ndvi_calibrations_active_unique` ON `pasture_ndvi_calibrations` (`organization_id`,`field_id`,`provider_key`) WHERE "pasture_ndvi_calibrations"."status" = 'active';--> statement-breakpoint
CREATE INDEX `pasture_ndvi_calibrations_scope_status_idx` ON `pasture_ndvi_calibrations` (`organization_id`,`field_id`,`provider_key`,`status`,`valid_from`);--> statement-breakpoint
CREATE TABLE `pasture_provider_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`mode` text DEFAULT 'unconfigured' NOT NULL,
	`provider_key` text,
	`decided_by` text NOT NULL,
	`decided_at` text NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pasture_provider_decisions_mode_check" CHECK("pasture_provider_decisions"."mode" IN ('unconfigured', 'configured')),
	CONSTRAINT "pasture_provider_decisions_provider_check" CHECK(
      ("pasture_provider_decisions"."mode" = 'unconfigured' AND "pasture_provider_decisions"."provider_key" IS NULL)
      OR ("pasture_provider_decisions"."mode" = 'configured' AND "pasture_provider_decisions"."provider_key" IS NOT NULL AND length(trim("pasture_provider_decisions"."provider_key")) BETWEEN 1 AND 80)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_provider_decisions_scope_unique` ON `pasture_provider_decisions` (`organization_id`,`field_id`);--> statement-breakpoint
CREATE TABLE `pasture_raw_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`source_kind` text NOT NULL,
	`provider_key` text,
	`captured_at` text NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`etag` text,
	`storage_status` text DEFAULT 'pending' NOT NULL,
	`created_by` text NOT NULL,
	`stored_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`,`paddock_id`) REFERENCES `potreros`(`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pasture_raw_observations_operation_check" CHECK(length(trim("pasture_raw_observations"."operation_id")) BETWEEN 8 AND 160),
	CONSTRAINT "pasture_raw_observations_request_hash_check" CHECK(length("pasture_raw_observations"."request_hash") = 64 AND "pasture_raw_observations"."request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "pasture_raw_observations_source_check" CHECK(
      ("pasture_raw_observations"."source_kind" = 'manual' AND "pasture_raw_observations"."provider_key" IS NULL)
      OR ("pasture_raw_observations"."source_kind" = 'ndvi' AND "pasture_raw_observations"."provider_key" IS NOT NULL AND length(trim("pasture_raw_observations"."provider_key")) BETWEEN 1 AND 80)
    ),
	CONSTRAINT "pasture_raw_observations_object_check" CHECK(length(trim("pasture_raw_observations"."object_key")) BETWEEN 1 AND 512 AND "pasture_raw_observations"."object_key" NOT LIKE '%..%'),
	CONSTRAINT "pasture_raw_observations_content_check" CHECK("pasture_raw_observations"."content_type" = 'application/json' AND "pasture_raw_observations"."size_bytes" BETWEEN 1 AND 2000000),
	CONSTRAINT "pasture_raw_observations_sha_check" CHECK(length("pasture_raw_observations"."sha256") = 64 AND "pasture_raw_observations"."sha256" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "pasture_raw_observations_storage_status_check" CHECK("pasture_raw_observations"."storage_status" IN ('pending', 'stored')),
	CONSTRAINT "pasture_raw_observations_storage_check" CHECK(
      ("pasture_raw_observations"."storage_status" = 'pending' AND "pasture_raw_observations"."etag" IS NULL AND "pasture_raw_observations"."stored_at" IS NULL)
      OR ("pasture_raw_observations"."storage_status" = 'stored' AND "pasture_raw_observations"."etag" IS NOT NULL AND length(trim("pasture_raw_observations"."etag")) > 0 AND "pasture_raw_observations"."stored_at" IS NOT NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_raw_observations_scope_id_unique` ON `pasture_raw_observations` (`organization_id`,`field_id`,`paddock_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_raw_observations_operation_unique` ON `pasture_raw_observations` (`organization_id`,`field_id`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_raw_observations_object_key_unique` ON `pasture_raw_observations` (`object_key`);--> statement-breakpoint
CREATE INDEX `pasture_raw_observations_scope_captured_idx` ON `pasture_raw_observations` (`organization_id`,`field_id`,`captured_at`);--> statement-breakpoint
CREATE INDEX `pasture_raw_observations_paddock_captured_idx` ON `pasture_raw_observations` (`field_id`,`paddock_id`,`captured_at`);--> statement-breakpoint
CREATE TABLE `pasture_rotation_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`herd_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`input_snapshot_json` text NOT NULL,
	`plan_json` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pasture_rotation_plans_herd_check" CHECK(length(trim("pasture_rotation_plans"."herd_id")) BETWEEN 1 AND 160),
	CONSTRAINT "pasture_rotation_plans_operation_check" CHECK(length(trim("pasture_rotation_plans"."operation_id")) BETWEEN 8 AND 160),
	CONSTRAINT "pasture_rotation_plans_request_hash_check" CHECK(length("pasture_rotation_plans"."request_hash") = 64 AND "pasture_rotation_plans"."request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "pasture_rotation_plans_status_check" CHECK("pasture_rotation_plans"."status" IN ('feasible', 'infeasible')),
	CONSTRAINT "pasture_rotation_plans_json_check" CHECK(
      json_valid("pasture_rotation_plans"."input_snapshot_json") AND json_type("pasture_rotation_plans"."input_snapshot_json") = 'object'
      AND json_valid("pasture_rotation_plans"."plan_json") AND json_type("pasture_rotation_plans"."plan_json") = 'object'
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pasture_rotation_plans_operation_unique` ON `pasture_rotation_plans` (`organization_id`,`field_id`,`operation_id`);--> statement-breakpoint
CREATE INDEX `pasture_rotation_plans_scope_status_idx` ON `pasture_rotation_plans` (`organization_id`,`field_id`,`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `personal_data_events` (
	`id` text PRIMARY KEY NOT NULL,
	`identity_id` text NOT NULL,
	`organization_id` text,
	`request_id` text NOT NULL,
	`event_type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`payload_json` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "personal_data_events_type_check" CHECK("personal_data_events"."event_type" IN (
        'legal.acceptance.recorded',
        'account.closure.requested',
        'account.closure.revoked',
        'workspace.exported'
      )),
	CONSTRAINT "personal_data_events_entity_type_check" CHECK("personal_data_events"."entity_type" IN ('legal_acceptance', 'account_closure', 'workspace_export')),
	CONSTRAINT "personal_data_events_request_check" CHECK(length("personal_data_events"."request_id") BETWEEN 1 AND 160),
	CONSTRAINT "personal_data_events_payload_check" CHECK(json_valid("personal_data_events"."payload_json") AND json_type("personal_data_events"."payload_json") = 'object'),
	CONSTRAINT "personal_data_events_time_check" CHECK(datetime("personal_data_events"."occurred_at") IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personal_data_events_identity_request_type_unique` ON `personal_data_events` (`identity_id`,`request_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `personal_data_events_identity_time_idx` ON `personal_data_events` (`identity_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `personal_data_events_organization_time_idx` ON `personal_data_events` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `personal_data_events_entity_idx` ON `personal_data_events` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE TABLE `platform_staff_bootstrap_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`normalized_email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`principal_id` text,
	`created_at` integer NOT NULL,
	`claimed_at` integer,
	`disabled_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "platform_staff_bootstrap_claims_id_check" CHECK(typeof("platform_staff_bootstrap_claims"."id") = 'text' AND length(trim("platform_staff_bootstrap_claims"."id")) BETWEEN 1 AND 160),
	CONSTRAINT "platform_staff_bootstrap_claims_email_check" CHECK(typeof("platform_staff_bootstrap_claims"."normalized_email") = 'text'
        AND length("platform_staff_bootstrap_claims"."normalized_email") BETWEEN 3 AND 320
        AND "platform_staff_bootstrap_claims"."normalized_email" = lower(trim("platform_staff_bootstrap_claims"."normalized_email"))
        AND instr("platform_staff_bootstrap_claims"."normalized_email", '@') > 1
        AND instr("platform_staff_bootstrap_claims"."normalized_email", '@') < length("platform_staff_bootstrap_claims"."normalized_email")
        AND instr(
          substr("platform_staff_bootstrap_claims"."normalized_email", instr("platform_staff_bootstrap_claims"."normalized_email", '@') + 1),
          '@'
        ) = 0),
	CONSTRAINT "platform_staff_bootstrap_claims_status_check" CHECK(typeof("platform_staff_bootstrap_claims"."status") = 'text'
        AND "platform_staff_bootstrap_claims"."status" IN ('pending', 'claimed', 'disabled')),
	CONSTRAINT "platform_staff_bootstrap_claims_version_check" CHECK(typeof("platform_staff_bootstrap_claims"."version") = 'integer' AND "platform_staff_bootstrap_claims"."version" > 0),
	CONSTRAINT "platform_staff_bootstrap_claims_lifecycle_check" CHECK(typeof("platform_staff_bootstrap_claims"."created_at") = 'integer'
        AND ("platform_staff_bootstrap_claims"."claimed_at" IS NULL OR typeof("platform_staff_bootstrap_claims"."claimed_at") = 'integer')
        AND ("platform_staff_bootstrap_claims"."disabled_at" IS NULL OR typeof("platform_staff_bootstrap_claims"."disabled_at") = 'integer')
        AND "platform_staff_bootstrap_claims"."created_at" >= 0
        AND (
          (
            "platform_staff_bootstrap_claims"."status" = 'pending'
            AND "platform_staff_bootstrap_claims"."principal_id" IS NULL
            AND "platform_staff_bootstrap_claims"."claimed_at" IS NULL
            AND "platform_staff_bootstrap_claims"."disabled_at" IS NULL
          )
          OR (
            "platform_staff_bootstrap_claims"."status" = 'claimed'
            AND "platform_staff_bootstrap_claims"."principal_id" IS NOT NULL
            AND "platform_staff_bootstrap_claims"."claimed_at" IS NOT NULL
            AND "platform_staff_bootstrap_claims"."claimed_at" >= "platform_staff_bootstrap_claims"."created_at"
            AND "platform_staff_bootstrap_claims"."disabled_at" IS NULL
          )
          OR (
            "platform_staff_bootstrap_claims"."status" = 'disabled'
            AND "platform_staff_bootstrap_claims"."principal_id" IS NULL
            AND "platform_staff_bootstrap_claims"."claimed_at" IS NULL
            AND "platform_staff_bootstrap_claims"."disabled_at" IS NOT NULL
            AND "platform_staff_bootstrap_claims"."disabled_at" >= "platform_staff_bootstrap_claims"."created_at"
          )
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_staff_bootstrap_claims_email_unique` ON `platform_staff_bootstrap_claims` (`normalized_email`);--> statement-breakpoint
CREATE INDEX `platform_staff_bootstrap_claims_status_idx` ON `platform_staff_bootstrap_claims` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `platform_staff_bootstrap_claims_principal_idx` ON `platform_staff_bootstrap_claims` (`principal_id`);--> statement-breakpoint
CREATE TABLE `platform_staff_capability_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`capability` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`granted_by_principal_id` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_by_principal_id` text,
	`revoked_at` integer,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`granted_by_principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "platform_staff_capability_grants_id_check" CHECK(typeof("platform_staff_capability_grants"."id") = 'text' AND length(trim("platform_staff_capability_grants"."id")) BETWEEN 1 AND 160),
	CONSTRAINT "platform_staff_capability_grants_capability_check" CHECK(typeof("platform_staff_capability_grants"."capability") = 'text'
      AND "platform_staff_capability_grants"."capability" IN (
        'support:read',
        'tenants:manage',
        'flags:manage',
        'audit:read',
        'operations:sensitive',
        'staff:manage'
      )),
	CONSTRAINT "platform_staff_capability_grants_status_check" CHECK(typeof("platform_staff_capability_grants"."status") = 'text' AND "platform_staff_capability_grants"."status" IN ('active', 'revoked')),
	CONSTRAINT "platform_staff_capability_grants_reason_check" CHECK(typeof("platform_staff_capability_grants"."reason") = 'text'
        AND length(trim("platform_staff_capability_grants"."reason")) BETWEEN 3 AND 1000),
	CONSTRAINT "platform_staff_capability_grants_version_check" CHECK(typeof("platform_staff_capability_grants"."version") = 'integer' AND "platform_staff_capability_grants"."version" > 0),
	CONSTRAINT "platform_staff_capability_grants_lifecycle_check" CHECK(typeof("platform_staff_capability_grants"."granted_at") = 'integer'
        AND ("platform_staff_capability_grants"."revoked_at" IS NULL OR typeof("platform_staff_capability_grants"."revoked_at") = 'integer')
        AND "platform_staff_capability_grants"."granted_at" >= 0
        AND (
          (
            "platform_staff_capability_grants"."status" = 'active'
            AND "platform_staff_capability_grants"."revoked_by_principal_id" IS NULL
            AND "platform_staff_capability_grants"."revoked_at" IS NULL
          )
          OR (
            "platform_staff_capability_grants"."status" = 'revoked'
            AND "platform_staff_capability_grants"."revoked_by_principal_id" IS NOT NULL
            AND "platform_staff_capability_grants"."revoked_at" IS NOT NULL
            AND "platform_staff_capability_grants"."revoked_at" >= "platform_staff_capability_grants"."granted_at"
          )
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_staff_capability_grants_active_unique` ON `platform_staff_capability_grants` (`principal_id`,`capability`) WHERE "platform_staff_capability_grants"."status" = 'active';--> statement-breakpoint
CREATE INDEX `platform_staff_capability_grants_principal_status_idx` ON `platform_staff_capability_grants` (`principal_id`,`status`);--> statement-breakpoint
CREATE INDEX `platform_staff_capability_grants_capability_status_idx` ON `platform_staff_capability_grants` (`capability`,`status`);--> statement-breakpoint
CREATE INDEX `platform_staff_capability_grants_granted_by_idx` ON `platform_staff_capability_grants` (`granted_by_principal_id`);--> statement-breakpoint
CREATE INDEX `platform_staff_capability_grants_revoked_by_idx` ON `platform_staff_capability_grants` (`revoked_by_principal_id`);--> statement-breakpoint
CREATE TABLE `platform_staff_elevations` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`principal_id` text NOT NULL,
	`auth_session_token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`auth_session_token_hash`) REFERENCES `auth_sessions`(`token_hash`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "platform_staff_elevations_token_hash_check" CHECK(typeof("platform_staff_elevations"."token_hash") = 'text'
        AND length("platform_staff_elevations"."token_hash") = 64
        AND "platform_staff_elevations"."token_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "platform_staff_elevations_session_hash_check" CHECK(typeof("platform_staff_elevations"."auth_session_token_hash") = 'text'
        AND length("platform_staff_elevations"."auth_session_token_hash") = 64
        AND "platform_staff_elevations"."auth_session_token_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "platform_staff_elevations_lifetime_check" CHECK(typeof("platform_staff_elevations"."created_at") = 'integer'
        AND typeof("platform_staff_elevations"."expires_at") = 'integer'
        AND ("platform_staff_elevations"."revoked_at" IS NULL OR typeof("platform_staff_elevations"."revoked_at") = 'integer')
        AND "platform_staff_elevations"."created_at" >= 0
        AND "platform_staff_elevations"."expires_at" > "platform_staff_elevations"."created_at"
        AND "platform_staff_elevations"."expires_at" <= "platform_staff_elevations"."created_at" + 900
        AND (
          "platform_staff_elevations"."revoked_at" IS NULL
          OR (
            "platform_staff_elevations"."revoked_at" >= "platform_staff_elevations"."created_at"
            AND "platform_staff_elevations"."revoked_at" <= "platform_staff_elevations"."expires_at"
          )
        ))
);
--> statement-breakpoint
CREATE INDEX `platform_staff_elevations_principal_expiry_idx` ON `platform_staff_elevations` (`principal_id`,`expires_at`);--> statement-breakpoint
CREATE INDEX `platform_staff_elevations_session_idx` ON `platform_staff_elevations` (`auth_session_token_hash`);--> statement-breakpoint
CREATE INDEX `platform_staff_elevations_expiry_idx` ON `platform_staff_elevations` (`expires_at`,`revoked_at`);--> statement-breakpoint
CREATE TABLE `platform_staff_events` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_principal_id` text,
	`action` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`organization_id` text,
	`reason` text,
	`before_json` text,
	`after_json` text,
	`request_id` text NOT NULL,
	`idempotency_key_hash` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`actor_principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "platform_staff_events_id_check" CHECK(typeof("platform_staff_events"."id") = 'text' AND length(trim("platform_staff_events"."id")) BETWEEN 1 AND 160),
	CONSTRAINT "platform_staff_events_actor_check" CHECK(typeof("platform_staff_events"."actor_type") = 'text'
      AND (
          "platform_staff_events"."actor_type" = 'system'
          AND "platform_staff_events"."actor_principal_id" IS NULL
          AND "platform_staff_events"."idempotency_key_hash" IS NULL
          AND (
            "platform_staff_events"."reason" IS NULL
            OR (
              typeof("platform_staff_events"."reason") = 'text'
              AND length(trim("platform_staff_events"."reason")) BETWEEN 3 AND 1000
            )
          )
        )
        OR (
          "platform_staff_events"."actor_type" = 'staff'
          AND "platform_staff_events"."actor_principal_id" IS NOT NULL
          AND "platform_staff_events"."reason" IS NOT NULL
          AND typeof("platform_staff_events"."reason") = 'text'
          AND length(trim("platform_staff_events"."reason")) BETWEEN 3 AND 1000
          AND "platform_staff_events"."idempotency_key_hash" IS NOT NULL
        )),
	CONSTRAINT "platform_staff_events_action_check" CHECK(typeof("platform_staff_events"."action") = 'text'
        AND length(trim("platform_staff_events"."action")) BETWEEN 5 AND 160
        AND "platform_staff_events"."action" = trim("platform_staff_events"."action")
        AND instr("platform_staff_events"."action", '.v') > 1
        AND length(substr("platform_staff_events"."action", instr("platform_staff_events"."action", '.v') + 2)) >= 1
        AND substr("platform_staff_events"."action", instr("platform_staff_events"."action", '.v') + 2, 1) BETWEEN '1' AND '9'
        AND substr("platform_staff_events"."action", instr("platform_staff_events"."action", '.v') + 2) NOT GLOB '*[^0-9]*'),
	CONSTRAINT "platform_staff_events_target_check" CHECK(typeof("platform_staff_events"."target_type") = 'text'
        AND typeof("platform_staff_events"."target_id") = 'text'
        AND length(trim("platform_staff_events"."target_type")) BETWEEN 1 AND 80
        AND length(trim("platform_staff_events"."target_id")) BETWEEN 1 AND 160),
	CONSTRAINT "platform_staff_events_json_check" CHECK(("platform_staff_events"."before_json" IS NULL OR (
          typeof("platform_staff_events"."before_json") = 'text'
          AND json_valid("platform_staff_events"."before_json")
          AND json_type("platform_staff_events"."before_json") = 'object'
        ))
        AND ("platform_staff_events"."after_json" IS NULL OR (
          typeof("platform_staff_events"."after_json") = 'text'
          AND json_valid("platform_staff_events"."after_json")
          AND json_type("platform_staff_events"."after_json") = 'object'
        ))
        AND ("platform_staff_events"."before_json" IS NOT NULL OR "platform_staff_events"."after_json" IS NOT NULL)),
	CONSTRAINT "platform_staff_events_request_check" CHECK(typeof("platform_staff_events"."request_id") = 'text'
        AND length(trim("platform_staff_events"."request_id")) BETWEEN 1 AND 180),
	CONSTRAINT "platform_staff_events_idempotency_check" CHECK("platform_staff_events"."idempotency_key_hash" IS NULL
        OR (
          typeof("platform_staff_events"."idempotency_key_hash") = 'text'
          AND length("platform_staff_events"."idempotency_key_hash") = 64
          AND "platform_staff_events"."idempotency_key_hash" NOT GLOB '*[^0-9a-f]*'
        )),
	CONSTRAINT "platform_staff_events_occurred_at_check" CHECK(typeof("platform_staff_events"."occurred_at") = 'integer' AND "platform_staff_events"."occurred_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_staff_events_staff_idempotency_unique` ON `platform_staff_events` (`actor_principal_id`,`idempotency_key_hash`) WHERE "platform_staff_events"."actor_type" = 'staff';--> statement-breakpoint
CREATE INDEX `platform_staff_events_occurred_idx` ON `platform_staff_events` (`occurred_at`,`id`);--> statement-breakpoint
CREATE INDEX `platform_staff_events_actor_occurred_idx` ON `platform_staff_events` (`actor_principal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `platform_staff_events_target_occurred_idx` ON `platform_staff_events` (`target_type`,`target_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `platform_staff_events_organization_occurred_idx` ON `platform_staff_events` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `platform_staff_principals` (
	`id` text PRIMARY KEY NOT NULL,
	`auth_identity_id` text NOT NULL,
	`normalized_email_snapshot` text NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_by_principal_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`suspended_at` integer,
	FOREIGN KEY (`auth_identity_id`) REFERENCES `auth_identities`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by_principal_id`) REFERENCES `platform_staff_principals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "platform_staff_principals_id_check" CHECK(typeof("platform_staff_principals"."id") = 'text'
      AND (
        (
          length("platform_staff_principals"."id") = 26
          AND substr("platform_staff_principals"."id", 1, 1) GLOB '[0-7]'
          AND "platform_staff_principals"."id" = upper("platform_staff_principals"."id")
          AND "platform_staff_principals"."id" NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
        )
        OR (
          length("platform_staff_principals"."id") = 36
          AND substr("platform_staff_principals"."id", 9, 1) = '-'
          AND substr("platform_staff_principals"."id", 14, 1) = '-'
          AND substr("platform_staff_principals"."id", 19, 1) = '-'
          AND substr("platform_staff_principals"."id", 24, 1) = '-'
          AND "platform_staff_principals"."id" = lower("platform_staff_principals"."id")
          AND length(replace("platform_staff_principals"."id", '-', '')) = 32
          AND replace("platform_staff_principals"."id", '-', '') NOT GLOB '*[^0-9a-f]*'
        )
      )),
	CONSTRAINT "platform_staff_principals_email_check" CHECK(typeof("platform_staff_principals"."normalized_email_snapshot") = 'text'
        AND length("platform_staff_principals"."normalized_email_snapshot") BETWEEN 3 AND 320
        AND "platform_staff_principals"."normalized_email_snapshot" = lower(trim("platform_staff_principals"."normalized_email_snapshot"))
        AND instr("platform_staff_principals"."normalized_email_snapshot", '@') > 1
        AND instr("platform_staff_principals"."normalized_email_snapshot", '@') < length("platform_staff_principals"."normalized_email_snapshot")
        AND instr(
          substr("platform_staff_principals"."normalized_email_snapshot", instr("platform_staff_principals"."normalized_email_snapshot", '@') + 1),
          '@'
        ) = 0),
	CONSTRAINT "platform_staff_principals_display_name_check" CHECK(typeof("platform_staff_principals"."display_name") = 'text'
        AND length(trim("platform_staff_principals"."display_name")) BETWEEN 1 AND 160),
	CONSTRAINT "platform_staff_principals_kind_check" CHECK(typeof("platform_staff_principals"."kind") = 'text' AND "platform_staff_principals"."kind" IN ('owner', 'staff')),
	CONSTRAINT "platform_staff_principals_status_check" CHECK(typeof("platform_staff_principals"."status") = 'text' AND "platform_staff_principals"."status" IN ('active', 'suspended')),
	CONSTRAINT "platform_staff_principals_version_check" CHECK(typeof("platform_staff_principals"."version") = 'integer' AND "platform_staff_principals"."version" > 0),
	CONSTRAINT "platform_staff_principals_timestamps_check" CHECK(typeof("platform_staff_principals"."created_at") = 'integer'
        AND typeof("platform_staff_principals"."updated_at") = 'integer'
        AND ("platform_staff_principals"."suspended_at" IS NULL OR typeof("platform_staff_principals"."suspended_at") = 'integer')
        AND "platform_staff_principals"."created_at" >= 0
        AND "platform_staff_principals"."updated_at" >= "platform_staff_principals"."created_at"
        AND (
          ("platform_staff_principals"."status" = 'active' AND "platform_staff_principals"."suspended_at" IS NULL)
          OR (
            "platform_staff_principals"."status" = 'suspended'
            AND "platform_staff_principals"."suspended_at" IS NOT NULL
            AND "platform_staff_principals"."suspended_at" >= "platform_staff_principals"."created_at"
            AND "platform_staff_principals"."suspended_at" <= "platform_staff_principals"."updated_at"
          )
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platform_staff_principals_auth_identity_unique` ON `platform_staff_principals` (`auth_identity_id`);--> statement-breakpoint
CREATE INDEX `platform_staff_principals_status_kind_idx` ON `platform_staff_principals` (`status`,`kind`,`id`);--> statement-breakpoint
CREATE INDEX `platform_staff_principals_creator_idx` ON `platform_staff_principals` (`created_by_principal_id`);--> statement-breakpoint
CREATE TABLE `product_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text,
	`reporter_membership_id` text NOT NULL,
	`reporter_email` text NOT NULL,
	`reporter_name` text NOT NULL,
	`plan_code` text NOT NULL,
	`category` text NOT NULL,
	`impact` text NOT NULL,
	`message` text NOT NULL,
	`contact_allowed` integer DEFAULT false NOT NULL,
	`submission_key` text NOT NULL,
	`page_path` text NOT NULL,
	`release_sha` text NOT NULL,
	`user_agent` text DEFAULT '' NOT NULL,
	`viewport_width` integer,
	`viewport_height` integer,
	`online` integer DEFAULT true NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`priority` text,
	`staff_note` text,
	`version` integer DEFAULT 1 NOT NULL,
	`last_event_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_feedback_reporter_email_check" CHECK(length("product_feedback"."reporter_email") BETWEEN 3 AND 320 AND "product_feedback"."reporter_email" = lower(trim("product_feedback"."reporter_email"))),
	CONSTRAINT "product_feedback_reporter_name_check" CHECK(length(trim("product_feedback"."reporter_name")) BETWEEN 1 AND 160),
	CONSTRAINT "product_feedback_plan_check" CHECK("product_feedback"."plan_code" IN ('legacy', 'free', 'pro')),
	CONSTRAINT "product_feedback_category_check" CHECK("product_feedback"."category" IN ('bug', 'improvement', 'recommendation')),
	CONSTRAINT "product_feedback_impact_check" CHECK("product_feedback"."impact" IN ('blocked', 'difficult', 'non_urgent')),
	CONSTRAINT "product_feedback_message_check" CHECK(length("product_feedback"."message") BETWEEN 10 AND 4000 AND "product_feedback"."message" = trim("product_feedback"."message")),
	CONSTRAINT "product_feedback_contact_check" CHECK("product_feedback"."contact_allowed" IN (0, 1)),
	CONSTRAINT "product_feedback_submission_key_check" CHECK(
        length("product_feedback"."submission_key") = 36
        AND "product_feedback"."submission_key" = lower("product_feedback"."submission_key")
        AND substr("product_feedback"."submission_key", 9, 1) = '-'
        AND substr("product_feedback"."submission_key", 14, 1) = '-'
        AND substr("product_feedback"."submission_key", 19, 1) = '-'
        AND substr("product_feedback"."submission_key", 24, 1) = '-'
        AND length(replace("product_feedback"."submission_key", '-', '')) = 32
        AND replace("product_feedback"."submission_key", '-', '') NOT GLOB '*[^0-9a-f]*'
        AND substr("product_feedback"."submission_key", 15, 1) GLOB '[1-5]'
        AND substr("product_feedback"."submission_key", 20, 1) GLOB '[89ab]'
      ),
	CONSTRAINT "product_feedback_page_path_check" CHECK(length("product_feedback"."page_path") BETWEEN 4 AND 1024 AND ("product_feedback"."page_path" = '/app' OR "product_feedback"."page_path" GLOB '/app/*')),
	CONSTRAINT "product_feedback_release_check" CHECK(length("product_feedback"."release_sha") BETWEEN 1 AND 128),
	CONSTRAINT "product_feedback_user_agent_check" CHECK(length("product_feedback"."user_agent") <= 512),
	CONSTRAINT "product_feedback_viewport_width_check" CHECK("product_feedback"."viewport_width" IS NULL OR "product_feedback"."viewport_width" BETWEEN 240 AND 10000),
	CONSTRAINT "product_feedback_viewport_height_check" CHECK("product_feedback"."viewport_height" IS NULL OR "product_feedback"."viewport_height" BETWEEN 240 AND 10000),
	CONSTRAINT "product_feedback_online_check" CHECK("product_feedback"."online" IN (0, 1)),
	CONSTRAINT "product_feedback_status_check" CHECK("product_feedback"."status" IN ('new', 'reviewing', 'planned', 'resolved', 'closed')),
	CONSTRAINT "product_feedback_priority_check" CHECK("product_feedback"."priority" IS NULL OR "product_feedback"."priority" IN ('p0', 'p1', 'p2', 'p3')),
	CONSTRAINT "product_feedback_staff_note_check" CHECK("product_feedback"."staff_note" IS NULL OR length("product_feedback"."staff_note") BETWEEN 1 AND 2000),
	CONSTRAINT "product_feedback_version_check" CHECK("product_feedback"."version" >= 1),
	CONSTRAINT "product_feedback_timestamp_check" CHECK(datetime("product_feedback"."created_at") IS NOT NULL AND datetime("product_feedback"."updated_at") IS NOT NULL AND "product_feedback"."updated_at" >= "product_feedback"."created_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_feedback_submission_unique` ON `product_feedback` (`reporter_membership_id`,`submission_key`);--> statement-breakpoint
CREATE INDEX `product_feedback_status_time_idx` ON `product_feedback` (`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `product_feedback_category_status_time_idx` ON `product_feedback` (`category`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `product_feedback_organization_time_idx` ON `product_feedback` (`organization_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `product_feedback_reporter_time_idx` ON `product_feedback` (`reporter_membership_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `product_feedback_events` (
	`id` text PRIMARY KEY NOT NULL,
	`feedback_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`event_type` text NOT NULL,
	`before_json` text,
	`after_json` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`feedback_id`) REFERENCES `product_feedback`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_feedback_events_actor_check" CHECK(length(trim("product_feedback_events"."actor_email")) BETWEEN 3 AND 320),
	CONSTRAINT "product_feedback_events_type_check" CHECK("product_feedback_events"."event_type" IN ('created', 'triage_updated')),
	CONSTRAINT "product_feedback_events_before_check" CHECK("product_feedback_events"."before_json" IS NULL OR (json_valid("product_feedback_events"."before_json") AND json_type("product_feedback_events"."before_json") = 'object')),
	CONSTRAINT "product_feedback_events_after_check" CHECK(json_valid("product_feedback_events"."after_json") AND json_type("product_feedback_events"."after_json") = 'object'),
	CONSTRAINT "product_feedback_events_time_check" CHECK(datetime("product_feedback_events"."occurred_at") IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX `product_feedback_events_feedback_time_idx` ON `product_feedback_events` (`feedback_id`,`occurred_at`,`id`);--> statement-breakpoint
CREATE TABLE `restore_confirmation_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`token_sha256` text NOT NULL,
	`backup_sha256` text NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "restore_confirmation_tokens_status_check" CHECK("restore_confirmation_tokens"."status" IN ('active', 'consumed', 'expired', 'revoked')),
	CONSTRAINT "restore_confirmation_tokens_hashes_check" CHECK(length("restore_confirmation_tokens"."token_sha256") = 64 AND length("restore_confirmation_tokens"."backup_sha256") = 64 AND length("restore_confirmation_tokens"."snapshot_sha256") = 64 AND length("restore_confirmation_tokens"."plan_sha256") = 64)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_confirmation_tokens_hash_unique` ON `restore_confirmation_tokens` (`token_sha256`);--> statement-breakpoint
CREATE INDEX `restore_confirmation_tokens_field_status_idx` ON `restore_confirmation_tokens` (`field_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `restore_confirmation_tokens_actor_idx` ON `restore_confirmation_tokens` (`organization_id`,`actor_email`,`created_at`);--> statement-breakpoint
CREATE TABLE `restore_recovery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`recovery_job_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`event_type` text NOT NULL,
	`job_status` text NOT NULL,
	`job_attempt_count` integer NOT NULL,
	`import_job_id` text,
	`object_status` text,
	`failure_code` text,
	`copied_object_count` integer NOT NULL,
	`compensated_object_count` integer NOT NULL,
	`applied_row_count` integer NOT NULL,
	`verified_row_count` integer NOT NULL,
	`evidence_version` integer DEFAULT 1 NOT NULL,
	`pre_restore_backup_sha256` text,
	`post_restore_sha256` text,
	`occurred_at` text NOT NULL,
	`previous_event_sha256` text,
	`event_sha256` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`recovery_job_id`) REFERENCES `restore_recovery_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "restore_recovery_events_type_check" CHECK("restore_recovery_events"."event_type" IN ('prepared', 'lease_claimed', 'lease_renewed', 'lease_recovered', 'lease_released', 'checkpoint_advanced', 'object_copied', 'object_verified', 'object_failed', 'compensation_started', 'object_compensated', 'succeeded', 'failed')),
	CONSTRAINT "restore_recovery_events_job_status_check" CHECK("restore_recovery_events"."job_status" IN ('prepared', 'copying', 'applying', 'verifying', 'succeeded', 'compensating', 'failed')),
	CONSTRAINT "restore_recovery_events_counts_check" CHECK("restore_recovery_events"."sequence_number" >= 0 AND "restore_recovery_events"."job_attempt_count" >= 0 AND "restore_recovery_events"."copied_object_count" >= 0 AND "restore_recovery_events"."compensated_object_count" >= 0 AND "restore_recovery_events"."applied_row_count" >= 0 AND "restore_recovery_events"."verified_row_count" >= 0),
	CONSTRAINT "restore_recovery_events_hashes_check" CHECK("restore_recovery_events"."id" = "restore_recovery_events"."event_sha256" AND length("restore_recovery_events"."event_sha256") = 64 AND (("restore_recovery_events"."sequence_number" = 0 AND "restore_recovery_events"."previous_event_sha256" IS NULL) OR ("restore_recovery_events"."sequence_number" > 0 AND length("restore_recovery_events"."previous_event_sha256") = 64))),
	CONSTRAINT "restore_recovery_events_failure_check" CHECK(("restore_recovery_events"."failure_code" IS NULL AND "restore_recovery_events"."event_type" NOT IN ('object_failed', 'compensation_started', 'failed')) OR ("restore_recovery_events"."failure_code" IN ('original_missing', 'original_hash_mismatch', 'schema_drift', 'snapshot_changed', 'plan_changed', 'foreign_key_violation', 'lease_lost', 'unknown_failure') AND "restore_recovery_events"."event_type" IN ('object_failed', 'compensation_started', 'failed'))),
	CONSTRAINT "restore_recovery_events_object_check" CHECK(
      ("restore_recovery_events"."event_type" = 'object_copied' AND "restore_recovery_events"."import_job_id" IS NOT NULL AND "restore_recovery_events"."object_status" = 'copied') OR
      ("restore_recovery_events"."event_type" = 'object_verified' AND "restore_recovery_events"."import_job_id" IS NOT NULL AND "restore_recovery_events"."object_status" = 'verified') OR
      ("restore_recovery_events"."event_type" = 'object_failed' AND "restore_recovery_events"."import_job_id" IS NOT NULL AND "restore_recovery_events"."object_status" = 'failed') OR
      ("restore_recovery_events"."event_type" = 'object_compensated' AND "restore_recovery_events"."import_job_id" IS NOT NULL AND "restore_recovery_events"."object_status" = 'compensated') OR
      ("restore_recovery_events"."event_type" NOT IN ('object_copied', 'object_verified', 'object_failed', 'object_compensated') AND "restore_recovery_events"."import_job_id" IS NULL AND "restore_recovery_events"."object_status" IS NULL)
    )
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_recovery_events_job_sequence_unique` ON `restore_recovery_events` (`recovery_job_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `restore_recovery_events_job_occurred_idx` ON `restore_recovery_events` (`recovery_job_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `restore_recovery_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`confirmation_token_id` text NOT NULL,
	`actor_email` text NOT NULL,
	`backup_sha256` text NOT NULL,
	`snapshot_sha256` text NOT NULL,
	`plan_sha256` text NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`execution_enabled` integer DEFAULT false NOT NULL,
	`expected_row_count` integer NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_expires_at` text,
	`object_cursor_import_job_id` text,
	`copied_object_count` integer DEFAULT 0 NOT NULL,
	`compensation_cursor_import_job_id` text,
	`compensated_object_count` integer DEFAULT 0 NOT NULL,
	`applied_row_count` integer DEFAULT 0 NOT NULL,
	`verified_row_count` integer DEFAULT 0 NOT NULL,
	`pre_restore_backup_object_key` text,
	`pre_restore_backup_sha256` text,
	`post_restore_sha256` text,
	`failure_code` text,
	`prepared_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`confirmation_token_id`) REFERENCES `restore_confirmation_tokens`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "restore_recovery_jobs_status_check" CHECK("restore_recovery_jobs"."status" IN ('prepared', 'copying', 'applying', 'verifying', 'succeeded', 'compensating', 'failed')),
	CONSTRAINT "restore_recovery_jobs_execution_disabled_check" CHECK("restore_recovery_jobs"."execution_enabled" = 0),
	CONSTRAINT "restore_recovery_jobs_counts_check" CHECK("restore_recovery_jobs"."expected_row_count" >= 0 AND "restore_recovery_jobs"."attempt_count" >= 0 AND "restore_recovery_jobs"."copied_object_count" >= 0 AND "restore_recovery_jobs"."compensated_object_count" >= 0 AND "restore_recovery_jobs"."applied_row_count" >= 0 AND "restore_recovery_jobs"."verified_row_count" >= 0),
	CONSTRAINT "restore_recovery_jobs_hashes_check" CHECK(length("restore_recovery_jobs"."backup_sha256") = 64 AND length("restore_recovery_jobs"."snapshot_sha256") = 64 AND length("restore_recovery_jobs"."plan_sha256") = 64 AND ("restore_recovery_jobs"."pre_restore_backup_sha256" IS NULL OR length("restore_recovery_jobs"."pre_restore_backup_sha256") = 64) AND ("restore_recovery_jobs"."post_restore_sha256" IS NULL OR length("restore_recovery_jobs"."post_restore_sha256") = 64)),
	CONSTRAINT "restore_recovery_jobs_lease_check" CHECK(("restore_recovery_jobs"."lease_token" IS NULL AND "restore_recovery_jobs"."lease_expires_at" IS NULL) OR ("restore_recovery_jobs"."lease_token" IS NOT NULL AND "restore_recovery_jobs"."lease_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_recovery_jobs_confirmation_unique` ON `restore_recovery_jobs` (`confirmation_token_id`);--> statement-breakpoint
CREATE INDEX `restore_recovery_jobs_status_lease_idx` ON `restore_recovery_jobs` (`status`,`lease_expires_at`,`updated_at`);--> statement-breakpoint
CREATE INDEX `restore_recovery_jobs_field_created_idx` ON `restore_recovery_jobs` (`field_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `restore_recovery_objects` (
	`id` text PRIMARY KEY NOT NULL,
	`recovery_job_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`sha256` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`destination_object_key` text,
	`was_preexisting` integer DEFAULT false NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_error_code` text,
	`copied_at` text,
	`verified_at` text,
	`compensated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`recovery_job_id`) REFERENCES `restore_recovery_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "restore_recovery_objects_status_check" CHECK("restore_recovery_objects"."status" IN ('pending', 'copied', 'verified', 'compensated', 'failed')),
	CONSTRAINT "restore_recovery_objects_values_check" CHECK("restore_recovery_objects"."sequence_number" >= 0 AND "restore_recovery_objects"."size_bytes" >= 0 AND "restore_recovery_objects"."attempt_count" >= 0 AND length("restore_recovery_objects"."sha256") = 64),
	CONSTRAINT "restore_recovery_objects_key_check" CHECK("restore_recovery_objects"."status" IN ('pending', 'failed') OR "restore_recovery_objects"."destination_object_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `restore_recovery_objects_job_import_unique` ON `restore_recovery_objects` (`recovery_job_id`,`import_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `restore_recovery_objects_job_sequence_unique` ON `restore_recovery_objects` (`recovery_job_id`,`sequence_number`);--> statement-breakpoint
CREATE INDEX `restore_recovery_objects_job_status_idx` ON `restore_recovery_objects` (`recovery_job_id`,`status`,`sequence_number`);--> statement-breakpoint
CREATE TABLE `scheduled_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`field_id` text,
	`type` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`due_at` text NOT NULL,
	`interval_seconds` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`last_started_at` text,
	`last_completed_at` text,
	`last_error_type` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "scheduled_jobs_status_check" CHECK("scheduled_jobs"."status" IN ('active', 'paused')),
	CONSTRAINT "scheduled_jobs_interval_check" CHECK("scheduled_jobs"."interval_seconds" BETWEEN 60 AND 31536000),
	CONSTRAINT "scheduled_jobs_attempt_check" CHECK("scheduled_jobs"."attempt_count" >= 0),
	CONSTRAINT "scheduled_jobs_scope_check" CHECK("scheduled_jobs"."field_id" IS NULL OR "scheduled_jobs"."organization_id" IS NOT NULL),
	CONSTRAINT "scheduled_jobs_payload_check" CHECK(json_valid("scheduled_jobs"."payload") AND json_type("scheduled_jobs"."payload") = 'object')
);
--> statement-breakpoint
CREATE INDEX `scheduled_jobs_due_idx` ON `scheduled_jobs` (`status`,`due_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `scheduled_jobs_scope_type_idx` ON `scheduled_jobs` (`organization_id`,`field_id`,`type`);--> statement-breakpoint
CREATE TABLE `paddock_subdivision_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`field_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`history` text NOT NULL,
	`line` text DEFAULT '[]' NOT NULL,
	`base_snapshot_token` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "paddock_subdivision_drafts_scope_kind_check" CHECK("paddock_subdivision_drafts"."scope_kind" IN ('field', 'paddock'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `paddock_subdivision_drafts_scope_unique` ON `paddock_subdivision_drafts` (`field_id`,`scope_kind`,`scope_id`);--> statement-breakpoint
CREATE INDEX `paddock_subdivision_drafts_field_idx` ON `paddock_subdivision_drafts` (`field_id`);--> statement-breakpoint
CREATE TABLE `soil_analysis_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`paddock_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`provider_key` text NOT NULL,
	`profile_key` text NOT NULL,
	`profile_version` text NOT NULL,
	`folio` text NOT NULL,
	`sample_id` text NOT NULL,
	`received_date` text NOT NULL,
	`report_date` text NOT NULL,
	`analysis_type` text NOT NULL,
	`sampled_by` text,
	`reported_sampling_depth_cm` real,
	`ideal_range_reference_depth_cm` real,
	`analytical_methods_text` text NOT NULL,
	`accreditation_claim_status` text NOT NULL,
	`signature_status` text NOT NULL,
	`qr_status` text NOT NULL,
	`documentary_use` text NOT NULL,
	`snapshot_json` text NOT NULL,
	`confirmed_by` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paddock_id`) REFERENCES `potreros`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`import_job_id`) REFERENCES `import_jobs`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`,`paddock_id`) REFERENCES `potreros`(`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "soil_analysis_reports_provider_check" CHECK("soil_analysis_reports"."provider_key" = 'cooprinsem'),
	CONSTRAINT "soil_analysis_reports_profile_check" CHECK(length(trim("soil_analysis_reports"."profile_key")) > 0 AND length(trim("soil_analysis_reports"."profile_version")) > 0),
	CONSTRAINT "soil_analysis_reports_identity_check" CHECK(length(trim("soil_analysis_reports"."folio")) BETWEEN 3 AND 80 AND length(trim("soil_analysis_reports"."sample_id")) BETWEEN 1 AND 80),
	CONSTRAINT "soil_analysis_reports_dates_check" CHECK(
      "soil_analysis_reports"."received_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND "soil_analysis_reports"."report_date" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      AND "soil_analysis_reports"."received_date" <= "soil_analysis_reports"."report_date"
    ),
	CONSTRAINT "soil_analysis_reports_depth_check" CHECK(
      ("soil_analysis_reports"."reported_sampling_depth_cm" IS NULL OR "soil_analysis_reports"."reported_sampling_depth_cm" BETWEEN 0.1 AND 200)
      AND ("soil_analysis_reports"."ideal_range_reference_depth_cm" IS NULL OR "soil_analysis_reports"."ideal_range_reference_depth_cm" BETWEEN 0.1 AND 200)
    ),
	CONSTRAINT "soil_analysis_reports_methods_check" CHECK(length(trim("soil_analysis_reports"."analytical_methods_text")) BETWEEN 80 AND 8000),
	CONSTRAINT "soil_analysis_reports_accreditation_check" CHECK("soil_analysis_reports"."accreditation_claim_status" IN ('reported_unverified', 'not_reported')),
	CONSTRAINT "soil_analysis_reports_signature_check" CHECK("soil_analysis_reports"."signature_status" IN ('not_checked', 'present_unverified', 'verified', 'absent')),
	CONSTRAINT "soil_analysis_reports_qr_check" CHECK("soil_analysis_reports"."qr_status" IN ('not_checked', 'present_unverified', 'verified', 'absent')),
	CONSTRAINT "soil_analysis_reports_use_check" CHECK("soil_analysis_reports"."documentary_use" = 'technical_result_only'),
	CONSTRAINT "soil_analysis_reports_snapshot_check" CHECK(json_valid("soil_analysis_reports"."snapshot_json") AND json_type("soil_analysis_reports"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `soil_analysis_reports_import_job_unique` ON `soil_analysis_reports` (`import_job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `soil_analysis_reports_scope_id_unique` ON `soil_analysis_reports` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `soil_analysis_reports_field_folio_unique` ON `soil_analysis_reports` (`organization_id`,`field_id`,`provider_key`,`folio`);--> statement-breakpoint
CREATE INDEX `soil_analysis_reports_paddock_date_idx` ON `soil_analysis_reports` (`field_id`,`paddock_id`,`report_date`);--> statement-breakpoint
CREATE TABLE `soil_analysis_results` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`report_id` text NOT NULL,
	`import_job_id` text NOT NULL,
	`import_row_id` text NOT NULL,
	`sequence_number` integer NOT NULL,
	`analyte_code` text NOT NULL,
	`analyte_name` text NOT NULL,
	`unit` text NOT NULL,
	`value` real NOT NULL,
	`ideal_min` real NOT NULL,
	`ideal_max` real NOT NULL,
	`ideal_range_text` text NOT NULL,
	`reported_classification` text,
	`range_assessment` text NOT NULL,
	`method_key` text,
	`method_label` text,
	`snapshot_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`report_id`) REFERENCES `soil_analysis_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_row_id`) REFERENCES `import_rows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`report_id`) REFERENCES `soil_analysis_reports`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_job_id`,`import_row_id`) REFERENCES `import_rows`(`import_job_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "soil_analysis_results_sequence_check" CHECK("soil_analysis_results"."sequence_number" > 0),
	CONSTRAINT "soil_analysis_results_identity_check" CHECK(
      length(trim("soil_analysis_results"."analyte_code")) BETWEEN 1 AND 80
      AND length(trim("soil_analysis_results"."analyte_name")) BETWEEN 1 AND 120
      AND length(trim("soil_analysis_results"."unit")) BETWEEN 1 AND 40
    ),
	CONSTRAINT "soil_analysis_results_range_check" CHECK("soil_analysis_results"."ideal_min" <= "soil_analysis_results"."ideal_max"),
	CONSTRAINT "soil_analysis_results_assessment_check" CHECK("soil_analysis_results"."range_assessment" IN ('below', 'within', 'above')),
	CONSTRAINT "soil_analysis_results_method_check" CHECK(
      ("soil_analysis_results"."method_key" IS NULL AND "soil_analysis_results"."method_label" IS NULL)
      OR (
        length(trim("soil_analysis_results"."method_key")) BETWEEN 1 AND 120
        AND length(trim("soil_analysis_results"."method_label")) BETWEEN 1 AND 240
      )
    ),
	CONSTRAINT "soil_analysis_results_snapshot_check" CHECK(json_valid("soil_analysis_results"."snapshot_json") AND json_type("soil_analysis_results"."snapshot_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `soil_analysis_results_report_sequence_unique` ON `soil_analysis_results` (`report_id`,`sequence_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `soil_analysis_results_report_analyte_unique` ON `soil_analysis_results` (`report_id`,`analyte_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `soil_analysis_results_import_row_unique` ON `soil_analysis_results` (`import_row_id`);--> statement-breakpoint
CREATE INDEX `soil_analysis_results_field_analyte_idx` ON `soil_analysis_results` (`field_id`,`analyte_code`,`created_at`);--> statement-breakpoint
CREATE TABLE `source_records` (
	`id` text PRIMARY KEY NOT NULL,
	`import_job_id` text NOT NULL,
	`import_row_id` text NOT NULL,
	`source_system` text DEFAULT 'cooprinsem' NOT NULL,
	`source_table` text NOT NULL,
	`source_key` text,
	`target_entity` text NOT NULL,
	`target_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`import_job_id`) REFERENCES `import_jobs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`import_row_id`) REFERENCES `import_rows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `source_records_row_target_unique` ON `source_records` (`import_row_id`,`target_entity`,`target_id`);--> statement-breakpoint
CREATE INDEX `source_records_target_idx` ON `source_records` (`target_entity`,`target_id`);--> statement-breakpoint
CREATE INDEX `source_records_job_idx` ON `source_records` (`import_job_id`);--> statement-breakpoint
CREATE TABLE `subdivision_drafts` (
	`field_id` text PRIMARY KEY NOT NULL,
	`history` text NOT NULL,
	`line` text DEFAULT '[]' NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sync_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`actor` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`op` text NOT NULL,
	`payload` text NOT NULL,
	`client_ts` text NOT NULL,
	`expected_version` text,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`applied_at` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`conflict_reason` text,
	`event_id` text,
	`server_version` text,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sync_mutations_status_check" CHECK("sync_mutations"."status" IN ('pending', 'applied', 'conflict', 'rejected')),
	CONSTRAINT "sync_mutations_op_check" CHECK("sync_mutations"."op" IN ('create', 'update', 'append')),
	CONSTRAINT "sync_mutations_payload_check" CHECK(json_valid("sync_mutations"."payload") AND json_type("sync_mutations"."payload") = 'object'),
	CONSTRAINT "sync_mutations_terminal_check" CHECK(("sync_mutations"."status" = 'pending' AND "sync_mutations"."applied_at" IS NULL) OR ("sync_mutations"."status" <> 'pending' AND "sync_mutations"."applied_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX `sync_mutations_scope_received_idx` ON `sync_mutations` (`organization_id`,`field_id`,`received_at`,`id`);--> statement-breakpoint
CREATE INDEX `sync_mutations_actor_status_idx` ON `sync_mutations` (`organization_id`,`actor`,`status`);--> statement-breakpoint
CREATE TABLE `traceability_declarations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`establishment_id` text NOT NULL,
	`period` integer NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`as_of_date` text NOT NULL,
	`counts` text NOT NULL,
	`total_animals` integer NOT NULL,
	`inventory_hash` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`folio` text,
	`form_version` text NOT NULL,
	`document_object_key` text,
	`document_sha256` text,
	`document_etag` text,
	`document_size_bytes` integer,
	`document_status` text,
	`declared_at` text,
	`annulled_at` text,
	`annulment_reason` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`establishment_id`) REFERENCES `traceability_establishments`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "traceability_declarations_period_check" CHECK("traceability_declarations"."period" BETWEEN 2000 AND 2100),
	CONSTRAINT "traceability_declarations_revision_check" CHECK("traceability_declarations"."revision" >= 1),
	CONSTRAINT "traceability_declarations_counts_check" CHECK(json_valid("traceability_declarations"."counts") AND json_type("traceability_declarations"."counts") = 'object'),
	CONSTRAINT "traceability_declarations_total_check" CHECK("traceability_declarations"."total_animals" >= 0),
	CONSTRAINT "traceability_declarations_hashes_check" CHECK(length("traceability_declarations"."inventory_hash") = 64 AND "traceability_declarations"."inventory_hash" NOT GLOB '*[^0-9a-f]*' AND length("traceability_declarations"."request_hash") = 64 AND "traceability_declarations"."request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "traceability_declarations_status_check" CHECK("traceability_declarations"."status" IN ('draft', 'declared', 'annulled')),
	CONSTRAINT "traceability_declarations_document_hash_check" CHECK("traceability_declarations"."document_sha256" IS NULL OR (length("traceability_declarations"."document_sha256") = 64 AND "traceability_declarations"."document_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "traceability_declarations_document_size_check" CHECK("traceability_declarations"."document_size_bytes" IS NULL OR "traceability_declarations"."document_size_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "traceability_declarations_document_status_check" CHECK("traceability_declarations"."document_status" IS NULL OR "traceability_declarations"."document_status" IN ('pending', 'stored', 'compensation_pending')),
	CONSTRAINT "traceability_declarations_declared_check" CHECK("traceability_declarations"."status" = 'draft' OR ("traceability_declarations"."folio" IS NOT NULL AND "traceability_declarations"."declared_at" IS NOT NULL AND "traceability_declarations"."document_status" = 'stored' AND "traceability_declarations"."document_object_key" IS NOT NULL AND "traceability_declarations"."document_sha256" IS NOT NULL)),
	CONSTRAINT "traceability_declarations_annulled_check" CHECK("traceability_declarations"."status" <> 'annulled' OR ("traceability_declarations"."annulled_at" IS NOT NULL AND length(trim("traceability_declarations"."annulment_reason")) > 0)),
	CONSTRAINT "traceability_declarations_version_check" CHECK("traceability_declarations"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_declarations_scope_id_unique` ON `traceability_declarations` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_declarations_revision_unique` ON `traceability_declarations` (`organization_id`,`establishment_id`,`period`,`revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_declarations_request_unique` ON `traceability_declarations` (`organization_id`,`field_id`,`request_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_declarations_document_key_unique` ON `traceability_declarations` (`document_object_key`) WHERE "traceability_declarations"."document_object_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `traceability_declarations_scope_period_idx` ON `traceability_declarations` (`organization_id`,`field_id`,`period`,`status`);--> statement-breakpoint
CREATE TABLE `traceability_diios` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`establishment_id` text NOT NULL,
	`official_number` text NOT NULL,
	`normalized_number` text NOT NULL,
	`device_type` text NOT NULL,
	`rfid_id` text,
	`animal_id` text,
	`status` text DEFAULT 'available' NOT NULL,
	`assigned_at` text,
	`ended_at` text,
	`replaces_device_id` text,
	`replaced_by_device_id` text,
	`last_transition_key` text,
	`effective_at` text NOT NULL,
	`replacement_for_id` text,
	`status_reason` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`establishment_id`) REFERENCES `traceability_establishments`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`replaces_device_id`) REFERENCES `traceability_diios`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`replaced_by_device_id`) REFERENCES `traceability_diios`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`replacement_for_id`) REFERENCES `traceability_diios`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "traceability_diios_number_check" CHECK(length("traceability_diios"."normalized_number") = 9 AND "traceability_diios"."normalized_number" NOT GLOB '*[^0-9]*'),
	CONSTRAINT "traceability_diios_device_check" CHECK("traceability_diios"."device_type" IN ('double_ear_tag', 'ear_button', 'ruminal_bolus')),
	CONSTRAINT "traceability_diios_status_check" CHECK("traceability_diios"."status" IN ('available', 'assigned', 'lost', 'replaced', 'retired')),
	CONSTRAINT "traceability_diios_assignment_check" CHECK(("traceability_diios"."status" = 'available' AND "traceability_diios"."animal_id" IS NULL AND "traceability_diios"."assigned_at" IS NULL AND "traceability_diios"."ended_at" IS NULL) OR ("traceability_diios"."status" = 'assigned' AND "traceability_diios"."animal_id" IS NOT NULL AND "traceability_diios"."assigned_at" IS NOT NULL AND "traceability_diios"."ended_at" IS NULL) OR ("traceability_diios"."status" IN ('lost', 'replaced', 'retired') AND "traceability_diios"."ended_at" IS NOT NULL)),
	CONSTRAINT "traceability_diios_lineage_check" CHECK(("traceability_diios"."replaces_device_id" IS NULL OR "traceability_diios"."replaces_device_id" <> "traceability_diios"."id") AND ("traceability_diios"."replaced_by_device_id" IS NULL OR "traceability_diios"."replaced_by_device_id" <> "traceability_diios"."id")),
	CONSTRAINT "traceability_diios_version_check" CHECK("traceability_diios"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_diios_scope_id_unique` ON `traceability_diios` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_diios_number_unique` ON `traceability_diios` (`organization_id`,`normalized_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_diios_active_animal_unique` ON `traceability_diios` (`organization_id`,`animal_id`) WHERE "traceability_diios"."status" = 'assigned' AND "traceability_diios"."animal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_diios_active_rfid_unique` ON `traceability_diios` (`organization_id`,`rfid_id`) WHERE "traceability_diios"."status" = 'assigned' AND "traceability_diios"."rfid_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `traceability_diios_scope_status_idx` ON `traceability_diios` (`organization_id`,`field_id`,`status`);--> statement-breakpoint
CREATE INDEX `traceability_diios_establishment_status_idx` ON `traceability_diios` (`establishment_id`,`status`);--> statement-breakpoint
CREATE INDEX `traceability_diios_animal_idx` ON `traceability_diios` (`animal_id`);--> statement-breakpoint
CREATE INDEX `traceability_diios_transition_key_idx` ON `traceability_diios` (`organization_id`,`field_id`,`last_transition_key`);--> statement-breakpoint
CREATE TABLE `traceability_establishments` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`rup` text NOT NULL,
	`normalized_rup` text NOT NULL,
	`kind` text DEFAULT 'dairy' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`georef` text,
	`holder_rut` text NOT NULL,
	`holder_name` text NOT NULL,
	`commune` text NOT NULL,
	`address` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "traceability_establishments_rup_check" CHECK(length("traceability_establishments"."normalized_rup") BETWEEN 4 AND 32 AND "traceability_establishments"."normalized_rup" NOT GLOB '*[^0-9A-Z.-]*'),
	CONSTRAINT "traceability_establishments_kind_check" CHECK("traceability_establishments"."kind" IN ('dairy', 'beef', 'mixed', 'other')),
	CONSTRAINT "traceability_establishments_status_check" CHECK("traceability_establishments"."status" IN ('active', 'inactive')),
	CONSTRAINT "traceability_establishments_georef_check" CHECK("traceability_establishments"."georef" IS NULL OR (json_valid("traceability_establishments"."georef") AND json_type("traceability_establishments"."georef") = 'object')),
	CONSTRAINT "traceability_establishments_holder_check" CHECK(length(trim("traceability_establishments"."holder_rut")) BETWEEN 9 AND 16 AND length(trim("traceability_establishments"."holder_name")) BETWEEN 2 AND 200),
	CONSTRAINT "traceability_establishments_location_check" CHECK(length(trim("traceability_establishments"."commune")) BETWEEN 2 AND 120 AND length(trim("traceability_establishments"."address")) BETWEEN 2 AND 300),
	CONSTRAINT "traceability_establishments_version_check" CHECK("traceability_establishments"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_establishments_scope_id_unique` ON `traceability_establishments` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_establishments_rup_unique` ON `traceability_establishments` (`organization_id`,`normalized_rup`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_establishments_active_field_unique` ON `traceability_establishments` (`organization_id`,`field_id`) WHERE "traceability_establishments"."status" = 'active';--> statement-breakpoint
CREATE INDEX `traceability_establishments_scope_status_idx` ON `traceability_establishments` (`organization_id`,`field_id`,`status`);--> statement-breakpoint
CREATE TABLE `traceability_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`animal_id` text,
	`diio_id` text,
	`payload` text DEFAULT '{}' NOT NULL,
	`domain_event_id` text NOT NULL,
	`actor` text NOT NULL,
	`occurred_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`domain_event_id`) REFERENCES `domain_events`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`diio_id`) REFERENCES `traceability_diios`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "traceability_events_payload_check" CHECK(json_valid("traceability_events"."payload") AND json_type("traceability_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_events_id_unique` ON `traceability_events` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_events_domain_event_id_unique` ON `traceability_events` (`domain_event_id`);--> statement-breakpoint
CREATE INDEX `traceability_events_scope_cursor_idx` ON `traceability_events` (`organization_id`,`field_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `traceability_events_entity_cursor_idx` ON `traceability_events` (`organization_id`,`field_id`,`entity_type`,`entity_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `traceability_events_animal_cursor_idx` ON `traceability_events` (`animal_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `traceability_import_stages` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`establishment_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`canonical_stage` text NOT NULL,
	`stage_hash` text NOT NULL,
	`result` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`row_count` integer NOT NULL,
	`expires_at` text NOT NULL,
	`committed_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`establishment_id`) REFERENCES `traceability_establishments`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "traceability_import_stages_source_check" CHECK("traceability_import_stages"."source_kind" IN ('sipec_file', 'cliex_dbf', 'manual_template')),
	CONSTRAINT "traceability_import_stages_stage_hash_check" CHECK(length("traceability_import_stages"."stage_hash") = 64 AND "traceability_import_stages"."stage_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "traceability_import_stages_result_check" CHECK(json_valid("traceability_import_stages"."result") AND json_type("traceability_import_stages"."result") = 'object'),
	CONSTRAINT "traceability_import_stages_status_check" CHECK("traceability_import_stages"."status" IN ('staged', 'committed', 'expired')),
	CONSTRAINT "traceability_import_stages_row_count_check" CHECK("traceability_import_stages"."row_count" BETWEEN 0 AND 5000),
	CONSTRAINT "traceability_import_stages_commit_check" CHECK(("traceability_import_stages"."status" = 'committed') = ("traceability_import_stages"."committed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_import_stages_scope_id_unique` ON `traceability_import_stages` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_import_stages_scope_hash_unique` ON `traceability_import_stages` (`organization_id`,`field_id`,`stage_hash`);--> statement-breakpoint
CREATE INDEX `traceability_import_stages_scope_status_expiry_idx` ON `traceability_import_stages` (`organization_id`,`field_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `traceability_movement_items` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`movement_id` text NOT NULL,
	`diio_id` text NOT NULL,
	`animal_id` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`animal_id`) REFERENCES `livestock_animals`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`movement_id`) REFERENCES `traceability_movements`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`diio_id`) REFERENCES `traceability_diios`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_movement_items_movement_diio_unique` ON `traceability_movement_items` (`movement_id`,`diio_id`);--> statement-breakpoint
CREATE INDEX `traceability_movement_items_scope_movement_idx` ON `traceability_movement_items` (`organization_id`,`field_id`,`movement_id`);--> statement-breakpoint
CREATE INDEX `traceability_movement_items_animal_idx` ON `traceability_movement_items` (`animal_id`);--> statement-breakpoint
CREATE TABLE `traceability_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`field_id` text NOT NULL,
	`establishment_id` text NOT NULL,
	`origin_rup` text NOT NULL,
	`destination_rup` text NOT NULL,
	`departure_at` text NOT NULL,
	`expected_arrival_at` text NOT NULL,
	`carrier` text NOT NULL,
	`carrier_rut` text NOT NULL,
	`vehicle_plate` text NOT NULL,
	`trailer_plate` text,
	`reason` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`folio` text,
	`form_version` text NOT NULL,
	`request_hash` text NOT NULL,
	`document_object_key` text,
	`document_sha256` text,
	`document_etag` text,
	`document_size_bytes` integer,
	`document_status` text,
	`supersedes_movement_id` text,
	`issued_at` text,
	`annulled_at` text,
	`annulment_reason` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`field_id`) REFERENCES `fields`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`) REFERENCES `fields`(`organization_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`establishment_id`) REFERENCES `traceability_establishments`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`,`field_id`,`supersedes_movement_id`) REFERENCES `traceability_movements`(`organization_id`,`field_id`,`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "traceability_movements_status_check" CHECK("traceability_movements"."status" IN ('draft', 'issued', 'annulled')),
	CONSTRAINT "traceability_movements_dates_check" CHECK("traceability_movements"."expected_arrival_at" >= "traceability_movements"."departure_at"),
	CONSTRAINT "traceability_movements_request_hash_check" CHECK(length("traceability_movements"."request_hash") = 64 AND "traceability_movements"."request_hash" NOT GLOB '*[^0-9a-f]*'),
	CONSTRAINT "traceability_movements_document_hash_check" CHECK("traceability_movements"."document_sha256" IS NULL OR (length("traceability_movements"."document_sha256") = 64 AND "traceability_movements"."document_sha256" NOT GLOB '*[^0-9a-f]*')),
	CONSTRAINT "traceability_movements_document_size_check" CHECK("traceability_movements"."document_size_bytes" IS NULL OR "traceability_movements"."document_size_bytes" BETWEEN 1 AND 10485760),
	CONSTRAINT "traceability_movements_document_status_check" CHECK("traceability_movements"."document_status" IS NULL OR "traceability_movements"."document_status" IN ('pending', 'stored', 'compensation_pending')),
	CONSTRAINT "traceability_movements_issued_check" CHECK("traceability_movements"."status" = 'draft' OR ("traceability_movements"."folio" IS NOT NULL AND "traceability_movements"."issued_at" IS NOT NULL AND "traceability_movements"."document_status" = 'stored' AND "traceability_movements"."document_object_key" IS NOT NULL AND "traceability_movements"."document_sha256" IS NOT NULL)),
	CONSTRAINT "traceability_movements_annulled_check" CHECK("traceability_movements"."status" <> 'annulled' OR ("traceability_movements"."annulled_at" IS NOT NULL AND length(trim("traceability_movements"."annulment_reason")) > 0)),
	CONSTRAINT "traceability_movements_version_check" CHECK("traceability_movements"."version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_movements_scope_id_unique` ON `traceability_movements` (`organization_id`,`field_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_movements_request_unique` ON `traceability_movements` (`organization_id`,`field_id`,`request_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_movements_folio_unique` ON `traceability_movements` (`organization_id`,`field_id`,`folio`) WHERE "traceability_movements"."folio" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `traceability_movements_document_key_unique` ON `traceability_movements` (`document_object_key`) WHERE "traceability_movements"."document_object_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `traceability_movements_scope_status_date_idx` ON `traceability_movements` (`organization_id`,`field_id`,`status`,`departure_at`);