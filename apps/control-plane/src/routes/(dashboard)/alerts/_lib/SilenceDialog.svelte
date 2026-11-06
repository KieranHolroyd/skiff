<script lang="ts" module>
	import type { AlertMatcher } from '@skiff/contracts';

	export interface SilencePreset {
		ruleId: string | null;
		matchers: AlertMatcher[];
		/** Shown in the description, e.g. the series being silenced. */
		subject?: string;
	}
</script>

<script lang="ts">
	/**
	 * Create a silence: one rule (or every rule, a maintenance window), label matchers that must
	 * all match a series, and how long. Opened prefilled from an alert's rule and labels.
	 */
	import { useQueryClient } from '@tanstack/svelte-query';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import PlusIcon from '@lucide/svelte/icons/plus';
	import XIcon from '@lucide/svelte/icons/x';
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Dialog from '#lib/components/ui/dialog/index.js';
	import { Input } from '#lib/components/ui/input/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { Spinner } from '#lib/components/ui/spinner/index.js';
	import { Textarea } from '#lib/components/ui/textarea/index.js';
	import { errorText } from '#lib/query.js';
	import { formatDateTime } from '../../_lib/format.js';
	import { createSilence, keys } from './api.js';
	import { SILENCE_DURATIONS } from './rules.js';

	let {
		open = $bindable(false),
		rules,
		preset = null
	}: {
		open?: boolean;
		rules: Array<{ id: string; name: string }>;
		preset?: SilencePreset | null;
	} = $props();

	const queryClient = useQueryClient();
	const DURATION_OPTIONS = [
		...SILENCE_DURATIONS.map((item) => ({ value: String(item.minutes), label: item.label })),
		{ value: 'custom', label: 'Custom…' }
	];

	let ruleId = $state('');
	let matchers = $state<AlertMatcher[]>([]);
	let duration = $state('60');
	let endsAt = $state('');
	let comment = $state('');
	let saving = $state(false);
	let failure = $state<string | null>(null);

	/** `YYYY-MM-DDTHH:mm` in local time, for a datetime-local input. */
	function localInput(ms: number): string {
		const date = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
		return date.toISOString().slice(0, 16);
	}

	// Reset from the preset each time the dialog opens.
	$effect(() => {
		if (!open) return;
		untrack(() => {
			ruleId = preset?.ruleId ?? '';
			matchers = (preset?.matchers ?? []).map((matcher) => ({ ...matcher }));
			duration = '60';
			endsAt = localInput(Date.now() + 2 * 3_600_000);
			comment = '';
			failure = null;
		});
	});

	const until = $derived.by(() => {
		if (duration === 'custom') {
			const ms = Date.parse(endsAt);
			return Number.isFinite(ms) ? ms : null;
		}
		return Date.now() + Number(duration) * 60_000;
	});

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		failure = null;
		const cleaned = matchers
			.map((matcher) => ({ label: matcher.label.trim(), value: matcher.value }))
			.filter((matcher) => matcher.label);
		if (duration === 'custom' && (until === null || until <= Date.now())) {
			failure = 'Pick an end time in the future.';
			return;
		}
		saving = true;
		try {
			const silence = await createSilence({
				ruleId: ruleId || null,
				matchers: cleaned,
				comment: comment.trim(),
				...(duration === 'custom'
					? { endsAt: new Date(until!).toISOString() }
					: { durationMinutes: Number(duration) })
			});
			toast.success(`Silenced until ${formatDateTime(silence.endsAt)}`);
			void queryClient.invalidateQueries({ queryKey: keys.all });
			open = false;
		} catch (error) {
			failure = errorText(error, 'Could not create the silence.');
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<form class="contents" onsubmit={submit}>
			<Dialog.Header>
				<Dialog.Title>Silence alerts</Dialog.Title>
				<Dialog.Description>
					{preset?.subject
						? `Mutes notifications for ${preset.subject}. The alert still shows here as silenced.`
						: 'Mutes notifications for matching series. Alerts still show here, marked as silenced.'}
				</Dialog.Description>
			</Dialog.Header>

			<div class="grid gap-4">
				<label class="block space-y-1.5">
					<span class="text-sm font-medium">Rule</span>
					<NativeSelect.Root bind:value={ruleId} class="w-full" aria-label="Rule">
						<NativeSelect.Option value="">Every rule (maintenance window)</NativeSelect.Option>
						{#each rules as rule (rule.id)}
							<NativeSelect.Option value={rule.id}>{rule.name}</NativeSelect.Option>
						{/each}
					</NativeSelect.Root>
				</label>

				<fieldset class="space-y-1.5">
					<legend class="text-sm font-medium">Matching labels</legend>
					<p class="text-xs text-muted-foreground">
						Every label must match. None silences every series of the rule{ruleId ? '' : 's'}.
					</p>
					{#each matchers as matcher, index (index)}
						<div class="flex items-center gap-1.5">
							<Input
								class="h-8 w-36 font-mono text-xs"
								bind:value={matcher.label}
								placeholder="label"
								aria-label="Label name"
								maxlength={64}
							/>
							<span class="text-muted-foreground" aria-hidden="true">=</span>
							<Input
								class="h-8 min-w-0 flex-1 font-mono text-xs"
								bind:value={matcher.value}
								placeholder="value"
								aria-label="Label value"
								maxlength={500}
							/>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label="Remove matcher"
								onclick={() => (matchers = matchers.filter((_, at) => at !== index))}
							>
								<XIcon />
							</Button>
						</div>
					{/each}
					<Button
						variant="outline"
						size="sm"
						disabled={matchers.length >= 10}
						onclick={() => (matchers = [...matchers, { label: '', value: '' }])}
						><PlusIcon />Matcher</Button
					>
				</fieldset>

				<fieldset class="space-y-1.5">
					<legend class="text-sm font-medium">Duration</legend>
					<div class="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Duration">
						{#each DURATION_OPTIONS as option (option.value)}
							<button
								type="button"
								role="radio"
								aria-checked={duration === option.value}
								class="rounded-full border px-3 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {duration ===
								option.value
									? 'border-brand/50 bg-brand/10 text-foreground'
									: 'text-muted-foreground hover:bg-muted'}"
								onclick={() => (duration = option.value)}
							>
								{option.label}
							</button>
						{/each}
					</div>
					{#if duration === 'custom'}
						<label class="mt-2 block space-y-1">
							<span class="text-xs text-muted-foreground">Ends at (your local time)</span>
							<Input type="datetime-local" bind:value={endsAt} class="w-auto" required />
						</label>
					{/if}
					{#if until}
						<p class="text-xs text-muted-foreground">Until {formatDateTime(until)}</p>
					{/if}
				</fieldset>

				<label class="block space-y-1.5">
					<span class="text-sm font-medium"
						>Comment <span class="font-normal text-muted-foreground">(optional)</span></span
					>
					<Textarea
						bind:value={comment}
						maxlength={500}
						rows={2}
						placeholder="Why, e.g. planned database upgrade"
					/>
				</label>
			</div>

			{#if failure}<p class="text-sm text-destructive" role="alert">{failure}</p>{/if}

			<Dialog.Footer>
				<Dialog.Close
					>{#snippet child({ props })}<Button {...props} variant="outline">Cancel</Button
						>{/snippet}</Dialog.Close
				>
				<Button type="submit" disabled={saving}>
					{#if saving}<Spinner />{/if}Silence
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
