import { error, fail } from '@sveltejs/kit';
import {
	canAdministerPlatform,
	hasPermission,
	logDrainFormats,
	logDrainLevels,
	logDrainSources,
	type LogDrainCreate,
	type LogDrainUpdate
} from '@skiff/contracts';
import { core } from '#lib/server/core.js';
import type { Actions, PageServerLoad } from './$types';

/** Settings → Log drains (DESIGN §8). Every check lives in `core.logDrains`. */
export const load: PageServerLoad = ({ locals }) => {
	const principal = locals.principal!;
	if (!hasPermission(principal, 'logs:read'))
		error(403, 'You need permission to read logs to see log drains.');
	const canEdit = core.logDrains.canEdit(principal);
	return {
		drains: core.logDrains.list(principal),
		canEdit,
		canPlatform: canAdministerPlatform(principal),
		projects: canEdit
			? core.projects.list(principal).map((project) => ({ slug: project.slug, name: project.name }))
			: []
	};
};

function string(data: FormData, name: string): string {
	return String(data.get(name) ?? '').trim();
}

function pick<T extends string>(value: string, choices: readonly T[]): T | undefined {
	return (choices as readonly string[]).includes(value) ? (value as T) : undefined;
}

function sources(data: FormData): Array<(typeof logDrainSources)[number]> {
	return data
		.getAll('sources')
		.map((value) => pick(String(value), logDrainSources))
		.filter((value) => value !== undefined);
}

/** One `Name: value` per line. A line without a colon is reported, not dropped. */
function headers(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of text
		.split('\n')
		.map((entry) => entry.trim())
		.filter(Boolean)) {
		const at = line.indexOf(':');
		if (at <= 0 || !line.slice(at + 1).trim())
			throw new Error(`Header "${line}" needs a name and a value, e.g. Authorization: Bearer …`);
		out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return out;
}

const secretNote =
	'Copy the signing secret now: it is not shown again. Verify X-Skiff-Signature with it.';

export const actions: Actions = {
	create: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const kind = string(data, 'kind') === 'otlp' ? 'otlp' : 'webhook';
			const headerMap = headers(string(data, 'headers'));
			const input: LogDrainCreate = {
				name: string(data, 'name'),
				kind,
				url: string(data, 'url'),
				sources: sources(data),
				allowPrivateNetwork: data.get('allowPrivateNetwork') === 'on',
				...(kind === 'webhook'
					? { format: pick(string(data, 'format'), logDrainFormats) ?? 'ndjson' }
					: {}),
				...(string(data, 'project') ? { project: string(data, 'project') } : {}),
				...(pick(string(data, 'minLevel'), logDrainLevels)
					? { minLevel: pick(string(data, 'minLevel'), logDrainLevels) }
					: {}),
				...(Object.keys(headerMap).length ? { headers: headerMap } : {})
			};
			const result = core.logDrains.create(principal, input);
			return {
				success: `Created ${result.drain.name}. Lines logged from now on are forwarded; send a test line to check the receiver.`,
				secret: result.signingSecret
					? { name: result.drain.name, value: result.signingSecret, note: secretNote }
					: null
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	update: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const input: LogDrainUpdate = {
				url: string(data, 'url'),
				sources: sources(data),
				minLevel: pick(string(data, 'minLevel'), logDrainLevels) ?? null
			};
			const format = pick(string(data, 'format'), logDrainFormats);
			if (format) input.format = format;
			// Header values are write-only: blank keeps them, a tick on "remove" clears them.
			if (data.get('clearHeaders') === 'on') input.headers = null;
			else if (string(data, 'headers')) input.headers = headers(string(data, 'headers'));
			const drain = core.logDrains.get(principal, string(data, 'id'));
			// Leave the URL out when it is unchanged (the view masks query values).
			if (input.url === drain.url) delete input.url;
			const result = core.logDrains.update(principal, drain.id, input);
			return { success: `Saved ${result.drain.name}.` };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	toggle: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const enabled = string(data, 'enabled') === 'true';
			const result = core.logDrains.update(principal, string(data, 'id'), { enabled });
			return {
				success: enabled
					? `${result.drain.name} is on again, from now: lines logged while it was off are not sent.`
					: `${result.drain.name} is paused.`
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	rotate: async ({ request, locals }) => {
		const principal = locals.principal!;
		const data = await request.formData();
		try {
			const result = core.logDrains.update(principal, string(data, 'id'), {
				rotateSigningSecret: true
			});
			return {
				success: `New signing secret for ${result.drain.name}. The old one stops working now.`,
				secret: { name: result.drain.name, value: result.signingSecret!, note: secretNote }
			};
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	test: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = string(await request.formData(), 'id');
		try {
			const result = await core.logDrains.test(principal, id);
			return result.ok ? { success: result.message } : fail(400, { message: result.message });
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	},

	remove: async ({ request, locals }) => {
		const principal = locals.principal!;
		const id = string(await request.formData(), 'id');
		try {
			core.logDrains.delete(principal, id);
			return { success: 'Log drain deleted. Forwarding has stopped.' };
		} catch (cause) {
			return fail(400, { message: (cause as Error).message });
		}
	}
};
