import { fail } from '@sveltejs/kit';
import { isPermission, statements, type Permission } from '@skiff/contracts';
import { auth } from '#lib/server/auth.js';
import { core } from '#lib/server/core.js';
import { authErrorMessage } from '#lib/server/user-settings.js';
import { formString } from '../_lib/errors.js';
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
}

function iso(value: unknown): string | null {
	if (value instanceof Date) return value.toISOString();
	if (typeof value === 'string' && value.length > 0) return value;
	if (typeof value === 'number') return new Date(value).toISOString();
	return null;
}

export const load: PageServerLoad = async ({ locals, request }) => {
	const principal = locals.principal!;
	const canSeeEmails = principal.role === 'owner' || principal.role === 'admin';

	let org: { id: string; name: string; slug: string; createdAt: string } | null = null;
	let members: Array<{
		userId: string;
		role: string;
		name: string;
		email: string | null;
		joinedAt: string | null;
	}> = [];
	try {
		org = core.ctx.sqlite
			.query<{ id: string; name: string; slug: string; createdAt: string }, [string]>(
				'SELECT id, name, slug, createdAt FROM organization WHERE id = ?'
			)
			.get(principal.orgId);
		members = core.ctx.sqlite
			.query<
				{ userId: string; role: string; name: string; email: string; joinedAt: string },
				[string]
			>(
				`SELECT m.userId AS userId, m.role AS role, u.name AS name, u.email AS email, m.createdAt AS joinedAt
				 FROM member m LEFT JOIN user u ON u.id = m.userId
				 WHERE m.organizationId = ?
				 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'deployer' THEN 2 ELSE 3 END, u.name ASC`
			)
			.all(principal.orgId)
			.map((row) => ({
				userId: row.userId,
				role: row.role,
				name: row.name || row.userId,
				email: canSeeEmails ? row.email || null : null,
				joinedAt: iso(row.joinedAt)
			}));
	} catch {
		// Auth tables may not exist during first boot; the page still renders.
	}

	const scopeGroups = Object.entries(statements)
		.map(([resource, actions]) => ({
			resource,
			permissions: actions
				.map((action) => `${resource}:${action}`)
				.filter((permission) => principal.permissions.has(permission as Permission))
		}))
		.filter((group) => group.permissions.length > 0);

	let apiKeys: ApiKeySummary[] = [];
	let apiKeysError: string | null = null;
	const canCreateKey = principal.permissions.has('apiKey:create');
	const canReadKeys = principal.permissions.has('apiKey:read');

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
				enabled: key.enabled !== false
			}));
		} catch (error) {
			apiKeysError = `API keys are temporarily unavailable: ${authErrorMessage(error)}`;
		}
	}

	return {
		org: org
			? { ...org, createdAt: iso(org.createdAt) }
			: { id: principal.orgId, name: 'Personal', slug: null, createdAt: null },
		members,
		canSeeEmails,
		scopeGroups,
		apiKeys,
		apiKeysError,
		canCreateKey,
		canReadKeys,
		canRevokeKey: principal.permissions.has('apiKey:revoke'),
		role: principal.role
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
					metadata: { scopes: selected }
				},
				headers: request.headers
			});
			return {
				success: 'API key created. Copy it now — this is the only time the full key is shown.',
				createdKey: created.key,
				createdKeyName: created.name ?? name,
				createdKeyScopes: selected
			};
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
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
		} catch (error) {
			return fail(400, { message: authErrorMessage(error) });
		}

		return { success: 'API key revoked. Requests using it stop working immediately.' };
	}
};
