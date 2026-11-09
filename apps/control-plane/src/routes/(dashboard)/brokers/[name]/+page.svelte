<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ActivityIcon from '@lucide/svelte/icons/activity';
	import CableIcon from '@lucide/svelte/icons/cable';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import HardDriveIcon from '@lucide/svelte/icons/hard-drive';
	import InboxIcon from '@lucide/svelte/icons/inbox';
	import ListOrderedIcon from '@lucide/svelte/icons/list-ordered';
	import MemoryStickIcon from '@lucide/svelte/icons/memory-stick';
	import EllipsisIcon from '@lucide/svelte/icons/ellipsis';
	import EraserIcon from '@lucide/svelte/icons/eraser';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import SendIcon from '@lucide/svelte/icons/send';
	import Undo2Icon from '@lucide/svelte/icons/undo-2';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import PlugIcon from '@lucide/svelte/icons/plug';
	import SlidersHorizontalIcon from '@lucide/svelte/icons/sliders-horizontal';
	import TerminalIcon from '@lucide/svelte/icons/terminal';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import UnplugIcon from '@lucide/svelte/icons/unplug';
	import { brokerEnvNames, type BrokerCredentials } from '@yoal/contracts';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import DetailList from '#lib/components/yoal/DetailList.svelte';
	import FormDialog from '#lib/components/yoal/FormDialog.svelte';
	import MetricChart from '#lib/components/yoal/MetricChart.svelte';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as InputGroup from '#lib/components/ui/input-group/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import TelemetryOff from '../../_lib/TelemetryOff.svelte';
	import RangePicker from '../../_lib/service/RangePicker.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import CopyValue from '../../_lib/service/CopyValue.svelte';
	import DangerZone from '../../_lib/service/DangerZone.svelte';
	import EnvNames from '../../_lib/service/EnvNames.svelte';
	import { readTab, tabHref, type Stat } from '../../_lib/service/sections.js';
	import {
		formatBytes,
		formatDate,
		formatDateTime,
		formatDuration,
		formatRelative
	} from '../../_lib/format.js';
	import { storagePercent } from '../../databases/_lib/database-series.js';
	import { brokerChart, brokerTotals, streamAgeSeconds } from '../_lib/broker-series.js';
	import { purgeCountdown } from '../../_lib/operations/copy.js';
	import BrokerHeader from '../_lib/BrokerHeader.svelte';
	import PeekSheet from '../_lib/PeekSheet.svelte';
	import { brokerSubnavKey } from '../_lib/subnav.js';
	import { useSubnavLocal } from '#lib/nav/subnav-local.svelte.js';
	import { BROKER_DEFAULT_TAB, BROKER_TABS, type BrokerTab } from '../_lib/broker-tabs.js';
	import type { PageProps } from './$types';

	interface BrokerFormResult {
		message?: string;
		fieldErrors?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const errors = $derived((form as BrokerFormResult | null)?.fieldErrors ?? {});

	const broker = $derived(data.broker);
	const can = $derived(data.brokerCan);
	const deleted = $derived(broker.deletedAt !== null);
	const nodeLabel = $derived(broker.nodeName ?? broker.nodeId);
	const hostPort = $derived(broker.internalHost.process.split(':').at(-1) ?? '');

	let tab = $state<BrokerTab>(
		readTab(page.url.searchParams.get('tab'), BROKER_TABS, BROKER_DEFAULT_TAB)
	);

	/** Switch sections in place (no reload), keeping `?tab=` deep-linkable. */
	function setTab(next: BrokerTab) {
		tab = next;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only `?tab` changes
		replaceState(tabHref(page.url.pathname + page.url.search, next, BROKER_DEFAULT_TAB), {});
	}

	/** The sidebar lists the sections; in-place ones switch here without a page load. */
	useSubnavLocal(() => ({
		key: brokerSubnavKey(broker.name),
		active: tab,
		select: (id) => {
			if (!BROKER_TABS.includes(id as BrokerTab)) return false;
			setTab(id as BrokerTab);
			return true;
		}
	}));

	// --- credentials: revealed on demand, audited, never in page data (as D58) ------------------

	let credentials = $state<BrokerCredentials | null>(null);
	let revealing = $state(false);

	async function reveal() {
		revealing = true;
		const outcome = await runAction('?/credentials', {}, { apply: false });
		revealing = false;
		if (outcome.type === 'success')
			credentials =
				(outcome.data as { credentials?: BrokerCredentials } | undefined)?.credentials ?? null;
	}

	// --- attachments -----------------------------------------------------------------------------

	let attachOpen = $state(false);
	let attachPrefix = $state('NATS');

	function detach(project: string) {
		askConfirm({
			title: `Detach ${broker.name} from ${project}?`,
			description:
				'The app restarts without its broker variables. The broker, its streams and stored messages are untouched.',
			confirmLabel: 'Detach',
			tone: 'danger',
			action: '?/detach',
			fields: { project }
		});
	}

	// --- metrics (D123) --------------------------------------------------------------------------

	const numberFormat = new Intl.NumberFormat('en-GB');
	const compactFormat = new Intl.NumberFormat('en-GB', {
		notation: 'compact',
		maximumFractionDigits: 1
	});
	const count = (value: number) =>
		value >= 10_000 ? compactFormat.format(value) : numberFormat.format(Math.round(value));
	const age = (seconds: number) => (seconds <= 0 ? '0s' : formatDuration(seconds));

	const windowFrom = $derived(Date.parse(data.range.from));
	const windowTo = $derived(Date.parse(data.range.to) + 60_000);
	const chart = $derived(
		brokerChart(data.metrics, data.range.interval, { from: windowFrom, to: windowTo })
	);
	const totals = $derived(brokerTotals(data.metrics));
	const chartBuckets = $derived(chart.buckets);
	const latest = $derived(totals.latest);
	const spanNote = $derived(chart.span > 1 ? `, ${chart.spanLabel} buckets` : '');

	const storeBytes = $derived(latest?.storeBytes ?? broker.storeBytes);
	const messagesHeld = $derived(latest?.messages ?? broker.messages);
	const kpis = $derived<Stat[]>([
		{
			label: 'Store',
			icon: HardDriveIcon,
			value: storeBytes === null ? '—' : formatBytes(storeBytes),
			unit: `/ ${formatBytes(broker.storageMb * 1024 * 1024)}`,
			meter: storagePercent(storeBytes, broker.storageMb),
			caption: 'A full store refuses publishes'
		},
		{
			label: 'Messages',
			icon: InboxIcon,
			value: messagesHeld === null ? '—' : count(messagesHeld),
			caption: latest
				? `${count(latest.pending + latest.ackPending)} waiting on consumers`
				: 'held across streams'
		},
		{
			label: 'Connections',
			icon: CableIcon,
			value: latest ? count(latest.connections) : '—',
			caption: latest ? `${count(latest.streams)} streams · ${count(latest.consumers)} consumers` : 'clients'
		},
		{
			label: 'Memory',
			icon: MemoryStickIcon,
			value: latest ? formatBytes(latest.memoryBytes) : '—',
			caption: `of ${broker.memoryMb} MB limit${totals.uptime !== null && totals.uptime < 1 ? ` · up ${(totals.uptime * 100).toFixed(1)}%` : ''}`
		}
	]);

	// --- queues ----------------------------------------------------------------------------------

	const streams = $derived(data.queues?.streams ?? []);
	let expanded = $state<Record<string, boolean>>({});

	// --- queue tools: run by the broker's node (D124) ---------------------------------------------

	const running = $derived(broker.status === 'running' && !deleted);
	const queueNames = $derived(streams.flatMap((stream) => (stream.queue ? [stream.queue] : [])));
	let createQueueOpen = $state(false);
	let sendOpen = $state(false);
	let sendQueue = $state('');
	let sendType = $state<'json' | 'text'>('json');
	let sendBody = $state('{\n  "hello": "world"\n}');
	let redriveOpen = $state(false);
	let redriveFrom = $state('');
	let redriveTo = $state('');
	let peekStream = $state<string | null>(null);
	const peekLabel = $derived(streams.find((stream) => stream.stream === peekStream)?.queue ?? null);

	const sendBodyError = $derived.by(() => {
		if (sendType !== 'json') return '';
		try {
			JSON.parse(sendBody);
			return '';
		} catch {
			return 'Not valid JSON yet. Fix it, or send it as text.';
		}
	});

	function openSend(queue = '') {
		sendQueue = queue || queueNames[0] || '';
		sendOpen = true;
	}

	function openRedrive(from: string) {
		redriveFrom = from;
		redriveTo = from.endsWith('-dlq') ? from.slice(0, -4) : (queueNames.find((name) => name !== from) ?? '');
		redriveOpen = true;
	}

	function purge(stream: { stream: string; queue: string | null; messages: number }) {
		askConfirm({
			title: `Purge ${stream.queue ?? stream.stream}?`,
			description: `Removes all ${count(stream.messages)} messages for good. The stream and its consumers stay, so producers and the consuming function keep working.`,
			confirmLabel: 'Purge messages',
			tone: 'danger',
			typeToConfirm: stream.queue ?? stream.stream,
			action: '?/purgeStream',
			fields: { stream: stream.stream }
		});
	}

	function removeStream(stream: { stream: string; queue: string | null }) {
		askConfirm({
			title: `Delete ${stream.stream}?`,
			description: stream.queue
				? 'The stream, its consumer and every message go. A producer or consumer that uses this queue creates an empty stream again on its next use.'
				: 'The stream, its consumers and every message go. Apps that use it must create it again.',
			confirmLabel: 'Delete stream',
			tone: 'danger',
			typeToConfirm: stream.queue ?? stream.stream,
			action: '?/deleteStream',
			fields: { stream: stream.stream }
		});
	}

	// --- settings --------------------------------------------------------------------------------

	let resizeOpen = $state(false);
</script>

<svelte:head>
	<title>{broker.name} · Queues · Yoal</title>
</svelte:head>

<div class="space-y-6">
	<BrokerHeader {broker} {can} />

	{#if page.url.searchParams.get('created') === '1' && broker.status === 'pending'}
		<Notice tone="info" title="Starting on {nodeLabel}">
			The node pulls the {broker.engineLabel} image and starts the container on its next reconcile. This
			page shows <em>running</em> once the server answers.
		</Notice>
	{/if}
	{#if broker.message && !deleted}
		<Notice tone="warning" title="Broker message">{broker.message}</Notice>
	{/if}
	{#if deleted}
		<Notice tone="warning" title="In the trash">
			The container is stopped; its streams stay on {nodeLabel} until
			<time datetime={broker.purgeAt}>{purgeCountdown(broker.purgeAt)}</time>. Restore it from the
			header.
		</Notice>
	{/if}

	{#if tab === 'overview'}
		{#if !deleted}
			<StatStrip label="Broker summary" stats={kpis} />
		{/if}
		<div class="grid items-start gap-5 xl:grid-cols-5">
			<Panel
				title="Connection"
				icon={CableIcon}
				description="Attached apps receive these as environment variables at start-up."
				class="xl:col-span-3"
			>
				{#snippet actions()}
					{#if can.credentials && !deleted}
						{#if credentials}
							<Button variant="outline" size="sm" onclick={() => (credentials = null)}>
								<EyeOffIcon />Hide credentials
							</Button>
						{:else}
							<Button variant="outline" size="sm" onclick={reveal} disabled={revealing}>
								{#if revealing}<Spinner />{:else}<KeyRoundIcon />{/if}
								Reveal credentials
							</Button>
						{/if}
					{/if}
				{/snippet}

				<DetailList>
					<dt>Protocol</dt>
					<dd class="text-xs">{broker.protocol}</dd>
					<dt>Process apps</dt>
					<dd><CopyValue value={broker.internalHost.process} label="host" /></dd>
					<dt>Container apps</dt>
					<dd><CopyValue value={broker.internalHost.container} label="host" /></dd>
					<dt>User</dt>
					<dd><CopyValue value={broker.username} label="user" /></dd>
					{#if credentials}
						<dt>URL</dt>
						<dd>
							<CopyValue
								value={credentials.url}
								label="URL"
								secret
								display={credentials.url.replace(
									`:${encodeURIComponent(credentials.password)}@`,
									':••••••@'
								)}
							/>
						</dd>
						<dt>Password</dt>
						<dd><CopyValue value={credentials.password} label="password" secret /></dd>
					{/if}
				</DetailList>

				{#if credentials}
					<div class="mt-4 space-y-3">
						{#each Object.entries(credentials.connectionSnippets) as [client, snippet] (client)}
							<CodeBlock code={snippet} label={client} />
						{/each}
						<p class="text-xs text-muted-foreground">This reveal was recorded in the audit log.</p>
					</div>
				{/if}

				<div class="mt-4 space-y-2 rounded-lg border bg-muted/30 p-3">
					<p class="text-xs text-muted-foreground">
						An attached app receives these, with its prefix (default <code class="font-mono"
							>NATS</code
						>):
					</p>
					<div class="flex flex-wrap gap-1.5">
						{#each brokerEnvNames('NATS') as name (name)}
							<Badge variant="secondary" class="font-mono font-normal">{name}</Badge>
						{/each}
					</div>
				</div>

				{#snippet footer()}
					<span class="flex items-start gap-2">
						<TerminalIcon class="mt-0.5 size-3.5 shrink-0" />
						<span>
							Private to {nodeLabel}: from elsewhere, tunnel with
							<code class="font-mono">ssh -L {hostPort}:127.0.0.1:{hostPort} &lt;node&gt;</code>.
							{#if !can.credentials}
								Revealing the password needs <code class="font-mono">broker:credentials</code>.
							{/if}
						</span>
					</span>
				{/snippet}
			</Panel>

			<Panel title="Resources" icon={SlidersHorizontalIcon} class="xl:col-span-2">
				{#snippet actions()}
					{#if can.update && !deleted}
						<Button variant="outline" size="sm" onclick={() => (resizeOpen = true)}>Resize</Button>
					{/if}
				{/snippet}
				<DetailList>
					<dt>Engine</dt>
					<dd class="text-xs">{broker.engineLabel} {broker.version}</dd>
					<dt>Memory</dt>
					<dd class="font-mono text-xs tabular-nums">{broker.memoryMb} MB</dd>
					<dt>CPU</dt>
					<dd class="font-mono text-xs tabular-nums">{broker.cpus} vCPU</dd>
					<dt>Message store</dt>
					<dd class="font-mono text-xs tabular-nums">{broker.storageMb} MB cap</dd>
					<dt>Data</dt>
					<dd class="text-xs">
						{broker.disk ? `Disk ${broker.disk.name} (${broker.disk.tier})` : 'System disk'}
					</dd>
					<dt>Features</dt>
					<dd class="flex flex-wrap justify-end gap-1">
						{#if broker.capabilities.streams}<Badge variant="outline">Streams</Badge>{/if}
						{#if broker.capabilities.workQueues}<Badge variant="outline">Work queues</Badge>{/if}
						{#if broker.capabilities.keyValue}<Badge variant="outline">Key-value</Badge>{/if}
						{#if broker.capabilities.requestReply}<Badge variant="outline">Request/reply</Badge
							>{/if}
					</dd>
				</DetailList>
			</Panel>
		</div>

		<Panel
			title="Attached projects"
			icon={PlugIcon}
			count={broker.attachments.length}
			description="Each attached project runs on {nodeLabel} and gets the broker's URL and credentials at start-up."
			flush
		>
			{#snippet actions()}
				{#if can.attach && !deleted && data.projects.length > 0}
					<Button variant="outline" size="sm" onclick={() => (attachOpen = true)}
						><PlugIcon />Attach</Button
					>
				{/if}
			{/snippet}
			{#if broker.attachments.length === 0}
				<EmptyState
					icon={PlugIcon}
					title="Not attached"
					description="Attach a process or container project; it is placed next to this broker on its next deploy."
				/>
			{:else}
				<ul class="divide-y">
					{#each broker.attachments as attachment (attachment.projectId)}
						<li class="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
							<div class="flex min-w-0 items-center gap-3">
								<FolderKanbanIcon class="size-4 text-muted-foreground" />
								<a
									href={resolve('/(dashboard)/projects/[slug]', { slug: attachment.projectSlug })}
									class="font-mono text-sm font-medium underline-offset-4 hover:underline"
									>{attachment.projectSlug}</a
								>
								<EnvNames names={attachment.envNames} />
							</div>
							<div class="flex items-center gap-2">
								<span class="text-xs text-muted-foreground"
									>since {formatDate(attachment.createdAt)}</span
								>
								{#if can.attach}
									<Button variant="ghost" size="sm" onclick={() => detach(attachment.projectSlug)}>
										<UnplugIcon />Detach
									</Button>
								{/if}
							</div>
						</li>
					{/each}
				</ul>
			{/if}
		</Panel>
	{:else if tab === 'queues'}
		<!-- Queues ------------------------------------------------------------------------------- -->
		<Panel
			title="Streams"
			icon={ListOrderedIcon}
			count={streams.length}
			description="JetStream streams on this broker. Function queues are YOAL_Q_<queue> streams; apps can create their own."
			flush
		>
			{#snippet actions()}
				{#if data.queues?.at}
					<span class="hidden text-xs text-muted-foreground sm:inline" title={formatDateTime(data.queues.at)}
						>Listed {formatRelative(data.queues.at)}</span
					>
				{/if}
				{#if can.update && running}
					<Button variant="outline" size="sm" onclick={() => openSend()}><SendIcon />Send message</Button>
					<Button variant="outline" size="sm" onclick={() => (createQueueOpen = true)}><PlusIcon />New queue</Button>
				{/if}
			{/snippet}
			{#if !data.queues?.at}
				<EmptyState
					icon={ListOrderedIcon}
					title="No listing yet"
					description={deleted
						? 'The broker is stopped, so its node is not sampling it.'
						: 'The node lists streams about a minute after the broker starts.'}
				/>
			{:else if streams.length === 0}
				<EmptyState
					icon={InboxIcon}
					title="No streams"
					description="A function queue creates its stream on first use; attached apps can create streams with any NATS client."
				/>
			{:else}
				{#if data.queues.truncated}
					<div class="px-4 pt-3">
						<Notice tone="info">
							This broker has more streams than the listing keeps; the first {streams.length} by name
							are shown.
						</Notice>
					</div>
				{/if}
				<Table.Root>
					<Table.Header>
						<Table.Row>
							<Table.Head class="pl-4">Stream</Table.Head>
							<Table.Head class="text-right">Messages</Table.Head>
							<Table.Head class="hidden text-right sm:table-cell">Bytes</Table.Head>
							<Table.Head class="hidden text-right md:table-cell">Consumers</Table.Head>
							<Table.Head class="text-right">Pending</Table.Head>
							<Table.Head class="hidden text-right md:table-cell">Awaiting ack</Table.Head>
							<Table.Head class="hidden text-right lg:table-cell">Redelivered</Table.Head>
							<Table.Head class="text-right">Oldest</Table.Head>
							<Table.Head class="w-10 pr-4"><span class="sr-only">Actions</span></Table.Head>
						</Table.Row>
					</Table.Header>
					<Table.Body>
						{#each streams as stream (stream.stream)}
							{@const oldest = stream.messages > 0 ? streamAgeSeconds(stream.firstAt, data.queues.at) : null}
							{@const open = expanded[stream.stream] ?? false}
							<Table.Row>
								<Table.Cell class="pl-4">
									<div class="flex items-center gap-2">
										{#if stream.consumers.length > 0}
											<Button
												variant="ghost"
												size="icon"
												class="size-6"
												aria-expanded={open}
												aria-label="{open ? 'Hide' : 'Show'} consumers of {stream.stream}"
												onclick={() => (expanded = { ...expanded, [stream.stream]: !open })}
											>
												<ChevronRightIcon class="size-4 transition-transform {open ? 'rotate-90' : ''}" />
											</Button>
										{:else}
											<span class="size-6"></span>
										{/if}
										<div class="min-w-0">
											<span class="font-mono text-sm font-medium">{stream.queue ?? stream.stream}</span>
											<p class="truncate text-xs text-muted-foreground">
												{#if stream.queue}queue · {stream.stream}{:else}{stream.subjects.join(', ') || 'no subjects'}{/if}
												· {stream.retention}{stream.storage === 'memory' ? ' · memory' : ''}
											</p>
										</div>
									</div>
								</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">{count(stream.messages)}</Table.Cell>
								<Table.Cell class="hidden text-right font-mono text-xs tabular-nums sm:table-cell">
									{formatBytes(stream.bytes)}{#if stream.maxBytes}<span class="text-muted-foreground"> / {formatBytes(stream.maxBytes)}</span>{/if}
								</Table.Cell>
								<Table.Cell class="hidden text-right font-mono text-xs tabular-nums md:table-cell">{stream.consumerCount}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">{count(stream.pending)}</Table.Cell>
								<Table.Cell class="hidden text-right font-mono text-xs tabular-nums md:table-cell">{count(stream.ackPending)}</Table.Cell>
								<Table.Cell class="hidden text-right font-mono text-xs tabular-nums lg:table-cell">{count(stream.redelivered)}</Table.Cell>
								<Table.Cell class="text-right font-mono text-xs tabular-nums">{oldest === null ? '—' : age(oldest)}</Table.Cell>
								<Table.Cell class="pr-4">
									{#if can.update && running}
										<DropdownMenu.Root>
											<DropdownMenu.Trigger>
												{#snippet child({ props })}
													<Button {...props} variant="ghost" size="icon" class="size-7" aria-label="Actions for {stream.queue ?? stream.stream}">
														<EllipsisIcon class="size-4" />
													</Button>
												{/snippet}
											</DropdownMenu.Trigger>
											<DropdownMenu.Content align="end" class="w-52">
												<DropdownMenu.Item onSelect={() => (peekStream = stream.stream)}><EyeIcon />Peek messages</DropdownMenu.Item>
												{#if stream.queue}
													<DropdownMenu.Item onSelect={() => openSend(stream.queue ?? '')}><SendIcon />Send test message</DropdownMenu.Item>
													<DropdownMenu.Item onSelect={() => openRedrive(stream.queue ?? '')} disabled={stream.messages === 0}>
														<Undo2Icon />Move messages to…
													</DropdownMenu.Item>
												{/if}
												{#if can.delete}
													<DropdownMenu.Separator />
													<DropdownMenu.Item variant="destructive" onSelect={() => purge(stream)} disabled={stream.messages === 0}>
														<EraserIcon />Purge messages
													</DropdownMenu.Item>
													<DropdownMenu.Item variant="destructive" onSelect={() => removeStream(stream)}>
														<TrashIcon />Delete stream
													</DropdownMenu.Item>
												{/if}
											</DropdownMenu.Content>
										</DropdownMenu.Root>
									{/if}
								</Table.Cell>
							</Table.Row>
							{#if open}
								{#each stream.consumers as consumer (consumer.name)}
									<Table.Row class="bg-muted/30">
										<Table.Cell class="pl-12">
											<span class="font-mono text-xs">{consumer.name}</span>
											<p class="text-xs text-muted-foreground">
												{consumer.waiting} waiting pull{consumer.waiting === 1 ? '' : 's'} · last delivery {consumer.lastDeliveredAt
													? formatRelative(consumer.lastDeliveredAt)
													: 'never'}
											</p>
										</Table.Cell>
										<Table.Cell></Table.Cell>
										<Table.Cell class="hidden sm:table-cell"></Table.Cell>
										<Table.Cell class="hidden md:table-cell"></Table.Cell>
										<Table.Cell class="text-right font-mono text-xs tabular-nums">{count(consumer.pending)}</Table.Cell>
										<Table.Cell class="hidden text-right font-mono text-xs tabular-nums md:table-cell">{count(consumer.ackPending)}</Table.Cell>
										<Table.Cell class="hidden text-right font-mono text-xs tabular-nums lg:table-cell">{count(consumer.redelivered)}</Table.Cell>
										<Table.Cell></Table.Cell>
										<Table.Cell class="pr-4"></Table.Cell>
									</Table.Row>
								{/each}
							{/if}
						{/each}
					</Table.Body>
				</Table.Root>
			{/if}
			{#snippet footer()}
				Pending is what consumers have not been handed yet; awaiting ack was delivered and is still being
				processed. Work-queue streams drop a message once it is acknowledged. Queue tools run on {nodeLabel},
				so changes show here straight away; the rest of the listing refreshes once a minute.
			{/snippet}
		</Panel>
	{:else if tab === 'metrics'}
		<!-- Metrics ------------------------------------------------------------------------------- -->
		<div class="flex flex-wrap items-end justify-between gap-3">
			<div>
				<h2 class="text-base font-semibold">Last {data.range.label}</h2>
				<p class="text-sm text-muted-foreground">Sampled once a minute by the node's agent.</p>
			</div>
			<RangePicker
				ranges={data.ranges}
				current={data.range.key}
				links={data.rangeLinks}
				tab="metrics"
			/>
		</div>

		{#if !data.telemetryAvailable}
			<TelemetryOff
				installed={data.telemetryInstalled}
				reason={data.telemetryReason}
				subject="Broker stats"
				unaffected="The broker itself is unaffected; the Queues tab still lists streams."
			/>
		{:else if data.metrics.length === 0}
			<EmptyState
				icon={ActivityIcon}
				title="No stats in the last {data.range.label}"
				description={deleted
					? 'The broker is stopped, so its node is not sampling it.'
					: 'Stats arrive about a minute after the broker starts.'}
			/>
		{:else}
			<p class="text-sm text-muted-foreground">
				{count(totals.published)} messages stored · {count(totals.messagesIn)} in / {count(
					totals.messagesOut
				)} out · peak backlog {count(totals.peakBacklog)}{#if totals.slowConsumers > 0}
					· <span class="text-destructive">{count(totals.slowConsumers)} slow consumers cut off</span>{/if}
			</p>
			<div class="grid items-start gap-5 xl:grid-cols-2">
				<Panel title="Store" description="JetStream file store in use.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={formatBytes}
						reference={{ label: 'budget', value: broker.storageMb * 1024 * 1024 }}
						series={[
							{
								label: 'store',
								color: 'var(--color-chart-1)',
								values: chartBuckets.map((bucket) => bucket.storeBytes),
								fill: true
							}
						]}
						label="Message store use over time"
					/>
				</Panel>
				<Panel title="Backlog" description="Messages waiting on consumers{spanNote ? `, peak per ${chart.spanLabel}` : ''}.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={count}
						series={[
							{
								label: 'pending',
								color: 'var(--color-chart-2)',
								values: chartBuckets.map((bucket) => bucket.pending),
								fill: true
							},
							{
								label: 'awaiting ack',
								color: 'var(--color-chart-4)',
								values: chartBuckets.map((bucket) => bucket.ackPending)
							}
						]}
						label="Consumer backlog over time"
					/>
				</Panel>
				<Panel title="Throughput" description="Messages per bucket{spanNote}.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={count}
						series={[
							{
								label: 'stored',
								color: 'var(--color-chart-1)',
								values: chartBuckets.map((bucket) => bucket.published)
							},
							{
								label: 'in',
								color: 'var(--color-chart-2)',
								values: chartBuckets.map((bucket) => bucket.messagesIn)
							},
							{
								label: 'out',
								color: 'var(--color-chart-3)',
								values: chartBuckets.map((bucket) => bucket.messagesOut)
							}
						]}
						label="Messages through the broker over time"
					/>
				</Panel>
				<Panel title="Oldest message" description="Age of the oldest unprocessed message in a consumed queue.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={age}
						series={[
							{
								label: 'oldest',
								color: 'var(--color-chart-5)',
								values: chartBuckets.map((bucket) => bucket.oldestAgeSeconds)
							}
						]}
						label="Oldest message age over time"
					/>
				</Panel>
				<Panel title="Connections" description="Client connections{chart.span > 1 ? `, ${chart.spanLabel} averages` : ''}.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={count}
						series={[
							{
								label: 'connections',
								color: 'var(--color-chart-2)',
								values: chartBuckets.map((bucket) => bucket.connections),
								fill: true
							}
						]}
						label="Client connections over time"
					/>
				</Panel>
				<Panel title="Memory" description="Container memory.">
					<MetricChart
						buckets={chartBuckets}
						from={windowFrom}
						to={windowTo}
						interval={data.range.interval}
						format={formatBytes}
						reference={{ label: 'limit', value: broker.memoryMb * 1024 * 1024 }}
						series={[
							{
								label: 'memory',
								color: 'var(--color-chart-3)',
								values: chartBuckets.map((bucket) => bucket.memoryBytes)
							}
						]}
						label="Container memory over time"
					/>
				</Panel>
			</div>
		{/if}
	{:else if tab === 'settings'}
		<Panel title="Version" icon={SlidersHorizontalIcon}>
			<p class="text-sm text-muted-foreground">
				{broker.engineLabel}
				{broker.version}.
				{#if broker.upgradeVersions.length > 0}
					A newer version is available ({broker.upgradeVersions.join(', ')}); upgrading restarts the
					broker in place and keeps its streams. Downgrades are refused.
				{:else}
					This is the newest version Yoal ships for {broker.engineLabel}.
				{/if}
			</p>
			{#if can.update && !deleted && broker.upgradeVersions.length > 0}
				<form method="POST" action="?/update" class="mt-3 flex flex-wrap items-end gap-2">
					<NativeSelect.Root
						name="version"
						value={broker.upgradeVersions[0]}
						aria-label="Target version"
					>
						{#each broker.upgradeVersions as version (version)}
							<NativeSelect.Option value={version}
								>{broker.engineLabel} {version}</NativeSelect.Option
							>
						{/each}
					</NativeSelect.Root>
					<Button type="submit" size="sm" variant="outline">Upgrade</Button>
				</form>
			{/if}
		</Panel>

		{#if can.delete && !deleted}
			<DangerZone>
				{#snippet description()}
					Delete moves the broker to the trash for {page.data.policies?.trashDays ?? 7} days; its streams
					stay on {nodeLabel} so a restore is lossless. Detach every project first.
				{/snippet}
				<Button
					variant="destructive"
					size="sm"
					onclick={() =>
						askConfirm({
							title: `Delete ${broker.name}?`,
							description:
								broker.attachments.length > 0
									? `It is attached to ${broker.attachments.map((item) => item.projectSlug).join(', ')}. Detach it first.`
									: 'The container stops and the broker moves to the trash.',
							confirmLabel: 'Move to trash',
							tone: 'danger',
							typeToConfirm: broker.name,
							action: '?/delete'
						})}
				>
					<TrashIcon />Delete broker
				</Button>
			</DangerZone>
		{/if}
	{/if}
</div>

{#if can.attach && !deleted}
	<FormDialog
		bind:open={attachOpen}
		icon={PlugIcon}
		title="Attach {broker.name}"
		description="The project's next start gets {attachPrefix ||
			'NATS'}_URL and credentials. It must run on {nodeLabel}; auto placement moves it there on its next deploy."
		action="?/attach"
		submitLabel="Attach"
	>
		<Field.Group>
			<Field.Field data-invalid={errors.project ? true : undefined}>
				<Field.Label for="attach-project">Project</Field.Label>
				<NativeSelect.Root id="attach-project" name="project" class="w-full" required>
					{#each data.projects as project (project.slug)}
						<NativeSelect.Option value={project.slug}
							>{project.name} ({project.runtime})</NativeSelect.Option
						>
					{/each}
				</NativeSelect.Root>
				{#if errors.project}<Field.Error>{errors.project}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.envPrefix ? true : undefined}>
				<Field.Label for="attach-prefix">Env prefix</Field.Label>
				<Input
					id="attach-prefix"
					name="envPrefix"
					bind:value={attachPrefix}
					maxlength={64}
					autocapitalize="characters"
					spellcheck="false"
					class="font-mono text-sm uppercase"
					aria-invalid={errors.envPrefix ? 'true' : undefined}
				/>
				{#if errors.envPrefix}<Field.Error>{errors.envPrefix}</Field.Error>{/if}
			</Field.Field>
			<p class="font-mono text-xs text-muted-foreground">
				{brokerEnvNames((attachPrefix || 'NATS').toUpperCase()).join(' ')}
			</p>
		</Field.Group>
	</FormDialog>
{/if}

{#if can.update && !deleted}
	<FormDialog
		bind:open={resizeOpen}
		icon={SlidersHorizontalIcon}
		title="Resize {broker.name}"
		description="More memory is admitted against {nodeLabel}'s workload slice. The broker restarts with the new limits; streams are kept."
		action="?/update"
		submitLabel="Save resources"
	>
		<div class="grid gap-4 sm:grid-cols-3">
			<Field.Field data-invalid={errors.memoryMb ? true : undefined}>
				<Field.Label for="resize-memory">Memory</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-memory"
						name="memoryMb"
						type="number"
						min={64}
						max={16384}
						value={String(broker.memoryMb)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end"
						><InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text></InputGroup.Addon
					>
				</InputGroup.Root>
				{#if errors.memoryMb}<Field.Error>{errors.memoryMb}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.cpus ? true : undefined}>
				<Field.Label for="resize-cpus">CPUs</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-cpus"
						name="cpus"
						type="number"
						min={0.1}
						max={8}
						step={0.1}
						value={String(broker.cpus)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end"
						><InputGroup.Text class="font-mono text-xs">vCPU</InputGroup.Text></InputGroup.Addon
					>
				</InputGroup.Root>
				{#if errors.cpus}<Field.Error>{errors.cpus}</Field.Error>{/if}
			</Field.Field>
			<Field.Field data-invalid={errors.storageMb ? true : undefined}>
				<Field.Label for="resize-store">Message store</Field.Label>
				<InputGroup.Root>
					<InputGroup.Input
						id="resize-store"
						name="storageMb"
						type="number"
						min={256}
						max={1048576}
						value={String(broker.storageMb)}
						class="font-mono text-sm"
					/>
					<InputGroup.Addon align="inline-end"
						><InputGroup.Text class="font-mono text-xs">MB</InputGroup.Text></InputGroup.Addon
					>
				</InputGroup.Root>
				{#if errors.storageMb}<Field.Error>{errors.storageMb}</Field.Error>{/if}
			</Field.Field>
		</div>
	</FormDialog>
{/if}

<PeekSheet bind:stream={peekStream} label={peekLabel} canDelete={can.delete} />

{#if can.update && running}
	<FormDialog
		bind:open={createQueueOpen}
		icon={PlusIcon}
		title="New queue"
		description="Creates the queue's stream now instead of on first use: a work queue (YOAL_Q_<name>) that a function consumes with a queue trigger and producers reach with a queue binding."
		action="?/createQueue"
		submitLabel="Create queue"
	>
		<Field.Field data-invalid={errors.queue ? true : undefined}>
			<Field.Label for="queue-name">Queue name</Field.Label>
			<Input
				id="queue-name"
				name="queue"
				required
				maxlength={63}
				pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?"
				placeholder="jobs"
				spellcheck="false"
				class="font-mono text-sm"
			/>
			<Field.Description>Lowercase letters, digits and hyphens, as on Cloudflare. Use it in wrangler.jsonc as <code class="font-mono">queues.producers[].queue</code>.</Field.Description>
		</Field.Field>
	</FormDialog>

	<FormDialog
		bind:open={sendOpen}
		icon={SendIcon}
		title="Send a test message"
		description="Published on {nodeLabel} exactly as a queue binding's send() does, so the consuming function receives it like any other message."
		action="?/sendMessage"
		submitLabel="Send"
		size="lg"
	>
		<Field.Group>
			<div class="grid gap-4 sm:grid-cols-[1fr_auto]">
				<Field.Field>
					<Field.Label for="send-queue">Queue</Field.Label>
					<Input id="send-queue" name="queue" bind:value={sendQueue} list="send-queue-names" required maxlength={63} spellcheck="false" class="font-mono text-sm" />
					<datalist id="send-queue-names">
						{#each queueNames as name (name)}<option value={name}></option>{/each}
					</datalist>
				</Field.Field>
				<Field.Field>
					<Field.Label for="send-type">Body type</Field.Label>
					<NativeSelect.Root id="send-type" name="contentType" bind:value={sendType}>
						<NativeSelect.Option value="json">JSON</NativeSelect.Option>
						<NativeSelect.Option value="text">Text</NativeSelect.Option>
					</NativeSelect.Root>
				</Field.Field>
			</div>
			<Field.Field data-invalid={sendBodyError ? true : undefined}>
				<Field.Label for="send-body">Body</Field.Label>
				<Textarea id="send-body" name="body" bind:value={sendBody} rows={8} spellcheck="false" class="font-mono text-xs" />
				{#if sendBodyError}<Field.Error>{sendBodyError}</Field.Error>{:else}<Field.Description>The consumer sees this as <code class="font-mono">message.body</code>{sendType === 'json' ? ', parsed' : ''}. At most 128 KiB.</Field.Description>{/if}
			</Field.Field>
			<div class="grid gap-4 sm:grid-cols-2">
				<Field.Field>
					<Field.Label for="send-delay">Delay</Field.Label>
					<InputGroup.Root>
						<InputGroup.Input id="send-delay" name="delaySeconds" type="number" min={0} max={43200} placeholder="0" class="font-mono text-sm" />
						<InputGroup.Addon align="inline-end"><InputGroup.Text class="font-mono text-xs">s</InputGroup.Text></InputGroup.Addon>
					</InputGroup.Root>
				</Field.Field>
				<Field.Field>
					<Field.Label for="send-count">Copies</Field.Label>
					<Input id="send-count" name="count" type="number" min={1} max={100} value="1" class="font-mono text-sm" />
					<Field.Description>Up to 100, for a quick load test.</Field.Description>
				</Field.Field>
			</div>
		</Field.Group>
	</FormDialog>

	<FormDialog
		bind:open={redriveOpen}
		icon={Undo2Icon}
		title="Move messages out of {redriveFrom}"
		description="Each message is republished to the target queue with its body and id, and its attempt count starts again; then it is removed from {redriveFrom}. Use it to retry a dead-letter queue once the consumer is fixed."
		action="?/redrive"
		submitLabel="Move messages"
	>
		<input type="hidden" name="from" value={redriveFrom} />
		<Field.Group>
			<Field.Field>
				<Field.Label for="redrive-to">Move to</Field.Label>
				<Input id="redrive-to" name="to" bind:value={redriveTo} list="redrive-queue-names" required maxlength={63} spellcheck="false" class="font-mono text-sm" />
				<datalist id="redrive-queue-names">
					{#each queueNames.filter((name) => name !== redriveFrom) as name (name)}<option value={name}></option>{/each}
				</datalist>
			</Field.Field>
			<Field.Field>
				<Field.Label for="redrive-limit">At most</Field.Label>
				<Input id="redrive-limit" name="limit" type="number" min={1} max={1000} value="1000" class="font-mono text-sm" />
			</Field.Field>
		</Field.Group>
	</FormDialog>
{/if}
