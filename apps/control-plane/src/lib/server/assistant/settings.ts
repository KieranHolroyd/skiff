import type { AssistantAgentDetail, Principal } from '@skiff/contracts';
import { core } from '../core';
import { sqlite } from '../db';
import { ASSISTANT_SYSTEM } from './agents';

/**
 * Owner-editable assistant details (Settings → Assistant → Instructions and tools). Provider
 * credentials stay in the environment (write-only, managed by `skiff-platform-config`); the prompt,
 * model override and tool allowlist are ordinary settings in the `settings` table under one key.
 *
 * Reads are lenient: a malformed row falls back to the built-in defaults rather than breaking the
 * dashboard. Writes are strict and audited.
 */

const SETTINGS_KEY = 'assistant.agent.v1';
const MAX_INSTRUCTIONS = 12_000;
const MAX_TOOLS = 200;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const TOOL = /^[a-z][a-z0-9_]{0,60}$/;

export interface AgentOverride {
	system: string;
	model: string | null;
	/** `null` offers every tool the caller may use. */
	tools: string[] | null;
}

/** The merged shape the orchestrator runs. */
export interface EffectiveAgent {
	system: string;
	/** `null` uses the platform model. */
	model: string | null;
	/** `null` offers every tool the caller may use. */
	tools: string[] | null;
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
	const system =
		typeof input.system === 'string' &&
		input.system.trim() &&
		input.system.trim().length <= MAX_INSTRUCTIONS
			? input.system.trim()
			: null;
	if (!system) return null;
	let tools: string[] | null = null;
	if (input.tools !== null && input.tools !== undefined) {
		tools = cleanTools(input.tools);
		if (!tools) return null;
	}
	let model: string | null = null;
	if (typeof input.model === 'string' && input.model.trim()) {
		if (!MODEL.test(input.model.trim())) return null;
		model = input.model.trim();
	}
	return { system, model, tools };
}

function readOverride(): AgentOverride | null {
	try {
		const row = sqlite
			.query<{ value: string }, [string]>('SELECT value FROM settings WHERE key = ?')
			.get(SETTINGS_KEY);
		if (!row?.value) return null;
		return cleanOverride(JSON.parse(row.value) as unknown);
	} catch {
		return null;
	}
}

function audit(principal: Principal, action: string): void {
	try {
		core.audit.record({ principal, action, resource: 'assistant', args: {}, result: 'ok' });
	} catch (error) {
		console.error('[assistant] audit failed:', error);
	}
}

/** Built-in defaults merged with the owner's override. */
export function effectiveAgent(): EffectiveAgent {
	const override = readOverride();
	return {
		system: override?.system ?? ASSISTANT_SYSTEM,
		model: override?.model ?? null,
		tools: override?.tools ?? null
	};
}

/** Owner view of the assistant, including whether it still matches the defaults. */
export function agentDetail(): AssistantAgentDetail {
	const override = readOverride();
	const agent = effectiveAgent();
	return {
		instructions: agent.system,
		model: agent.model,
		tools: agent.tools,
		customized: override !== null
	};
}

export type AgentDetailInput = {
	system: string;
	model: string;
	/** `null` offers every tool. */
	tools: string[] | null;
};

/** Strict validation used by the save action. */
export function validateAgentDetail(
	input: AgentDetailInput,
	allowedTools: ReadonlySet<string>
): { ok: true; value: AgentOverride } | { ok: false; error: string } {
	const system = input.system.trim();
	if (!system || system.length > MAX_INSTRUCTIONS)
		return { ok: false, error: `Instructions must be 1–${MAX_INSTRUCTIONS} characters.` };
	const model = input.model.trim();
	if (model && !MODEL.test(model))
		return { ok: false, error: 'Model must be a model id (letters, digits, . _ : / -).' };
	let tools: string[] | null = null;
	if (input.tools !== null) {
		tools = cleanTools(input.tools);
		if (!tools) return { ok: false, error: `Choose at most ${MAX_TOOLS} valid tools.` };
		if (tools.length === 0) return { ok: false, error: 'Choose at least one tool.' };
		const unknown = tools.filter((tool) => !allowedTools.has(tool));
		if (unknown.length)
			return {
				ok: false,
				error: `Unknown tool${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}.`
			};
	}
	return { ok: true, value: { system, model: model || null, tools } };
}

export function saveAgentDetail(principal: Principal, value: AgentOverride): void {
	sqlite.run(
		`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		[SETTINGS_KEY, JSON.stringify(value), Date.now()]
	);
	audit(principal, 'platform.assistantAgent');
}

export function resetAgentDetail(principal: Principal): void {
	sqlite.run('DELETE FROM settings WHERE key = ?', [SETTINGS_KEY]);
	audit(principal, 'platform.assistantAgentReset');
}
