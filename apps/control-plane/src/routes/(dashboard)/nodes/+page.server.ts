import { fail } from '@sveltejs/kit';
import type { NodeView } from '@skiff/core';
import type { DiskView, NodeCapacityView, NodeRole } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import {
	failStatus,
	formBoolean,
	formOptionalPositiveInt,
	formString,
	toFormFailure
} from '../_lib/errors.js';
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

	// Disks per node, read-only here; adding and editing them is Settings → Storage (D169).
	const disksByNode: Record<string, DiskView[]> = {};
	if (!denied) {
		try {
			for (const node of core.disks.overview(principal).nodes) disksByNode[node.id] = node.disks;
		} catch {
			// Platform viewers without storage read keep the rest of the page.
		}
	}

	return {
		nodes,
		capacity,
		denied,
		disksByNode,
		platformOrigin: core.ctx.config.platformOrigin,
		/** The release nodes should run: the control plane's own version (D99). */
		targetVersion: core.ctx.config.desiredAgentVersion ?? null
	};
};

export const actions: Actions = {
	createToken: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const managed = formString(data, 'networkMode') !== 'external';
		try {
			// The first node to join becomes the edge; later ones are workers and need an address
			// the edge can proxy to (see /nodes/vpn for the WireGuard walkthrough).
			const hasEdge = core.nodes.list(principal).some((node) => node.mode === 'edge');
			const token = core.nodes.createJoinToken(principal, hasEdge ? undefined : 'edge');
			const command = hasEdge
				? managed
					? `curl -fsSL ${core.ctx.config.platformOrigin}/install/node.sh | sudo sh -s -- --token ${token.token} --name <name>`
					: `sudo skiff-agent join ${core.ctx.config.platformOrigin} --token ${token.token} --name <name> --public-address <tunnel-ip>:<port>`
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

	updateNode: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });
		const name = formString(data, 'name');
		if (!name) return fail(400, { message: 'Give the node a name.' });
		const sliceMemoryMb = formOptionalPositiveInt(data, 'sliceMemoryMb');
		const sliceCpuWeight = formOptionalPositiveInt(data, 'sliceCpuWeight');
		if (sliceMemoryMb === null) return fail(400, { message: 'Slice memory must be a whole number of MB.' });
		if (sliceCpuWeight === null) return fail(400, { message: 'CPU weight must be a whole number.' });
		const roles = data.getAll('roles').map(String).filter(Boolean) as NodeRole[];
		if (roles.length === 0) return fail(400, { message: 'A node needs at least one role.' });
		const cpuBudgetRaw = formString(data, 'cpuBudgetMillis');
		const cpuBudgetMillis = cpuBudgetRaw ? Number(cpuBudgetRaw) : null;
		if (cpuBudgetRaw && (!Number.isInteger(cpuBudgetMillis) || (cpuBudgetMillis ?? 0) <= 0))
			return fail(400, { message: 'CPU budget must be a positive whole number of millis.' });
		const labels: Record<string, string> = {};
		for (const line of formString(data, 'labels').split(/\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const at = trimmed.indexOf('=');
			if (at <= 0) return fail(400, { message: `Label "${trimmed}" needs the form key=value.` });
			labels[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
		}

		try {
			core.nodes.update(principal, nodeId, {
				name,
				publicAddress: formString(data, 'publicAddress') || null,
				sliceMemoryMb,
				sliceCpuWeight,
				canBuild: formBoolean(data, 'canBuild'),
				zone: formString(data, 'zone') || 'default',
				roles,
				labels,
				lanEndpoint: formString(data, 'lanEndpoint') || null,
				cpuBudgetMillis,
				// Blank restores the install default.
				dataDir: formString(data, 'dataDir') || null,
				buildDir: formString(data, 'buildDir') || null
			});
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}

		return { success: 'Node updated. The agent applies the change on its next pull.' };
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

	setEdge: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });
		try {
			const node = core.nodes.setEdge(principal, nodeId);
			return {
				success: `${node.name} is now the edge node. Static sites move to it on the next pull; point DNS at it if it is a different machine.`
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	removeNode: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });

		try {
			const { requeuedBuilds } = core.nodes.remove(principal, nodeId);
			const builds =
				requeuedBuilds > 0
					? ` ${requeuedBuilds} build${requeuedBuilds === 1 ? '' : 's'} it had claimed went back to the queue.`
					: '';
			return {
				success: `Node removed and its token revoked.${builds} Uninstall the agent on the machine to stop it.`
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
	},

	updateAgent: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		const nodeId = formString(data, 'nodeId');
		if (!nodeId) return fail(400, { message: 'Missing node id.' });

		try {
			const node = core.nodes.requestUpdate(principal, nodeId);
			return {
				success: `${node.name} will install ${node.update?.version ?? 'the new release'} on its next check. Its agent restarts when it is done.`
			};
		} catch (error) {
			return fail(failStatus(error), toFormFailure(error));
		}
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
