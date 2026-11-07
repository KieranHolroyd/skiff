import type {
	AssistantChatRequest,
	AssistantConfirmation,
	AssistantEvent,
	AssistantGuide,
	AssistantPageContext
} from '@skiff/contracts';
import { collectPageContext } from './page-context.js';

/**
 * Chat state for the dashboard assistant (docs/ASSISTANT.md).
 *
 * Conversations are kept per signed-in user in this browser's localStorage, so they survive
 * navigation and reloads. Nothing is stored on the server beyond the audit trail. Each turn groups
 * the user's message with the assistant's reply; tool steps and confirmation cards are attached to
 * that reply, so scrolling back shows exactly what happened in that turn.
 */

export type StepStatus = 'running' | 'ok' | 'error' | 'cancelled';

export interface ToolStep {
	callId: string;
	tool: string;
	title: string;
	status: StepStatus;
	args?: string;
	summary?: string;
	detail?: string;
	durationMs?: number;
	startedAt: number;
}

export type ConfirmationStatus = 'pending' | 'running' | 'done' | 'error' | 'denied' | 'expired';

export interface ConfirmationCard extends AssistantConfirmation {
	status: ConfirmationStatus;
	createdAt: number;
	result?: string;
	error?: string;
}

export type MessageState = 'streaming' | 'done' | 'stopped' | 'error';

export interface AssistantMessage {
	id: string;
	turnId: string;
	role: 'user' | 'assistant';
	content: string;
	createdAt: number;
	state?: MessageState;
	steps?: ToolStep[];
	confirmations?: ConfirmationCard[];
	/** Whole-turn duration, on the last reply of a turn. */
	durationMs?: number;
	/** The page the user was on when they asked. */
	page?: string;
}

export interface Conversation {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	pinned?: boolean;
	draft?: string;
	messages: AssistantMessage[];
}

export interface AssistantPrefs {
	wide: boolean;
	docked: boolean;
	includePage: boolean;
}

const STORAGE_VERSION = 1;
const MAX_CONVERSATIONS = 40;
const MAX_MESSAGES = 200;
const MAX_HISTORY = 20;
const MAX_HISTORY_CHARS = 12_000;
const CONFIRM_TTL_MS = 10 * 60_000;
export const MAX_MESSAGE_CHARS = 8_000;

