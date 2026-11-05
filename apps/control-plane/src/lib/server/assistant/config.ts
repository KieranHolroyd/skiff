import { ASSISTANT_AGENTS, type AssistantStatus } from '@skiff/contracts';

/**
 * Settings → Assistant (docs/ASSISTANT.md). The assistant is optional and off until an owner
 * configures an OpenAI-compatible model provider. Values come from the process environment, which
 * in production is `/etc/skiff/skiff.env` (written by `skiff-platform-config`) and in development is
 * `.data/platform-settings.json`.
 */

export interface AssistantRuntimeConfig {
	provider: 'openai' | 'openai-compatible' | 'openrouter' | 'ollama';
	baseUrl: string;
	model: string;
	/** A cheaper/faster model for the routing decision; falls back to `model`. */
	routerModel: string;
	apiKey?: string;
	/** How many specialists a single turn may use (1–4). */
	maxAgents: number;
}

const DEFAULT_BASE_URL: Record<AssistantRuntimeConfig['provider'], string> = {
	openai: 'https://api.openai.com/v1',
	'openai-compatible': 'https://api.openai.com/v1',
	openrouter: 'https://openrouter.ai/api/v1',
	ollama: 'http://127.0.0.1:11434/v1'
};

function providerFromEnv(): AssistantRuntimeConfig['provider'] {
	const value = process.env.SKIFF_ASSISTANT_PROVIDER;
	return value === 'openai' || value === 'openrouter' || value === 'ollama'
		? value
		: 'openai-compatible';
}

/** `null` means the feature is not configured (or explicitly disabled). */
export function assistantConfig(): AssistantRuntimeConfig | null {
	if (process.env.SKIFF_ASSISTANT_DISABLED === '1') return null;
	const provider = providerFromEnv();
	const baseUrl = (process.env.SKIFF_ASSISTANT_BASE_URL ?? DEFAULT_BASE_URL[provider]).replace(
		/\/$/,
		''
	);
	const model = process.env.SKIFF_ASSISTANT_MODEL;
	if (!baseUrl || !model) return null;
	const max = Number(process.env.SKIFF_ASSISTANT_MAX_AGENTS ?? 3);
	return {
		provider,
		baseUrl,
		model,
		routerModel: process.env.SKIFF_ASSISTANT_ROUTER_MODEL ?? model,
		apiKey: process.env.SKIFF_ASSISTANT_API_KEY || undefined,
		maxAgents: Number.isInteger(max) ? Math.min(4, Math.max(1, max)) : 3
	};
}

export const assistantEnabled = (): boolean => assistantConfig() !== null;

/** Public status for the dashboard: never includes the API key. */
export function assistantStatus(): AssistantStatus {
	const config = assistantConfig();
	return {
		enabled: config !== null,
		configured: config !== null,
		provider: config?.provider ?? null,
		model: config?.model ?? null,
		agents: ASSISTANT_AGENTS.map((agent) => ({ ...agent, enabled: true })),
		maxAgents: config?.maxAgents ?? 3
	};
}

/** Credentials for an OpenAI-compatible endpoint. Ollama ignores the token. */
export function providerHeaders(config: AssistantRuntimeConfig): Record<string, string> {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
	if (config.provider === 'openrouter') {
		// OpenRouter's optional attribution headers; harmless for other gateways.
		headers['x-title'] = 'Skiff';
		const origin = process.env.SKIFF_PLATFORM_ORIGIN;
		if (origin) headers['http-referer'] = origin;
	}
	return headers;
}

/**
 * Validate a provider by listing its models. This is the Settings → Assistant "Test" button and
 * the pre-save check, so a typo in the base URL or key fails before the control plane restarts.
 */
export async function testProvider(
	config: Pick<AssistantRuntimeConfig, 'baseUrl' | 'apiKey'> & { model?: string },
	signal?: AbortSignal
): Promise<{ ok: true; models: string[] } | { ok: false; message: string }> {
	const baseUrl = config.baseUrl.replace(/\/$/, '');
	try {
		const response = await fetch(`${baseUrl}/models`, {
			headers: providerHeaders({
				...config,
				provider: 'openai-compatible',
				model: config.model ?? '',
				routerModel: '',
				maxAgents: 1
			}),
			signal
		});
		if (response.ok) {
			const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
			const models = (body.data ?? [])
				.map((model) => (typeof model.id === 'string' ? model.id : ''))
				.filter(Boolean)
				.sort();
			return { ok: true, models };
		}
		// Not every compatible server implements /models. A one-token completion is a real test.
		if ((response.status === 404 || response.status === 405) && config.model) {
			const probe = await fetch(`${baseUrl}/chat/completions`, {
				method: 'POST',
				headers: providerHeaders({
					...config,
					provider: 'openai-compatible',
					model: config.model,
					routerModel: '',
					maxAgents: 1
				}),
				body: JSON.stringify({
					model: config.model,
					messages: [{ role: 'user', content: 'ping' }],
					max_tokens: 1,
					stream: false
				}),
				signal
			});
			if (probe.ok) return { ok: true, models: [] };
			const detail = (await probe.text()).slice(0, 400);
			return {
				ok: false,
				message: `The provider has no /models endpoint and a test completion failed (${probe.status}): ${detail || probe.statusText}`
			};
		}
		const body = (await response.text()).slice(0, 400);
		return {
			ok: false,
			message: `The provider answered ${response.status}: ${body || response.statusText}`
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: `Could not reach the provider: ${message}` };
	}
}
