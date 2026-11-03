import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

const LIMITS = [25, 50, 100, 200] as const;

/** Org-scoped audit log with a small limit selector (DESIGN §6.3, §8). */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const rawLimit = Number(url.searchParams.get('limit') ?? 50);
	const limit = (LIMITS as readonly number[]).includes(rawLimit) ? rawLimit : 50;
	const action = (url.searchParams.get('action') ?? '').trim();
	const resource = (url.searchParams.get('resource') ?? '').trim();

	const entries = core.audit.list({
		principal,
		limit,
		action: action || undefined,
		resource: resource || undefined
	});

	const actorIds = [
		...new Set(entries.map((entry) => entry.actorId).filter((id): id is string => Boolean(id)))
	];
	const actors: Record<string, { name: string; email: string | null }> = {};
	if (actorIds.length > 0) {
		try {
			const placeholders = actorIds.map(() => '?').join(', ');
			const rows = core.ctx.sqlite
				.query<{ id: string; name: string; email: string }, string[]>(
					`SELECT id, name, email FROM user WHERE id IN (${placeholders})`
				)
				.all(...actorIds);
			for (const row of rows) actors[row.id] = { name: row.name, email: row.email };
		} catch {
			// Actor names are a nicety; IDs are enough if the auth tables are unavailable.
		}
	}

	return {
		entries,
		actors,
		limit,
		action,
		resource,
		limits: LIMITS
	};
};
