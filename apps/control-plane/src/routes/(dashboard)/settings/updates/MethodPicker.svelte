<script lang="ts">
	import type { SelfUpdateMethod } from '@yoal/contracts';
	import { methods } from './update-ui.js';

	/** Radio cards for how the release is obtained; submits as the form field `method`. */
	let {
		value = $bindable(),
		defaultMethod
	}: { value: SelfUpdateMethod; defaultMethod: SelfUpdateMethod } = $props();
</script>

<fieldset class="space-y-2.5">
	<legend class="mb-2.5 text-xs font-medium text-muted-foreground">How to install</legend>
	<div class="grid gap-2 sm:grid-cols-3">
		{#each methods as option (option.value)}
			<label
				class="group relative flex cursor-pointer flex-col gap-2 rounded-lg border bg-background p-3 transition-[border-color,box-shadow,background-color] hover:border-foreground/20 has-checked:border-foreground/40 has-checked:bg-muted/40 has-checked:ring-1 has-checked:ring-foreground/10 has-focus-visible:ring-2 has-focus-visible:ring-ring/50"
			>
				<input type="radio" name="method" value={option.value} bind:group={value} class="sr-only" />
				<span class="flex items-center justify-between gap-2">
					<span
						class="flex size-7 items-center justify-center rounded-md border bg-muted/50 text-muted-foreground transition-colors group-has-checked:border-foreground/20 group-has-checked:bg-foreground group-has-checked:text-background"
						aria-hidden="true"
					>
						<option.icon class="size-3.5" />
					</span>
					<span
						class="flex size-4 items-center justify-center rounded-full border transition-colors group-has-checked:border-foreground group-has-checked:bg-foreground"
						aria-hidden="true"
					>
						<span
							class="size-1.5 rounded-full bg-background opacity-0 transition-opacity group-has-checked:opacity-100"
						></span>
					</span>
				</span>
				<span class="min-w-0">
					<span class="flex items-center gap-1.5 text-sm font-medium">
						{option.label}
						{#if option.value === defaultMethod}
							<span class="text-[0.65rem] font-normal text-muted-foreground">· default</span>
						{/if}
					</span>
					<span class="mt-0.5 block text-xs leading-relaxed text-pretty text-muted-foreground"
						>{option.description}</span
					>
				</span>
			</label>
		{/each}
	</div>
</fieldset>
