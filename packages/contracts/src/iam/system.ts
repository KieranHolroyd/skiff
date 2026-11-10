/**
 * Named internal actors (IAM.md §7.1, I3).
 *
 * A system principal is in-process: it never reaches a surface and proves nothing. Instead of
 * borrowing an org owner's permissions, each one gets the fixed, least-privilege set its flow
 * uses. The permissions here are the whole grant; `buildSystemPrincipal` in `@yoal/core` copies
 * them verbatim rather than capping them by a role.
 *
 * Add a name only when a call site needs one, and grant exactly what that path checks.
 */
import type { Permission } from './catalog.ts';

export interface SystemPrincipalSpec {
	name: string;
	description: string;
	permissions: readonly Permission[];
}

export const systemPrincipals = {
	'system:alerts': {
		name: 'system:alerts',
		description: 'Resolves project, database, storage and broker names and runs alert queries.',
		permissions: ['project:read', 'database:read', 'storage:read', 'broker:read', 'metrics:read'],
	},
	'system:failover': {
		name: 'system:failover',
		description: 'Fails over database replicas and workload replicas across nodes.',
		// The controller records its own audit rows and drives the handlers directly; the reads cover
		// the database and workload resources it inspects.
		permissions: ['database:read', 'deployment:read'],
	},
	'system:registry-autodeploy': {
		name: 'system:registry-autodeploy',
		description: 'Deploys a project when its linked registry tag is pushed.',
		// `deployImage` creates a deployment and saves the image into the workload spec.
		permissions: ['deployment:create', 'project:update'],
	},
	'system:registry-storage': {
		name: 'system:registry-storage',
		description: "Provisions the registry's own RustFS instance, bucket and scoped key.",
		// Only the identity the platform registry uses to wire its managed S3 backend; the key it
		// creates is read-write on the registry's bucket and nothing else.
		permissions: ['storage:create', 'storage:read', 'storage:update'],
	},
	'system:pipeline-deploy': {
		name: 'system:pipeline-deploy',
		description: 'Deploys a linked project from a trusted pipeline run.',
		// `startDeploy` creates deployments and, for image deploys, updates the workload spec;
		// `finalizeDeploy` only creates deployments.
		permissions: ['deployment:create', 'project:update'],
	},
	'system:email-delivery': {
		name: 'system:email-delivery',
		description: 'Pauses sending on reputation limits and verifies sandbox recipients.',
		// Neither path checks a permission today (both write the row directly and then audit); the
		// grant mirrors the "email sending/update" actions they perform.
		permissions: ['email:send', 'email:update'],
	},
	'system:build-claim': {
		name: 'system:build-claim',
		description: 'Finalizes a claimed build into a deployment and reports the result.',
		// The builder node reports a finished build; the only permissioned call is `deployEntries`.
		permissions: ['deployment:create'],
	},
	'system:member-sync': {
		name: 'system:member-sync',
		description: 'Creates the org binding that mirrors a member role on first use.',
		// The engine writes `iam_bindings` rows directly; this is the permission that write stands for.
		permissions: ['iam:manage-bindings'],
	},
	'system:usage-analytics': {
		name: 'system:usage-analytics',
		description: 'Records each opt-in usage ping in the audit log.',
		// The ping path reads counts directly and calls no permissioned service.
		permissions: [],
	},
	'system:whats-new': {
		name: 'system:whats-new',
		description: 'Seed the post-update onboarding ledger when setup completes.',
		// The ledger is one settings row; no permissioned service is called.
		permissions: [],
	},
} as const satisfies Record<string, SystemPrincipalSpec>;

export function systemPermissions(name: keyof typeof systemPrincipals): readonly Permission[] {
	return systemPrincipals[name].permissions;
}
