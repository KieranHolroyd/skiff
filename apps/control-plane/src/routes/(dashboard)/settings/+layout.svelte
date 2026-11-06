<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import ChevronsUpDownIcon from '@lucide/svelte/icons/chevrons-up-down';
	import ShieldCheckIcon from '@lucide/svelte/icons/shield-check';
	import { Badge } from '#lib/components/ui/badge/index.js';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as DropdownMenu from '#lib/components/ui/dropdown-menu/index.js';
	import PageHeader from '../_lib/PageHeader.svelte';
	import NavHint from './_lib/NavHint.svelte';
	import { roleBadge } from './_lib/roles.js';
	import {
		GROUP_LABELS,
		GROUP_ORDER,
		sectionForPath,
		visibleSections,
		type Section
	} from './_lib/sections.js';

	let { data, children } = $props();

	const sections = $derived(
		visibleSections({
			platformAdmin: data.can.manageNodes,
			role: data.role,
			permissions: data.permissions
		})
	);

	const groups = $derived(
		GROUP_ORDER.map((group) => ({
			id: group,
			label: GROUP_LABELS[group],
			items: sections.filter((entry) => entry.group === group)
		})).filter((group) => group.items.length > 0)
	);

	const current = $derived(sectionForPath(page.url.pathname, sections));

	const article = $derived(['admin', 'owner'].includes(data.role) ? 'an' : 'a');

	/** The permission table on Settings → General. */
	const accessHref = `${resolve('/(dashboard)/settings')}#access`;
</script>

{#snippet navLink(entry: Section, onclick?: () => void)}
	{@const active = current?.id === entry.id}
	<a
		href={resolve(entry.href)}
		aria-current={active ? 'page' : undefined}
		data-skiff-target={`settings.tab.${entry.id}`}
		{onclick}
		class="group relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-muted-foreground transition-colors outline-none hover:bg-muted/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 aria-[current=page]:bg-muted aria-[current=page]:font-medium aria-[current=page]:text-foreground"
	>
		<span
			class="absolute inset-y-1.5 -left-3 w-0.5 rounded-full bg-brand opacity-0 transition-opacity group-aria-[current=page]:opacity-100"
			aria-hidden="true"
		></span>
		<entry.icon
			class="size-4 shrink-0 transition-colors group-hover:text-foreground group-aria-[current=page]:text-brand"
		/>
		<span class="truncate">{entry.label}</span>
		<NavHint id={entry.id} hints={data.hints} update={data.updateAvailable} />
	</a>
{/snippet}

<div class="space-y-6 lg:space-y-8">
	<PageHeader
		target="page.settings"
		eyebrow={data.org.name}
		title="Settings"
		description="You, the organisation you are signed in to, and the Skiff platform it runs on."
	>
		<span class="flex items-center gap-2 text-sm text-muted-foreground">
			Signed in as <span class="font-medium text-foreground">{data.user.name}</span>
			<Badge variant={roleBadge(data.role)} class="capitalize">{data.role}</Badge>
		</span>
	</PageHeader>

	<div class="grid gap-6 lg:grid-cols-[13.5rem_minmax(0,1fr)] lg:gap-10 xl:gap-14">
		<!-- Small screens: one menu instead of a row of tabs that would overflow. -->
		<div class="lg:hidden">
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							variant="outline"
							class="h-11 w-full justify-start gap-3 px-3"
							aria-label="Settings section"
							{...props}
						>
							{#if current}
								<current.icon class="text-brand" />
								<span class="flex min-w-0 flex-col items-start leading-tight">
									<span class="text-[0.7rem] font-normal text-muted-foreground"
										>{GROUP_LABELS[current.group]}</span
									>
									<span class="truncate">{current.label}</span>
								</span>
							{:else}
								Choose a section
							{/if}
							<ChevronsUpDownIcon class="ml-auto text-muted-foreground" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-(--bits-dropdown-menu-anchor-width) min-w-64">
					{#each groups as group, index (group.id)}
						{#if index > 0}<DropdownMenu.Separator />{/if}
						<DropdownMenu.Group>
							<DropdownMenu.GroupHeading class="text-xs font-normal text-muted-foreground"
								>{group.label}</DropdownMenu.GroupHeading
							>
							{#each group.items as entry (entry.id)}
								<DropdownMenu.Item
									onSelect={() => goto(resolve(entry.href))}
									class={current?.id === entry.id ? 'bg-muted font-medium' : ''}
								>
									<entry.icon class={current?.id === entry.id ? 'text-brand' : ''} />
									<span class="flex-1">{entry.label}</span>
									<NavHint id={entry.id} hints={data.hints} update={data.updateAvailable} />
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.Group>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		</div>

		<!-- Large screens: a sticky, grouped section list. -->
		<aside class="hidden lg:block">
			<nav aria-label="Settings sections" class="sticky top-20 space-y-6 pl-3">
				{#each groups as group (group.id)}
					<div class="space-y-1">
						<p
							class="flex items-baseline gap-1.5 px-2.5 pb-1 text-xs font-medium text-muted-foreground"
						>
							{group.label}
							{#if group.id === 'organisation'}
								<span class="truncate font-normal text-muted-foreground/70">· {data.org.name}</span>
							{/if}
						</p>
						{#each group.items as entry (entry.id)}
							{@render navLink(entry)}
						{/each}
					</div>
				{/each}

				<Button
					href={accessHref}
					variant="ghost"
					class="mx-0.5 h-auto w-auto items-start justify-start gap-2.5 rounded-lg border border-dashed border-border px-3 py-2.5 text-left text-xs font-normal whitespace-normal text-muted-foreground hover:border-solid hover:bg-muted/40"
				>
					<ShieldCheckIcon class="mt-px size-3.5 shrink-0" />
					<span>
						What can {article} <span class="font-medium capitalize">{data.role}</span> do? See every permission
						your role holds.
					</span>
				</Button>
			</nav>
		</aside>

		<div class="min-w-0 space-y-6">
			{@render children()}
		</div>
	</div>
</div>
