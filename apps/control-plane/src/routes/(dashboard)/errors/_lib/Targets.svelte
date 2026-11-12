<script lang="ts">
	import type { AppErrorServiceView, AppErrorTargetView } from '@yoal/contracts';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import FolderKanbanIcon from '@lucide/svelte/icons/folder-kanban';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SendIcon from '@lucide/svelte/icons/send';
	import TrashIcon from '@lucide/svelte/icons/trash';
	import { runAction } from '#lib/actions.js';
	import { askConfirm } from '#lib/confirm.svelte.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import EmptyState from '../../_lib/EmptyState.svelte';
	import { formatDateTime } from '../../_lib/format.js';

	let {
		service,
		projects,
		origin,
		canManage
	}: {
		service: AppErrorServiceView | null;
		projects: Array<{ slug: string; name: string }>;
		origin: string;
		canManage: boolean;
	} = $props();

	const autoLinked = $derived(service?.targets.filter((target) => target.autoLinked).length ?? 0);

	function snippet(target: AppErrorTargetView): string {
		return `<script src="${origin.replace(/\/$/, '')}/e.js" data-dsn="${target.dsn}"><\/script>`;
	}

	function health(target: AppErrorTargetView): { label: string; tone: 'success' | 'warning' | 'danger' | 'info' } {
		if (!target.enabled) return { label: 'disabled', tone: 'danger' };
		if (target.lastSeenAt && target.lastSeenAt >= Date.now() - 24 * 60 * 60 * 1000)
			return { label: 'reporting', tone: 'success' };
		if (target.lastSeenAt) return { label: 'quiet', tone: 'warning' };
		return { label: 'waiting for first event', tone: 'info' };
	}

	function setup(target: AppErrorTargetView): Array<{ label: string; code: string; language: string }> {
		const dsn = target.dsn ?? 'https://<key>@<platform>/ingest/<id>';
		return [
			{
				label: 'Node / Bun',
				language: 'ts',
				code: `import * as Sentry from '@sentry/node';\n\nSentry.init({\n  dsn: '${dsn}',\n  environment: 'production',\n});`
			},
			{
				label: 'Browser SDK',
				language: 'ts',
				code: `import * as Sentry from '@sentry/browser';\n\nSentry.init({\n  dsn: '${dsn}',\n  environment: 'production',\n});`
			},
			{
				label: 'PHP',
				language: 'php',
				code: `\\Sentry\\init([\n  'dsn' => '${dsn}',\n  'environment' => 'production',\n]);`
			},
			{
				label: 'Go',
				language: 'go',
				code: `sentry.Init(sentry.ClientOptions{\n  Dsn: "${dsn}",\n  Environment: "production",\n})`
			},
			{
				label: 'Python',
				language: 'python',
				code: `import sentry_sdk\n\nsentry_sdk.init(\n    dsn="${dsn}",\n    environment="production",\n)`
			}
		];
	}

	function removeTarget(target: AppErrorTargetView) {
		askConfirm({
			title: `Delete ${target.name}?`,
			description: 'Its DSN, issues, events and counts are deleted. The app will start rejecting errors.',
			confirmLabel: 'Delete target',
			tone: 'danger',
			action: '?/deleteTarget',
			fields: { targetId: target.id }
		});
	}
</script>

