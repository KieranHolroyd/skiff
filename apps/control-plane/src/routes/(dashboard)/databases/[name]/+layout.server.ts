import { featureEnabled } from '@skiff/core';
import { core } from '#lib/server/core.js';
import type { LayoutServerLoad } from './$types';

/**
 * Shared by every database sub-route: whether the native studio (D96) is on, so `DatabaseHeader`
 * shows the Studio tab. `DB_STUDIO` defaults on and is kept as a kill switch.
 */
export const load: LayoutServerLoad = () => ({
	studioEnabled: featureEnabled(core.ctx.config, 'DB_STUDIO')
});
