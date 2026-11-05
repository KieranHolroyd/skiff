import type { AssistantRuntimeConfig } from './config';
import { providerHeaders } from './config';

/**
 * A small OpenAI-compatible chat-completions client. One protocol covers OpenAI, OpenRouter,
 * vLLM, LM Studio, Ollama and most hosted gateways, which keeps the optional assistant free of a
 * vendor SDK. Streams text deltas and accumulates tool calls.
 */

export interface ProviderToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface ProviderMessage {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: { name: string; arguments: string };
	}>;
	tool_call_id?: string;
	name?: string;
}

export interface ProviderTool {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: Record<string, unknown>;
	};
}

export interface ChatOptions {
	model?: string;
	messages: ProviderMessage[];
	tools?: ProviderTool[];
	temperature?: number;
	signal?: AbortSignal;
	/** Called for every streamed text delta. */
	onText?: (text: string) => void;
	/** Hard cap on the response. */
	maxTokens?: number;
}

export interface ChatResult {
	text: string;
	toolCalls: ProviderToolCall[];
	finishReason: string | null;
}

function contentText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (Array.isArray(content))
		return content
			.map((part) => {
				if (typeof part === 'string') return part;
				if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string')
					return part.text;
				return '';
			})
			.join('');
	return '';
}

/** Parse one SSE line; returns the JSON payload, `null` for comments/blank, or `'[DONE]'`. */
function parseDataLine(line: string): Record<string, unknown> | 'done' | null {
	if (!line.startsWith('data:')) return null;
	const raw = line.slice(5).trim();
	if (!raw) return null;
	if (raw === '[DONE]') return 'done';
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
}

export async function streamChat(
	config: AssistantRuntimeConfig,
	options: ChatOptions
): Promise<ChatResult> {
	const controller = new AbortController();
	const signal = options.signal
		? AbortSignal.any([options.signal, controller.signal])
		: controller.signal;
	const timer = setTimeout(() => controller.abort(), 120_000);

	let response: Response;
	try {
		response = await fetch(`${config.baseUrl}/chat/completions`, {
			method: 'POST',
			headers: providerHeaders(config),
			body: JSON.stringify({
				model: options.model ?? config.model,
				messages: options.messages,
				stream: true,
				temperature: options.temperature ?? 0.2,
				...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
				...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {})
			}),
			signal
		});
	} catch (error) {
		clearTimeout(timer);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			signal.aborted
				? 'The model provider timed out.'
				: `Could not reach the model provider: ${message}`,
			{ cause: error }
		);
	}

	try {
		if (!response.ok) {
			const body = (await response.text()).slice(0, 600);
			throw new Error(
				`The model provider answered ${response.status}: ${body || response.statusText}. Check the base URL, model and API key in Settings → Assistant.`
			);
		}
		if (!response.body) throw new Error('The model provider returned an empty response.');

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';
		let text = '';
		let finishReason: string | null = null;
		const calls = new Map<number, { id: string; name: string; arguments: string }>();

		const consume = (payload: Record<string, unknown>) => {
			const error = payload.error as { message?: unknown } | undefined;
			if (error) throw new Error(String(error.message ?? 'The model provider returned an error.'));
			const choices = payload.choices as
				| Array<{
						delta?: {
							content?: unknown;
							tool_calls?: Array<{
								index?: number;
								id?: string;
								function?: { name?: string; arguments?: string };
							}>;
						};
						message?: { content?: unknown; tool_calls?: unknown };
						finish_reason?: string | null;
				  }>
				| undefined;
			const choice = choices?.[0];
			if (!choice) return;
			const delta = choice.delta ?? choice.message;
			const chunk = contentText(delta?.content);
			if (chunk) {
				text += chunk;
				options.onText?.(chunk);
			}
			for (const call of (delta?.tool_calls as Array<{
				index?: number;
				id?: string;
				function?: { name?: string; arguments?: string };
			}>) ?? []) {
				const index = typeof call.index === 'number' ? call.index : calls.size;
				const current = calls.get(index) ?? { id: '', name: '', arguments: '' };
				if (call.id) current.id = call.id;
				if (call.function?.name) current.name += call.function.name;
				if (call.function?.arguments) current.arguments += call.function.arguments;
				calls.set(index, current);
			}
			if (choice.finish_reason) finishReason = choice.finish_reason;
		};

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			// SSE events are separated by a blank line; keep the trailing partial event in the buffer.
			const events = buffer.split(/\r?\n\r?\n/);
			buffer = events.pop() ?? '';
			for (const event of events) {
				for (const line of event.split(/\r?\n/)) {
					const payload = parseDataLine(line);
					if (payload === 'done') {
						buffer = '';
						break;
					}
					if (payload) consume(payload);
				}
			}
		}
		// Some servers send one final event without a trailing blank line.
		for (const line of buffer.split(/\r?\n/)) {
			const payload = parseDataLine(line);
			if (payload && payload !== 'done') consume(payload);
			if (payload === 'done') break;
		}

		const toolCalls: ProviderToolCall[] = [...calls.entries()]
			.sort(([a], [b]) => a - b)
			.map(([index, call]) => ({
				id: call.id || `call_${index}`,
				name: call.name,
				arguments: call.arguments.trim() || '{}'
			}))
			.filter((call) => call.name);

		return { text, toolCalls, finishReason };
	} finally {
		clearTimeout(timer);
	}
}
