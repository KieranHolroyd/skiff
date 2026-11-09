import { fail } from '@sveltejs/kit';
import {
	serverErrorSources,
	type ServerErrorListQuery,
	type ServerErrorSource
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, toFormFailure } from '../../_lib/errors.js';
import { canChangeErrors, formStatus, requireErrorViewer } from './_lib/access.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Server errors (docs/SERVER-ERRORS.md, D171): the control plane's own exceptions and
 * 5xx answers, grouped into issues. Filters live in the URL so a view can be linked.
 */

const STATUSES = ['unresolved', 'resolved', 'ignored', 'all'] as const;
type StatusFilter = (typeof STATUSES)[number];

export const load: PageServerLoad = ({ locals, url }) => {
	const principal = requireErrorViewer(locals);
	const rawStatus = url.searchParams.get('status') ?? 'unresolved';
	const status: StatusFilter = (STATUSES as readonly string[]).includes(rawStatus)
		? (rawStatus as StatusFilter)
		: 'unresolved';
	const rawSource = url.searchParams.get('source') ?? '';
	const source = (serverErrorSources as readonly string[]).includes(rawSource)
		? (rawSource as ServerErrorSource)
		: undefined;
	const q = url.searchParams.get('q')?.trim().slice(0, 200) || undefined;
	const before = Number(url.searchParams.get('before')) || undefined;

	const query: ServerErrorListQuery = { status, source, q, before, limit: 50 };
	const list = core.serverErrors.list(principal, query);
	return {
		...list,
		filters: { status, source: source ?? '', q: q ?? '', before: before ?? null },
		canChange: canChangeErrors(principal),
		now: Date.now()
	};
};

/** `id` entries (the bulk form) and/or a comma-joined `ids` (the confirm dialog). */
function ids(data: FormData): string[] {
	const joined = data.get('ids');
	return [...data.getAll('id'), ...(typeof joined === 'string' ? joined.split(',') : [])].filter(
		(value): value is string => typeof value === 'string' && value.trim().length > 0
	);
}

export const actions: Actions = {
	status: async ({ request, locals }) => {
		const principal = requireErrorViewer(locals);
		const data = await request.formData();
		const status = formStatus(data.get('status'));
		const selected = ids(data);
		if (!status) return fail(400, { message: 'Choose resolved, ignored or unresolved.' });
		if (selected.length === 0) return fail(400, { message: 'Select at least one issue.' });
		try {
			const changed = core.serverErrors.setStatus(principal, selected, status);
			return { success: `${changed} ${changed === 1 ? 'issue' : 'issues'} marked ${status}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	delete: async ({ request, locals }) => {
		const principal = requireErrorViewer(locals);
		const selected = ids(await request.formData());
		if (selected.length === 0) return fail(400, { message: 'Select at least one issue.' });
		try {
			const deleted = core.serverErrors.delete(principal, selected);
			return { success: `Deleted ${deleted} ${deleted === 1 ? 'issue' : 'issues'}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	}
};
