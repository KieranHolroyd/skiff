import type { Database } from 'bun:sqlite';

/**
 * Keep stored hostnames in step with the platform's domains (D105).
 *
 * Most hosts are computed from `contentDomain` on every request, but two are stored with it baked
 * in: `deployments.preview_host` (`<slug>--<id>.<contentDomain>`) and
 * `storage_instances.public_host` (`<name>--s3.<contentDomain>`). When Settings → Domains changes
 * the content domain, the control plane restarts and this runs on boot: it rewrites those
 * suffixes and bumps the desired-state watermark so every agent pulls routes for the new names.
 * A platform-origin change also bumps the watermark (desired state carries login and object URLs).
 *
 * The last-applied values live in `settings` (`platform_origin`, `content_domain`). The first run
 * on an install only records them: existing rows were created with the current domain.
 */
export interface DomainReconcileResult {
	/** Whether anything changed since the last boot. */
	changed: boolean;
	previousContentDomain: string | null;
	previews: number;
	storage: number;
}

const ORIGIN_KEY = 'platform_origin';
const CONTENT_KEY = 'content_domain';

export function reconcilePlatformDomains(
	sqlite: Database,
	current: { platformOrigin: string; contentDomain: string },
	now = Date.now(),
): DomainReconcileResult {
	const read = (key: string) =>
		sqlite.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
	const write = (key: string, value: string) =>
		sqlite.run(
			'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
			[key, value, now],
		);

	const previousOrigin = read(ORIGIN_KEY);
	const previousContent = read(CONTENT_KEY);
	const result: DomainReconcileResult = { changed: false, previousContentDomain: previousContent, previews: 0, storage: 0 };

	sqlite
		.transaction(() => {
			if (previousOrigin === null || previousContent === null) {
				write(ORIGIN_KEY, current.platformOrigin);
				write(CONTENT_KEY, current.contentDomain);
				return;
			}
			const contentChanged = previousContent !== current.contentDomain;
			if (!contentChanged && previousOrigin === current.platformOrigin) return;

			if (contentChanged) {
				const oldSuffix = `.${previousContent}`;
				const rewrite = (table: string, column: string) =>
					sqlite.run(
						`UPDATE ${table} SET ${column} = substr(${column}, 1, length(${column}) - length(?1)) || ?2
						 WHERE ${column} IS NOT NULL AND length(${column}) > length(?1) AND substr(${column}, -length(?1)) = ?1`,
						[oldSuffix, `.${current.contentDomain}`],
					).changes;
				result.previews = rewrite('deployments', 'preview_host');
				result.storage = rewrite('storage_instances', 'public_host');
			}
			sqlite.run(
				'INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT), updated_at = excluded.updated_at',
				['state_version', '1', now],
			);
			write(ORIGIN_KEY, current.platformOrigin);
			write(CONTENT_KEY, current.contentDomain);
			result.changed = true;
		})
		.immediate();
	return result;
}
