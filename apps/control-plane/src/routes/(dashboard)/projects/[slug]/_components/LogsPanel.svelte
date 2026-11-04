<script lang="ts">
	import type { DeploymentView, ProjectView } from '@skiff/core';
	import type { BuildView, LogEventView, LogLevel } from '@skiff/contracts';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import ArrowDownToLineIcon from '@lucide/svelte/icons/arrow-down-to-line';
	import CopyIcon from '@lucide/svelte/icons/copy';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import HammerIcon from '@lucide/svelte/icons/hammer';
	import PauseIcon from '@lucide/svelte/icons/pause';
	import PlayIcon from '@lucide/svelte/icons/play';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SquareTerminalIcon from '@lucide/svelte/icons/square-terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import WifiIcon from '@lucide/svelte/icons/wifi';
	import WifiOffIcon from '@lucide/svelte/icons/wifi-off';
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Separator } from '#lib/components/ui/separator/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Toggle } from '#lib/components/ui/toggle/index.js';
	import * as ToggleGroup from '#lib/components/ui/toggle-group/index.js';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { displayUrl, formatDuration, shortId, shortSha } from '../../../_lib/format.js';

	type Source = 'runtime' | 'build';
	type Phase = 'connecting' | 'live' | 'paused' | 'ended' | 'error';
	type LevelFilter = 'all' | LogLevel;

	let {
		project,
		deployments,
		builds,
		workloadStatus = null,
		workloadDeploymentId = '',
		canRead,
		source = $bindable<Source>('runtime'),
		buildId = $bindable(''),
		deploymentId = $bindable('')
	}: {
		project: ProjectView;
		deployments: DeploymentView[];
		builds: BuildView[];
		workloadStatus?: string | null;
		/** The deployment the workload is actually running; it may differ from production. */
		workloadDeploymentId?: string;
		canRead: boolean;
		source?: Source;
		buildId?: string;
		deploymentId?: string;
	} = $props();

	let events = $state<LogEventView[]>([]);
	let phase = $state<Phase>('connecting');
	let buildStatus = $state<string | null>(null);
	let errorText = $state<string | null>(null);
	let paused = $state(false);
	let autoScroll = $state(true);
	let query = $state('');
	let level = $state<LevelFilter>('all');
	let viewport = $state<HTMLDivElement | null>(null);
	let connection: EventSource | null = null;
	let cursor = $state(0);

	const activeDeploymentId = $derived.by(() => {
		const requested = deploymentId || workloadDeploymentId || project.productionDeploymentId;
		if (requested && deployments.some((deployment) => deployment.id === requested))
			return requested;
		return deployments[0]?.id ?? '';
	});
	const activeBuildId = $derived.by(() => {
		if (buildId && builds.some((build) => build.id === buildId)) return buildId;
		return builds[0]?.id ?? '';
	});
	const activeDeployment = $derived(
		deployments.find((deployment) => deployment.id === activeDeploymentId) ?? null
	);
	const activeBuild = $derived(builds.find((build) => build.id === activeBuildId) ?? null);

	const filtered = $derived.by(() => {
		const needle = query.trim().toLowerCase();
		return events.filter((event) => {
			if (level !== 'all' && event.level !== level) return false;
			if (needle && !event.message.toLowerCase().includes(needle)) return false;
			return true;
		});
	});

	const counts = $derived.by(() => {
		let warn = 0;
		let error = 0;
		for (const event of events) {
			if (event.level === 'warn') warn += 1;
			if (event.level === 'error') error += 1;
		}
		return { warn, error };
	});

	const targetStatus = $derived(
		source === 'build'
			? (buildStatus ?? activeBuild?.status ?? null)
			: activeDeploymentId === workloadDeploymentId
				? (workloadStatus ?? activeDeployment?.status ?? null)
				: (activeDeployment?.status ?? null)
	);
	const live = $derived(phase === 'live');

	$effect(() => {
		if (activeDeploymentId && deploymentId !== activeDeploymentId)
			deploymentId = activeDeploymentId;
	});
	$effect(() => {
		if (activeBuildId && buildId !== activeBuildId) buildId = activeBuildId;
	});

	$effect(() => {
		if (!canRead) return;
		const currentSource = source;
		const currentBuild = activeBuildId;
		const currentDeployment = activeDeploymentId;
		if (currentSource === 'build' && !currentBuild) {
			closeStream();
			events = [];
			phase = 'ended';
			return;
		}
		if (currentSource === 'runtime' && deployments.length === 0) {
			closeStream();
			events = [];
			phase = 'ended';
			return;
		}
		connect(currentSource, currentBuild, currentDeployment);
		return () => closeStream();
	});

	$effect(() => {
		// Depend on the visible list so a filtered append still reaches the bottom.
		const size = filtered.length;
		if (!autoScroll || !viewport || size === 0) return;
		void tick().then(() => {
			if (viewport && autoScroll) viewport.scrollTop = viewport.scrollHeight;
		});
	});

	function connect(nextSource: Source, nextBuild: string, nextDeployment: string): void {
		closeStream();
		events = [];
		cursor = 0;
		errorText = null;
		buildStatus = null;
		phase = 'connecting';
		paused = false;
		const params = new URLSearchParams({ source: nextSource });
		if (nextSource === 'build') params.set('buildId', nextBuild);
		else if (nextDeployment) params.set('deploymentId', nextDeployment);
		const stream = new EventSource(
			`/projects/${encodeURIComponent(project.slug)}/logs/stream?${params.toString()}`
		);
		connection = stream;
		stream.onopen = () => {
			if (connection !== stream) return;
			errorText = null;
			phase = paused ? 'paused' : 'live';
		};
		stream.addEventListener('ready', (message) => {
			if (connection !== stream) return;
			const data = parsePayload(message);
			if (typeof data?.status === 'string') buildStatus = data.status;
			phase = paused ? 'paused' : 'live';
		});
		stream.addEventListener('logs', (message) => {
			if (connection !== stream) return;
			const data = parsePayload(message);
			if (!Array.isArray(data?.events)) return;
			const incoming = data.events as LogEventView[];
			if (data.initial) {
				events = incoming;
			} else if (!paused) {
				const last = events.at(-1)?.seq ?? 0;
				const fresh = incoming.filter((event) => event.seq > last);
				if (fresh.length > 0) events = [...events, ...fresh].slice(-4_000);
			}
			if (typeof data.cursor === 'number') cursor = data.cursor;
			if (!paused) phase = 'live';
		});
		stream.addEventListener('status', (message) => {
			if (connection !== stream) return;
			const data = parsePayload(message);
			if (typeof data?.status === 'string') buildStatus = data.status;
		});
		stream.addEventListener('end', (message) => {
			if (connection !== stream) return;
			const data = parsePayload(message);
			if (typeof data?.status === 'string') buildStatus = data.status;
			phase = 'ended';
			closeStream();
		});
		stream.addEventListener('server-error', (message) => {
			if (connection !== stream) return;
			const data = parsePayload(message);
			errorText = typeof data?.message === 'string' ? data.message : 'The log stream failed.';
			phase = 'error';
		});
		stream.onerror = () => {
			if (connection !== stream) return;
			// EventSource reconnects by itself, and the server sends an SSE id so it resumes at the
			// right cursor. Only surface a message when we were previously connected.
			phase = paused ? 'paused' : 'connecting';
			if (!errorText && events.length > 0) errorText = 'Lost the live tail; retrying…';
		};
	}

	function closeStream(): void {
		if (connection) {
			connection.close();
			connection = null;
		}
	}

	function togglePause(): void {
		if (paused) {
			paused = false;
			// The connection stayed open while paused, so the cursor is current and only new lines
			// appear from here. A closed stream (ended build, dropped connection) reconnects.
			if (connection) phase = 'live';
			else connect(source, activeBuildId, activeDeploymentId);
			return;
		}
		paused = true;
		phase = 'paused';
	}

	function clearLogs(): void {
		events = [];
	}

	function scrollToBottom(): void {
		autoScroll = true;
		if (viewport) viewport.scrollTop = viewport.scrollHeight;
	}

	function download(): void {
		const body = filtered
			.map(
				(event) =>
					`${new Date(event.ts).toISOString()} ${event.level.toUpperCase()} ${event.message}`
			)
			.join('\n');
		const blob = new Blob([`${body}\n`], { type: 'text/plain' });
		const anchor = document.createElement('a');
		anchor.href = URL.createObjectURL(blob);
		anchor.download = `${project.slug}-${source === 'build' ? `build-${shortId(activeBuildId)}` : `deployment-${shortId(activeDeploymentId)}`}.log`;
		anchor.click();
		URL.revokeObjectURL(anchor.href);
	}

	async function copy(): Promise<void> {
		await navigator.clipboard.writeText(
			filtered
				.map(
					(event) =>
						`${new Date(event.ts).toISOString()} ${event.level.toUpperCase()} ${event.message}`
				)
				.join('\n')
		);
		toast.success('Log buffer copied.');
	}

	function parsePayload(message: Event): Record<string, unknown> | null {
		try {
			return JSON.parse((message as MessageEvent).data) as Record<string, unknown>;
		} catch {
			return null;
		}
	}

	function clock(value: number): string {
		const date = new Date(value);
		return `${date.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(date.getMilliseconds()).padStart(3, '0')}`;
	}

	function duration(value: string | null | undefined): string {
		if (!value) return '—';
		const ms = Date.now() - Date.parse(value);
		return ms < 0 ? 'now' : formatDuration(ms / 1000);
	}

	const dot: Record<LogEventView['level'], string> = {
		debug: 'bg-muted-foreground/50',
		info: 'bg-info',
		warn: 'bg-warning',
		error: 'bg-destructive'
	};
	const textTone: Record<LogEventView['level'], string> = {
		debug: 'text-muted-foreground',
		info: 'text-foreground',
		warn: 'text-warning',
		error: 'text-destructive'
	};
