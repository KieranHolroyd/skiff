import type { BadgeVariant } from '#lib/components/ui/badge/index.js';

/** What each org role is for, in one line. Shown when inviting, and under Settings → General. */
export const ROLE_DESCRIPTIONS: Record<string, string> = {
	owner: 'Everything, including members, API keys and deleting projects',
	admin: 'Manage projects, deployments, members (except owners) and keys',
	deployer: 'Create projects and deploy, promote and roll back',
	viewer: 'Read-only access to projects, deployments and logs',
	guest: 'Project-only access from an invitation; no organisation-wide permissions'
};

export const ROLE_ORDER = ['owner', 'admin', 'deployer', 'viewer', 'guest'];

export function roleBadge(role: string): BadgeVariant {
	if (role === 'owner') return 'brand';
	if (role === 'admin') return 'info';
	if (role === 'guest') return 'outline';
	return 'neutral';
}

export function initials(name: string): string {
	return (
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0]?.toUpperCase() ?? '')
			.join('') || '?'
	);
}
