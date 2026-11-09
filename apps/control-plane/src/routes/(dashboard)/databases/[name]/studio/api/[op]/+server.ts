import type { RequestHandler } from './$types';
import { featureEnabled, studioFingerprint } from '@yoal/core';
import { core } from '#lib/server/core.js';
import { handleStudioCall, type StudioProxyDeps } from '#lib/studio/proxy.server.js';

/**
 * Native studio calls (plan 22): `POST …/studio/api/<op>` with a protocol body. The dashboard
 * session authenticates; the session token is added here and never reaches the browser.
 */

const deps: StudioProxyDeps = {
	enabled: () => featureEnabled(core.ctx.config, 'DB_STUDIO'),
	studio: core.databaseStudio,
	gatewayPort: () => core.ctx.config.databaseGatewayPort ?? 8082,
	fingerprint: studioFingerprint
};

export const POST: RequestHandler = (event) =>
	handleStudioCall(deps, {
		principal: event.locals.principal,
		name: event.params.name,
		op: event.params.op,
		request: event.request
	});
