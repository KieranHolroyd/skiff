import { error, fail } from '@sveltejs/kit';
import { CoreError } from '@yoal/core';
import {
	hasPermission,
	isTerminalOperation,
	itemStatuses,
	itemVerdicts,
	type ItemStatus,
	type ItemVerdict
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, toFormFailure } from '../../../../_lib/errors.js';
import { actorNames } from '../../../../_lib/operations/actors.server.js';
import type { Actions, PageServerLoad } from './$types';

const PAGE = 100;

/** One operation: counters, live progress and its items (docs/OPERATIONS.md §6.4). */
export const load: PageServerLoad = ({ locals, params, url }) => {
	const principal = locals.principal!;
	const rawStatus = url.searchParams.get('status') ?? '';
	const rawVerdict = url.searchParams.get('verdict') ?? '';
	const status = (itemStatuses as readonly string[]).includes(rawStatus)
		? (rawStatus as ItemStatus)
		: undefined;
	const verdict = (itemVerdicts as readonly string[]).includes(rawVerdict)
		? (rawVerdict as ItemVerdict)
		: undefined;
	const after = Math.max(0, Math.floor(Number(url.searchParams.get('after')) || 0));

	try {
		const operation = core.operations.get(principal, params.id);
		const page = core.operations.items(principal, params.id, {
			after,
			limit: PAGE,
			status,
			verdict
		});
		const mine = operation.actor.id === principal.userId;
		const runnable = core.operations
			.actions(principal)
			.some((action) => action.id === operation.action);
		return {
			operation,
			items: page.items,
			cursor: page.cursor,
			hasMore: page.hasMore,
			filters: { status: status ?? '', verdict: verdict ?? '', after },
			actor: operation.actor.id
				? (actorNames([operation.actor.id])[operation.actor.id] ?? operation.actor.id)
				: null,
			mine,
			canCancel:
				!isTerminalOperation(operation.status) &&
				(mine ||
					hasPermission(principal, 'project:delete') ||
					(core.ctx.platformIam.canMaintain(principal) && operation.scope === 'platform')),
			canApply: operation.status === 'planned' && mine && runnable
		};
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}
};

export const actions: Actions = {
	cancel: ({ locals, params }) => {
		try {
			core.operations.cancel(locals.principal!, params.id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Cancelled.' };
	},

	apply: ({ locals, params }) => {
		try {
			core.operations.apply(locals.principal!, params.id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Applying the plan.' };
	}
};
