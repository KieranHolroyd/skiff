import { error, fail, type Action } from '@sveltejs/kit';
import {
	emailOrgStates,
	type EmailOrgState,
	type EmailOrgView,
	type Principal
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import {
	failStatus,
	formBoolean,
	formOptionalPositiveInt,
	formString,
	toFormFailure
} from '../../_lib/errors.js';

/**
 * The platform half of Email (docs/EMAIL.md §3.3): the mail node, the mail domain, the global
 * pause, the platform DNS and an organisation's limits. Email → Mail server shows all of it, and the
 * overview's setup checklist embeds the node picker, so both pages share these loaders and actions.
 * `core.email` re-checks that the caller is a platform admin on every change.
 */

const MAIL_CAPABILITY = 'mail';

export function isPlatformAdmin(principal: Principal | null | undefined): principal is Principal {
	return !!principal && core.ctx.platformIam.canAdminister(principal);
}

export function requirePlatformAdmin(locals: App.Locals): Principal {
	if (!isPlatformAdmin(locals.principal)) error(403, 'Only a platform admin can configure email.');
	return locals.principal!;
}

export type MailNodeOption = ReturnType<typeof mailNodes>[number];

/** Every node, and whether its agent can run skiff-mail. Platform admin only. */
export function mailNodes(principal: Principal) {
	return core.nodes.list(principal).map((node) => ({
		id: node.id,
		name: node.name,
		mode: node.mode,
		status: node.status,
		agentVersion: node.agentVersion,
		mail: node.capabilities.includes(MAIL_CAPABILITY)
	}));
}

/** The mail node's public IPv4, from its platform A record, which every member may see. */
export function mailNodeIp(): string | null {
	const settings = core.email.settings();
	return (
		core.email
			.platformRecords()
			.find((record) => record.type === 'A' && record.name === settings.hostnames.helo)?.value ??
		null
	);
}

/** Everything Email → Mail server shows. */
export function loadMailServer(principal: Principal) {
	const settings = core.email.settings();
	const nodes = mailNodes(principal);
	let emailOrg: EmailOrgView | null = null;
	try {
		emailOrg = core.email.orgView(principal);
	} catch {
		// Without email:read in this org the limits editor still saves; it just can't show usage.
	}
	return {
		settings,
		nodes,
		mailNode: nodes.find((node) => node.id === settings.nodeId) ?? null,
		platformRecords: core.email.platformRecords(),
		emailOrg
	};
}

const node: Action = async ({ request, locals }) => {
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
				? 'Mail node saved. Its agent starts skiff-mail on the next reconcile; point reverse DNS at it next.'
				: 'Email is switched off: no node sends or receives mail.'
		};
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
};

const mailDomain: Action = async ({ request, locals }) => {
	const principal = requirePlatformAdmin(locals);
	const data = await request.formData();
	const value = formString(data, 'reset') ? null : formString(data, 'mailDomain') || null;
	try {
		const settings = await core.email.configure(principal, { mailDomain: value });
		return {
			success:
				settings.mailDomainSource === 'content'
					? `Mail hostnames are back on the content domain, ${settings.mailDomain}.`
					: `Mail hostnames now live under ${settings.mailDomain}. Publish the platform records and update the PTR.`
		};
	} catch (caught) {
		return fail(failStatus(caught), toFormFailure(caught));
	}
};

const pause: Action = async ({ request, locals }) => {
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
};

const org: Action = async ({ request, locals }) => {
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
};

/** The mail server's form actions. The overview spreads in `node` for its first setup step. */
export const mailServerActions = { node, mailDomain, pause, org };
