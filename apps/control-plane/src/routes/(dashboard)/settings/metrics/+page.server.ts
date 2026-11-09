import { fail } from '@sveltejs/kit';
import { metricsSections, type MetricsExportSettingsUpdate } from '@yoal/contracts';
import { ValidationError } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { formBoolean, formString } from '../../_lib/errors.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Metrics (docs/METRICS.md): what `/metrics` exports and how hard a scrape may work.
 * Stored in the database, so a change applies to the next scrape without a restart.
 */

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return {
		settings: core.metricsExport.settings(),
		platformOrigin: core.ctx.config.platformOrigin,
		telemetryInstalled: core.ctx.telemetry?.installed ?? false
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const update: MetricsExportSettingsUpdate = {
			publicPlatform: formBoolean(data, 'publicPlatform'),
			cacheSeconds: Number(formString(data, 'cacheSeconds')),
			maxApps: Number(formString(data, 'maxApps')),
			sections: Object.fromEntries(metricsSections.map((section) => [section, formBoolean(data, `section.${section}`)]))
		};
		try {
			const settings = core.metricsExport.updateSettings(principal, update);
			core.ctx.audit.record({ principal, action: 'platform.metrics', resource: 'platform', args: settings, result: 'ok' });
			return { success: 'Saved. The next scrape uses the new settings.' };
		} catch (cause) {
			if (cause instanceof ValidationError)
				return fail(400, { message: 'Cache must be 0–300 seconds and max apps 1–10,000.' });
			throw cause;
		}
	}
};
