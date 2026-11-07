<script lang="ts">
	import ClockIcon from '@lucide/svelte/icons/clock';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import PlayIcon from '@lucide/svelte/icons/play';
	import SendIcon from '@lucide/svelte/icons/send';
	import SnowflakeIcon from '@lucide/svelte/icons/snowflake';
	import {
		functionRequestMethods,
		type FunctionInvokeResult,
		type FunctionScheduledResult,
		type FunctionView
	} from '@skiff/contracts';
	import { runAction } from '#lib/actions.js';
	import { runNodeTask } from '#lib/node-tasks.js';
	import CopyButton from '#lib/components/skiff/CopyButton.svelte';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import StatusBadge from '#lib/components/skiff/StatusBadge.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import { formatBytes, formatRelative } from '../../_lib/format.js';
	import { prettyBody, statusTone } from './test-request.js';

	/**
	 * A function's Test tab (D124): send one HTTP request to the live host, run a cron now, or drop
	 * a message into a queue it consumes. Everything runs on the function's node, against the
	 * production deployment, so it has the same side effects as real traffic.
	 */
	let {
		view,
		cronNext,
		hasHost,
		canDeploy,
		canSendQueue
	}: {
		view: FunctionView | null;
		cronNext: Record<string, string | null>;
		hasHost: boolean;
		canDeploy: boolean;
		canSendQueue: boolean;
	} = $props();

	// --- HTTP request --------------------------------------------------------------------------

	let method = $state<(typeof functionRequestMethods)[number]>('GET');
	let path = $state('/');
	let headers = $state('');
	let body = $state('');
	let sending = $state(false);
	let response = $state<FunctionInvokeResult | null>(null);
	const hasBody = $derived(method !== 'GET' && method !== 'HEAD');
	const responseType = $derived(
		response?.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? null
	);

	async function send(event: SubmitEvent) {
		event.preventDefault();
		sending = true;
		const task = await runNodeTask<'function.invoke'>('?/invoke', {
			method,
			path,
			headers,
			...(hasBody ? { body } : {})
		});
		sending = false;
		if (task?.result) response = task.result;
	}

	function useJson() {
		if (!/^content-type\s*:/im.test(headers))
			headers = `${headers.trim() ? `${headers.trim()}\n` : ''}Content-Type: application/json`;
		if (!body.trim()) body = '{\n  \n}';
	}

	// --- cron ----------------------------------------------------------------------------------

	const crons = $derived(view?.triggers.crons ?? []);
	let cronRunning = $state<string | null>(null);
	let cronResults = $state<Record<string, FunctionScheduledResult & { at: string }>>({});

	async function runCron(cron: string) {
		cronRunning = cron;
		const task = await runNodeTask<'function.scheduled'>('?/runCron', { cron });
		cronRunning = null;
		if (task?.result) cronResults = { ...cronResults, [cron]: { ...task.result, at: new Date().toISOString() } };
	}

	// --- queues --------------------------------------------------------------------------------

	const queues = $derived(view?.triggers.queues ?? []);
	let queue = $state('');
	let queueType = $state<'json' | 'text'>('json');
	let queueBody = $state('{\n  "test": true\n}');
	let queueCount = $state('1');
	let queueSending = $state(false);

	$effect(() => {
		if (!queue && queues[0]) queue = queues[0].queue;
	});

	async function sendQueue(event: SubmitEvent) {
		event.preventDefault();
		queueSending = true;
		await runAction('?/sendQueueMessage', { queue, contentType: queueType, body: queueBody, count: queueCount }, { apply: false });
		queueSending = false;
	}

	const ms = (value: number) => (value >= 1000 ? `${(value / 1000).toFixed(2)} s` : `${Math.round(value)} ms`);
</script>

