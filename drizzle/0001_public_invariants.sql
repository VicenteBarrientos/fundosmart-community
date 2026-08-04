-- Invariantes consolidadas del esquema público; no contiene datos semilla.
-- Consolidado para el baseline comunitario y ordenado por nombre.
CREATE TRIGGER `account_closure_requests_no_delete`
BEFORE DELETE ON `account_closure_requests`
BEGIN
	SELECT RAISE(ABORT, 'account_closure_requests_retained');
END;
--> statement-breakpoint
CREATE TRIGGER `account_closure_requests_snapshot_guard`
BEFORE INSERT ON `account_closure_requests`
WHEN
	length(NEW.`snapshot_json`) > 1000000
	OR json_type(NEW.`snapshot_json`, '$.memberships') IS NOT 'array'
	OR (SELECT COUNT(*) FROM json_each(NEW.`snapshot_json`)) <> 1
	OR EXISTS (
		SELECT 1 FROM json_each(NEW.`snapshot_json`) AS root
		WHERE root.`key` <> 'memberships'
	)
	OR EXISTS (
		SELECT 1
		FROM json_each(NEW.`snapshot_json`, '$.memberships') AS snapshot
		WHERE snapshot.`type` <> 'object'
			OR (SELECT COUNT(*) FROM json_each(snapshot.`value`)) <> 5
			OR EXISTS (
				SELECT 1 FROM json_each(snapshot.`value`) AS property
				WHERE property.`key` NOT IN ('id', 'organizationId', 'role', 'status', 'fieldIds')
			)
			OR json_type(snapshot.`value`, '$.id') IS NOT 'text'
			OR json_type(snapshot.`value`, '$.organizationId') IS NOT 'text'
			OR json_type(snapshot.`value`, '$.role') IS NOT 'text'
			OR json_extract(snapshot.`value`, '$.role') NOT IN ('owner', 'admin', 'manager', 'operator', 'viewer')
			OR json_type(snapshot.`value`, '$.status') IS NOT 'text'
			OR json_extract(snapshot.`value`, '$.status') NOT IN ('active', 'suspended')
			OR json_type(snapshot.`value`, '$.fieldIds') IS NOT 'array'
			OR EXISTS (
				SELECT 1 FROM json_each(snapshot.`value`, '$.fieldIds') AS field
				WHERE field.`type` <> 'text'
			)
			OR (
				SELECT COUNT(*) FROM json_each(snapshot.`value`, '$.fieldIds')
			) <> (
				SELECT COUNT(DISTINCT field.`value`)
				FROM json_each(snapshot.`value`, '$.fieldIds') AS field
			)
	)
	OR (
		SELECT COUNT(*) FROM json_each(NEW.`snapshot_json`, '$.memberships')
	) <> (
		SELECT COUNT(DISTINCT json_extract(snapshot.`value`, '$.id'))
		FROM json_each(NEW.`snapshot_json`, '$.memberships') AS snapshot
	)
	OR EXISTS (
		SELECT 1
		FROM `organization_memberships` AS membership
		WHERE (
			(NEW.`scope` = 'organization' AND membership.`organization_id` = NEW.`target_id`)
			OR (
				NEW.`scope` = 'account'
				AND membership.`normalized_email` = (
					SELECT identity.`normalized_email`
					FROM `auth_identities` AS identity
					WHERE identity.`id` = NEW.`target_id`
				)
			)
		)
			AND NOT EXISTS (
				SELECT 1
				FROM json_each(NEW.`snapshot_json`, '$.memberships') AS snapshot
				WHERE json_extract(snapshot.`value`, '$.id') = membership.`id`
			)
	)
	OR EXISTS (
		SELECT 1
		FROM json_each(NEW.`snapshot_json`, '$.memberships') AS snapshot
		LEFT JOIN `organization_memberships` AS membership
			ON membership.`id` = json_extract(snapshot.`value`, '$.id')
		WHERE membership.`id` IS NULL
			OR membership.`organization_id` <> json_extract(snapshot.`value`, '$.organizationId')
			OR membership.`role` <> json_extract(snapshot.`value`, '$.role')
			OR NOT (
				(
					membership.`closure_request_id` IS NULL
					AND membership.`status` = json_extract(snapshot.`value`, '$.status')
				)
				OR (
					membership.`closure_request_id` IS NOT NULL
					AND membership.`status` = 'suspended'
					AND EXISTS (
						SELECT 1
						FROM `account_closure_requests` AS linked_request
						INNER JOIN json_each(
							linked_request.`snapshot_json`,
							'$.memberships'
						) AS linked_snapshot
						WHERE linked_request.`id` = membership.`closure_request_id`
							AND linked_request.`status` = 'grace'
							AND json_extract(linked_snapshot.`value`, '$.id') = membership.`id`
							AND (
								(
									NEW.`requested_at` <= linked_request.`grace_ends_at`
									AND json_extract(linked_snapshot.`value`, '$.status')
										= json_extract(snapshot.`value`, '$.status')
								)
								OR (
									NEW.`requested_at` > linked_request.`grace_ends_at`
									AND json_extract(snapshot.`value`, '$.status') = 'suspended'
								)
							)
					)
				)
			)
			OR NOT (
				(NEW.`scope` = 'organization' AND membership.`organization_id` = NEW.`target_id`)
				OR (
					NEW.`scope` = 'account'
					AND membership.`normalized_email` = (
						SELECT identity.`normalized_email`
						FROM `auth_identities` AS identity
						WHERE identity.`id` = NEW.`target_id`
					)
				)
			)
	)
	OR EXISTS (
		SELECT 1
		FROM json_each(NEW.`snapshot_json`, '$.memberships') AS snapshot
		INNER JOIN `membership_field_access` AS access
			ON access.`membership_id` = json_extract(snapshot.`value`, '$.id')
		WHERE NOT EXISTS (
			SELECT 1
			FROM json_each(snapshot.`value`, '$.fieldIds') AS field
			WHERE field.`value` = access.`field_id`
		)
	)
	OR EXISTS (
		SELECT 1
		FROM json_each(NEW.`snapshot_json`, '$.memberships') AS snapshot
		INNER JOIN json_each(snapshot.`value`, '$.fieldIds') AS field
		WHERE NOT EXISTS (
			SELECT 1
			FROM `membership_field_access` AS access
			WHERE access.`membership_id` = json_extract(snapshot.`value`, '$.id')
				AND access.`field_id` = field.`value`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_SNAPSHOT_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `account_closure_requests_target_guard`
BEFORE INSERT ON `account_closure_requests`
WHEN
	(
		NEW.`scope` = 'account'
		AND (
			NEW.`target_id` <> NEW.`actor_identity_id`
			OR NOT EXISTS (
				SELECT 1 FROM `auth_identities`
				WHERE `id` = NEW.`target_id`
			)
		)
	)
	OR (
		NEW.`scope` = 'organization'
		AND (
			NOT EXISTS (
				SELECT 1 FROM `organizations`
				WHERE `id` = NEW.`target_id`
					AND `kind` <> 'demo'
			)
			OR NOT EXISTS (
				SELECT 1
				FROM `auth_identities` AS identity
				INNER JOIN `organization_memberships` AS membership
					ON membership.`normalized_email` = identity.`normalized_email`
				WHERE identity.`id` = NEW.`actor_identity_id`
					AND membership.`organization_id` = NEW.`target_id`
					AND membership.`role` = 'owner'
					AND membership.`status` = 'active'
					AND membership.`closure_request_id` IS NULL
			)
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'account_closure_target_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `account_closure_requests_transition_guard`
BEFORE UPDATE ON `account_closure_requests`
WHEN NOT (
	OLD.`status` = 'grace'
	AND NEW.`status` = 'revoked'
	AND OLD.`revoked_at` IS NULL
	AND NEW.`revoked_at` IS NOT NULL
	AND NEW.`revoked_at` >= OLD.`requested_at`
	AND NEW.`revoked_at` <= OLD.`grace_ends_at`
	AND NEW.`version` = OLD.`version` + 1
	AND NEW.`id` = OLD.`id`
	AND NEW.`scope` = OLD.`scope`
	AND NEW.`target_id` = OLD.`target_id`
	AND NEW.`actor_identity_id` = OLD.`actor_identity_id`
	AND NEW.`request_id` = OLD.`request_id`
	AND NEW.`requested_at` = OLD.`requested_at`
	AND NEW.`grace_ends_at` = OLD.`grace_ends_at`
	AND NEW.`snapshot_version` = OLD.`snapshot_version`
	AND NEW.`snapshot_json` = OLD.`snapshot_json`
	AND EXISTS (
		SELECT 1
		FROM `personal_data_events` AS event
		WHERE event.`event_type` = 'account.closure.revoked'
			AND event.`entity_type` = 'account_closure'
			AND event.`entity_id` = OLD.`id`
			AND event.`identity_id` = OLD.`actor_identity_id`
			AND event.`occurred_at` = NEW.`revoked_at`
			AND (
				(OLD.`scope` = 'account' AND event.`organization_id` IS NULL)
				OR (
					OLD.`scope` = 'organization'
					AND event.`organization_id` = OLD.`target_id`
				)
			)
			AND json_extract(event.`payload_json`, '$.scope') = OLD.`scope`
			AND json_extract(event.`payload_json`, '$.targetId') = OLD.`target_id`
			AND json_extract(event.`payload_json`, '$.restoredSnapshotVersion') = OLD.`snapshot_version`
	)
)
BEGIN
	SELECT RAISE(ABORT, 'account_closure_transition_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_events_no_delete`
BEFORE DELETE ON `agenda_task_events`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_EVENT_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_events_no_update`
BEFORE UPDATE ON `agenda_task_events`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_EVENT_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_operations_no_delete`
BEFORE DELETE ON `agenda_task_operations`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_OPERATION_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_operations_no_update`
BEFORE UPDATE ON `agenda_task_operations`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_OPERATION_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_states_identity_immutable`
BEFORE UPDATE ON `agenda_task_states`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`organization_id` IS NOT OLD.`organization_id`
  OR NEW.`field_id` IS NOT OLD.`field_id`
  OR NEW.`item_key` IS NOT OLD.`item_key`
  OR NEW.`signal_revision` IS NOT OLD.`signal_revision`
  OR NEW.`source` IS NOT OLD.`source`
  OR NEW.`created_by_membership_id` IS NOT OLD.`created_by_membership_id`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_IDENTITY_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_states_lifecycle_versioned`
BEFORE UPDATE ON `agenda_task_states`
FOR EACH ROW WHEN
  NEW.`version` <> OLD.`version` + 1
  OR NEW.`updated_at` <= OLD.`updated_at`
  OR NEW.`last_operation_id` IS OLD.`last_operation_id`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_LIFECYCLE_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `agenda_task_states_no_delete`
BEFORE DELETE ON `agenda_task_states`
BEGIN
  SELECT RAISE(ABORT, 'AGENDA_TASK_STATE_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete`
BEFORE DELETE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_update`
BEFORE UPDATE ON `audit_log`
BEGIN
	SELECT RAISE(ABORT, 'audit_log_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `benchmark_positions_insert_privacy_guard`
BEFORE INSERT ON `benchmark_positions`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `benchmark_aggregates`
	WHERE `cohort_key` = NEW.`cohort_key`
		AND `period` = NEW.`period`
		AND `metric_key` = NEW.`metric_key`
		AND `schema_version` = NEW.`schema_version`
		AND `status` = 'published'
) OR NOT EXISTS (
	SELECT 1 FROM `fields`
	WHERE `organization_id` = NEW.`organization_id`
		AND `id` = NEW.`field_id`
		AND `is_demo` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark_position_privacy_guard');
END;
--> statement-breakpoint
CREATE TRIGGER `benchmark_positions_update_privacy_guard`
BEFORE UPDATE ON `benchmark_positions`
FOR EACH ROW
WHEN NOT EXISTS (
	SELECT 1 FROM `benchmark_aggregates`
	WHERE `cohort_key` = NEW.`cohort_key`
		AND `period` = NEW.`period`
		AND `metric_key` = NEW.`metric_key`
		AND `schema_version` = NEW.`schema_version`
		AND `status` = 'published'
) OR NOT EXISTS (
	SELECT 1 FROM `fields`
	WHERE `organization_id` = NEW.`organization_id`
		AND `id` = NEW.`field_id`
		AND `is_demo` = 0
)
BEGIN
	SELECT RAISE(ABORT, 'benchmark_position_privacy_guard');
END;
--> statement-breakpoint
CREATE TRIGGER `cooprinsem_history_unit_contracts_no_delete`
BEFORE DELETE ON `cooprinsem_history_unit_contracts`
BEGIN
	SELECT RAISE(ABORT, 'cooprinsem_history_unit_contracts_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `cooprinsem_history_unit_contracts_no_update`
BEFORE UPDATE ON `cooprinsem_history_unit_contracts`
BEGIN
	SELECT RAISE(ABORT, 'cooprinsem_history_unit_contracts_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `domain_events_no_delete`
BEFORE DELETE ON `domain_events`
BEGIN
	SELECT RAISE(ABORT, 'domain_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `domain_events_no_update`
BEFORE UPDATE ON `domain_events`
BEGIN
	SELECT RAISE(ABORT, 'domain_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `legal_acceptances_evidence_guard`
BEFORE INSERT ON `legal_acceptances`
WHEN NOT (
	json_valid(NEW.`evidence_json`)
	AND json_type(NEW.`evidence_json`) = 'object'
	AND (SELECT COUNT(*) FROM json_each(NEW.`evidence_json`)) = 8
	AND json_extract(NEW.`evidence_json`, '$.evidenceVersion') = NEW.`evidence_version`
	AND json_extract(NEW.`evidence_json`, '$.source') = 'authenticated_web'
	AND json_extract(NEW.`evidence_json`, '$.confirmed') = 1
	AND json_extract(NEW.`evidence_json`, '$.requestId') = NEW.`request_id`
	AND json_extract(NEW.`evidence_json`, '$.acceptedAt') = NEW.`accepted_at`
	AND json_extract(NEW.`evidence_json`, '$.identityId') = NEW.`identity_id`
	AND (
		json_type(NEW.`evidence_json`, '$.userAgentSha256') = 'null'
		OR (
			json_type(NEW.`evidence_json`, '$.userAgentSha256') = 'text'
			AND length(json_extract(NEW.`evidence_json`, '$.userAgentSha256')) = 64
			AND json_extract(NEW.`evidence_json`, '$.userAgentSha256') NOT GLOB '*[^a-f0-9]*'
		)
	)
	AND json_type(NEW.`evidence_json`, '$.document') = 'object'
	AND (SELECT COUNT(*) FROM json_each(NEW.`evidence_json`, '$.document')) = 5
	AND json_extract(NEW.`evidence_json`, '$.document.kind') = NEW.`document_kind`
	AND json_extract(NEW.`evidence_json`, '$.document.version') = NEW.`document_version`
	AND json_extract(NEW.`evidence_json`, '$.document.publishedOn') = NEW.`document_published_on`
	AND json_extract(NEW.`evidence_json`, '$.document.contentSha256') = NEW.`document_content_sha256`
	AND json_extract(NEW.`evidence_json`, '$.document.route') = CASE NEW.`document_kind`
		WHEN 'privacy' THEN '/privacidad'
		WHEN 'terms' THEN '/terminos'
	END
)
BEGIN
	SELECT RAISE(ABORT, 'legal_acceptance_evidence_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `legal_acceptances_no_delete`
BEFORE DELETE ON `legal_acceptances`
BEGIN
	SELECT RAISE(ABORT, 'legal_acceptances_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `legal_acceptances_no_update`
BEFORE UPDATE ON `legal_acceptances`
BEGIN
	SELECT RAISE(ABORT, 'legal_acceptances_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `membership_field_access_closure_frozen_delete`
BEFORE DELETE ON `membership_field_access`
WHEN EXISTS (
	SELECT 1
	FROM `organization_memberships` AS membership
	WHERE membership.`id` = OLD.`membership_id`
		AND (
			EXISTS (
				SELECT 1 FROM `account_closure_requests` AS request
				WHERE request.`id` = membership.`closure_request_id`
					AND request.`status` = 'grace'
					AND (
						request.`scope` = 'organization'
						OR strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
							<= request.`grace_ends_at`
					)
			)
			OR EXISTS (
				SELECT 1 FROM `account_closure_requests` AS request
				WHERE request.`scope` = 'organization'
					AND request.`target_id` = membership.`organization_id`
					AND request.`status` = 'grace'
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_FIELD_ACCESS_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `membership_field_access_closure_frozen_insert`
BEFORE INSERT ON `membership_field_access`
WHEN EXISTS (
	SELECT 1
	FROM `organization_memberships` AS membership
	WHERE membership.`id` = NEW.`membership_id`
		AND (
			EXISTS (
				SELECT 1 FROM `account_closure_requests` AS request
				WHERE request.`id` = membership.`closure_request_id`
					AND request.`status` = 'grace'
					AND (
						request.`scope` = 'organization'
						OR strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
							<= request.`grace_ends_at`
					)
			)
			OR EXISTS (
				SELECT 1 FROM `account_closure_requests` AS request
				WHERE request.`scope` = 'organization'
					AND request.`target_id` = membership.`organization_id`
					AND request.`status` = 'grace'
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_FIELD_ACCESS_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `membership_field_access_closure_frozen_update`
BEFORE UPDATE ON `membership_field_access`
WHEN EXISTS (
	SELECT 1
	FROM `organization_memberships` AS membership
	WHERE membership.`id` IN (OLD.`membership_id`, NEW.`membership_id`)
		AND (
			EXISTS (
				SELECT 1 FROM `account_closure_requests` AS request
				WHERE request.`id` = membership.`closure_request_id`
					AND request.`status` = 'grace'
					AND (
						request.`scope` = 'organization'
						OR strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
							<= request.`grace_ends_at`
					)
			)
			OR EXISTS (
				SELECT 1 FROM `account_closure_requests` AS request
				WHERE request.`scope` = 'organization'
					AND request.`target_id` = membership.`organization_id`
					AND request.`status` = 'grace'
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_FIELD_ACCESS_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `milk_settlements_integrity_insert`
BEFORE INSERT ON `milk_settlements`
FOR EACH ROW
WHEN NOT (
	typeof(NEW.`id`) = 'text'
	AND length(trim(NEW.`id`)) > 0
	AND length(NEW.`id`) <= 200
	AND typeof(NEW.`field_id`) = 'text'
	AND length(trim(NEW.`field_id`)) > 0
	AND length(NEW.`field_id`) <= 200
	AND typeof(NEW.`period`) = 'text'
	AND length(NEW.`period`) = 7
	AND NEW.`period` GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
	AND substr(NEW.`period`, 6, 2) BETWEEN '01' AND '12'
	AND (
		NEW.`generated_at` IS NULL
		OR (
			typeof(NEW.`generated_at`) = 'text'
			AND length(NEW.`generated_at`) BETWEEN 10 AND 29
			AND substr(NEW.`generated_at`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
			AND date(substr(NEW.`generated_at`, 1, 10), '+0 days') = substr(NEW.`generated_at`, 1, 10)
			AND (
				length(NEW.`generated_at`) = 10
				OR (
					substr(NEW.`generated_at`, 11, 1) IN ('T', ' ')
					AND substr(NEW.`generated_at`, 12, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`generated_at`, 12, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`generated_at`, 14, 1) = ':'
					AND substr(NEW.`generated_at`, 15, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`generated_at`, 15, 2) AS integer) BETWEEN 0 AND 59
					AND substr(NEW.`generated_at`, 17, 1) = ':'
					AND substr(NEW.`generated_at`, 18, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`generated_at`, 18, 2) AS integer) BETWEEN 0 AND 59
					AND (
						length(NEW.`generated_at`) = 19
						OR (length(NEW.`generated_at`) = 20 AND substr(NEW.`generated_at`, 20, 1) = 'Z')
						OR (
							length(NEW.`generated_at`) = 24
							AND substr(NEW.`generated_at`, 20, 1) = '.'
							AND substr(NEW.`generated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
							AND substr(NEW.`generated_at`, 24, 1) = 'Z'
						)
						OR (
							length(NEW.`generated_at`) = 25
							AND substr(NEW.`generated_at`, 20, 1) IN ('+', '-')
							AND substr(NEW.`generated_at`, 21, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 21, 2) AS integer) BETWEEN 0 AND 23
							AND substr(NEW.`generated_at`, 23, 1) = ':'
							AND substr(NEW.`generated_at`, 24, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 24, 2) AS integer) BETWEEN 0 AND 59
						)
						OR (
							length(NEW.`generated_at`) = 29
							AND substr(NEW.`generated_at`, 20, 1) = '.'
							AND substr(NEW.`generated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
							AND substr(NEW.`generated_at`, 24, 1) IN ('+', '-')
							AND substr(NEW.`generated_at`, 25, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 25, 2) AS integer) BETWEEN 0 AND 23
							AND substr(NEW.`generated_at`, 27, 1) = ':'
							AND substr(NEW.`generated_at`, 28, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 28, 2) AS integer) BETWEEN 0 AND 59
						)
					)
				)
			)
			AND julianday(NEW.`generated_at`) IS NOT NULL
		)
	)
	AND typeof(NEW.`plant`) = 'text'
	AND length(NEW.`plant`) <= 300
	AND typeof(NEW.`purchase_order`) = 'text'
	AND length(trim(NEW.`purchase_order`)) > 0
	AND length(NEW.`purchase_order`) <= 200
	AND typeof(NEW.`producer_code`) = 'text'
	AND length(NEW.`producer_code`) <= 200
	AND typeof(NEW.`producer_name`) = 'text'
	AND length(trim(NEW.`producer_name`)) > 0
	AND length(NEW.`producer_name`) <= 300
	AND typeof(NEW.`buyer_name`) = 'text'
	AND length(trim(NEW.`buyer_name`)) > 0
	AND length(NEW.`buyer_name`) <= 300
	AND typeof(NEW.`total_liters`) IN ('integer', 'real')
	AND NEW.`total_liters` > 0
	AND abs(NEW.`total_liters`) < 1e308
	AND (
		NEW.`liters_first_half` IS NULL
		OR (
			typeof(NEW.`liters_first_half`) IN ('integer', 'real')
			AND NEW.`liters_first_half` >= 0
			AND abs(NEW.`liters_first_half`) < 1e308
		)
	)
	AND (
		NEW.`liters_second_half` IS NULL
		OR (
			typeof(NEW.`liters_second_half`) IN ('integer', 'real')
			AND NEW.`liters_second_half` >= 0
			AND abs(NEW.`liters_second_half`) < 1e308
		)
	)
	AND (
		(NEW.`liters_first_half` IS NULL AND NEW.`liters_second_half` IS NULL)
		OR abs(
			coalesce(NEW.`liters_first_half`, 0)
			+ coalesce(NEW.`liters_second_half`, 0)
			- NEW.`total_liters`
		) <= 0.0010000001
	)
	AND typeof(NEW.`net_amount_clp`) = 'integer'
	AND NEW.`net_amount_clp` BETWEEN 0 AND 9007199254740991
	AND typeof(NEW.`tax_amount_clp`) = 'integer'
	AND NEW.`tax_amount_clp` BETWEEN 0 AND 9007199254740991
	AND typeof(NEW.`gross_amount_clp`) = 'integer'
	AND NEW.`gross_amount_clp` BETWEEN 1 AND 9007199254740991
	AND NEW.`gross_amount_clp` = NEW.`net_amount_clp` + NEW.`tax_amount_clp`
	AND typeof(NEW.`net_price_per_liter_clp`) IN ('integer', 'real')
	AND NEW.`net_price_per_liter_clp` > 0
	AND abs(NEW.`net_price_per_liter_clp`) < 1e308
	AND abs(
		NEW.`net_price_per_liter_clp`
		- (1.0 * NEW.`net_amount_clp` / NEW.`total_liters`)
	) <= 0.01
	AND (
		NEW.`gross_price_per_liter_clp` IS NULL
		OR (
			typeof(NEW.`gross_price_per_liter_clp`) IN ('integer', 'real')
			AND NEW.`gross_price_per_liter_clp` > 0
			AND abs(NEW.`gross_price_per_liter_clp`) < 1e308
			AND abs(
				NEW.`gross_price_per_liter_clp`
				- (1.0 * NEW.`gross_amount_clp` / NEW.`total_liters`)
			) <= 0.01
		)
	)
	AND (
		NEW.`source_document_name` IS NULL
		OR (
			typeof(NEW.`source_document_name`) = 'text'
			AND length(trim(NEW.`source_document_name`)) > 0
			AND length(NEW.`source_document_name`) <= 500
		)
	)
	AND typeof(NEW.`notes`) = 'text'
	AND length(NEW.`notes`) <= 10000
	AND CASE
		WHEN typeof(NEW.`line_items`) = 'text' AND json_valid(NEW.`line_items`) = 1
		THEN json_type(NEW.`line_items`) = 'array' AND json_array_length(NEW.`line_items`) <= 200
		ELSE 0
	END
	AND typeof(NEW.`created_at`) = 'text'
	AND length(NEW.`created_at`) BETWEEN 10 AND 29
	AND substr(NEW.`created_at`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
	AND date(substr(NEW.`created_at`, 1, 10), '+0 days') = substr(NEW.`created_at`, 1, 10)
	AND (
		length(NEW.`created_at`) = 10
		OR (
			substr(NEW.`created_at`, 11, 1) IN ('T', ' ')
			AND substr(NEW.`created_at`, 12, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`created_at`, 12, 2) AS integer) BETWEEN 0 AND 23
			AND substr(NEW.`created_at`, 14, 1) = ':'
			AND substr(NEW.`created_at`, 15, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`created_at`, 15, 2) AS integer) BETWEEN 0 AND 59
			AND substr(NEW.`created_at`, 17, 1) = ':'
			AND substr(NEW.`created_at`, 18, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`created_at`, 18, 2) AS integer) BETWEEN 0 AND 59
			AND (
				length(NEW.`created_at`) = 19
				OR (length(NEW.`created_at`) = 20 AND substr(NEW.`created_at`, 20, 1) = 'Z')
				OR (
					length(NEW.`created_at`) = 24
					AND substr(NEW.`created_at`, 20, 1) = '.'
					AND substr(NEW.`created_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`created_at`, 24, 1) = 'Z'
				)
				OR (
					length(NEW.`created_at`) = 25
					AND substr(NEW.`created_at`, 20, 1) IN ('+', '-')
					AND substr(NEW.`created_at`, 21, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 21, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`created_at`, 23, 1) = ':'
					AND substr(NEW.`created_at`, 24, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 24, 2) AS integer) BETWEEN 0 AND 59
				)
				OR (
					length(NEW.`created_at`) = 29
					AND substr(NEW.`created_at`, 20, 1) = '.'
					AND substr(NEW.`created_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`created_at`, 24, 1) IN ('+', '-')
					AND substr(NEW.`created_at`, 25, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 25, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`created_at`, 27, 1) = ':'
					AND substr(NEW.`created_at`, 28, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 28, 2) AS integer) BETWEEN 0 AND 59
				)
			)
		)
	)
	AND julianday(NEW.`created_at`) IS NOT NULL
	AND typeof(NEW.`updated_at`) = 'text'
	AND length(NEW.`updated_at`) BETWEEN 10 AND 29
	AND substr(NEW.`updated_at`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
	AND date(substr(NEW.`updated_at`, 1, 10), '+0 days') = substr(NEW.`updated_at`, 1, 10)
	AND (
		length(NEW.`updated_at`) = 10
		OR (
			substr(NEW.`updated_at`, 11, 1) IN ('T', ' ')
			AND substr(NEW.`updated_at`, 12, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`updated_at`, 12, 2) AS integer) BETWEEN 0 AND 23
			AND substr(NEW.`updated_at`, 14, 1) = ':'
			AND substr(NEW.`updated_at`, 15, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`updated_at`, 15, 2) AS integer) BETWEEN 0 AND 59
			AND substr(NEW.`updated_at`, 17, 1) = ':'
			AND substr(NEW.`updated_at`, 18, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`updated_at`, 18, 2) AS integer) BETWEEN 0 AND 59
			AND (
				length(NEW.`updated_at`) = 19
				OR (length(NEW.`updated_at`) = 20 AND substr(NEW.`updated_at`, 20, 1) = 'Z')
				OR (
					length(NEW.`updated_at`) = 24
					AND substr(NEW.`updated_at`, 20, 1) = '.'
					AND substr(NEW.`updated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`updated_at`, 24, 1) = 'Z'
				)
				OR (
					length(NEW.`updated_at`) = 25
					AND substr(NEW.`updated_at`, 20, 1) IN ('+', '-')
					AND substr(NEW.`updated_at`, 21, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 21, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`updated_at`, 23, 1) = ':'
					AND substr(NEW.`updated_at`, 24, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 24, 2) AS integer) BETWEEN 0 AND 59
				)
				OR (
					length(NEW.`updated_at`) = 29
					AND substr(NEW.`updated_at`, 20, 1) = '.'
					AND substr(NEW.`updated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`updated_at`, 24, 1) IN ('+', '-')
					AND substr(NEW.`updated_at`, 25, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 25, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`updated_at`, 27, 1) = ':'
					AND substr(NEW.`updated_at`, 28, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 28, 2) AS integer) BETWEEN 0 AND 59
				)
			)
		)
	)
	AND julianday(NEW.`updated_at`) IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'milk_settlement_integrity_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `milk_settlements_integrity_update`
BEFORE UPDATE ON `milk_settlements`
FOR EACH ROW
WHEN NOT (
	typeof(NEW.`id`) = 'text'
	AND length(trim(NEW.`id`)) > 0
	AND length(NEW.`id`) <= 200
	AND typeof(NEW.`field_id`) = 'text'
	AND length(trim(NEW.`field_id`)) > 0
	AND length(NEW.`field_id`) <= 200
	AND typeof(NEW.`period`) = 'text'
	AND length(NEW.`period`) = 7
	AND NEW.`period` GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'
	AND substr(NEW.`period`, 6, 2) BETWEEN '01' AND '12'
	AND (
		NEW.`generated_at` IS NULL
		OR (
			typeof(NEW.`generated_at`) = 'text'
			AND length(NEW.`generated_at`) BETWEEN 10 AND 29
			AND substr(NEW.`generated_at`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
			AND date(substr(NEW.`generated_at`, 1, 10), '+0 days') = substr(NEW.`generated_at`, 1, 10)
			AND (
				length(NEW.`generated_at`) = 10
				OR (
					substr(NEW.`generated_at`, 11, 1) IN ('T', ' ')
					AND substr(NEW.`generated_at`, 12, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`generated_at`, 12, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`generated_at`, 14, 1) = ':'
					AND substr(NEW.`generated_at`, 15, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`generated_at`, 15, 2) AS integer) BETWEEN 0 AND 59
					AND substr(NEW.`generated_at`, 17, 1) = ':'
					AND substr(NEW.`generated_at`, 18, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`generated_at`, 18, 2) AS integer) BETWEEN 0 AND 59
					AND (
						length(NEW.`generated_at`) = 19
						OR (length(NEW.`generated_at`) = 20 AND substr(NEW.`generated_at`, 20, 1) = 'Z')
						OR (
							length(NEW.`generated_at`) = 24
							AND substr(NEW.`generated_at`, 20, 1) = '.'
							AND substr(NEW.`generated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
							AND substr(NEW.`generated_at`, 24, 1) = 'Z'
						)
						OR (
							length(NEW.`generated_at`) = 25
							AND substr(NEW.`generated_at`, 20, 1) IN ('+', '-')
							AND substr(NEW.`generated_at`, 21, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 21, 2) AS integer) BETWEEN 0 AND 23
							AND substr(NEW.`generated_at`, 23, 1) = ':'
							AND substr(NEW.`generated_at`, 24, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 24, 2) AS integer) BETWEEN 0 AND 59
						)
						OR (
							length(NEW.`generated_at`) = 29
							AND substr(NEW.`generated_at`, 20, 1) = '.'
							AND substr(NEW.`generated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
							AND substr(NEW.`generated_at`, 24, 1) IN ('+', '-')
							AND substr(NEW.`generated_at`, 25, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 25, 2) AS integer) BETWEEN 0 AND 23
							AND substr(NEW.`generated_at`, 27, 1) = ':'
							AND substr(NEW.`generated_at`, 28, 2) GLOB '[0-9][0-9]'
							AND CAST(substr(NEW.`generated_at`, 28, 2) AS integer) BETWEEN 0 AND 59
						)
					)
				)
			)
			AND julianday(NEW.`generated_at`) IS NOT NULL
		)
	)
	AND typeof(NEW.`plant`) = 'text'
	AND length(NEW.`plant`) <= 300
	AND typeof(NEW.`purchase_order`) = 'text'
	AND length(trim(NEW.`purchase_order`)) > 0
	AND length(NEW.`purchase_order`) <= 200
	AND typeof(NEW.`producer_code`) = 'text'
	AND length(NEW.`producer_code`) <= 200
	AND typeof(NEW.`producer_name`) = 'text'
	AND length(trim(NEW.`producer_name`)) > 0
	AND length(NEW.`producer_name`) <= 300
	AND typeof(NEW.`buyer_name`) = 'text'
	AND length(trim(NEW.`buyer_name`)) > 0
	AND length(NEW.`buyer_name`) <= 300
	AND typeof(NEW.`total_liters`) IN ('integer', 'real')
	AND NEW.`total_liters` > 0
	AND abs(NEW.`total_liters`) < 1e308
	AND (
		NEW.`liters_first_half` IS NULL
		OR (
			typeof(NEW.`liters_first_half`) IN ('integer', 'real')
			AND NEW.`liters_first_half` >= 0
			AND abs(NEW.`liters_first_half`) < 1e308
		)
	)
	AND (
		NEW.`liters_second_half` IS NULL
		OR (
			typeof(NEW.`liters_second_half`) IN ('integer', 'real')
			AND NEW.`liters_second_half` >= 0
			AND abs(NEW.`liters_second_half`) < 1e308
		)
	)
	AND (
		(NEW.`liters_first_half` IS NULL AND NEW.`liters_second_half` IS NULL)
		OR abs(
			coalesce(NEW.`liters_first_half`, 0)
			+ coalesce(NEW.`liters_second_half`, 0)
			- NEW.`total_liters`
		) <= 0.0010000001
	)
	AND typeof(NEW.`net_amount_clp`) = 'integer'
	AND NEW.`net_amount_clp` BETWEEN 0 AND 9007199254740991
	AND typeof(NEW.`tax_amount_clp`) = 'integer'
	AND NEW.`tax_amount_clp` BETWEEN 0 AND 9007199254740991
	AND typeof(NEW.`gross_amount_clp`) = 'integer'
	AND NEW.`gross_amount_clp` BETWEEN 1 AND 9007199254740991
	AND NEW.`gross_amount_clp` = NEW.`net_amount_clp` + NEW.`tax_amount_clp`
	AND typeof(NEW.`net_price_per_liter_clp`) IN ('integer', 'real')
	AND NEW.`net_price_per_liter_clp` > 0
	AND abs(NEW.`net_price_per_liter_clp`) < 1e308
	AND abs(
		NEW.`net_price_per_liter_clp`
		- (1.0 * NEW.`net_amount_clp` / NEW.`total_liters`)
	) <= 0.01
	AND (
		NEW.`gross_price_per_liter_clp` IS NULL
		OR (
			typeof(NEW.`gross_price_per_liter_clp`) IN ('integer', 'real')
			AND NEW.`gross_price_per_liter_clp` > 0
			AND abs(NEW.`gross_price_per_liter_clp`) < 1e308
			AND abs(
				NEW.`gross_price_per_liter_clp`
				- (1.0 * NEW.`gross_amount_clp` / NEW.`total_liters`)
			) <= 0.01
		)
	)
	AND (
		NEW.`source_document_name` IS NULL
		OR (
			typeof(NEW.`source_document_name`) = 'text'
			AND length(trim(NEW.`source_document_name`)) > 0
			AND length(NEW.`source_document_name`) <= 500
		)
	)
	AND typeof(NEW.`notes`) = 'text'
	AND length(NEW.`notes`) <= 10000
	AND CASE
		WHEN typeof(NEW.`line_items`) = 'text' AND json_valid(NEW.`line_items`) = 1
		THEN json_type(NEW.`line_items`) = 'array' AND json_array_length(NEW.`line_items`) <= 200
		ELSE 0
	END
	AND typeof(NEW.`created_at`) = 'text'
	AND length(NEW.`created_at`) BETWEEN 10 AND 29
	AND substr(NEW.`created_at`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
	AND date(substr(NEW.`created_at`, 1, 10), '+0 days') = substr(NEW.`created_at`, 1, 10)
	AND (
		length(NEW.`created_at`) = 10
		OR (
			substr(NEW.`created_at`, 11, 1) IN ('T', ' ')
			AND substr(NEW.`created_at`, 12, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`created_at`, 12, 2) AS integer) BETWEEN 0 AND 23
			AND substr(NEW.`created_at`, 14, 1) = ':'
			AND substr(NEW.`created_at`, 15, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`created_at`, 15, 2) AS integer) BETWEEN 0 AND 59
			AND substr(NEW.`created_at`, 17, 1) = ':'
			AND substr(NEW.`created_at`, 18, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`created_at`, 18, 2) AS integer) BETWEEN 0 AND 59
			AND (
				length(NEW.`created_at`) = 19
				OR (length(NEW.`created_at`) = 20 AND substr(NEW.`created_at`, 20, 1) = 'Z')
				OR (
					length(NEW.`created_at`) = 24
					AND substr(NEW.`created_at`, 20, 1) = '.'
					AND substr(NEW.`created_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`created_at`, 24, 1) = 'Z'
				)
				OR (
					length(NEW.`created_at`) = 25
					AND substr(NEW.`created_at`, 20, 1) IN ('+', '-')
					AND substr(NEW.`created_at`, 21, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 21, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`created_at`, 23, 1) = ':'
					AND substr(NEW.`created_at`, 24, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 24, 2) AS integer) BETWEEN 0 AND 59
				)
				OR (
					length(NEW.`created_at`) = 29
					AND substr(NEW.`created_at`, 20, 1) = '.'
					AND substr(NEW.`created_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`created_at`, 24, 1) IN ('+', '-')
					AND substr(NEW.`created_at`, 25, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 25, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`created_at`, 27, 1) = ':'
					AND substr(NEW.`created_at`, 28, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`created_at`, 28, 2) AS integer) BETWEEN 0 AND 59
				)
			)
		)
	)
	AND julianday(NEW.`created_at`) IS NOT NULL
	AND typeof(NEW.`updated_at`) = 'text'
	AND length(NEW.`updated_at`) BETWEEN 10 AND 29
	AND substr(NEW.`updated_at`, 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'
	AND date(substr(NEW.`updated_at`, 1, 10), '+0 days') = substr(NEW.`updated_at`, 1, 10)
	AND (
		length(NEW.`updated_at`) = 10
		OR (
			substr(NEW.`updated_at`, 11, 1) IN ('T', ' ')
			AND substr(NEW.`updated_at`, 12, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`updated_at`, 12, 2) AS integer) BETWEEN 0 AND 23
			AND substr(NEW.`updated_at`, 14, 1) = ':'
			AND substr(NEW.`updated_at`, 15, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`updated_at`, 15, 2) AS integer) BETWEEN 0 AND 59
			AND substr(NEW.`updated_at`, 17, 1) = ':'
			AND substr(NEW.`updated_at`, 18, 2) GLOB '[0-9][0-9]'
			AND CAST(substr(NEW.`updated_at`, 18, 2) AS integer) BETWEEN 0 AND 59
			AND (
				length(NEW.`updated_at`) = 19
				OR (length(NEW.`updated_at`) = 20 AND substr(NEW.`updated_at`, 20, 1) = 'Z')
				OR (
					length(NEW.`updated_at`) = 24
					AND substr(NEW.`updated_at`, 20, 1) = '.'
					AND substr(NEW.`updated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`updated_at`, 24, 1) = 'Z'
				)
				OR (
					length(NEW.`updated_at`) = 25
					AND substr(NEW.`updated_at`, 20, 1) IN ('+', '-')
					AND substr(NEW.`updated_at`, 21, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 21, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`updated_at`, 23, 1) = ':'
					AND substr(NEW.`updated_at`, 24, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 24, 2) AS integer) BETWEEN 0 AND 59
				)
				OR (
					length(NEW.`updated_at`) = 29
					AND substr(NEW.`updated_at`, 20, 1) = '.'
					AND substr(NEW.`updated_at`, 21, 3) GLOB '[0-9][0-9][0-9]'
					AND substr(NEW.`updated_at`, 24, 1) IN ('+', '-')
					AND substr(NEW.`updated_at`, 25, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 25, 2) AS integer) BETWEEN 0 AND 23
					AND substr(NEW.`updated_at`, 27, 1) = ':'
					AND substr(NEW.`updated_at`, 28, 2) GLOB '[0-9][0-9]'
					AND CAST(substr(NEW.`updated_at`, 28, 2) AS integer) BETWEEN 0 AND 59
				)
			)
		)
	)
	AND julianday(NEW.`updated_at`) IS NOT NULL
)
BEGIN
	SELECT RAISE(ABORT, 'milk_settlement_integrity_invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_closure_frozen_delete`
BEFORE DELETE ON `organization_memberships`
WHEN (
	EXISTS (
		SELECT 1 FROM `account_closure_requests` AS request
		WHERE request.`id` = OLD.`closure_request_id`
			AND request.`status` = 'grace'
			AND (
				request.`scope` = 'organization'
				OR strftime('%Y-%m-%dT%H:%M:%fZ', 'now') <= request.`grace_ends_at`
			)
	)
	OR EXISTS (
		SELECT 1 FROM `account_closure_requests` AS request
		WHERE request.`scope` = 'organization'
			AND request.`target_id` = OLD.`organization_id`
			AND request.`status` = 'grace'
	)
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_MEMBERSHIP_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_closure_frozen_update`
BEFORE UPDATE ON `organization_memberships`
WHEN NEW.`closure_request_id` IS OLD.`closure_request_id`
	AND (
		EXISTS (
		SELECT 1 FROM `account_closure_requests` AS request
		WHERE request.`id` = OLD.`closure_request_id`
			AND request.`status` = 'grace'
			AND (
				request.`scope` = 'organization'
				OR strftime('%Y-%m-%dT%H:%M:%fZ', 'now') <= request.`grace_ends_at`
			)
		)
		OR EXISTS (
			SELECT 1 FROM `account_closure_requests` AS request
			WHERE request.`scope` = 'organization'
				AND request.`target_id` = OLD.`organization_id`
				AND request.`status` = 'grace'
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_MEMBERSHIP_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_closure_target_insert`
BEFORE INSERT ON `organization_memberships`
WHEN NEW.`closure_request_id` IS NOT NULL
	OR EXISTS (
		SELECT 1
		FROM `account_closure_requests` AS request
		WHERE request.`status` = 'grace'
			AND (
				(request.`scope` = 'organization' AND request.`target_id` = NEW.`organization_id`)
				OR (
					request.`scope` = 'account'
					AND NEW.`normalized_email` = (
						SELECT identity.`normalized_email`
						FROM `auth_identities` AS identity
						WHERE identity.`id` = request.`target_id`
					)
				)
			)
	)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_TARGET_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_closure_target_update`
BEFORE UPDATE OF `organization_id`, `normalized_email` ON `organization_memberships`
WHEN EXISTS (
	SELECT 1
	FROM `account_closure_requests` AS request
	WHERE request.`status` = 'grace'
		AND (
			(request.`scope` = 'organization' AND request.`target_id` IN (OLD.`organization_id`, NEW.`organization_id`))
			OR (
				request.`scope` = 'account'
				AND (
					OLD.`normalized_email` = (
						SELECT identity.`normalized_email`
						FROM `auth_identities` AS identity
						WHERE identity.`id` = request.`target_id`
					)
					OR NEW.`normalized_email` = (
						SELECT identity.`normalized_email`
						FROM `auth_identities` AS identity
						WHERE identity.`id` = request.`target_id`
					)
				)
			)
		)
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_TARGET_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_closure_transition_guard`
BEFORE UPDATE OF `status`, `closure_request_id` ON `organization_memberships`
WHEN NOT (
	(OLD.`closure_request_id` IS NULL AND NEW.`closure_request_id` IS NULL)
	OR (
		OLD.`closure_request_id` IS NULL
		AND NEW.`closure_request_id` IS NOT NULL
		AND NEW.`status` = 'suspended'
		AND NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`user_email` = OLD.`user_email`
		AND NEW.`normalized_email` = OLD.`normalized_email`
		AND NEW.`display_name` = OLD.`display_name`
		AND NEW.`role` = OLD.`role`
		AND NEW.`created_by` = OLD.`created_by`
		AND NEW.`created_at` = OLD.`created_at`
		AND NEW.`updated_at` = OLD.`updated_at`
		AND EXISTS (
			SELECT 1
			FROM `account_closure_requests` AS request
			INNER JOIN json_each(request.`snapshot_json`, '$.memberships') AS snapshot
			WHERE request.`id` = NEW.`closure_request_id`
				AND request.`status` = 'grace'
				AND json_extract(snapshot.`value`, '$.id') = OLD.`id`
				AND json_extract(snapshot.`value`, '$.organizationId') = OLD.`organization_id`
				AND json_extract(snapshot.`value`, '$.role') = OLD.`role`
				AND json_extract(snapshot.`value`, '$.status') = OLD.`status`
				AND (
					(request.`scope` = 'organization' AND request.`target_id` = OLD.`organization_id`)
					OR (
						request.`scope` = 'account'
						AND OLD.`normalized_email` = (
							SELECT identity.`normalized_email`
							FROM `auth_identities` AS identity
							WHERE identity.`id` = request.`target_id`
						)
					)
				)
		)
	)
	OR (
		OLD.`closure_request_id` IS NOT NULL
		AND NEW.`closure_request_id` IS NULL
		AND NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`user_email` = OLD.`user_email`
		AND NEW.`normalized_email` = OLD.`normalized_email`
		AND NEW.`display_name` = OLD.`display_name`
		AND NEW.`role` = OLD.`role`
		AND NEW.`created_by` = OLD.`created_by`
		AND NEW.`created_at` = OLD.`created_at`
		AND NEW.`updated_at` = OLD.`updated_at`
		AND EXISTS (
			SELECT 1
			FROM `account_closure_requests` AS request
			INNER JOIN json_each(request.`snapshot_json`, '$.memberships') AS snapshot
			WHERE request.`id` = OLD.`closure_request_id`
				AND request.`status` = 'revoked'
				AND json_extract(snapshot.`value`, '$.id') = OLD.`id`
				AND json_extract(snapshot.`value`, '$.status') = NEW.`status`
		)
	)
	OR (
		OLD.`closure_request_id` IS NOT NULL
		AND NEW.`closure_request_id` IS NOT NULL
		AND NEW.`closure_request_id` <> OLD.`closure_request_id`
		AND NEW.`status` = 'suspended'
		AND NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`user_email` = OLD.`user_email`
		AND NEW.`normalized_email` = OLD.`normalized_email`
		AND NEW.`display_name` = OLD.`display_name`
		AND NEW.`role` = OLD.`role`
		AND NEW.`created_by` = OLD.`created_by`
		AND NEW.`created_at` = OLD.`created_at`
		AND NEW.`updated_at` = OLD.`updated_at`
		AND EXISTS (
			SELECT 1
			FROM `account_closure_requests` AS old_request
			INNER JOIN json_each(
				old_request.`snapshot_json`,
				'$.memberships'
			) AS old_snapshot
			INNER JOIN `account_closure_requests` AS new_request
				ON new_request.`id` = NEW.`closure_request_id`
			INNER JOIN json_each(
				new_request.`snapshot_json`,
				'$.memberships'
			) AS new_snapshot
			WHERE old_request.`id` = OLD.`closure_request_id`
				AND old_request.`status` = 'revoked'
				AND new_request.`status` = 'grace'
				AND json_extract(old_snapshot.`value`, '$.id') = OLD.`id`
				AND json_extract(new_snapshot.`value`, '$.id') = OLD.`id`
				AND (
					old_request.`revoked_at` > new_request.`grace_ends_at`
					OR json_extract(old_snapshot.`value`, '$.status')
						= json_extract(new_snapshot.`value`, '$.status')
				)
		)
	)
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_MEMBERSHIP_TRANSITION_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_keep_active_owner_delete`
BEFORE DELETE ON `organization_memberships`
WHEN OLD.`role` = 'owner'
  AND OLD.`status` = 'active'
  AND NOT EXISTS (
    SELECT 1 FROM `organization_memberships` AS other
    WHERE other.`organization_id` = OLD.`organization_id`
      AND other.`id` <> OLD.`id`
      AND other.`role` = 'owner'
      AND other.`status` = 'active'
  )
BEGIN
  SELECT RAISE(ABORT, 'LAST_ACTIVE_OWNER');
END;
--> statement-breakpoint
CREATE TRIGGER `organization_memberships_keep_active_owner_update`
BEFORE UPDATE OF `role`, `status` ON `organization_memberships`
WHEN OLD.`role` = 'owner'
	AND OLD.`status` = 'active'
	AND (NEW.`role` <> 'owner' OR NEW.`status` <> 'active')
	AND NOT EXISTS (
		SELECT 1 FROM `organization_memberships` AS other
		WHERE other.`organization_id` = OLD.`organization_id`
			AND other.`id` <> OLD.`id`
			AND other.`role` = 'owner'
			AND other.`status` = 'active'
	)
	AND NOT (
		NEW.`role` = OLD.`role`
		AND NEW.`status` = 'suspended'
		AND OLD.`closure_request_id` IS NULL
		AND NEW.`closure_request_id` IS NOT NULL
		AND NEW.`id` = OLD.`id`
		AND NEW.`organization_id` = OLD.`organization_id`
		AND NEW.`user_email` = OLD.`user_email`
		AND NEW.`normalized_email` = OLD.`normalized_email`
		AND NEW.`display_name` = OLD.`display_name`
		AND NEW.`created_by` = OLD.`created_by`
		AND NEW.`created_at` = OLD.`created_at`
		AND NEW.`updated_at` = OLD.`updated_at`
		AND EXISTS (
			SELECT 1
			FROM `account_closure_requests` AS request
			INNER JOIN json_each(request.`snapshot_json`, '$.memberships') AS snapshot
			WHERE request.`id` = NEW.`closure_request_id`
				AND request.`status` = 'grace'
				AND json_extract(snapshot.`value`, '$.id') = OLD.`id`
				AND json_extract(snapshot.`value`, '$.role') = OLD.`role`
				AND json_extract(snapshot.`value`, '$.status') = OLD.`status`
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'LAST_ACTIVE_OWNER');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_closure_frozen_delete`
BEFORE DELETE ON `organizations`
WHEN EXISTS (
	SELECT 1 FROM `account_closure_requests` AS request
	WHERE request.`scope` = 'organization'
		AND request.`target_id` = OLD.`id`
		AND request.`status` = 'grace'
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_ORGANIZATION_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_closure_frozen_update`
BEFORE UPDATE ON `organizations`
WHEN EXISTS (
	SELECT 1 FROM `account_closure_requests` AS request
	WHERE request.`scope` = 'organization'
		AND request.`target_id` = OLD.`id`
		AND request.`status` = 'grace'
)
BEGIN
	SELECT RAISE(ABORT, 'ACCOUNT_CLOSURE_ORGANIZATION_FROZEN');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_kind_insert`
BEFORE INSERT ON `organizations`
FOR EACH ROW WHEN NEW.`kind` NOT IN ('shared', 'personal', 'demo')
BEGIN
	SELECT RAISE(ABORT, 'INVALID_ORGANIZATION_KIND');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_kind_update`
BEFORE UPDATE OF `kind` ON `organizations`
FOR EACH ROW WHEN NEW.`kind` NOT IN ('shared', 'personal', 'demo')
BEGIN
	SELECT RAISE(ABORT, 'INVALID_ORGANIZATION_KIND');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_plan_insert`
BEFORE INSERT ON `organizations`
FOR EACH ROW WHEN
  NEW.`plan_code` NOT IN ('legacy', 'free', 'pro')
  OR (NEW.`field_limit` IS NOT NULL AND NEW.`field_limit` <= 0)
  OR (NEW.`paddock_limit` IS NOT NULL AND NEW.`paddock_limit` <= 0)
  OR (
    NEW.`plan_code` = 'free'
    AND (
      NEW.`field_limit` IS NOT 2
      OR NEW.`paddock_limit` IS NOT 200
      OR NEW.`self_service_owner_email` IS NULL
      OR NEW.`self_service_owner_email` <> lower(trim(NEW.`self_service_owner_email`))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORGANIZATION_PLAN');
END;
--> statement-breakpoint
CREATE TRIGGER `organizations_plan_update`
BEFORE UPDATE OF `plan_code`, `field_limit`, `paddock_limit`, `self_service_owner_email`
ON `organizations`
FOR EACH ROW WHEN
  NEW.`plan_code` NOT IN ('legacy', 'free', 'pro')
  OR (NEW.`field_limit` IS NOT NULL AND NEW.`field_limit` <= 0)
  OR (NEW.`paddock_limit` IS NOT NULL AND NEW.`paddock_limit` <= 0)
  OR (
    NEW.`plan_code` = 'free'
    AND (
      NEW.`field_limit` IS NOT 2
      OR NEW.`paddock_limit` IS NOT 200
      OR NEW.`self_service_owner_email` IS NULL
      OR NEW.`self_service_owner_email` <> lower(trim(NEW.`self_service_owner_email`))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'INVALID_ORGANIZATION_PLAN');
END;
--> statement-breakpoint
CREATE TRIGGER `personal_data_events_no_delete`
BEFORE DELETE ON `personal_data_events`
BEGIN
	SELECT RAISE(ABORT, 'personal_data_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `personal_data_events_no_update`
BEFORE UPDATE ON `personal_data_events`
BEGIN
	SELECT RAISE(ABORT, 'personal_data_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_bootstrap_claims_lifecycle_update`
BEFORE UPDATE ON `platform_staff_bootstrap_claims`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_principal_collision')
  WHERE NEW.`principal_id` IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM `platform_staff_bootstrap_claims`
      WHERE `principal_id` = NEW.`principal_id`
        AND `id` <> OLD.`id`
    );

  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_terminal')
  WHERE OLD.`status` <> 'pending'
    OR NEW.`status` NOT IN ('claimed', 'disabled')
    OR NEW.`id` IS NOT OLD.`id`
    OR NEW.`normalized_email` IS NOT OLD.`normalized_email`
    OR NEW.`created_at` IS NOT OLD.`created_at`
    OR NEW.`version` <> OLD.`version` + 1;

  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_identity_mismatch')
  WHERE NEW.`status` = 'claimed'
    AND NOT EXISTS (
      SELECT 1
      FROM `platform_staff_principals` AS `principal`
      INNER JOIN `auth_identities` AS `identity`
        ON `identity`.`id` = `principal`.`auth_identity_id`
      WHERE `principal`.`id` = NEW.`principal_id`
        AND `identity`.`normalized_email` = NEW.`normalized_email`
    );
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_bootstrap_claims_no_delete`
BEFORE DELETE ON `platform_staff_bootstrap_claims`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_no_delete');
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_bootstrap_claims_pending_insert`
BEFORE INSERT ON `platform_staff_bootstrap_claims`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_id_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_bootstrap_claims`
    WHERE `id` = NEW.`id`
  );

  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_email_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_bootstrap_claims`
    WHERE `normalized_email` = NEW.`normalized_email`
  );

  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_principal_collision')
  WHERE NEW.`principal_id` IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM `platform_staff_bootstrap_claims`
      WHERE `principal_id` = NEW.`principal_id`
    );

  SELECT RAISE(ABORT, 'platform_staff_bootstrap_claims_pending_insert_required')
  WHERE NEW.`status` <> 'pending'
    OR NEW.`principal_id` IS NOT NULL
    OR NEW.`claimed_at` IS NOT NULL
    OR NEW.`disabled_at` IS NOT NULL
    OR NEW.`version` <> 1;
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_capability_grants_collision_insert`
BEFORE INSERT ON `platform_staff_capability_grants`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_capability_grants_id_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_capability_grants`
    WHERE `id` = NEW.`id`
  );

  SELECT RAISE(ABORT, 'platform_staff_capability_grants_active_collision')
  WHERE NEW.`status` = 'active'
    AND EXISTS (
      SELECT 1
      FROM `platform_staff_capability_grants`
      WHERE `principal_id` = NEW.`principal_id`
        AND `capability` = NEW.`capability`
        AND `status` = 'active'
    );
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_capability_grants_no_delete`
BEFORE DELETE ON `platform_staff_capability_grants`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_capability_grants_no_delete');
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_capability_grants_versioned_update`
BEFORE UPDATE ON `platform_staff_capability_grants`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_capability_grants_immutable')
  WHERE OLD.`status` <> 'active'
    OR NEW.`status` <> 'revoked'
    OR NEW.`id` IS NOT OLD.`id`
    OR NEW.`principal_id` IS NOT OLD.`principal_id`
    OR NEW.`capability` IS NOT OLD.`capability`
    OR NEW.`reason` IS NOT OLD.`reason`
    OR NEW.`granted_by_principal_id` IS NOT OLD.`granted_by_principal_id`
    OR NEW.`granted_at` IS NOT OLD.`granted_at`
    OR NEW.`version` <> OLD.`version` + 1;
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_elevations_identity_insert`
BEFORE INSERT ON `platform_staff_elevations`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_elevations_token_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_elevations`
    WHERE `token_hash` = NEW.`token_hash`
  );

  SELECT RAISE(ABORT, 'platform_staff_elevations_identity_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `platform_staff_principals` AS `principal`
    INNER JOIN `auth_sessions` AS `session`
      ON `session`.`identity_id` = `principal`.`auth_identity_id`
    WHERE `principal`.`id` = NEW.`principal_id`
      AND `principal`.`status` = 'active'
      AND `session`.`token_hash` = NEW.`auth_session_token_hash`
  );
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_elevations_revocation_update`
BEFORE UPDATE ON `platform_staff_elevations`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_elevations_immutable')
  WHERE OLD.`revoked_at` IS NOT NULL
    OR NEW.`revoked_at` IS NULL
    OR NEW.`token_hash` IS NOT OLD.`token_hash`
    OR NEW.`principal_id` IS NOT OLD.`principal_id`
    OR NEW.`auth_session_token_hash` IS NOT OLD.`auth_session_token_hash`
    OR NEW.`created_at` IS NOT OLD.`created_at`
    OR NEW.`expires_at` IS NOT OLD.`expires_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_events_collision_insert`
BEFORE INSERT ON `platform_staff_events`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_events_id_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_events`
    WHERE `id` = NEW.`id`
  );

  SELECT RAISE(ABORT, 'platform_staff_events_idempotency_collision')
  WHERE NEW.`actor_type` = 'staff'
    AND EXISTS (
      SELECT 1
      FROM `platform_staff_events`
      WHERE `actor_type` = 'staff'
        AND `actor_principal_id` = NEW.`actor_principal_id`
        AND `idempotency_key_hash` = NEW.`idempotency_key_hash`
    );
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_events_no_delete`
BEFORE DELETE ON `platform_staff_events`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_events_no_update`
BEFORE UPDATE ON `platform_staff_events`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_principals_bootstrap_insert`
BEFORE INSERT ON `platform_staff_principals`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_principals_id_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_principals`
    WHERE `id` = NEW.`id`
  );

  SELECT RAISE(ABORT, 'platform_staff_principals_auth_identity_collision')
  WHERE EXISTS (
    SELECT 1
    FROM `platform_staff_principals`
    WHERE `auth_identity_id` = NEW.`auth_identity_id`
  );

  SELECT RAISE(ABORT, 'platform_staff_principals_identity_mismatch')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `auth_identities`
    WHERE `id` = NEW.`auth_identity_id`
      AND `normalized_email` = NEW.`normalized_email_snapshot`
  );

  SELECT RAISE(ABORT, 'platform_staff_principals_bootstrap_claim_required')
  WHERE NEW.`created_by_principal_id` IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `platform_staff_bootstrap_claims`
      WHERE `status` = 'pending'
        AND `normalized_email` = NEW.`normalized_email_snapshot`
    );

  SELECT RAISE(ABORT, 'platform_staff_principals_first_owner_required')
  WHERE NOT EXISTS (SELECT 1 FROM `platform_staff_principals`)
    AND (NEW.`kind` <> 'owner' OR NEW.`status` <> 'active');

  SELECT RAISE(ABORT, 'platform_staff_principals_creator_inactive')
  WHERE NEW.`created_by_principal_id` IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM `platform_staff_principals`
      WHERE `id` = NEW.`created_by_principal_id`
        AND `status` = 'active'
    );
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_principals_last_active_owner`
BEFORE UPDATE ON `platform_staff_principals`
WHEN OLD.`kind` = 'owner'
  AND OLD.`status` = 'active'
  AND (NEW.`kind` <> 'owner' OR NEW.`status` <> 'active')
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_principals_last_active_owner')
  WHERE NOT EXISTS (
    SELECT 1
    FROM `platform_staff_principals`
    WHERE `id` <> OLD.`id`
      AND `kind` = 'owner'
      AND `status` = 'active'
  );
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_principals_no_delete`
BEFORE DELETE ON `platform_staff_principals`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_principals_no_delete');
END;
--> statement-breakpoint
CREATE TRIGGER `platform_staff_principals_versioned_update`
BEFORE UPDATE ON `platform_staff_principals`
BEGIN
  SELECT RAISE(ABORT, 'platform_staff_principals_immutable')
  WHERE NEW.`id` IS NOT OLD.`id`
    OR NEW.`auth_identity_id` IS NOT OLD.`auth_identity_id`
    OR NEW.`created_by_principal_id` IS NOT OLD.`created_by_principal_id`
    OR NEW.`created_at` IS NOT OLD.`created_at`;

  SELECT RAISE(ABORT, 'platform_staff_principals_identity_mismatch')
  WHERE NEW.`normalized_email_snapshot` IS NOT OLD.`normalized_email_snapshot`
    AND NOT EXISTS (
    SELECT 1
    FROM `auth_identities`
    WHERE `id` = NEW.`auth_identity_id`
      AND `normalized_email` = NEW.`normalized_email_snapshot`
  );

  SELECT RAISE(ABORT, 'platform_staff_principals_version_invalid')
  WHERE NEW.`version` <> OLD.`version` + 1
    OR NEW.`updated_at` < OLD.`updated_at`;
