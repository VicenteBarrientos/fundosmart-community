import assert from "node:assert/strict";
import test from "node:test";
import {
  capabilitiesForProfile,
  decideStaffAuthorization,
  denyStaffAuthorization,
  ELEVATION_REQUIRED_CAPABILITIES,
  isStaffCapability,
  matchesAuthorizationSnapshot,
  MAXIMUM_ELEVATION_LIFETIME_SECONDS,
  publicStaffAccessCode,
  requiresElevation,
  STAFF_AUTHORIZATION_CONTRACT_VERSION,
  STAFF_CAPABILITIES,
  STAFF_CAPABILITY_PROFILES,
  STAFF_INFRASTRUCTURE_REASON_CODES,
  STAFF_PUBLIC_ACCESS_CODES,
  staffCapabilityProfileKeys,
} from "../src/modules/staff/domain/staff-authorization.mjs";

const SESSION_HASH = "a".repeat(64);
const OTHER_SESSION_HASH = "b".repeat(64);
const NOW = 1_772_000_000;

function principal(overrides = {}) {
  return {
    id: "01JQZP0000000000000000000A",
    authIdentityId: "auth-identity-1",
    status: "active",
    kind: "staff",
    version: 1,
    ...overrides,
  };
}

function grant(capability, overrides = {}) {
  return {
    id: `grant-${capability}`,
    principalId: "01JQZP0000000000000000000A",
    capability,
    status: "active",
    version: 1,
    ...overrides,
  };
}

function elevation(overrides = {}) {
  return {
    principalId: "01JQZP0000000000000000000A",
    authSessionTokenHash: SESSION_HASH,
    createdAt: NOW - 60,
    expiresAt: NOW + 300,
    revokedAt: null,
    ...overrides,
  };
}

function decide(overrides = {}) {
  return decideStaffAuthorization({
    capability: "support:read",
    principal: principal(),
    grants: [grant("support:read")],
    elevation: null,
    authSessionTokenHash: SESSION_HASH,
    now: NOW,
    ...overrides,
  });
}

test("el catálogo de capacidades es cerrado, congelado y coincide con el ADR", () => {
  assert.equal(STAFF_AUTHORIZATION_CONTRACT_VERSION, "fundosmart.staff-authorization.v1");
  assert.deepEqual([...STAFF_CAPABILITIES], [
    "support:read",
    "tenants:manage",
    "flags:manage",
    "audit:read",
    "operations:sensitive",
    "staff:manage",
  ]);
  assert.ok(Object.isFrozen(STAFF_CAPABILITIES));
  assert.ok(Object.isFrozen(STAFF_CAPABILITY_PROFILES));
  assert.equal(isStaffCapability("support:read"), true);
  assert.equal(isStaffCapability("support:write"), false);
  assert.equal(isStaffCapability(null), false);
});

test("los perfiles son plantillas explícitas y no herencia", () => {
  assert.deepEqual([...staffCapabilityProfileKeys()], [
    "owner-initial",
    "platform-operator",
    "support",
  ]);
  assert.deepEqual([...capabilitiesForProfile("owner-initial")], [...STAFF_CAPABILITIES]);
  assert.deepEqual([...capabilitiesForProfile("platform-operator")], [
    "support:read",
    "tenants:manage",
    "flags:manage",
    "audit:read",
  ]);
  assert.deepEqual([...capabilitiesForProfile("support")], ["support:read"]);
  assert.equal(capabilitiesForProfile("owner"), null);
  assert.equal(capabilitiesForProfile("__proto__"), null);
  assert.equal(capabilitiesForProfile(null), null);
});

test("sólo las capacidades sensibles exigen elevación", () => {
  assert.deepEqual([...ELEVATION_REQUIRED_CAPABILITIES], [
    "operations:sensitive",
    "staff:manage",
  ]);
  assert.equal(requiresElevation("operations:sensitive"), true);
  assert.equal(requiresElevation("staff:manage"), true);
  assert.equal(requiresElevation("support:read"), false);
  assert.equal(requiresElevation("tenants:manage"), false);
});

