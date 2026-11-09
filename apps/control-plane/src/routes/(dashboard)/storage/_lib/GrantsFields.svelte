<script lang="ts">
	import ArchiveIcon from '@lucide/svelte/icons/archive';
	import type { StorageGrant } from '@yoal/contracts';
	import * as Field from '#lib/components/ui/field/index.js';
	import * as NativeSelect from '#lib/components/ui/native-select/index.js';
	import { GRANT_FIELD_PREFIX } from './grants.js';

	/**
	 * One row per bucket with a no access / read / read-write choice, posted as `grant:<bucket>`
	 * fields (read on the server by `grantsFromForm`). The attachment's scoped key gets exactly these
	 * grants (S4).
	 */
	let {
		buckets,
		grants = [],
		defaultMode = '',
		error,
		idPrefix = 'grant'
	}: {
		buckets: string[];
		grants?: StorageGrant[];
		/** Mode for buckets without a grant in `grants`; blank means no access. */
		defaultMode?: '' | StorageGrant['mode'];
		error?: string;
		idPrefix?: string;
	} = $props();

	const modeOf = (bucket: string) =>
		grants.find((grant) => grant.bucket === bucket)?.mode ?? defaultMode;
</script>

<Field.Set data-invalid={error ? true : undefined}>
	<Field.Legend variant="label">Bucket access</Field.Legend>
	<Field.Description>
		The app's own key can reach only these buckets. Read covers get and list; read-write adds put,
		delete and multipart uploads.
	</Field.Description>
	{#if buckets.length === 0}
		<p class="text-sm text-muted-foreground">This instance has no buckets yet. Create one first.</p>
	{:else}
		<div class="divide-y rounded-lg border">
			{#each buckets as bucket (bucket)}
				<div class="flex items-center justify-between gap-3 px-3 py-2">
					<label
						for="{idPrefix}-{bucket}"
						class="inline-flex min-w-0 items-center gap-2 font-mono text-xs"
					>
						<ArchiveIcon class="size-3.5 shrink-0 text-muted-foreground" />
						<span class="truncate">{bucket}</span>
					</label>
					<NativeSelect.Root
						id="{idPrefix}-{bucket}"
						name="{GRANT_FIELD_PREFIX}{bucket}"
						value={modeOf(bucket)}
						size="sm"
						class="w-36"
					>
						<NativeSelect.Option value="">No access</NativeSelect.Option>
						<NativeSelect.Option value="read">Read</NativeSelect.Option>
						<NativeSelect.Option value="read-write">Read-write</NativeSelect.Option>
					</NativeSelect.Root>
				</div>
			{/each}
		</div>
	{/if}
	{#if error}<Field.Error>{error}</Field.Error>{/if}
</Field.Set>
