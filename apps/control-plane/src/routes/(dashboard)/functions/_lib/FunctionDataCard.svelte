<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import Notice from '#lib/components/yoal/Notice.svelte';
	import type { DatabaseAttachmentView, StorageAttachmentView } from '@yoal/contracts';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import { dataBindingSnippet } from '../../_lib/function-view.js';

	/**
	 * How a function reaches data (docs/FUNCTIONS.md §4.5). Hyperdrive and R2 bind *attached*
	 * resources: the attachment puts the credentials in the host's activation env, and the binding
	 * names the resource in wrangler.jsonc's `yoal` section. KV, D1, Durable Objects, queues and the
	 * cache keep their data on the host itself.
	 */
	let {
		databaseAttachments,
		storageAttachments
	}: {
		databaseAttachments: DatabaseAttachmentView[];
		storageAttachments: StorageAttachmentView[];
	} = $props();

	const snippet = $derived(
		dataBindingSnippet(
			databaseAttachments.map((item) => item.databaseName),
			storageAttachments.map((item) => ({
				name: item.storageName,
				buckets: item.grants.map((grant) => grant.bucket)
			}))
		)
	);
	const attachedAnything = $derived(databaseAttachments.length + storageAttachments.length > 0);
</script>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-4">
		<Card.Title>Bind attached data</Card.Title>
		<Card.Description>
			Attach a Postgres database or a storage instance below, then name it in wrangler.jsonc. A
			Hyperdrive or R2 binding to something that is not attached fails the deploy with that reason.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4 py-4">
		<CodeBlock
			label={attachedAnything
				? 'wrangler.jsonc · for what is attached'
				: 'wrangler.jsonc · example'}
			code={snippet}
		/>
		<Notice tone="info" title="Data kept on the host">
			KV, D1, Durable Objects, queues and the cache store their data on the function's node, which
			keeps it to one host. Snapshot backups of that data are not built yet; keep anything you
			cannot lose in a managed database or bucket.
		</Notice>
	</Card.Content>
</Card.Root>