test("un staff activo con el grant exacto queda autorizado con snapshot congelado", () => {
  const decision = decide();

  assert.equal(decision.allowed, true);
  assert.equal(decision.capability, "support:read");
  assert.equal(decision.reasonCode, null);
  assert.equal(decision.publicCode, null);
  assert.equal(decision.principalId, "01JQZP0000000000000000000A");
  assert.equal(decision.grantId, "grant-support:read");
  assert.equal(decision.elevationRequired, false);
  assert.ok(Object.isFrozen(decision));
  assert.ok(Object.isFrozen(decision.snapshot));
  assert.deepEqual({ ...decision.snapshot }, {
    capability: "support:read",
    principalId: "01JQZP0000000000000000000A",
    principalVersion: 1,
    principalStatus: "active",
    grantId: "grant-support:read",
    grantVersion: 1,
  });
});

test("cada capacidad del catálogo se autoriza sólo con su propio grant", () => {
  for (const capability of STAFF_CAPABILITIES) {
    const allowed = decide({
      capability,
      grants: [grant(capability)],
      elevation: requiresElevation(capability) ? elevation() : null,
    });
    assert.equal(allowed.allowed, true, `debería permitir ${capability}`);

    const otherCapability = STAFF_CAPABILITIES.find((entry) => entry !== capability);
    const denied = decide({
      capability,
      grants: [grant(otherCapability)],
      elevation: requiresElevation(capability) ? elevation() : null,
    });
    assert.equal(denied.allowed, false, `no debería permitir ${capability} con otro grant`);
    assert.equal(denied.reasonCode, "GRANT_MISSING");
  }
});

test("kind owner no concede ninguna capacidad implícita", () => {
  const decision = decide({
    capability: "staff:manage",
    principal: principal({ kind: "owner" }),
    grants: [],
    elevation: elevation(),
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "GRANT_MISSING");
  assert.equal(decision.principalKind, null);
});

test("un miembro de tenant sin principal global queda fuera", () => {
  const decision = decide({ principal: null, grants: [] });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "PRINCIPAL_MISSING");
  assert.equal(decision.publicCode, "STAFF_REQUIRED");
  assert.equal(decision.snapshot, null);
});

test("un principal suspendido pierde el acceso aunque conserve el grant", () => {
  const decision = decide({ principal: principal({ status: "suspended" }) });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "PRINCIPAL_SUSPENDED");
  assert.equal(decision.principalId, null);
});

