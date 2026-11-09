<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const error = $derived((data as { form?: { error?: string } | null }).form?.error);
</script>

<svelte:head>
	<title>Sign in · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

{#if data.verified}
	<div class="pool-notice">Your email address is verified. Sign in to continue.</div>
{/if}
{#if error}
	<div class="pool-error">{error}</div>
{/if}

<form method="POST">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
	<div class="pool-field">
		<label for="email">Email</label>
		<input
			id="email"
			name="email"
			type="email"
			autocomplete="username"
			required
			value={data.email}
		/>
	</div>
	<div class="pool-field">
		<label for="password">Password</label>
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			required
		/>
	</div>
	<button class="pool-submit" type="submit">Sign in</button>
</form>

<div class="pool-alt">
	{#if data.pool.signupMode === 'open'}
		New here? <a href={`/pool/${data.pool.id}/signup${data.returnTo ? `?return_to=${encodeURIComponent(data.returnTo)}` : ''}`}>Create an account</a>
	{:else}
		This pool is invite-only. Ask an administrator for an invitation.
	{/if}
</div>
