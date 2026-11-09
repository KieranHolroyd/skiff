import { error } from '@sveltejs/kit';
import { hasPermission, isTerminalOperation, type OperationView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { actorNames } from '../../_lib/operations/actors.server.js';
import type { PageServerLoad } from './$types';

const HISTORY = 30;

/** Settings → Maintenance: on-demand prune and the history of mass operations (docs/OPERATIONS.md §6.4). */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'project:read'))
		error(403, 'You need permission to read projects to see maintenance.');

	const canViewPlatform = core.ctx.platformIam.canView(principal);
	const canPrune = core.operations.actions(principal).some((action) => action.id === 'prune');

	const org = core.operations.list(principal, { limit: HISTORY });
	let platform: OperationView[] = [];
	if (canViewPlatform) {
		try {
			platform = core.operations.list(principal, { scope: 'platform', limit: HISTORY });
		} catch {
			// Platform history is admin-only; the org history still renders.
		}
	}
	const history = [...org, ...platform]
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
		.slice(0, HISTORY);

	// Pick an unfinished scan or prune back up after a reload.
	const activePrune = canPrune
		? (history.find(
				(operation) =>
					operation.kind === 'prune' &&
					!isTerminalOperation(operation.status) &&
					operation.actor.id === principal.userId
			) ?? null)
		: null;

	return {
		canPrune,
		canPrunePlatform: canPrune && core.ctx.platformIam.canMaintain(principal),
		history,
		actors: actorNames(history.map((operation) => operation.actor.id)),
		activePrune,
		userId: principal.userId
	};
};
