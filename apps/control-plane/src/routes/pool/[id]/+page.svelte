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

{#if !data.user.emailVerified}
	<div class="pool-notice">
		Your email address is not verified yet. Some pool features may be limited until you follow the
		link we sent.
	</div>
	{#if (data as { form?: { sent?: boolean } | null }).form?.sent}
		<div class="pool-notice">A fresh verification link is on its way.</div>
	{:else}
		<form method="POST" action="?/resend" class="pool-resend">
			<input type="hidden" name="csrf" value={data.csrf} />
			<button class="pool-submit" type="submit">Resend verification email</button>
		</form>
	{/if}
{/if}

<div class="pool-alt">
	<a href={`/pool/${data.pool.id}/logout`}>Sign out</a>
</div>

<style>
	.pool-resend {
		margin-bottom: 1rem;
	}
</style>
