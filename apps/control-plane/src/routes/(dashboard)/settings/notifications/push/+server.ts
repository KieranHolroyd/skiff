import { parsePushSubscription } from '@skiff/core';
import { canConfigurePlatform } from '#lib/server/platform-config.js';
import { pushStore, vapid } from '#lib/server/push.js';
import { describeUserAgent } from '#lib/user-agent.js';
import type { RequestHandler } from './$types';

/**
 * Register or drop this browser for push alerts (D108). JSON rather than a form action because the
 * service worker calls it too, on `pushsubscriptionchange`. Owner sessions only: API keys and MCP
 * clients have no browser to notify.
 */
function gate(locals: App.Locals): Response | string {
	const principal = locals.principal;
	if (!principal || principal.kind !== 'user' || !locals.user || !canConfigurePlatform(principal))
		return Response.json({ message: 'Only the owner can receive push alerts.' }, { status: 403 });
	if (!vapid)
		return Response.json(
			{ message: 'Push notifications are not set up on this server yet.' },
			{ status: 409 }
		);
	return principal.userId;
}

async function body(request: Request): Promise<Record<string, unknown> | null> {
	if (Number(request.headers.get('content-length') ?? 0) > 8192) return null;
	const value = await request.json().catch(() => null);
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = gate(locals);
	if (userId instanceof Response) return userId;
	const input = await body(request);
	const subscription = parsePushSubscription(input?.subscription);
	if (!subscription)
		return Response.json({ message: 'That is not a valid push subscription.' }, { status: 400 });
	if (
		typeof input?.previousEndpoint === 'string' &&
		input.previousEndpoint !== subscription.endpoint
	)
		pushStore.removeEndpoint(input.previousEndpoint, userId);
	const device = pushStore.save(
		userId,
		subscription,
		describeUserAgent(request.headers.get('user-agent'))
	);
	return Response.json({ id: device.id, device: device.device }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	const principal = locals.principal;
	if (!principal || principal.kind !== 'user' || !locals.user)
		return Response.json({ message: 'Sign in first.' }, { status: 401 });
	const input = await body(request);
	if (typeof input?.endpoint !== 'string')
		return Response.json({ message: 'endpoint is required' }, { status: 400 });
	// Any signed-in user may drop their own device, even after losing the owner role.
	const removed = pushStore.removeEndpoint(input.endpoint, principal.userId);
	return Response.json({ removed });
};
