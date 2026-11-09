<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const error = $derived((data as { form?: { error?: string } | null }).form?.error);
</script>

<svelte:head>
	<title>Reset password · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

{#if error}
	<div class="pool-error">{error}</div>
{/if}

{#if !data.token}
	<div class="pool-error">That reset link is invalid or has expired.</div>
{/if}

<form method="POST">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="token" value={data.token} />
	<input type="hidden" name="return_to" value={data.returnTo ?? ''} />
	<div class="pool-field">
		<label for="password">New password</label>
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="new-password"
			minlength="8"
			maxlength="200"
			required
		/>
	</div>
	<div class="pool-field">
		<label for="confirm">Confirm new password</label>
		<input
			id="confirm"
			name="confirm"
			type="password"
			autocomplete="new-password"
			minlength="8"
			maxlength="200"
			required
		/>
	</div>
	<button class="pool-submit" type="submit">Set new password</button>
</form>

<div class="pool-alt">
	<a href={`/pool/${data.pool.id}/login`}>Back to sign in</a>
</div>
