import { randomUUID } from 'node:crypto';
import {
	type AssistantAgentId,
	type AssistantChatRequest,
	type AssistantEvent,
	type AssistantGuide,
	type AssistantSpeaker,
	type Principal
} from '@skiff/contracts';
import { core } from '../core';
import { LEAD_SYSTEM, ROUTER_SYSTEM, SYNTHESIS_SYSTEM } from './agents';
import { assistantConfig, type AssistantRuntimeConfig } from './config';
import { mintConfirmation, verifyConfirmation } from './confirm';
import { streamChat, type ProviderMessage } from './provider';
import { effectiveAgents, type EffectiveAgent } from './settings';
import {
	assistantTools,
	parseArgs,
	providerTools,
	resultSummary,
	toolFor,
	type AssistantTool
} from './tools';

/**
 * Multi-agent execution (docs/ASSISTANT.md):
 *
 *   1. The lead routes to 1–3 specialists from a compact description of the turn.
 *   2. Each specialist runs its own tool loop against the MCP catalog.
 *   3. If more than one answered, the lead synthesises one reply.
 *
 * Destructive tool calls are never executed inline: they are signed and handed to the chat UI,
 * which re-submits the approval through `/api/v1/assistant/confirm`.
 */

const MAX_ROUNDS = 8;
const MAX_TOOL_CALLS = 16;
const MAX_TARGETS = 50;

export interface RunOptions {
	principal: Principal;
	request: AssistantChatRequest;
	signal: AbortSignal;
	emit: (event: AssistantEvent) => void;
}

interface AgentAnswer {
	agent: AssistantAgentId;
	label: string;
	text: string;
	guides: AssistantGuide[];
	needsConfirmation: boolean;
}

