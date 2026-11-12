<script lang="ts">
	import type { AppErrorServiceView, AppErrorTargetView } from '@yoal/contracts';
	import CheckIcon from '@lucide/svelte/icons/check';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import ClipboardCopyIcon from '@lucide/svelte/icons/clipboard-copy';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import SendIcon from '@lucide/svelte/icons/send';
	import { invalidateAll } from '$app/navigation';
	import { runAction } from '#lib/actions.js';
	import CopyButton from '#lib/components/yoal/CopyButton.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { formatDateTime } from '../../_lib/format.js';

	type Framework = 'node' | 'browser' | 'php' | 'go' | 'python' | 'static';

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

	const frameworks: Array<{ id: Framework; label: string; hint: string }> = [
		{ id: 'node', label: 'Node / Bun', hint: '@sentry/node' },
		{ id: 'browser', label: 'Browser SDK', hint: '@sentry/browser' },
		{ id: 'php', label: 'PHP', hint: 'sentry/sentry' },
		{ id: 'go', label: 'Go', hint: 'sentry-go' },
		{ id: 'python', label: 'Python', hint: 'sentry-sdk' },
		{ id: 'static', label: 'Static site', hint: 'one script tag' }
	];
	let framework = $state<Framework>('node');
	let selectedTargetId = $state('');
	let checking = $state(false);

	$effect(() => {
		if (selectedTargetId || !service?.targets.length) return;
		selectedTargetId =
			service.targets.find((row) => !row.lastSeenAt)?.id ?? service.targets[0]!.id;
	});

	const target = $derived(
		service?.targets.find((row) => row.id === selectedTargetId) ??
			service?.targets[0] ??
			null
	);
	const connected = $derived(Boolean(target?.lastSeenAt));
	const dsn = $derived(target?.dsn ?? 'https://<key>@<platform>/ingest/<target-id>');

	function code(): string {
		switch (framework) {
			case 'browser':
				return `import * as Sentry from '@sentry/browser';\n\nSentry.init({\n  dsn: '${dsn}',\n  environment: 'production',\n  release: 'web@1.0.0',\n});`;
			case 'php':
				return `\\Sentry\\init([\n  'dsn' => '${dsn}',\n  'environment' => 'production',\n  'release' => 'web@1.0.0',\n]);`;
			case 'go':
				return `sentry.Init(sentry.ClientOptions{\n  Dsn: "${dsn}",\n  Environment: "production",\n  Release: "web@1.0.0",\n})`;
			case 'python':
				return `import sentry_sdk\n\nsentry_sdk.init(\n    dsn="${dsn}",\n    environment="production",\n    release="web@1.0.0",\n)`;
			case 'static':
				return `<script src="${origin.replace(/\/$/, '')}/e.js"\n        data-dsn="${dsn}"\n        data-release="web@1.0.0"\n        data-environment="production"><\/script>`;
			default:
				return `import * as Sentry from '@sentry/node';\n\nSentry.init({\n  dsn: '${dsn}',\n  environment: 'production',\n  release: 'web@1.0.0',\n});`;
		}
	}

	async function checkForEvent() {
		checking = true;
		try {
			await invalidateAll();
		} finally {
			checking = false;
		}
	}

	async function sendTest() {
		if (!target) return;
		await runAction('?/testTarget', { targetId: target.id });
		await invalidateAll();
	}
</script>

