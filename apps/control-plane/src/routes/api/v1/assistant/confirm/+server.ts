import * as z from 'zod';
import { hasPermission } from '@yoal/contracts';
import { json, readJson, route } from '#lib/server/api.js';
import { runConfirmed } from '#lib/server/assistant/orchestrator.js';
import type { RequestHandler } from './$types';

const bodySchema = z.object({ token: z.string().min(1).max(20_000) });

/**
 * Execute one destructive assistant action the user approved in the chat. The token is signed and
 * bound to this user and org (docs/ASSISTANT.md); the normal service-layer permissions still apply.
 */
export const POST: RequestHandler = async ({ locals, request }) =>
	route(async () => {
		const principal = locals.principal;
		if (!principal) return json({ error: 'unauthorized' }, 401);
		if (!hasPermission(principal, 'project:read'))
			return json(
				{ error: 'forbidden', message: 'You need project read access to use the assistant.' },
				403
			);
		const { token } = await readJson(request, bodySchema);
		try {
			return await runConfirmed(principal, token);
		} catch (error) {
			return json(
				{
					error: 'confirmation_failed',
					message: error instanceof Error ? error.message : 'Could not confirm.'
				},
				400
			);
		}
	});
