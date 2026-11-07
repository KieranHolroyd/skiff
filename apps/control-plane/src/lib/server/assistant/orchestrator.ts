import { randomUUID } from 'node:crypto';
import {
	type AssistantChatRequest,
	type AssistantEvent,
	type AssistantGuide,
	type Principal
} from '@skiff/contracts';
import { core } from '../core';
import { PANEL_FORMAT } from './agents';
import { assistantConfig, type AssistantRuntimeConfig } from './config';
import { mintConfirmation, verifyConfirmation } from './confirm';
import { streamChat, type ProviderMessage } from './provider';
import { effectiveAgent, type EffectiveAgent } from './settings';
import { createToolbox } from './tool-search';
import { assistantTools, parseArgs, providerTools, resultSummary, toolFor } from './tools';

/**
 * One agent per turn (docs/ASSISTANT.md): the assistant runs a single tool loop against every MCP
 * tool the user may call (or the owner's allowlist), streaming text and tool steps as it goes.
 * Large catalogs are deferred: a core set plus `search_tools` is offered, and the model loads the
 * rest by name or keyword (./tool-search.ts).
 *
 * Destructive tool calls are never executed inline: they are signed and handed to the chat UI,
 * which re-submits the approval through `/api/v1/assistant/confirm`.
 */

const MAX_TARGETS = 50;
const MAX_ARGS_PREVIEW = 600;
const MAX_DETAIL = 4_000;

export interface RunOptions {
	principal: Principal;
	request: AssistantChatRequest;
	signal: AbortSignal;
	emit: (event: AssistantEvent) => void;
}

function pageSummary(request: AssistantChatRequest): string {
	const context = request.context;
	if (!context.path)
		return 'The user turned page context off: you cannot see their current page. Answer from tools; a guide_user tour may still navigate by dashboard path.';
	const targets = context.targets.slice(0, MAX_TARGETS);
	const lines = [
		`Current page: ${context.path}${context.title ? ` — ${context.title}` : ''}`,
		...(context.project ? [`Project: ${context.project}`] : []),
		'Visible interactive elements (target ids for guide_user):'
	];
	if (targets.length === 0) lines.push('- (no labelled elements were collected)');
	for (const target of targets) {
		const ref = [
			target.id ? `id=${target.id}` : '',
			target.selector ? `selector=${target.selector}` : ''
		]
			.filter(Boolean)
			.join(' ');
		lines.push(`- ${target.label} [${target.kind}]${ref ? ` (${ref})` : ''}`);
	}
	return lines.join('\n');
}

function historyMessages(request: AssistantChatRequest): ProviderMessage[] {
	return request.history.map((message) => ({ role: message.role, content: message.content }));
}

/** Arguments for the step list: file bodies summarised, long strings clipped, never megabytes. */
function argsPreview(args: Record<string, unknown>): string | undefined {
	const keys = Object.keys(args);
	if (keys.length === 0) return undefined;
	const compact = JSON.stringify(args, (key, value: unknown) => {
		if (key === 'files' && Array.isArray(value)) return `[${value.length} file(s)]`;
		if (typeof value === 'string' && value.length > 160) return `${value.slice(0, 160)}…`;
		return value;
	});
	if (!compact) return undefined;
	return compact.length > MAX_ARGS_PREVIEW ? `${compact.slice(0, MAX_ARGS_PREVIEW)}…` : compact;
}

