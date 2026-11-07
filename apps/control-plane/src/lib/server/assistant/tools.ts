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
import { needsConfirmation, validateToolArgs } from './confirm-policy';
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
	/**
	 * The chat must stop and ask the user before this tool runs. True for every MCP tool annotated
	 * `destructiveHint` and for every tool in `CONFIRM_TOOLS` (./confirm-policy.ts).
	 */
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
	// Blueprints (plan 11): each step re-checks its own permission; this hides the tool from viewers.
	apply_stack: 'project:update',
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
	revoke_site_session: 'shareLink:revoke',
	sign_out_all_visitors: 'project:update',
	create_database: 'database:create',
	attach_database: 'database:update',
	detach_database: 'database:update',
	delete_database: 'database:delete',
	create_database_credential: 'database:credentials',
	rotate_database_credential: 'database:credentials',
	revoke_database_credential: 'database:credentials',
	create_volume: 'project:update',
	attach_volume: 'project:update',
	detach_volume: 'project:update',
	create_storage: 'storage:create',
	create_bucket: 'storage:update',
	get_bucket_config: 'storage:read',
	update_bucket_config: 'storage:update',
	attach_storage: 'storage:update',
	detach_storage: 'storage:update',
	delete_storage: 'storage:delete',
	create_storage_key: 'storage:update',
	revoke_storage_key: 'storage:update',
	create_email_domain: 'email:update',
	send_email: 'email:send',
	remove_email_suppression: 'email:update',
	add_email_address: 'email:update',
	remove_email_address: 'email:update',
	// Queue and function tools (D124); peek is a read but needs broker:update (bodies are data).
	create_queue: 'broker:update',
	send_queue_message: 'broker:update',
	peek_queue_messages: 'broker:update',
	redrive_queue: 'broker:update',
	invoke_function: 'deployment:create',
	run_function_cron: 'deployment:create',
	// Jobs (plan 09): definitions are project config, runs are deploys of a kind.
	create_job: 'project:update',
	update_job: 'project:update',
	pause_job: 'project:update',
	delete_job: 'project:update',
	run_job: 'deployment:create',
	run_command: 'deployment:create',
	cancel_job_run: 'deployment:create',
	// Dashboards (D101) are an org resource behind metrics:read; there is no separate write scope.
	create_dashboard: 'metrics:read',
	add_dashboard_panels: 'metrics:read',
	update_dashboard_panel: 'metrics:read',
	remove_dashboard_panels: 'metrics:read',
	update_dashboard: 'metrics:read',
	delete_dashboard: 'metrics:read',
	// Alert rules (docs/ALERTS.md): the service further limits writes to owners/admins, silences to deployers.
	create_alert_rule: 'metrics:read',
	update_alert_rule: 'metrics:read',
	delete_alert_rule: 'metrics:read',
	silence_alerts: 'metrics:read',
	acknowledge_alert: 'metrics:read',
	// Log drains (DESIGN §8): the service further limits writes to owners and admins.
	create_log_drain: 'logs:read',
	test_log_drain: 'logs:read',
	delete_log_drain: 'logs:read'
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
		destructive: needsConfirmation(definition.name, definition.config.annotations),
		schema: definition.config.inputSchema ?? z.object({}),
		run: async (args) => {
			// Model output is untrusted: hold it to the same schema the MCP transport enforces.
			const parsed = validateToolArgs(definition.name, definition.config.inputSchema, args);
			if (!parsed.ok) return { ok: false, text: parsed.error };
			const result = await definition.handler(parsed.args);
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
