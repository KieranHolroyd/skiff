<script lang="ts">
	import { Button } from '#lib/components/ui/button/index.js';
	import * as Card from '#lib/components/ui/card/index.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<main class="flex min-h-svh items-center justify-center p-6">
	<Card.Root class="w-full max-w-md">
		<Card.Header>
			<Card.Title>Authorize the Skiff CLI</Card.Title>
			<Card.Description>
				The CLI will receive an API key for {data.email ?? data.name ?? 'your account'}.
			</Card.Description>
		</Card.Header>
		<Card.Content class="space-y-3 text-sm">
			<p>
				Only continue if you just ran <code class="rounded bg-muted px-1 py-0.5">skif login --web</code>
				on this machine.
			</p>
			<p class="text-muted-foreground">
				The key gets the same access as your account{data.role ? ` (${data.role})` : ''}. You can
				revoke it later on the settings page.
			</p>
		</Card.Content>
		<Card.Footer>
			<form method="POST" class="flex w-full justify-end gap-2">
				<input type="hidden" name="redirect_uri" value={data.redirectUri} />
				<input type="hidden" name="state" value={data.state} />
				<input type="hidden" name="code_challenge" value={data.codeChallenge} />
				<input type="hidden" name="code_challenge_method" value="S256" />
				<Button type="submit" variant="outline" name="decision" value="deny">Cancel</Button>
				<Button type="submit" name="decision" value="approve">Authorize</Button>
			</form>
		</Card.Footer>
	</Card.Root>
</main>
