<script lang="ts" module>
	/** Where a page's shell lives, so a tab switch or reload re-attaches instead of starting over. */
	interface StoredShell {
		execId: string;
		replica: number | null;
		shell: string;
		user: string;
	}

	function storageKey(slug: string): string {
		return `skiff:container-shell:${slug}`;
	}

	function loadShell(slug: string): StoredShell | null {
		try {
			const raw = sessionStorage.getItem(storageKey(slug));
			return raw ? (JSON.parse(raw) as StoredShell) : null;
		} catch {
			return null;
		}
	}

	function saveShell(slug: string, shell: StoredShell | null): void {
		try {
			if (shell) sessionStorage.setItem(storageKey(slug), JSON.stringify(shell));
			else sessionStorage.removeItem(storageKey(slug));
		} catch {
			// Private mode: the shell still works, it just will not survive a reload.
		}
	}
</script>

<script lang="ts">
	import { onMount, untrack } from 'svelte';
	import { browser } from '$app/env';
	import { createQuery } from '@tanstack/svelte-query';
	import type { ContainerShell, ContainerTarget } from '@skiff/contracts';
	import type { Terminal } from '@xterm/xterm';
	import type { FitAddon } from '@xterm/addon-fit';
	import '@xterm/xterm/css/xterm.css';
	import Maximize2Icon from '@lucide/svelte/icons/maximize-2';
	import Minimize2Icon from '@lucide/svelte/icons/minimize-2';
	import PlayIcon from '@lucide/svelte/icons/play';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SquareIcon from '@lucide/svelte/icons/square';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { fetchJson } from '#lib/query.js';
	import ReplicaPicker from './ReplicaPicker.svelte';

	let {
		slug,
		replica = $bindable<number | null>(null)
	}: {
		slug: string;
		replica?: number | null;
	} = $props();

	type Phase = 'loading' | 'idle' | 'opening' | 'live' | 'reconnecting' | 'ended' | 'error';

	let host = $state<HTMLDivElement | null>(null);
	let phase = $state<Phase>('loading');
	let message = $state<string | null>(null);
	let fullscreen = $state(false);
	let shell = $state<ContainerShell>('auto');
	let user = $state<'default' | 'root'>('default');
	let current = $state<StoredShell | null>(null);

	let term: Terminal | null = null;
	let fit: FitAddon | null = null;
	let events: EventSource | null = null;
	let pending: Uint8Array[] = [];
	let flushTimer: ReturnType<typeof setTimeout> | null = null;
	let resizeTimer: ReturnType<typeof setTimeout> | null = null;
	let sending: Promise<unknown> = Promise.resolve();

	const base = $derived(`/projects/${encodeURIComponent(slug)}/container`);
	const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
	const replicaQuery = (value: number | null) => (value === null ? '' : `?replica=${value}`);

	const targetsQuery = createQuery(() => ({
		queryKey: ['container-targets', slug] as const,
		queryFn: ({ signal }) =>
			fetchJson<{ targets: ContainerTarget[] }>(`${base}/targets`, { signal }),
		enabled: browser,
		staleTime: 30_000
	}));

	/** A fixed dark palette: terminals read best dark in either theme, and xterm needs hex colours. */
	const theme = {
		background: '#0b0d10',
		foreground: '#e4e7eb',
		cursor: '#e4e7eb',
		cursorAccent: '#0b0d10',
		selectionBackground: '#3b4252aa',
		black: '#1d2026',
		red: '#f2777a',
		green: '#99cc99',
		yellow: '#ffcc66',
		blue: '#6699cc',
		magenta: '#cc99cc',
		cyan: '#66cccc',
		white: '#d3d7de',
		brightBlack: '#5c6370',
		brightRed: '#ff8f8f',
		brightGreen: '#b5e8b5',
		brightYellow: '#ffe08a',
		brightBlue: '#8cb8e8',
		brightMagenta: '#e0b8e0',
		brightCyan: '#8ce0e0',
		brightWhite: '#ffffff'
	};

	onMount(() => {
		let disposed = false;
		let observer: ResizeObserver | null = null;
		(async () => {
			const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
				import('@xterm/xterm'),
				import('@xterm/addon-fit'),
				import('@xterm/addon-web-links')
			]);
			if (disposed || !host) return;
			term = new Terminal({
				cursorBlink: true,
				fontFamily: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace',
				fontSize: 13,
				lineHeight: 1.15,
				scrollback: 10_000,
				allowProposedApi: false,
				theme
			});
			fit = new FitAddon();
			term.loadAddon(fit);
			term.loadAddon(new WebLinksAddon());
			term.open(host);
			fit.fit();
			// Ctrl/Cmd-C copies a selection instead of sending an interrupt.
			term.attachCustomKeyEventHandler((event) => {
				if (
					event.type === 'keydown' &&
					(event.ctrlKey || event.metaKey) &&
					event.key === 'c' &&
					term?.hasSelection()
				) {
					void navigator.clipboard?.writeText(term.getSelection());
					return false;
				}
				return true;
			});
			term.onData((data) => send(data));
			term.onBinary((data) => send(data, true));
			term.onResize(({ cols, rows }) => queueResize(cols, rows));
			observer = new ResizeObserver(() => fit?.fit());
			observer.observe(host);

			const stored = loadShell(slug);
			if (stored) {
				shell = stored.shell as ContainerShell;
				user = stored.user === 'root' ? 'root' : 'default';
				replica = stored.replica;
				attach(stored);
			} else {
				await open();
			}
		})().catch((error: unknown) => {
			phase = 'error';
			message = error instanceof Error ? error.message : 'The terminal could not start.';
		});
		return () => {
			disposed = true;
			observer?.disconnect();
			events?.close();
			events = null;
			if (flushTimer) clearTimeout(flushTimer);
			if (resizeTimer) clearTimeout(resizeTimer);
			term?.dispose();
			term = null;
			// The shell keeps running on the node; coming back re-attaches (it closes itself after
			// 15 minutes with nobody watching).
		};
	});

	async function open(): Promise<void> {
		if (!term) return;
		phase = 'opening';
		message = null;
		term.reset();
		try {
			const response = await fetch(`${base}/exec${replicaQuery(replica)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					shell,
					user,
					cols: clamp(term.cols, 10, 500),
					rows: clamp(term.rows, 4, 200)
				})
			});
			const body = (await response.json().catch(() => ({}))) as {
				exec?: { execId: string };
				message?: string;
			};
			if (!response.ok || !body.exec)
				throw new Error(body.message ?? `The node answered ${response.status}.`);
			const opened: StoredShell = { execId: body.exec.execId, replica, shell, user };
			saveShell(slug, opened);
			attach(opened);
			term.focus();
		} catch (error) {
			phase = 'error';
			message = error instanceof Error ? error.message : 'The shell could not be opened.';
		}
	}

	function attach(session: StoredShell): void {
		events?.close();
		current = session;
		phase = 'opening';
		const source = new EventSource(
			`${base}/exec/${session.execId}/stream${replicaQuery(session.replica)}`
		);
		events = source;
		source.onopen = () => {
			if (events !== source) return;
			phase = 'live';
			message = null;
			term?.focus();
		};
		source.addEventListener('data', (event) => {
			const text = atob((event as MessageEvent<string>).data);
			const bytes = new Uint8Array(text.length);
			for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index);
			term?.write(bytes);
		});
		source.addEventListener('exit', (event) => {
			const code = (JSON.parse((event as MessageEvent<string>).data) as { code: number }).code;
			finish(code === 0 ? null : `The shell exited with code ${code}.`, code);
		});
		source.onerror = () => {
			if (events !== source) return;
			// EventSource retries on its own (resuming from Last-Event-ID); CLOSED means the server
			// refused, which for a shell means it is gone.
			if (source.readyState === EventSource.CLOSED)
				finish('The shell session is no longer available.', null);
			else phase = 'reconnecting';
		};
	}

	function finish(reason: string | null, code: number | null): void {
		events?.close();
		events = null;
		phase = 'ended';
		message = reason;
		saveShell(slug, null);
		if (code === 126 || code === 127)
			message = `${reason} The image may not include ${shell === 'auto' ? 'a shell (/bin/sh)' : shell}; distroless images have none.`;
		term?.write(`\r\n\x1b[2m[${reason ?? 'session ended'}]\x1b[0m\r\n`);
	}

	async function end(): Promise<void> {
		const session = current;
		if (!session) return;
		events?.close();
		events = null;
		saveShell(slug, null);
		await fetch(`${base}/exec/${session.execId}${replicaQuery(session.replica)}`, {
			method: 'DELETE'
		}).catch(() => undefined);
		phase = 'ended';
		message = null;
		term?.write('\r\n\x1b[2m[session closed]\x1b[0m\r\n');
	}

	async function restart(): Promise<void> {
		if (current && (phase === 'live' || phase === 'reconnecting')) await end();
		await open();
	}

	/** Keystrokes are batched for a few ms and sent in order, as raw bytes. */
	const encoder = new TextEncoder();
	function send(data: string, binary = false): void {
		if (!current || phase === 'ended') return;
		// `onBinary` hands over one byte per character; everything else is text.
		pending.push(
			binary ? Uint8Array.from(data, (char) => char.charCodeAt(0) & 0xff) : encoder.encode(data)
		);
		if (flushTimer) return;
		flushTimer = setTimeout(() => {
			flushTimer = null;
			const chunks = pending;
			pending = [];
			const session = current;
			if (!session || chunks.length === 0) return;
			const body = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.length;
			}
			sending = sending.then(() =>
				fetch(`${base}/exec/${session.execId}/input${replicaQuery(session.replica)}`, {
					method: 'POST',
					headers: { 'content-type': 'application/octet-stream' },
					body
				}).catch(() => undefined)
			);
		}, 6);
	}

	function queueResize(cols: number, rows: number): void {
		if (resizeTimer) clearTimeout(resizeTimer);
		resizeTimer = setTimeout(() => {
			const session = current;
			if (!session || phase === 'ended') return;
			void fetch(`${base}/exec/${session.execId}/resize${replicaQuery(session.replica)}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ cols: clamp(cols, 10, 500), rows: clamp(rows, 4, 200) })
			}).catch(() => undefined);
		}, 120);
	}

	// Fullscreen changes the terminal's box; refit once the layout settles.
	$effect(() => {
		void fullscreen;
		untrack(() => requestAnimationFrame(() => fit?.fit()));
	});

	const statusLabel = $derived(
		{
			loading: 'Loading…',
			idle: 'Not connected',
			opening: 'Connecting…',
			live: 'Connected',
			reconnecting: 'Reconnecting…',
			ended: 'Ended',
			error: 'Failed'
		}[phase]
	);
	const statusDot = $derived(
		phase === 'live'
			? 'bg-success'
			: phase === 'reconnecting' || phase === 'opening' || phase === 'loading'
				? 'bg-warning'
				: phase === 'error'
					? 'bg-destructive'
					: 'bg-muted-foreground'
	);
