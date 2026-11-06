import type { RequestHandler } from './$types';
import type { AlertEventKind } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

const KINDS = new Set<AlertEventKind>(['state', 'notification', 'error', 'system', 'ack', 'silence']);

/** Alert history, newest first: `?rule=`, `?kind=state,notification`, `?before=<iso>`, `?limit=`. */
export const GET: RequestHandler = (event) =>
	route(() => {
		const params = event.url.searchParams;
		const kinds = (params.get('kind') ?? '')
			.split(',')
			.filter((kind): kind is AlertEventKind => KINDS.has(kind as AlertEventKind));
		return {
			events: core.alerts.history(requirePrincipal(event), {
				ruleId: params.get('rule') ?? undefined,
				before: params.get('before') ?? undefined,
				limit: Number(params.get('limit')) || undefined,
				kinds
			})
		};
	});