function id(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

function parseEvent(block: string): AssistantEvent | null {
	const data = block
		.split(/\r?\n/)
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

function titleFrom(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 60 ? `${line.slice(0, 57)}…` : line || 'New conversation';
}

function readStorage<T>(key: string): T | null {
	try {
		const raw = localStorage.getItem(key);
		return raw ? (JSON.parse(raw) as T) : null;
	} catch {
		return null;
	}
}

/** Bring a stored conversation back to a consistent idle state (a reload can interrupt a run). */
function revive(conversation: Conversation): Conversation {
	const now = Date.now();
	for (const message of conversation.messages) {
		if (message.state === 'streaming') message.state = 'stopped';
		for (const step of message.steps ?? [])
			if (step.status === 'running') step.status = 'cancelled';
		for (const card of message.confirmations ?? []) {
			if (card.status === 'running') card.status = 'error';
			if (card.status === 'pending' && now - card.createdAt > CONFIRM_TTL_MS)
				card.status = 'expired';
		}
	}
	return conversation;
}

/** What the model sees of a past reply: its text plus what happened to any action it proposed. */
function historyContent(message: AssistantMessage): string {
	let text = message.content.trim();
	for (const card of message.confirmations ?? []) {
		const outcome =
			card.status === 'done'
				? `the user confirmed it and it completed: ${(card.result ?? 'Done.').replace(/\s+/g, ' ').slice(0, 400)}`
				: card.status === 'denied'
					? 'the user cancelled it; nothing changed'
					: card.status === 'error'
						? `the user confirmed it but it failed: ${(card.error ?? '').slice(0, 300)}`
						: card.status === 'expired'
							? 'the confirmation expired; nothing changed'
							: 'still waiting for the user to confirm or cancel';
		text += `\n\n[Proposed action "${card.title}": ${outcome}]`;
	}
	if (message.state === 'stopped') text += '\n\n[The user stopped this reply early.]';
	return text.slice(0, MAX_HISTORY_CHARS);
}

class AssistantChatState {
	open = $state(false);
	view = $state<'chat' | 'history'>('chat');
	status = $state<'idle' | 'sending'>('idle');
	conversations = $state<Conversation[]>([]);
	activeId = $state<string | null>(null);
	tour = $state<AssistantGuide | null>(null);
	/** A reply finished while the panel was closed. */
	unread = $state(false);
	/** The user message being edited in the composer (its turn is replaced on send). */
	editingTurn = $state<string | null>(null);
	prefs = $state<AssistantPrefs>({ wide: false, docked: false, includePage: true });

	private userId: string | null = null;
	private controller: AbortController | null = null;
	private runId: string | null = null;
	private turnId: string | null = null;
	/** The reply being streamed for the current turn. */
	private replyId: string | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	readonly active = $derived(this.conversations.find((item) => item.id === this.activeId) ?? null);
	readonly messages = $derived(this.active?.messages ?? []);
	readonly sending = $derived(this.status === 'sending');

	// --- persistence -------------------------------------------------------------------------

	private get key(): string {
		return `skiff.assistant.v${STORAGE_VERSION}.${this.userId ?? 'anon'}`;
	}

	/** Load this user's conversations and panel preferences. Safe to call more than once. */
	init(userId: string): void {
		if (typeof window === 'undefined' || this.userId === userId) return;
		this.userId = userId;
		const stored = readStorage<{ conversations?: Conversation[]; activeId?: string }>(this.key);
		this.conversations = (stored?.conversations ?? [])
			.filter((c) => Array.isArray(c?.messages))
			.map(revive);
		this.activeId = this.conversations.some((c) => c.id === stored?.activeId)
			? (stored?.activeId ?? null)
			: null;
		const prefs = readStorage<Partial<AssistantPrefs>>('skiff.assistant.prefs');
		if (prefs) this.prefs = { ...this.prefs, ...prefs };
		window.addEventListener('storage', (event) => {
			// Another tab changed the history: pick it up unless this tab is mid-run.
			if (event.key !== this.key || this.sending) return;
			const next = readStorage<{ conversations?: Conversation[] }>(this.key);
			if (next?.conversations) this.conversations = next.conversations.map(revive);
		});
		window.addEventListener('pagehide', () => this.flush());
	}

	persist(): void {
		if (typeof window === 'undefined' || !this.userId) return;
		// Throttle, not debounce: a long stream still saves every 400 ms.
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => this.flush(), 400);
	}

	flush(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (!this.userId) return;
		const sorted = [...this.conversations]
			.filter((c) => c.messages.length > 0 || c.draft)
			.sort(
				(a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false) || b.updatedAt - a.updatedAt
			);
		let keep = sorted.slice(0, MAX_CONVERSATIONS);
		for (let attempt = 0; attempt < 6; attempt += 1) {
			try {
				const payload = JSON.stringify({
					conversations: $state.snapshot(keep).map((c) => ({
						...c,
						messages: c.messages.slice(-MAX_MESSAGES).map((m) => ({
							...m,
							steps: m.steps?.map((step) => ({ ...step, detail: step.detail?.slice(0, 1_500) }))
						}))
					})),
					activeId: this.activeId
				});
				localStorage.setItem(this.key, payload);
				return;
			} catch {
				// Quota: drop the oldest unpinned conversations and try again.
				const unpinned = keep.filter((c) => !c.pinned);
				if (unpinned.length === 0) return;
				const drop = new Set(
					unpinned.slice(-Math.max(1, Math.ceil(unpinned.length / 4))).map((c) => c.id)
				);
				keep = keep.filter((c) => !drop.has(c.id));
			}
		}
	}

	setPref<K extends keyof AssistantPrefs>(key: K, value: AssistantPrefs[K]): void {
		this.prefs[key] = value;
		try {
			localStorage.setItem('skiff.assistant.prefs', JSON.stringify(this.prefs));
		} catch {
			// per-browser convenience only
		}
	}

	// --- panel and conversations --------------------------------------------------------------

	toggle(): void {
		if (this.open) this.close();
		else this.show();
	}

	show(): void {
		this.open = true;
		this.unread = false;
	}

	close(): void {
		this.open = false;
	}

	/**
	 * Open the panel and ask about something the user pointed at (a firing alert, a failed
	 * deploy). A reply still streaming is stopped first: the contextual action is the new request,
	 * so it starts its own conversation instead of joining (and sending the history of) whatever
	 * was open.
	 */
	ask(prompt: string): void {
		const text = prompt.trim();
		if (!text) return;
		if (this.sending) this.stop();
		this.activeId = null;
		this.editingTurn = null;
		this.view = 'chat';
		this.show();
		void this.send(text, this.prefs.includePage ? collectPageContext() : { path: '', targets: [] });
	}

	private ensureConversation(): Conversation {
		if (this.active) return this.active;
		const conversation: Conversation = {
			id: id('chat'),
			title: 'New conversation',
			createdAt: Date.now(),
			updatedAt: Date.now(),
			messages: []
		};
		this.conversations.unshift(conversation);
		this.activeId = conversation.id;
		return this.conversations[0]!;
	}

	/** Start a fresh conversation (the current one stays in history). */
	newConversation(): void {
		if (this.sending) this.stop();
		this.activeId = null;
		this.editingTurn = null;
		this.view = 'chat';
		this.persist();
	}

	select(conversationId: string): void {
		if (this.sending) this.stop();
		this.activeId = conversationId;
		this.editingTurn = null;
		this.view = 'chat';
		this.persist();
	}

	rename(conversationId: string, title: string): void {
		const conversation = this.conversations.find((c) => c.id === conversationId);
		if (!conversation || !title.trim()) return;
		conversation.title = title.trim().slice(0, 120);
		this.persist();
	}

	togglePin(conversationId: string): void {
		const conversation = this.conversations.find((c) => c.id === conversationId);
		if (!conversation) return;
		conversation.pinned = !conversation.pinned;
		this.persist();
	}

	remove(conversationId: string): void {
		if (this.activeId === conversationId) {
			if (this.sending) this.stop();
			this.activeId = null;
		}
		this.conversations = this.conversations.filter((c) => c.id !== conversationId);
		this.persist();
	}

	clearAll(): void {
		if (this.sending) this.stop();
		this.conversations = this.conversations.filter((c) => c.pinned);
		this.activeId = null;
		this.persist();
	}

	/** Clear the current conversation's messages but keep it as the active thread. */
	clearActive(): void {
		if (this.sending) this.stop();
		if (this.active) {
			this.active.messages = [];
			this.active.title = 'New conversation';
		}
		this.editingTurn = null;
		this.persist();
	}

	setDraft(text: string): void {
		const conversation = this.active;
		if (conversation) {
			if ((conversation.draft ?? '') === text) return;
			conversation.draft = text;
		} else {
			if (!text) return;
			this.ensureConversation().draft = text;
		}
		this.persist();
	}

	dismissTour(): void {
		this.tour = null;
		// Return to the conversation that produced the tour.
		this.show();
	}

	exportMarkdown(): string {
		const conversation = this.active;
		if (!conversation) return '';
		const lines = [`# ${conversation.title}`, '', `_Exported ${new Date().toISOString()}_`, ''];
		for (const message of conversation.messages) {
			const who = message.role === 'user' ? 'You' : 'Skiff';
			lines.push(
				`## ${who} · ${new Date(message.createdAt).toLocaleString()}`,
				'',
				message.content.trim(),
				''
			);
			for (const step of message.steps ?? [])
				lines.push(
					`- tool \`${step.tool}\` (${step.status})${step.summary ? `: ${step.summary}` : ''}`
				);
			for (const card of message.confirmations ?? [])
				lines.push(`- action "${card.title}": ${card.status}`);
			if (message.steps?.length || message.confirmations?.length) lines.push('');
		}
		return lines.join('\n');
	}

	// --- running a turn -----------------------------------------------------------------------

	stop(): void {
		this.controller?.abort();
		this.controller = null;
		this.finishTurn('stopped');
	}

	private finishTurn(state: MessageState, durationMs?: number): void {
		const conversation = this.active;
		if (conversation && this.turnId) {
			const replies = conversation.messages.filter(
				(m) => m.turnId === this.turnId && m.role === 'assistant'
			);
			for (const message of replies) {
				if (message.state === 'streaming')
					message.state = state === 'done' && !message.content ? 'done' : state;
				for (const step of message.steps ?? [])
					if (step.status === 'running') step.status = 'cancelled';
			}
			// Drop empty placeholders an aborted run left behind.
			conversation.messages = conversation.messages.filter(
				(m) =>
					!(
						m.turnId === this.turnId &&
						m.role === 'assistant' &&
						!m.content &&
						!m.steps?.length &&
						!m.confirmations?.length &&
						m.state !== 'error'
					)
			);
			const last = conversation.messages.findLast(
				(m) => m.turnId === this.turnId && m.role === 'assistant'
			);
			if (last && durationMs !== undefined) last.durationMs = durationMs;
			conversation.updatedAt = Date.now();
		}
		this.status = 'idle';
		this.replyId = null;
		if (!this.open && state === 'done') this.unread = true;
		this.persist();
	}

	/** The current turn's reply, created on first use. */
	private reply(): AssistantMessage {
		const conversation = this.active!;
		if (this.replyId) {
			const found = conversation.messages.find((message) => message.id === this.replyId);
			if (found) return found;
		}
		conversation.messages.push({
			id: id('msg'),
			turnId: this.turnId!,
			role: 'assistant',
			content: '',
			createdAt: Date.now(),
			state: 'streaming'
		});
		const message = conversation.messages[conversation.messages.length - 1]!;
		this.replyId = message.id;
		return message;
	}

	private handle(event: AssistantEvent): void {
		switch (event.type) {
			case 'run.started':
				// Show the "Thinking…" placeholder straight away.
				this.reply();
				break;
			case 'text.delta':
				this.reply().content += event.text;
				break;
			case 'tool.started': {
				const message = this.reply();
				(message.steps ??= []).push({
					callId: event.callId,
					tool: event.tool,
					title: event.title,
					args: event.args,
					status: 'running',
					startedAt: Date.now()
				});
				break;
			}
			case 'tool.finished': {
				const step = this.reply().steps?.find((item) => item.callId === event.callId);
				if (step) {
					step.status = event.ok ? 'ok' : 'error';
					step.summary = event.summary;
					step.detail = event.detail;
					step.durationMs = event.durationMs ?? Date.now() - step.startedAt;
				}
				break;
			}
			case 'ui.guide':
				this.tour = event.guide;
				// The tour needs the page, so step out of the panel.
				this.open = false;
				break;
			case 'confirmation.required': {
				const message = this.reply();
				(message.confirmations ??= []).push({
					token: event.token,
					tool: event.tool,
					title: event.title,
					summary: event.summary,
					args: event.args,
					status: 'pending',
					createdAt: Date.now()
				});
				// The proposal replaces the running step for the same call.
				const running = message.steps?.findLast(
					(step) => step.tool === event.tool && step.status === 'running'
				);
				if (running) {
					running.status = 'ok';
					running.summary = 'Waiting for your confirmation.';
					running.durationMs = Date.now() - running.startedAt;
				}
				break;
			}
			case 'error':
				this.errorReply(event.message);
				break;
			case 'run.finished':
				this.finishTurn('done', event.durationMs);
				break;
		}
		this.persist();
	}

	/**
	 * Send a message. With `editingTurn` set (or `replaceTurn`), the conversation is cut back to
	 * just before that turn first, so edits and regenerations replace the old answer.
	 */
	async send(
		text: string,
		context: AssistantPageContext,
		options: { replaceTurn?: string } = {}
	): Promise<void> {
		const message = text.trim().slice(0, MAX_MESSAGE_CHARS);
		if (!message || this.sending) return;
		const conversation = this.ensureConversation();
		const replaceTurn = options.replaceTurn ?? this.editingTurn;
		this.editingTurn = null;
		if (replaceTurn) {
			const index = conversation.messages.findIndex((m) => m.turnId === replaceTurn);
			if (index >= 0) conversation.messages = conversation.messages.slice(0, index);
		}

		const history = conversation.messages
			.filter(
				(item) => item.state !== 'error' && (item.content.trim() || item.confirmations?.length)
			)
			.map((item) => ({
				role: item.role,
				content: item.role === 'user' ? item.content : historyContent(item)
			}))
			.slice(-MAX_HISTORY);

		const turnId = id('turn');
		conversation.messages.push({
			id: id('msg'),
			turnId,
			role: 'user',
			content: message,
			createdAt: Date.now(),
			page: context.path || undefined
		});
		if (
			conversation.messages.filter((m) => m.role === 'user').length === 1 ||
			conversation.title === 'New conversation'
		)
			conversation.title = titleFrom(message);
		conversation.draft = '';
		conversation.updatedAt = Date.now();

		this.turnId = turnId;
		this.runId = null;
		this.replyId = null;
		this.status = 'sending';
		this.persist();

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
			let finished = false;
			const dispatch = (event: AssistantEvent | null) => {
				if (!event || this.controller !== controller) return;
				if (event.type === 'run.started') this.runId = event.runId;
				else if (
					this.runId &&
					'runId' in event &&
					event.runId !== this.runId &&
					event.runId !== 'run_failed'
				)
					return;
				if (event.type === 'run.finished') finished = true;
				this.handle(event);
			};
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				const blocks = buffer.split(/\r?\n\r?\n/);
				buffer = blocks.pop() ?? '';
				for (const block of blocks) dispatch(parseEvent(block));
			}
			dispatch(parseEvent(buffer));
			if (!finished && this.controller === controller) {
				// The stream ended without a terminal event (connection dropped, server restart).
				this.fail('The connection to the assistant closed before the reply finished.');
			}
		} catch (error) {
			if (controller.signal.aborted) return;
			this.fail(error instanceof Error ? error.message : String(error));
		} finally {
			if (this.controller === controller) {
				this.controller = null;
				if (this.sending) this.finishTurn('done');
			}
		}
	}

	private fail(text: string): void {
		this.errorReply(text);
		this.finishTurn('error');
	}

	/**
	 * Show an error. An empty reply becomes the error; a reply that already has text or steps keeps
	 * them and the error follows as its own message.
	 */
	private errorReply(text: string): void {
		let message = this.reply();
		if (message.content || message.steps?.length || message.confirmations?.length) {
			if (message.state === 'streaming') message.state = 'stopped';
			this.replyId = null;
			message = this.reply();
		}
		message.content = message.content ? `${message.content}\n\n${text}` : text;
		message.state = 'error';
	}

	/** The user message that opened a turn. */
	turnPrompt(turnId: string): AssistantMessage | undefined {
		return this.messages.find((m) => m.turnId === turnId && m.role === 'user');
	}

	/** Re-run a turn (regenerate an answer, or retry one that failed). */
	retry(turnId: string, context: AssistantPageContext): void {
		const prompt = this.turnPrompt(turnId);
		if (prompt) void this.send(prompt.content, context, { replaceTurn: turnId });
	}

	/** The newest user message, for up-arrow editing. */
	lastPrompt(): AssistantMessage | undefined {
		return this.messages.findLast((m) => m.role === 'user');
	}

	async confirm(card: ConfirmationCard): Promise<void> {
		if (card.status !== 'pending') return;
		if (Date.now() - card.createdAt > CONFIRM_TTL_MS) {
			card.status = 'expired';
			this.persist();
			return;
		}
		card.status = 'running';
		try {
			const response = await fetch('/api/v1/assistant/confirm', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ token: card.token })
			});
			const body = (await response.json().catch(() => null)) as {
				ok?: boolean;
				text?: string;
				message?: string;
			} | null;
			if (!response.ok || body?.ok !== true) {
				card.status = 'error';
				card.error = body?.message ?? body?.text ?? `The action failed (${response.status}).`;
			} else {
				card.status = 'done';
				card.result = body.text ?? 'Done.';
			}
		} catch (error) {
			card.status = 'error';
			card.error = error instanceof Error ? error.message : String(error);
		}
		this.persist();
	}

	deny(card: ConfirmationCard): void {
		if (card.status !== 'pending') return;
		card.status = 'denied';
		this.persist();
	}
}

export const assistant = new AssistantChatState();