{#if !hasHost}
	<EmptyState
		icon={PlayIcon}
		title="Nothing to test yet"
		description="Deploy the function first; test requests run against its live host."
	/>
{:else}
	<div class="space-y-5">
		<Panel
			title="Send a request"
			icon={SendIcon}
			description="Sent straight to the production host's socket on its node, so domains, access rules and the cache are skipped. It runs your real code: writes happen."
		>
			{#if !canDeploy}
				<Notice tone="info">Sending test requests needs the <code class="font-mono">deployment:create</code> permission.</Notice>
			{:else}
				<form class="space-y-4" onsubmit={send}>
					<div class="flex gap-2">
						<NativeSelect.Root bind:value={method} aria-label="Method" class="w-28 font-mono text-sm">
							{#each functionRequestMethods as item (item)}
								<NativeSelect.Option value={item}>{item}</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
						<Input bind:value={path} aria-label="Path" placeholder="/api/hello?name=skiff" spellcheck="false" class="flex-1 font-mono text-sm" required />
						<Button type="submit" disabled={sending}>
							{#if sending}<Spinner />{:else}<SendIcon />{/if}
							Send
						</Button>
					</div>
					<div class="grid gap-4 lg:grid-cols-2">
						<Field.Field>
							<Field.Label for="test-headers">Headers</Field.Label>
							<Textarea id="test-headers" bind:value={headers} rows={hasBody ? 6 : 3} placeholder={'Authorization: Bearer …\nAccept: application/json'} spellcheck="false" class="font-mono text-xs" />
							<Field.Description>One <code class="font-mono">Name: value</code> per line.</Field.Description>
						</Field.Field>
						{#if hasBody}
							<Field.Field>
								<div class="flex items-center justify-between">
									<Field.Label for="test-body">Body</Field.Label>
									<Button type="button" variant="link" size="sm" class="h-auto p-0 text-xs" onclick={useJson}>JSON</Button>
								</div>
								<Textarea id="test-body" bind:value={body} rows={6} spellcheck="false" class="font-mono text-xs" />
							</Field.Field>
						{/if}
					</div>
				</form>

				{#if response}
					{@const text = response.encoding === 'utf8' ? prettyBody(response.body, responseType) : response.body}
					<div class="mt-5 space-y-3 rounded-lg border p-3">
						<div class="flex flex-wrap items-center gap-2 text-sm">
							<StatusBadge status={String(response.status)} label="{response.status} {response.statusText}" tone={statusTone(response.status)} />
							<span class="font-mono text-xs text-muted-foreground tabular-nums">{ms(response.durationMs)}</span>
							<span class="font-mono text-xs text-muted-foreground">{formatBytes(response.size)}</span>
							{#if response.coldStart}
								<Badge variant="outline"><SnowflakeIcon />cold start</Badge>
							{/if}
							<span class="ml-auto"><CopyButton value={response.body} label="body" /></span>
						</div>
						<details>
							<summary class="cursor-pointer text-xs text-muted-foreground">{response.headers.length} response headers</summary>
							<dl class="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 font-mono text-xs">
								{#each response.headers as [name, value], index (index)}
									<dt class="text-muted-foreground">{name}</dt>
									<dd class="break-all">{value}</dd>
								{/each}
							</dl>
						</details>
						{#if response.size === 0}
							<p class="text-xs text-muted-foreground">Empty body.</p>
						{:else}
							<pre class="max-h-[50svh] overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap">{text}</pre>
						{/if}
						{#if response.encoding === 'base64'}
							<p class="text-xs text-muted-foreground">Binary response, shown as base64.</p>
						{/if}
						{#if response.truncated}
							<p class="text-xs text-muted-foreground">Showing the first 256 KiB of {formatBytes(response.size)}.</p>
						{/if}
					</div>
				{/if}
			{/if}
			{#snippet footer()}
				Test requests are not counted in Invocations (those come from the edge's access log); console output lands in Logs as usual.
			{/snippet}
		</Panel>

		<div class="grid items-start gap-5 xl:grid-cols-2">
			<Panel title="Cron triggers" icon={ClockIcon} count={crons.length} description="Run scheduled() now with the cron as controller.cron. The regular schedule is unaffected." flush>
				{#if crons.length === 0}
					<EmptyState icon={ClockIcon} title="No crons" description={'Add "triggers": { "crons": ["*/5 * * * *"] } to wrangler.jsonc and deploy.'} />
				{:else}
					<ul class="divide-y">
						{#each crons as cron (cron)}
							{@const result = cronResults[cron]}
							<li class="space-y-2 px-4 py-3">
								<div class="flex items-center justify-between gap-3">
									<div class="min-w-0">
										<code class="font-mono text-sm">{cron}</code>
										<p class="text-xs text-muted-foreground">
											Next run {cronNext[cron] ? formatRelative(cronNext[cron]!) : 'unknown'} (UTC)
										</p>
									</div>
									{#if canDeploy}
										<Button variant="outline" size="sm" disabled={cronRunning !== null} onclick={() => runCron(cron)}>
											{#if cronRunning === cron}<Spinner />{:else}<PlayIcon />{/if}
											Run now
										</Button>
									{/if}
								</div>
								{#if result}
									<div class="flex flex-wrap items-center gap-2 text-xs">
										<StatusBadge
											status={result.error ? 'failed' : 'ok'}
											label={result.error ? `Failed (${result.status})` : 'Completed'}
											tone={result.error ? 'danger' : 'success'}
										/>
										<span class="font-mono text-muted-foreground tabular-nums">{ms(result.durationMs)}</span>
										{#if result.coldStart}<Badge variant="outline"><SnowflakeIcon />cold start</Badge>{/if}
										<span class="text-muted-foreground">{formatRelative(result.at)}</span>
									</div>
									{#if result.error}
										<p class="font-mono text-xs break-all text-destructive">{result.error}</p>
									{/if}
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</Panel>

			<Panel title="Queue consumers" icon={InboxIcon} count={queues.length} description="Drop a message into a queue this function consumes; it arrives in the next batch of queue().">
				{#if queues.length === 0}
					<EmptyState icon={InboxIcon} title="No queue consumers" description="Add queues.consumers to wrangler.jsonc and attach a broker to consume queues." />
				{:else if !canSendQueue}
					<Notice tone="info">Sending test messages needs the <code class="font-mono">broker:update</code> permission.</Notice>
				{:else}
					<form class="space-y-4" onsubmit={sendQueue}>
						<div class="grid gap-4 sm:grid-cols-[1fr_auto_auto]">
							<Field.Field>
								<Field.Label for="queue-target">Queue</Field.Label>
								<NativeSelect.Root id="queue-target" bind:value={queue} class="w-full font-mono text-sm">
									{#each queues as item (item.queue)}
										<NativeSelect.Option value={item.queue}>{item.queue} · {item.broker}</NativeSelect.Option>
									{/each}
								</NativeSelect.Root>
							</Field.Field>
							<Field.Field>
								<Field.Label for="queue-type">Type</Field.Label>
								<NativeSelect.Root id="queue-type" bind:value={queueType}>
									<NativeSelect.Option value="json">JSON</NativeSelect.Option>
									<NativeSelect.Option value="text">Text</NativeSelect.Option>
								</NativeSelect.Root>
							</Field.Field>
							<Field.Field>
								<Field.Label for="queue-count">Copies</Field.Label>
								<Input id="queue-count" type="number" min={1} max={100} bind:value={queueCount} class="w-20 font-mono text-sm" />
							</Field.Field>
						</div>
						<Field.Field>
							<Field.Label for="queue-body">Body</Field.Label>
							<Textarea id="queue-body" bind:value={queueBody} rows={5} spellcheck="false" class="font-mono text-xs" />
						</Field.Field>
						<Button type="submit" variant="outline" disabled={queueSending || !queue}>
							{#if queueSending}<Spinner />{:else}<SendIcon />{/if}
							Send to queue
						</Button>
					</form>
				{/if}
			</Panel>
		</div>
	</div>
{/if}
