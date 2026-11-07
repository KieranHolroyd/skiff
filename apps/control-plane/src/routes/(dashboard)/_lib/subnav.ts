import type { Subnav, RouteUrl } from '#lib/nav/subnav.js';
import { alertsSubnav } from '../alerts/_lib/subnav.js';
import { brokerSubnav } from '../brokers/_lib/subnav.js';
import { databaseSubnav } from '../databases/_lib/subnav.js';
import { docsSubnav } from '../docs/_lib/subnav.js';
import { emailSubnav } from '../email/_lib/subnav.js';
import { functionDeploymentSubnav, functionSubnav } from '../functions/_lib/subnav.js';
import { deploymentSubnav, projectSubnav } from '../projects/[slug]/_components/project-subnav.js';
import { settingsSubnav } from '../settings/_lib/subnav.js';
import { storageSubnav } from '../storage/_lib/subnav.js';

/**
 * Which areas take over the sidebar, and with what. Reads only route data, so the server renders
 * the same sidebar the client hydrates. A route whose data is missing (an error page) falls back
 * to the main navigation.
 */
export function subnavFor(
	routeId: string | null,
	data: Record<string, unknown>,
	url: RouteUrl
): Subnav | null {
	if (!routeId) return null;
	const has = (...keys: string[]) => keys.every((key) => data[key] != null);
	// Each builder declares the slice of route data it reads; `has` checked it is there.
	const d = data as never;

	if (routeId === '/(dashboard)/settings' || routeId.startsWith('/(dashboard)/settings/'))
		return has('hints') ? settingsSubnav(d, url.pathname) : null;

	if (routeId === '/(dashboard)/alerts' || routeId.startsWith('/(dashboard)/alerts/')) {
		const can = data.can as { manageNodes?: boolean } | undefined;
		return alertsSubnav(can?.manageNodes === true, url, routeId !== '/(dashboard)/alerts');
	}

	if (routeId === '/(dashboard)/email' || routeId.startsWith('/(dashboard)/email/'))
		return has('emailArea') ? emailSubnav(d, url) : null;

	if (routeId.startsWith('/(dashboard)/docs/')) return has('docsNav') ? docsSubnav(d, url) : null;

	switch (routeId) {
		case '/(dashboard)/projects/[slug]':
			return has('project', 'deployments', 'builds', 'shareLinks') ? projectSubnav(d, url) : null;
		case '/(dashboard)/projects/[slug]/deployments/[id]':
			return has('project', 'deployment') ? deploymentSubnav(d, url) : null;

		case '/(dashboard)/functions/[slug]':
			return has('project', 'deployments', 'domains') ? functionSubnav(d, url) : null;
		case '/(dashboard)/functions/[slug]/deployments/[id]':
			return has('project', 'deployment') ? functionDeploymentSubnav(d, url) : null;

		case '/(dashboard)/databases/[name]':
			return has('database', 'dbCan') ? databaseSubnav(d, url, null) : null;
		case '/(dashboard)/databases/[name]/studio':
			return has('database', 'dbCan') ? databaseSubnav(d, url, 'studio') : null;
		case '/(dashboard)/databases/[name]/logs':
			return has('database', 'dbCan') ? databaseSubnav(d, url, 'logs') : null;

		case '/(dashboard)/storage/[name]':
			return has('storage') ? storageSubnav(d, url, null) : null;
		case '/(dashboard)/storage/[name]/objects':
			return has('storage') ? storageSubnav(d, url, 'objects') : null;
		case '/(dashboard)/storage/[name]/logs':
			return has('storage') ? storageSubnav(d, url, 'logs') : null;

		case '/(dashboard)/brokers/[name]':
			return has('broker') ? brokerSubnav(d, url, null) : null;
		case '/(dashboard)/brokers/[name]/logs':
			return has('broker') ? brokerSubnav(d, url, 'logs') : null;
	}
	return null;
}
