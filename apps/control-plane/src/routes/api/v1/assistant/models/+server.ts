import { json } from '#lib/server/api.js';
import { listOpenRouterModels } from '#lib/server/assistant/openrouter.js';
import { canConfigurePlatform } from '#lib/server/platform-config.js';
import type { RequestHandler } from './$types';

/**
 * The owner-only model picker for Settings → Assistant. OpenRouter publishes its catalogue
 * publicly, so no key is needed for this call; the `x-title` header identifies Skiff. The route is
 * gated with the same rule as the settings page, so a deployer or an API key cannot browse it.
 */
export const GET: RequestHandler = async ({ locals, url }) => {
	if (!canConfigurePlatform(locals.principal))
		return json(
			{ error: 'forbidden', message: 'Only the owner can browse assistant models.' },
			403
		);
	if ((url.searchParams.get('provider') ?? 'openrouter') !== 'openrouter')
		return json(
			{
				error: 'unsupported_provider',
				message: 'Model browsing is available for the OpenRouter provider.'
			},
			400
		);
	const result = await listOpenRouterModels({
		force: url.searchParams.get('refresh') === '1',
		signal: AbortSignal.timeout(15_000)
	});
	if (!result.ok) return json({ error: 'provider_error', message: result.message }, 502);
	return json({ provider: 'openrouter', models: result.models }, 200, {
		'cache-control': 'private, max-age=300'
	});
};
