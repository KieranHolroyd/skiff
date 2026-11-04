import { fail } from '@sveltejs/kit';
import type { NodeView } from '@skiff/core';
import type { NodeCapacityView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { failStatus, formBoolean, formString, toFormFailure } from '../_lib/errors.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	let nodes: NodeView[] = [];
	let denied = false;
	let capacity: NodeCapacityView[] = [];
	try {
		nodes = core.nodes.list(principal);
		capacity = core.workloads.capacity(principal);
	} catch {
		denied = true;
	}

	return {
		nodes,
		capacity,
		denied,
		platformOrigin: core.ctx.config.platformOrigin
	};
};

export const actions: Actions = {
	createToken: async ({ locals }) => {
		const principal = locals.principal!;
		try {
			// The first node to join becomes the edge; later ones are workers and need an address
			// the edge can proxy to (see /nodes/vpn for the WireGuard walkthrough).
			const hasEdge = core.nodes.list(principal).some((node) => node.mode === 'edge');
			const token = core.nodes.createJoinToken(principal, hasEdge ? undefined : 'edge');
			const command = hasEdge
				? `sudo skiff-agent join ${core.ctx.config.platformOrigin} --token ${token.token} --name <name> --public-address <tunnel-ip>:<port>`
				: `sudo skiff-agent join ${core.ctx.config.platformOrigin} --token ${token.token} --name edge`;
			return {
				success: 'Join token created. It is single-use and expires in one hour.',
				token: token.token,
				command,
				expiresAt: token.expiresAt
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	setDraining: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		const draining = formBoolean(data, 'draining');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });

		try {
			core.nodes.setDraining(principal, nodeId, draining);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}

		return {
			success: draining
				? 'Node is draining. It stops receiving new placements.'
				: 'Node resumed and available for placements.'
		};
	},

	setBuilder: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		const builder = formBoolean(data, 'builder');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });

		try {
			core.nodes.setBuilder(principal, nodeId, builder);
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}

		return {
			success: builder
				? 'Node is now a Builder. It claims git builds one at a time.'
				: 'Builder role removed. Queued builds will wait for another Builder.'
		};
	},

	rotateToken: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });

		try {
			const rotated = core.nodes.rotateToken(principal, nodeId);
			return {
				success:
					'Node token rotated. Update /etc/skiff/agent.env on the node and restart the agent.',
				rotatedToken: rotated.token,
				nodeId
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	}
};
