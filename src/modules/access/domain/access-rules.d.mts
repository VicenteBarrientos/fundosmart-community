import type {
  AccessCapability,
  FeatureKey,
  OrganizationKind,
  OrganizationMembershipRole,
} from "./types";

type DefaultWorkspaceCandidate = {
  organizationId: string;
  role: OrganizationMembershipRole;
  createdAt: string;
};

export const ROLE_CAPABILITIES: Readonly<Record<OrganizationMembershipRole, readonly AccessCapability[]>>;
export function roleHasCapability(role: OrganizationMembershipRole, capability: AccessCapability): boolean;
export function roleHasGlobalFieldAccess(role: OrganizationMembershipRole): boolean;
export function normalizeAccessEmail(email: unknown): string;
export function defaultWorkspaceMembership<Membership extends DefaultWorkspaceCandidate>(
  activeMemberships: readonly Membership[],
  kindByOrganizationId: ReadonlyMap<string, OrganizationKind>,
): Membership | null;
export function featureForCapability(capability: unknown): FeatureKey | null;
