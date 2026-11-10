import { fail } from '@sveltejs/kit';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../../_lib/errors.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Usage analytics (docs/USAGE-ANALYTICS.md, D211).
 *
 * Off by default. The page shows the exact ping before it is sent, because the collector and the
 * wire format are open source: an operator should never have to trust a description of what leaves
 * their server.
 */

export const load: PageServerLoad = ({ locals }) => {
	const principal = requireOwnerPage(locals);
	return {
		usageAnalytics: core.usageAnalytics.view(principal),
		sourceUrl: 'https://github.com/KieranHolroyd/yoal/blob/main/docs/USAGE-ANALYTICS.md'
	};
};

export const actions: Actions = {
	/** Save the opt-in and, if the operator wants one, a different collector endpoint. */
	save: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		try {
			const endpoint = data.has('endpoint') ? formString(data, 'endpoint') : undefined;
			const view = core.usageAnalytics.setEnabled(principal, {
				enabled: formBoolean(data, 'enabled'),
				...(endpoint === undefined ? {} : { endpoint })
			});
			return {
				success: view.enabled
					? 'Thanks — anonymous usage data is on. The first ping goes out within a minute, then once a day.'
					: 'Anonymous usage data is off. Nothing else is sent.'
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	/** Send one ping now, so "it works" is observable rather than a promise. */
	send: async ({ locals }) => {
		const principal = requireOwnerPage(locals);
		const view = core.usageAnalytics.view(principal);
		if (!view.enabled)
			return fail(409, { message: 'Turn anonymous usage data on before sending a ping.' });
		const result = await core.usageAnalytics.send();
		if (!result.sent)
			return fail(502, {
				message: `The collector could not be reached: ${result.error ?? 'unknown error'}`
			});
		return { success: 'Ping sent. Thank you.' };
	}
};
