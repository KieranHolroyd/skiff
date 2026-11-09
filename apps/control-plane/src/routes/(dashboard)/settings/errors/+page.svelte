<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BugIcon from '@lucide/svelte/icons/bug';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import EyeOffIcon from '@lucide/svelte/icons/eye-off';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import SearchIcon from '@lucide/svelte/icons/search';
	import SendIcon from '@lucide/svelte/icons/send';
	import Trash2Icon from '@lucide/svelte/icons/trash-2';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { serverErrorSources, type ServerErrorStatus } from '@yoal/contracts';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { notify } from '#lib/actions.js';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import { Checkbox } from '#lib/components/ui/checkbox/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Switch } from '#lib/components/ui/switch/index.js';
	import * as Table from '#lib/components/ui/table/index.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import Panel from '../../_lib/Panel.svelte';
	import StatStrip from '../../_lib/service/StatStrip.svelte';
	import type { Stat } from '../../_lib/service/sections.js';
	import { formatDateTime, formatRelative } from '../../_lib/format.js';
	import SettingsHeader from '../_lib/SettingsHeader.svelte';
	import Bars from './_lib/Bars.svelte';
	import { sourceLabel, statusLabel, statusTone } from './_lib/copy.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The Sentry form is local until saved; the page data resets it after a successful save.
	let sentryEnabled = $state(untrack(() => data.sentry.enabled));
	let sentryPii = $state(untrack(() => data.sentry.sendDefaultPii));
	let sentryClearToken = $state(false);
	$effect(() => {
		sentryEnabled = data.sentry.enabled;
		sentryPii = data.sentry.sendDefaultPii;
		sentryClearToken = false;
	});

	const TABS = [
		{ id: 'unresolved', label: 'Unresolved' },
		{ id: 'resolved', label: 'Resolved' },
		{ id: 'ignored', label: 'Ignored' },
		{ id: 'all', label: 'All' }
	] as const;

	// Both reset when the page data changes: a new page of issues starts with nothing selected.
	let search = $derived(data.filters.q);
	let selected = $derived.by((): string[] => {
		void data.issues;
		return [];
	});

	const allSelected = $derived(data.issues.length > 0 && selected.length === data.issues.length);

	const stats = $derived.by((): Stat[] => [
		{
			label: 'Unresolved',
			value: data.summary.unresolved.toLocaleString('en-GB'),
			icon: BugIcon
		},
		{
			label: 'Events, last 24 h',
			value: data.summary.events24h.toLocaleString('en-GB'),
			icon: ZapIcon
		},
		{
			label: 'Resolved',
			value: data.summary.resolved.toLocaleString('en-GB'),
			icon: CircleCheckIcon
		},
		{ label: 'Ignored', value: data.summary.ignored.toLocaleString('en-GB'), icon: EyeOffIcon }
	]);

	const hourLabels = $derived.by(() => {
		const hour = 60 * 60 * 1000;
		const start = Math.floor(data.now / hour) * hour - 23 * hour;
		return data.hourly.map((_, index) =>
			new Date(start + index * hour).toLocaleTimeString('en-GB', {
				hour: '2-digit',
				minute: '2-digit'
			})
		);
	});

	function href(next: { status?: string; source?: string; q?: string; before?: number | null }) {
		// eslint-disable-next-line svelte/prefer-svelte-reactivity -- a throwaway builder, not state
		const params = new URLSearchParams();
		const status = next.status ?? data.filters.status;
		const source = next.source ?? data.filters.source;
		const q = next.q ?? data.filters.q;
		if (status !== 'unresolved') params.set('status', status);
		if (source) params.set('source', source);
		if (q) params.set('q', q);
		if (next.before) params.set('before', String(next.before));
		const query = params.toString();
		return `${page.url.pathname}${query ? `?${query}` : ''}`;
	}

	function navigate(next: Parameters<typeof href>[0]) {
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query changes
		void goto(href(next), { reset: false });
	}

	function toggle(id: string, checked: boolean) {
		selected = checked ? [...selected, id] : selected.filter((entry) => entry !== id);
	}

	let bulkForm = $state<HTMLFormElement | null>(null);
	let bulkStatus = $state<ServerErrorStatus>('resolved');

	function submitStatus(status: ServerErrorStatus) {
		bulkStatus = status;
		queueMicrotask(() => bulkForm?.requestSubmit());
	}

	function confirmDelete() {
		const count = selected.length;
		const ids = [...selected];
		askConfirm({
			title: `Delete ${count} ${count === 1 ? 'issue' : 'issues'}?`,
			description:
				'Their events and counts go too. If the error happens again it starts a new issue.',
			confirmLabel: 'Delete',
			tone: 'danger',
			action: '?/delete',
			// The confirm dialog posts flat fields, so the ids travel comma-joined.
			fields: { ids: ids.join(',') },
			onResult: (result) => {
				if (result.type === 'success')
					toast.success(`Deleted ${count === 1 ? 'the issue' : `${count} issues`}`);
				else if (result.type === 'failure')
					toast.error(
						String((result.data as { message?: unknown })?.message ?? 'Could not delete')
					);
			}
		});
	}
