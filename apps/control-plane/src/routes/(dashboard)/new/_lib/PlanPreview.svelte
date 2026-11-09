<script lang="ts">
	import BoxIcon from '@lucide/svelte/icons/box';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import CircleXIcon from '@lucide/svelte/icons/circle-x';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import LockKeyholeIcon from '@lucide/svelte/icons/lock-keyhole';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import ShieldIcon from '@lucide/svelte/icons/shield';
	import { githubRunnerLabels, type TemplatePlan } from '@yoal/contracts';
	import type { Component, Snippet } from 'svelte';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import ProjectMark from '../../_lib/ProjectMark.svelte';
	import { formatMb, reservedMb } from './template-form.js';

	/**
	 * What the template will create, straight from its plan: the project, the workload, the
	 * secrets (names only) and the first deployment. `stale` dims the last good plan while the
	 * form has problems, so the preview never jumps back to empty while someone is typing.
	 */
	let {
		plan,
		stale = false,
		slug,
		secretNames
	}: {
		plan: TemplatePlan;
		stale?: boolean;
		/** The slug the project will get (typed or derived). */
		slug: string;
		/** Organisation secret names, or null when the viewer cannot list them. */
		secretNames: string[] | null;
	} = $props();

	const spec = $derived(plan.spec);
	const replicas = $derived(spec.replicas ?? 1);
	const total = $derived(reservedMb(plan));
	const image = $derived(spec.image ?? spec.command?.join(' ') ?? '');
	const imageShort = $derived(image.replace(/^[^/]+\.[^/]+\//, ''));
	const runsOn = $derived(spec.runner ? githubRunnerLabels(spec.runner) : null);
	const known = $derived(secretNames ? new Set(secretNames) : null);
</script>

{#snippet row(icon: Component<{ class?: string }>, title: string, body: Snippet)}
	{@const Icon = icon}
	<li class="group/row relative flex gap-3 pb-4 last:pb-0">
		<span
			class="absolute top-7 bottom-0 left-[13px] w-px bg-border group-last/row:hidden"
			aria-hidden="true"
		></span>
		<span
			class="relative z-10 flex size-7 shrink-0 items-center justify-center rounded-md border bg-background text-muted-foreground"
		>
			<Icon class="size-3.5" />
		</span>
		<div class="min-w-0 flex-1 space-y-1 pt-0.5">
			<p class="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
			{@render body()}
		</div>
	</li>
{/snippet}

<div class="space-y-5 transition-opacity duration-300 {stale ? 'opacity-45 saturate-50' : ''}">
	<ol class="text-sm">
		{#snippet projectBody()}
			<div class="flex items-center gap-2.5">
				<ProjectMark slug={slug || 'project'} name={plan.project.name} />
				<div class="min-w-0">
					<p class="truncate font-medium">{plan.project.name}</p>
					<p class="truncate font-mono text-xs text-muted-foreground">{slug}</p>
				</div>
			</div>
			<p class="flex items-center gap-1 text-xs text-muted-foreground">
				<ShieldIcon class="size-3" />Platform login only · {plan.project.runtime}
			</p>
		{/snippet}
		{@render row(BoxIcon, 'Project', projectBody)}

		{#snippet workloadBody()}
			<p class="truncate font-mono text-xs" title={image}>{imageShort}</p>
			<div class="flex flex-wrap gap-1.5 pt-0.5" aria-label="{replicas} copies">
				{#each { length: Math.min(replicas, 12) }, index (index)}
					<span
						class="flex h-6 min-w-6 animate-in items-center justify-center rounded border bg-muted/50 px-1 font-mono text-[0.65rem] text-muted-foreground zoom-in-90 fade-in"
						style:animation-delay="{index * 30}ms">{index + 1}</span
					>
				{/each}
				{#if replicas > 12}
					<span class="self-center font-mono text-xs text-muted-foreground">+{replicas - 12}</span>
				{/if}
			</div>
			<dl class="grid grid-cols-3 gap-2 pt-1 text-xs">
				<div>
					<dt class="text-muted-foreground">Each</dt>
					<dd class="font-mono tabular-nums">{formatMb(spec.memoryMb)}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">CPU each</dt>
					<dd class="font-mono tabular-nums">{spec.cpus ?? '—'}</dd>
				</div>
				<div>
					<dt class="text-muted-foreground">Reserves</dt>
					<dd class="font-mono font-medium tabular-nums">{formatMb(total)}</dd>
				</div>
			</dl>
			{#if spec.ingress === 'none'}
				<p class="text-xs text-muted-foreground">No public route; outbound connections only.</p>
			{/if}
		{/snippet}
		{@render row(
			LockKeyholeIcon,
			replicas === 1 ? 'Workload' : `Workload · ${replicas} copies`,
			workloadBody
		)}

		{#if plan.secrets.length > 0 || plan.requiredSecrets.length > 0}
			{#snippet secretsBody()}
				<ul class="space-y-1">
					{#each plan.secrets as secret (secret.name)}
						<li class="flex items-center justify-between gap-2">
							<span class="truncate font-mono text-xs">{secret.name}</span>
							<span
								class="shrink-0 rounded bg-success/10 px-1.5 text-[0.65rem] font-medium text-success"
								>new · encrypted</span
							>
						</li>
					{/each}
					{#each plan.requiredSecrets as name (name)}
						{@const found = known?.has(name)}
						<li class="flex items-center justify-between gap-2">
							<span class="truncate font-mono text-xs">{name}</span>
							{#if known === null}
								<span class="shrink-0 text-[0.65rem] text-muted-foreground">existing</span>
							{:else if found}
								<span class="inline-flex shrink-0 items-center gap-1 text-[0.65rem] text-success"
									><CircleCheckIcon class="size-3" />found</span
								>
							{:else}
								<span
									class="inline-flex shrink-0 items-center gap-1 text-[0.65rem] text-destructive"
									><CircleXIcon class="size-3" />not found</span
								>
							{/if}
						</li>
					{/each}
				</ul>
			{/snippet}
			{@render row(KeyRoundIcon, 'Secrets', secretsBody)}
		{/if}

		{#snippet deployBody()}
			<p class="text-xs text-muted-foreground">
				Recorded as <code class="font-mono">yoal-template.json</code> and promoted to production.
			</p>
		{/snippet}
		{@render row(RocketIcon, 'First deployment', deployBody)}
	</ol>

	{#if runsOn}
		<CodeBlock
			label=".github/workflows/ci.yml"
			code={`jobs:\n  build:\n    runs-on: [${runsOn.join(', ')}]`}
		/>
	{/if}
</div>