test("un grant revocado deja de autorizar", () => {
  const decision = decide({
    grants: [grant("support:read", { status: "revoked" })],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "GRANT_MISSING");
});

test("dos grants activos de la misma capacidad fallan cerrado", () => {
  const decision = decide({
    grants: [
      grant("support:read", { id: "grant-a" }),
      grant("support:read", { id: "grant-b" }),
    ],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "GRANT_AMBIGUOUS");
});

test("un grant de otro principal nunca se aprovecha", () => {
  const decision = decide({
    grants: [grant("support:read", { principalId: "otro-principal" })],
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "GRANT_PRINCIPAL_MISMATCH");
});

test("una capacidad sensible sin elevación se deniega con código propio", () => {
  const decision = decide({
    capability: "operations:sensitive",
    grants: [grant("operations:sensitive")],
    elevation: null,
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "ELEVATION_MISSING");
  assert.equal(decision.publicCode, "STAFF_ELEVATION_REQUIRED");
  assert.equal(decision.elevationRequired, true);
  assert.equal(decision.principalId, "01JQZP0000000000000000000A");
});

test("la elevación caduca, se revoca y se liga a una sola sesión y principal", () => {
  const base = {
    capability: "staff:manage",
    grants: [grant("staff:manage")],
  };

  assert.equal(decide({ ...base, elevation: elevation() }).allowed, true);

  const expired = decide({
    ...base,
    elevation: elevation({ createdAt: NOW - 600, expiresAt: NOW }),
  });
  assert.equal(expired.reasonCode, "ELEVATION_EXPIRED");

  const revoked = decide({ ...base, elevation: elevation({ revokedAt: NOW - 10 }) });
  assert.equal(revoked.reasonCode, "ELEVATION_REVOKED");

  const otherSession = decide({
    ...base,
    elevation: elevation({ authSessionTokenHash: OTHER_SESSION_HASH }),
  });
  assert.equal(otherSession.reasonCode, "ELEVATION_SESSION_MISMATCH");

  const otherPrincipal = decide({
    ...base,
    elevation: elevation({ principalId: "otro-principal" }),
  });
  assert.equal(otherPrincipal.reasonCode, "ELEVATION_PRINCIPAL_MISMATCH");

  const future = decide({
    ...base,
    elevation: elevation({ createdAt: NOW + 60, expiresAt: NOW + 300 }),
  });
  assert.equal(future.reasonCode, "ELEVATION_NOT_YET_VALID");
});

test("una elevación más larga que el techo del esquema es inválida", () => {
  const decision = decide({
    capability: "staff:manage",
    grants: [grant("staff:manage")],
    elevation: elevation({
      createdAt: NOW - 10,
      expiresAt: NOW - 10 + MAXIMUM_ELEVATION_LIFETIME_SECONDS + 1,
    }),
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, "ELEVATION_LIFETIME_INVALID");
});

test("una elevación vigente se reporta aunque la capacidad no la exija", () => {
  const decision = decide({ elevation: elevation() });

  assert.equal(decision.allowed, true);
  assert.equal(decision.elevationRequired, false);
  assert.equal(decision.elevationConfirmed, true);
});

test("una elevación caducada no bloquea una capacidad que no la exige", () => {
  const decision = decide({
    elevation: elevation({ createdAt: NOW - 600, expiresAt: NOW }),
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.elevationConfirmed, false);
});

test("toda forma inesperada deniega sin lanzar", () => {
  const invalidInputs = [
    undefined,
    null,
    "support:read",
    [],
    Object.create(null),
    { capability: "support:read" },
    {
      capability: "support:read",
      principal: principal(),
      grants: [grant("support:read")],
      elevation: null,
      authSessionTokenHash: SESSION_HASH,
      now: NOW,
      extra: true,
    },
  ];

  for (const input of invalidInputs) {
    const decision = decideStaffAuthorization(input);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, "INPUT_SHAPE_INVALID");
    assert.equal(decision.publicCode, "STAFF_REQUIRED");
  }

  assert.equal(decide({ capability: "support:write" }).reasonCode, "CAPABILITY_INVALID");
  assert.equal(decide({ now: NOW + 0.5 }).reasonCode, "INPUT_SHAPE_INVALID");
  assert.equal(decide({ now: -1 }).reasonCode, "INPUT_SHAPE_INVALID");
  assert.equal(decide({ authSessionTokenHash: "corto" }).reasonCode, "INPUT_SHAPE_INVALID");
  assert.equal(decide({ authSessionTokenHash: "A".repeat(64) }).reasonCode, "INPUT_SHAPE_INVALID");
  assert.equal(decide({ grants: "support:read" }).reasonCode, "GRANT_INVALID");
  assert.equal(decide({ grants: [{ id: "x" }] }).reasonCode, "GRANT_INVALID");
  assert.equal(decide({ principal: { id: "x" } }).reasonCode, "PRINCIPAL_INVALID");
  assert.equal(
    decide({ principal: principal({ version: 0 }) }).reasonCode,
    "PRINCIPAL_INVALID",
  );
});

test("la barrera de respuesta exige el mismo principal, grant y versiones", () => {
  const before = decide().snapshot;

  assert.equal(matchesAuthorizationSnapshot(before, { ...before }), true);
  assert.equal(
    matchesAuthorizationSnapshot(before, { ...before, principalVersion: 2 }),
    false,
  );
  assert.equal(matchesAuthorizationSnapshot(before, { ...before, grantVersion: 2 }), false);
  assert.equal(matchesAuthorizationSnapshot(before, { ...before, grantId: "otro" }), false);
  assert.equal(
    matchesAuthorizationSnapshot(before, { ...before, principalId: "otro" }),
    false,
  );
  assert.equal(
    matchesAuthorizationSnapshot(before, { ...before, principalStatus: "suspended" }),
    false,
  );
  assert.equal(
    matchesAuthorizationSnapshot(before, { ...before, capability: "audit:read" }),
    false,
  );
});

test("la barrera rechaza snapshots ausentes, parciales o inválidos", () => {
  const before = decide().snapshot;

  assert.equal(matchesAuthorizationSnapshot(before, null), false);
  assert.equal(matchesAuthorizationSnapshot(null, before), false);
  assert.equal(matchesAuthorizationSnapshot(before, { ...before, extra: 1 }), false);
  const partial = { ...before };
  Reflect.deleteProperty(partial, "grantId");
  assert.equal(matchesAuthorizationSnapshot(before, partial), false);
  assert.equal(
    matchesAuthorizationSnapshot(
      { ...before, principalStatus: "suspended" },
      { ...before, principalStatus: "suspended" },
    ),
    false,
  );
});

test("la denegación de infraestructura conserva la misma forma congelada", () => {
  const shape = Object.keys(decide({ principal: null, grants: [] })).sort();

  for (const reasonCode of ["BACKEND_UNAVAILABLE", "ROW_SHAPE_INVALID", "STAFF_ACCESS_CHANGED"]) {
    const decision = denyStaffAuthorization(reasonCode, "support:read");
    assert.equal(decision.allowed, false);
    assert.equal(decision.reasonCode, reasonCode);
    assert.equal(decision.capability, "support:read");
    assert.equal(decision.snapshot, null);
    assert.ok(Object.isFrozen(decision));
    assert.deepEqual(Object.keys(decision).sort(), shape);
  }

  assert.equal(denyStaffAuthorization("STAFF_ACCESS_CHANGED").publicCode, "STAFF_ACCESS_CHANGED");
  assert.equal(denyStaffAuthorization("BACKEND_UNAVAILABLE").capability, null);
  assert.equal(denyStaffAuthorization("BACKEND_UNAVAILABLE", "inventada").capability, null);
});

test("un motivo de infraestructura desconocido degrada a backend no disponible", () => {
  assert.deepEqual([...STAFF_INFRASTRUCTURE_REASON_CODES], [
    "BACKEND_UNAVAILABLE",
    "ROW_SHAPE_INVALID",
    "STAFF_ACCESS_CHANGED",
  ]);
  assert.equal(denyStaffAuthorization("GRANT_MISSING").reasonCode, "BACKEND_UNAVAILABLE");
  assert.equal(denyStaffAuthorization(null).reasonCode, "BACKEND_UNAVAILABLE");
  assert.equal(denyStaffAuthorization("lo que sea").publicCode, "STAFF_REQUIRED");
});

test("los códigos públicos son tres y no filtran el motivo interno", () => {
  assert.deepEqual([...STAFF_PUBLIC_ACCESS_CODES], [
    "STAFF_REQUIRED",
    "STAFF_ELEVATION_REQUIRED",
    "STAFF_ACCESS_CHANGED",
  ]);
  assert.equal(publicStaffAccessCode("PRINCIPAL_SUSPENDED"), "STAFF_REQUIRED");
  assert.equal(publicStaffAccessCode("GRANT_MISSING"), "STAFF_REQUIRED");
  assert.equal(publicStaffAccessCode("ELEVATION_EXPIRED"), "STAFF_ELEVATION_REQUIRED");
  assert.equal(publicStaffAccessCode("ELEVATION_SESSION_MISMATCH"), "STAFF_ELEVATION_REQUIRED");
  assert.equal(publicStaffAccessCode("STAFF_ACCESS_CHANGED"), "STAFF_ACCESS_CHANGED");
  assert.equal(publicStaffAccessCode("cualquier cosa"), "STAFF_REQUIRED");
  assert.equal(publicStaffAccessCode(null), "STAFF_REQUIRED");

  for (const reasonCode of ["PRINCIPAL_MISSING", "GRANT_AMBIGUOUS", "ELEVATION_REVOKED"]) {
    assert.ok(STAFF_PUBLIC_ACCESS_CODES.includes(publicStaffAccessCode(reasonCode)));
  }
});
