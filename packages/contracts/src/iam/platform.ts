/**
 * Platform roles (IAM.md I24, §10).
 *
 * Platform roles are deliberately *not* org roles: a binding to one at `{ type: 'platform' }` never
 * confers access to an org, a project or a resource inside one. A platform admin who also needs org
 * access gets a separate org binding, which the org's owners can see.
 *
 * The permissions here are a small, closed set of `platform:*` strings. They live outside the org
 * catalog because the catalog's `Permission` union is what org roles, custom roles, tokens and MCP
 * consents are made of. Keeping them separate means a platform binding can never accidentally grant
 * an org permission (the service filters to `platform:` when it compiles a binding).
 *
 * `platform-admin` is the role the Better Auth `user.role = admin` flag is seeded to. D129's
 * "a platform admin's own dashboard session only" rule is expressed as the `credentialIn: [session]`
 * condition on that seeded binding, not as a check in every route.
 */

import type { Condition } from './authorize.ts';

/** Every platform permission. `platform-admin` holds all of them. */
export const platformPermissions = [
	/** Read the fleet: nodes, topology, maintenance history, upgrade plans. */
	'platform:read',
	/** Add, remove and label nodes; join tokens and node lifecycle. */
	'platform:nodes',
	/** Drain and undrain nodes, and move workloads off them. */
	'platform:drain',
	/** Disks, default storage targets and storage settings. */
	'platform:storage',
	/** Ingress and database HA: failover, replicas and promotion. */
	'platform:ha',
	/** Platform version, agent upgrades and self-update. */
	'platform:updates',
	/** Fleet-wide maintenance: a platform-scope prune and other whole-install operations. */
	'platform:maintenance',
	/** Platform settings, policies, metrics export, email, registry and GitHub App. */
	'platform:settings',
	/** Platform domains and DNS, including the content domain. */
	'platform:domains',
	/** Org quotas and other cross-tenant allowance writes. */
	'platform:quotas',
] as const;

export type PlatformPermission = (typeof platformPermissions)[number];

const operatorPermissions = [
	'platform:read',
	'platform:nodes',
	'platform:drain',
	'platform:storage',
	'platform:ha',
	'platform:updates',
] as const satisfies readonly PlatformPermission[];

const viewerPermissions = ['platform:read'] as const satisfies readonly PlatformPermission[];

/**
 * Built-in platform roles. Operator can run the fleet but cannot change settings, domains or
 * quotas; viewer gets the fleet reads only. Admin holds every permission, including maintenance.
 */
export const platformRoles = {
	'platform-admin': platformPermissions,
	'platform-operator': operatorPermissions,
	'platform-viewer': viewerPermissions,
} as const satisfies Record<string, readonly PlatformPermission[]>;

export type PlatformRole = keyof typeof platformRoles;

export const platformRoleIds = Object.keys(platformRoles) as PlatformRole[];

export function isPlatformRole(value: string): value is PlatformRole {
	return (platformRoleIds as readonly string[]).includes(value);
}

export function isPlatformPermission(value: string): value is PlatformPermission {
	return (platformPermissions as readonly string[]).includes(value);
}

export const platformRoleDescriptions: Record<PlatformRole, string> = {
	'platform-admin':
		'Every platform permission, including settings, domains, quotas and fleet maintenance.',
	'platform-operator': 'Run the fleet: nodes, drain, storage, HA and updates. No settings, domains or quotas.',
	'platform-viewer': 'Read-only fleet views.',
};

/**
 * D129: a platform admin's own dashboard session only. Bindings written by `ensurePlatformAdmin`
 * carry this condition; an API key or MCP token therefore never inherits it.
 */
export const platformAdminCondition: Condition = {
	op: 'credentialIn',
	credentials: ['session'],
};

/**
 * The condition a new binding to `roleId` gets when the caller did not supply one. Only
 * `platform-admin` is session-only by default; a deliberate exception (such as the quota-write API
 * key, D129) passes `condition: null` to `bind`.
 */
export function defaultPlatformCondition(roleId: PlatformRole): Condition | null {
	return roleId === 'platform-admin' ? platformAdminCondition : null;
}
