import { fail } from '@sveltejs/kit';
import {
	PLATFORM_POLICY_DEFAULTS,
	type PlatformPolicies,
	type PlatformPolicyKey
} from '@skiff/contracts';
import { ValidationError } from '@skiff/core';
import { assistantStatus } from '#lib/server/assistant/config.js';
import { core } from '#lib/server/core.js';
import { formString } from '../../_lib/errors.js';
import { requireOwnerPage } from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Policies: retention windows, alert thresholds, new-database defaults and assistant
 * caps (packages/contracts/src/platform-policies.ts). Stored in the database, so the maintenance
 * loop and the next request use a change without a restart.
 */

export const load: PageServerLoad = ({ locals }) => {
	requireOwnerPage(locals);
	return {
		policies: core.policies.get(),
		defaults: PLATFORM_POLICY_DEFAULTS,
		assistantConfigured: assistantStatus().configured
	};
};

const TEXT_KEYS = new Set<PlatformPolicyKey>(['databaseBackupSchedule', 'ingressDriver']);

export const actions: Actions = {
	save: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const update: Partial<Record<PlatformPolicyKey, string | number>> = {};
		const fieldErrors: Record<string, string> = {};
		for (const key of Object.keys(PLATFORM_POLICY_DEFAULTS) as PlatformPolicyKey[]) {
			if (!data.has(key)) continue;
			const raw = formString(data, key);
			if (TEXT_KEYS.has(key)) {
				update[key] = raw;
				continue;
			}
			const value = Number(raw);
			if (!raw || !Number.isInteger(value)) fieldErrors[key] = 'Enter a whole number.';
			else update[key] = value;
		}
		if (Object.keys(fieldErrors).length)
			return fail(400, { message: 'Check the highlighted fields.', fieldErrors });

		const before = core.policies.get();
		try {
			const saved = core.policies.update(principal, update);
			const changed = (Object.keys(saved) as PlatformPolicyKey[]).filter(
				(key) => saved[key] !== before[key]
			);
			core.ctx.audit.record({
				principal,
				action: 'platform.policies',
				resource: 'platform',
				args: Object.fromEntries(
					changed.map((key) => [key, saved[key]])
				) as Partial<PlatformPolicies>,
				result: 'ok'
			});
			return {
				success: changed.length
					? 'Saved. Changes apply from the next maintenance run or request.'
					: 'Nothing changed.'
			};
		} catch (cause) {
			if (cause instanceof ValidationError) {
				const issues = cause.issues as Array<{ path?: PropertyKey[]; message?: string }>;
				for (const issue of issues) {
					const key = String(issue.path?.[0] ?? '');
					if (key && !fieldErrors[key]) fieldErrors[key] = issue.message ?? 'Out of range.';
				}
				return fail(400, { message: Object.values(fieldErrors)[0] ?? cause.message, fieldErrors });
			}
			throw cause;
		}
	}
};
