import { ValidationError, parseAuditTime, type AuditEntry } from '@skiff/core';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

const LIMITS = [25, 50, 100, 200] as const;

/** A calendar date from a date input; anything else is ignored rather than failing the page. */
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Org-scoped audit log (DESIGN §6.3, §8): filters, a date range (whole UTC days) and cursor paging,
 * newest first. `cursor` walks to older entries; dropping it goes back to the newest.
 */
export const load: PageServerLoad = ({ locals, url }) => {
	const principal = locals.principal!;
	const rawLimit = Number(url.searchParams.get('limit') ?? 50);
	const limit = (LIMITS as readonly number[]).includes(rawLimit) ? rawLimit : 50;
	const action = (url.searchParams.get('action') ?? '').trim();
	const resource = (url.searchParams.get('resource') ?? '').trim();
	const from = (url.searchParams.get('from') ?? '').trim();
	const to = (url.searchParams.get('to') ?? '').trim();
	const cursor = (url.searchParams.get('cursor') ?? '').trim();

	let entries: AuditEntry[] = [];
	let nextCursor: string | null = null;
	let problem: string | null = null;
	try {
		const page = core.audit.page({
			principal,
			limit,
			action: action || undefined,
			resource: resource || undefined,
			from: DATE.test(from) ? parseAuditTime(from, 'from') : undefined,
			to: DATE.test(to) ? parseAuditTime(to, 'to') : undefined,
			cursor: cursor || null
		});
		entries = page.entries;
		nextCursor = page.nextCursor;
	} catch (cause) {
		// An inverted range or a stale cursor: say so on the page instead of failing it.
		if (!(cause instanceof ValidationError)) throw cause;
		problem = cause.message;
	}

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
		from: DATE.test(from) ? from : '',
		to: DATE.test(to) ? to : '',
		paged: cursor !== '',
		nextCursor,
		problem,
		limits: LIMITS
	};
};
