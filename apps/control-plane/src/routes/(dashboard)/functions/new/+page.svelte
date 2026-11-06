<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import ZapIcon from '@lucide/svelte/icons/zap';
	import { WORKERD_MAX_COMPATIBILITY_DATE, WORKERD_PINNED_VERSION } from '@skiff/contracts';
	import FormFeedback from '#lib/components/skiff/FormFeedback.svelte';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import * as Field from '#lib/components/ui/field/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import AccessSelect from '../../_lib/AccessSelect.svelte';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import type { PageProps } from './$types';

	interface CreateResult {
		message?: string;
		fieldErrors?: Record<string, string>;
		values?: Record<string, string>;
	}

	let { data, form }: PageProps = $props();
	const result = $derived(form as CreateResult | null);

	let name = $state('');
	let slug = $state('');
	let slugEdited = $state(false);
	let placement = $state('auto');
	let productionAccess = $state('public');
	let previewAccess = $state('platform');
	let submitting = $state(false);

	/** Mirrors the server's slug rules closely enough for a preview; the server decides. */
	const derivedSlug = $derived(
		name
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40)
	);
	const shownSlug = $derived(slugEdited ? slug : derivedSlug);

	const placementChoices = $derived([
		{ value: 'auto', label: 'Auto — the node with the most free slice budget' },
		{ value: 'edge', label: 'Edge node' },
		...data.capacity
			.filter((item) => item.mode !== 'edge')
			.map((item) => ({
				value: item.nodeId,
				label: `${item.name} (${item.mode}) · ${item.freeMemoryMb} MB free`
			}))
	]);

	const features = [
		'Runs ordinary Workers code on workerd, the same runtime skif wrangler dev uses locally',
		'KV, D1, Durable Objects, queues, cache, R2, Hyperdrive and Analytics Engine bindings',
		'Cron triggers fired from the node, and invocation logs for every request',
		'Scales to zero when idle; stateless functions can run several replicas',
		'Immutable deployments with preview URLs, promote and one-click rollback',
		'Private egress blocked by default; only the bindings you declare are reachable'
	];

	const quickstart = `npm create cloudflare@latest my-function -- --type hello-world
cd my-function
skif wrangler dev      # same runtime, locally
skif deploy            # creates the function if it does not exist`;
</script>

<svelte:head>
	<title>Create a function · Skiff</title>
</svelte:head>

