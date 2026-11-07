/** Sections of a function's console page, in display order. */
export const FUNCTION_TABS = [
	'overview',
	'invocations',
	'test',
	'deployments',
	'bindings',
	'data',
	'variables',
	'logs',
	'domains',
	'settings'
] as const;

export type FunctionTab = (typeof FUNCTION_TABS)[number];

export const FUNCTION_DEFAULT_TAB: FunctionTab = 'overview';

/**
 * Where an old `/projects/<slug>?tab=` link lands now that functions have their own console.
 * Project-only sections (environments, builds, source, shares) fall back to the overview.
 */
export function functionTabFromProjectTab(tab: string | null): FunctionTab {
	switch (tab) {
		case 'runtime':
			return 'bindings';
		case 'traffic':
			return 'overview';
		case 'deployments':
		case 'data':
		case 'variables':
		case 'logs':
		case 'domains':
		case 'settings':
			return tab;
		default:
			return FUNCTION_DEFAULT_TAB;
	}
}
