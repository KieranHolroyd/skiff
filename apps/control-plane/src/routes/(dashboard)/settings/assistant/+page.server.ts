import { fail } from '@sveltejs/kit';
import { PLATFORM_CONFIG_SECTIONS, type PlatformConfigKey } from '@skiff/contracts';
import {
	agentDetail,
	resetAgentDetail,
	saveAgentDetail,
	validateAgentDetail
} from '#lib/server/assistant/settings.js';
import { assistantTools } from '#lib/server/assistant/tools.js';
import { testProvider } from '#lib/server/assistant/config.js';
import { currentSection } from '#lib/server/platform-config.js';
import { formBoolean, formRawString, formString } from '../../_lib/errors.js';
import { policyState, savePolicies } from '../_lib/policies.server.js';
import {
	collect,
	configState,
	fieldFailure,
	queueConfig,
	requireOwnerPage
} from '../_platform.server.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Settings → Assistant is owner-only, like the other platform settings. The API key is write-only:
 * it is never sent back to the browser, and a blank field keeps the saved one. Saving validates by
 * listing the provider's models first, so a typo fails here instead of at the first chat turn.
 */

export const load: PageServerLoad = ({ locals }) => {
	const principal = requireOwnerPage(locals);
	return {
		...configState(),
		...policyState(),
		assistant: currentSection('assistant'),
		agent: agentDetail(),
		catalog: assistantTools(principal)
			.map(({ name, title, description, destructive }) => ({
				name,
				title,
				description,
				destructive
			}))
			.sort((a, b) => a.title.localeCompare(b.title))
	};
};

function fields(data: FormData) {
	return collect([
		{
			field: 'provider',
			key: 'SKIFF_ASSISTANT_PROVIDER',
			value: formString(data, 'provider') || 'openai-compatible',
			required: true,
			label: 'Provider'
		},
		{
			field: 'baseUrl',
			key: 'SKIFF_ASSISTANT_BASE_URL',
			value: formString(data, 'baseUrl'),
			required: true,
			label: 'Base URL'
		},
		{
			field: 'model',
			key: 'SKIFF_ASSISTANT_MODEL',
			value: formString(data, 'model'),
			required: true,
			label: 'Model'
		},
		{
			field: 'apiKey',
			key: 'SKIFF_ASSISTANT_API_KEY',
			value: formRawString(data, 'apiKey'),
			secret: true,
			label: 'API key'
		}
	]);
}

export const actions: Actions = {
	savePolicies,

	saveAgent: async ({ request, locals }) => {
		const principal = requireOwnerPage(locals);
		const data = await request.formData();
		const tools = formBoolean(data, 'allTools')
			? null
			: data.getAll('tools').filter((value): value is string => typeof value === 'string');
		const allowedTools = new Set(assistantTools(principal).map((tool) => tool.name));
		const result = validateAgentDetail(
			{
				system: formString(data, 'instructions'),
				model: formString(data, 'model'),
				tools
			},
			allowedTools
		);
		if (!result.ok) return fail(400, { message: result.error });
		saveAgentDetail(principal, result.value);
		return { success: 'Assistant saved. The next turn uses the new details.' };
	},

	resetAgent: async ({ locals }) => {
		const principal = requireOwnerPage(locals);
		resetAgentDetail(principal);
		return { success: 'Assistant reset to its built-in details.' };
	},

	save: async ({ request, locals }) => {
		requireOwnerPage(locals);
		const data = await request.formData();
		const { set, unset, fieldErrors } = fields(data);
		if (Object.keys(fieldErrors).length) return fieldFailure(fieldErrors);

		const baseUrl = set.SKIFF_ASSISTANT_BASE_URL;
		const apiKey = set.SKIFF_ASSISTANT_API_KEY || process.env.SKIFF_ASSISTANT_API_KEY;
		const result = await testProvider(
			{ baseUrl: baseUrl!, apiKey, model: set.SKIFF_ASSISTANT_MODEL },
			AbortSignal.timeout(15_000)
		);
		if (!result.ok)
			return fail(400, {
				message: `Not saved — the provider check failed. ${result.message}`,
				fieldErrors: { baseUrl: 'The provider did not answer with a model list.' }
			});

		const model = set.SKIFF_ASSISTANT_MODEL!;
		const known = result.models.length > 0 && result.models.includes(model);
		return queueConfig(
			locals,
			{ action: 'configure', section: 'assistant', set, unset },
			[
				known || result.models.length === 0
					? `Provider answered (${result.models.length} models). Saving ${model}.`
					: `Provider answered, but “${model}” is not in its model list. Saving anyway — check the name if a turn fails.`,
				'The dashboard restarts for a few seconds.'
			].join(' ')
		);
	},

	remove: async ({ locals }) =>
		queueConfig(
			locals,
			{
				action: 'configure',
				section: 'assistant',
				set: {},
				unset: [...PLATFORM_CONFIG_SECTIONS.assistant] as PlatformConfigKey[]
			},
			'Removing the assistant configuration. The launcher disappears when the dashboard restarts.'
		),

	test: async ({ locals }) => {
		requireOwnerPage(locals);
		const baseUrl = process.env.SKIFF_ASSISTANT_BASE_URL;
		if (!baseUrl) return fail(409, { message: 'The assistant is not configured yet.' });
		const result = await testProvider(
			{
				baseUrl,
				apiKey: process.env.SKIFF_ASSISTANT_API_KEY,
				model: process.env.SKIFF_ASSISTANT_MODEL
			},
			AbortSignal.timeout(15_000)
		);
		if (!result.ok) return fail(502, { message: `The provider check failed. ${result.message}` });
		return {
			success: `Provider answered with ${result.models.length} model${result.models.length === 1 ? '' : 's'}${
				result.models.length > 0 ? `: ${result.models.slice(0, 8).join(', ')}` : ''
			}.`
		};
	}
};
