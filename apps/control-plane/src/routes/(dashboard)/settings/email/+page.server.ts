import { error, fail } from '@sveltejs/kit';
import {
	canAdministerPlatform,
	emailOrgStates,
	type EmailOrgState,
	type EmailOrgView,
	type Principal
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { features } from '#lib/server/config.js';
import {
	failStatus,
	formBoolean,
	formOptionalPositiveInt,
	formString,
	toFormFailure
} from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Email (docs/EMAIL.md §3.3): the mail node, the mail domain (the content domain or a
 * custom one), the global pause, the platform DNS the node needs, and this organisation's sandbox state and limits. `core.email` re-checks that the
 * caller is a platform admin on every change.
 */

const MAIL_CAPABILITY = 'mail';

function requirePlatformAdmin(locals: App.Locals): Principal {
	if (!locals.principal || !canAdministerPlatform(locals.principal))
		error(403, 'Only a platform admin can configure email.');
	return locals.principal;
}

export const load: PageServerLoad = ({ locals }) => {
	const principal = requirePlatformAdmin(locals);
	const settings = core.email.settings();
	const nodes = core.nodes.list(principal).map((node) => ({
		id: node.id,
		name: node.name,
		mode: node.mode,
		status: node.status,
		agentVersion: node.agentVersion,
		mail: node.capabilities.includes(MAIL_CAPABILITY)
	}));
	const mailNode = nodes.find((node) => node.id === settings.nodeId) ?? null;

	let emailOrg: EmailOrgView | null = null;
	try {
		emailOrg = core.email.orgView(principal);
	} catch {
		// Without email:read in this org the limits editor still saves; it just can't show usage.
	}

	return {
		enabled: features.EMAIL,
		settings,
		nodes,
		mailNode,
		platformRecords: core.email.platformRecords(),
		emailOrg
	};
};

export const actions: Actions = {
	node: async ({ request, locals }) => {
		const principal = requirePlatformAdmin(locals);
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		const ip = formString(data, 'ip');
		try {
			const settings = await core.email.configure(principal, {
				nodeId: nodeId || null,
				...(ip ? { ip } : {})
			});
			return {
				success: settings.nodeId
					? 'Mail node saved. Its agent starts skiff-mail on the next reconcile; publish the platform records below.'
					: 'Email is switched off: no node sends or receives mail.'
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	domain: async ({ request, locals }) => {
		const principal = requirePlatformAdmin(locals);
		const data = await request.formData();
		const mailDomain = formString(data, 'reset') ? null : formString(data, 'mailDomain') || null;
		try {
			const settings = await core.email.configure(principal, { mailDomain });
			return {
				success:
					settings.mailDomainSource === 'content'
						? `Mail hostnames are back on the content domain, ${settings.mailDomain}.`
						: `Mail hostnames now live under ${settings.mailDomain}. Publish the records below and update the PTR.`
			};
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
	},

	pause: async ({ request, locals }) => {
		const principal = requirePlatformAdmin(locals);
		const paused = formBoolean(await request.formData(), 'paused');
		try {
			await core.email.configure(principal, { paused });
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: paused
				? 'Delivery paused. Sends are still accepted and queued on the mail node.'
				: 'Delivery resumed. Queued mail goes out now.'
		};
	},

	org: async ({ request, locals }) => {
		const principal = requirePlatformAdmin(locals);
		const data = await request.formData();
		const state = formString(data, 'state');
		const perSecond = formOptionalPositiveInt(data, 'perSecond');
		const perDay = formOptionalPositiveInt(data, 'perDay');
		const fieldErrors: Record<string, string> = {};
		if (!(emailOrgStates as readonly string[]).includes(state)) fieldErrors.state = 'Pick a state.';
		if (perSecond === null) fieldErrors.perSecond = 'A whole number of at least 1.';
		if (perDay === null) fieldErrors.perDay = 'A whole number of at least 1.';
		if (Object.keys(fieldErrors).length > 0)
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors });
		try {
			core.email.setOrgState(principal, principal.orgId, {
				state: state as EmailOrgState,
				perSecond: perSecond ?? undefined,
				perDay: perDay ?? undefined
			});
		} catch (caught) {
			return fail(failStatus(caught), toFormFailure(caught));
		}
		return {
			success: 'Sending state and limits saved. The mail node picks them up within seconds.'
		};
	}
};
