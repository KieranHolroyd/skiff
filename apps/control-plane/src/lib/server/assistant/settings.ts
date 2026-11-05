import {
	ASSISTANT_AGENTS,
	type AssistantAgentDetail,
	type AssistantAgentId,
	type AssistantStatus,
	type Principal
} from '@skiff/contracts';
import { core } from '../core';
import { sqlite } from '../db';
import { AGENTS, type AgentDefinition } from './agents';
import { assistantStatus } from './config';

/**
 * Owner-editable agent details (Settings → Assistant → Agents). Provider credentials stay in the
 * environment (write-only, managed by `skiff-platform-config`); prompts, labels and tool allowlists
 * are ordinary settings and live in the `settings` table under one JSON key.
 *
 * Reads are lenient: a malformed row falls back to the built-in defaults rather than breaking the
 * dashboard. Writes are strict and audited.
 */

const SETTINGS_KEY = 'assistant.agents.v1';
const MAX_LABEL = 40;
const MAX_BRIEF = 240;
const MAX_INSTRUCTIONS = 8_000;
const MAX_TOOLS = 100;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const TOOL = /^[a-z][a-z0-9_]{0,60}$/;
const AGENT_IDS = new Set<string>(ASSISTANT_AGENTS.map((agent) => agent.id));

export interface AgentOverride {
	enabled: boolean;
	label: string;
	brief: string;
	system: string;
	model: string | null;
	tools: string[];
}

type AgentOverrides = Partial<Record<AssistantAgentId, AgentOverride>>;

/** The merged shape the orchestrator runs. */
export interface EffectiveAgent extends AgentDefinition {
	label: string;
	enabled: boolean;
	/** `null` uses the platform model. */
	model: string | null;
}

function oneLine(value: string, max: number): string | null {
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > max || /[\r\n\0]/.test(trimmed)) return null;
	return trimmed;
}

function cleanTools(value: unknown): string[] | null {
	if (!Array.isArray(value) || value.length > MAX_TOOLS) return null;
	const tools: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string' || !TOOL.test(item)) return null;
		if (!tools.includes(item)) tools.push(item);
	}
	return tools;
}

function cleanOverride(value: unknown): AgentOverride | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	const label = typeof input.label === 'string' ? oneLine(input.label, MAX_LABEL) : null;
	const brief = typeof input.brief === 'string' ? oneLine(input.brief, MAX_BRIEF) : null;
	const system =
		typeof input.system === 'string' && input.system.trim().length <= MAX_INSTRUCTIONS
			? input.system.trim()
			: null;
	if (!label || !brief || !system || typeof input.enabled !== 'boolean') return null;
	const tools = cleanTools(input.tools);
	if (!tools) return null;
	let model: string | null = null;
	if (typeof input.model === 'string' && input.model.trim()) {
		if (!MODEL.test(input.model.trim())) return null;
		model = input.model.trim();
	}
	return { enabled: input.enabled, label, brief, system, model, tools };
}

function readOverrides(): AgentOverrides {
	try {
		const row = sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(SETTINGS_KEY);
		if (!row?.value) return {};
		const raw = JSON.parse(row.value) as unknown;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
		const overrides: AgentOverrides = {};
		for (const [id, value] of Object.entries(raw)) {
			if (!AGENT_IDS.has(id)) continue;
			const clean = cleanOverride(value);
			if (clean) overrides[id as AssistantAgentId] = clean;
		}
		return overrides;
	} catch {
		return {};
	}
}

function writeOverrides(
	principal: Principal,
	overrides: AgentOverrides,
	auditAction: string
): void {
	sqlite.run(
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		[SETTINGS_KEY, JSON.stringify(overrides), Date.now()]
	);
	try {
		core.audit.record({
			principal,
			action: auditAction,
			resource: 'assistant',
			args: { agents: Object.keys(overrides).sort() },
			result: 'ok'
		});
	} catch (error) {
		console.error('[assistant] audit failed:', error);
	}
}

/** Merge built-in defaults with the owner's overrides. */
export function effectiveAgentList(): EffectiveAgent[] {
	const overrides = readOverrides();
	return ASSISTANT_AGENTS.map((meta) => {
		const base = AGENTS[meta.id];
		const override = overrides[meta.id];
		return {
			...base,
			label: override?.label ?? meta.label,
			brief: override?.brief ?? base.brief,
			system: override?.system ?? base.system,
			tools: override?.tools ?? base.tools,
			enabled: override?.enabled ?? true,
			model: override?.model ?? null
		};
	});
}

export function effectiveAgents(): Record<AssistantAgentId, EffectiveAgent> {
	const out = {} as Record<AssistantAgentId, EffectiveAgent>;
	for (const agent of effectiveAgentList()) out[agent.id] = agent;
	return out;
}

/** The dashboard layout and status endpoint need the owner-edited labels too. */
export function assistantStatusWithAgents(): AssistantStatus {
	return {
		...assistantStatus(),
		agents: effectiveAgentList().map((agent) => ({
			id: agent.id,
			label: agent.label,
			description: agent.brief,
			enabled: agent.enabled
		}))
	};
}

/** Owner view of one agent, including whether it still matches the defaults. */
export function agentDetails(): AssistantAgentDetail[] {
	const overrides = readOverrides();
	return effectiveAgentList().map((agent) => ({
		id: agent.id,
		label: agent.label,
		description: agent.brief,
		instructions: agent.system,
		enabled: agent.enabled,
		model: agent.model,
		tools: agent.tools,
		customized: Boolean(overrides[agent.id])
	}));
}

export type AgentDetailInput = {
	enabled: boolean;
	label: string;
	brief: string;
	system: string;
	model: string;
	tools: string[];
};

/** Strict validation used by the save action. */
export function validateAgentDetail(
	input: AgentDetailInput,
	allowedTools: ReadonlySet<string>
): { ok: true; value: AgentOverride } | { ok: false; error: string } {
	const label = oneLine(input.label, MAX_LABEL);
	if (!label) return { ok: false, error: `Name must be 1–${MAX_LABEL} characters on one line.` };
	const brief = oneLine(input.brief, MAX_BRIEF);
	if (!brief)
		return { ok: false, error: `Description must be 1–${MAX_BRIEF} characters on one line.` };
	const system = input.system.trim();
	if (!system || system.length > MAX_INSTRUCTIONS)
		return { ok: false, error: `Instructions must be 1–${MAX_INSTRUCTIONS} characters.` };
	const model = input.model.trim();
	if (model && !MODEL.test(model))
		return { ok: false, error: 'Model must be a model id (letters, digits, . _ : / -).' };
	const tools = cleanTools(input.tools);
	if (!tools) return { ok: false, error: `Choose at most ${MAX_TOOLS} valid tools.` };
	const unknown = tools.filter((tool) => !allowedTools.has(tool));
	if (unknown.length)
		return {
			ok: false,
			error: `Unknown tool${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`
		};
	return {
		ok: true,
		value: { enabled: input.enabled, label, brief, system, model: model || null, tools }
	};
}

export function saveAgentDetail(
	principal: Principal,
	id: AssistantAgentId,
	value: AgentOverride
): void {
	const overrides = readOverrides();
	overrides[id] = value;
	writeOverrides(principal, overrides, 'platform.assistantAgent');
}

export function resetAgentDetail(principal: Principal, id: AssistantAgentId): void {
	const overrides = readOverrides();
	delete overrides[id];
	writeOverrides(principal, overrides, 'platform.assistantAgentReset');
}