END;
--> statement-breakpoint
CREATE TRIGGER `product_feedback_capture_immutable`
BEFORE UPDATE ON `product_feedback`
FOR EACH ROW WHEN
  NEW.`id` IS NOT OLD.`id`
  OR NEW.`organization_id` IS NOT OLD.`organization_id`
  OR NEW.`field_id` IS NOT OLD.`field_id`
  OR NEW.`reporter_membership_id` IS NOT OLD.`reporter_membership_id`
  OR NEW.`reporter_email` IS NOT OLD.`reporter_email`
  OR NEW.`reporter_name` IS NOT OLD.`reporter_name`
  OR NEW.`plan_code` IS NOT OLD.`plan_code`
  OR NEW.`category` IS NOT OLD.`category`
  OR NEW.`impact` IS NOT OLD.`impact`
  OR NEW.`message` IS NOT OLD.`message`
  OR NEW.`contact_allowed` IS NOT OLD.`contact_allowed`
  OR NEW.`submission_key` IS NOT OLD.`submission_key`
  OR NEW.`page_path` IS NOT OLD.`page_path`
  OR NEW.`release_sha` IS NOT OLD.`release_sha`
  OR NEW.`user_agent` IS NOT OLD.`user_agent`
  OR NEW.`viewport_width` IS NOT OLD.`viewport_width`
  OR NEW.`viewport_height` IS NOT OLD.`viewport_height`
  OR NEW.`online` IS NOT OLD.`online`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_FEEDBACK_CAPTURE_IMMUTABLE');
