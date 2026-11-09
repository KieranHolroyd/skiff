<script lang="ts">
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	const error = $derived((data as { form?: { error?: string } | null }).form?.error);
	const inviteOnly = $derived(data.pool.signupMode === 'invite');
	const returnTo = $derived(data.returnTo ?? '');
</script>

<svelte:head>
	<title>Create account · {data.pool.theme.displayName ?? data.pool.name}</title>
</svelte:head>

{#if error}
	<div class="pool-error">{error}</div>
{/if}

{#if inviteOnly && !data.invite}
	<div class="pool-notice">
		This pool is invite-only. Open the invitation link you were sent, or paste its token below.
	</div>
{/if}

<form method="POST">
	<input type="hidden" name="csrf" value={data.csrf} />
	<input type="hidden" name="return_to" value={returnTo} />
	<div class="pool-field">
		<label for="name">Name</label>
		<input id="name" name="name" type="text" autocomplete="name" maxlength="120" />
	</div>
	<div class="pool-field">
		<label for="email">Email</label>
		<input id="email" name="email" type="email" autocomplete="username" required />
	</div>
	<div class="pool-field">
		<label for="password">Password</label>
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
	{#if inviteOnly}
		<div class="pool-field">
			<label for="invite">Invitation token</label>
			<input id="invite" name="invite" type="text" value={data.invite} required />
		</div>
	{/if}
	<button class="pool-submit" type="submit">Create account</button>
</form>

<div class="pool-alt">
	Already have an account? <a href={`/pool/${data.pool.id}/login${returnTo ? `?return_to=${encodeURIComponent(returnTo)}` : ''}`}>Sign in</a>
</div>
