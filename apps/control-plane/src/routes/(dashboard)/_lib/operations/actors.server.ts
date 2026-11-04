import { core } from '#lib/server/core.js';

/** Display names for operation actors (user ids). Names are a nicety; ids are the fallback. */
export function actorNames(ids: Array<string | null | undefined>): Record<string, string> {
	const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
	const names: Record<string, string> = {};
	if (unique.length === 0) return names;
	try {
		const rows = core.ctx.sqlite
			.query<{ id: string; name: string | null; email: string | null }, string[]>(
				`SELECT id, name, email FROM user WHERE id IN (${unique.map(() => '?').join(', ')})`
			)
			.all(...unique);
		for (const row of rows) names[row.id] = row.name || row.email || row.id;
	} catch {
		// The auth tables may be unavailable during first boot.
	}
	return names;
}
