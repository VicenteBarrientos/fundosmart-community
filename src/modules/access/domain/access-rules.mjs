export const ROLE_CAPABILITIES = Object.freeze({
  owner: Object.freeze(["view", "operate", "manage_imports", "manage_finance", "manage_members", "export_data", "restore_data", "trazabilidad:read", "trazabilidad:write", "pastoreo:read", "pastoreo:write", "analitica:read", "benchmarking:read", "benchmarking:write"]),
  admin: Object.freeze(["view", "operate", "manage_imports", "manage_finance", "manage_members", "export_data", "restore_data", "trazabilidad:read", "trazabilidad:write", "pastoreo:read", "pastoreo:write", "analitica:read", "benchmarking:read", "benchmarking:write"]),
  manager: Object.freeze(["view", "operate", "manage_imports", "manage_finance", "trazabilidad:read", "trazabilidad:write", "pastoreo:read", "pastoreo:write", "analitica:read", "benchmarking:read"]),
  operator: Object.freeze(["view", "operate", "trazabilidad:read", "trazabilidad:write", "pastoreo:read", "pastoreo:write", "analitica:read"]),
  viewer: Object.freeze(["view", "trazabilidad:read", "pastoreo:read", "analitica:read", "benchmarking:read"]),
});

export function roleHasCapability(role, capability) {
  return ROLE_CAPABILITIES[role]?.includes(capability) ?? false;
}

export function roleHasGlobalFieldAccess(role) {
  return role === "owner" || role === "admin";
}

export function normalizeAccessEmail(email) {
  return String(email ?? "").trim().toLowerCase();
}

/* Espacio de entrada cuando la identidad tiene varios y no eligió ninguno.
   Antes esto no se decidía: la app derivaba al selector antes de mostrar nada,
   en cada dispositivo nuevo y cada vez que vencía la cookie. La regla ordena por
   responsabilidad antes que por conveniencia —primero el rol, después el espacio
   compartido sobre el personal porque otras personas dependen de él, luego la
   antigüedad y por último el identificador, para que no dependa del orden en que
   la base devuelva las filas—. La demo queda fuera: es de solo lectura y nunca
   debe ser el destino por omisión.

   Elegir por omisión es seguro sólo porque el espacio activo se anuncia en la
   barra superior de cada pantalla; si eso dejara de verse, esto vuelve a ser una
   decisión a ciegas sobre dónde se escribe. */
const DEFAULT_WORKSPACE_ROLE_PRIORITY = Object.freeze({
  owner: 0,
  admin: 1,
  manager: 2,
  operator: 3,
  viewer: 4,
});
const DEFAULT_WORKSPACE_KIND_PRIORITY = Object.freeze({
  shared: 0,
  personal: 1,
  demo: 2,
});

export function defaultWorkspaceMembership(activeMemberships, kindByOrganizationId) {
  const kindOf = (membership) => kindByOrganizationId?.get(membership.organizationId) ?? "shared";
  const rank = (table, key, fallback) => table[key] ?? fallback;
  const eligible = activeMemberships.filter((membership) => kindOf(membership) !== "demo");
  const candidates = eligible.length > 0 ? eligible : activeMemberships;
  return [...candidates].sort((left, right) => (
    rank(DEFAULT_WORKSPACE_ROLE_PRIORITY, left.role, 9) - rank(DEFAULT_WORKSPACE_ROLE_PRIORITY, right.role, 9)
    || rank(DEFAULT_WORKSPACE_KIND_PRIORITY, kindOf(left), 9) - rank(DEFAULT_WORKSPACE_KIND_PRIORITY, kindOf(right), 9)
    || String(left.createdAt ?? "").localeCompare(String(right.createdAt ?? ""))
    || String(left.organizationId).localeCompare(String(right.organizationId))
  ))[0] ?? null;
}

export function featureForCapability(capability) {
  const separator = String(capability ?? "").indexOf(":");
  if (separator < 1) return null;
  const feature = capability.slice(0, separator);
  return ["trazabilidad", "pastoreo", "analitica", "benchmarking"].includes(feature) ? feature : null;
}
