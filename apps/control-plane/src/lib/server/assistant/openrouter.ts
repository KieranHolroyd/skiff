/**
 * OpenRouter's public model catalogue, used by Settings → Assistant so an owner picks a real,
 * tool-capable model instead of typing an id from memory. The chat itself still goes through the
 * OpenAI-compatible client; this is only a discovery convenience.
 */

import type { AssistantModelInfo } from '@skiff/contracts';

export type OpenRouterModel = AssistantModelInfo;

interface Cache {
	at: number;
	models: OpenRouterModel[];
}

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CACHE_MS = 10 * 60_000;
let cache: Cache | null = null;

function number(value: unknown): number | null {
	const parsed =
		typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
	return Number.isFinite(parsed) ? parsed : null;
}

function parseModel(value: unknown): OpenRouterModel | null {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const input = value as Record<string, unknown>;
	if (typeof input.id !== 'string' || !input.id) return null;
	const supported = Array.isArray(input.supported_parameters)
		? input.supported_parameters.filter((item): item is string => typeof item === 'string')
		: [];
	const pricing =
		input.pricing && typeof input.pricing === 'object' && !Array.isArray(input.pricing)
			? (input.pricing as Record<string, unknown>)
			: {};
	return {
		id: input.id,
		name: typeof input.name === 'string' && input.name ? input.name : input.id,
		contextLength: number(input.context_length),
		promptPrice: number(pricing.prompt),
		completionPrice: number(pricing.completion),
		// Older catalogue rows had no supported_parameters. Only exclude models that explicitly
		// say they cannot call tools; the chat validates on its first turn anyway.
		supportsTools: supported.length === 0 || supported.includes('tools')
	};
}

/** Pure parser for the catalogue response; exported for tests. */
export function parseOpenRouterModels(value: unknown): OpenRouterModel[] {
	if (!Array.isArray(value)) return [];
	return value
		.map(parseModel)
		.filter((model): model is OpenRouterModel => model !== null)
		.filter((model) => model.supportsTools)
		.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function listOpenRouterModels(
	options: { force?: boolean; signal?: AbortSignal } = {}
): Promise<{ ok: true; models: OpenRouterModel[] } | { ok: false; message: string }> {
	if (!options.force && cache && Date.now() - cache.at < CACHE_MS)
		return { ok: true, models: cache.models };
	try {
		const response = await fetch(MODELS_URL, {
			headers: { accept: 'application/json', 'x-title': 'Skiff' },
			signal: options.signal
		});
		if (!response.ok) {
			const body = (await response.text()).slice(0, 300);
			return {
				ok: false,
				message: `OpenRouter answered ${response.status}: ${body || response.statusText}`
			};
		}
		const body = (await response.json()) as { data?: unknown };
		if (!Array.isArray(body.data))
			return { ok: false, message: 'OpenRouter returned no model list.' };
		const models = body.data
			.map(parseModel)
			.filter((model): model is OpenRouterModel => model !== null)
			.filter((model) => model.supportsTools)
			.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
		cache = { at: Date.now(), models };
		return { ok: true, models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Could not reach OpenRouter: ${message}` };
	}
}
