/** Every section of a project, in the order the navigation presents them. */
export const PROJECT_TABS = [
	'traffic',
	'container',
	'logs',
	'shell',
	'files',
	'deployments',
	'environments',
	'builds',
	'jobs',
	'source',
	'domains',
	'data',
	'variables',
	'runtime',
	'shares',
	'access',
	'settings'
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

/** Sections only a container project has (D127); other runtimes fall back to the default. */
export const CONTAINER_TABS: readonly ProjectTab[] = ['container', 'shell', 'files'];

export const DEFAULT_PROJECT_TAB: ProjectTab = 'deployments';

/** Sections that were renamed, so old links still land in the right place. */
const LEGACY_TABS: Record<string, ProjectTab> = { volumes: 'data', env: 'variables' };

/** Narrow an untrusted `?tab=` value to a real section. */
export function readProjectTab(value: string | null): ProjectTab {
	if (value && value in LEGACY_TABS) return LEGACY_TABS[value]!;
	return PROJECT_TABS.includes(value as ProjectTab) ? (value as ProjectTab) : DEFAULT_PROJECT_TAB;
}

/** Where a share link stands; only `active` links still open the deployment. */
export function shareState(link: {
	revokedAt: string | null;
	expiresAt: string | null;
	redemptions: number;
	maxRedemptions: number | null;
}): string {
	if (link.revokedAt) return 'revoked';
	if (link.expiresAt && Date.parse(link.expiresAt) <= Date.now()) return 'expired';
	if (link.maxRedemptions !== null && link.redemptions >= link.maxRedemptions) return 'used up';
	return 'active';
}
