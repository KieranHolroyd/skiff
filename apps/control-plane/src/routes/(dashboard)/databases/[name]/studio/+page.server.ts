import { error, fail } from '@sveltejs/kit';
import { CoreError, featureEnabled } from '@skiff/core';
import {
	databaseStudioOpenSchema,
	type DatabaseStudioView,
	type DatabaseView
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formString, toFormFailure } from '../../../_lib/errors.js';
import { databaseCan, fieldErrorsFrom } from '../../_lib/forms.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * The native database studio workspace (plan 22, D96). `DB_STUDIO` defaults on and is kept as a
 * kill switch: with the flag off the route does not exist and the Studio tab is hidden.
 */

function requireEnabled() {
	if (!featureEnabled(core.ctx.config, 'DB_STUDIO')) error(404, 'Not found');
}

export const load: PageServerLoad = ({ locals, params }) => {
	requireEnabled();
	const principal = locals.principal!;
	let database: DatabaseView;
	try {
		database = core.databases.get(principal, params.name, { includeDeleted: true });
	} catch (caught) {
		if (caught instanceof CoreError) error(caught.status, caught.message);
		throw caught;
	}

	const dbCan = databaseCan(principal);
	let studio: DatabaseStudioView | null = null;
	let studioError: string | null = null;
	if (dbCan.console && database.deletedAt === null) {
		try {
			studio = core.databaseStudio.view(principal, params.name);
		} catch (caught) {
			studioError = caught instanceof Error ? caught.message : 'Could not read the studio session.';
		}
	}

	return {
		database,
		dbCan,
		/** Enabling writes needs `database:update` on top of `database:console`. */
		canWrite: dbCan.update,
		studio,
		studioError
	};
};

export const actions: Actions = {
	open: async ({ request, locals, params }) => {
		requireEnabled();
		const principal = locals.principal!;
		const data = await request.formData();
		// The form omits `readOnly` for the safe default; `readOnly=0` opts in to writes.
		const readOnly = formString(data, 'readOnly') !== '0';
		const parsed = databaseStudioOpenSchema.safeParse({ readOnly });
		if (!parsed.success) {
			return fail(400, {
				message: parsed.error.issues[0]?.message ?? 'Could not open the studio.',
				fieldErrors: fieldErrorsFrom(parsed.error.issues)
			});
		}
		try {
			core.databaseStudio.open(principal, params.name, parsed.data);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: readOnly
				? 'Studio open in read-only mode.'
				: 'Writes enabled for this studio session only.'
		};
	},

	close: async ({ locals, params }) => {
		requireEnabled();
		const principal = locals.principal!;
		try {
			core.databaseStudio.close(principal, params.name);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return { success: 'Studio closed.' };
	}
};