</script>

<Card.Root class="gap-0 overflow-hidden py-0">
	<Card.Header class="border-b py-4">
		<div class="flex items-start gap-3">
			<span
				class="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
			>
				<SquareTerminalIcon class="size-4" />
			</span>
			<div class="space-y-1">
				<Card.Title class="flex flex-wrap items-center gap-2">
					Live logs
					{#if live}
						<span
							class="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success"
						>
							<span class="relative grid size-1.5 place-items-center">
								<span class="absolute size-full animate-ping rounded-full bg-success opacity-60"
								></span>
								<span class="relative size-1.5 rounded-full bg-success"></span>
							</span>
							Streaming
						</span>
					{:else if phase === 'paused'}
						<Badge variant="warning"><PauseIcon />Paused</Badge>
					{:else if phase === 'ended'}
						<Badge variant="neutral">Finished</Badge>
					{:else if phase === 'error'}
						<Badge variant="danger">Disconnected</Badge>
					{:else}
						<Badge variant="info">Connecting</Badge>
					{/if}
				</Card.Title>
				<Card.Description>
					Tail deployment output and git build output without refreshing. Lines are drained from the
					node, kept for seven days, and resume from the last cursor after a reconnect.
				</Card.Description>
			</div>
		</div>
		<Card.Action class="self-center">
			<div class="flex items-center gap-2">
				<Button variant="outline" size="sm" onclick={togglePause} disabled={!canRead}>
					{#if paused}<PlayIcon />Resume{:else}<PauseIcon />Pause{/if}
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Download visible logs"
					onclick={download}
					disabled={filtered.length === 0}
				>
					<DownloadIcon />
				</Button>
				<Button
					variant="outline"
					size="icon-sm"
					aria-label="Copy visible logs"
					onclick={copy}
					disabled={filtered.length === 0}
				>
					<CopyIcon />
				</Button>
			</div>
		</Card.Action>
	</Card.Header>

	{#if !canRead}
		<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
			<WifiOffIcon class="size-6 text-muted-foreground" />
			<p class="text-sm font-medium">Logs need the logs:read permission</p>
			<p class="max-w-md text-sm text-muted-foreground">
				Ask an owner or admin for a token that includes log visibility. Deployments and builds are
				otherwise unchanged.
			</p>
		</div>
	{:else if source === 'runtime' && deployments.length === 0}
		<div class="flex flex-col items-center gap-2 px-6 py-16 text-center">
			<RocketIcon class="size-6 text-muted-foreground" />
			<p class="text-sm font-medium">No deployment to tail yet</p>
			<p class="max-w-md text-sm text-muted-foreground">
				Deploy once and runtime output will appear here. Static deployments do not run a process,
				but git build logs are always available under Build logs.
			</p>
		</div>
	{:else}
		<div>
			<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<ToggleGroup.Root
					type="single"
					variant="outline"
					size="sm"
					value={source}
					onValueChange={(value) => value && (source = value as typeof source)}
					aria-label="Log source"
				>
					<ToggleGroup.Item value="runtime"><RocketIcon />Runtime</ToggleGroup.Item>
					<ToggleGroup.Item value="build"><HammerIcon />Build</ToggleGroup.Item>
				</ToggleGroup.Root>

				{#if source === 'runtime'}
					<label class="sr-only" for="log-deployment">Deployment</label>
					<NativeSelect.Root
						id="log-deployment"
						size="sm"
						class="w-auto font-mono text-xs"
						bind:value={deploymentId}
					>
						{#each deployments as deployment (deployment.id)}
							<NativeSelect.Option value={deployment.id}>
								{deployment.shortId}{deployment.isProduction
									? ' · production'
									: ` · ${deployment.environmentSlug}`}{deployment.id === workloadDeploymentId
									? ' · running'
									: ''}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if activeDeployment}
						<a
							href={activeDeployment.previewUrl}
							target="_blank"
							rel="external noreferrer"
							class="hidden max-w-56 truncate font-mono text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline sm:block"
						>
							{displayUrl(activeDeployment.previewUrl)}
						</a>
					{/if}
				{:else}
					<label class="sr-only" for="log-build">Build</label>
					<NativeSelect.Root
						id="log-build"
						size="sm"
						class="w-auto font-mono text-xs"
						bind:value={buildId}
					>
						{#each builds as build (build.id)}
							<NativeSelect.Option value={build.id}>
								{shortId(build.id)} · {build.ref}{build.status === 'building' ? ' · building' : ''}
							</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
					{#if activeBuild}
						<span class="hidden font-mono text-xs text-muted-foreground sm:block">
							{activeBuild.commitSha ? shortSha(activeBuild.commitSha) : 'no commit'} · {duration(
								activeBuild.startedAt
							)}
						</span>
					{/if}
				{/if}

				<div class="ml-auto flex flex-wrap items-center gap-2">
					{#if targetStatus}
						<StatusBadge status={targetStatus} />
					{/if}
					<Button
						variant="ghost"
						size="icon-sm"
						aria-label="Clear the visible log buffer"
						onclick={clearLogs}
						disabled={events.length === 0}
					>
						<TrashIcon />
					</Button>
				</div>
			</div>

			<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
				<InputGroup.Root class="h-7 min-w-40 flex-1">
					<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
					<InputGroup.Input
						class="font-mono text-xs"
						placeholder="Filter lines…"
						autocapitalize="off"
						spellcheck="false"
						bind:value={query}
					/>
				</InputGroup.Root>
				<ToggleGroup.Root
					type="single"
					size="sm"
					value={level}
					onValueChange={(value) => value && (level = value as LevelFilter)}
					aria-label="Log level"
				>
					{#each [{ value: 'all', label: 'All' }, { value: 'info', label: 'Info' }, { value: 'warn', label: `Warn${counts.warn ? ` ${counts.warn}` : ''}` }, { value: 'error', label: `Error${counts.error ? ` ${counts.error}` : ''}` }] as option (option.value)}
						<ToggleGroup.Item value={option.value} class="px-2 text-xs"
							>{option.label}</ToggleGroup.Item
						>
					{/each}
				</ToggleGroup.Root>
				<Separator orientation="vertical" class="data-[orientation=vertical]:h-5" />
				<Toggle
					size="sm"
					class="text-xs"
					pressed={autoScroll}
					onPressedChange={(pressed) => (pressed ? scrollToBottom() : (autoScroll = false))}
				>
					{#if autoScroll}<ActivityIcon />Live edge{:else}<ArrowDownToLineIcon />Follow{/if}
				</Toggle>
			</div>

			<div
				bind:this={viewport}
				class="relative h-[30rem] overflow-auto overscroll-contain bg-muted/30 font-mono text-xs leading-relaxed"
				role="log"
				aria-live="polite"
				aria-label="Live log output"
			>
				{#if phase === 'connecting' && events.length === 0}
					<div class="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
						<Spinner />
						<p class="text-xs">Connecting to the log drain…</p>
					</div>
				{:else if filtered.length === 0}
					<div
						class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground"
					>
						<SquareTerminalIcon class="size-5" />
						{#if source === 'runtime' && project.runtime === 'static'}
							<p class="text-xs">Static deployment — there is no process output to drain.</p>
							<Button variant="outline" size="sm" onclick={() => (source = 'build')}>
								Open build logs
							</Button>
						{:else}
							<p class="text-xs">
								{#if events.length > 0}
									No lines match this filter.
								{:else if source === 'build' && activeBuild && activeBuild.status === 'queued'}
									Queued. Build output appears when a Builder claims the job.
								{:else if source === 'build'}
									This build has no output yet.
								{:else}
									Waiting for output. The app's stdout and stderr are drained here.
								{/if}
							</p>
						{/if}
					</div>
				{:else}
					<div class="py-1">
						{#each filtered as event (event.seq)}
							<div
								class="group grid grid-cols-[6.7rem_0.55rem_minmax(0,1fr)] items-start gap-x-3 px-4 py-0.5 hover:bg-muted"
							>
								<span class="pt-px text-muted-foreground tabular-nums select-none">
									{clock(event.ts)}
								</span>
								<span class="mt-[0.42rem] size-1.5 rounded-full {dot[event.level]}"></span>
								<span class="min-w-0 break-words whitespace-pre-wrap {textTone[event.level]}">
									{#if event.stream === 'stderr'}<span
											class="mr-1.5 rounded bg-destructive/10 px-1 py-px font-semibold text-destructive"
											>err</span
										>{/if}{event.message}
								</span>
							</div>
						{/each}
					</div>
				{/if}
			</div>

			<div
				class="flex flex-wrap items-center gap-x-3 gap-y-1 border-t px-3 py-2 font-mono text-xs text-muted-foreground"
			>
				<span class="inline-flex items-center gap-1.5">
					{#if live}
						<span class="size-1.5 rounded-full bg-success"></span>Live
					{:else if phase === 'ended'}
						<span class="size-1.5 rounded-full bg-muted-foreground"></span>Stream closed
					{:else if phase === 'paused'}
						<span class="size-1.5 rounded-full bg-warning"></span>Paused
					{:else}
						<span class="size-1.5 rounded-full bg-info"></span>Reconnecting
					{/if}
				</span>
				<span>{filtered.length} / {events.length} lines</span>
				{#if cursor}<span class="hidden sm:inline">cursor {cursor}</span>{/if}
				{#if errorText}<span class="text-warning">{errorText}</span>{/if}
				<span class="ml-auto hidden items-center gap-1 sm:inline-flex">
					<WifiIcon class="size-3" /> 7-day retention
				</span>
			</div>
		</div>
	{/if}
</Card.Root>