<div class="mx-auto max-w-6xl space-y-6">
	<div class="space-y-3">
		<a
			href={resolve('/(dashboard)/functions')}
			class="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
		>
			<ChevronLeftIcon class="size-4" />Functions
		</a>
		<div class="flex items-start gap-3">
			<span
				class="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand"
			>
				<ZapIcon class="size-5" />
			</span>
			<div class="space-y-1">
				<h1 class="text-2xl font-semibold tracking-tight">Create a function</h1>
				<p class="max-w-2xl text-sm text-muted-foreground">
					A Workers-compatible function with its own URL, deployments and secrets. Create it here to
					choose placement and access first, or just run <code class="font-mono text-xs"
						>skif deploy</code
					>
					in a Wrangler project and it is created for you.
				</p>
			</div>
		</div>
	</div>

	<div class="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
		<form
			method="POST"
			enctype="multipart/form-data"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update({ reset: false });
					submitting = false;
				};
			}}
		>
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title>Basics</Card.Title>
					<Card.Description>The name is for people; the slug is the address.</Card.Description>
				</Card.Header>
				<Card.Content class="py-5">
					<Field.Group>
						<FormFeedback {result} />
						<Field.Field data-invalid={result?.fieldErrors?.name ? true : undefined}>
							<Field.Label for="fn-name">Name</Field.Label>
							<Input
								id="fn-name"
								name="name"
								bind:value={name}
								placeholder="Image resizer"
								maxlength={120}
								required
								autocomplete="off"
							/>
							{#if result?.fieldErrors?.name}<Field.Error>{result.fieldErrors.name}</Field.Error
								>{/if}
						</Field.Field>
						<Field.Field data-invalid={result?.fieldErrors?.slug ? true : undefined}>
							<Field.Label for="fn-slug">
								Slug <span class="font-normal text-muted-foreground">optional</span>
							</Field.Label>
							<Input
								id="fn-slug"
								name="slug"
								bind:value={slug}
								oninput={() => (slugEdited = slug.length > 0)}
								placeholder={derivedSlug || 'image-resizer'}
								class="font-mono text-sm"
								autocomplete="off"
							/>
							<Field.Description>
								Served at <span class="font-mono"
									>{shownSlug || 'your-function'}.{data.contentDomain}</span
								>. Slugs are globally unique.
							</Field.Description>
							{#if result?.fieldErrors?.slug}<Field.Error>{result.fieldErrors.slug}</Field.Error
								>{/if}
						</Field.Field>
					</Field.Group>
				</Card.Content>

				<Card.Header class="border-y py-4">
					<Card.Title>Placement and access</Card.Title>
					<Card.Description>
						Where the workerd host runs, and who may call it. Both can change later.
					</Card.Description>
				</Card.Header>
				<Card.Content class="py-5">
					<Field.Group>
						<Field.Field>
							<Field.Label for="fn-placement">Placement</Field.Label>
							<NativeSelect.Root
								id="fn-placement"
								name="placement"
								bind:value={placement}
								class="w-full"
							>
								{#each placementChoices as option (option.value)}
									<NativeSelect.Option value={option.value}>{option.label}</NativeSelect.Option>
								{/each}
							</NativeSelect.Root>
							<Field.Description>
								Each function reserves 128 MB of the node's workload slice by default; the bundle
								can ask for more.
							</Field.Description>
						</Field.Field>
						<div class="grid gap-4 sm:grid-cols-2">
							<Field.Field>
								<Field.Label for="fn-prod-access">Production access</Field.Label>
								<AccessSelect
									id="fn-prod-access"
									name="productionAccess"
									bind:value={productionAccess}
									invalid={Boolean(result?.fieldErrors?.productionAccess)}
								/>
							</Field.Field>
							<Field.Field>
								<Field.Label for="fn-preview-access">Preview access</Field.Label>
								<AccessSelect
									id="fn-preview-access"
									name="previewAccess"
									bind:value={previewAccess}
									invalid={Boolean(result?.fieldErrors?.previewAccess)}
								/>
							</Field.Field>
						</div>
					</Field.Group>
				</Card.Content>

				{#if data.canDeploy}
					<Card.Header class="border-y py-4">
						<Card.Title>
							Bundle <span class="text-sm font-normal text-muted-foreground">optional</span>
						</Card.Title>
						<Card.Description>
							A built Worker as a .zip (index.js or worker.js at the root, assets in public/). It is
							deployed and promoted as soon as the function exists, with this function's secrets
							bound.
						</Card.Description>
					</Card.Header>
					<Card.Content class="py-5">
						<Field.Field data-invalid={result?.fieldErrors?.bundle ? true : undefined}>
							<Field.Label for="fn-bundle" class="sr-only">Bundle</Field.Label>
							<Input id="fn-bundle" name="bundle" type="file" accept=".zip,application/zip" />
							{#if result?.fieldErrors?.bundle}<Field.Error>{result.fieldErrors.bundle}</Field.Error
								>{/if}
						</Field.Field>
					</Card.Content>
				{/if}

				<Card.Footer class="flex justify-end gap-2 border-t py-4">
					<Button variant="ghost" href={resolve('/(dashboard)/functions')}>Cancel</Button>
					<Button type="submit" disabled={submitting}>
						{#if submitting}<Spinner />{:else}<ZapIcon />{/if}
						Create function
					</Button>
				</Card.Footer>
			</Card.Root>
		</form>

		<div class="space-y-5">
			<Card.Root class="gap-0 py-0">
				<Card.Header class="border-b py-4">
					<Card.Title>What you get</Card.Title>
				</Card.Header>
				<Card.Content class="py-4">
					<ul class="space-y-2.5">
						{#each features as feature (feature)}
							<li class="flex gap-2 text-sm">
								<CircleCheckIcon class="mt-0.5 size-4 shrink-0 text-success" />
								<span>{feature}</span>
							</li>
						{/each}
					</ul>
				</Card.Content>
			</Card.Root>
			<CodeBlock label="start locally" code={quickstart} />
			<p class="text-xs text-muted-foreground">
				workerd <span class="font-mono">{WORKERD_PINNED_VERSION}</span> · compatibility dates up to
				<span class="font-mono">{WORKERD_MAX_COMPATIBILITY_DATE}</span>
			</p>
		</div>
	</div>
</div>
