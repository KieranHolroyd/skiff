import type { RequestHandler } from './$types';
import { logLevels, type LogLevel } from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * RustFS container logs (D82). The agent drains the unit's journal like any other workload; this
 * endpoint pages the managed-service stream. `after` is the SSE/polling cursor.
 */
export const GET: RequestHandler = (event) =>
	route(() => {
		const principal = requirePrincipal(event);
		const storage = core.storage.requireRow(principal, event.params.name, { includeDeleted: true });
		const params = event.url.searchParams;
		const afterRaw = params.get('after');
		const after =
			afterRaw !== null && Number.isFinite(Number(afterRaw))
				? Math.max(0, Math.floor(Number(afterRaw)))
				: undefined;
		const limitRaw = Number(params.get('limit') ?? 200);
		const level = params.get('level');
		return core.logs.queryService(principal, 'storage', storage.id, {
			...(after !== undefined ? { after } : {}),
			limit: Number.isFinite(limitRaw) ? limitRaw : 200,
			...(level && (logLevels as readonly string[]).includes(level) ? { level: level as LogLevel } : {}),
			...(params.get('q') ? { q: params.get('q')! } : {})
		});
	});
