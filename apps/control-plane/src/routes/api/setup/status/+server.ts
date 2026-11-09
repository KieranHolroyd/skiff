import type { RequestHandler } from './$types';
import { migrations } from '@yoal/db';
import { sqlite } from '#lib/server/db.js';
import { core } from '#lib/server/core.js';
import { contentDomain, features, objectStoreKind, platformOrigin, sharedDomain, smtp } from '#lib/server/config.js';
import { platformVersion } from '#lib/server/version.js';
import { json } from '#lib/server/api.js';

/**
 * Public bootstrap status for the setup wizard (DESIGN §12). Exposes only non-sensitive facts:
 * whether an owner exists, the configured domains and the storage/email mode. The first user is
 * allowed to sign up; afterwards the platform is invite-only (D10).
 */
export const GET: RequestHandler = async () => {
	const count = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM user').get();
	const nodes = sqlite.query<{ count: number }, []>('SELECT count(*) AS count FROM nodes').get();
	const applied = new Set(
		sqlite.query<{ id: string }, []>('SELECT id FROM yoal_migrations').all().map((row) => row.id)
	);
	const pending = migrations.filter((migration) => !applied.has(migration.id));
	const snapshot = core.upgrades.listSnapshotBundles()[0];
	return json({
		needsSetup: (count?.count ?? 0) === 0,
		platformOrigin,
		contentDomain,
		sharedDomain,
		objectStore: objectStoreKind,
		email: smtp ? 'smtp' : 'console',
		nodes: nodes?.count ?? 0,
		/** Release identity for the dashboard/installer; never a secret. */
		version: platformVersion,
		channel: process.env.YOAL_RELEASE_CHANNEL === 'edge' ? 'edge' : 'stable',
		/** True when every migration this release ships is applied. */
		ready: pending.length === 0,
		lastUpgradeSnapshot: snapshot
			? {
					createdAt: snapshot.manifest.createdAt,
					targetVersion: snapshot.manifest.targetVersion,
					pinned: snapshot.manifest.pinned
				}
			: null,
		/** Resolved YOAL_FEATURE_* values; booleans only, never env values or secrets. */
		features,
	});
};
