import {
	assistantAgentLabel,
	type AssistantChatRequest,
	type AssistantConfirmation,
	type AssistantEvent,
	type AssistantGuide,
	type AssistantPageContext,
	type AssistantSpeaker
} from '@skiff/contracts';

/**
 * Chat state for the dashboard assistant. The panel is mounted once in the dashboard layout, so a
 * conversation survives client-side navigation (but not a full reload). Streamed events update the
 * message for the agent that produced them, which is what makes the multi-agent turn legible.
 */

export interface AssistantMessage {
	id: string;
	role: 'user' | 'assistant';
	speaker?: AssistantSpeaker;
	content: string;
	error?: boolean;
}

export interface ToolActivity {
	callId: string;
	agent: AssistantSpeaker;
	tool: string;
	title: string;
	status: 'running' | 'ok' | 'error';
	summary?: string;
}

export interface PendingConfirmation extends AssistantConfirmation {
	status: 'pending' | 'running' | 'done' | 'error' | 'denied';
	result?: string;
	error?: string;
}

function id(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function parseEvent(block: string): AssistantEvent | null {
	const lines = block.split(/\r?\n/);
	const data = lines
		.filter((line) => line.startsWith('data:'))
		.map((line) => line.slice(5).trim())
		.join('\n');
	if (!data) return null;
	try {
		return JSON.parse(data) as AssistantEvent;
	} catch {
		return null;
	}
}

class AssistantChatState {
	open = $state(false);
	status = $state<'idle' | 'sending'>('idle');
	messages = $state<AssistantMessage[]>([]);
	activities = $state<ToolActivity[]>([]);
	activeAgents = $state<string[]>([]);
	tour = $state<AssistantGuide | null>(null);
	confirmation = $state<PendingConfirmation | null>(null);
	error = $state<string | null>(null);

	private controller: AbortController | null = null;
	private runId: string | null = null;
	private currentMessages = new Map<AssistantSpeaker, string>();

	toggle(): void {
		this.open = !this.open;
	}

	close(): void {
		this.open = false;
	}

	reset(): void {
		this.controller?.abort();
		this.controller = null;
		this.runId = null;
		this.status = 'idle';
		this.messages = [];
		this.activities = [];
		this.activeAgents = [];
		this.tour = null;
		this.confirmation = null;
		this.error = null;
		this.currentMessages.clear();
	}

	stop(): void {
		this.controller?.abort();
		this.controller = null;
		this.status = 'idle';
		this.activeAgents = [];
	}

	dismissTour(): void {
		this.tour = null;
		// Return to the conversation that produced the tour.
		this.open = true;
	}

	private messageFor(speaker: AssistantSpeaker): AssistantMessage {
		const existing = this.currentMessages.get(speaker);
		if (existing) {
			const found = this.messages.find((message) => message.id === existing);
			if (found) return found;
		}
		const message: AssistantMessage = {
			id: id('msg'),
			role: 'assistant',
			speaker,
			content: ''
		};
		this.messages.push(message);
		this.currentMessages.set(speaker, message.id);
		return this.messages[this.messages.length - 1]!;
	}

	private handle(event: AssistantEvent): void {
		switch (event.type) {
			case 'run.started':
				this.activeAgents = event.agents.map((agent) => assistantAgentLabel(agent));
				break;
			case 'agent.started':
				if (this.currentMessages.has(event.agent)) return;
				this.messageFor(event.agent);
				this.activeAgents = [...new Set([...this.activeAgents, event.label])];
				break;
			case 'agent.finished':
				this.activeAgents = this.activeAgents.filter((label) => label !== event.label);
				break;
			case 'text.delta': {
				const message = this.messageFor(event.agent);
				message.content += event.text;
				break;
			}
			case 'tool.started':
				this.activities.push({
					callId: event.callId,
					agent: event.agent,
					tool: event.tool,
					title: event.title,
					status: 'running'
				});
				break;
			case 'tool.finished': {
				const activity = this.activities.find((item) => item.callId === event.callId);
				if (activity) {
					activity.status = event.ok ? 'ok' : 'error';
					activity.summary = event.summary;
				}
				break;
			}
			case 'ui.guide':
				this.tour = event.guide;
				// The tour needs the page, so step out of the panel.
				this.open = false;
				break;
			case 'confirmation.required':
				this.confirmation = {
					token: event.token,
					tool: event.tool,
					title: event.title,
					summary: event.summary,
					args: event.args,
					status: 'pending'
				};
				break;
			case 'error':
				this.error = event.message;
				break;
			case 'run.finished':
				this.status = 'idle';
				this.activeAgents = [];
				break;
		}
	}

	async send(text: string, context: AssistantPageContext): Promise<void> {
		const message = text.trim();
		if (!message || this.status === 'sending') return;
		const history = this.messages
			.filter((item) => !item.error && item.content.trim())
			.map((item) => ({ role: item.role, content: item.content }))
			.slice(-20);
		this.messages.push({ id: id('msg'), role: 'user', content: message });
		this.activities = [];
		this.activeAgents = [];
		this.error = null;
		this.confirmation = null;
		this.currentMessages.clear();
		this.status = 'sending';

		const controller = new AbortController();
		this.controller = controller;
		const body: AssistantChatRequest = { message, history, context };

		try {
			const response = await fetch('/api/v1/assistant/chat', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal
			});
			if (!response.ok) {
				const problem = (await response.json().catch(() => null)) as { message?: string } | null;
				throw new Error(problem?.message ?? `The assistant answered ${response.status}.`);
			}
			if (!response.body) throw new Error('The assistant returned an empty stream.');

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = '';
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const events = buffer.split(/\r?\n\r?\n/);
				buffer = events.pop() ?? '';
				for (const block of events) {
					const event = parseEvent(block);
					if (!event) continue;
					if (event.type === 'run.started') this.runId = event.runId;
					else if (this.runId && 'runId' in event && event.runId !== this.runId) continue;
					this.handle(event);
				}
			}
			const last = parseEvent(buffer);
			if (last && (!('runId' in last) || last.runId === this.runId)) this.handle(last);
		} catch (error) {
			if (controller.signal.aborted) return;
			this.error = error instanceof Error ? error.message : String(error);
			this.messages.push({
				id: id('msg'),
				role: 'assistant',
				speaker: 'lead',
				content: this.error,
				error: true
			});
		} finally {
			if (this.controller === controller) this.controller = null;
			this.status = 'idle';
			this.activeAgents = [];
		}
	}

	async confirm(): Promise<void> {
		const pending = this.confirmation;
		if (!pending || pending.status !== 'pending') return;
		pending.status = 'running';
		try {
			const response = await fetch('/api/v1/assistant/confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: pending.token })
			});
			const body = (await response.json().catch(() => null)) as {
				ok?: boolean;
				text?: string;
				message?: string;
			} | null;
			if (!response.ok || body?.ok !== true) {
				pending.status = 'error';
				pending.error = body?.message ?? `The action failed (${response.status}).`;
				return;
			}
			pending.status = 'done';
			pending.result = body.text ?? 'Done.';
			this.activities.push({
				callId: id('confirm'),
				agent: 'lead',
				tool: pending.tool,
				title: pending.title,
				status: 'ok',
				summary: pending.result.split('\n')[0]?.slice(0, 220)
			});
		} catch (error) {
			pending.status = 'error';
			pending.error = error instanceof Error ? error.message : String(error);
		}
	}

	deny(): void {
		if (!this.confirmation) return;
		this.confirmation.status = 'denied';
	}
}

export const assistant = new AssistantChatState();
