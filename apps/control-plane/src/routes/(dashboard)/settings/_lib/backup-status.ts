import type { BackupHealth } from '#lib/server/platform-config.js';
import type { Tone } from '#lib/status.js';
import { formatDuration } from '../../_lib/format.js';

export interface BackupStatus {
	label: string;
	tone: Tone;
	detail: string;
}

/**
 * One headline state for platform backups. Shared by Settings → Backups and the settings
 * navigation, so the dot beside "Backups" always agrees with the page.
 */
export function backupStatus(input: {
	configured: boolean;
	local: boolean;
	health: BackupHealth;
}): BackupStatus {
	const { configured, local, health } = input;
	if (!configured)
		return {
			label: 'Not set up',
			tone: 'warning',
			detail: 'The platform database is not backed up off this server.'
		};
	if (local)
		return {
			label: 'Saved locally',
			tone: 'neutral',
			detail:
				'R2 credentials are saved for this dev server. Continuous backups run on an installed server.'
		};
	if (!health.enabled)
		return {
			label: 'Off',
			tone: 'neutral',
			detail: 'R2 is configured, but continuous backups are turned off.'
		};
	if (health.litestream && health.litestream.active !== 'active')
		return {
			label: 'Failing',
			tone: 'danger',
			detail: `Litestream is ${health.litestream.active}, so new changes are not being backed up.`
		};
	if (health.replication && !health.replication.ok)
		return {
			label: 'Failing',
			tone: 'danger',
			detail: health.replication.error ?? 'R2 has no recent backup.'
		};
	const lag = health.replication?.lagSeconds;
	if (lag !== null && lag !== undefined && lag > 300)
		return {
			label: 'Behind',
			tone: 'warning',
			detail: `The newest backup in R2 is ${formatDuration(lag)} old.`
		};
	if (health.drill && !health.drill.ok)
		return {
			label: 'Drill failed',
			tone: 'danger',
			detail: 'The last restore drill could not reproduce the live database.'
		};
	return {
		label: 'Protected',
		tone: 'success',
		detail: 'Every change is copied to R2 within seconds and restores are tested monthly.'
	};
}