function pageSummary(request: AssistantChatRequest): string {
	const context = request.context;
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

/** Deterministic fallback when the router model is unavailable or returns junk. */
function fallbackAgents(message: string): AssistantAgentId[] {
	const text = message.toLowerCase();
	const picked = new Set<AssistantAgentId>();
	const match = (agent: AssistantAgentId, words: string[]) => {
		if (words.some((word) => text.includes(word))) picked.add(agent);
	};
	match('data', ['database', 'postgres', 'sql', 'bucket', 'storage', 's3', 'rustfs', 'attach']);
	match('platform', [
		'node',
		'fleet',
		'capacity',
		'audit',
		'metric',
		'traffic',
		'log',
		'down',
		'offline',
		'slow',
		'error rate'
	]);
	match('projects', [
		'deploy',
		'release',
		'rollback',
		'promote',
		'environment',
		'share link',
		'access',
		'project',
		'workload',
		'build'
	]);
	match('guide', ['where', 'how do i', 'click', 'page', 'find', 'navigate', 'what is', 'help']);
	if (picked.size === 0) picked.add('guide');
	return [...picked].slice(0, 2);
}

async function routeAgents(
	config: AssistantRuntimeConfig,
	request: AssistantChatRequest,
	signal: AbortSignal,
	agents: Record<AssistantAgentId, EffectiveAgent>
): Promise<{ agents: AssistantAgentId[]; note?: string }> {
	const roster = Object.values(agents)
		.filter((agent) => agent.enabled)
		.map((agent) => `- ${agent.id}: ${agent.brief}`)
		.join('\n');
	const prompt = [
		pageSummary(request),
		'',
		'Conversation so far:',
		...request.history
			.slice(-8)
			.map((message) => `${message.role}: ${message.content.slice(0, 800)}`),
		`user: ${request.message}`
	].join('\n');

	try {
		const result = await streamChat(config, {
			model: config.routerModel,
			temperature: 0,
			maxTokens: 200,
			signal,
			messages: [
				{ role: 'system', content: `${ROUTER_SYSTEM}\n\nAgents:\n${roster}` },
				{ role: 'user', content: prompt }
			]
		});
		const raw = result.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
		const start = raw.indexOf('{');
		const end = raw.lastIndexOf('}');
		if (start < 0 || end <= start) throw new Error('router returned no JSON');
		const parsed = JSON.parse(raw.slice(start, end + 1)) as { agents?: unknown; reason?: unknown };
		const ids = Array.isArray(parsed.agents)
			? parsed.agents
					.filter(
						(id): id is AssistantAgentId =>
							typeof id === 'string' && id in agents && agents[id as AssistantAgentId].enabled
					)
					.slice(0, config.maxAgents)
			: [];
		if (ids.length === 0) throw new Error('router chose no agent');
		return {
			agents: [...new Set(ids)],
			note: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : undefined
		};
	} catch (error) {
		if (signal.aborted) throw error;
		const enabled = new Set(
			Object.values(agents)
				.filter((agent) => agent.enabled)
				.map((agent) => agent.id)
		);
		const picked = fallbackAgents(request.message)
			.filter((id) => enabled.has(id))
			.slice(0, config.maxAgents);
		return {
			agents: picked,
			note: 'Routed from keywords because the router model was unavailable.'
		};
	}
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
	allTools: AssistantTool[],
	signal: AbortSignal,
	emit: (event: AssistantEvent) => void,
	runId: string
): Promise<AgentAnswer> {
	const allowed = new Set(definition.tools);
	const tools = allTools.filter((tool) => allowed.has(tool.name));
	const speaker: AssistantSpeaker = definition.id;
	const label = definition.label;
	emit({ type: 'agent.started', runId, agent: speaker, label });

	const messages: ProviderMessage[] = [
		{ role: 'system', content: definition.system },
		...historyMessages(request),
		{ role: 'user', content: `${pageSummary(request)}\n\nUser request:\n${request.message}` }
	];
	const providerToolList = providerTools(tools);
	const guides: AssistantGuide[] = [];
	let text = '';
	let toolCalls = 0;
	let stoppedForConfirmation = false;

	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const result = await streamChat(config, {
			model: definition.model ?? config.model,
			messages,
			tools: providerToolList,
			signal,
			onText: (delta) => {
				text += delta;
				emit({ type: 'text.delta', runId, agent: speaker, text: delta });
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
			if (toolCalls >= MAX_TOOL_CALLS) {
				messages.push({
					role: 'tool',
					tool_call_id: call.id,
					content: 'Tool budget exhausted for this turn. Answer with what you have.'
				});
				continue;
			}
			toolCalls += 1;
			const tool = toolFor(tools, call.name);
			emit({
				type: 'tool.started',
				runId,
				agent: speaker,
				callId: call.id,
				tool: call.name,
				title: tool?.title ?? call.name
			});

			if (!tool) {
				const message = `There is no tool named "${call.name}". Use one of the tools you were given.`;
				messages.push({ role: 'tool', tool_call_id: call.id, content: message });
				emit({
					type: 'tool.finished',
					runId,
					agent: speaker,
					callId: call.id,
					tool: call.name,
					ok: false,
					summary: message
				});
				continue;
			}

			const parsed = parseArgs(call.arguments);
			if (!parsed.ok) {
				messages.push({ role: 'tool', tool_call_id: call.id, content: parsed.error });
				emit({
					type: 'tool.finished',
					runId,
					agent: speaker,
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
					agent: speaker,
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
			try {
				const result = await tool.run(parsed.args);
				outcome = { ok: result.ok, text: result.text };
				if (result.guide) {
					guides.push(result.guide);
					emit({ type: 'ui.guide', runId, agent: speaker, guide: result.guide });
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
				agent: speaker,
				callId: call.id,
				tool: call.name,
				ok: outcome.ok,
				summary: resultSummary(outcome.text, outcome.ok)
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
		emit({ type: 'text.delta', runId, agent: speaker, text });
	}

	emit({ type: 'agent.finished', runId, agent: speaker, label });
	return {
		agent: definition.id,
		label,
		text,
		guides,
		needsConfirmation: stoppedForConfirmation
	};
}

async function runLead(
	config: AssistantRuntimeConfig,
	request: AssistantChatRequest,
	signal: AbortSignal,
	emit: (event: AssistantEvent) => void,
	runId: string
): Promise<string> {
	const speaker: AssistantSpeaker = 'lead';
	emit({ type: 'agent.started', runId, agent: speaker, label: 'Skiff' });
	let text = '';
	await streamChat(config, {
		messages: [
			{ role: 'system', content: LEAD_SYSTEM },
			...historyMessages(request),
			{ role: 'user', content: `${pageSummary(request)}\n\nUser request:\n${request.message}` }
		],
		signal,
		onText: (delta) => {
			text += delta;
			emit({ type: 'text.delta', runId, agent: speaker, text: delta });
		}
	});
	emit({ type: 'agent.finished', runId, agent: speaker, label: 'Skiff' });
	return text;
}

async function synthesise(
	config: AssistantRuntimeConfig,
	request: AssistantChatRequest,
	answers: AgentAnswer[],
	signal: AbortSignal,
	emit: (event: AssistantEvent) => void,
	runId: string
): Promise<string> {
	const speaker: AssistantSpeaker = 'lead';
	emit({ type: 'agent.started', runId, agent: speaker, label: 'Skiff' });
	const findings = answers
		.map((answer) => `## ${answer.label}\n${answer.text.trim() || '(no text; it used tools)'}`)
		.join('\n\n');
	let text = '';
	await streamChat(config, {
		messages: [
			{ role: 'system', content: SYNTHESIS_SYSTEM },
			{
				role: 'user',
				content: `${pageSummary(request)}\n\nUser request:\n${request.message}\n\nSpecialist findings:\n${findings}`
			}
		],
		signal,
		onText: (delta) => {
			text += delta;
			emit({ type: 'text.delta', runId, agent: speaker, text: delta });
		}
	});
	emit({ type: 'agent.finished', runId, agent: speaker, label: 'Skiff' });
	return text;
}

export async function runAssistant(options: RunOptions): Promise<void> {
	const config = assistantConfig();
	if (!config) throw new Error('The assistant is not configured.');
	const { principal, request, signal, emit } = options;
	const runId = `run_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

	try {
		const agents = effectiveAgents();
		const route = await routeAgents(config, request, signal, agents);
		emit({ type: 'run.started', runId, agents: route.agents, note: route.note });

		try {
			core.audit.record({
				principal,
				action: 'assistant.chat',
				resource: 'assistant',
				args: { agents: route.agents, chars: request.message.length, page: request.context.path },
				result: 'ok'
			});
		} catch (error) {
			console.error('[assistant] audit failed:', error);
		}

		const allTools = assistantTools(principal);
		const answers: AgentAnswer[] = [];
		let confirmationPending = false;
		for (const id of route.agents) {
			const definition = agents[id];
			if (!definition?.enabled) continue;
			const answer = await runAgent(
				config,
				definition,
				principal,
				request,
				allTools,
				signal,
				emit,
				runId
			);
			answers.push(answer);
			if (signal.aborted) return;
			// A pending confirmation pauses the turn: the next message carries the result.
			if (answer.needsConfirmation) {
				confirmationPending = true;
				break;
			}
		}

		const useful = answers.filter((answer) => answer.text.trim() !== '');
		if (!confirmationPending) {
			if (route.agents.length === 1 && useful.length === 1) {
				// The specialist already streamed the final answer.
			} else if (useful.length > 1) {
				await synthesise(config, request, useful, signal, emit, runId);
			} else if (useful.length === 0) {
				await runLead(config, request, signal, emit, runId);
			}
		}
		emit({ type: 'run.finished', runId, agents: route.agents });
	} catch (error) {
		if (signal.aborted) return;
		emit({
			type: 'error',
			runId,
			message: error instanceof Error ? error.message : String(error)
		});
		emit({ type: 'run.finished', runId, agents: [] });
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
