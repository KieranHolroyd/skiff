<script lang="ts">
	import * as Card from '#lib/components/ui/card/index.js';
	import RocketIcon from '@lucide/svelte/icons/rocket';
	import CodeBlock from '../../_lib/CodeBlock.svelte';
	import { deployCommands, starterWorker, starterWrangler } from '../../_lib/function-view.js';

	/**
	 * First-deploy guide. The Wrangler file is the only config a user keeps: `skif deploy` bundles
	 * with Wrangler, generates the internal manifest and deploys (FN8).
	 */
	let { slug }: { slug: string } = $props();
</script>

<Card.Root class="gap-0 py-0">
	<Card.Header class="border-b py-4">
		<Card.Title class="flex items-center gap-2">
			<RocketIcon class="size-4 text-muted-foreground" />
			Deploy your first function
		</Card.Title>
		<Card.Description>
			Write ordinary Workers code. <code class="font-mono text-xs">skif deploy</code> finds
			<code class="font-mono text-xs">wrangler.jsonc</code>, bundles with Wrangler (installing it if
			needed) and deploys. The same project still deploys to Cloudflare.
		</Card.Description>
	</Card.Header>
	<Card.Content class="space-y-4 py-4">
		<div class="grid gap-4 lg:grid-cols-2">
			<CodeBlock label="wrangler.jsonc" code={starterWrangler(slug)} />
			<CodeBlock label="src/index.ts" code={starterWorker()} />
		</div>
		<CodeBlock label="terminal" code={deployCommands(slug)} />
		<p class="text-xs text-muted-foreground">
			Bindings map by name: <code class="font-mono">vars</code>, KV, D1, Durable Objects, queues,
			Analytics Engine, assets and services work as written. Hyperdrive and R2 also need the
			database or storage attached under <span class="font-medium text-foreground">Data</span> and
			named in the <code class="font-mono">skiff</code> section. Project secrets are bound automatically.
		</p>
	</Card.Content>
</Card.Root>
