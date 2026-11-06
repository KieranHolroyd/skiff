import { fail } from '@sveltejs/kit';
import type { NodeView } from '@skiff/core';
import { core } from '#lib/server/core.js';
import { updateSource } from '#lib/server/self-update.js';
import { platformVersion } from '#lib/server/version.js';
import { failStatus, formString, toFormFailure } from '../../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

/** Pasted into a shell by the operator, so keep both values to a strict, quote-free alphabet. */
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TUNNEL_ADDRESS = /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]{1,253}):(\d{1,5})$/;

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	let nodes: NodeView[] = [];
	let denied = false;
	try {
		nodes = core.nodes.list(principal);
	} catch {
		denied = true;
	}

	const platformOrigin = core.ctx.config.platformOrigin;
	let platformHost = platformOrigin;
	try {
		platformHost = new URL(platformOrigin).hostname;
	} catch {
		// Bootstrap origins are always URLs; fall back to the raw value if not.
	}

	return {
		denied,
		hasEdge: nodes.some((node) => node.mode === 'edge'),
		workers: nodes
			.filter((node) => node.mode === 'worker')
			.map((node) => ({
				id: node.id,
				name: node.name,
				status: node.status,
				publicAddress: node.publicAddress
			})),
		platformOrigin,
		platformHost,
		contentDomain: core.ctx.config.contentDomain,
		platformVersion,
		/** The repository this install tracks (a fork, if it was installed from one). */
		sourceRepo: updateSource().repo
	};
};

export const actions: Actions = {
	createToken: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const name = formString(data, 'name');
		const publicAddress = formString(data, 'publicAddress');

		const fieldErrors: Record<string, string> = {};
		if (!NODE_NAME.test(name))
			fieldErrors.name = 'Use 1–64 letters, digits, dots, dashes or underscores.';
		const address = TUNNEL_ADDRESS.exec(publicAddress);
		const port = address ? Number(address[2]) : 0;
		if (!address || port < 1 || port > 65535)
			fieldErrors.publicAddress = 'Use the worker’s tunnel IP and Caddy port, e.g. 10.88.0.2:8080.';
		if (Object.keys(fieldErrors).length > 0)
			return fail(400, { message: 'Check the node name and tunnel address.', fieldErrors });

		try {
			const token = core.nodes.createJoinToken(principal, name);
			const origin = core.ctx.config.platformOrigin;
			const command = [
				`sudo -u skiff /opt/skiff/current/agent/skiff-agent join ${origin} \\`,
				`  --token ${token.token} \\`,
				`  --name ${name} \\`,
				`  --public-address ${publicAddress} \\`,
				`  --data-dir /var/lib/skiff/agent \\`,
				`  | sudo tee /etc/skiff/agent.env >/dev/null`,
				`sudo chown root:skiff /etc/skiff/agent.env && sudo chmod 0640 /etc/skiff/agent.env`
			].join('\n');
			return {
				success: 'Join command created. It is single-use and expires in one hour.',
				command,
				expiresAt: token.expiresAt
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	}
};
