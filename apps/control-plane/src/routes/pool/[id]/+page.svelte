<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head>
	<title>Signed in · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

<p style="margin-bottom: 1rem; font-size: 0.9rem; color: #374151;">
	Signed in as <strong>{data.user.email}</strong>.
</p>

<div class="pool-alt">
	<a href={`/pool/${data.pool.id}/logout`}>Sign out</a>
</div>
