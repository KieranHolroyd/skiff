import { hasPermission, type BlueprintStackView } from '@yoal/contracts';
import { featureEnabled } from '@yoal/core';
import { core } from '#lib/server/core.js';
import type { PageServerLoad } from './$types';

/**
 * Paste a blueprint, review the plan, apply it and follow the run (plan 11). The page talks to
 * `/api/v1/blueprints/*` with the session cookie; every rule lives in `core.blueprints`.
 */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	const enabled = featureEnabled(core.ctx.config, 'BLUEPRINTS');
	let stacks: BlueprintStackView[] = [];
	if (enabled) {
		try {
			stacks = core.blueprints.list(principal);
		} catch {
			// No project:read; the list is simply hidden.
		}
	}
	return {
		enabled,
		// The page lists stacks; their stored documents stay on the server.
		stacks: stacks.map((stack) => ({ ...stack, document: null })),
		canApply: hasPermission(principal, 'project:update')
	};
};
