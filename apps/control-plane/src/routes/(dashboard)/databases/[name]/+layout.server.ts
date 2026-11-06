import { featureEnabled } from '@skiff/core';
import { core } from '#lib/server/core.js';
import type { LayoutServerLoad } from './$types';

/**
 * Shared by every database sub-route: whether `DB_STUDIO` is on, so `DatabaseHeader` can point
 * the Studio tab at the native workspace (plan 22) instead of the DBGate section.
 */
export const load: LayoutServerLoad = () => ({
	nativeStudio: featureEnabled(core.ctx.config, 'DB_STUDIO')
});
