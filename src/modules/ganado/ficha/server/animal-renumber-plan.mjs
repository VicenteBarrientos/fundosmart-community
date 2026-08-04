const IDENTIFIER_SOURCE_SYSTEM = "manual";
const IDENTIFIER_KIND = "tag";

/**
 * Un cambio de número no reemplaza el identificador: cierra el vigente y abre uno nuevo.
 * El plan es una lista ordenada de sentencias pensada para un único lote atómico.
 * La última sentencia afirma el estado final y fuerza el rollback si no se cumple.
 */
export function buildAnimalRenumberPlan(input) {
  const {
    animalId,
    fieldId,
    organizationId,
    fieldIds,
    previousTag,
    previousNormalizedTag,
    newTag,
    newNormalizedTag,
    effectiveOn,
    reason,
    actor,
    now,
    historyIdentifierId,
    activeIdentifierId,
    auditId,
  } = input;

  const scope = animalScopeCondition(animalId, fieldId, organizationId, fieldIds);
  const noCompetingAnimal = {
    sql: `
      NOT EXISTS (
        SELECT 1
        FROM livestock_animals AS competing_animal
        INNER JOIN livestock_lots AS competing_lot ON competing_lot.id = competing_animal.lot_id
        WHERE competing_animal.tag = ?
          AND competing_animal.id <> ?
          AND competing_lot.field_id = ?
      )
    `,
    bindings: [newTag, animalId, fieldId],
  };

  return [
    {
      label: "close_active_identifier",
      expected: "zeroOrOne",
      sql: `
        UPDATE livestock_animal_identifiers
        SET valid_to = ?, updated_at = ?
        WHERE animal_id = ?
          AND source_system = '${IDENTIFIER_SOURCE_SYSTEM}'
          AND kind = '${IDENTIFIER_KIND}'
          AND valid_to IS NULL
          AND ${scope.sql}
      `,
      bindings: [effectiveOn, now, animalId, ...scope.bindings],
    },
    {
      // Un animal creado a mano nunca tuvo fila de identificador: su número actual
      // se materializa como historia cerrada para no perderlo en el primer cambio.
      label: "backfill_previous_identifier",
      expected: "zeroOrOne",
      sql: `
        INSERT INTO livestock_animal_identifiers (
          id, field_id, animal_id, source_system, kind, value, normalized_value,
          valid_from, valid_to, is_primary, created_at, updated_at
        )
        SELECT ?, ?, ?, '${IDENTIFIER_SOURCE_SYSTEM}', '${IDENTIFIER_KIND}', ?, ?, NULL, ?, 0, ?, ?
        WHERE ${scope.sql}
          AND NOT EXISTS (
            SELECT 1 FROM livestock_animal_identifiers AS history
            WHERE history.animal_id = ?
              AND history.source_system = '${IDENTIFIER_SOURCE_SYSTEM}'
              AND history.kind = '${IDENTIFIER_KIND}'
          )
      `,
      bindings: [
        historyIdentifierId, fieldId, animalId, previousTag, previousNormalizedTag,
        effectiveOn, now, now, ...scope.bindings, animalId,
      ],
    },
    {
      label: "open_active_identifier",
      expected: "one",
      sql: `
        INSERT INTO livestock_animal_identifiers (
          id, field_id, animal_id, source_system, kind, value, normalized_value,
          valid_from, valid_to, is_primary, created_at, updated_at
        )
        SELECT ?, ?, ?, '${IDENTIFIER_SOURCE_SYSTEM}', '${IDENTIFIER_KIND}', ?, ?, ?, NULL, 1, ?, ?
        WHERE ${scope.sql}
          AND EXISTS (SELECT 1 FROM livestock_animals WHERE id = ? AND tag = ?)
          AND ${noCompetingAnimal.sql}
          AND NOT EXISTS (
            SELECT 1 FROM livestock_animal_identifiers AS competing_identifier
            WHERE competing_identifier.field_id = ?
              AND competing_identifier.source_system = '${IDENTIFIER_SOURCE_SYSTEM}'
              AND competing_identifier.kind = '${IDENTIFIER_KIND}'
              AND competing_identifier.normalized_value = ?
              AND competing_identifier.valid_to IS NULL
          )
      `,
      bindings: [
        activeIdentifierId, fieldId, animalId, newTag, newNormalizedTag, effectiveOn, now, now,
        ...scope.bindings, animalId, previousTag, ...noCompetingAnimal.bindings,
        fieldId, newNormalizedTag,
      ],
    },
    {
      label: "move_animal_tag",
      expected: "one",
      sql: `
        UPDATE livestock_animals
        SET tag = ?, updated_at = ?
        WHERE id = ?
          AND tag = ?
          AND ${scope.sql}
          AND ${noCompetingAnimal.sql}
      `,
      bindings: [
        newTag, now, animalId, previousTag,
        ...scope.bindings, ...noCompetingAnimal.bindings,
      ],
    },
    {
      label: "audit",
      expected: "one",
      sql: `
        INSERT INTO audit_log (
          id, organization_id, field_id, actor, action, entity_type, entity_id,
          before, after, source_record_id, occurred_at
        )
        SELECT ?, ?, ?, ?, 'animal.renumbered', 'livestock_animal', ?, ?, ?, NULL, ?
        WHERE ${scope.sql}
      `,
      bindings: [
        auditId, organizationId, fieldId, actor, animalId,
        JSON.stringify({ tag: previousTag }),
        JSON.stringify({ tag: newTag, effectiveOn, reason, previousTag }),
        now, ...scope.bindings,
      ],
    },
    {
      label: "assert_final_state",
      expected: "assertion",
      sql: `
        SELECT CASE
          WHEN (
            SELECT COUNT(*) FROM livestock_animals WHERE id = ? AND tag = ?
          ) = 1
          AND (
            SELECT COUNT(*) FROM livestock_animal_identifiers
            WHERE animal_id = ?
              AND source_system = '${IDENTIFIER_SOURCE_SYSTEM}'
              AND kind = '${IDENTIFIER_KIND}'
              AND valid_to IS NULL
          ) = 1
          AND (
            SELECT COUNT(*) FROM livestock_animal_identifiers
            WHERE animal_id = ?
              AND source_system = '${IDENTIFIER_SOURCE_SYSTEM}'
              AND kind = '${IDENTIFIER_KIND}'
              AND valid_to IS NULL
              AND normalized_value = ?
              AND valid_from = ?
          ) = 1
          AND (
            SELECT COUNT(*) FROM livestock_animal_identifiers
            WHERE animal_id = ?
              AND source_system = '${IDENTIFIER_SOURCE_SYSTEM}'
              AND kind = '${IDENTIFIER_KIND}'
              AND normalized_value = ?
              AND valid_to = ?
          ) >= 1
          AND (
            SELECT COUNT(*) FROM audit_log WHERE id = ? AND organization_id = ? AND entity_id = ?
          ) = 1
          THEN 1
          ELSE abs(-9223372036854775807 - 1)
        END AS complete
      `,
      bindings: [
        animalId, newTag,
        animalId,
        animalId, newNormalizedTag, effectiveOn,
        animalId, previousNormalizedTag, effectiveOn,
        auditId, organizationId, animalId,
      ],
    },
  ];
}

export function assertRenumberPlanApplied(results) {
  const changesByLabel = new Map(results.map((entry) => [entry.label, entry.changes]));
  const closed = changesByLabel.get("close_active_identifier") ?? 0;
  const backfilled = changesByLabel.get("backfill_previous_identifier") ?? 0;
  if (closed + backfilled !== 1) return false;
  for (const label of ["open_active_identifier", "move_animal_tag", "audit"]) {
    if (changesByLabel.get(label) !== 1) return false;
  }
  return true;
}

function animalScopeCondition(animalId, fieldId, organizationId, fieldIds) {
  return {
    sql: `
      EXISTS (
        SELECT 1
        FROM livestock_animals AS scoped_animal
        INNER JOIN livestock_lots AS scoped_lot ON scoped_lot.id = scoped_animal.lot_id
        INNER JOIN fields AS scoped_field ON scoped_field.id = scoped_lot.field_id
        WHERE scoped_animal.id = ?
          AND scoped_field.id = ?
          AND scoped_field.organization_id = ?
          AND scoped_field.id IN (SELECT value FROM json_each(?))
      )
    `,
    bindings: [animalId, fieldId, organizationId, JSON.stringify(fieldIds)],
  };
}