</script>

<svelte:window
	onkeydown={(event) => {
		if (fullscreen && event.key === 'Escape' && event.shiftKey) fullscreen = false;
	}}
/>

<div
	class={fullscreen
		? 'fixed inset-0 z-50 flex flex-col gap-3 bg-background p-3'
		: 'flex flex-col gap-3'}
>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div class="flex flex-wrap items-center gap-3">
			<ReplicaPicker targets={targetsQuery.data?.targets ?? []} bind:replica />
			<label class="flex items-center gap-2 text-sm">
				<span class="text-muted-foreground">Shell</span>
				<NativeSelect.Root bind:value={shell} class="h-8">
					<NativeSelect.Option value="auto">auto (bash, else sh)</NativeSelect.Option>
					<NativeSelect.Option value="/bin/bash">/bin/bash</NativeSelect.Option>
					<NativeSelect.Option value="/bin/sh">/bin/sh</NativeSelect.Option>
					<NativeSelect.Option value="/bin/ash">/bin/ash</NativeSelect.Option>
				</NativeSelect.Root>
			</label>
			<label class="flex items-center gap-2 text-sm">
				<span class="text-muted-foreground">User</span>
				<NativeSelect.Root bind:value={user} class="h-8">
					<NativeSelect.Option value="default">image default</NativeSelect.Option>
					<NativeSelect.Option value="root">root</NativeSelect.Option>
				</NativeSelect.Root>
			</label>
		</div>
		<div class="flex items-center gap-2">
			<span class="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite">
				{#if phase === 'opening' || phase === 'reconnecting'}
					<Spinner class="size-3" />
				{:else}
					<span class="size-1.5 rounded-full {statusDot}"></span>
				{/if}
				{statusLabel}
			</span>
			{#if phase === 'live' || phase === 'reconnecting'}
				<Button variant="outline" size="sm" onclick={end}>
					<SquareIcon />
					End
				</Button>
				<Button
					variant="outline"
					size="sm"
					onclick={restart}
					title="Close this shell and open a new one with these settings"
				>
					<PlusIcon />
					New
				</Button>
			{:else if phase !== 'loading' && phase !== 'opening'}
				<Button size="sm" onclick={open}>
					<PlayIcon />
					Start shell
				</Button>
			{/if}
			<Button
				variant="ghost"
				size="icon-sm"
				onclick={() => (fullscreen = !fullscreen)}
				title={fullscreen ? 'Exit full screen (Shift+Esc)' : 'Full screen'}
			>
				{#if fullscreen}<Minimize2Icon />{:else}<Maximize2Icon />{/if}
			</Button>
		</div>
	</div>

	{#if message}
		<p class="text-sm {phase === 'error' ? 'text-destructive' : 'text-muted-foreground'}">
			{message}
		</p>
	{/if}

	<div
		class="min-h-0 overflow-hidden rounded-xl border bg-[#0b0d10] p-2 shadow-xs {fullscreen
			? 'flex-1'
			: 'h-[min(70vh,640px)]'}"
	>
		<div bind:this={host} class="size-full" role="application" aria-label="Container shell"></div>
	</div>
	<p class="text-xs text-muted-foreground">
		Runs inside the container with its own limits: no added capabilities, a read-only root
		filesystem and the same network. Opening a shell is recorded in the audit log; what you type is
		not.
	</p>
</div>
