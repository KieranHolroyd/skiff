<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Sign out · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

<p style="margin-bottom: 1rem; font-size: 0.9rem; color: #374151;">
	Sign out of {data.pool.theme.displayName ?? data.pool.name}?
</p>

<form method="POST">
	<input type="hidden" name="csrf" value={data.csrf} />
	<button class="pool-submit" type="submit">Sign out</button>
</form>
