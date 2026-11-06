import { existsSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { core } from '#lib/server/core.js';
import { configState, queueConfig, requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Telemetry (D101): install or remove the optional ClickHouse store. The root helper
 * (`skiff-platform-config`, action `telemetry`) does the work and restarts the control plane.
 */

const SYSTEMD_DIR = process.env.SKIFF_SYSTEMD_DIR ?? '/etc/systemd/system';

export const load: PageServerLoad = async ({ locals }) => {
	requireOwnerPage(locals);
	const telemetry = core.ctx.telemetry;
	const installed = telemetry?.installed ?? false;
	const available = installed && telemetry ? await telemetry.ready() : false;
	return {
		...configState(),
		telemetry: {
			/** A ClickHouse connection is configured for this control plane. */
			installed,
			/** The systemd unit exists (installed by the installer or the helper). */
			unitPresent: existsSync(join(SYSTEMD_DIR, 'skiff-clickhouse.service')),
			available,
			error: installed && !available ? (telemetry?.error?.message ?? null) : null,
			stats: available && telemetry ? await telemetry.stats() : null,
			retention: telemetry?.retention ?? { minuteHours: 48, hourDays: 90 },
			host: { totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() }
		}
	};
};

export const actions: Actions = {
	install: async ({ locals }) =>
		queueConfig(
			locals,
			{ action: 'telemetry', enabled: true, purgeData: false },
			'Installing ClickHouse. This downloads about 240 MB; the dashboard restarts for a few seconds when it is done.'
		),

	remove: async ({ request, locals }) => {
		const data = await request.formData();
		const purgeData = data.get('purgeData') === 'on' || data.get('purgeData') === 'true';
		return queueConfig(
			locals,
			{ action: 'telemetry', enabled: false, purgeData },
			purgeData ? 'Removing ClickHouse and its data.' : 'Removing ClickHouse; its data is kept.'
		);
	}
};
