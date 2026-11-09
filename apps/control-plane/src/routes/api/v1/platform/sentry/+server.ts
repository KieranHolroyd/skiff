import {
	sentrySettingsInputSchema,
	type SentryRuntimeStatus,
	type SentrySettingsView
} from '@yoal/contracts';
import { core } from '#lib/server/core.js';
import { readJson, route } from '#lib/server/api.js';
import { requirePrincipal } from '#lib/server/principal.js';
import { reconfigureSentry, sentryRuntime } from '#lib/server/sentry.js';
import type { RequestHandler } from './$types';

/**
 * Optional Sentry forwarding (docs/SERVER-ERRORS.md §6). Settings are stored in the platform
 * database and take effect without a restart. Passing an auth token seals it; it is never returned.
 * Platform admins only.
 */
interface SentrySettingsResponse {
	settings: SentrySettingsView;
	runtime: SentryRuntimeStatus;
}

export const GET: RequestHandler = (event) =>
	route((): SentrySettingsResponse => {
		const principal = requirePrincipal(event);
		return { settings: core.sentry.view(principal), runtime: sentryRuntime() };
	});

export const PATCH: RequestHandler = (event) =>
	route(async (): Promise<SentrySettingsResponse> => {
		const principal = requirePrincipal(event);
		const body = await readJson(event.request, sentrySettingsInputSchema);
		const settings = core.sentry.save(principal, body);
		await reconfigureSentry();
		return { settings, runtime: sentryRuntime() };
	});
