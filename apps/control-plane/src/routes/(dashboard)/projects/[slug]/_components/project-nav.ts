/** Every section of a project, in the order the navigation presents them. */
export const PROJECT_TABS = [
	'traffic',
	'logs',
	'deployments',
	'environments',
	'builds',
	'source',
	'domains',
	'volumes',
	'runtime',
	'shares',
	'settings'
] as const;

export type ProjectTab = (typeof PROJECT_TABS)[number];

export const DEFAULT_PROJECT_TAB: ProjectTab = 'deployments';

/** Narrow an untrusted `?tab=` value to a real section. */
export function readProjectTab(value: string | null): ProjectTab {
	return PROJECT_TABS.includes(value as ProjectTab) ? (value as ProjectTab) : DEFAULT_PROJECT_TAB;
}
