import { error, fail } from '@sveltejs/kit';
import { CoreError } from '@skiff/core';
import { accessModes, hasPermission } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import {
	failStatus,
	formOptionalPositiveInt,
	formOptionalString,
	formRawString,
	formString,
	toFormFailure
} from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	const principal = locals.principal!;
	try {
		const project = await core.projects.get(principal, params.slug);
		const row = core.projects.requireRow(principal, params.slug);
		const deployments = core.deployments.list(principal, row, { limit: 50 });
		let shareLinks: Awaited<ReturnType<typeof core.access.listShareLinks>> = [];
		if (hasPermission(principal, 'shareLink:read')) {
			try {
				shareLinks = core.access.listShareLinks(principal, row);
			} catch {
				// The project can still be inspected without share-link visibility.
			}
		}

		return {
			project,
			deployments,
			shareLinks,
			can: {
				update: hasPermission(principal, 'project:update'),
				deleteProject: hasPermission(principal, 'project:delete'),
				promote: hasPermission(principal, 'deployment:promote'),
				rollback: hasPermission(principal, 'deployment:rollback'),
				deleteDeployment: hasPermission(principal, 'deployment:delete'),
				createShare: hasPermission(principal, 'shareLink:create'),
				revokeShare: hasPermission(principal, 'shareLink:revoke')
			}
		};
	} catch (caught) {
		if (caught instanceof CoreError)
			error(caught.status === 404 ? 404 : caught.status, caught.message);
		throw caught;
	}
};

export const actions: Actions = {
	setAccess: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const scope = formString(data, 'scope');
		const mode = formString(data, 'mode');
		const password = formRawString(data, 'password');

		const fieldErrors: Record<string, string> = {};
		if (scope !== 'production' && scope !== 'previews')
			fieldErrors.scope = 'Choose production or previews.';
		if (!(accessModes as readonly string[]).includes(mode))
			fieldErrors.mode = 'Choose a valid access mode.';
		if (mode === 'password' && password.length < 8) {
			fieldErrors.password = 'Use at least 8 characters for password mode.';
		}
		if (Object.keys(fieldErrors).length > 0) {
			return fail(400, { message: 'Check the access settings.', fieldErrors });
		}

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.projects.setAccess(principal, project.slug, {
				scope: scope as 'production' | 'previews',
				mode: mode as (typeof accessModes)[number],
				password: mode === 'password' ? password : undefined
			});
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return {
			success: `${scope === 'production' ? 'Production' : 'Preview'} access set to ${mode}; agents converge within seconds.`
		};
	},

	promote: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'deploymentId');
		if (!id) return fail(400, { message: 'Missing deployment id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.promote(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Production pointer moved. Traffic switches on the next reconcile.' };
	},

	rollback: async ({ locals, params }) => {
		const principal = locals.principal!;
		try {
			const project = core.projects.requireRow(principal, params.slug);
			const deployment = await core.deployments.rollback(principal, project);
			return { success: `Rolled back to ${deployment.shortId}.` };
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	pin: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'deploymentId');
		const pinned = formString(data, 'pinned') === 'true';
		if (!id) return fail(400, { message: 'Missing deployment id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.setPinned(principal, project, id, pinned);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return {
			success: pinned ? 'Deployment pinned; retention will keep it.' : 'Deployment unpinned.'
		};
	},

	deleteDeployment: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'deploymentId');
		if (!id) return fail(400, { message: 'Missing deployment id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.deployments.delete(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Deployment deleted. Its preview URL stops working on the next reconcile.' };
	},

	createShare: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const expiresRaw = formString(data, 'expiresAt') || formString(data, 'expiresAtLocal');
		const maxRedemptions = formOptionalPositiveInt(data, 'maxRedemptions');
		const note = formOptionalString(data, 'note');
		const deploymentId = formOptionalString(data, 'deploymentId');

		let expiresAt: string | undefined;
		if (expiresRaw) {
			const timestamp = Date.parse(expiresRaw);
			if (!Number.isFinite(timestamp)) {
				return fail(400, {
					message: 'Choose a valid expiry date.',
					fieldErrors: { expiresAt: 'Invalid date and time.' }
				});
			}
			if (timestamp <= Date.now()) {
				return fail(400, {
					message: 'Expiry must be in the future.',
					fieldErrors: { expiresAt: 'Choose a future date.' }
				});
			}
			expiresAt = new Date(timestamp).toISOString();
		}
		if (maxRedemptions === null) {
			return fail(400, {
				message: 'Maximum redemptions must be a positive whole number.',
				fieldErrors: { maxRedemptions: 'Enter a positive whole number.' }
			});
		}

		try {
			const project = core.projects.requireRow(principal, params.slug);
			const share = await core.access.createShareLink(principal, project, {
				deploymentId,
				expiresAt,
				maxRedemptions,
				note
			});
			return {
				success: 'Share link created. Copy it now — the token is shown only once.',
				shareUrl: share.url,
				shareHost: share.host
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	revokeShare: async ({ request, locals, params }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const id = formString(data, 'shareId');
		if (!id) return fail(400, { message: 'Missing share link id.' });

		try {
			const project = core.projects.requireRow(principal, params.slug);
			await core.access.revokeShareLink(principal, project, id);
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}

		return { success: 'Share link revoked. Sessions are pushed to agents within seconds.' };
	}
};
