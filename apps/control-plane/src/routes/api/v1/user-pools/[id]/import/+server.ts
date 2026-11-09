import type { RequestHandler } from './$types';
import { userPoolImportSchema } from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import { json, readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';

/**
 * Import users from Auth0, Cognito, Firebase or a Skiff pool export (IAM.md I29, §11.2). Send
 * `{ dryRun: true }` first to get the same counts without writing anything. The caller needs
 * `userPool:manage-users`; a hash the engine cannot verify forces a password reset.
 */
export const POST: RequestHandler = (event) =>
	route(async () => {
		const principal = requirePrincipal(event);
		const input = await readJson(event.request, userPoolImportSchema);
		const report = await core.userPools.importPool(principal, event.params.id, input);
		return json(report, input.dryRun ? 200 : 201);
	});