function resultDetail(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL)}\n…` : trimmed;
}

function confirmationSummary(args: Record<string, unknown>): string {
	const body = JSON.stringify(args, null, 2) ?? '{}';
	return body.length > 700 ? `${body.slice(0, 700)}…` : body;
}

async function runAgent(
	config: AssistantRuntimeConfig,
	definition: EffectiveAgent,
	principal: Principal,
	request: AssistantChatRequest,
	signal: AbortSignal,
	emit: (event: AssistantEvent) => void,
	runId: string
): Promise<void> {
	const allTools = assistantTools(principal);
	const allowed = definition.tools ? new Set(definition.tools) : null;
	const tools = allowed ? allTools.filter((tool) => allowed.has(tool.name)) : allTools;
	const toolbox = createToolbox(tools);
	const toolLoading = toolbox.prompt();

	const messages: ProviderMessage[] = [
		{
			role: 'system',
			content: [definition.system, toolLoading, PANEL_FORMAT].filter(Boolean).join('\n\n')
		},
		...historyMessages(request),
		{ role: 'user', content: `${pageSummary(request)}\n\nUser request:\n${request.message}` }
	];
	let providerToolList = providerTools(toolbox.offered());
	let providerToolVersion = toolbox.version;
	const guides: AssistantGuide[] = [];
	let text = '';
	let toolCalls = 0;
	let stoppedForConfirmation = false;
	// Per-turn budgets are platform policies (Settings → Policies), read once per turn.
	const { assistantMaxRounds, assistantMaxToolCalls } = core.policies.get();

	for (let round = 0; round < assistantMaxRounds; round += 1) {
		if (providerToolVersion !== toolbox.version) {
			providerToolList = providerTools(toolbox.offered());
			providerToolVersion = toolbox.version;
		}
		const result = await streamChat(config, {
			model: definition.model ?? config.model,
			messages,
			tools: providerToolList,
			signal,
			onText: (delta) => {
				text += delta;
				emit({ type: 'text.delta', runId, text: delta });
			}
		});
		if (result.toolCalls.length === 0) break;

		messages.push({
			role: 'assistant',
			content: result.text || null,
			tool_calls: result.toolCalls.map((call) => ({
				id: call.id,
				type: 'function',
				function: { name: call.name, arguments: call.arguments }
			}))
		});

		for (const call of result.toolCalls) {
			if (toolCalls >= assistantMaxToolCalls) {
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: 'Tool budget exhausted for this turn. Answer with what you have.'
				});
				continue;
			}
			toolCalls += 1;
			const tool = toolbox.find(call.name);
			const parsed = parseArgs(call.arguments);
			emit({
				type: 'tool.started',
				runId,
				callId: call.id,
				tool: call.name,
				title: tool?.title ?? call.name,
				args: parsed.ok ? argsPreview(parsed.args) : undefined
			});

			if (!tool) {
				const message = `There is no tool named "${call.name}". Use one of the tools you were given.`;
				messages.push({ role: 'tool', tool_call_id: call.id, content: message });
				emit({
					type: 'tool.finished',
					runId,
					callId: call.id,
					tool: call.name,
					ok: false,
					summary: message
				});
				continue;
			}

			if (!toolbox.isLoaded(tool.name)) {
				// Called by name without loading: the model has not seen the schema, so its arguments
				// are a guess. Load it and let it retry rather than run (or confirm) a guessed call.
				toolbox.load([tool.name]);
				const message = `${tool.name} was not loaded, so its arguments were not checked. It is loaded now; call it again using its schema.`;
				messages.push({ role: 'tool', tool_call_id: call.id, content: message });
				emit({
					type: 'tool.finished',
					runId,
					callId: call.id,
					tool: call.name,
					ok: false,
					summary: message
				});
				continue;
			}

			if (!parsed.ok) {
				messages.push({ role: 'tool', tool_call_id: call.id, content: parsed.error });
				emit({
					type: 'tool.finished',
					runId,
					callId: call.id,
					tool: call.name,
					ok: false,
					summary: parsed.error
				});
				continue;
			}

			if (tool.destructive) {
				const token = mintConfirmation(principal, tool.name, parsed.args);
				emit({
					type: 'confirmation.required',
					runId,
					token,
					tool: tool.name,
					title: tool.title,
					summary: confirmationSummary(parsed.args),
					args: parsed.args
				});
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content:
						'The dashboard is asking the user to confirm this action. Do not call it again; tell the user to confirm or cancel in the chat.'
				});
				stoppedForConfirmation = true;
				break;
			}

			let outcome: { ok: boolean; text: string };
			const startedAt = Date.now();
			try {
				const result = await tool.run(parsed.args);
				outcome = { ok: result.ok, text: result.text };
				if (result.guide) {
					guides.push(result.guide);
					emit({ type: 'ui.guide', runId, guide: result.guide });
				}
			} catch (error) {
				outcome = {
					ok: false,
					text: error instanceof Error ? error.message : String(error)
				};
			}
			messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.text });
			emit({
				type: 'tool.finished',
				runId,
				callId: call.id,
				tool: call.name,
				ok: outcome.ok,
				summary: resultSummary(outcome.text, outcome.ok),
				detail: resultDetail(outcome.text),
				durationMs: Date.now() - startedAt
			});
		}
		if (stoppedForConfirmation) break;
	}

	if (text.trim() === '') {
		// A tool-only turn still needs a sentence the user can read.
		text = stoppedForConfirmation
			? 'I have prepared that action. Confirm or cancel it below.'
			: guides.length > 0
				? 'I have highlighted it on the page.'
				: 'Done.';
		emit({ type: 'text.delta', runId, text });
	}
}

export async function runAssistant(options: RunOptions): Promise<void> {
	const config = assistantConfig();
	if (!config) throw new Error('The assistant is not configured.');
	const { principal, request, signal, emit } = options;
	const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
	const startedAt = Date.now();

	try {
		emit({ type: 'run.started', runId });

		try {
			core.audit.record({
				principal,
				action: 'assistant.chat',
				resource: 'assistant',
				args: { chars: request.message.length, page: request.context.path },
				result: 'ok'
			});
		} catch (error) {
			console.error('[assistant] audit failed:', error);
		}

		await runAgent(config, effectiveAgent(), principal, request, signal, emit, runId);
		if (signal.aborted) return;
		emit({ type: 'run.finished', runId, durationMs: Date.now() - startedAt });
	} catch (error) {
		if (signal.aborted) return;
		emit({
			type: 'error',
			runId,
			message: error instanceof Error ? error.message : String(error)
		});
		emit({ type: 'run.finished', runId, durationMs: Date.now() - startedAt });
	}
}

/** Execute a destructive action the user approved in the chat. */
export async function runConfirmed(
	principal: Principal,
	token: string
): Promise<{ ok: boolean; tool: string; title: string; text: string }> {
	const verified = verifyConfirmation(token, principal);
	if (!verified.ok) throw new Error(`Cannot confirm: ${verified.reason}.`);
	const tools = assistantTools(principal);
	const tool = toolFor(tools, verified.tool);
	if (!tool) throw new Error(`Unknown tool "${verified.tool}".`);
	if (!tool.destructive) throw new Error('That tool does not need confirmation.');
	const result = await tool.run(verified.args);
	return {
		ok: result.ok,
		tool: tool.name,
		title: tool.title,
		text: result.text
	};
}
