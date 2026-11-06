import type { BlastRadiusView } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	try {
		const view = core.topology.view(principal);
		const blast: Record<string, BlastRadiusView> = {};
		for (const node of view.nodes)
			blast[node.id] = core.topology.blastRadius(principal, { kind: 'node', id: node.id });
		return { view, blast, denied: false };
	} catch {
		return { view: null, blast: {}, denied: true };
	}
};
