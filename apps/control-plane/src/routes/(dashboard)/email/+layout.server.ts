import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import { emailCan } from './_lib/forms.server.js';
import type { LayoutServerLoad } from './$types';

/**
 * Facts every Email page shares (docs/EMAIL.md §9): whether the feature is on, whether a platform
 * admin has picked a mail node yet, and what the viewer may do. Every check lives in `core.email`.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const settings = core.email.settings();
	return {
		emailArea: {
			enabled: features.EMAIL,
			configured: settings.nodeId !== null,
			paused: settings.paused,
			hostnames: settings.hostnames,
			can: emailCan(principal)
		}
	};
};
