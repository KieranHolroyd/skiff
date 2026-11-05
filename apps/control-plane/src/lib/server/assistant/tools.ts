import * as z from 'zod';
import {
	assistantGuideSchema,
	hasPermission,
	type AssistantGuide,
	type Permission,
	type Principal
} from '@skiff/contracts';
import { skiffToolDefinitions, type SkiffToolDefinition } from '../mcp';
import { GUIDE_TOOL } from './constants';
import type { ProviderTool } from './provider';

/**
 * The bridge between Skiff's MCP tool catalog and the assistant's model. Tool names, schemas and
 * behaviour are the MCP ones; only the transport differs. `guide_user` is the one assistant-only
 * tool: it drives the dashboard tour instead of touching the platform.
 */

export interface AssistantTool {
	name: string;
	title: string;
	description: string;
	destructive: boolean;
	schema: z.ZodType;
	run: (
		args: Record<string, unknown>
	) => Promise<{ ok: boolean; text: string; guide?: AssistantGuide }>;
}

function textResult(value: unknown): string {
	const result = value as {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	const text = (result?.content ?? [])
		.filter((part) => part?.type === 'text' && typeof part.text === 'string')
		.map((part) => part.text)
		.join('\n');
	if (text) return text;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function summary(text: string, isError: boolean): string {
	const first = text
		.replace(/\s+/g, ' ')
		.replace(/^#+\s*/, '')
		.trim()
		.slice(0, 220);
	if (first) return first;
	return isError ? 'The tool returned an error.' : 'Done.';
}

/**
 * Write tools the caller cannot use are not offered at all. Reads stay visible; the service layer
 * still enforces them. This keeps a viewer from seeing a delete confirmation that can only fail.
 */
const WRITE_PERMISSION: Record<string, Permission> = {
	create_project: 'project:create',
	update_project: 'project:update',
	delete_project: 'project:delete',
	delete_projects: 'project:delete',
	restore_projects: 'project:update',
	deploy_site: 'deployment:create',
	deploy_files: 'deployment:create',
	create_upload: 'deployment:create',
	finalize_upload: 'deployment:create',
	deploy_to_environment: 'deployment:create',
	promote_deployment: 'deployment:promote',
	rollback: 'deployment:rollback',
	create_environment: 'project:update',
	set_workload: 'project:update',
	set_access: 'project:update',
	create_share_link: 'shareLink:create',
	revoke_share_link: 'shareLink:revoke',
	create_database: 'database:create',
	attach_database: 'database:update',
	detach_database: 'database:update',
	delete_database: 'database:delete',
	create_storage: 'storage:create',
	create_bucket: 'storage:update',
	attach_storage: 'storage:update',
	detach_storage: 'storage:update',
	delete_storage: 'storage:delete'
};

/** Every permitted MCP tool, plus the UI guide, for one signed-in user. */
export function assistantTools(principal: Principal): AssistantTool[] {
	const definitions = skiffToolDefinitions(principal).filter((definition) => {
		const permission = WRITE_PERMISSION[definition.name];
		return !permission || hasPermission(principal, permission);
	});
	const tools: AssistantTool[] = definitions.map((definition: SkiffToolDefinition) => ({
		name: definition.name,
		title: definition.config.title ?? definition.name.replaceAll('_', ' '),
		description: definition.config.description ?? '',
		destructive: definition.config.annotations?.destructiveHint === true,
		schema: definition.config.inputSchema ?? z.object({}),
		run: async (args) => {
			const result = await definition.handler(args);
			const text = textResult(result);
			const isError = (result as { isError?: boolean })?.isError === true;
			return { ok: !isError, text: text.slice(0, 40_000) };
		}
	}));

	tools.push({
		name: GUIDE_TOOL,
		title: 'Guide the user around the dashboard',
		description:
			'Show a short guided tour: navigate to a path and spotlight an element on the page. Use the target ids and selectors from the page outline in the prompt. Prefer this when the user asks where something is or how to do something in the dashboard.',
		destructive: false,
		schema: assistantGuideSchema,
		run: async (args) => {
			const guide = assistantGuideSchema.parse(args);
			return {
				ok: true,
				text: `The dashboard is showing ${guide.steps.length} guided step${guide.steps.length === 1 ? '' : 's'}. Tell the user what to do in one or two sentences; do not repeat the whole tour in text.`,
				guide
			};
		}
	});

	return tools;
}

export function toolFor(tools: AssistantTool[], name: string): AssistantTool | undefined {
	return tools.find((tool) => tool.name === name);
}

/** Convert a zod schema to the JSON Schema an OpenAI-compatible provider expects. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
	try {
		const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
		delete json.$schema;
		return json;
	} catch {
		return { type: 'object', additionalProperties: true };
	}
}

export function providerTools(tools: AssistantTool[]): ProviderTool[] {
	return tools.map((tool) => ({
		type: 'function',
		function: {
			name: tool.name,
			description: tool.description,
			parameters: jsonSchema(tool.schema)
		}
	}));
}

/** Parse a model's JSON arguments; an invalid blob is reported to the model, not thrown. */
export function parseArgs(
	raw: string
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
	try {
		const value = JSON.parse(raw || '{}') as unknown;
		if (!value || typeof value !== 'object' || Array.isArray(value))
			return { ok: false, error: 'Tool arguments must be a JSON object.' };
		return { ok: true, args: value as Record<string, unknown> };
	} catch (error) {
		return { ok: false, error: `Tool arguments were not valid JSON: ${(error as Error).message}` };
	}
}

export function resultSummary(text: string, ok: boolean): string {
	return summary(text, !ok);
}

export type { AssistantGuide };
