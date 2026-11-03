import { error, fail } from '@sveltejs/kit';
import {
	validatePlatformConfigValue,
	type PlatformConfigKey,
	type PlatformConfigSection,
	type Principal
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import {
	OWNER_ONLY_MESSAGE,
	canConfigurePlatform,
	configAvailability,
	configInFlight,
	configPending,
	localRestartPending,
	readConfigStatus,
	saveConfigLocally,
	submitConfigRequest
} from '#lib/server/platform-config.js';

/** Shared by Settings → Backups and Settings → Notifications. */

export function requireOwnerPage(locals: App.Locals): Principal {
	if (!canConfigurePlatform(locals.principal)) error(403, OWNER_ONLY_MESSAGE);
	return locals.principal!;
}

export function configState() {
	const status = readConfigStatus();
	return {
		availability: configAvailability(),
		status,
		pending: configPending(),
		inFlight: configInFlight(status),
		/** Dev server: saved settings apply after a restart. */
		restartPending: localRestartPending()
	};
}

type Body = Parameters<typeof submitConfigRequest>[1];

/**
 * Gate, then queue a request for the root helper and audit it (keys only, never values).
 * Returns a form-action result.
 */
export function queueConfig(locals: App.Locals, body: Body, success: string) {
	const principal = locals.principal;
	if (!principal || !canConfigurePlatform(principal))
		return fail(403, { message: OWNER_ONLY_MESSAGE });
	const availability = configAvailability();
	if (availability === 'local') {
		// Dev server: no root helper; save to .data/platform-settings.json (see local-settings.ts).
		try {
			const changed = saveConfigLocally(principal, body);
			core.ctx.audit.record({
				principal,
				action: 'platform.config',
				resource: 'platform',
				args: { local: true, changed },
				result: 'ok'
			});
			return {
				success: changed.length
					? 'Saved to .data/platform-settings.json. Restart the dev server to use the new settings.'
					: 'Nothing changed; the settings already match.'
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	}
	if (availability === 'unmanaged')
		return fail(409, {
			message:
				'This control plane is not an installed release, so its settings come from the shell environment. Edit them there.'
		});
	if (availability === 'not-enabled')
		return fail(409, {
			message:
				'Dashboard settings are not enabled on this host yet. Run `sudo skiff-update-self check` on the server once.'
		});
	if (configInFlight())
		return fail(409, {
			message: 'Another settings change is still being applied. Try again in a moment.'
		});

	const args =
		body.action === 'configure'
			? { section: body.section, set: Object.keys(body.set), unset: body.unset }
			: body.action === 'backups'
				? { enabled: body.enabled }
				: {};
	const action =
		body.action === 'configure'
			? 'platform.config'
			: body.action === 'backups'
				? 'platform.backups'
				: 'platform.restoreDrill';
	try {
		const requestId = submitConfigRequest(principal, body);
		core.ctx.audit.record({
			principal,
			action,
			resource: 'platform',
			args: { ...args, requestId },
			result: 'ok'
		});
		return { success, requestId };
	} catch (cause) {
		const message = (cause as Error).message;
		core.ctx.audit.record({
			principal,
			action,
			resource: 'platform',
			args,
			result: 'error',
			error: message
		});
		return fail(400, { message: `Could not queue the change: ${message}` });
	}
}

/**
 * Turn submitted fields into `set`/`unset` for a section. Blank secret fields keep the current
 * value; blank optional fields are removed. Returns field errors keyed by form field name.
 */
export function collect(
	fields: Array<{
		field: string;
		key: PlatformConfigKey;
		value: string;
		secret?: boolean;
		required?: boolean;
		label: string;
	}>
): { set: Record<string, string>; unset: string[]; fieldErrors: Record<string, string> } {
	const set: Record<string, string> = {};
	const unset: string[] = [];
	const fieldErrors: Record<string, string> = {};
	for (const { field, key, value, secret, required, label } of fields) {
		if (!value) {
			if (secret) {
				if (required && !process.env[key]) fieldErrors[field] = `${label} is required.`;
				continue;
			}
			if (required) fieldErrors[field] = `${label} is required.`;
			else unset.push(key);
			continue;
		}
		const problem = validatePlatformConfigValue(key, value);
		if (problem) fieldErrors[field] = `${label} ${problem}.`;
		else set[key] = value;
	}
	return { set, unset, fieldErrors };
}

export function fieldFailure(fieldErrors: Record<string, string>) {
	return fail(400, { message: Object.values(fieldErrors)[0] ?? 'Check the form.', fieldErrors });
}

export type Section = PlatformConfigSection;
