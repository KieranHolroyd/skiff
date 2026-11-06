<script lang="ts">
	import { page } from '$app/state';
	import type { OperationActionId } from '@skiff/contracts';
	import Notice from '#lib/components/skiff/Notice.svelte';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import * as AlertDialog from '#lib/components/ui/alert-dialog/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import type { BulkController } from './bulk.svelte.js';
	import { countLabel, reasonLabel } from './copy.js';

	/** The confirm dialog for a bulk action, built from the server's plan. */
	let { controller, contentDomain }: { controller: BulkController; contentDomain: string } =
		$props();

	/** Settings → Policies trash period; the layout loads it. */
	const trashDays = $derived<number>(page.data.policies?.trashDays ?? 7);

	const PREVIEW = 10;

	let typed = $state('');
	let pending = $state(false);

	const plan = $derived(controller.plan);
	const info = $derived(plan?.info);
	const ready = $derived(plan?.items.filter((item) => item.verdict === 'ok') ?? []);
	const skipped = $derived(plan?.items.filter((item) => item.verdict === 'skip') ?? []);
	const blocked = $derived(plan?.items.filter((item) => item.verdict === 'blocked') ?? []);
	const live = $derived(ready.filter((item) => item.flags.includes('live')));
	const workloads = $derived(ready.filter((item) => item.flags.includes('workload')).length);
	const domains = $derived(ready.filter((item) => item.flags.includes('custom_domain')).length);
	const destructive = $derived(info?.destructive ?? false);
	const irreversible = $derived(info ? !info.reversible : false);
	const needsTyping = $derived(
		ready.length > 0 && (irreversible || (destructive && (ready.length >= 5 || live.length > 0)))
	);
	const expected = $derived(String(ready.length));
	const blockedByTyping = $derived(needsTyping && typed.trim() !== expected);

	const descriptions: Partial<Record<OperationActionId, string>> = $derived({
		'project.delete': `They move to the trash and are kept for ${trashDays} days. You can restore them until then.`,
		'project.restore': 'They come back with their deployments and settings.',
		'project.purge':
			'This permanently deletes them with their deployments, releases and domains. It cannot be undone.'
	});
	const description = $derived(
		info
			? (descriptions[info.id] ??
					`${info.label}.${info.reversible ? '' : ' This cannot be undone.'}`)
			: ''
	);

	$effect(() => {
		// Reset the typed confirmation whenever a new plan opens.
		void plan?.operation.id;
		typed = '';
		pending = false;
	});

	async function confirm() {
		if (blockedByTyping || pending || ready.length === 0) return;
		pending = true;
		await controller.confirm();
		pending = false;
	}

	function close() {
		if (pending) return;
		controller.dismiss();
	}
</script>

<AlertDialog.Root open={plan !== null} onOpenChange={(open) => !open && close()}>
	<AlertDialog.Content class="sm:max-w-lg">
		{#if plan && info}
			<AlertDialog.Header>
				<AlertDialog.Title class={irreversible ? 'text-destructive' : ''}>
					{#if ready.length > 0}
						{info.verb} {countLabel(ready.length)}?
					{:else}
						Nothing to {info.verb.toLowerCase()}
					{/if}
				</AlertDialog.Title>
				<AlertDialog.Description>
					{ready.length > 0
						? description
						: 'None of the selected projects can be changed. See the reasons below.'}
				</AlertDialog.Description>
			</AlertDialog.Header>

			<div class="max-h-[55vh] space-y-4 overflow-y-auto text-sm">
				<div class="flex flex-wrap gap-1.5">
					<Badge variant="success" class="tabular-nums">{ready.length} ready</Badge>
					{#if skipped.length}<Badge variant="neutral" class="tabular-nums"
							>{skipped.length} skipped</Badge
						>{/if}
					{#if blocked.length}<Badge variant="danger" class="tabular-nums"
							>{blocked.length} blocked</Badge
						>{/if}
				</div>

				{#if destructive && live.length}
					<Notice tone="warning" title="{countLabel(live.length)} serving production">
						{live.map((item) => item.label).join(', ')}
						{live.length === 1 ? 'goes' : 'go'} offline at
						<span class="font-mono">*.{contentDomain}</span>.
					</Notice>
				{/if}
				{#if destructive && (workloads || domains)}
					<ul class="list-disc space-y-0.5 pl-5 text-muted-foreground">
						{#if workloads}<li>
								{countLabel(workloads)}
								{workloads === 1 ? 'runs' : 'run'} a workload that will be stopped.
							</li>{/if}
						{#if domains}<li>
								{countLabel(domains)}
								{domains === 1 ? 'has' : 'have'} custom domains that stop resolving to Skiff.
							</li>{/if}
					</ul>
				{/if}

				{#if ready.length}
					<div class="space-y-1.5">
						<p class="text-xs font-medium text-muted-foreground uppercase">Projects</p>
						<div class="flex flex-wrap gap-1.5">
							{#each ready.slice(0, PREVIEW) as item (item.seq)}
								<code class="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{item.label}</code>
							{/each}
							{#if ready.length > PREVIEW}
								<span class="self-center text-xs text-muted-foreground"
									>and {ready.length - PREVIEW} more</span
								>
							{/if}
						</div>
					</div>
				{/if}

				{#if skipped.length || blocked.length}
					<div class="space-y-1.5">
						<p class="text-xs font-medium text-muted-foreground uppercase">Not included</p>
						<ul class="divide-y rounded-md border">
							{#each [...blocked, ...skipped] as item (item.seq)}
								<li class="flex items-center justify-between gap-3 px-3 py-1.5">
									<span class="truncate font-mono text-xs">{item.label ?? item.targetId}</span>
									<span
										class="shrink-0 text-xs {item.verdict === 'blocked'
											? 'text-destructive'
											: 'text-muted-foreground'}">{reasonLabel(item.reason)}</span
									>
								</li>
							{/each}
						</ul>
					</div>
				{/if}

				{#if needsTyping}
					<Field.Field>
						<Field.Label for="bulk-confirm-count">
							Type <code class="rounded bg-muted px-1 py-0.5 font-mono text-xs">{expected}</code> to confirm
						</Field.Label>
						<Input
							id="bulk-confirm-count"
							bind:value={typed}
							inputmode="numeric"
							autocomplete="off"
							spellcheck="false"
							onkeydown={(event) => event.key === 'Enter' && confirm()}
						/>
					</Field.Field>
				{/if}
			</div>

			<AlertDialog.Footer>
				<AlertDialog.Cancel disabled={pending}>Cancel</AlertDialog.Cancel>
				{#if ready.length}
					<Button
						variant={destructive ? 'destructive' : 'default'}
						disabled={pending || blockedByTyping}
						onclick={confirm}
					>
						{#if pending}<Spinner />{/if}
						{info.verb}
						{countLabel(ready.length)}
					</Button>
				{/if}
			</AlertDialog.Footer>
		{/if}
	</AlertDialog.Content>
</AlertDialog.Root>