<div class="space-y-5">
	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2"><CircleAlertIcon class="size-5" /> Automatic linking</Card.Title>
			<Card.Description>
				When this is on, every project in this organization gets a DSN and the DSN is injected into
				its process apps and functions. New projects are linked as they are created.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-wrap items-center gap-3">
			<Badge variant={service?.autoLink ? 'success' : 'info'}>{service?.autoLink ? 'On' : 'Off'}</Badge>
			{#if canManage}
				<Button
					variant={service?.autoLink ? 'outline' : 'default'}
					onclick={() => runAction('?/setAutoLink', { enabled: service?.autoLink ? 'false' : 'true' })}
				>
					{service?.autoLink ? 'Turn automatic linking off' : 'Turn automatic linking on'}
				</Button>
			{/if}
			<p class="text-xs text-muted-foreground">
				Turning it off disables targets that were created automatically; targets enabled by hand stay on.
				Nothing is deleted.
			</p>
			<span class="ms-auto text-xs text-muted-foreground">
				{service?.summary.targets ?? 0} targets · {autoLinked} auto-linked ·
				{service?.summary.reporting24h ?? 0} reporting in 24h
			</span>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title>Targets</Card.Title>
			<Card.Description>
				A target is a Yoal project or an off-platform app. Copy its DSN into any Sentry SDK or use it
				with the browser snippet.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if canManage}
				<div class="flex flex-wrap items-end gap-2 rounded-lg border p-3">
					{#if projects.length > 0}
						<form method="POST" action="?/linkProject" class="flex flex-1 flex-wrap items-end gap-2">
							<label class="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground">
								<span>Link a Yoal project by hand</span>
								<NativeSelect.Root name="project" value="" size="sm" class="w-full">
									<NativeSelect.Option value="">Choose a project</NativeSelect.Option>
									{#each projects as project (project.slug)}
										<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
									{/each}
								</NativeSelect.Root>
							</label>
							<Button type="submit" variant="outline"><PlusIcon />Link project</Button>
						</form>
					{/if}
					<form method="POST" action="?/createTarget" class="flex flex-1 flex-wrap items-end gap-2">
						<label class="grid min-w-56 flex-1 gap-1 text-xs text-muted-foreground">
							<span>Attach an off-platform project</span>
							<Input name="name" placeholder="e.g. Marketing site (Vercel)" required />
						</label>
						<Button type="submit" variant="outline"><PlusIcon />Attach</Button>
					</form>
				</div>
			{/if}

			{#if !service || service.targets.length === 0}
				<EmptyState
					icon={FolderKanbanIcon}
					title="No targets yet"
					description="Turn automatic linking on, or attach an off-platform project to get a DSN."
				/>
			{:else}
				<div class="space-y-3">
					{#each service.targets as target (target.id)}
						<div class="rounded-lg border p-4">
							<div class="flex flex-wrap items-start justify-between gap-3">
								<div class="min-w-0 space-y-1">
									<div class="flex flex-wrap items-center gap-2">
										<span class="font-medium">{target.name}</span>
										<Badge variant="info">{target.kind === 'project' ? 'Yoal project' : 'Off-platform'}</Badge>
										{#if target.autoLinked}<Badge variant="success">auto-linked</Badge>{/if}
										<Badge variant={target.enabled ? 'success' : 'danger'}>{target.enabled ? 'enabled' : 'disabled'}</Badge>
										<Badge variant={health(target).tone}>{health(target).label}</Badge>
									</div>
									{#if target.projectSlug}
										<a class="text-xs text-muted-foreground hover:underline" href="/projects/{target.projectSlug}">
											{target.projectSlug}
										</a>
									{:else}
										<p class="text-xs text-muted-foreground">Not linked to a Yoal project.</p>
									{/if}
								</div>
								<div class="flex flex-wrap items-center gap-3">
									<div class="flex h-8 w-28 items-end gap-0.5" title="Events, last 7 days">
										{#each target.daily as value}
											<div
												class="min-h-0.5 flex-1 rounded-sm bg-primary/50"
												style={`height: ${Math.max(4, (value / Math.max(1, ...target.daily)) * 100)}%`}
												title={`${value} events`}
											></div>
										{/each}
									</div>
									<div class="flex flex-wrap items-center gap-2">
										<a class="text-xs text-muted-foreground hover:underline" href="?tab=issues&target={target.id}">View issues</a>
										<span class="text-xs text-muted-foreground">{target.unresolved.toLocaleString()} unresolved</span>
										<span class="text-xs text-muted-foreground">{target.events24h.toLocaleString()} in 24h</span>
										<span class="text-xs text-muted-foreground">
											{target.lastSeenAt ? `last seen ${formatDateTime(target.lastSeenAt)}` : 'no events yet'}
										</span>
										{#if target.firstSeenAt}
											<span class="text-xs text-muted-foreground">first seen {formatDateTime(target.firstSeenAt)}</span>
										{/if}
									</div>
								</div>
							</div>

							<div class="mt-3 flex flex-wrap items-center gap-2">
								<code class="max-w-full overflow-x-auto rounded bg-muted px-2 py-1 text-xs">{target.dsn ?? '—'}</code>
								{#if target.dsn}
									<CopyButton value={target.dsn} label="Copy DSN" />
									<CopyButton value={snippet(target)} label="Copy snippet" />
								{/if}
								{#if canManage}
									<Button variant="outline" size="sm" onclick={() => runAction('?/testTarget', { targetId: target.id })}>
										<SendIcon />Send test
									</Button>
									<Button variant="outline" size="sm" onclick={() => runAction('?/rotateTargetKey', { targetId: target.id })}>
										<RefreshCwIcon />Rotate key
									</Button>
									<Button
										variant="outline"
										size="sm"
										onclick={() => runAction('?/toggleTarget', { targetId: target.id, enabled: target.enabled ? 'false' : 'true' })}
									>
										{target.enabled ? 'Disable' : 'Enable'}
									</Button>
									<Button variant="outline" size="sm" onclick={() => removeTarget(target)}>
										<TrashIcon />Delete
									</Button>
								{/if}
							</div>

							<details class="mt-3 text-sm">
								<summary class="cursor-pointer text-xs text-muted-foreground hover:underline">Setup snippets</summary>
								<div class="mt-3 grid gap-2">
									{#each setup(target) as item (item.label)}
										<div class="rounded-lg border">
											<div class="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
												<span class="text-xs font-medium">{item.label}</span>
												<CopyButton value={item.code} label="Copy" />
											</div>
											<pre class="overflow-x-auto p-3 text-xs">{item.code}</pre>
										</div>
									{/each}
									<div class="rounded-lg border">
										<div class="flex items-center justify-between border-b bg-muted/30 px-3 py-1.5">
											<span class="text-xs font-medium">Static site</span>
											<CopyButton value={snippet(target)} label="Copy" />
										</div>
										<pre class="overflow-x-auto p-3 text-xs">{snippet(target)}</pre>
									</div>
								</div>
							</details>

							{#if canManage}
								<details class="mt-3 text-sm">
									<summary class="cursor-pointer text-xs text-muted-foreground hover:underline">Target settings</summary>
									<form method="POST" action="?/updateTarget" class="mt-3 flex flex-wrap items-end gap-3">
										<input type="hidden" name="targetId" value={target.id} />
										{#if target.kind === 'standalone'}
											<label class="grid gap-1 text-xs text-muted-foreground">
												<span>Name</span>
												<Input name="name" value={target.name} class="w-56" />
											</label>
										{/if}
										<label class="grid gap-1 text-xs text-muted-foreground">
											<span>Stored-event sample rate</span>
											<Input name="sampleRate" type="number" min="0" max="1" step="0.05" value={target.sampleRate} class="w-28" />
										</label>
										<label class="flex items-center gap-2 text-xs text-muted-foreground">
											<input type="checkbox" name="notify" value="true" checked={target.notify} class="size-4" />
											<input type="hidden" name="notify" value="false" />
											<span>Notify on a new or regressed issue</span>
										</label>
										<Button type="submit" variant="outline" size="sm"><CheckIcon />Save</Button>
										<span class="text-xs text-muted-foreground">
											{target.usage.accepted.toLocaleString()} accepted this month
											· limit {target.usage.limit.toLocaleString()}
										</span>
									</form>
								</details>
							{/if}
						</div>
					{/each}
				</div>
			{/if}
		</Card.Content>
	</Card.Root>
</div>