<div class="space-y-5">
	<Card.Root>
		<Card.Header>
			<Card.Title class="flex items-center gap-2"><CircleAlertIcon class="size-5" /> Get your first error</Card.Title>
			<Card.Description>
				Three steps: create a target, paste one snippet into the app, and send a test or wait for
				the first real exception. DSNs are safe to ship in client code; they can only append errors
				to one target.
			</Card.Description>
		</Card.Header>
		<Card.Content>
			<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<Badge variant={service?.targets.length ? 'success' : 'info'}>Target</Badge>
				<Badge variant={target?.dsn ? 'success' : 'info'}>DSN</Badge>
				<Badge variant={connected ? 'success' : 'info'}>First event</Badge>
				<span class="ms-auto">
					{connected
						? `First event received ${formatDateTime(target!.lastSeenAt!)}`
						: target
							? 'Waiting for the first event.'
							: 'Create a target to start.'}
				</span>
			</div>
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">1. Choose a target</Card.Title>
			<Card.Description>
				A target is one DSN: a Yoal project, or an app outside Yoal.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-4">
			{#if service && service.targets.length > 0}
				<div class="flex flex-wrap items-end gap-3">
					<label class="grid min-w-64 flex-1 gap-1 text-xs text-muted-foreground">
						<span>Send errors to</span>
						<NativeSelect.Root name="target" bind:value={selectedTargetId} size="sm" class="w-full">
							{#each service.targets as row (row.id)}
								<NativeSelect.Option value={row.id}>
									{row.name}{row.kind === 'standalone' ? ' (off-platform)' : ''}
								</NativeSelect.Option>
							{/each}
						</NativeSelect.Root>
					</label>
					<Button variant="outline" onclick={() => runAction('?/setAutoLink', { enabled: 'true' })}>
						<CheckIcon />Link every project automatically
					</Button>
					{#if service.autoLink}<Badge variant="success">automatic linking is on</Badge>{/if}
					<a class="text-xs text-muted-foreground hover:underline" href="?tab=targets">Manage targets</a>
				</div>
				<p class="text-xs text-muted-foreground">
					The snippet below uses <span class="font-medium">{target?.name}</span>. Pick another target
					to change the DSN.
				</p>
			{:else if canManage}
				<div class="grid gap-3 lg:grid-cols-2">
					<form method="POST" action="?/setAutoLink" class="rounded-lg border p-4">
						<input type="hidden" name="enabled" value="true" />
						<p class="text-sm font-medium">Link every Yoal project</p>
						<p class="mt-1 text-xs text-muted-foreground">
							Creates a DSN for every current project and every project created later. The DSN is
							injected into process apps and functions.
						</p>
						<Button type="submit" variant="outline" class="mt-3"><CheckIcon />Turn on automatic linking</Button>
					</form>
					{#if projects.length > 0}
						<form method="POST" action="?/linkProject" class="rounded-lg border p-4">
							<p class="text-sm font-medium">Link one project</p>
							<p class="mt-1 text-xs text-muted-foreground">Use this when automatic linking should stay off.</p>
							<NativeSelect.Root name="project" value="" size="sm" class="mt-3 w-full">
								<NativeSelect.Option value="">Choose a project</NativeSelect.Option>
								{#each projects as project (project.slug)}
									<NativeSelect.Option value={project.slug}>{project.name}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							<Button type="submit" variant="outline" class="mt-3"><PlusIcon />Link project</Button>
						</form>
					{/if}
					<form method="POST" action="?/createTarget" class="rounded-lg border p-4">
						<p class="text-sm font-medium">An app outside Yoal</p>
						<p class="mt-1 text-xs text-muted-foreground">
							Give it a name and get a standalone DSN for any Sentry SDK or static site.
						</p>
						<Input name="name" placeholder="e.g. Marketing site (Vercel)" required class="mt-3" />
						<Button type="submit" variant="outline" class="mt-3"><PlusIcon />Create target</Button>
					</form>
				</div>
			{:else}
				<p class="text-sm text-muted-foreground">
					A project updater can create the first target. Once it exists, this page shows the DSN and
					snippet.
				</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">2. Paste the snippet</Card.Title>
			<Card.Description>
				Pick the SDK your app already uses. The only change is the DSN.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3">
			<div class="flex flex-wrap gap-1">
				{#each frameworks as item (item.id)}
					<button
						type="button"
						class="rounded-md px-3 py-1.5 text-sm {framework === item.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}"
						onclick={() => (framework = item.id)}
					>
						{item.label}
					</button>
				{/each}
			</div>
			<div class="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
				<span>{frameworks.find((item) => item.id === framework)?.hint}</span>
				{#if target?.dsn}
					<CopyButton value={target.dsn} label="Copy DSN" />
				{/if}
			</div>
			<div class="rounded-lg border">
				<div class="flex items-center justify-between border-b bg-muted/30 px-3 py-2">
					<span class="font-mono text-xs">{frameworks.find((item) => item.id === framework)?.label}</span>
					<CopyButton value={code()} label="Copy snippet" />
				</div>
				<pre class="overflow-x-auto p-4 text-xs">{code()}</pre>
			</div>
			{#if !target?.dsn}
				<p class="text-xs text-muted-foreground">Create a target above to fill in a real DSN.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<Card.Root>
		<Card.Header>
			<Card.Title class="text-base">3. Verify the pipe</Card.Title>
			<Card.Description>
				Send a synthetic event through the real ingest path, or throw a real exception and check again.
			</Card.Description>
		</Card.Header>
		<Card.Content class="flex flex-wrap items-center gap-2">
			{#if target}
				{#if connected}
					<Badge variant="success"><CheckIcon />First event received</Badge>
					<span class="text-xs text-muted-foreground">{formatDateTime(target.lastSeenAt!)}</span>
					<a class="text-sm text-muted-foreground hover:underline" href="?tab=issues&target={target.id}">
						Open its issues
					</a>
				{:else}
					<Badge variant="info">Waiting for first event</Badge>
				{/if}
				<Button variant="outline" onclick={sendTest}><SendIcon />Send test error</Button>
				<Button variant="outline" disabled={checking} onclick={checkForEvent}>
					<RefreshCwIcon class={checking ? 'animate-spin' : ''} />Check again
				</Button>
				<span class="text-xs text-muted-foreground">
					{target.usage.accepted.toLocaleString()} accepted this month · no events yet? Check that the
					app started after you added the DSN.
				</span>
			{:else}
				<p class="text-sm text-muted-foreground">Create a target above, then send a test.</p>
			{/if}
		</Card.Content>
	</Card.Root>

	<div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
		<ClipboardCopyIcon class="size-4" />
		<span>Already using Sentry? Replace your Sentry DSN with this one. Nothing else changes.</span>
		<a class="hover:underline" href="?tab=targets">See every target and its setup</a>
	</div>
</div>