</script>

<svelte:head><title>Server errors · Settings · Yoal</title></svelte:head>

<SettingsHeader id="errors" />

<div class="space-y-6">
	<div class="space-y-3">
		<StatStrip label="Server error summary" {stats} />
		<div class="rounded-xl border bg-card px-4 py-3 shadow-xs">
			<div class="mb-2 flex items-center justify-between text-xs text-muted-foreground">
				<span>Events per hour, last 24 hours</span>
				<span class="tabular-nums">{data.summary.events24h.toLocaleString('en-GB')} total</span>
			</div>
			<Bars values={data.hourly} labels={hourLabels} height="h-12" />
		</div>
	</div>

	<div class="flex flex-wrap items-center justify-between gap-3">
		<nav class="flex flex-wrap gap-1 rounded-lg bg-muted p-1" aria-label="Issue status">
			<!-- eslint-disable svelte/no-navigation-without-resolve -- same route, only the query changes -->
			{#each TABS as tab (tab.id)}
				{@const active = data.filters.status === tab.id}
				{@const count = tab.id === 'all' ? null : data.summary[tab.id]}
				<a
					href={href({ status: tab.id, before: null })}
					class="flex items-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium transition-colors {active
						? 'bg-background text-foreground shadow-xs'
						: 'text-muted-foreground hover:text-foreground'}"
					aria-current={active ? 'page' : undefined}
				>
					{tab.label}
					{#if count !== null && count > 0}
						<span class="text-xs text-muted-foreground tabular-nums">{count}</span>
					{/if}
				</a>
			{/each}
			<!-- eslint-enable svelte/no-navigation-without-resolve -->
		</nav>

		<form
			class="flex flex-wrap items-center gap-2"
			onsubmit={(event) => {
				event.preventDefault();
				navigate({ q: search.trim(), before: null });
			}}
		>
			<NativeSelect.Root
				aria-label="Source"
				value={data.filters.source}
				onchange={(event) => navigate({ source: event.currentTarget.value, before: null })}
			>
				<NativeSelect.Option value="">Every source</NativeSelect.Option>
				{#each serverErrorSources as source (source)}
					<NativeSelect.Option value={source}>{sourceLabel[source]}</NativeSelect.Option>
				{/each}
			</NativeSelect.Root>
			<div class="relative">
				<SearchIcon
					class="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
				/>
				<Input
					type="search"
					placeholder="Search messages, routes, ids"
					class="w-64 pl-8"
					bind:value={search}
				/>
			</div>
		</form>
	</div>

	{#if data.issues.length === 0}
		<EmptyState
			icon={data.filters.status === 'unresolved' && !data.filters.q && !data.filters.source
				? CircleCheckIcon
				: BugIcon}
			title={data.filters.q || data.filters.source
				? 'No issues match'
				: data.filters.status === 'unresolved'
					? 'No unresolved server errors'
					: `No ${data.filters.status === 'all' ? '' : `${data.filters.status} `}issues`}
			description={data.filters.status === 'unresolved' && !data.filters.q && !data.filters.source
				? 'Exceptions in pages, actions, the REST API and background loops show up here, along with any 5xx the control plane answers.'
				: 'Try another status, source or search.'}
		/>
	{:else}
		<form
			method="POST"
			action="?/status"
			bind:this={bulkForm}
			use:enhance={() => {
				return async ({ result, update }) => {
					await update();
					if (result.type === 'success')
						toast.success(String((result.data as { success?: unknown })?.success ?? 'Updated'));
					else if (result.type === 'failure')
						toast.error(
							String((result.data as { message?: unknown })?.message ?? 'Could not update')
						);
				};
			}}
		>
			<input type="hidden" name="status" value={bulkStatus} />
			{#each selected as id (id)}<input type="hidden" name="id" value={id} />{/each}
		</form>

		<div class="overflow-hidden rounded-xl border bg-card shadow-xs">
			{#if data.canChange}
				<div
					class="flex min-h-12 flex-wrap items-center gap-2 border-b px-4 py-2 text-sm {selected.length
						? 'bg-muted/50'
						: ''}"
				>
					<Checkbox
						aria-label="Select every issue on this page"
						checked={allSelected}
						indeterminate={selected.length > 0 && !allSelected}
						onCheckedChange={(checked) =>
							(selected = checked ? data.issues.map((issue) => issue.id) : [])}
					/>
					{#if selected.length}
						<span class="mr-2 text-muted-foreground tabular-nums">{selected.length} selected</span>
						{#if data.filters.status !== 'resolved'}
							<Button size="sm" variant="outline" onclick={() => submitStatus('resolved')}>
								<CircleCheckIcon />Resolve
							</Button>
						{/if}
						{#if data.filters.status !== 'ignored'}
							<Button size="sm" variant="outline" onclick={() => submitStatus('ignored')}>
								<EyeOffIcon />Ignore
							</Button>
						{/if}
						{#if data.filters.status !== 'unresolved'}
							<Button size="sm" variant="outline" onclick={() => submitStatus('unresolved')}>
								<RotateCcwIcon />Reopen
							</Button>
						{/if}
						<Button size="sm" variant="ghost" class="text-destructive" onclick={confirmDelete}>
							<Trash2Icon />Delete
						</Button>
					{:else}
						<span class="text-muted-foreground">
							{data.issues.length}{data.nextBefore ? '+' : ''}
							{data.issues.length === 1 ? 'issue' : 'issues'}, most recent first
						</span>
					{/if}
				</div>
			{/if}

			<Table.Root>
				<Table.Header>
					<Table.Row>
						{#if data.canChange}<Table.Head class="w-10"
								><span class="sr-only">Select</span></Table.Head
							>{/if}
						<Table.Head>Issue</Table.Head>
						<Table.Head class="hidden md:table-cell">Source</Table.Head>
						<Table.Head class="text-right">Events</Table.Head>
						<Table.Head class="hidden text-right sm:table-cell">Last 24 h</Table.Head>
						<Table.Head class="text-right">Last seen</Table.Head>
					</Table.Row>
				</Table.Header>
				<Table.Body>
					{#each data.issues as issue (issue.id)}
						{@const detail = resolve('/(dashboard)/settings/errors/[id]', { id: issue.id })}
						<Table.Row data-state={selected.includes(issue.id) ? 'selected' : undefined}>
							{#if data.canChange}
								<Table.Cell class="align-top">
									<Checkbox
										aria-label={`Select ${issue.name}`}
										checked={selected.includes(issue.id)}
										onCheckedChange={(checked) => toggle(issue.id, checked === true)}
									/>
								</Table.Cell>
							{/if}
							<Table.Cell class="max-w-0 min-w-64 whitespace-normal">
								<a href={detail} class="group block space-y-1">
									<span class="flex flex-wrap items-center gap-2">
										<span class="font-semibold group-hover:underline">{issue.name}</span>
										{#if data.filters.status === 'all' || issue.status !== data.filters.status}
											<Badge variant={statusTone[issue.status]}>{statusLabel[issue.status]}</Badge>
										{/if}
										{#if issue.regressedAt && issue.status === 'unresolved'}
											<Badge
												variant="warning"
												title={`Came back ${formatDateTime(issue.regressedAt)}`}
											>
												Regressed
											</Badge>
										{/if}
										{#if issue.firstSeenAt > data.now - 24 * 60 * 60 * 1000}
											<Badge variant="info">New</Badge>
										{/if}
									</span>
									<span class="line-clamp-2 text-sm break-words text-muted-foreground">
										{issue.message}
									</span>
									{#if issue.culprit}
										<span class="block truncate font-mono text-xs text-muted-foreground/80">
											{issue.culprit}
										</span>
									{/if}
								</a>
							</Table.Cell>
							<Table.Cell class="hidden align-top md:table-cell">
								<Badge variant="outline">{sourceLabel[issue.source]}</Badge>
							</Table.Cell>
							<Table.Cell class="text-right align-top font-medium tabular-nums">
								{issue.count.toLocaleString('en-GB')}
							</Table.Cell>
							<Table.Cell class="hidden text-right align-top tabular-nums sm:table-cell">
								{issue.count24h.toLocaleString('en-GB')}
							</Table.Cell>
							<Table.Cell class="text-right align-top whitespace-nowrap text-muted-foreground">
								<span title={formatDateTime(issue.lastSeenAt)}
									>{formatRelative(issue.lastSeenAt)}</span
								>
								<span class="block text-xs" title={formatDateTime(issue.firstSeenAt)}>
									first {formatRelative(issue.firstSeenAt)}
								</span>
							</Table.Cell>
						</Table.Row>
					{/each}
				</Table.Body>
			</Table.Root>
		</div>

		{#if data.filters.before || data.nextBefore}
			<div class="flex justify-end gap-2">
				{#if data.filters.before}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query changes -->
					<Button variant="ghost" size="sm" href={href({ before: null })}>Newest</Button>
				{/if}
				{#if data.nextBefore}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- same route, only the query changes -->
					<Button variant="outline" size="sm" href={href({ before: data.nextBefore })}>Older</Button
					>
				{/if}
			</div>
		{/if}
	{/if}

	<Panel
		title="Sentry"
		icon={BugIcon}
		description="Optional. Forward the same errors to Sentry as well as keeping them here. Nothing leaves this install until a DSN is saved and switched on."
	>
		{#snippet actions()}
			<Badge variant={data.sentry.enabled ? 'success' : 'outline'}
				>{data.sentry.enabled ? 'On' : 'Off'}</Badge
			>
		{/snippet}
		<form
			method="POST"
			action="?/saveSentry"
			use:enhance={() => {
				return async ({ result, update }) => {
					notify(result);
					await update({ reset: false });
				};
			}}
		>
			<div class="space-y-4">
				<Field.Group>
					<Field.Field orientation="horizontal" class="gap-2">
						<input type="hidden" name="enabled" value={sentryEnabled ? 'true' : ''} />
						<Switch id="sentry-enabled" bind:checked={sentryEnabled} />
						<Field.Content>
							<Field.Label for="sentry-enabled" class="font-normal">
								Send errors to Sentry
							</Field.Label>
							<Field.Description>
								The local issue list above is always kept. If Sentry is unreachable, errors are still
								recorded and alerts still fire.
							</Field.Description>
						</Field.Content>
					</Field.Field>
				</Field.Group>

				<div class="grid gap-4 sm:grid-cols-2">
					<Field.Field class="sm:col-span-2">
						<Field.Label for="sentry-dsn">DSN</Field.Label>
						<Input
							id="sentry-dsn"
							name="dsn"
							value={data.sentry.dsn ?? ''}
							placeholder="https://public-key@o123.ingest.sentry.io/456"
							class="font-mono text-xs"
							autocomplete="off"
						/>
						<Field.Description>
							Project → Settings → Client Keys (DSN). The public key is enough to send events.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sentry-environment">Environment</Field.Label>
						<Input
							id="sentry-environment"
							name="environment"
							value={data.sentry.environment}
							placeholder="production"
						/>
						<Field.Description>Separate production from staging in Sentry.</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sentry-release">Release</Field.Label>
						<Input
							id="sentry-release"
							name="release"
							value={data.sentry.release ?? ''}
							placeholder="yoal@1.2.3"
							class="font-mono text-xs"
						/>
						<Field.Description>
							Defaults to the running Yoal version. Issues group by release when set.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sentry-traces">Performance sample rate</Field.Label>
						<Input
							id="sentry-traces"
							name="tracesSampleRate"
							type="number"
							min={0}
							max={1}
							step="0.01"
							value={data.sentry.tracesSampleRate}
						/>
						<Field.Description>
							0 turns performance tracing off (the default). 1 traces every request; start around
							0.05 on a busy install.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sentry-org">Organisation slug</Field.Label>
						<Input
							id="sentry-org"
							name="organizationSlug"
							value={data.sentry.organizationSlug ?? ''}
							placeholder="acme"
							class="font-mono text-xs"
						/>
						<Field.Description>
							Optional. With a project slug and token, Yoal creates the release on boot.
						</Field.Description>
					</Field.Field>
					<Field.Field>
						<Field.Label for="sentry-project">Project slug</Field.Label>
						<Input
							id="sentry-project"
							name="projectSlug"
							value={data.sentry.projectSlug ?? ''}
							placeholder="yoal-control-plane"
							class="font-mono text-xs"
						/>
					</Field.Field>
					<Field.Field class="sm:col-span-2">
						<Field.Label for="sentry-token">Auth token</Field.Label>
						<Input
							id="sentry-token"
							name="authToken"
							type="password"
							value=""
							placeholder={data.sentry.hasAuthToken
								? `Saved (${data.sentry.authTokenHint}) · leave blank to keep`
								: 'Optional, for release creation'}
							autocomplete="off"
							class="font-mono text-xs"
						/>
						<Field.Description>
							Stored encrypted and never shown again. Needs <code class="font-mono text-xs"
								>project:releases</code
							>
							(or <code class="font-mono text-xs">project:write</code>) to create the release; events
							themselves only need the DSN.
						</Field.Description>
					</Field.Field>
				</div>

				<Field.Group>
					<Field.Field orientation="horizontal" class="gap-2">
						<input type="hidden" name="sendDefaultPii" value={sentryPii ? 'true' : ''} />
						<Switch id="sentry-pii" bind:checked={sentryPii} />
						<Field.Content>
							<Field.Label for="sentry-pii" class="font-normal">
								Include request metadata
							</Field.Label>
							<Field.Description>
								Adds the client IP and request headers Sentry normally drops. Request bodies, cookies
								and authorisation headers are never sent, whatever this is set to.
							</Field.Description>
						</Field.Content>
					</Field.Field>
					{#if data.sentry.hasAuthToken}
						<Field.Field orientation="horizontal" class="gap-2">
							<input type="hidden" name="clearAuthToken" value={sentryClearToken ? 'true' : ''} />
							<Checkbox id="sentry-clear-token" bind:checked={sentryClearToken} />
							<Field.Content>
								<Field.Label for="sentry-clear-token" class="font-normal">
									Remove the saved auth token
								</Field.Label>
							</Field.Content>
						</Field.Field>
					{/if}
				</Field.Group>

				<div class="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
					<p class="text-xs text-muted-foreground">
						{#if !data.canChange}
							Read-only: only a platform admin can change these settings.
						{:else if data.sentryRuntime.active}
							Forwarding to Sentry · {data.sentryRuntime.eventsSent} event{data.sentryRuntime
								.eventsSent === 1
								? ''
								: 's'} this process
							{#if data.sentryRuntime.lastEventAt}
								· last {formatRelative(data.sentryRuntime.lastEventAt)}
							{/if}
						{:else if data.sentry.enabled}
							Not initialised yet. Save to apply the current settings.
						{:else}
							Off. Errors stay in this database only.
						{/if}
						{#if data.sentryRuntime.lastError}
							<span class="block text-destructive">{data.sentryRuntime.lastError}</span>
						{/if}
					</p>
					<div class="flex gap-2">
						<Button
							type="submit"
							formaction="?/testSentry"
							variant="outline"
							size="sm"
							disabled={!data.canChange}
						>
							<SendIcon />Send test event
						</Button>
						<Button type="submit" size="sm" disabled={!data.canChange}>
							Save Sentry settings
						</Button>
					</div>
				</div>
			</div>
		</form>
	</Panel>

	<p class="text-xs text-muted-foreground">
		Messages and stacks are scrubbed of credentials, paths never keep their query string, and no
		request body or header is stored. Each issue keeps its newest 50 events; events go after 30 days
		and quiet issues after 90. A new or returning issue raises the <em>New server error</em>
		system alert (Alerts → System alerts).
	</p>
</div>
