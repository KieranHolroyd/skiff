import { error, fail } from '@sveltejs/kit';
import {
	defaultAgentScopes,
	destructivePermissions,
	isPermission,
	roles,
	statements,
	type Permission
} from '@yoal/contracts';
import { auth } from '#lib/server/auth.js';
import { authErrorMessage } from '#lib/server/user-settings.js';
import { formString } from '../../_lib/errors.js';
import { RESOURCE_LABELS } from '../_lib/resources.js';
import type { Actions, PageServerLoad } from './$types';

interface ApiKeySummary {
	id: string;
	name: string | null;
	start: string | null;
	prefix: string | null;
	createdAt: string | null;
	expiresAt: string | null;
	lastRequest: string | null;
	enabled: boolean;
	/** Granted scopes; null means the key acts with the owner's full role (CLI browser login). */
	scopes: string[] | null;
}

function iso(value: unknown): string | null {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number') return new Date(value).toISOString();
	return null;
}

/** Same reading as `principalFromRequest`: `scopes`, else `permissions`, from the key metadata. */
function grantedScopes(metadata: unknown): string[] | null {
	let parsed: unknown = metadata;
	if (typeof metadata === 'string') {
		try {
			parsed = JSON.parse(metadata);
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== 'object') return null;
	const { scopes, permissions } = parsed as { scopes?: unknown; permissions?: unknown };
	const granted = scopes ?? permissions;
	return Array.isArray(granted) ? granted.filter((value) => typeof value === 'string') : null;
}

export const load: PageServerLoad = async ({ locals, request }) => {
	const principal = locals.principal!;
	const canCreateKey = principal.permissions.has('apiKey:create');
	const canReadKeys = principal.permissions.has('apiKey:read');
	if (!canCreateKey && !canReadKeys) error(403, 'Your role cannot use API keys.');

	const held = (permission: Permission) => principal.permissions.has(permission);
	const destructive = new Set<string>(destructivePermissions);
	const scopeGroups = Object.entries(statements)
		.map(([resource, actions]) => ({
			resource,
			label: RESOURCE_LABELS[resource] ?? resource,
			permissions: actions
				.map((action) => `${resource}:${action}` as Permission)
				.filter(held)
				.map((permission) => ({ permission, destructive: destructive.has(permission) }))
		}))
		.filter((group) => group.permissions.length > 0);

	/** One-click starting points, each narrowed to what the viewer actually holds. */
	const presets = [
		{
			id: 'read',
			label: 'Read-only',
			description: 'Dashboards, monitoring and audits',
			permissions: roles.viewer.filter(held)
		},
		{
			id: 'deploy',
			label: 'Deploy',
			description: 'CI pipelines: build, deploy, promote',
			permissions: defaultAgentScopes.filter(held)
		},
		{
			id: 'all',
			label: 'Everything I can do',
			description: 'Mirrors your role, destructive actions included',
			permissions: [...principal.permissions]
		}
	];

	let apiKeys: ApiKeySummary[] = [];
	let apiKeysError: string | null = null;

	if (canReadKeys) {
		try {
			const listed = await auth.api.listApiKeys({
				query: { limit: 100, sortBy: 'createdAt', sortDirection: 'desc' },
				headers: request.headers
			});
			apiKeys = listed.apiKeys.map((key) => ({
				id: key.id,
				name: key.name ?? null,
				start: key.start ?? null,
				prefix: key.prefix ?? null,
				createdAt: iso(key.createdAt),
				expiresAt: iso(key.expiresAt),
				lastRequest: iso(key.lastRequest),
				enabled: key.enabled !== false,
				scopes: grantedScopes(key.metadata)
			}));
		} catch (cause) {
			apiKeysError = `API keys are temporarily unavailable: ${authErrorMessage(cause)}`;
		}
	}

	return {
		scopeGroups,
		presets,
		heldCount: principal.permissions.size,
		apiKeys,
		apiKeysError,
		canCreateKey,
		canReadKeys,
		canRevokeKey: principal.permissions.has('apiKey:revoke')
	};
};

export const actions: Actions = {
	createKey: async ({ request, locals }) => {
		const principal = locals.principal!;
		if (!principal.permissions.has('apiKey:create')) {
			return fail(403, { message: 'Your role cannot create API keys.' });
		}
		const data = await request.formData();
		const name = formString(data, 'name');
		const expiresRaw = formString(data, 'expiresIn');
		const selected = data
			.getAll('permissions')
			.filter((value): value is string => typeof value === 'string')
			.filter((value) => isPermission(value) && principal.permissions.has(value));

		if (!name)
			return fail(400, {
				message: 'Give the key a name so you can identify it later.',
				fieldErrors: { name: 'A name is required.' }
			});
		if (name.length > 64)
			return fail(400, {
				message: 'Keep the key name to 64 characters or fewer.',
				fieldErrors: { name: 'Too long.' }
			});
		if (selected.length === 0) {
			return fail(400, {
				message: 'Select at least one permission for the key.',
				fieldErrors: { permissions: 'Choose at least one scope.' }
			});
		}

		let expiresIn: number | null = null;
		if (expiresRaw && expiresRaw !== 'never') {
			const days = Number(expiresRaw);
			if (!Number.isInteger(days) || days < 1 || days > 365) {
				return fail(400, {
					message: 'Choose a valid expiry between 1 and 365 days.',
					fieldErrors: { expiresIn: 'Choose a valid expiry.' }
				});
			}
			expiresIn = days * 86_400;
		}

		try {
			const created = await auth.api.createApiKey({
				body: {
					name,
					expiresIn,
					// `orgId` binds the key to the org it was created in (IAM.md I5/I14): switching
					// orgs, or joining another one, never moves an existing key. IAM.md I14 still owns
					// moving these Better Auth `apikey` rows to `access_keys`.
					metadata: { scopes: selected, orgId: principal.orgId }
				},
				headers: request.headers
			});
			return {
				success: 'API key created. Copy it now — this is the only time the full key is shown.',
				createdKey: created.key,
				createdKeyName: created.name ?? name,
				createdKeyScopes: selected
			};
		} catch (cause) {
			return fail(400, { message: authErrorMessage(cause) });
		}
	},

	deleteKey: async ({ request, locals }) => {
		const principal = locals.principal!;
		if (!principal.permissions.has('apiKey:revoke')) {
			return fail(403, { message: 'Your role cannot revoke API keys.' });
		}
		const data = await request.formData();
		const keyId = formString(data, 'keyId');
		if (!keyId) return fail(400, { message: 'Missing API key id.' });

		try {
			await auth.api.deleteApiKey({ body: { keyId }, headers: request.headers });
		} catch (cause) {
			return fail(400, { message: authErrorMessage(cause) });
		}

		return { success: 'API key revoked. Requests using it stop working immediately.' };
	}
};
