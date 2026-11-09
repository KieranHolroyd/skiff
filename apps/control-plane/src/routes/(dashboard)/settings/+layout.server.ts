import { isGuestPrincipal } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import {
	backupHealth,
	configAvailability,
	currentSection
} from '#lib/server/platform-config.js';
import { backupStatus, type BackupStatus } from './_lib/backup-status.js';
import type { LayoutServerLoad } from './$types';

/**
 * Small, cheap facts for the settings navigation: counts beside Members, API keys and Connected
 * apps, and a status dot beside each platform section an owner is expected to set up. The backup
 * check shells out to systemd, so it is streamed rather than awaited.
 */
export const load: LayoutServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const sqlite = core.ctx.sqlite;

	const count = (sql: string, ...params: string[]): number | null => {
		try {
			return sqlite.query<{ n: number }, string[]>(sql).get(...params)?.n ?? null;
		} catch {
			// Auth tables may not exist during first boot.
			return null;
		}
	};

	const owner =
		core.ctx.platformIam.canAdminister(principal) &&
		principal.permissions.has('iam:manage-owners');
	const availability = owner ? configAvailability() : null;
	// A guest gets no org-level counts (IAM.md §8.2); their access is per project.
	const guest = isGuestPrincipal(principal);

	return {
		hints: {
			members: guest
				? null
				: count('SELECT COUNT(*) AS n FROM member WHERE organizationId = ?', principal.orgId),
			invitations: !guest && principal.permissions.has('member:invite')
				? count(
						`SELECT COUNT(*) AS n FROM invitation
						 WHERE organizationId = ? AND status = 'pending' AND expiresAt > ?`,
						principal.orgId,
						new Date().toISOString()
					)
				: null,
			apiKeys: principal.permissions.has('apiKey:read')
				? count('SELECT COUNT(*) AS n FROM apikey WHERE referenceId = ?', principal.userId)
				: null,
			connectedApps: count(
				'SELECT COUNT(DISTINCT clientId) AS n FROM oauthConsent WHERE userId = ?',
				principal.userId
			),
			platform: owner
				? {
						availability,
						email: currentSection('email').configured,
						alerts: currentSection('alerts').configured,
						assistant: currentSection('assistant').configured,
						backups: backupHealth()
							.then((health): BackupStatus =>
								backupStatus({
									configured: currentSection('backups').configured,
									local: availability === 'local',
									health
								})
							)
							.catch((): BackupStatus | null => null)
					}
				: null
		}
	};
};