END;
--> statement-breakpoint
CREATE TRIGGER `product_feedback_events_no_delete`
BEFORE DELETE ON `product_feedback_events`
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_FEEDBACK_EVENT_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `product_feedback_events_no_update`
BEFORE UPDATE ON `product_feedback_events`
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_FEEDBACK_EVENT_APPEND_ONLY');
END;
--> statement-breakpoint
CREATE TRIGGER `product_feedback_lifecycle_versioned`
BEFORE UPDATE ON `product_feedback`
FOR EACH ROW WHEN
  NEW.`version` <> OLD.`version` + 1
  OR NEW.`updated_at` <= OLD.`updated_at`
  OR NEW.`last_event_id` IS OLD.`last_event_id`
BEGIN
  SELECT RAISE(ABORT, 'PRODUCT_FEEDBACK_LIFECYCLE_INVALID');
END;
--> statement-breakpoint
CREATE TRIGGER `restore_recovery_events_no_delete`
BEFORE DELETE ON `restore_recovery_events`
BEGIN
	SELECT RAISE(ABORT, 'restore_recovery_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `restore_recovery_events_no_update`
BEFORE UPDATE ON `restore_recovery_events`
BEGIN
	SELECT RAISE(ABORT, 'restore_recovery_events_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `sync_mutations_no_delete`
BEFORE DELETE ON `sync_mutations`
BEGIN
	SELECT RAISE(ABORT, 'sync_mutations_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `sync_mutations_request_immutable`
BEFORE UPDATE ON `sync_mutations`
WHEN OLD.`id` <> NEW.`id`
	OR OLD.`organization_id` <> NEW.`organization_id`
	OR OLD.`field_id` <> NEW.`field_id`
	OR OLD.`actor` <> NEW.`actor`
	OR OLD.`entity` <> NEW.`entity`
	OR OLD.`entity_id` <> NEW.`entity_id`
	OR OLD.`op` <> NEW.`op`
	OR OLD.`payload` <> NEW.`payload`
	OR OLD.`client_ts` <> NEW.`client_ts`
	OR COALESCE(OLD.`expected_version`, '') <> COALESCE(NEW.`expected_version`, '')
	OR OLD.`received_at` <> NEW.`received_at`
	OR OLD.`status` <> 'pending'
	OR NEW.`status` = 'pending'
BEGIN
	SELECT RAISE(ABORT, 'sync_mutations_append_only');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_declarations_no_delete`
BEFORE DELETE ON `traceability_declarations`
BEGIN
  SELECT RAISE(ABORT, 'official declarations cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_declarations_state_machine`
BEFORE UPDATE ON `traceability_declarations`
WHEN (OLD.`status` = 'draft' AND NEW.`status` = 'annulled')
  OR (OLD.`status` = 'declared' AND NEW.`status` <> 'annulled')
  OR OLD.`status` = 'annulled'
BEGIN
  SELECT RAISE(ABORT, 'invalid official declaration transition');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_declarations_stored_document_immutable`
BEFORE UPDATE ON `traceability_declarations`
WHEN OLD.`document_status` = 'stored' AND (
  NEW.`organization_id` IS NOT OLD.`organization_id`
  OR NEW.`field_id` IS NOT OLD.`field_id`
  OR NEW.`establishment_id` IS NOT OLD.`establishment_id`
  OR NEW.`period` IS NOT OLD.`period`
  OR NEW.`revision` IS NOT OLD.`revision`
  OR NEW.`as_of_date` IS NOT OLD.`as_of_date`
  OR NEW.`counts` IS NOT OLD.`counts`
  OR NEW.`total_animals` IS NOT OLD.`total_animals`
  OR NEW.`inventory_hash` IS NOT OLD.`inventory_hash`
  OR NEW.`request_hash` IS NOT OLD.`request_hash`
  OR NEW.`folio` IS NOT OLD.`folio`
  OR NEW.`form_version` IS NOT OLD.`form_version`
  OR NEW.`document_object_key` IS NOT OLD.`document_object_key`
  OR NEW.`document_sha256` IS NOT OLD.`document_sha256`
  OR NEW.`document_etag` IS NOT OLD.`document_etag`
  OR NEW.`document_size_bytes` IS NOT OLD.`document_size_bytes`
  OR NEW.`declared_at` IS NOT OLD.`declared_at`
  OR NEW.`created_by` IS NOT OLD.`created_by`
  OR NEW.`created_at` IS NOT OLD.`created_at`
)
BEGIN
  SELECT RAISE(ABORT, 'stored official declaration document is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_diios_identity_immutable`
BEFORE UPDATE ON `traceability_diios`
WHEN NEW.`id` IS NOT OLD.`id`
  OR NEW.`organization_id` IS NOT OLD.`organization_id`
  OR NEW.`field_id` IS NOT OLD.`field_id`
  OR NEW.`establishment_id` IS NOT OLD.`establishment_id`
  OR NEW.`official_number` IS NOT OLD.`official_number`
  OR NEW.`normalized_number` IS NOT OLD.`normalized_number`
  OR NEW.`device_type` IS NOT OLD.`device_type`
  OR NEW.`created_by` IS NOT OLD.`created_by`
  OR NEW.`created_at` IS NOT OLD.`created_at`
BEGIN
  SELECT RAISE(ABORT, 'traceability DIIO identity is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_diios_no_delete`
BEFORE DELETE ON `traceability_diios`
BEGIN
  SELECT RAISE(ABORT, 'traceability DIIO records are lifecycle-only');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_diios_state_machine`
BEFORE UPDATE ON `traceability_diios`
WHEN NOT (
  (OLD.`status` = 'available' AND NEW.`status` IN ('assigned', 'retired'))
  OR (OLD.`status` = 'assigned' AND NEW.`status` IN ('lost', 'replaced', 'retired'))
  OR (OLD.`status` = 'lost' AND NEW.`status` IN ('replaced', 'retired'))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid traceability DIIO transition');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_diios_transition_metadata`
BEFORE UPDATE ON `traceability_diios`
WHEN NEW.`version` <> OLD.`version` + 1
  OR NEW.`last_transition_key` IS NULL
  OR length(trim(NEW.`last_transition_key`)) = 0
BEGIN
  SELECT RAISE(ABORT, 'traceability DIIO transition metadata is invalid');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_events_no_delete`
BEFORE DELETE ON `traceability_events`
BEGIN
  SELECT RAISE(ABORT, 'traceability events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_events_no_update`
BEFORE UPDATE ON `traceability_events`
BEGIN
  SELECT RAISE(ABORT, 'traceability events are append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movement_items_delete_draft_only`
BEFORE DELETE ON `traceability_movement_items`
WHEN (SELECT `status` FROM `traceability_movements` WHERE `id` = OLD.`movement_id`) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'issued movement items are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movement_items_insert_draft_only`
BEFORE INSERT ON `traceability_movement_items`
WHEN (SELECT `status` FROM `traceability_movements` WHERE `id` = NEW.`movement_id`) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'issued movement items are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movement_items_max_45`
BEFORE INSERT ON `traceability_movement_items`
WHEN (SELECT COUNT(*) FROM `traceability_movement_items` WHERE `movement_id` = NEW.`movement_id`) >= 45
BEGIN
  SELECT RAISE(ABORT, 'an official movement accepts at most 45 DIIO');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movement_items_update_draft_only`
BEFORE UPDATE ON `traceability_movement_items`
WHEN (SELECT `status` FROM `traceability_movements` WHERE `id` = OLD.`movement_id`) <> 'draft'
  OR (SELECT `status` FROM `traceability_movements` WHERE `id` = NEW.`movement_id`) <> 'draft'
BEGIN
  SELECT RAISE(ABORT, 'issued movement items are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movements_no_delete`
BEFORE DELETE ON `traceability_movements`
BEGIN
  SELECT RAISE(ABORT, 'official movements cannot be deleted');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movements_state_machine`
BEFORE UPDATE ON `traceability_movements`
WHEN (OLD.`status` = 'draft' AND NEW.`status` = 'annulled')
  OR (OLD.`status` = 'issued' AND NEW.`status` <> 'annulled')
  OR OLD.`status` = 'annulled'
BEGIN
  SELECT RAISE(ABORT, 'invalid official movement transition');
END;
--> statement-breakpoint
CREATE TRIGGER `traceability_movements_stored_document_immutable`
BEFORE UPDATE ON `traceability_movements`
WHEN OLD.`document_status` = 'stored' AND (
  NEW.`organization_id` IS NOT OLD.`organization_id`
  OR NEW.`field_id` IS NOT OLD.`field_id`
  OR NEW.`establishment_id` IS NOT OLD.`establishment_id`
  OR NEW.`origin_rup` IS NOT OLD.`origin_rup`
  OR NEW.`destination_rup` IS NOT OLD.`destination_rup`
  OR NEW.`departure_at` IS NOT OLD.`departure_at`
  OR NEW.`expected_arrival_at` IS NOT OLD.`expected_arrival_at`
  OR NEW.`carrier` IS NOT OLD.`carrier`
  OR NEW.`carrier_rut` IS NOT OLD.`carrier_rut`
  OR NEW.`vehicle_plate` IS NOT OLD.`vehicle_plate`
  OR NEW.`trailer_plate` IS NOT OLD.`trailer_plate`
  OR NEW.`reason` IS NOT OLD.`reason`
  OR NEW.`folio` IS NOT OLD.`folio`
  OR NEW.`form_version` IS NOT OLD.`form_version`
  OR NEW.`request_hash` IS NOT OLD.`request_hash`
  OR NEW.`document_object_key` IS NOT OLD.`document_object_key`
  OR NEW.`document_sha256` IS NOT OLD.`document_sha256`
  OR NEW.`document_etag` IS NOT OLD.`document_etag`
  OR NEW.`document_size_bytes` IS NOT OLD.`document_size_bytes`
  OR NEW.`supersedes_movement_id` IS NOT OLD.`supersedes_movement_id`
  OR NEW.`issued_at` IS NOT OLD.`issued_at`
  OR NEW.`created_by` IS NOT OLD.`created_by`
  OR NEW.`created_at` IS NOT OLD.`created_at`
)
BEGIN
  SELECT RAISE(ABORT, 'stored official movement document is immutable');
END;
--> statement-breakpoint
