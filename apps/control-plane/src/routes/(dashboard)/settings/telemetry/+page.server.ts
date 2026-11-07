import { existsSync, readFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { fail } from '@sveltejs/kit';
import {
	TELEMETRY_MEMORY_ENV,
	TELEMETRY_MEMORY_MB,
	validateTelemetryMemoryMb
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { configState, queueConfig, requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Telemetry (D101): install or remove the optional ClickHouse store. The root helper
 * (`skiff-platform-config`, action `telemetry`) does the work and restarts the control plane.
 */

const SYSTEMD_DIR = process.env.SKIFF_SYSTEMD_DIR ?? '/etc/systemd/system';
const ENV_FILE = process.env.SKIFF_ENV_FILE ?? '/etc/skiff/skiff.env';

/**
 * The configured memory ceiling (MiB), or null for the default. Read from skiff.env (group skiff
 * can read it) because changing it restarts only ClickHouse, so this process's env goes stale.
 */
function configuredMemoryMb(): number | null {
	let raw = process.env[TELEMETRY_MEMORY_ENV];
	try {
		const line = readFileSync(ENV_FILE, 'utf8')
			.split('\n')
			.find((l) => l.startsWith(`${TELEMETRY_MEMORY_ENV}=`));
		raw = line
			? line.slice(TELEMETRY_MEMORY_ENV.length + 1).replace(/^["']|["']$/g, '')
			: undefined;
	} catch {
		// not an installed host (dev server): the process env is all there is
	}
	const value = Number(raw?.trim());
	return raw && !validateTelemetryMemoryMb(value) ? value : null;
}

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
			host: { totalMemoryBytes: totalmem(), freeMemoryBytes: freemem() },
			memory: {
				/** Configured ceiling in MiB; null means the default. */
				configuredMb: configuredMemoryMb(),
				defaultMb: TELEMETRY_MEMORY_MB.default,
				minMb: TELEMETRY_MEMORY_MB.min,
				maxMb: TELEMETRY_MEMORY_MB.max
			}
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
	},

	memory: async ({ request, locals }) => {
		const data = await request.formData();
		const raw = String(data.get('memoryMb') ?? '').trim();
		let memoryMb: number | null = null;
		if (raw && data.get('reset') !== 'true') {
			memoryMb = Number(raw);
			const problem = validateTelemetryMemoryMb(memoryMb);
			if (problem)
				return fail(400, {
					message: `Memory ceiling ${problem}.`,
					fieldErrors: { memoryMb: problem }
				});
			// The unit's hard limit is 4/3 of the ceiling; leave the host room for everything else.
			const unitBytes = Math.ceil((memoryMb * 4) / 3) * 1024 * 1024;
			if (unitBytes > totalmem() * 0.75)
				return fail(400, {
					message: `A ${memoryMb} MiB ceiling lets ClickHouse use up to ${Math.ceil((memoryMb * 4) / 3)} MiB, more than 75% of this host's RAM.`,
					fieldErrors: { memoryMb: 'too large for this host' }
				});
		}
		const label =
			memoryMb === null ? `the default (${TELEMETRY_MEMORY_MB.default} MiB)` : `${memoryMb} MiB`;
		return queueConfig(
			locals,
			{ action: 'telemetry-memory', memoryMb },
			`Restarting ClickHouse with a memory ceiling of ${label}. Telemetry pauses for a few seconds.`
		);
	},

	restart: async ({ locals }) =>
		queueConfig(
			locals,
			{ action: 'telemetry-restart' },
			'Restarting ClickHouse. Telemetry pauses for a few seconds.'
		)
};
