/** Every section of a project, in the order the navigation presents them. */
export const PROJECT_TABS = [
	'traffic',
	'logs',
	'deployments',
	'environments',
	'builds',
	'source',
	'domains',
	'data',
	'variables',
	'runtime',
	'shares',
	'settings'
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export const DEFAULT_PROJECT_TAB: ProjectTab = 'deployments';

/** Sections that were renamed, so old links still land in the right place. */
const LEGACY_TABS: Record<string, ProjectTab> = { volumes: 'data', env: 'variables' };

/** Narrow an untrusted `?tab=` value to a real section. */
export function readProjectTab(value: string | null): ProjectTab {
	if (value && value in LEGACY_TABS) return LEGACY_TABS[value]!;
	return PROJECT_TABS.includes(value as ProjectTab) ? (value as ProjectTab) : DEFAULT_PROJECT_TAB;
}
